/**
 * Einmalige Normalisierung: Alt-Dokumente tragen in enrichedBy/locatedBy die
 * OAuth-Identität (E-Mail), weil der Agent vor Einführung von agentName keine
 * eigene Kennung mitsenden konnte. Setzt alle E-Mail-Werte auf den heutigen
 * Agentennamen. Idempotent — zweiter Lauf findet nichts mehr.
 */
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const AGENT_NAME = 'fcNewsAgent';
const EMAIL = /@/;

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));

const news = await db
  .collection('news')
  .updateMany({ 'enrichment.enrichedBy': EMAIL }, { $set: { 'enrichment.enrichedBy': AGENT_NAME } });
console.log(`news.enrichment.enrichedBy normalisiert: ${news.modifiedCount}`);

const geo = await db
  .collection('newsGeo')
  .updateMany({ locatedBy: EMAIL }, { $set: { locatedBy: AGENT_NAME } });
console.log(`newsGeo.locatedBy normalisiert: ${geo.modifiedCount}`);

console.log('fertig');
await closeMongo();
