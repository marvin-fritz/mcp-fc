import { Db, MongoClient } from 'mongodb';
import type { Config } from '../config.js';
import type { MongoActivity } from '../telemetry/mongoActivity.js';

/** Hard budget for every query/aggregation. */
export const MAX_TIME_MS = 5000;

let client: MongoClient | null = null;

export async function connectMongo(config: Config, activity?: MongoActivity): Promise<MongoClient> {
  if (!client) {
    // Command monitoring must be enabled at construction; listeners attach before connect().
    client = new MongoClient(config.mongoUri, { maxPoolSize: 10, monitorCommands: Boolean(activity) });
    activity?.attach(client);
    await client.connect();
  }
  return client;
}

export async function getDb(config: Config): Promise<Db> {
  return (await connectMongo(config)).db(config.mongoDb);
}

export async function closeMongo(): Promise<void> {
  await client?.close();
  client = null;
}
