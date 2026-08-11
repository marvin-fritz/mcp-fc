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
console.log('creating news sort indexes…');
const news = db.collection('news');
// sortBy=relevance in der REST-API
await news.createIndex({ relevance: -1, pubDate: -1 }, { name: 'relevance_pubDate' });
// sortBy=views / sortBy=likes ("Meistgelesen")
await news.createIndex({ 'stats.views': -1, pubDate: -1 }, { name: 'views_pubDate' });
await news.createIndex({ 'stats.likes': -1, pubDate: -1 }, { name: 'likes_pubDate' });
console.log('creating news enrichment indexes…');
// Sortierung von get_news_for_geocoding (find + sort pubDate)
try {
  await news.dropIndex('pubDate_-1');
} catch (e) {
  // Index may not exist, that's ok
}
await news.createIndex({ pubDate: -1 }, { name: 'pubDate' });
// Karte: Viewport-Query über den enrichment-Block
await news.createIndex(
  { 'enrichment.geo.location': '2dsphere' },
  { sparse: true, name: 'enrichment_location_2dsphere' },
);
// Top-Stories / Relevanz-Sortierung aus dem Block (löst news.relevance in Phase 5 ab)
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
console.log('done');
await closeMongo();
