# News-Enrichment-Merge + Topics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Topics-Erkennung durch den Geo-Agenten und Zusammenlegung von `newsGeo` in einen `enrichment`-Block auf `news` (Spec: `docs/superpowers/specs/2026-08-11-news-enrichment-merge-design.md`).

**Architecture:** Der Agent schreibt künftig einen kompletten `enrichment`-Block (`relevance`, `headline`, `summary`, `topics`, `geo.*`, `enrichedBy/At`) per `$set` auf das `news`-Dokument. Übergangsweise Dual-Write nach `newsGeo` und in die bestehenden Top-Level-Felder (webapi-Kompatibilität). `get_news_for_geocoding` filtert dann direkt auf `enrichment: {$exists: false}` statt per `$lookup`.

**Tech Stack:** TypeScript (ESM), MongoDB-Driver 7, zod 3, vitest, tsx-Skripte.

## Global Constraints

- Node >= 20, `"type": "module"` — Imports mit `.js`-Endung auch in TS-Dateien.
- Kommentare und Commit-Messages auf Deutsch, Commit-Stil wie Historie: `feat(geonews): …`, `docs(geonews): …`.
- Integrationstests brauchen eine laufende Mongo (Config aus `process.env`, `MCP_AUTH_DISABLED: 'true'`); Testdaten unter `category: 'MCPFCTEST'`, Cleanup in `afterAll`.
- Alle Mongo-Reads mit `maxTimeMS: MAX_TIME_MS` (aus `src/db/client.ts`).
- Der `noLocation`-Zweig darf abwärtskompatibel bleiben: `{newsId, noLocation:true}` ohne weitere Felder muss weiterhin funktionieren (die Routine wird erst in Task 7 angepasst).
- **Betriebsreihenfolge (nicht Code-Reihenfolge):** Nach dem Deploy von Task 2–4 muss `scripts/backfill-enrichment.ts` laufen, BEVOR der Geo-Agent (täglich 8:00) wieder läuft — sonst bietet `get_news_for_geocoding` bereits verortete Alt-News erneut an.

---

### Task 1: Prüfskript Ingester-Schreibverhalten (Phase 1, Blocker)

Klärt das kritische Risiko: Überschreibt der externe News-Ingester per Replace die von uns denormalisierten Felder? Empirischer Check: `newsGeo`-Docs mit `locatable:true` + `relevance`, deren `locatedAt` älter als 3 Tage ist, müssen im zugehörigen `news`-Doc noch `relevance` tragen.

**Files:**
- Create: `scripts/verify-ingester-writes.ts`
- Modify: `package.json` (Script-Eintrag)

**Interfaces:**
- Consumes: `loadConfig`/`getDb`/`closeMongo` wie in `scripts/backfill-news-relevance.ts`.
- Produces: Konsolen-Report; Exit-Code 1 bei Verdacht auf Replace-Verhalten.

- [ ] **Step 1: Skript schreiben**

```ts
/**
 * Phase-1-Prüfung (Spec 2026-08-11): Schreibt der News-Ingester per Replace,
 * verlieren alte news-Docs ihre denormalisierte relevance wieder. Wir prüfen
 * newsGeo-Einträge (locatable:true, relevance gesetzt), die älter als 3 Tage
 * sind — deren news-Doc muss relevance noch tragen. Mismatches > 0 => Verdacht
 * auf Replace-Verhalten, Merge NICHT fortsetzen, erst Ingester prüfen/fixen.
 */
import type { ObjectId } from 'mongodb';
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const CUTOFF = new Date(Date.now() - 3 * 24 * 3600 * 1000);
const CHUNK = 500;

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
const geoDocs = await db
  .collection('newsGeo')
  .find(
    { locatable: true, relevance: { $exists: true }, locatedAt: { $lt: CUTOFF } },
    { projection: { newsId: 1 } },
  )
  .toArray();

let checked = 0;
let missing = 0;
let orphaned = 0;
for (let i = 0; i < geoDocs.length; i += CHUNK) {
  const ids = geoDocs.slice(i, i + CHUNK).map((g) => g.newsId as ObjectId);
  const newsDocs = await db
    .collection('news')
    .find({ _id: { $in: ids } }, { projection: { relevance: 1 } })
    .toArray();
  const byId = new Map(newsDocs.map((d) => [String(d._id), d]));
  for (const id of ids) {
    const doc = byId.get(String(id));
    checked++;
    if (!doc) orphaned++;
    else if (doc.relevance == null) missing++;
  }
}

console.log(`geprüft: ${checked} (locatedAt < ${CUTOFF.toISOString()})`);
console.log(`news-Doc fehlt (vom Ingester gelöscht/rotiert): ${orphaned}`);
console.log(`relevance verschwunden (Replace-Verdacht!): ${missing}`);
if (missing > 0) {
  console.error('FAIL: Ingester überschreibt denormalisierte Felder — Merge stoppen, Ingester-Repo prüfen.');
  process.exit(1);
}
console.log('OK: keine Hinweise auf Replace-Verhalten.');
await closeMongo();
```

- [ ] **Step 2: package.json-Script ergänzen**

In `package.json` unter `scripts`:

```json
"verify-ingester-writes": "tsx scripts/verify-ingester-writes.ts"
```

- [ ] **Step 3: Gegen die echte DB laufen lassen**

Run: `npm run verify-ingester-writes`
Expected: `OK: keine Hinweise auf Replace-Verhalten.` — Bei `FAIL`: **STOPP**, Ergebnis an Marvin melden, Tasks 2–8 nicht beginnen. (Hinweis: Wenn `geprüft: 0`, sind alle newsGeo-Einträge jünger als 3 Tage — dann Aussagekraft begrenzt, ebenfalls melden.)

- [ ] **Step 4: Commit**

```bash
git add scripts/verify-ingester-writes.ts package.json
git commit -m "chore(geonews): Phase-1-Prüfskript für Ingester-Schreibverhalten"
```

---

### Task 2: `buildEnrichment` (TDD)

Kernfunktion, die aus einem Submit-Item den `enrichment`-Block baut. Eigene Datei, damit Tool-Handler, Backfill und Tests dieselbe Logik teilen.

**Files:**
- Create: `src/features/geonews/enrichment.ts`
- Test: `tests/unit/geonews-enrichment.test.ts`

**Interfaces:**
- Produces: `buildEnrichment(item: EnrichmentInput, enrichedBy: string, enrichedAt: Date): Document` — genutzt von Task 3 (Tool-Handler) und Task 5 (Backfill). `EnrichmentInput` = Felder des `locationItem` (`noLocation?, lat?, lon?, country?, place?, precision?, confidence?, relevance?, summary?, headline?, topics?`).

- [ ] **Step 1: Failing Tests schreiben** (`tests/unit/geonews-enrichment.test.ts`)

```ts
import { describe, expect, it } from 'vitest';
import { buildEnrichment } from '../../src/features/geonews/enrichment.js';

const AT = new Date('2026-08-11T08:00:00.000Z');

describe('buildEnrichment', () => {
  it('baut den vollen Block für ein verortetes Item mit Topics', () => {
    const block = buildEnrichment(
      {
        lat: 50.11, lon: 8.68, country: 'de', place: 'Frankfurt', precision: 'city',
        confidence: 0.9, relevance: 0.72, summary: 'EZB-Entscheid.',
        headline: 'EZB hebt Leitzins an', topics: ['ECB', 'Interest Rates'],
      },
      'fc-geo-agent', AT,
    );
    expect(block).toEqual({
      enrichedBy: 'fc-geo-agent',
      enrichedAt: AT,
      relevance: 0.72,
      headline: 'EZB hebt Leitzins an',
      summary: 'EZB-Entscheid.',
      topics: ['ECB', 'Interest Rates'],
      geo: {
        locatable: true,
        location: { type: 'Point', coordinates: [8.68, 50.11] },
        country: 'DE',
        place: 'Frankfurt',
        precision: 'city',
        confidence: 0.9,
      },
    });
  });

  it('erfasst Topics und relevance auch ohne Ort — kein Ort heißt nicht themenlos', () => {
    const block = buildEnrichment(
      { noLocation: true, relevance: 0.6, topics: ['US Economy', 'US Job Market', 'DAX'] },
      'fc-geo-agent', AT,
    );
    expect(block.geo).toEqual({ locatable: false });
    expect(block.relevance).toBe(0.6);
    expect(block.topics).toEqual(['US Economy', 'US Job Market', 'DAX']);
  });

  it('lässt fehlende optionale Felder weg statt null zu schreiben', () => {
    const block = buildEnrichment(
      { lat: 1, lon: 2, country: 'US', precision: 'country', relevance: 0.3 },
      'fc-geo-agent', AT,
    );
    expect(block).not.toHaveProperty('headline');
    expect(block).not.toHaveProperty('summary');
    expect(block).not.toHaveProperty('topics');
    expect(block.geo).not.toHaveProperty('place');
    expect(block.geo).not.toHaveProperty('confidence');
  });

  it('minimales noLocation-Item bleibt gültig (Abwärtskompatibilität zur Routine)', () => {
    const block = buildEnrichment({ noLocation: true }, 'fc-geo-agent', AT);
    expect(block).toEqual({ enrichedBy: 'fc-geo-agent', enrichedAt: AT, geo: { locatable: false } });
  });
});
```

- [ ] **Step 2: Tests laufen lassen — müssen fehlschlagen**

Run: `npx vitest run tests/unit/geonews-enrichment.test.ts`
Expected: FAIL (Modul `enrichment.js` existiert nicht)

- [ ] **Step 3: Implementierung** (`src/features/geonews/enrichment.ts`)

```ts
/** enrichment-Block für das news-Dokument — alle vom Agenten gesammelten Daten. */
import type { Document } from 'mongodb';

export interface EnrichmentInput {
  noLocation?: boolean;
  lat?: number;
  lon?: number;
  country?: string;
  place?: string;
  precision?: 'country' | 'region' | 'city';
  confidence?: number;
  relevance?: number;
  summary?: string;
  headline?: string;
  topics?: string[];
}

/**
 * `geo` ist bewusst nur ein Teilbereich des Blocks: relevance, headline,
 * summary und topics sind ortsunabhängig und werden auch bei
 * `locatable: false` erfasst (kein Ort heißt nicht themenlos oder unwichtig).
 * Der Block wird als Ganzes per `$set: { enrichment: … }` geschrieben —
 * Re-Submits ersetzen ihn vollständig, das ist gewollt.
 */
export function buildEnrichment(item: EnrichmentInput, enrichedBy: string, enrichedAt: Date): Document {
  const geo: Document = item.noLocation
    ? { locatable: false }
    : {
        locatable: true,
        location: { type: 'Point', coordinates: [item.lon, item.lat] },
        country: item.country?.toUpperCase(),
        ...(item.place ? { place: item.place } : {}),
        precision: item.precision,
        ...(item.confidence != null ? { confidence: item.confidence } : {}),
      };
  return {
    enrichedBy,
    enrichedAt,
    ...(item.relevance != null ? { relevance: item.relevance } : {}),
    ...(item.headline ? { headline: item.headline } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.topics && item.topics.length > 0 ? { topics: item.topics } : {}),
    geo,
  };
}
```

- [ ] **Step 4: Tests laufen lassen — müssen bestehen**

Run: `npx vitest run tests/unit/geonews-enrichment.test.ts`
Expected: PASS (4 Tests)

- [ ] **Step 5: Commit**

```bash
git add src/features/geonews/enrichment.ts tests/unit/geonews-enrichment.test.ts
git commit -m "feat(geonews): buildEnrichment — enrichment-Block mit topics und geo-Teilbereich"
```

---

### Task 3: Tool `submit_news_locations` — Topics, erweiterter noLocation-Zweig, enrichment-Write

`locationItem` bekommt `topics`; der Handler schreibt zusätzlich zum bisherigen Dual-Write (`newsGeo` + Top-Level-Patch) den `enrichment`-Block auf `news`.

**Files:**
- Modify: `src/features/geonews/index.ts` (Schema ~Zeile 14–39, Handler ~Zeile 107–187)
- Test: `tests/integration/geonews.test.ts` (neue describe-Blöcke anhängen)

**Interfaces:**
- Consumes: `buildEnrichment` aus Task 2.
- Produces: `news.enrichment`-Block wie in Task 2 definiert; `newsGeo`-Schreibweg und `buildNewsPatch`-Top-Level-Felder bleiben unverändert (Dual-Write, webapi-Kompatibilität bis Phase 5).

- [ ] **Step 1: Failing Integrationstests anhängen** (ans Ende von `tests/integration/geonews.test.ts`)

```ts
describe('submit_news_locations → enrichment-Block', () => {
  it('schreibt den vollen enrichment-Block inkl. topics an den news-Doc', async () => {
    await h.client.callTool({
      name: 'submit_news_locations',
      arguments: {
        items: [{
          newsId: String(newsIds[0]),
          lat: 50.11, lon: 8.68, country: 'de', place: 'Frankfurt', precision: 'city',
          confidence: 0.9, relevance: 0.77, summary: 'EZB-Entscheid.',
          headline: 'EZB hebt Leitzins an', topics: ['ECB', 'Interest Rates'],
        }],
      },
    });
    const doc: any = await db.collection('news').findOne({ _id: newsIds[0] });
    expect(doc.enrichment.enrichedBy).toBe('test');
    expect(doc.enrichment.enrichedAt).toBeInstanceOf(Date);
    expect(doc.enrichment.relevance).toBe(0.77);
    expect(doc.enrichment.headline).toBe('EZB hebt Leitzins an');
    expect(doc.enrichment.topics).toEqual(['ECB', 'Interest Rates']);
    expect(doc.enrichment.geo).toEqual({
      locatable: true,
      location: { type: 'Point', coordinates: [8.68, 50.11] },
      country: 'DE',
      place: 'Frankfurt',
      precision: 'city',
      confidence: 0.9,
    });
    // Dual-Write bleibt intakt:
    expect(doc.relevance).toBe(0.77);
    const geoDoc: any = await db.collection('newsGeo').findOne({ newsId: newsIds[0] });
    expect(geoDoc.relevance).toBe(0.77);
  });

  it('noLocation-Items dürfen topics und relevance mitliefern — nur im Block, nicht top-level', async () => {
    await h.client.callTool({
      name: 'submit_news_locations',
      arguments: {
        items: [{
          newsId: String(newsIds[1]),
          noLocation: true,
          relevance: 0.55,
          topics: ['US Economy', 'US Job Market', 'DAX'],
          headline: 'US-Jobdaten verunsichern Anleger',
        }],
      },
    });
    const doc: any = await db.collection('news').findOne({ _id: newsIds[1] });
    expect(doc.enrichment.geo).toEqual({ locatable: false });
    expect(doc.enrichment.relevance).toBe(0.55);
    expect(doc.enrichment.topics).toEqual(['US Economy', 'US Job Market', 'DAX']);
    expect(doc.enrichment.headline).toBe('US-Jobdaten verunsichern Anleger');
    // Top-Level-Denormalisierung bei noLocation unverändert: nur geoLocatedAt.
    // (newsIds[1] hat aus früheren Tests bereits relevance 0.6 top-level —
    // die darf durch den noLocation-Submit nicht überschrieben werden.)
    expect(doc.relevance).toBe(0.6);
  });

  it('lehnt mehr als 5 topics ab', async () => {
    const res: any = await h.client.callTool({
      name: 'submit_news_locations',
      arguments: {
        items: [{
          newsId: String(newsIds[0]), noLocation: true,
          topics: ['A1', 'B2', 'C3', 'D4', 'E5', 'F6'],
        }],
      },
    });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Tests laufen lassen — neue müssen fehlschlagen**

Run: `npx vitest run tests/integration/geonews.test.ts`
Expected: die 3 neuen Tests FAIL (`enrichment` undefined bzw. topics akzeptiert ohne Limit), alle bestehenden PASS.

- [ ] **Step 3: Schema erweitern** (`src/features/geonews/index.ts`, in `locationItem` nach `headline`)

```ts
  topics: z
    .array(z.string().min(2).max(60))
    .min(1)
    .max(5)
    .optional()
    .describe(
      '1-5 Themen-Tags: Englisch, Title Case — z.B. ["US Economy","US Job Market","DAX"]. Kategorien: Indizes (DAX, S&P 500), Länder-/Regionen-Themen (US Economy, Eurozone Economy), Märkte/Assetklassen (Oil, Gold, Bonds, Crypto), Institutionen (ECB, Fed), Themenfelder (Interest Rates, Inflation, Tariffs), Einzelwerte als Firmenname (Apple, Siemens). WICHTIG: Trägt die News ein spezifisches Thema, vergib es zusätzlich konkret (z.B. Private Credit, Credit Defaults, CRE Debt, Yen Carry Trade, AI Capex) — die Tags werden als Zeitreihe für Trend-Früherkennung aggregiert. Dasselbe Thema deshalb immer mit exakt demselben Tag, keine neuen Formulierungen für bekannte Themen. Keine Sätze, keine Duplikate, kein Kategorie-Echo (ECONOMY ist Kategorie, kein Topic). Auch bei noLocation angeben.',
    ),
```

Zusätzlich im `describe` von `relevance`, `summary` und `headline` jeweils den Zusatz ergänzen: `Auch bei noLocation sinnvoll und erwünscht.` — und in der Tool-`description` von `submit_news_locations` den Satz ergänzen: `Auch noLocation-Items sollen relevance, topics, headline und summary mitliefern — Themen und Wichtigkeit sind ortsunabhängig.`

- [ ] **Step 4: Handler erweitern** (`src/features/geonews/index.ts`)

Import ergänzen:

```ts
import { buildEnrichment } from './enrichment.js';
```

Den bestehenden `newsOps.push`-Block (aktuell ~Zeile 168–173) ersetzen durch:

```ts
          newsOps.push({
            updateOne: {
              filter: { _id: news._id },
              update: {
                $set: {
                  // Top-Level-Denormalisierung: bleibt bis Phase 5 (webapi liest sie noch)
                  ...buildNewsPatch(item, base.locatedAt as Date).$set,
                  enrichment: buildEnrichment(item, auth.keyName, base.locatedAt as Date),
                },
              },
            },
          });
```

(`buildNewsPatch`-Import und `newsGeo`-Write bleiben unverändert — Dual-Write.)

- [ ] **Step 5: Alle geonews-Tests laufen lassen**

Run: `npx vitest run tests/integration/geonews.test.ts tests/unit/geonews-patch.test.ts tests/unit/geonews-enrichment.test.ts`
Expected: PASS, keine Regressionen (insbesondere „setzt bei noLocation nur geoLocatedAt, keine relevance" — Top-Level bleibt unangetastet).

- [ ] **Step 6: Commit**

```bash
git add src/features/geonews/index.ts tests/integration/geonews.test.ts
git commit -m "feat(geonews): topics im Submit-Schema, enrichment-Block auf news, noLocation-Zweig erweitert"
```

---

### Task 4: `get_news_for_geocoding` auf enrichment-Filter umstellen

Ersetzt den `$lookup` auf `newsGeo` (Scan-Fenster 500) durch einen direkten Filter `enrichment: {$exists: false}` — einfacher und ohne Fenster-Limitierung.

**Files:**
- Modify: `src/features/geonews/index.ts` (Handler von `get_news_for_geocoding`, ~Zeile 57–95; Konstante `SCAN_WINDOW` entfernen)
- Test: `tests/integration/geonews.test.ts` (ein Header-Assert anpassen)

**Interfaces:**
- Consumes: `news.enrichment` aus Task 3.
- Produces: unverändertes Tabellenformat (`newsId|date|category|source|title|description`) — der Geo-Agent merkt nichts von der Umstellung.

- [ ] **Step 1: Handler ersetzen**

Kompletter neuer Handler-Body (ersetzt Aggregation inkl. `SCAN_WINDOW`; die Konstante und ihren Doc-Kommentar löschen):

```ts
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 20, 50);
        const match: Record<string, unknown> = { enrichment: { $exists: false } };
        if (input.from || input.to) {
          match.pubDate = {
            ...(input.from ? { $gte: new Date(`${input.from}T00:00:00Z`) } : {}),
            ...(input.to ? { $lte: new Date(`${input.to}T23:59:59.999Z`) } : {}),
          };
        }
        if (input.category) match.category = input.category.toUpperCase();
        const docs = await cols(db)
          .news.find(match, {
            projection: { title: 1, description: 1, sourceName: 1, category: 1, pubDate: 1 },
            sort: { pubDate: -1 },
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        return table(
          ['newsId', 'date', 'category', 'source', 'title', 'description'],
          docs.slice(0, lim).map((d) => [
            String(d._id),
            fmtDate(d.pubDate),
            d.category,
            d.sourceName,
            d.title,
            (d.description ?? '').slice(0, 200),
          ]),
          { hasMore },
        );
      },
```

Tool-`description` anpassen: `'Newest news that have NO enrichment block yet — for the geolocation agent. …'` (Rest unverändert).

- [ ] **Step 2: Header-Assert im Integrationstest anpassen**

In `tests/integration/geonews.test.ts` prüft „lists unlocated news…" per `lines.filter((l) => !l.startsWith('#'))` — das bleibt gültig. Nur falls dort auf den Text `newest 500 news scanned` geprüft würde, entfällt das (aktuell nicht der Fall — verifizieren). Der Test „fetch afterwards returns 0 rows" funktioniert weiter, weil Submits jetzt `enrichment` setzen.

Run: `npx vitest run tests/integration/geonews.test.ts`
Expected: PASS. Achtung: Der Test „lists unlocated news" läuft VOR den Submit-Tests (vitest führt describe-Blöcke in Dateireihenfolge aus) — die 3 Seed-News haben dort noch kein `enrichment`, erwartet also weiterhin 4 Zeilen.

- [ ] **Step 3: Gesamte Testsuite**

Run: `npm test`
Expected: PASS (keine anderen Features betroffen).

- [ ] **Step 4: Commit**

```bash
git add src/features/geonews/index.ts tests/integration/geonews.test.ts
git commit -m "feat(geonews): get_news_for_geocoding filtert direkt auf fehlenden enrichment-Block"
```

---

### Task 5: Indizes erweitern

**Files:**
- Modify: `scripts/ensure-indexes.ts`

**Interfaces:**
- Produces: Indizes für Karte (2dsphere), Top-Stories, Länder-Filter, Topics-Filter auf `news`; `{pubDate:-1}` für den neuen `get_news_for_geocoding`-Sort.

- [ ] **Step 1: Index-Erstellung ergänzen** (in `scripts/ensure-indexes.ts` nach den bestehenden news-Indizes)

```ts
console.log('creating news enrichment indexes…');
// Sortierung von get_news_for_geocoding (find + sort pubDate)
await news.createIndex({ pubDate: -1 }, { name: 'pubDate' });
// Karte: Viewport-Query über den enrichment-Block
await news.createIndex(
  { 'enrichment.geo.location': '2dsphere' },
  { sparse: true, name: 'enrichment_location_2dsphere' },
);
// Top-Stories / Relevanz-Sortierung aus dem Block (löst news.relevance in Phase 5 ab)
await news.createIndex(
  { 'enrichment.relevance': -1, pubDate: -1 },
  { name: 'enrichment_relevance_pubDate' },
);
// Länder-Filter/-Badges
await news.createIndex(
  { 'enrichment.geo.country': 1, pubDate: -1 },
  { name: 'enrichment_country_pubDate' },
);
// Themen-Filter (Multikey)
await news.createIndex(
  { 'enrichment.topics': 1, pubDate: -1 },
  { name: 'enrichment_topics_pubDate' },
);
```

- [ ] **Step 2: Ausführen**

Run: `npm run ensure-indexes`
Expected: läuft durch (Index-Aufbau auf ~500k Docs kann einige Minuten dauern; sparse/Multikey-Indizes betreffen nur den kleinen enriched-Teilbestand).

- [ ] **Step 3: Commit**

```bash
git add scripts/ensure-indexes.ts
git commit -m "feat(geonews): Indizes für news.enrichment (2dsphere, relevance, country, topics, pubDate)"
```

---

### Task 6: Backfill `newsGeo` → `news.enrichment`

Einmaliges, idempotentes Skript: Bestehende `newsGeo`-Docs werden als `enrichment`-Block auf `news` übertragen. Muss vor dem nächsten Agenten-Lauf nach dem Deploy von Task 4 gelaufen sein (siehe Global Constraints).

**Files:**
- Create: `scripts/backfill-enrichment.ts`
- Modify: `package.json` (Script-Eintrag)

**Interfaces:**
- Consumes: `buildEnrichment` aus Task 2; newsGeo-Felder (`locatable`, `location`, `country`, `place`, `precision`, `confidence`, `relevance`, `summary`, `geoTitle`, `locatedBy`, `locatedAt`).

- [ ] **Step 1: Skript schreiben** (Muster: `scripts/backfill-news-relevance.ts`)

```ts
/**
 * Einmaliges Backfill (Phase 3): überträgt newsGeo-Docs als enrichment-Block
 * auf news. Idempotent — überschreibt nur, wenn enrichment fehlt oder älter
 * als newsGeo.locatedAt ist (frische Agenten-Submits gewinnen).
 * Nicht während des Agenten-Laufs (täglich 8:00) starten.
 * topics bleibt für Alt-Docs leer — das Feld gibt es erst ab dem Tool-Umbau.
 */
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';
import { buildEnrichment } from '../src/features/geonews/enrichment.js';

const BATCH = 1000;

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
const cursor = db.collection('newsGeo').find(
  {},
  {
    projection: {
      newsId: 1, locatable: 1, location: 1, country: 1, place: 1, precision: 1,
      confidence: 1, relevance: 1, summary: 1, geoTitle: 1, locatedBy: 1, locatedAt: 1,
    },
  },
);

let ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
let done = 0;

async function flush() {
  if (ops.length === 0) return;
  const res = await db.collection('news').bulkWrite(ops, { ordered: false });
  done += res.modifiedCount;
  console.log(`${done} news-Dokumente aktualisiert`);
  ops = [];
}

for await (const geo of cursor) {
  const locatedAt = (geo.locatedAt as Date) ?? new Date(0);
  ops.push({
    updateOne: {
      // enrichment fehlt ODER ist älter als dieser newsGeo-Stand
      filter: {
        _id: geo.newsId,
        $or: [
          { enrichment: { $exists: false } },
          { 'enrichment.enrichedAt': { $lt: locatedAt } },
        ],
      },
      update: {
        $set: {
          enrichment: buildEnrichment(
            {
              noLocation: geo.locatable === false,
              lat: geo.location?.coordinates?.[1],
              lon: geo.location?.coordinates?.[0],
              country: geo.country,
              place: geo.place,
              precision: geo.precision,
              confidence: geo.confidence,
              relevance: geo.relevance,
              summary: geo.summary,
              headline: geo.geoTitle,
            },
            (geo.locatedBy as string) ?? 'backfill',
            locatedAt,
          ),
        },
      },
    },
  });
  if (ops.length >= BATCH) await flush();
}
await flush();

const geoCount = await db.collection('newsGeo').countDocuments();
const enrichedCount = await db.collection('news').countDocuments({ enrichment: { $exists: true } });
console.log(`fertig: ${done} aktualisiert — newsGeo: ${geoCount}, news mit enrichment: ${enrichedCount}`);
if (enrichedCount < geoCount) {
  console.warn('WARNUNG: weniger enriched news als newsGeo-Docs — verwaiste newsId-Referenzen prüfen.');
}
await closeMongo();
```

- [ ] **Step 2: package.json-Script ergänzen**

```json
"backfill-enrichment": "tsx scripts/backfill-enrichment.ts"
```

- [ ] **Step 3: Ausführen und Zähl-Abgleich prüfen**

Run: `npm run backfill-enrichment`
Expected: `news mit enrichment` ≈ `newsGeo`-Count (Differenz nur durch verwaiste Referenzen, deren news-Doc der Ingester gelöscht hat — bei großer Differenz melden). Zweiter Lauf direkt danach: `0 aktualisiert` (Idempotenz-Beleg).

- [ ] **Step 4: Commit**

```bash
git add scripts/backfill-enrichment.ts package.json
git commit -m "feat(geonews): Backfill newsGeo → news.enrichment (idempotent)"
```

---

### Task 7: Routine-Auftragstext dokumentieren

Der Auftragstext der Scheduled-Task `fc_geo_news_locating` liegt außerhalb des Repos — ohne Anpassung bleibt `topics` dauerhaft leer (bekannte Falle, siehe Warnung in `docs/geonews-restapi-integration.md`). Wir legen den fertigen neuen Auftragstext als Datei ab, Marvin überträgt ihn in die Routine.

**Files:**
- Create: `docs/geonews-agent-routine.md`

- [ ] **Step 1: Datei schreiben**

```markdown
# Auftragstext für die Routine fc_geo_news_locating

Stand 2026-08-11 — nach dem enrichment-Umbau. Diesen Text in die
Claude-Scheduled-Task übernehmen (der Auftragstext liegt NICHT im Repo;
Felder, die er nicht aufzählt, füllt der Agent nicht).

---

Du bist der Geo-News-Agent für financecentre. Aufgabe:

1. Rufe `get_news_for_geocoding` mit `{"limit": 50}` auf. Wenn 0 Zeilen
   zurückkommen, bist du fertig.
2. Bestimme für JEDE News:
   - **topics** (immer, 1–5): konkrete Themen-Tags, Englisch, Title Case —
     z.B. ["US Economy", "US Job Market", "DAX"]. Kategorien: Indizes (DAX,
     S&P 500), Länder-Themen (US Economy, Eurozone Economy), Assetklassen
     (Oil, Gold, Bonds, Crypto), Institutionen (ECB, Fed), Themenfelder
     (Interest Rates, Inflation, Tariffs), Einzelwerte als Firmenname
     (Apple, Siemens). Keine Sätze, keine Kategorie-Echos wie ECONOMY.
     WICHTIG: Werde konkret, wenn die News ein spezifisches Thema trägt —
     z.B. Private Credit, Credit Defaults, CRE Debt, Yen Carry Trade,
     AI Capex. Die Tags speisen eine Trend-Früherkennung (Zählung pro
     Zeitfenster); dasselbe Thema deshalb IMMER mit exakt demselben Tag,
     keine neue Formulierung für ein bekanntes Thema.
   - **relevance** (immer, 0–1): Wichtigkeit des Ereignisses gemäß der
     Anker in der Tool-Beschreibung.
   - **headline** (immer, ≤90 Zeichen): NEUE kurze deutsche Schlagzeile,
     selbst formuliert — nicht der Original-Titel, keine Quellenangabe.
   - **summary** (immer, ≤300 Zeichen): 1–2 deutsche Sätze.
   - **Ort**, falls es einen sinnvollen gibt: lat, lon, country (ISO2),
     place, precision (country|region|city), confidence (0–1).
     Falls kein sinnvoller Ort: `"noLocation": true` — topics, relevance,
     headline und summary trotzdem angeben!
3. Reiche alles gesammelt mit `submit_news_locations` ein (max. 50 Items
   pro Aufruf). Prüfe die Antwort auf ERROR-Zeilen und korrigiere
   fehlerhafte Items in einem zweiten Aufruf.
4. Wiederhole ab Schritt 1, bis keine News mehr offen sind (max. 5 Runden).
```

- [ ] **Step 2: Querverweis in der webapi-Doku ergänzen**

In `docs/geonews-restapi-integration.md` im Warnhinweis-Block (Abschnitt 1, `> **Achtung bei neuen Feldern:**`) am Ende ergänzen: `Der aktuelle Auftragstext liegt als Kopiervorlage in docs/geonews-agent-routine.md.`

- [ ] **Step 3: Commit**

```bash
git add docs/geonews-agent-routine.md docs/geonews-restapi-integration.md
git commit -m "docs(geonews): Auftragstext-Vorlage für fc_geo_news_locating mit topics"
```

---

### Task 8: webapi-Doku auf `news.enrichment` umschreiben

`docs/geonews-restapi-integration.md` beschreibt für das webapi-Repo den Lesezugriff. Nach dem Merge liest die Karte aus `news` statt `newsGeo`.

**Files:**
- Modify: `docs/geonews-restapi-integration.md`

- [ ] **Step 1: Abschnitt 1 (Datenmodell) ersetzen**

Neue Feldtabelle (ersetzt die newsGeo-Tabelle; die relevance-Skala-Tabelle und der Warnhinweis-Block bleiben):

```markdown
## 1. Datenmodell

Quelle ist jetzt die `news`-Collection selbst. Der Geo-Agent schreibt einen
`enrichment`-Block direkt an das news-Dokument (Upsert per `$set` durch das
MCP-Tool `submit_news_locations`); `newsGeo` ist deprecated und wird nach der
webapi-Umstellung gedroppt.

| Feld | Typ | Bedeutung |
|---|---|---|
| `enrichment` | object? | fehlt = noch nicht vom Agenten bearbeitet |
| `enrichment.enrichedBy` / `enrichedAt` | str / date | Agent-Name + Zeitstempel |
| `enrichment.relevance` | float? | 0–1 — Bedeutung des EREIGNISSES (auch ohne Ort gesetzt) |
| `enrichment.headline` | str? | kurze deutsche Schlagzeile (≤90 Zeichen, ehem. `geoTitle`) |
| `enrichment.summary` | str? | 1–2 Sätze (Pin-Callout / Teaser) |
| `enrichment.topics` | [str]? | 1–5 Themen-Tags, Englisch, Title Case (`"US Economy"`, `"DAX"`) |
| `enrichment.geo.locatable` | bool | `false` = kein sinnvoller Ort (**für die Karte filtern!**) |
| `enrichment.geo.location` | GeoJSON Point | `[lon, lat]` — Reihenfolge beachten |
| `enrichment.geo.country` | str? | ISO 3166-1 alpha-2, uppercase |
| `enrichment.geo.place` | str? | Anzeigename, fehlt bei `precision=country` |
| `enrichment.geo.precision` | str? | `country` \| `region` \| `city` |
| `enrichment.geo.confidence` | float? | 0–1 — Sicherheit der VERORTUNG |
| `title`, `sourceName`, `link`, `image`, `pubDate`, `category` | — | native news-Felder — **keine Denormalisierung mehr nötig** |

Übergangsphase: Die bisherigen Top-Level-Felder (`relevance`, `geoTitle`,
`geoSummary`, `country`, `place`, `geoLocatedAt`) werden noch parallel
geschrieben und erst entfernt, wenn die webapi vollständig auf
`enrichment.*` liest.

Indizes (via mcp-fc `ensure-indexes`): `{'enrichment.geo.location':'2dsphere'}`
sparse, `{'enrichment.relevance':-1, pubDate:-1}`,
`{'enrichment.geo.country':1, pubDate:-1}`, `{'enrichment.topics':1, pubDate:-1}`.
```

- [ ] **Step 2: Abschnitte 2–5 (Beanie/Service/Endpoints) anpassen**

Kernänderungen in den Code-Beispielen (Feld-Mapping alt → neu, in allen Snippets konsistent durchziehen):

| alt (`NewsGeo`) | neu (`News`) |
|---|---|
| Collection `newsGeo`, Model `NewsGeo` | Collection `news`, `Enrichment`-Submodel eingebettet |
| `locatable: True` | `"enrichment.geo.locatable": True` |
| `location` | `"enrichment.geo.location"` |
| `relevance` | `"enrichment.relevance"` |
| `country` | `"enrichment.geo.country"` |
| `summary` / `geoTitle` | `enrichment.summary` / `enrichment.headline` |
| `newsId` | entfällt — `_id` IST die news-Id |
| denormalisiertes `title`/`link`/… | native news-Felder |

Beanie-Model-Beispiel (ersetzt das `NewsGeo`-Model in Abschnitt 2):

```python
class GeoBlock(BaseModel):
    locatable: bool = True
    location: GeoPoint | None = None
    country: str | None = None
    place: str | None = None
    precision: str | None = None
    confidence: float | None = None


class Enrichment(BaseModel):
    enrichedBy: str
    enrichedAt: datetime
    relevance: float | None = None
    headline: str | None = None
    summary: str | None = None
    topics: list[str] | None = None
    geo: GeoBlock


class News(Document):
    title: str
    description: str | None = None
    sourceName: str
    link: str
    image: str | None = None
    pubDate: datetime
    category: str
    enrichment: Enrichment | None = None

    class Settings:
        name = "news"
```

Response-Schema: `NewsGeoResponse` bekommt zusätzlich `topics: list[str] | None` und `headline: str | None`; `newsId` liefert ab jetzt `str(item.id)`.

- [ ] **Step 3: Abschnitt 7 (Betrieb) ergänzen**

Am Ende von Abschnitt 7 ergänzen: `Health-Signal ist jetzt max(news.enrichment.enrichedAt) statt max(newsGeo.locatedAt).`

- [ ] **Step 4: Commit**

```bash
git add docs/geonews-restapi-integration.md
git commit -m "docs(geonews): webapi-Integration auf news.enrichment umgeschrieben"
```

---

### Task 9: Phase-5-Rückbauskript (vorbereiten, NICHT ausführen)

**GATE: Erst ausführen, wenn die webapi vollständig auf `enrichment.*` liest (bestätigt durch Marvin).** Das Skript wird jetzt nur geschrieben und committet.

**Files:**
- Create: `scripts/cleanup-legacy-geo.ts`
- Modify: `package.json` (Script-Eintrag)

- [ ] **Step 1: Skript schreiben**

```ts
/**
 * Phase-5-Rückbau — ERST AUSFÜHREN, wenn die webapi vollständig auf
 * news.enrichment.* liest (Marvin bestätigt). Danach zusätzlich im Code:
 * Dual-Write entfernen (newsGeo-Upsert + buildNewsPatch in
 * src/features/geonews/index.ts, newsPatch.ts löschen) und newsGeo aus
 * src/db/collections.ts sowie scripts/ensure-indexes.ts streichen.
 *
 * Entfernt die Top-Level-Duplikate (stammen aus buildNewsPatch, nicht vom
 * Ingester) und droppt newsGeo. Läuft nur, wenn --yes übergeben wird.
 */
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

if (!process.argv.includes('--yes')) {
  console.error('Abbruch: Gate beachten (webapi umgestellt?) und mit --yes bestätigen.');
  process.exit(1);
}

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));

const res = await db.collection('news').updateMany(
  { geoLocatedAt: { $exists: true } },
  { $unset: { relevance: '', geoSummary: '', geoTitle: '', country: '', place: '', geoLocatedAt: '' } },
);
console.log(`Top-Level-Duplikate entfernt: ${res.modifiedCount} news-Docs`);

await db.collection('news').dropIndex('relevance_pubDate').catch(() => {});
await db.collection('newsGeo').drop();
console.log('newsGeo gedroppt.');
await closeMongo();
```

- [ ] **Step 2: package.json-Script ergänzen**

```json
"cleanup-legacy-geo": "tsx scripts/cleanup-legacy-geo.ts"
```

- [ ] **Step 3: Nur Trockentest des Gates**

Run: `npx tsx scripts/cleanup-legacy-geo.ts`
Expected: `Abbruch: Gate beachten …`, Exit-Code 1 — das Skript darf ohne `--yes` nichts tun.

- [ ] **Step 4: Commit**

```bash
git add scripts/cleanup-legacy-geo.ts package.json
git commit -m "chore(geonews): Phase-5-Rückbauskript (gated, Ausführung erst nach webapi-Umstellung)"
```

---

## Nach Abschluss (operativ, außerhalb dieses Plans)

1. Deploy; direkt danach `npm run backfill-enrichment` (vor dem nächsten 8:00-Agentenlauf).
2. Marvin überträgt `docs/geonews-agent-routine.md` in die Scheduled-Task `fc_geo_news_locating`.
3. webapi-Umbau nach `docs/geonews-restapi-integration.md` (anderes Repo).
4. Wenn webapi umgestellt: Phase 5 — `npm run cleanup-legacy-geo -- --yes` plus Code-Rückbau (Dual-Write, `newsPatch.ts`, `newsGeo` aus `collections.ts`/`ensure-indexes.ts`).
