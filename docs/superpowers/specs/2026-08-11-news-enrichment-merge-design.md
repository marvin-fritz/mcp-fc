# Design: Topics-Erkennung + Merge von newsGeo in news (enrichment-Block)

Datum: 2026-08-11
Status: freigegeben (Marvin), Umsetzung folgt per Implementierungsplan

## Ziel

1. Der Geo-Agent (`fc_geo_news_locating`) erkennt pro Nachricht 1–5 konkrete
   Themen (z.B. `["US Economy", "US Job Market", "DAX"]`) und liefert sie mit.
2. `newsGeo` und `news` werden zusammengelegt: Alle vom Agenten gesammelten
   Daten wandern in einen klar abgegrenzten `enrichment`-Block auf dem
   `news`-Dokument. `newsGeo` wird danach obsolet und gedroppt. Das beseitigt
   die doppelte Denormalisierung in beide Richtungen (newsGeo dupliziert
   title/link/image/pubDate/category aus news; news dupliziert
   relevance/geoTitle/geoSummary/country/place aus newsGeo).

Geo ist dabei bewusst nur **ein Teilbereich** des Blocks — der Block ist für
künftige Anreicherungen (Sentiment, Ticker-Zuordnung, …) erweiterbar.

## Ziel-Datenmodell (`news`)

```js
{
  // ── vom Ingester (financecentre-Backend, außerhalb dieses Repos) ──
  _id, title, description, link, image, pubDate, category, sourceName, stats, …

  // ── ausschließlich vom Agenten geschrieben (per $set auf `enrichment`) ──
  enrichment: {
    enrichedBy: 'fc-geo-agent',       // auth.keyName
    enrichedAt: ISODate,
    relevance: 0.72,                  // 0–1, Wichtigkeit des EREIGNISSES; auch ohne Ort erlaubt
    headline: 'EZB hebt Leitzins an', // deutsche Schlagzeile ≤90 Zeichen (bisher geoTitle)
    summary: '1–2 Sätze …',           // ≤300 Zeichen (Pin-Callout / Teaser)
    topics: ['ECB', 'Eurozone Economy', 'Interest Rates'],  // NEU, 1–5 Tags
    geo: {
      locatable: true,                // false = kein sinnvoller Ort
      location: { type: 'Point', coordinates: [lon, lat] },  // nur bei locatable
      country: 'DE',                  // ISO 3166-1 alpha-2, uppercase
      place: 'Frankfurt am Main',
      precision: 'city',              // country | region | city
      confidence: 0.9                 // Sicherheit der VERORTUNG
    }
  }
}
```

Regeln:

- `topics`, `relevance`, `headline`, `summary` sind **ortsunabhängig** und
  werden auch bei `geo.locatable: false` erfasst (Marktberichte u.ä. haben
  Themen und Wichtigkeit, aber keinen Ort).
- Bei `locatable: false` entfallen `location`, `country`, `place`,
  `precision`, `confidence`.
- Der Agent schreibt ausschließlich `enrichment` (per `$set: { enrichment: … }`),
  nie Ingester-Felder. Der Ingester darf `enrichment` nicht anfassen (→ Risiko 1).

### Topics-Taxonomie

Freie Agent-Strings driften („US Economy" vs. „US-Wirtschaft" vs. „us economy")
und machen das Feld für Filter unbrauchbar. Leitplanken im Schema-`describe`
des Tools und im Agenten-Auftragstext:

- Englisch, Title Case, 1–5 Tags pro News.
- Kategorien mit Ankerbeispielen: Indizes (`DAX`, `S&P 500`), Länder-/Regionen-
  Themen (`US Economy`, `Eurozone Economy`), Märkte/Assetklassen (`Oil`,
  `Gold`, `Crypto`, `Bonds`), Institutionen (`ECB`, `Fed`), Themenfelder
  (`Interest Rates`, `Inflation`, `US Job Market`, `Tariffs`), Einzelwerte als
  Firmenname (`Apple`, `Siemens`).
- **Konkretheit für Trend-Erkennung:** Neben breiten Tags soll der Agent auch
  spezifische Themen vergeben, wenn die News eines trägt — z.B.
  `Private Credit`, `Credit Defaults`, `CRE Debt`, `Yen Carry Trade`,
  `AI Capex`. Zielbild ist ein **Frühwarnsystem**: Topics werden später als
  Zeitreihe aggregiert (Zählung pro Zeitfenster über den
  `{topics, pubDate}`-Index), um aufkommende Themen und Häufungen (z.B.
  „Private Credit" zusammen mit „Credit Defaults") früh zu erkennen. Dafür
  zählt Wiedererkennbarkeit: dasselbe Thema immer mit exakt demselben Tag,
  lieber ein etablierter spezifischer Begriff als jedes Mal eine neue
  Formulierung.
- Keine Sätze, keine Duplikate, kein Quellen-/Kategorie-Echo (`ECONOMY` ist
  Kategorie, kein Topic).

## Tool-Änderungen (`src/features/geonews/`)

### `submit_news_locations`

- `locationItem` erweitert um `topics: z.array(z.string().max(60)).min(1).max(5).optional()`
  mit `describe` gemäß Taxonomie oben.
- Der `noLocation`-Zweig akzeptiert künftig auch `topics`, `relevance`,
  `summary`, `headline` (alle optional, bis die Routine angepasst ist).
- Schreibweg neu: `$set` des kompletten `enrichment`-Blocks auf `news`
  (Upsert-Semantik pro Feld entfällt — der Block wird als Ganzes ersetzt, das
  ist beim Re-Submit einer News gewollt).
- Übergangsweise **Dual-Write**: zusätzlich weiterhin `newsGeo`-Upsert und die
  bisherige Top-Level-Denormalisierung (`relevance`, `geoTitle`, `geoSummary`,
  `country`, `place`, `geoLocatedAt`) via `buildNewsPatch` — die webapi liest
  beides noch. Entfällt in Phase 5.

### `get_news_for_geocoding`

- Filter wird `{ enrichment: { $exists: false } }` statt `$lookup` auf
  `newsGeo` — einfacher und schneller. Umstellung **erst nach dem Backfill**
  (Phase 3), sonst würden bereits verortete News erneut angeboten.
- `SCAN_WINDOW`-Konstrukt kann mit dem direkten Filter entfallen.

## Indizes (`scripts/ensure-indexes.ts`)

Neu auf `news`:

| Index | Zweck |
|---|---|
| `{'enrichment.geo.location': '2dsphere'}` sparse | Viewport-Query der Karte |
| `{'enrichment.relevance': -1, pubDate: -1}` | Top-Stories / Sortierung |
| `{'enrichment.geo.country': 1, pubDate: -1}` | Länder-Filter/-Badges |
| `{'enrichment.topics': 1, pubDate: -1}` | Themen-Filter (Multikey) |

Die bestehenden Top-Level-Indizes (`relevance_pubDate` auf news) bleiben bis
Phase 5, die `newsGeo`-Indizes bis zum Drop der Collection.

## Migrationspfad

| Phase | Inhalt | Gate |
|---|---|---|
| 1 | **Prüfpunkt Ingester** (Skript `scripts/verify-ingester-writes.ts`): Behalten alte, bereits geo-gepatchte news-Docs (`geoLocatedAt` vorhanden, älter als N Tage) ihre `relevance`? Zusätzlich im Ingester-Repo verifizieren: `$set`-Upsert vs. Replace. | Bei Replace-Verhalten: erst Ingester fixen. **Blocker für alles Weitere** — betrifft schon die heutige Denormalisierung. |
| 2 | Tool-Umbau: `topics`, erweiterter noLocation-Zweig, `enrichment`-Write, Dual-Write; neue Indizes anlegen. | Tests grün. |
| 3 | Backfill `scripts/backfill-enrichment.ts`: alle `newsGeo`-Docs → `news.enrichment` (idempotent, `$set` nur wenn `enrichment` fehlt oder `locatedAt` neuer). Danach `get_news_for_geocoding` auf `enrichment`-Filter umstellen. | Stichproben: Zähl-Abgleich `newsGeo` vs. `news.enrichment`. |
| 4 | Routine `fc_geo_news_locating` anpassen (Auftragstext liegt außerhalb des Repos!): topics + noLocation-Felder aufzählen. webapi-Doku [geonews-restapi-integration.md](../../geonews-restapi-integration.md) auf `news.enrichment.*`-Queries umschreiben (Beanie-Model, Viewport/Top/Countries lesen aus `news`). | Agent liefert topics; webapi umgestellt. |
| 5 | Rückbau: Dual-Write entfernen, `newsGeo` droppen, Top-Level-Duplikate (`relevance`, `geoTitle`, `geoSummary`, `country`, `place`, `geoLocatedAt`) per Skript aus `news` entfernen, webapi-Sortierung auf `enrichment.relevance`. | webapi nutzt ausschließlich `enrichment`. |

Alt-Docs ohne Topics: bleiben zunächst leer; optionaler Nach-Lauf des Agenten
über eine Zeitscheibe ist möglich, aber kein Muss.

## Risiken

1. **Ingester-Schreibverhalten (kritisch, Phase 1):** Schreibt der Ingester
   news-Docs per Replace, löscht jeder Feed-Lauf den `enrichment`-Block.
   Status: unbekannt, wird geprüft.
2. **Routine vergessen:** Neues Tool-Feld ohne Anpassung des Agenten-
   Auftragstexts bleibt dauerhaft leer, ohne Fehler (siehe Warnung in der
   webapi-Doku). Phase 4 ist deshalb expliziter Bestandteil.
3. **Reihenfolge Backfill ↔ Filter-Umstellung:** Filter vor Backfill umstellen
   würde verortete News erneut anbieten. Durch Phasen-Gate abgesichert.
4. **Größe der news-Collection (~500k):** Alle neuen Indizes sind
   sparse/partial bzw. Multikey auf kleinem Teilbestand — unkritisch, aber
   Index-Aufbau dauert einige Minuten.

## Tests

- Unit: `buildEnrichment` (Nachfolger von `buildNewsPatch`) — located,
  noLocation mit/ohne topics, Validierungsfehler.
- Integration (bestehende geonews-Tests erweitern): Submit → `news.enrichment`
  gesetzt, Dual-Write nach `newsGeo` intakt; `get_news_for_geocoding` bietet
  enriched News nicht mehr an.
- Backfill: idempotent, Zähl-Abgleich.
