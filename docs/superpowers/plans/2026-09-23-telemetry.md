# Telemetrie für mcp-fc — Implementierungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** mcp-fc schreibt Heartbeats und JSON-Logs nach dem fc-telemetry-Vertrag, damit `/admin/system` den MCP wie die Python-Dienste zeigt (Spec: `docs/superpowers/specs/2026-09-23-telemetry-design.md`).

**Architecture:** Kleine, einzeln testbare Bausteine in `src/telemetry/` (Log-Format, Zähler, Mongo-Aktivität, Prozesswerte, Version, Jobs, HTTP, Heartbeat); `server.ts` verdrahtet sie. Tool-Aufrufe gelten als Jobs. Die webapi bekommt `has_heartbeat=True` für `mcp`.

**Tech Stack:** Node ≥ 20 (Server: 24), TypeScript (NodeNext, strict), mongodb 7.5, pino 10, express 5, Vitest 4.

## Global Constraints

- Repo `~/Documents/Projekte/mcp-fc`, Branch `feat/telemetry`; webapi `~/Documents/Projekte/Finanz-Copilot/webapi`, Branch `main`.
- Code-Kommentare englisch (wie im Repo), Heartbeat-Warntexte deutsch wie in fc-telemetry.
- Dienstname im Heartbeat und in Logzeilen: `mcp` (Registry-Name der webapi).
- `ts` und `startedAt` als `Date`, nie als String.
- Keine neuen Abhängigkeiten.
- Codeblöcke mit `file=` enthalten den vollständigen Dateiinhalt.
- Tests: `npx vitest run <pfad>`; Typprüfung: `npx tsc -p tsconfig.json --noEmit`.
- Commits enden mit `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

---

### Task 1: Logformat und Log-Zähler

**Files:** Create `src/telemetry/logCounter.ts`, `src/telemetry/logging.ts`; Test `tests/unit/telemetry-logging.test.ts`

**Interfaces — Produces:** `class LogCounter { record(level: number): void; snapshotAndReset(): { warnings: number; errors: number } }`; `toTelemetryFields(obj)`; `telemetryLoggerOptions({ service, level, logger?, counter? }): LoggerOptions`.

- [ ] **Step 1: Test schreiben**

```ts file=tests/unit/telemetry-logging.test.ts
import { describe, expect, it } from 'vitest';
import pino from 'pino';
import { LogCounter } from '../../src/telemetry/logCounter.js';
import { telemetryLoggerOptions, toTelemetryFields } from '../../src/telemetry/logging.js';

function capture(counter?: LogCounter) {
  const lines: Record<string, unknown>[] = [];
  const log = pino(telemetryLoggerOptions({ service: 'mcp', level: 'debug', counter }), {
    write: (line: string) => {
      lines.push(JSON.parse(line));
    },
  });
  return { log, lines };
}

describe('telemetry log format', () => {
  it('writes fc-telemetry fields with Python level names and an ISO timestamp', () => {
    const { log, lines } = capture();
    log.info('mcp-fc listening on :8814');
    log.warn('slow');
    expect(lines[0]).toMatchObject({ service: 'mcp', logger: 'mcp-fc', level: 'INFO', msg: 'mcp-fc listening on :8814' });
    expect(lines[0].ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(lines[1].level).toBe('WARNING');
    expect(lines[0]).not.toHaveProperty('pid');
    expect(lines[0]).not.toHaveProperty('time');
  });

  it('maps tool/ms/err to job/duration_ms/exc and nests everything else under extra', () => {
    const { log, lines } = capture();
    log.info({ tool: 'get_financials', key: 'agent1', ms: 42 }, 'tool ok');
    log.error({ tool: 'search_news', err: new Error('kaputt') }, 'tool failed');
    expect(lines[0]).toMatchObject({ job: 'get_financials', duration_ms: 42, extra: { key: 'agent1' }, msg: 'tool ok' });
    expect(lines[0]).not.toHaveProperty('tool');
    expect(lines[1].level).toBe('ERROR');
    expect(String(lines[1].exc)).toContain('Error: kaputt');
  });

  it('counts warnings and errors, fatal as error', () => {
    const counter = new LogCounter();
    const { log } = capture(counter);
    log.info('a');
    log.warn('b');
    log.error('c');
    log.fatal('d');
    expect(counter.snapshotAndReset()).toEqual({ warnings: 1, errors: 2 });
    expect(counter.snapshotAndReset()).toEqual({ warnings: 0, errors: 0 });
  });

  it('keeps a plain string error as is', () => {
    expect(toTelemetryFields({ err: 'boom' })).toEqual({ exc: 'boom' });
  });
});
```

- [ ] **Step 2: Laufen lassen — FAIL** (`npx vitest run tests/unit/telemetry-logging.test.ts`, Module fehlen)

- [ ] **Step 3: Implementieren**

```ts file=src/telemetry/logCounter.ts
/** Counts WARNING/ERROR log lines (pino levels >= 40 / >= 50) for the heartbeat `logs` block. */
export class LogCounter {
  private warnings = 0;
  private errors = 0;

  record(level: number): void {
    if (level >= 50) this.errors += 1;
    else if (level >= 40) this.warnings += 1;
  }

  snapshotAndReset(): { warnings: number; errors: number } {
    const snap = { warnings: this.warnings, errors: this.errors };
    this.warnings = 0;
    this.errors = 0;
    return snap;
  }
}
```

```ts file=src/telemetry/logging.ts
import type { LoggerOptions } from 'pino';
import type { LogCounter } from './logCounter.js';

/** pino level label -> Python level name, as the webapi journal parser expects. */
const LEVEL_NAMES: Record<string, string> = {
  trace: 'DEBUG',
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARNING',
  error: 'ERROR',
  fatal: 'CRITICAL',
};

function formatError(value: unknown): string {
  if (value instanceof Error) return value.stack ?? `${value.name}: ${value.message}`;
  if (value && typeof value === 'object') {
    const err = value as { stack?: unknown; type?: unknown; message?: unknown };
    if (typeof err.stack === 'string') return err.stack;
    if (typeof err.message === 'string') return typeof err.type === 'string' ? `${err.type}: ${err.message}` : err.message;
  }
  return String(value);
}

/**
 * Maps a pino log object onto the fc-telemetry line schema: `job`, `duration_ms` and
 * `exc` stay top-level (the existing `tool` / `ms` / `err` fields are renamed to them),
 * everything else moves under `extra` — the webapi journal parser drops unknown keys.
 */
export function toTelemetryFields(obj: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const extra: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (key === 'job' || key === 'tool') out.job = value;
    else if (key === 'duration_ms' || key === 'ms') out.duration_ms = value;
    else if (key === 'exc' || key === 'err') out.exc = formatError(value);
    else extra[key] = value;
  }
  if (Object.keys(extra).length > 0) out.extra = extra;
  return out;
}

export interface TelemetryLoggerConfig {
  service: string;
  level: string;
  logger?: string;
  counter?: LogCounter;
}

/** pino options producing one fc-telemetry JSON line per event (ts, service, level, logger, msg, …). */
export function telemetryLoggerOptions({ service, level, logger = 'mcp-fc', counter }: TelemetryLoggerConfig): LoggerOptions {
  return {
    level,
    base: { service, logger },
    messageKey: 'msg',
    timestamp: () => `,"ts":"${new Date().toISOString()}"`,
    formatters: {
      level: (label) => ({ level: LEVEL_NAMES[label] ?? label.toUpperCase() }),
      log: (obj) => toTelemetryFields(obj),
    },
    // pino rejects `hooks: undefined` (it replaces the defaults) — only set the key when counting.
    ...(counter && {
      hooks: {
        logMethod(args, method, levelNumber) {
          counter.record(levelNumber);
          return method.apply(this, args);
        },
      },
    }),
  };
}
```

- [ ] **Step 4: Laufen lassen — PASS**, `npx tsc -p tsconfig.json --noEmit` ohne Fehler.
- [ ] **Step 5: Commit** `feat(telemetry): fc-telemetry-Logformat und Log-Zähler`

---

### Task 2: Mongo-Aktivität

**Files:** Create `src/telemetry/mongoActivity.ts`; Test `tests/unit/telemetry-mongo.test.ts`

**Interfaces — Produces:** `interface MongoSnapshot { reads; writes; errors; latencyMsAvg; byCollection: Record<string, { reads; writes }> }`; `class MongoActivity { constructor(clock?: () => number); attach(client: MongoClient): void; started(e): void; finish(e, failed: boolean): void; snapshotAndReset(): MongoSnapshot }`.

- [ ] **Step 1: Test schreiben**

```ts file=tests/unit/telemetry-mongo.test.ts
import { describe, expect, it } from 'vitest';
import { MongoActivity } from '../../src/telemetry/mongoActivity.js';

let requestId = 0;

function run(
  activity: MongoActivity,
  commandName: string,
  command: Record<string, unknown>,
  opts: { db?: string; duration?: number; failed?: boolean } = {},
) {
  requestId += 1;
  activity.started({ commandName, command, databaseName: opts.db ?? 'financecentre', requestId });
  activity.finish({ requestId, duration: opts.duration ?? 2 }, opts.failed ?? false);
}

describe('MongoActivity', () => {
  it('counts reads and writes per db.collection and averages the latency', () => {
    const activity = new MongoActivity();
    run(activity, 'find', { find: 'news' }, { duration: 3 });
    run(activity, 'aggregate', { aggregate: 'news' }, { duration: 5 });
    run(activity, 'insert', { insert: 'newsGeo' }, { duration: 1 });
    run(activity, 'find', { find: 'oauthClients' }, { db: 'mcp-fc', duration: 3 });
    expect(activity.snapshotAndReset()).toEqual({
      reads: 3,
      writes: 1,
      errors: 0,
      latencyMsAvg: 3,
      byCollection: {
        'financecentre.news': { reads: 2, writes: 0 },
        'financecentre.newsGeo': { reads: 0, writes: 1 },
        'mcp-fc.oauthClients': { reads: 1, writes: 0 },
      },
    });
    expect(activity.snapshotAndReset()).toEqual({ reads: 0, writes: 0, errors: 0, latencyMsAvg: 0, byCollection: {} });
  });

  it('takes the collection of getMore from command.collection', () => {
    const activity = new MongoActivity();
    run(activity, 'getMore', { getMore: 12345, collection: 'insiderTrades' });
    expect(activity.snapshotAndReset().byCollection).toEqual({ 'financecentre.insiderTrades': { reads: 1, writes: 0 } });
  });

  it('ignores other commands and the heartbeat collections', () => {
    const activity = new MongoActivity();
    run(activity, 'ping', { ping: 1 });
    run(activity, 'createIndexes', { createIndexes: 'news' });
    run(activity, 'update', { update: 'systemHeartbeats' });
    run(activity, 'insert', { insert: 'systemHeartbeatHistory' });
    expect(activity.snapshotAndReset()).toMatchObject({ reads: 0, writes: 0, byCollection: {} });
  });

  it('counts a failed command as write and as error', () => {
    const activity = new MongoActivity();
    run(activity, 'update', { update: 'news' }, { failed: true });
    expect(activity.snapshotAndReset()).toMatchObject({ writes: 1, errors: 1 });
  });

  it('ignores finish events without a matching start', () => {
    const activity = new MongoActivity();
    activity.finish({ requestId: 999_999, duration: 1 }, false);
    expect(activity.snapshotAndReset().reads).toBe(0);
  });

  it('drops in-flight commands older than 60 s', () => {
    let now = 0;
    const activity = new MongoActivity(() => now);
    activity.started({ commandName: 'find', command: { find: 'news' }, databaseName: 'financecentre', requestId: 424242 });
    now = 61_000;
    activity.snapshotAndReset();
    activity.finish({ requestId: 424242, duration: 1 }, false);
    expect(activity.snapshotAndReset().reads).toBe(0);
  });
});
```

- [ ] **Step 2: FAIL** — **Step 3: Implementieren**

```ts file=src/telemetry/mongoActivity.ts
import type { CommandFailedEvent, CommandStartedEvent, CommandSucceededEvent, MongoClient } from 'mongodb';

export const READ_COMMANDS: ReadonlySet<string> = new Set(['find', 'aggregate', 'count', 'countDocuments', 'distinct', 'getMore']);
export const WRITE_COMMANDS: ReadonlySet<string> = new Set(['insert', 'update', 'delete', 'findAndModify', 'bulkWrite']);
const IGNORED_COLLECTIONS: ReadonlySet<string> = new Set(['systemHeartbeats', 'systemHeartbeatHistory']);
const INFLIGHT_MAX_AGE_MS = 60_000;
const INFLIGHT_MAX_ENTRIES = 10_000;

type Kind = 'reads' | 'writes';

export interface CollectionCounts {
  reads: number;
  writes: number;
}

export interface MongoSnapshot {
  reads: number;
  writes: number;
  errors: number;
  latencyMsAvg: number;
  byCollection: Record<string, CollectionCounts>;
}

export type StartedEvent = Pick<CommandStartedEvent, 'commandName' | 'command' | 'databaseName' | 'requestId'>;
export type FinishedEvent = Pick<CommandSucceededEvent | CommandFailedEvent, 'requestId' | 'duration'>;

function collectionOf(commandName: string, command: Record<string, unknown>): string | null {
  const coll = commandName === 'getMore' ? (command.collection ?? command.getMore) : command[commandName];
  return typeof coll === 'string' ? coll : null;
}

const round2 = (value: number) => Math.round(value * 100) / 100;

/**
 * Process-wide MongoDB command counters (fc-telemetry `mongo` block), fed by the
 * driver's command monitoring. Counts are deltas since the last snapshot.
 */
export class MongoActivity {
  private readonly clock: () => number;
  private readonly inflight = new Map<number, { kind: Kind; coll: string; at: number }>();
  private reads = 0;
  private writes = 0;
  private errors = 0;
  private latencyMs = 0;
  private count = 0;
  private byCollection: Record<string, CollectionCounts> = {};

  constructor(clock: () => number = Date.now) {
    this.clock = clock;
  }

  /** Needs a client created with `monitorCommands: true`; attach before `connect()`. */
  attach(client: MongoClient): void {
    client.on('commandStarted', (event) => this.started(event));
    client.on('commandSucceeded', (event) => this.finish(event, false));
    client.on('commandFailed', (event) => this.finish(event, true));
  }

  started(event: StartedEvent): void {
    const kind: Kind | null = READ_COMMANDS.has(event.commandName) ? 'reads' : WRITE_COMMANDS.has(event.commandName) ? 'writes' : null;
    if (!kind) return;
    const coll = collectionOf(event.commandName, event.command as Record<string, unknown>);
    if (coll === null || IGNORED_COLLECTIONS.has(coll)) return;
    if (this.inflight.size > INFLIGHT_MAX_ENTRIES) this.inflight.clear();
    this.inflight.set(event.requestId, { kind, coll: `${event.databaseName}.${coll}`, at: this.clock() });
  }

  finish(event: FinishedEvent, failed: boolean): void {
    const entry = this.inflight.get(event.requestId);
    if (!entry) return;
    this.inflight.delete(event.requestId);
    if (entry.kind === 'reads') this.reads += 1;
    else this.writes += 1;
    if (failed) this.errors += 1;
    this.latencyMs += event.duration;
    this.count += 1;
    const bucket = (this.byCollection[entry.coll] ??= { reads: 0, writes: 0 });
    bucket[entry.kind] += 1;
  }

  snapshotAndReset(): MongoSnapshot {
    const now = this.clock();
    for (const [id, entry] of this.inflight) {
      if (now - entry.at > INFLIGHT_MAX_AGE_MS) this.inflight.delete(id);
    }
    const snap: MongoSnapshot = {
      reads: this.reads,
      writes: this.writes,
      errors: this.errors,
      latencyMsAvg: this.count ? round2(this.latencyMs / this.count) : 0,
      byCollection: this.byCollection,
    };
    this.reads = 0;
    this.writes = 0;
    this.errors = 0;
    this.latencyMs = 0;
    this.count = 0;
    this.byCollection = {};
    return snap;
  }
}
```

- [ ] **Step 4: PASS + tsc** — **Step 5: Commit** `feat(telemetry): Mongo-Kommandos zählen (fc-telemetry-Vertrag)`

---

### Task 3: Prozesswerte, Version, Jobs, HTTP

**Files:** Create `src/telemetry/proc.ts`, `src/telemetry/version.ts`, `src/telemetry/jobs.ts`, `src/telemetry/httpStats.ts`; Test `tests/unit/telemetry-units.test.ts`

**Interfaces — Produces:** `class ProcStats { constructor(clock?: () => number /* s */, statusPath?: string); snapshot(): { cpuPct; threads; rssMb } }`; `detectVersion(env?, cwd?): string`; `interface JobError { job; type; message; ts }`, `interface JobState { current: string[]; lastError: JobError | null; errorsTotal: number }`, `class JobTracker { start(name): () => void; recordError(name, error): void; state(): JobState }`; `interface HttpSnapshot { requests; errors5xx; latencyMsAvg }`, `class HttpStats { middleware(): RequestHandler; record(status, elapsedMs): void; snapshotAndReset(): HttpSnapshot }`.

- [ ] **Step 1: Test schreiben**

```ts file=tests/unit/telemetry-units.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import express from 'express';
import { describe, expect, it } from 'vitest';
import { HttpStats } from '../../src/telemetry/httpStats.js';
import { JobTracker } from '../../src/telemetry/jobs.js';
import { ProcStats } from '../../src/telemetry/proc.js';
import { detectVersion } from '../../src/telemetry/version.js';

describe('JobTracker', () => {
  it('lists running jobs sorted and counts parallel runs of the same job', () => {
    const jobs = new JobTracker();
    const endFirst = jobs.start('search_news');
    const endOther = jobs.start('get_financials');
    const endSecond = jobs.start('search_news');
    expect(jobs.state().current).toEqual(['get_financials', 'search_news']);
    endFirst();
    expect(jobs.state().current).toEqual(['get_financials', 'search_news']);
    endSecond();
    endSecond();
    endOther();
    expect(jobs.state().current).toEqual([]);
  });

  it('records the last error with type, truncated message and ISO timestamp', () => {
    const jobs = new JobTracker(() => new Date('2026-09-23T10:00:00.000Z'));
    class MongoServerSelectionError extends Error {
      override name = 'MongoServerSelectionError';
    }
    jobs.recordError('get_prices', new MongoServerSelectionError('x'.repeat(600)));
    const first = jobs.state().lastError;
    expect(first?.type).toBe('MongoServerSelectionError');
    expect(first?.message).toHaveLength(500);
    jobs.recordError('search_news', 'kaputt');
    expect(jobs.state()).toMatchObject({
      errorsTotal: 2,
      lastError: { job: 'search_news', type: 'Error', message: 'kaputt', ts: '2026-09-23T10:00:00.000Z' },
    });
  });
});

describe('HttpStats', () => {
  it('counts requests, 5xx and latency but skips /healthz', async () => {
    let now = 0;
    const stats = new HttpStats(() => (now += 10));
    const app = express();
    app.use(stats.middleware());
    app.get('/healthz', (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/mcp', (_req, res) => {
      res.json({ ok: true });
    });
    app.post('/boom', (_req, res) => {
      res.status(503).json({ error: 'down' });
    });
    const server = app.listen(0);
    const { port } = server.address() as AddressInfo;
    try {
      await fetch(`http://127.0.0.1:${port}/healthz`);
      await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
      await fetch(`http://127.0.0.1:${port}/boom`, { method: 'POST' });
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      server.closeAllConnections();
      server.close();
    }
    expect(stats.snapshotAndReset()).toEqual({ requests: 2, errors5xx: 1, latencyMsAvg: 10 });
    expect(stats.snapshotAndReset()).toEqual({ requests: 0, errors5xx: 0, latencyMsAvg: 0 });
  });
});

describe('detectVersion', () => {
  const sha = `db41124${'a'.repeat(33)}`;

  function repo(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'fc-version-'));
    for (const [path, content] of Object.entries(files)) {
      const full = join(dir, '.git', path);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return dir;
  }

  it('prefers FC_SERVICE_VERSION', () => {
    expect(detectVersion({ FC_SERVICE_VERSION: '1.2.3' }, '/nonexistent')).toBe('1.2.3');
  });

  it('reads the short SHA of the checked-out branch', () => {
    expect(detectVersion({}, repo({ HEAD: 'ref: refs/heads/main\n', 'refs/heads/main': `${sha}\n` }))).toBe('db41124');
  });

  it('falls back to packed-refs', () => {
    const dir = repo({ HEAD: 'ref: refs/heads/main\n', 'packed-refs': `# pack-refs with: peeled fully-peeled sorted\n${sha} refs/heads/main\n` });
    expect(detectVersion({}, dir)).toBe('db41124');
  });

  it('handles a detached HEAD', () => {
    expect(detectVersion({}, repo({ HEAD: `${sha}\n` }))).toBe('db41124');
  });

  it('returns unknown without git metadata', () => {
    expect(detectVersion({}, '/nonexistent')).toBe('unknown');
  });
});

describe('ProcStats', () => {
  it('reports rss, threads and a non-negative cpu share (0 on the first call)', () => {
    let wall = 0;
    const proc = new ProcStats(() => (wall += 1));
    const first = proc.snapshot();
    expect(first.cpuPct).toBe(0);
    expect(first.rssMb).toBeGreaterThan(0);
    expect(first.threads).toBeGreaterThanOrEqual(1);
    expect(Object.keys(first)).toEqual(['cpuPct', 'threads', 'rssMb']);
    expect(proc.snapshot().cpuPct).toBeGreaterThanOrEqual(0);
  });
});
```

- [ ] **Step 2: FAIL** — **Step 3: Implementieren**

```ts file=src/telemetry/proc.ts
import { readFileSync } from 'node:fs';

export interface ProcSnapshot {
  cpuPct: number;
  threads: number;
  rssMb: number;
}

function readThreads(statusPath: string): number | null {
  try {
    const match = readFileSync(statusPath, 'utf8').match(/^Threads:\s+(\d+)/m);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

/** Process metrics without extra deps: CPU share since the last call, OS threads, RSS. */
export class ProcStats {
  private readonly clock: () => number;
  private readonly statusPath: string;
  private lastCpuSec: number | null = null;
  private lastWallSec: number | null = null;

  /** `clock` returns seconds (monotonic). */
  constructor(clock: () => number = () => performance.now() / 1000, statusPath = '/proc/self/status') {
    this.clock = clock;
    this.statusPath = statusPath;
  }

  snapshot(): ProcSnapshot {
    const usage = process.cpuUsage();
    const cpuSec = (usage.user + usage.system) / 1e6;
    const wallSec = this.clock();
    let cpuPct = 0;
    if (this.lastCpuSec !== null && this.lastWallSec !== null && wallSec > this.lastWallSec) {
      cpuPct = Math.round(((cpuSec - this.lastCpuSec) / (wallSec - this.lastWallSec)) * 1000) / 10;
    }
    this.lastCpuSec = cpuSec;
    this.lastWallSec = wallSec;
    return {
      cpuPct: Math.max(0, cpuPct),
      threads: readThreads(this.statusPath) ?? 1,
      rssMb: Math.round((process.memoryUsage.rss() / (1024 * 1024)) * 10) / 10,
    };
  }
}
```

```ts file=src/telemetry/version.ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHORT = 7;

function readGitSha(cwd: string): string | null {
  const gitDir = join(cwd, '.git');
  const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim();
  if (/^[0-9a-f]{40}$/.test(head)) return head.slice(0, SHORT);
  const ref = head.match(/^ref: (.+)$/)?.[1];
  if (!ref) return null;
  try {
    return readFileSync(join(gitDir, ref), 'utf8').trim().slice(0, SHORT);
  } catch {
    const line = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
      .split('\n')
      .find((entry) => entry.endsWith(` ${ref}`));
    return line ? line.slice(0, SHORT) : null;
  }
}

/**
 * Version of the running service: `FC_SERVICE_VERSION`, else the short git SHA read
 * straight from `.git` (no `git` binary, works under the service user), else `unknown`.
 */
export function detectVersion(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): string {
  if (env.FC_SERVICE_VERSION) return env.FC_SERVICE_VERSION;
  try {
    return readGitSha(cwd) ?? 'unknown';
  } catch {
    return 'unknown';
  }
}
```

```ts file=src/telemetry/jobs.ts
export interface JobError {
  job: string;
  type: string;
  message: string;
  ts: string;
}

export interface JobState {
  current: string[];
  lastError: JobError | null;
  errorsTotal: number;
}

const MESSAGE_MAX = 500;

/** Running jobs (for mcp-fc: tool calls) and the last job failure, process-wide. */
export class JobTracker {
  private readonly now: () => Date;
  private readonly active = new Map<string, number>();
  private lastError: JobError | null = null;
  private errorsTotal = 0;

  constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Marks `name` as running; the returned function ends this run (idempotent). */
  start(name: string): () => void {
    this.active.set(name, (this.active.get(name) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (this.active.get(name) ?? 1) - 1;
      if (left <= 0) this.active.delete(name);
      else this.active.set(name, left);
    };
  }

  recordError(name: string, error: unknown): void {
    const err = error instanceof Error ? error : new Error(String(error));
    this.errorsTotal += 1;
    this.lastError = {
      job: name,
      type: err.name || 'Error',
      message: err.message.slice(0, MESSAGE_MAX),
      ts: this.now().toISOString(),
    };
  }

  state(): JobState {
    return {
      current: [...this.active.keys()].sort(),
      lastError: this.lastError ? { ...this.lastError } : null,
      errorsTotal: this.errorsTotal,
    };
  }
}
```

```ts file=src/telemetry/httpStats.ts
import type { RequestHandler } from 'express';

export interface HttpSnapshot {
  requests: number;
  errors5xx: number;
  latencyMsAvg: number;
}

/**
 * Request counters for the heartbeat `http` block (like webapi's RequestStatsMiddleware).
 * Measured when the response finishes — mcp-fc answers with plain JSON, no streaming.
 */
export class HttpStats {
  private readonly clock: () => number;
  private readonly ignoredPaths: ReadonlySet<string>;
  private requests = 0;
  private errors5xx = 0;
  private latencySumMs = 0;

  constructor(clock: () => number = () => performance.now(), ignoredPaths: ReadonlySet<string> = new Set(['/healthz'])) {
    this.clock = clock;
    this.ignoredPaths = ignoredPaths;
  }

  record(status: number, elapsedMs: number): void {
    this.requests += 1;
    this.latencySumMs += elapsedMs;
    if (status >= 500) this.errors5xx += 1;
  }

  middleware(): RequestHandler {
    return (req, res, next) => {
      if (this.ignoredPaths.has(req.path)) {
        next();
        return;
      }
      const started = this.clock();
      let recorded = false;
      const finish = () => {
        if (recorded) return;
        recorded = true;
        this.record(res.statusCode, this.clock() - started);
      };
      res.once('finish', finish);
      res.once('close', finish);
      next();
    };
  }

  snapshotAndReset(): HttpSnapshot {
    const snap = {
      requests: this.requests,
      errors5xx: this.errors5xx,
      latencyMsAvg: this.requests ? Math.round((this.latencySumMs / this.requests) * 100) / 100 : 0,
    };
    this.requests = 0;
    this.errors5xx = 0;
    this.latencySumMs = 0;
    return snap;
  }
}
```

- [ ] **Step 4: PASS + tsc** — **Step 5: Commit** `feat(telemetry): Prozesswerte, Version, Jobs und HTTP-Zähler`

---

### Task 4: Heartbeat

**Files:** Create `src/telemetry/heartbeat.ts`; Tests `tests/unit/telemetry-heartbeat.test.ts`, `tests/integration/telemetry.test.ts`

**Interfaces — Consumes:** Task 1–3. **Produces:** `LIVE_COLLECTION`, `HISTORY_COLLECTION`, `type HeartbeatDoc`, `interface HeartbeatWriter { ensureSetup(); write(doc, history); close() }`, `class MongoHeartbeatWriter(uri, database)`, `mergeCounters(pending, doc)`, `class Heartbeat { constructor(HeartbeatOptions); buildDocument(); tick(): Promise<HeartbeatDoc | null>; start(); stop() }`.

- [ ] **Step 1: Tests schreiben**

```ts file=tests/unit/telemetry-heartbeat.test.ts
import { describe, expect, it, vi } from 'vitest';
import { Heartbeat, mergeCounters, type HeartbeatDoc, type HeartbeatOptions, type HeartbeatWriter } from '../../src/telemetry/heartbeat.js';
import { JobTracker } from '../../src/telemetry/jobs.js';
import { LogCounter } from '../../src/telemetry/logCounter.js';
import { MongoActivity } from '../../src/telemetry/mongoActivity.js';

class FakeWriter implements HeartbeatWriter {
  setups = 0;
  writes: Array<{ doc: HeartbeatDoc; history: boolean }> = [];
  failNext = 0;
  closed = false;

  async ensureSetup(): Promise<void> {
    this.setups += 1;
  }

  async write(doc: HeartbeatDoc, history: boolean): Promise<void> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      throw new Error('mongo down');
    }
    this.writes.push({ doc, history });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function heartbeat(writer: FakeWriter, extra: Partial<HeartbeatOptions> = {}): Heartbeat {
  return new Heartbeat({ service: 'mcp', writer, version: 'db41124', now: () => new Date('2026-09-23T10:00:00.000Z'), ...extra });
}

let requestId = 0;
function feed(activity: MongoActivity, commandName: string, coll: string, duration = 2): void {
  requestId += 1;
  activity.started({ commandName, command: { [commandName]: coll }, databaseName: 'financecentre', requestId });
  activity.finish({ requestId, duration }, false);
}

describe('Heartbeat', () => {
  it('builds the fc-telemetry document with Date fields and provider blocks', async () => {
    const activity = new MongoActivity();
    feed(activity, 'find', 'news', 4);
    const jobs = new JobTracker();
    jobs.start('search_news');
    const logCounter = new LogCounter();
    logCounter.record(40);
    const writer = new FakeWriter();
    const doc = await heartbeat(writer, {
      activity,
      jobs,
      logCounter,
      providers: { http: () => ({ requests: 3, errors5xx: 0, latencyMsAvg: 12 }) },
    }).tick();
    expect(doc).toMatchObject({
      service: 'mcp',
      pid: process.pid,
      version: 'db41124',
      intervalSec: 5,
      mongo: { reads: 1, writes: 0, errors: 0, latencyMsAvg: 4, byCollection: { 'financecentre.news': { reads: 1, writes: 0 } } },
      jobs: { current: ['search_news'], lastError: null, errorsTotal: 0 },
      logs: { warnings: 1, errors: 0 },
      http: { requests: 3, errors5xx: 0, latencyMsAvg: 12 },
    });
    expect(doc?.ts).toBeInstanceOf(Date);
    expect(doc?.startedAt).toBeInstanceOf(Date);
    expect(typeof doc?.host).toBe('string');
    expect(Object.keys(doc?.proc ?? {})).toEqual(['cpuPct', 'threads', 'rssMb']);
  });

  it('sets up once and writes history on the first and every 12th tick', async () => {
    const writer = new FakeWriter();
    const hb = heartbeat(writer);
    for (let i = 0; i < 13; i++) await hb.tick();
    expect(writer.setups).toBe(1);
    expect(writer.writes.map((w) => w.history)).toEqual([true, ...Array<boolean>(11).fill(false), true]);
  });

  it('carries counters of failed writes into the next document and warns at most once a minute', async () => {
    let clock = 0;
    const warnings: string[] = [];
    const activity = new MongoActivity();
    const writer = new FakeWriter();
    writer.failNext = 2;
    const hb = heartbeat(writer, { activity, clock: () => clock, onWarn: (message) => warnings.push(message) });
    feed(activity, 'insert', 'newsGeo');
    expect(await hb.tick()).toBeNull();
    clock = 10_000;
    feed(activity, 'insert', 'newsGeo');
    expect(await hb.tick()).toBeNull();
    clock = 20_000;
    feed(activity, 'insert', 'newsGeo');
    const doc = await hb.tick();
    expect(doc?.mongo).toMatchObject({ writes: 3, byCollection: { 'financecentre.newsGeo': { reads: 0, writes: 3 } } });
    expect(warnings).toEqual(['Heartbeat konnte nicht geschrieben werden: Error: mongo down']);
  });

  it('keeps writing when a provider throws', async () => {
    const warnings: string[] = [];
    const writer = new FakeWriter();
    const doc = await heartbeat(writer, {
      providers: {
        http: () => {
          throw new Error('kaputt');
        },
      },
      onWarn: (message) => warnings.push(message),
    }).tick();
    expect(doc).not.toHaveProperty('http');
    expect(writer.writes).toHaveLength(1);
    expect(warnings[0]).toContain("Heartbeat-Provider 'http' fehlgeschlagen");
  });

  it('ticks on start and on every interval, stop() closes the writer', async () => {
    vi.useFakeTimers();
    try {
      const writer = new FakeWriter();
      const hb = heartbeat(writer, { intervalSec: 5 });
      hb.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(writer.writes).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(10_000);
      expect(writer.writes).toHaveLength(3);
      await hb.stop();
      expect(writer.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('mergeCounters', () => {
  it('adds mongo, logs and provider counters and weights the mongo latency', () => {
    const pending = {
      mongo: { reads: 1, writes: 1, errors: 1, latencyMsAvg: 4, byCollection: { 'financecentre.news': { reads: 1, writes: 1 } } },
      logs: { warnings: 1, errors: 0 },
      http: { requests: 2, errors5xx: 1, latencyMsAvg: 50 },
    };
    const doc = {
      mongo: { reads: 2, writes: 0, errors: 0, latencyMsAvg: 1, byCollection: { 'financecentre.news': { reads: 2, writes: 0 } } },
      logs: { warnings: 0, errors: 2 },
      http: { requests: 1, errors5xx: 0, latencyMsAvg: 10 },
    };
    mergeCounters(pending, doc);
    expect(doc).toEqual({
      mongo: { reads: 3, writes: 1, errors: 1, latencyMsAvg: 2.5, byCollection: { 'financecentre.news': { reads: 3, writes: 1 } } },
      logs: { warnings: 1, errors: 2 },
      http: { requests: 3, errors5xx: 1, latencyMsAvg: 10 },
    });
  });
});
```

```ts file=tests/integration/telemetry.test.ts
import { MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Heartbeat, HISTORY_COLLECTION, LIVE_COLLECTION, MongoHeartbeatWriter } from '../../src/telemetry/heartbeat.js';
import { MongoActivity } from '../../src/telemetry/mongoActivity.js';

const URI = process.env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017';
const DB = `fc_telemetry_test_${process.pid}`;

describe('telemetry against a real MongoDB', () => {
  let admin: MongoClient;

  beforeAll(async () => {
    admin = await new MongoClient(URI).connect();
  });

  afterAll(async () => {
    await admin.db(DB).dropDatabase();
    await admin.close();
  });

  it('creates indexes and the capped history, upserts the live document and appends history', async () => {
    const writer = new MongoHeartbeatWriter(URI, DB);
    const hb = new Heartbeat({ service: 'mcp-test', writer, version: 'test' });
    await hb.tick();
    await hb.tick();
    await writer.close();

    const db = admin.db(DB);
    const live = await db.collection(LIVE_COLLECTION).find({ service: 'mcp-test' }).toArray();
    expect(live).toHaveLength(1);
    expect(live[0].ts).toBeInstanceOf(Date);
    expect(live[0].startedAt).toBeInstanceOf(Date);
    expect(await db.collection(HISTORY_COLLECTION).countDocuments({ service: 'mcp-test' })).toBe(1);

    const indexes = await db.collection(LIVE_COLLECTION).indexes();
    expect(indexes.find((index) => index.key.ts === 1)?.expireAfterSeconds).toBe(120);
    expect(indexes.find((index) => index.key.service === 1 && index.key.pid === 1)?.unique).toBe(true);
    const [info] = await db.listCollections({ name: HISTORY_COLLECTION }).toArray();
    expect((info as { options?: { capped?: boolean } }).options?.capped).toBe(true);

    // A second setup must accept the existing capped collection (code 48).
    const again = new MongoHeartbeatWriter(URI, DB);
    await again.ensureSetup();
    await again.close();
  });

  it('counts the commands of a client with monitorCommands', async () => {
    const activity = new MongoActivity();
    const client = new MongoClient(URI, { monitorCommands: true });
    activity.attach(client);
    await client.connect();
    try {
      await client.db(DB).collection('probe').insertOne({ a: 1 });
      await client.db(DB).collection('probe').find({}).toArray();
    } finally {
      await client.close();
    }
    expect(activity.snapshotAndReset().byCollection[`${DB}.probe`]).toEqual({ reads: 1, writes: 1 });
  });
});
```

- [ ] **Step 2: FAIL** — **Step 3: Implementieren**

```ts file=src/telemetry/heartbeat.ts
import { hostname } from 'node:os';
import { MongoClient, MongoServerError } from 'mongodb';
import type { JobState, JobTracker } from './jobs.js';
import type { LogCounter } from './logCounter.js';
import type { MongoActivity, MongoSnapshot } from './mongoActivity.js';
import { ProcStats, type ProcSnapshot } from './proc.js';
import { detectVersion } from './version.js';

export const LIVE_COLLECTION = 'systemHeartbeats';
export const HISTORY_COLLECTION = 'systemHeartbeatHistory';
export const HISTORY_CAPPED_BYTES = 20 * 1024 * 1024;
export const LIVE_TTL_SECONDS = 120;
const WARN_INTERVAL_MS = 60_000;
const NAMESPACE_EXISTS = 48;
const RESERVED_KEYS: ReadonlySet<string> = new Set([
  'service', 'ts', 'pid', 'host', 'version', 'startedAt', 'intervalSec', 'proc', 'mongo', 'jobs', 'logs',
]);

export type HeartbeatDoc = {
  service: string;
  ts: Date;
  pid: number;
  host: string;
  version: string;
  startedAt: Date;
  intervalSec: number;
  proc: ProcSnapshot;
  mongo: MongoSnapshot;
  jobs: JobState;
  logs: { warnings: number; errors: number };
  [provider: string]: unknown;
};

export interface HeartbeatWriter {
  ensureSetup(): Promise<void>;
  write(doc: HeartbeatDoc, history: boolean): Promise<void>;
  close(): Promise<void>;
}

/** Own small client (pool 1) so the heartbeat stays independent of the service client. */
export class MongoHeartbeatWriter implements HeartbeatWriter {
  private readonly uri: string;
  private readonly database: string;
  private client: MongoClient | null = null;

  constructor(uri: string, database = 'financecentre') {
    this.uri = uri;
    this.database = database;
  }

  private db() {
    this.client ??= new MongoClient(this.uri, {
      maxPoolSize: 1,
      appName: 'fc-telemetry',
      serverSelectionTimeoutMS: 3000,
      connectTimeoutMS: 3000,
      socketTimeoutMS: 5000,
    });
    return this.client.db(this.database);
  }

  async ensureSetup(): Promise<void> {
    const db = this.db();
    await db.collection(LIVE_COLLECTION).createIndex({ service: 1, pid: 1 }, { unique: true });
    await db.collection(LIVE_COLLECTION).createIndex({ ts: 1 }, { expireAfterSeconds: LIVE_TTL_SECONDS });
    try {
      await db.createCollection(HISTORY_COLLECTION, { capped: true, size: HISTORY_CAPPED_BYTES });
    } catch (error) {
      // Another process created it first — fine.
      if (!(error instanceof MongoServerError && error.code === NAMESPACE_EXISTS)) throw error;
    }
    await db.collection(HISTORY_COLLECTION).createIndex({ service: 1, ts: 1 });
  }

  async write(doc: HeartbeatDoc, history: boolean): Promise<void> {
    const db = this.db();
    await db.collection(LIVE_COLLECTION).replaceOne({ service: doc.service, pid: doc.pid }, doc, { upsert: true });
    // insertOne adds `_id` to the object it gets — hand it a copy.
    if (history) await db.collection(HISTORY_COLLECTION).insertOne({ ...doc });
  }

  async close(): Promise<void> {
    await this.client?.close();
    this.client = null;
  }
}

type Bag = Record<string, unknown>;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const numberOr0 = (value: unknown) => (isNumber(value) ? value : 0);
const asBag = (value: unknown): Bag | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && !(value instanceof Date) ? (value as Bag) : null;

/** Carries the counters of a document whose write failed (`pending`) into the next one. */
export function mergeCounters(pending: Bag, doc: Bag): void {
  const pMongo = asBag(pending.mongo);
  const dMongo = asBag(doc.mongo);
  if (pMongo && dMongo) {
    const pCount = numberOr0(pMongo.reads) + numberOr0(pMongo.writes);
    const dCount = numberOr0(dMongo.reads) + numberOr0(dMongo.writes);
    dMongo.reads = numberOr0(dMongo.reads) + numberOr0(pMongo.reads);
    dMongo.writes = numberOr0(dMongo.writes) + numberOr0(pMongo.writes);
    dMongo.errors = numberOr0(dMongo.errors) + numberOr0(pMongo.errors);
    if (isNumber(pMongo.latencyMsAvg) && isNumber(dMongo.latencyMsAvg) && pCount + dCount > 0) {
      dMongo.latencyMsAvg = Math.round(((pMongo.latencyMsAvg * pCount + dMongo.latencyMsAvg * dCount) / (pCount + dCount)) * 100) / 100;
    }
    const dByCollection = asBag(dMongo.byCollection) ?? (dMongo.byCollection = {} as Bag);
    for (const [key, pValue] of Object.entries(asBag(pMongo.byCollection) ?? {})) {
      const pBucket = asBag(pValue);
      if (pBucket) {
        const bucket = asBag(dByCollection[key]) ?? (dByCollection[key] = {} as Bag);
        for (const [sub, value] of Object.entries(pBucket)) {
          if (isNumber(value)) bucket[sub] = numberOr0(bucket[sub]) + value;
        }
      } else if (isNumber(pValue)) {
        dByCollection[key] = numberOr0(dByCollection[key]) + pValue;
      }
    }
  }

  const pLogs = asBag(pending.logs);
  const dLogs = asBag(doc.logs);
  if (pLogs && dLogs) {
    dLogs.warnings = numberOr0(dLogs.warnings) + numberOr0(pLogs.warnings);
    dLogs.errors = numberOr0(dLogs.errors) + numberOr0(pLogs.errors);
  }

  for (const [key, pValue] of Object.entries(pending)) {
    if (RESERVED_KEYS.has(key)) continue;
    const pBlock = asBag(pValue);
    const dBlock = asBag(doc[key]);
    if (!pBlock || !dBlock) continue;
    for (const [sub, value] of Object.entries(pBlock)) {
      if (sub === 'latencyMsAvg' || !isNumber(value)) continue;
      if (isNumber(dBlock[sub])) dBlock[sub] = (dBlock[sub] as number) + value;
    }
  }
}

export interface HeartbeatOptions {
  service: string;
  writer: HeartbeatWriter;
  intervalSec?: number;
  historyEvery?: number;
  activity?: MongoActivity;
  logCounter?: LogCounter;
  jobs?: JobTracker;
  providers?: Record<string, () => Bag>;
  version?: string;
  now?: () => Date;
  /** Milliseconds, only for throttling warnings. */
  clock?: () => number;
  proc?: ProcStats;
  onWarn?: (message: string) => void;
}

/** Writes the process state to MongoDB every `intervalSec` (fc-telemetry heartbeat contract). */
export class Heartbeat {
  private readonly service: string;
  private readonly writer: HeartbeatWriter;
  private readonly intervalSec: number;
  private readonly historyEvery: number;
  private readonly activity?: MongoActivity;
  private readonly logCounter?: LogCounter;
  private readonly jobs?: JobTracker;
  private readonly providers: Record<string, () => Bag>;
  private readonly version: string;
  private readonly now: () => Date;
  private readonly clock: () => number;
  private readonly proc: ProcStats;
  private readonly onWarn: (message: string) => void;
  private readonly startedAt: Date;
  private ticks = 0;
  private setupDone = false;
  private pending: HeartbeatDoc | null = null;
  private lastWarn: number | null = null;
  private inFlight = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(options: HeartbeatOptions) {
    this.service = options.service;
    this.writer = options.writer;
    this.intervalSec = options.intervalSec ?? 5;
    this.historyEvery = Math.max(1, options.historyEvery ?? 12);
    this.activity = options.activity;
    this.logCounter = options.logCounter;
    this.jobs = options.jobs;
    this.providers = options.providers ?? {};
    this.version = options.version ?? detectVersion();
    this.now = options.now ?? (() => new Date());
    this.clock = options.clock ?? Date.now;
    this.proc = options.proc ?? new ProcStats();
    this.onWarn = options.onWarn ?? (() => {});
    this.startedAt = this.now();
  }

  buildDocument(): HeartbeatDoc {
    const doc: HeartbeatDoc = {
      service: this.service,
      ts: this.now(),
      pid: process.pid,
      host: hostname(),
      version: this.version,
      startedAt: this.startedAt,
      intervalSec: this.intervalSec,
      proc: this.proc.snapshot(),
      mongo: this.activity?.snapshotAndReset() ?? { reads: 0, writes: 0, errors: 0, latencyMsAvg: 0, byCollection: {} },
      jobs: this.jobs?.state() ?? { current: [], lastError: null, errorsTotal: 0 },
      logs: this.logCounter?.snapshotAndReset() ?? { warnings: 0, errors: 0 },
    };
    for (const [name, provider] of Object.entries(this.providers)) {
      try {
        doc[name] = provider();
      } catch (error) {
        this.warn(`Heartbeat-Provider '${name}' fehlgeschlagen`, error);
      }
    }
    return doc;
  }

  /** One heartbeat; never throws — the service must not fail because of telemetry. */
  async tick(): Promise<HeartbeatDoc | null> {
    if (this.inFlight) return null;
    this.inFlight = true;
    let doc: HeartbeatDoc | null = null;
    try {
      doc = this.buildDocument();
      if (this.pending) {
        mergeCounters(this.pending, doc);
        this.pending = null;
      }
      if (!this.setupDone) {
        await this.writer.ensureSetup();
        this.setupDone = true;
      }
      await this.writer.write(doc, this.ticks % this.historyEvery === 0);
      this.ticks += 1;
      return doc;
    } catch (error) {
      // Keep the counters: the next successful tick carries them.
      if (doc) this.pending = doc;
      this.warn('Heartbeat konnte nicht geschrieben werden', error);
      return null;
    } finally {
      this.inFlight = false;
    }
  }

  start(): void {
    if (this.timer) return;
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.intervalSec * 1000);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.writer.close();
  }

  private warn(message: string, error: unknown): void {
    const now = this.clock();
    if (this.lastWarn !== null && now - this.lastWarn < WARN_INTERVAL_MS) return;
    this.lastWarn = now;
    const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    this.onWarn(`${message}: ${detail}`);
  }
}
```

- [ ] **Step 4: PASS** (`npx vitest run tests/unit/telemetry-heartbeat.test.ts tests/integration/telemetry.test.ts`) + tsc
- [ ] **Step 5: Commit** `feat(telemetry): Heartbeat nach systemHeartbeats (fc-telemetry-Vertrag)`

---

### Task 5: Verdrahtung in Server, Mongo-Client und Tools

**Files:** Create `src/telemetry/index.ts`; Modify `src/config.ts`, `src/db/client.ts`, `src/mcp.ts`, `src/server.ts`; Tests `tests/unit/config.test.ts`, `tests/unit/mcp.test.ts`

**Interfaces — Produces:** `TELEMETRY_SERVICE = 'mcp'`, `interface Telemetry { logCounter; activity; jobs; http }`, `createTelemetry()`, `startHeartbeat(telemetry, { mongoUri, database, onWarn })`; `Config.telemetry: boolean`; `connectMongo(config, activity?)`; `Deps.jobs?: JobTracker`; `buildApp(config, deps, authDb?, http?)`.

- [ ] **Step 1: Tests ergänzen**

In `tests/unit/config.test.ts` im `describe('loadConfig', …)` ergänzen:

```ts
  it('enables telemetry unless FC_TELEMETRY=off', () => {
    expect(loadConfig({ MCP_AUTH_DISABLED: 'true' }).telemetry).toBe(true);
    expect(loadConfig({ MCP_AUTH_DISABLED: 'true', FC_TELEMETRY: 'off' }).telemetry).toBe(false);
  });
```

In `tests/unit/mcp.test.ts` (Imports um `JobTracker` aus `../../src/telemetry/jobs.js` ergänzen) einen Block anhängen:

```ts
describe('tool calls as telemetry jobs', () => {
  it('tracks running tool calls and records unexpected failures only', async () => {
    const jobs = new JobTracker();
    const seen: string[][] = [];
    const tool = (name: string, handler: () => Promise<string>) => ({
      name,
      title: name,
      description: name,
      inputSchema: {},
      requiredScope: 'read' as const,
      annotations: { readOnlyHint: true },
      handler,
    });
    const feature: FeatureModule = {
      name: 'jobs',
      tools: [
        tool('observe', async () => {
          seen.push(jobs.state().current);
          return 'ok';
        }),
        tool('crash', async () => {
          throw new Error('db down');
        }),
        tool('user_error', async () => {
          throw new ToolError('nothing found');
        }),
      ],
    };
    const server = createMcpServer({ db: {} as Db, log: pino({ level: 'silent' }), jobs }, { keyName: 'test', scopes: new Set(['read']) }, [feature]);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await server.connect(serverTransport);
    const client = new Client({ name: 'test', version: '0.0.0' });
    await client.connect(clientTransport);
    try {
      await client.callTool({ name: 'observe', arguments: {} });
      await client.callTool({ name: 'crash', arguments: {} });
      await client.callTool({ name: 'user_error', arguments: {} });
    } finally {
      await client.close();
      await server.close();
    }
    expect(seen).toEqual([['observe']]);
    expect(jobs.state()).toMatchObject({ current: [], errorsTotal: 1, lastError: { job: 'crash', type: 'Error', message: 'db down' } });
  });
});
```

Run: `npx vitest run tests/unit/config.test.ts tests/unit/mcp.test.ts` → FAIL (`telemetry` fehlt, `jobs` unbekannt).

- [ ] **Step 2: `src/telemetry/index.ts` anlegen**

```ts file=src/telemetry/index.ts
import { Heartbeat, MongoHeartbeatWriter } from './heartbeat.js';
import { HttpStats } from './httpStats.js';
import { JobTracker } from './jobs.js';
import { LogCounter } from './logCounter.js';
import { MongoActivity } from './mongoActivity.js';

/** Service name in heartbeats and log lines — must match the webapi registry (`mcp`). */
export const TELEMETRY_SERVICE = 'mcp';

export interface Telemetry {
  logCounter: LogCounter;
  activity: MongoActivity;
  jobs: JobTracker;
  http: HttpStats;
}

export function createTelemetry(): Telemetry {
  return { logCounter: new LogCounter(), activity: new MongoActivity(), jobs: new JobTracker(), http: new HttpStats() };
}

export function startHeartbeat(
  telemetry: Telemetry,
  options: { mongoUri: string; database: string; onWarn: (message: string) => void },
): Heartbeat {
  const heartbeat = new Heartbeat({
    service: TELEMETRY_SERVICE,
    writer: new MongoHeartbeatWriter(options.mongoUri, options.database),
    activity: telemetry.activity,
    logCounter: telemetry.logCounter,
    jobs: telemetry.jobs,
    providers: { http: () => ({ ...telemetry.http.snapshotAndReset() }) },
    onWarn: options.onWarn,
  });
  heartbeat.start();
  return heartbeat;
}

export { telemetryLoggerOptions } from './logging.js';
export type { HttpStats } from './httpStats.js';
export type { JobTracker } from './jobs.js';
export type { MongoActivity } from './mongoActivity.js';
```

- [ ] **Step 3: `config.ts`** — in `interface Config` ergänzen:

```ts
  /** Heartbeat + command monitoring per fc-telemetry contract; off with FC_TELEMETRY=off. */
  telemetry: boolean;
```

und im Rückgabeobjekt von `loadConfig`: `telemetry: env.FC_TELEMETRY !== 'off',`

- [ ] **Step 4: `db/client.ts`** — `connectMongo` ersetzen:

```ts
export async function connectMongo(config: Config, activity?: MongoActivity): Promise<MongoClient> {
  if (!client) {
    // Command monitoring must be enabled at construction; listeners attach before connect().
    client = new MongoClient(config.mongoUri, { maxPoolSize: 10, monitorCommands: Boolean(activity) });
    activity?.attach(client);
    await client.connect();
  }
  return client;
}
```

Import: `import type { MongoActivity } from '../telemetry/mongoActivity.js';`

- [ ] **Step 5: `mcp.ts`** — `Deps` um `jobs?: JobTracker` ergänzen (Import `import type { JobTracker } from './telemetry/jobs.js';`) und den Handler-Körper ersetzen:

```ts
          const start = Date.now();
          const endJob = deps.jobs?.start(tool.name);
          try {
            const text = await tool.handler(input, { db: deps.db, auth, log: deps.log });
            deps.log.info({ tool: tool.name, key: auth.keyName, ms: Date.now() - start }, 'tool ok');
            return { content: [{ type: 'text' as const, text }] };
          } catch (e) {
            if (e instanceof ToolError) {
              deps.log.warn({ tool: tool.name, key: auth.keyName, ms: Date.now() - start, err: e.message }, 'tool error');
              return errResult(e.message);
            }
            deps.jobs?.recordError(tool.name, e);
            deps.log.error({ tool: tool.name, key: auth.keyName, err: e }, 'tool failed');
            return errResult('internal error — retry or narrow the query');
          } finally {
            endJob?.();
          }
```

- [ ] **Step 6: `server.ts`** — Import `import { createTelemetry, startHeartbeat, telemetryLoggerOptions, TELEMETRY_SERVICE, type HttpStats } from './telemetry/index.js';`; `buildApp` bekommt als vierten Parameter `http?: HttpStats` und direkt nach `app.set('trust proxy', 'loopback');`:

```ts
  if (http) app.use(http.middleware());
```

`main()` ersetzen:

```ts
async function main(): Promise<void> {
  const config = loadConfig();
  const telemetry = config.telemetry ? createTelemetry() : null;
  const log = pino(telemetryLoggerOptions({ service: TELEMETRY_SERVICE, level: config.logLevel, counter: telemetry?.logCounter }));
  const client = await connectMongo(config, telemetry?.activity);
  const db = await getDb(config);
  let authDb: Db | undefined;
  if (config.jwtSecret) {
    authDb = client.db(config.mongoAuthDb);
    await new AuthStore(authDb).ensureIndexes();
    log.info({ issuer: config.publicUrl }, 'oauth enabled');
  }
  const app = buildApp(config, { db, log, jobs: telemetry?.jobs }, authDb, telemetry?.http);
  app.listen(config.port, () => log.info(`mcp-fc listening on :${config.port}`));
  if (telemetry) {
    startHeartbeat(telemetry, { mongoUri: config.mongoUri, database: config.mongoDb, onWarn: (message) => log.warn(message) });
  }
}
```

- [ ] **Step 7: Alles prüfen** — `npm test` und `npx tsc -p tsconfig.json --noEmit` grün; `npm run build` baut `dist/`.
- [ ] **Step 8: Rauchtest lokal** — `MCP_AUTH_DISABLED=true MCP_PORT=8899 MONGODB_DB=fc_telemetry_smoke node dist/server.js` starten, 6 s warten, in `fc_telemetry_smoke.systemHeartbeats` liegt ein Dokument mit `service: "mcp"`; stdout zeigt JSON-Zeilen mit `"service":"mcp"`. Prozess beenden, Datenbank droppen.
- [ ] **Step 9: Commit** `feat(telemetry): Heartbeat, Logformat und Tool-Jobs im Server verdrahten`

---

### Task 6: webapi — MCP sendet Heartbeats

**Files:** Modify `app/services/system_ops/registry.py` (mcp: `has_heartbeat=True`); Test `tests/system_ops/test_registry.py`

- [ ] **Step 1: Test anhängen**

```python
def test_heartbeat_services_are_the_fc_telemetry_integrations() -> None:
    assert [s.name for s in SERVICES if s.has_heartbeat] == ["kraken", "aladin", "webapi", "mcp"]
```

Run: `.venv/bin/python -m pytest tests/system_ops/test_registry.py -q` → FAIL.

- [ ] **Step 2:** In `registry.py` beim Eintrag `mcp` `has_heartbeat=False` → `has_heartbeat=True`.
- [ ] **Step 3:** `.venv/bin/python -m pytest tests/system_ops -q` → PASS.
- [ ] **Step 4: Commit** `feat(system_ops): mcp sendet Heartbeats (fc-telemetry-Port)`

---

### Task 7: Merge, Push, Deploy, Nachweis

- [ ] mcp-fc: `feat/telemetry` per `--no-ff` in `main`, `npm test`, `git push origin main`.
- [ ] webapi: `git push origin main`.
- [ ] Server mcp-fc (Eigentümer von `/opt/mcp-fc` prüfen, im selben Nutzerkontext wie bisher ausführen): `cd /opt/mcp-fc && git pull --ff-only && npm ci && npm run build && systemctl restart mcp-fc`; `curl -s localhost:8814/healthz`; `journalctl -u mcp-fc -n 5 -o cat` zeigt JSON-Zeilen mit `"service":"mcp"`.
- [ ] Server webapi: `cd /opt/finanz-copilot-api/webapi && sudo -u finanzapi -H git pull --ff-only && systemctl restart finanz-copilot-api`; nach ~5 s `systemctl is-active`.
- [ ] Nachweis: `systemHeartbeats` enthält `service: "mcp"` mit frischem `ts`; `/admin/system` zeigt MCP mit Raten und Lese-/Schreibbögen statt gestrichelter Linie.
