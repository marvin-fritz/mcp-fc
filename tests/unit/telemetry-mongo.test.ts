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
