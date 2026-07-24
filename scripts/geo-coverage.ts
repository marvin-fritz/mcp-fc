// Lauf 2026-07-24 gegen die LOKALE Mongo (127.0.0.1, Default ohne .env):
//   news=476841, newsGeo=0 — die lokale Kopie enthält keine Geo-Daten.
// Aussagekräftig ist dieses Skript nur gegen die Produktions-Mongo; dort
// MONGODB_URI setzen oder auf dem Server ausführen.
//
// Ersatzmessung 2026-07-24 über die öffentliche REST-API (news-geo/countries
// gegen die News-Zahl im selben Fenster), weil die Prod-Mongo von der
// Entwicklungsmaschine nicht erreichbar ist:
//   24h: news=3237, verortet=1997 → 61,7 % Abdeckung
//   72h: news=9958, verortet=5951 → 59,8 % Abdeckung
// Rund 40 % der News tragen also keine relevance. Konsequenz für den Plan
// (Task 13): Default-Tab ist "Neu", nicht "Top".

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
