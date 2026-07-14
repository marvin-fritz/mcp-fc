# mcp-fc — GeoNews: Geo-Verortung von News für die Kartenansicht (Design)

Datum: 2026-07-14
Status: Approved (Design bestätigt; Ergänzung: `image`-Link wird denormalisiert)

## Zweck

Die App zeigt News auf einer Apple-MapKit-Karte. Ein AI-Agent (extern, z.B. Cron)
arbeitet über den MCP-Server: holt unverortete News, bestimmt Land/Ort selbst
(LLM-Wissen), meldet die Verortung zurück; der MCP schreibt in die neue Collection
`newsGeo` (separat von `news`). **Ein Ort pro Nachricht** (User-Entscheidung).

## Collection `financecentre.newsGeo`

```js
{
  _id: ObjectId,
  newsId: ObjectId,             // Referenz news._id — UNIQUE
  locatable: true,              // false = News ist nicht verortbar (Marker, damit sie nicht erneut vorgelegt wird)
  location: { type: "Point", coordinates: [lon, lat] },  // GeoJSON, WGS84 — MapKit-kompatibel
  country: "DE",                // ISO 3166-1 alpha-2 (uppercase)
  place: "Frankfurt am Main",   // optional (bei precision=country leer)
  precision: "city",            // country | region | city
  confidence: 0.9,              // 0–1
  summary: "…",                 // optional, 1–2 Sätze für den Pin-Callout (max 300 Zeichen)
  // denormalisiert aus news (App liest für die Karte nur newsGeo):
  title, sourceName, link, image, pubDate, category,
  // Meta:
  locatedBy: "geo-agent",       // AuthContext.keyName (API-Key-Name oder OAuth-E-Mail)
  locatedAt: ISODate
}
```

Bei `locatable: false` fehlen location/country/place/precision/confidence/summary;
die denormalisierten Felder und Meta sind trotzdem gesetzt.

Indexe (via `scripts/ensure-indexes.ts`): `{newsId:1}` unique,
`{location:'2dsphere'}` sparse, `{pubDate:-1}`, `{country:1, pubDate:-1}`.
Viewport-Queries der App: `$geoWithin`/`$box` auf `location`; Swift:
`CLLocationCoordinate2D(latitude: coordinates[1], longitude: coordinates[0])`.

## MCP-Tools (Feature-Modul `src/features/geonews/`)

### `get_news_for_geocoding` (Scope `read`)

Neueste News ohne newsGeo-Eintrag. Params: `limit` (default 20, max 50),
`from?`/`to?` (pubDate, YYYY-MM-DD), `category?`. Pipeline: match → sort pubDate
desc → `$limit 500` (Scan-Fenster) → `$lookup` newsGeo via newsId → `$match`
kein Treffer → project → limit+1. Ausgabe-Tabelle:
`newsId|date|category|source|title|description` (description auf 200 Zeichen
gekürzt). Meta-Zeile nennt das Scan-Fenster, damit der Agent bei 0 Treffern das
Zeitfenster verschieben kann.

### `submit_news_locations` (Scope `write` — erstes Write-Tool)

Input: `items` (Array, 1–100), je Eintrag entweder Verortung
(`newsId`, `lat`, `lon`, `country`, `precision`, optional `place`, `confidence`,
`summary`) oder `{ newsId, noLocation: true }`.

Verhalten:
- Batch-Lookup der news-Dokumente (`$in`), Denormalisierung serverseitig
  (title, sourceName, link, image, pubDate, category).
- Pro Eintrag validieren: newsId existiert, lat/lon-Bereiche, country `^[A-Z]{2}$`,
  precision-Enum; bei Verortung sind lat/lon/country/precision Pflicht.
- `replaceOne({newsId}, doc, {upsert: true})` — idempotent, Agent-Retries safe;
  doppelte newsIds im selben Batch: letzter gewinnt.
- Ungültige Einträge brechen den Batch nicht ab: gültige werden geschrieben,
  Fehler einzeln als `ERROR item <i>: <grund>`-Zeilen zurückgemeldet.
- Antwort: `ok: <n> located, <m> noLocation (<u> updated)` + Fehlerzeilen.
- Annotations: `readOnlyHint: false, destructiveHint: false` (additive Upserts).

## Querschnitt

- `cols()`-Whitelist: + `newsGeo`.
- `format/table.ts`: Zellen werden ab jetzt zentral sanitisiert (`|` → `¦`,
  Zeilenumbrüche → Leerzeichen) — Titel/Beschreibungen mit Pipes würden sonst
  jede Tabellenausgabe zerstören (betrifft auch bestehende Tools, gewollter Fix).
- Agent-Zugang: API-Key mit `read+write` (z.B. `geoagent:<key>=read+write`)
  oder OAuth-Login mit admin-Account. Scope-Enforcement existiert bereits.

## Agent-Workflow (Referenz)

```
loop:
  get_news_for_geocoding {limit: 20}
  → für jede Zeile Ort bestimmen (oder noLocation)
  → submit_news_locations {items: […]}
  bis "# 0 rows"
```

## Tests

- Unit: table()-Sanitisierung (Pipe/Newline in Zellen).
- Integration (`tests/integration/geonews.test.ts`): 3 Test-News mit eigener
  Kategorie `MCPFCTEST` (isoliert die Tests von echten Daten; lokale news-Kopie
  hat u.a. falsch datierte Zukunfts-Artikel) + Teardown löscht Test-News und
  deren newsGeo-Einträge. Fälle: Fetch liefert die 3; Submit (2 Orte + 1
  noLocation) → Zählungen + Dokumente inkl. [lon,lat], image, locatedBy;
  erneuter Fetch → 0 rows; Re-Submit → update (Idempotenz); ungültige Einträge
  → Fehlerzeilen, gültige geschrieben; read-only Key → Scope-Fehler.

## Nicht enthalten (YAGNI)

- Kein Geocoding im MCP selbst (der Agent verortet).
- Keine Mehrfach-Orte pro News (Schema später um Zusatzfeld erweiterbar).
- Kein Lese-Tool für die Karte (die App liest Mongo direkt bzw. über ihre API).
