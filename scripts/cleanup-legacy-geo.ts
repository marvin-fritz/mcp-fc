/**
 * Phase-5-Rückbau — ERST AUSFÜHREN, wenn die webapi vollständig auf
 * news.enrichment.* liest (Marvin bestätigt). Danach zusätzlich im Code:
 * Dual-Write entfernen (newsGeo-Upsert + buildNewsPatch in
 * src/features/geonews/index.ts, newsPatch.ts löschen), newsGeo aus
 * src/db/collections.ts sowie scripts/ensure-indexes.ts streichen, und in
 * scripts/ensure-indexes.ts zusätzlich die Erstellung des news-Index
 * `relevance_pubDate` entfernen — sonst legt ein späterer ensure-indexes-Lauf
 * den hier gedroppten Alt-Index stillschweigend wieder an.
 *
 * Entfernt die Top-Level-Duplikate (stammen aus buildNewsPatch, nicht vom
 * Ingester) und droppt newsGeo. Läuft nur, wenn --yes übergeben wird.
 */
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

if (!process.argv.includes('--yes')) {
  console.error('Abbruch: Gate beachten (webapi umgestellt?) und mit --yes bestätigen.');
  process.exit(1);
}

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));

const res = await db.collection('news').updateMany(
  { geoLocatedAt: { $exists: true } },
  { $unset: { relevance: '', geoSummary: '', geoTitle: '', country: '', place: '', geoLocatedAt: '' } },
);
console.log(`Top-Level-Duplikate entfernt: ${res.modifiedCount} news-Docs`);

await db.collection('news').dropIndex('relevance_pubDate').catch(() => {});
await db.collection('newsGeo').drop();
console.log('newsGeo gedroppt.');
await closeMongo();
