# Design: Telemetrie für mcp-fc (Port von fc-telemetry)

Datum: 2026-09-23
Status: freigegeben (Marvin): Tool-Aufrufe als Jobs, HTTP-Block, webapi-Flag `has_heartbeat` für mcp mitziehen und beide Dienste deployen.

## Ziel

mcp-fc meldet sich im Admin-Bereich `/admin/system` wie Kraken, Aladin und webapi:
Heartbeat mit Mongo-Lese-/Schreibraten, Prozesswerten, laufenden Jobs und Log-Zählern,
dazu JSON-Logzeilen im fc-telemetry-Schema. Die webapi (`/api/v1/system/*`) und das
Orbit-Live-Bild im Frontend lesen das ohne weitere Änderung.

Referenz ist das Python-Paket `fc-telemetry` v0.1.2 (`~/Documents/Projekte/fc-telemetry`);
dessen Vertrag wird 1:1 übernommen, kein eigenes npm-Paket (YAGNI, einziger Node-Dienst).

## Nicht-Ziele

- Kein gemeinsames Node-Paket, keine neue Abhängigkeit.
- Keine Änderung am Heartbeat-Schema oder an der webapi-Aggregation.
- Kein Graceful-Shutdown-Umbau (das Live-Dokument verfällt per TTL nach 120 s).

## Vertrag (aus fc-telemetry übernommen)

**Heartbeat** — alle 5 s `replaceOne({service, pid}, doc, {upsert: true})` in
`financecentre.systemHeartbeats`; Indizes `{service: 1, pid: 1}` unique und `{ts: 1}`
TTL 120 s. Beim ersten und dann jedem 12. Tick eine Kopie in die capped Collection
`systemHeartbeatHistory` (20 MiB, Index `{service: 1, ts: 1}`, „existiert schon“ = Code 48
ist ok). Eigener Client: Pool 1, `appName: 'fc-telemetry'`, Timeouts 3000/3000/5000 ms.
Schlägt das Schreiben fehl, werden die Zähler ins nächste Dokument übernommen; Warnung
höchstens einmal pro 60 s. Der Dienst scheitert nie am Heartbeat.

Dokument:

| Feld | Inhalt |
|---|---|
| `service` | `"mcp"` (Name aus der webapi-Registry) |
| `ts`, `startedAt` | BSON-Datum (JS `Date`) — Strings verwirft die webapi |
| `pid`, `host`, `version`, `intervalSec` | `process.pid`, `os.hostname()`, s. u., `5` |
| `proc` | `{cpuPct, threads, rssMb}` — CPU über `process.cpuUsage()`-Differenz, Threads aus `/proc/self/status` (Fallback 1), RSS aus `process.memoryUsage.rss()` |
| `mongo` | `{reads, writes, errors, latencyMsAvg, byCollection}` — Deltas seit dem letzten Tick |
| `jobs` | `{current, lastError, errorsTotal}` |
| `logs` | `{warnings, errors}` — Deltas |
| `http` | `{requests, errors5xx, latencyMsAvg}` — Deltas (Provider) |

**Mongo-Aktivität** — Treiber-Option `monitorCommands: true` am Dienst-Client, Ereignisse
`commandStarted/Succeeded/Failed`. Lesen: `find, aggregate, count, countDocuments,
distinct, getMore`; Schreiben: `insert, update, delete, findAndModify, bulkWrite`; alles
andere ignoriert. Collection = `command[commandName]` bzw. bei `getMore`
`command.collection`; Schlüssel `"<db>.<collection>"`; `systemHeartbeats` und
`systemHeartbeatHistory` ausgenommen. Fehlgeschlagene Kommandos zählen als Lesen/Schreiben
und als Fehler. Latenz = Mittel der `duration` (ms, 2 Nachkommastellen). Unbeendete
Kommandos älter als 60 s werden verworfen.

**Logzeilen** — pino schreibt JSON nach stdout (journald), Felder `ts` (ISO mit ms und
`Z`), `service`, `level` (`DEBUG|INFO|WARNING|ERROR|CRITICAL`), `logger` (`mcp-fc`), `msg`,
optional `job`, `duration_ms`, `exc`, `extra`. Die bisherigen Felder werden abgebildet:
`tool` → `job`, `ms` → `duration_ms`, `err` → `exc` (Stack), alles Übrige unter `extra`
(der Journal-Parser der webapi verwirft unbekannte Schlüssel). WARN/ERROR/FATAL zählen für
`logs`.

**Version** — `FC_SERVICE_VERSION`, sonst Kurz-SHA direkt aus `.git` (HEAD, Ref-Datei oder
`packed-refs`; kein `git`-Aufruf), sonst `"unknown"`.

## Abbildung auf mcp-fc

- **Jobs = laufende Tool-Aufrufe.** Jeder Tool-Handler meldet sich für seine Laufzeit unter
  seinem Namen an (`jobs.current`); unerwartete Fehler (`tool failed`) setzen `lastError`
  und zählen `errorsTotal`. `ToolError` (erwartete Nutzerfehler) zählt nicht.
- **HTTP** — Express-Middleware zählt alle Anfragen außer `/healthz` beim `finish`/`close`
  der Antwort (Antworten sind JSON, kein Streaming).
- **Schalter** — `FC_TELEMETRY=off` schaltet Heartbeat und Kommando-Monitoring ab
  (Standard: an). Das Logformat gilt immer.

## Aufbau

Neuer Ordner `src/telemetry/`: `logCounter.ts`, `logging.ts`, `mongoActivity.ts`,
`proc.ts`, `version.ts`, `jobs.ts`, `httpStats.ts`, `heartbeat.ts`, `index.ts`
(`createTelemetry()`, `startHeartbeat()`). Geändert: `config.ts` (`telemetry`),
`db/client.ts` (Aktivität vor `connect()` anhängen), `mcp.ts` (Jobs), `server.ts`
(Verdrahtung).

## webapi

`registry.py`: `mcp` bekommt `has_heartbeat=True`, damit ein aktiver MCP ohne frischen
Heartbeat als `stale` erscheint (wie die Python-Dienste). Test in
`tests/system_ops/test_registry.py`.

## Tests

Vitest-Unit-Tests je Baustein (Logformat, Zähler, Mongo-Aktivität mit Test-Ereignissen,
Heartbeat mit Test-Writer inkl. Historie, Fehler-Übertrag und Warn-Drossel, Jobs, HTTP,
Version, Proc); Integrationstest gegen die lokale Mongo in einer Wegwerf-Datenbank
(Indizes, capped Collection, Schreiben, Monitoring am echten Client). Nach dem Deploy:
Journal zeigt JSON-Zeilen, `systemHeartbeats` enthält `service: "mcp"`, `/admin/system`
zeigt MCP mit Raten.
