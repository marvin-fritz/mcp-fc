import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
console.log('creating news text index (idempotent, may take a minute on ~500k docs)…');
await db.collection('news').createIndex({ title: 'text', description: 'text' }, { name: 'news_text' });
console.log('creating news sort indexes…');
const news = db.collection('news');
// sortBy=views / sortBy=likes ("Meistgelesen")
await news.createIndex({ 'stats.views': -1, pubDate: -1 }, { name: 'views_pubDate' });
await news.createIndex({ 'stats.likes': -1, pubDate: -1 }, { name: 'likes_pubDate' });
console.log('creating news enrichment indexes…');
// Sortierung von get_news_for_geocoding (find + sort pubDate)
// Alt-Index ohne Namen aus früherem Lauf entfernen; existiert er nicht (idempotenter Re-Run), ist das ok
try {
  await news.dropIndex('pubDate_-1');
} catch (e: any) {
  if (e.code !== 27 && e.codeName !== 'IndexNotFound') {
    throw e;
  }
}
await news.createIndex({ pubDate: -1 }, { name: 'pubDate' });
// Karte: Viewport-Query über den enrichment-Block
await news.createIndex(
  { 'enrichment.geo.location': '2dsphere' },
  { sparse: true, name: 'enrichment_location_2dsphere' },
);
// Top-Stories / Relevanz-Sortierung (sortBy=relevance und hot in der REST-API)
await news.createIndex(
  { 'enrichment.relevance': -1, pubDate: -1 },
  { name: 'enrichment_relevance_pubDate' },
);
// Länder-Filter/-Badges
await news.createIndex(
  { 'enrichment.geo.country': 1, pubDate: -1 },
  { name: 'enrichment_country_pubDate' },
);
// Themen-Filter (Multikey)
await news.createIndex(
  { 'enrichment.topics': 1, pubDate: -1 },
  { name: 'enrichment_topics_pubDate' },
);
// Watchlist-Newsfeed (webapi): exakter ISIN-Match auf getaggte News
await news.createIndex(
  { 'enrichment.isins': 1, pubDate: -1 },
  { name: 'enrichment_isins_pubDate' },
);
console.log('done');
await closeMongo();
