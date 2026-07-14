import { Db, MongoClient } from 'mongodb';
import type { Config } from '../config.js';

/** Hard budget for every query/aggregation. */
export const MAX_TIME_MS = 5000;

let client: MongoClient | null = null;

export async function connectMongo(config: Config): Promise<MongoClient> {
  if (!client) {
    client = new MongoClient(config.mongoUri, { maxPoolSize: 10 });
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
