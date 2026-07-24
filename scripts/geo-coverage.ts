// Messung 2026-07-24: news=476841, newsGeo=0, unlocatable=0, unlocatablePct=0, withRelevance=0

import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
const geo = db.collection('newsGeo');

const total = await geo.countDocuments({});
const unlocatable = await geo.countDocuments({ locatable: false });
const withRelevance = await geo.countDocuments({ locatable: true, relevance: { $gte: 0 } });
const news = await db.collection('news').estimatedDocumentCount();

console.log({
  news,
  newsGeo: total,
  unlocatable,
  unlocatablePct: total ? Math.round((unlocatable / total) * 1000) / 10 : 0,
  withRelevance,
});

await closeMongo();
