# mcp-fc — MCP Server für financecentre (Design)

Datum: 2026-07-14
Status: Approved (Architektur + Tool-Katalog vom User bestätigt; Umsetzung freigegeben)

## Zweck

Ein MCP-Server, der AI-Agenten Finanzdaten (Aktien, Kurse, SEC-Financials, Insider Trades,
13F/Fonds, politische Trades, Makro, News) aus der lokalen MongoDB `financecentre`
bereitstellt. Deployment als plain Node-Prozess auf dem eigenen Server, Zugriff der
Agenten über HTTPS (Reverse Proxy) mit API-Key.

Prioritäten: Performance, token-effizientes Ausgabeformat, Skalierbarkeit, moderner
MCP-Ansatz, erweiterbare Feature-Struktur (v1 read-only, später auch Write-Tools).

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Sprache/Runtime | TypeScript, Node ≥ 20, ESM |
| MCP SDK | `@modelcontextprotocol/sdk` (offiziell) |
| Transport | Streamable HTTP, **stateless** (kein Session-State → horizontal skalierbar, SSE-Transport deprecated) |
| HTTP-Framework | Express (nur Routing/Middleware) |
| Auth v1 | API-Key als `Authorization: Bearer <key>`, Keys mit **Scopes** (`read`, später `write`), austauschbar gegen OAuth 2.1 Verifier |
| MongoDB | Nativer `mongodb`-Treiber, Connection Pooling, lokale Verbindung ohne DB-User (`mongodb://127.0.0.1:27017`), DB `financecentre` |
| Schreibzugriff | DB-Verbindung ist schreibfähig; **alle v1-Tools sind read-only** (Beschränkung auf Tool-/Scope-Ebene, nicht DB-Ebene) |
| Ausgabeformat | Kompakte Pipe-Tabellen bzw. `key: value`-Zeilen, siehe unten |
| Validierung | Zod-Input-Schemas pro Tool |
| Logging | pino, eine Zeile pro Tool-Call (tool, dauer, rows, key-name) |
| Tests | Vitest: Unit (Formatter, Query-Builder) + Integration (Tools via MCP InMemory-Client gegen lokale DB) + E2E (HTTP + Auth) |
| Deployment | `node dist/server.js` via systemd oder pm2, `.env`-Konfiguration, `GET /healthz` |

## Architektur

```
AI Agent ── HTTPS + Bearer <API-Key> ──► Reverse Proxy ──► Node-Prozess
                                                            ├─ Express
                                                            │   ├─ Auth-Middleware (Keys+Scopes)
                                                            │   ├─ POST /mcp (Streamable HTTP, stateless)
                                                            │   └─ GET /healthz (ohne Auth)
                                                            ├─ MCP Server + Feature-Registry
                                                            ├─ format/ (Token-effiziente Ausgabe)
                                                            └─ db/ (Mongo-Client, Pooling)
                                                                 └─► MongoDB financecentre
```

Schichten: `auth/transport` → `features` (Tool-Schema + Formatierung) → `db` (Queries).
Tools kennen kein Express; der Data-Layer kennt kein MCP. Jede Schicht isoliert testbar.

### Projektstruktur

```
src/
├── server.ts              # Express + StreamableHTTPServerTransport + Wiring
├── config.ts              # Env-Parsing (Port, Mongo-URI, API-Keys+Scopes)
├── auth/
│   ├── apiKey.ts          # Bearer-Key-Prüfung (timing-safe), Scope-Auflösung
│   └── types.ts           # AuthContext { keyName, scopes }
├── db/
│   ├── client.ts          # MongoClient Singleton, Pooling, ping
│   ├── collections.ts     # Typisierte Collection-Getter + Namen
│   └── identifiers.ts     # ISIN/Ticker/Name → stockIndex-Auflösung (inkl. cik)
├── format/
│   ├── table.ts           # Pipe-Tabellen, Truncation-Meta-Zeile
│   ├── kv.ts              # key: value-Blöcke (null/leer wird ausgelassen)
│   └── num.ts             # Zahlen-/Datums-Formatierung (Decimal128, YYYY-MM-DD)
└── features/
    ├── index.ts           # Registry: FeatureModule[] → registerAll(server, deps)
    ├── types.ts           # FeatureModule- und ToolDef-Contract
    ├── securities/        # search_securities, get_security_snapshot, screen_stocks
    ├── prices/            # get_price_history
    ├── financials/        # get_financials
    ├── insider/           # get_insider_trades
    ├── funds/             # search_funds, get_fund_holdings
    ├── political/         # get_political_trades
    ├── macro/             # get_macro_series
    └── news/              # search_news
```

### Feature-Modul-Contract

Jedes Modul exportiert ein `FeatureModule`:

```ts
interface ToolDef {
  name: string;
  title: string;
  description: string;        // inkl. Einheiten + Beispiel-Aufruf
  inputSchema: ZodRawShape;
  requiredScope: 'read' | 'write';
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  handler(input, ctx: { db, auth, log }): Promise<string>; // gibt fertigen Text zurück
}

interface FeatureModule { name: string; tools: ToolDef[]; }
```

Registrierung: `features/index.ts` hält die Liste der Module; `registerAll` prüft vor
jedem Handler-Aufruf den Scope des API-Keys. Neues Feature = neuer Ordner + ein
Eintrag in der Liste. Write-Tools später: `requiredScope: 'write'` +
`readOnlyHint: false` — Auth-Gerüst existiert ab v1.

## Tool-Katalog v1 (alle read-only, Scope `read`)

Gemeinsame Regeln:
- `limit` default 25, hart gedeckelt (siehe je Tool). Zeiträume gedeckelt.
- Identifikation von Wertpapieren primär per `isin`; `ticker`/Name werden über
  `stockIndex` aufgelöst (`db/identifiers.ts`). secFinancials wird über `cik`
  (aus `stockIndex.identifiers.cik`) bzw. `ticker` gematcht.
- Immer Projections — nie ganze Dokumente laden. Aggregationen serverseitig.
- Jede Query mit `maxTimeMS: 5000`.

| Tool | Quelle | Parameter | Deckel |
|---|---|---|---|
| `search_securities` | stockIndex | `query` (Name-Substring, Ticker oder ISIN), `limit` | 50 |
| `get_security_snapshot` | stockIndex + stockMetrics + stockPrices (letzter Trade) | `isin` | – |
| `get_price_history` | stockPrices (Aggregation → OHLC) | `isin`, `from`, `to`, `interval: day\|week\|month` (default day) | 400 Kerzen; darüber Fehler mit Hinweis auf gröberes Intervall |
| `screen_stocks` | stockMetrics | `sector?`, `industryGroup?`, `index?`, `country?`, `marketCapMin/Max?`, `sortBy` (return1D…return1Y, returnYTD, marketCap, rangePosition52w), `order`, `limit` | 100 |
| `get_financials` | secFinancials | `identifier` (ISIN oder Ticker), `statements?` ⊆ {income,balance,cashflow} (default alle), `period: annual\|quarterly` (default annual), `periods` (Anzahl, default 4) | 12 Perioden |
| `get_insider_trades` | insiderTrades | `isin?` (sonst marktweit), `from?`, `to?`, `minAmount?`, `transactionType?`, `limit` | 100 |
| `search_funds` | funds | `query` (Name-Substring oder CIK), `limit` | 50 |
| `get_fund_holdings` | f13Filings (+funds) | entweder `fund` (CIK oder Name) → Holdings des letzten Filings, oder `isin` → Top-Holder; `period?`, `limit` | 200 |
| `get_political_trades` | politicalFilings ($unwind trades) | `politician?` (Name-Substring), `ticker?`, `chamber?`, `from?`, `limit` | 100 |
| `get_macro_series` | fred + economicIndicators | ohne `seriesId` → Katalog (id, name, unit, freq, category); mit `seriesId` → Observations `from?`/`to?` | 500 Observations |
| `search_news` | news ($text) | `query`, `from?`, `to?`, `source?`, `category?`, `limit` | 50 |

Bewusst nicht in v1: `topicTrends`, `insiderAnalysis`, `fundsAnalysis`, `newsSources`,
`stockSplits` sowie alle internen Collections (`users`, `chat_conversations`,
`notifications`, `geminiStats`, `modulStats`, `feedHealth`, `stockPriceScanState`).

### Format-Details je Tool (Auszug)

- `get_financials`: Matrix-Format — Zeilen = Posten (nur Posten mit mindestens einem
  Wert), Spalten = Perioden (`FY2025|FY2024|…`). Kopfzeile nennt Währung und Einheit
  (Mio.). Das ist die token-günstigste Darstellung für Periodenvergleiche.
- `get_price_history`: `date|open|high|low|close|volume`-Zeilen, Kopf nennt Währung.
- `get_fund_holdings` (per Fund): `issuer|isin|value(USDk)|shares|pct` sortiert nach
  value desc, Kopf nennt reportPeriod und Portfoliowert.
- `search_news`: `date|source|title|link`; `description` nur auf Anfrage via `fields`.

## Token-effizientes Ausgabeformat

1. **Tabellen**: Erste Zeile Spaltennamen, Pipe-getrennt, kein Padding/Alignment.
   Danach Datenzeilen. Beispiel:
   ```
   isin|ticker|name|sector|mcap(USDm)
   DE0005773303|FRA|Fraport|Industrials|8123
   ```
2. **Truncation-Meta**: Bei abgeschnittenen Ergebnissen erste Zeile
   `# rows 1-100 of 2345 — refine filters or raise offset`. Bei 0 Treffern
   `# 0 rows` plus ggf. Hinweis (z.B. „unknown ISIN — use search_securities").
3. **Einzelobjekte** (Snapshot): `key: value`-Zeilen, null/leere Felder ausgelassen.
4. **Zahlen**: keine wissenschaftliche Notation, max. 4 signifikante Nachkommastellen,
   Geldbeträge in benannter Einheit im Header (z.B. `(USDm)`), Decimal128 → string.
5. **Daten**: `YYYY-MM-DD`; Zeitstempel nur wo nötig (`YYYY-MM-DD HH:mm`).
6. Kein `structuredContent`/JSON-Output in v1 — reiner Text ist token-günstiger.

## Performance & Skalierbarkeit

- Stateless Streamable HTTP: pro Request eigene Transport-Instanz, kein Session-Store →
  N Prozesse hinter Proxy möglich; Prozess-Restart unkritisch.
- Mongo-Connection-Pool (default 10) als Prozess-Singleton.
- Vorhandene Indizes decken alle v1-Queries (geprüft):
  `stockPrices {isin, tradeTime}` / `{isin, tradeDateOnly}`,
  `insiderTrades {isin, transactionDate}` / `{transactionDate}` / `{totalAmount}`,
  `secFinancials {cik, filingType, periodEnd}`, `f13Filings {cik, reportPeriod}` /
  `{holdings.isin}`, `politicalFilings {filer.fullName, filingDate}` /
  `{trades.ticker, filingDate}`, `stockIndex {isin} {ticker} {name}`,
  `news {pubDate}` u.a.
- **Neu anzulegen**: Text-Index auf `news {title, description}` für `search_news`
  (additiv, einmalig bei Implementierung).
- `maxTimeMS: 5000` je Query; Aggregationen mit `allowDiskUse: false`.

## Konfiguration (.env)

```
MCP_PORT=8814
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=financecentre
# Kommagetrennt: <keyName>:<key>=<scope>[+<scope>]
MCP_API_KEYS=agent1:CHANGE_ME_LONG_RANDOM=read
MCP_AUTH_DISABLED=false   # nur für lokale Entwicklung
LOG_LEVEL=info
```

## Fehlerbehandlung

- Ungültige Inputs: Zod-Fehler → MCP-Validation-Error (macht das SDK).
- Fachliche Fehler (unbekannte ISIN, leeres Ergebnis, zu großer Zeitraum):
  `isError: true` mit einer Zeile `ERROR: <was> — <konkreter nächster Schritt>`.
- Query-Timeout → `ERROR: query timed out — narrow the time range or filters`.
- DB nicht erreichbar: Tool-Fehler + `/healthz` zeigt `db: down`; Prozess bleibt oben,
  Reconnect übernimmt der Treiber.
- 401 (fehlender/falscher Key) und 403 (fehlender Scope) auf HTTP-Ebene vor dem MCP-Layer.

## Tests

- **Unit**: `format/*` (Tabellen, Zahlen, Truncation), Query-Builder der Features
  (Filter → Mongo-Pipeline), Key/Scope-Parsing.
- **Integration**: MCP-Client via `InMemoryTransport` direkt gegen den Server,
  echte lokale DB, read-only Assertions auf stabile Fakten
  (z.B. `search_securities("Fraport")` → enthält `DE0005773303`).
- **E2E**: Server auf zufälligem Port booten, `StreamableHTTPClientTransport` mit/ohne
  gültigem Key → 200/401/403-Verhalten.

## Deployment (ohne Docker)

- `npm run build` → `dist/`; Start `node dist/server.js`.
- Repo enthält `deploy/mcp-fc.service` (systemd-Beispiel) und `deploy/DEPLOY.md`
  (Reverse-Proxy-Hinweise: nur `POST /mcp` + `GET /healthz` exponieren, TLS am Proxy).

## Später (bewusst nicht v1)

- OAuth 2.1 (Auth-Middleware austauschen, Scopes existieren schon).
- Write-Tools (`requiredScope: 'write'`), z.B. Watchlists, Annotationen.
- Feature-Module für `topicTrends`, `insiderAnalysis`, `fundsAnalysis`.
- MCP Resources (Schema-/Katalog-Dokumente) und Prompts, falls Agenten sie brauchen.
