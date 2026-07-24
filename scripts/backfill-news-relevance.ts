/**
 * Einmaliges Backfill: überträgt relevance/summary/country/place aus newsGeo
 * in die news-Collection. Idempotent — mehrfaches Ausführen ist unschädlich.
 * Nicht während des Agenten-Laufs (täglich 8:00) starten.
 */
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';
import { buildNewsPatch } from '../src/features/geonews/newsPatch.js';

const BATCH = 1000;

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
const cursor = db.collection('newsGeo').find(
  {},
  { projection: { newsId: 1, locatable: 1, relevance: 1, summary: 1, country: 1, place: 1, locatedAt: 1 } },
);

let ops: Array<{ updateOne: { filter: Record<string, unknown>; update: Record<string, unknown> } }> = [];
let done = 0;

async function flush() {
  if (ops.length === 0) return;
  await db.collection('news').bulkWrite(ops, { ordered: false });
  done += ops.length;
  console.log(`${done} news-Dokumente aktualisiert`);
  ops = [];
}

for await (const geo of cursor) {
  ops.push({
    updateOne: {
      filter: { _id: geo.newsId },
      update: buildNewsPatch(
        {
          noLocation: geo.locatable === false,
          relevance: geo.relevance,
          summary: geo.summary,
          country: geo.country,
          place: geo.place,
        },
        geo.locatedAt ?? new Date(),
      ),
    },
  });
  if (ops.length >= BATCH) await flush();
}
await flush();

console.log(`fertig: ${done} Dokumente`);
await closeMongo();
