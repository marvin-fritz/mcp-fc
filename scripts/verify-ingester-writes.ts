/**
 * Phase-1-Prüfung (Spec 2026-08-11): Schreibt der News-Ingester per Replace,
 * verlieren alte news-Docs ihre denormalisierte relevance wieder. Wir prüfen
 * newsGeo-Einträge (locatable:true, relevance gesetzt), die älter als 3 Tage
 * sind — deren news-Doc muss relevance noch tragen. Mismatches > 0 => Verdacht
 * auf Replace-Verhalten, Merge NICHT fortsetzen, erst Ingester prüfen/fixen.
 */
import type { ObjectId } from 'mongodb';
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const CUTOFF = new Date(Date.now() - 3 * 24 * 3600 * 1000);
const CHUNK = 500;

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
const geoDocs = await db
  .collection('newsGeo')
  .find(
    { locatable: true, relevance: { $exists: true }, locatedAt: { $lt: CUTOFF } },
    { projection: { newsId: 1 } },
  )
  .toArray();

let checked = 0;
let missing = 0;
let orphaned = 0;
for (let i = 0; i < geoDocs.length; i += CHUNK) {
  const ids = geoDocs.slice(i, i + CHUNK).map((g) => g.newsId as ObjectId);
  const newsDocs = await db
    .collection('news')
    .find({ _id: { $in: ids } }, { projection: { relevance: 1 } })
    .toArray();
  const byId = new Map(newsDocs.map((d) => [String(d._id), d]));
  for (const id of ids) {
    const doc = byId.get(String(id));
    checked++;
    if (!doc) orphaned++;
    else if (doc.relevance == null) missing++;
  }
}

console.log(`geprüft: ${checked} (locatedAt < ${CUTOFF.toISOString()})`);
console.log(`news-Doc fehlt (vom Ingester gelöscht/rotiert): ${orphaned}`);
console.log(`relevance verschwunden (Replace-Verdacht!): ${missing}`);
if (missing > 0) {
  console.error('FAIL: Ingester überschreibt denormalisierte Felder — Merge stoppen, Ingester-Repo prüfen.');
  process.exit(1);
}
console.log('OK: keine Hinweise auf Replace-Verhalten.');
await closeMongo();
