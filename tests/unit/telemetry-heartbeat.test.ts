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
