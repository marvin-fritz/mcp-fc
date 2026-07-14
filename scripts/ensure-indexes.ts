import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
console.log('creating news text index (idempotent, may take a minute on ~500k docs)…');
await db.collection('news').createIndex({ title: 'text', description: 'text' }, { name: 'news_text' });
console.log('done');
await closeMongo();
