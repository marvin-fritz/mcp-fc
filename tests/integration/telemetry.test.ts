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
