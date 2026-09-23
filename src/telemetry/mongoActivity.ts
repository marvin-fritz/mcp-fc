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
