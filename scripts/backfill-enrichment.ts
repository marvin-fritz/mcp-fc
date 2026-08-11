/**
 * Einmaliges Backfill (Phase 3): überträgt newsGeo-Docs als enrichment-Block
 * auf news. Idempotent — überschreibt nur, wenn enrichment fehlt oder älter
 * als newsGeo.locatedAt ist (frische Agenten-Submits gewinnen).
 * Nicht während des Agenten-Laufs (täglich 8:00) starten.
 * topics bleibt für Alt-Docs leer — das Feld gibt es erst ab dem Tool-Umbau.
 */
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';
import { buildEnrichment } from '../src/features/geonews/enrichment.js';

const BATCH = 1000;

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
const cursor = db.collection('newsGeo').find(
  {},
  {
    projection: {
      newsId: 1, locatable: 1, location: 1, country: 1, place: 1, precision: 1,
      confidence: 1, relevance: 1, summary: 1, geoTitle: 1, locatedBy: 1, locatedAt: 1,
    },
  },
);

let ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
let done = 0;

async function flush() {
  if (ops.length === 0) return;
  const res = await db.collection('news').bulkWrite(ops, { ordered: false });
  done += res.modifiedCount;
  console.log(`${done} news-Dokumente aktualisiert`);
  ops = [];
}

for await (const geo of cursor) {
  const locatedAt = (geo.locatedAt as Date) ?? new Date(0);
  ops.push({
    updateOne: {
      // enrichment fehlt ODER ist älter als dieser newsGeo-Stand
      filter: {
        _id: geo.newsId,
        $or: [
          { enrichment: { $exists: false } },
          { 'enrichment.enrichedAt': { $lt: locatedAt } },
        ],
      },
      update: {
        $set: {
          enrichment: buildEnrichment(
            {
              noLocation: geo.locatable === false,
              lat: geo.location?.coordinates?.[1],
              lon: geo.location?.coordinates?.[0],
              country: geo.country,
              place: geo.place,
              precision: geo.precision,
              confidence: geo.confidence,
              relevance: geo.relevance,
              summary: geo.summary,
              headline: geo.geoTitle,
            },
            (geo.locatedBy as string) ?? 'backfill',
            locatedAt,
          ),
        },
      },
    },
  });
  if (ops.length >= BATCH) await flush();
}
await flush();

const geoCount = await db.collection('newsGeo').countDocuments();
const enrichedCount = await db.collection('news').countDocuments({ enrichment: { $exists: true } });
console.log(`fertig: ${done} aktualisiert — newsGeo: ${geoCount}, news mit enrichment: ${enrichedCount}`);
if (enrichedCount < geoCount) {
  console.warn('WARNUNG: weniger enriched news als newsGeo-Docs — verwaiste newsId-Referenzen prüfen.');
}
await closeMongo();
