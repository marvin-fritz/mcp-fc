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
