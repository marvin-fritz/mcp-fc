import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
console.log('creating news text index (idempotent, may take a minute on ~500k docs)…');
await db.collection('news').createIndex({ title: 'text', description: 'text' }, { name: 'news_text' });
console.log('creating newsGeo indexes…');
const geo = db.collection('newsGeo');
await geo.createIndex({ newsId: 1 }, { unique: true, name: 'newsId_unique' });
await geo.createIndex({ location: '2dsphere' }, { sparse: true, name: 'location_2dsphere' });
await geo.createIndex({ pubDate: -1 });
await geo.createIndex({ country: 1, pubDate: -1 });
// top-stories queries: highest relevance first, newest as tiebreaker
await geo.createIndex({ relevance: -1, pubDate: -1 }, { name: 'relevance_pubDate' });
console.log('done');
await closeMongo();
