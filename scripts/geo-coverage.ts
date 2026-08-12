// Abdeckungsmessung: Wie viele news tragen einen enrichment-Block?
// Aussagekräftig nur gegen die Produktions-Mongo (dort MONGODB_URI setzen
// oder auf dem Server ausführen) — die lokale Dev-Kopie hat keine
// Agenten-Daten. Historische Messung 2026-07-24 (damals noch newsGeo, per
// REST-API): 24h ≈ 62 % Abdeckung, 72h ≈ 60 %.

import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
const news = db.collection('news');

const dayMs = 24 * 3600 * 1000;
const since = (days: number) => ({ pubDate: { $gte: new Date(Date.now() - days * dayMs) } });

const total = await news.estimatedDocumentCount();
const enriched = await news.countDocuments({ enrichment: { $exists: true } });
const unlocatable = await news.countDocuments({ 'enrichment.geo.locatable': false });
const withTopics = await news.countDocuments({ 'enrichment.topics.0': { $exists: true } });
const last24hTotal = await news.countDocuments(since(1));
const last24hEnriched = await news.countDocuments({ ...since(1), enrichment: { $exists: true } });

console.log({
  news: total,
  enriched,
  unlocatable,
  unlocatablePct: enriched ? Math.round((unlocatable / enriched) * 1000) / 10 : 0,
  withTopics,
  last24h: {
    news: last24hTotal,
    enriched: last24hEnriched,
    coveragePct: last24hTotal ? Math.round((last24hEnriched / last24hTotal) * 1000) / 10 : 0,
  },
});
await closeMongo();
