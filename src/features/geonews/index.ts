import { ObjectId } from 'mongodb';
import type { Document } from 'mongodb';
import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { fmtDate } from '../../format/num.js';
import { table } from '../../format/table.js';
import type { FeatureModule } from '../types.js';
import { buildEnrichment } from './enrichment.js';

const locationItem = z.object({
  newsId: z.string().regex(/^[a-f0-9]{24}$/i).describe('news _id (24-char hex from get_news_for_geocoding)'),
  noLocation: z.boolean().optional().describe('true = news has no meaningful location; remembered so it is not offered again'),
  lat: z.number().min(-90).max(90).optional(),
  lon: z.number().min(-180).max(180).optional(),
  country: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('ISO 3166-1 alpha-2, e.g. DE'),
  place: z.string().max(120).optional().describe('display name, e.g. "Frankfurt am Main"'),
  precision: z.enum(['country', 'region', 'city']).optional(),
  confidence: z.number().min(0).max(1).optional().describe('how sure you are about the LOCATION (not the importance)'),
  relevance: z
    .number()
    .min(0)
    .max(1)
    .optional()
    .describe(
      'how significant the EVENT is, 0-1 (required unless noLocation). Anchors: 0.95-1.0 = historic shock (9/11, war outbreak, market crash, systemic bank failure); 0.8-0.94 = major (central-bank surprise, war escalation, mega-merger, big-tech collapse); 0.6-0.79 = notable (rate decision as expected, large-cap earnings, national election); 0.4-0.59 = moderate (mid-cap news, sector reports); 0.2-0.39 = routine (small-cap PR, analyst notes); 0-0.19 = trivial/irrelevant. Auch bei noLocation sinnvoll und erwünscht.',
    ),
  summary: z.string().max(300).optional().describe('1-2 sentences for the map pin callout. Auch bei noLocation sinnvoll und erwünscht.'),
  headline: z
    .string()
    .max(90)
    .optional()
    .describe(
      'Schreibe hier selbst eine NEUE kurze deutsche Schlagzeile (max 90 Zeichen), auch für fremdsprachige Quellen — wird in der App als Überschrift angezeigt. NICHT den Original-Titel aus get_news_for_geocoding kopieren, sondern neu formulieren. Keine Zusammenfassung, sondern eine Schlagzeile: aktiv, konkret, ohne Quellenangabe. Auch bei noLocation sinnvoll und erwünscht.',
    ),
  topics: z
    .array(z.string().min(2).max(60))
    .min(1)
    .max(8)
    .optional()
    .describe(
      '1-8 Themen-Tags (typisch 2-5): Englisch, Title Case — z.B. ["US Economy","US Job Market","DAX"]. Kategorien: Indizes (DAX, S&P 500), Länder-/Regionen-Themen (US Economy, Eurozone Economy), Märkte/Assetklassen (Oil, Gold, Bonds, Crypto), Institutionen (ECB, Fed), Themenfelder (Interest Rates, Inflation, Tariffs), Einzelwerte als Firmenname (Apple, Siemens), Personen mit vollem Namen, wenn sie das Ereignis prägen (Zohran Mamdani, Jerome Powell, Elon Musk). WICHTIG: Trägt die News ein spezifisches Thema, vergib es zusätzlich konkret (z.B. Private Credit, Credit Defaults, CRE Debt, Yen Carry Trade, AI Capex) — die Tags werden als Zeitreihe für Trend-Früherkennung aggregiert. Dasselbe Thema/dieselbe Person deshalb immer mit exakt demselben Tag, keine neuen Formulierungen für bekannte Themen. Keine Sätze, keine Duplikate, kein Kategorie-Echo (ECONOMY ist Kategorie, kein Topic). Auch bei noLocation angeben.',
    ),
});

export const geonewsFeature: FeatureModule = {
  name: 'geonews',
  tools: [
    {
      name: 'get_news_for_geocoding',
      title: 'News pending geolocation',
      description:
        'Newest news that have NO enrichment block yet (or only a partial fast-lane block from the hourly tagger) — for the geolocation agent. Returns newsId (use it in submit_news_locations), date, category, source, title, description (truncated). Example: {"limit":20}',
      inputSchema: {
        limit: z.number().int().min(1).max(50).optional().describe('default 20'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        category: z.string().optional().describe('e.g. ECONOMY, POLITICS'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 20, 50);
        const match: Record<string, unknown> = {
          $or: [{ enrichment: { $exists: false } }, { 'enrichment.partial': true }],
        };
        if (input.from || input.to) {
          match.pubDate = {
            ...(input.from ? { $gte: new Date(`${input.from}T00:00:00Z`) } : {}),
            ...(input.to ? { $lte: new Date(`${input.to}T23:59:59.999Z`) } : {}),
          };
        }
        if (input.category) match.category = input.category.toUpperCase();
        const docs = await cols(db)
          .news.find(match, {
            projection: { title: 1, description: 1, sourceName: 1, category: 1, pubDate: 1 },
            sort: { pubDate: -1 },
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        return table(
          ['newsId', 'date', 'category', 'source', 'title', 'description'],
          docs.slice(0, lim).map((d) => [
            String(d._id),
            fmtDate(d.pubDate),
            d.category,
            d.sourceName,
            d.title,
            (d.description ?? '').slice(0, 200),
          ]),
          { hasMore },
        );
      },
    },
    {
      name: 'submit_news_locations',
      title: 'Submit news geolocations',
      description:
        'Store news enrichment (writes the enrichment block on the news doc, upsert by newsId). Each item: either a location (lat, lon, country ISO2, precision, relevance — plus optional place, confidence, summary ≤300 chars for the map pin, headline ≤90 chars: a short German headline that YOU write yourself, even for foreign-language sources — do NOT copy the source title from get_news_for_geocoding, write a new one; active, concrete, no source attribution, not a summary sentence, topics: 1-8 English Title-Case theme tags like ["US Economy","DAX"], incl. defining persons by full name ("Zohran Mamdani") — be concrete for specific themes (Private Credit, Credit Defaults, Yen Carry Trade), always reuse the exact same tag for the same theme: the tags feed a trend early-warning time series) or {"newsId":"…","noLocation":true} for news without a meaningful location. relevance (0-1) drives pin size/filtering on the map: 1.0 = historic shock, 0.7 = major event, 0.3 = routine, <0.1 = trivial. Auch noLocation-Items sollen relevance, topics, headline und summary mitliefern — Themen und Wichtigkeit sind ortsunabhängig. Invalid items are skipped and reported. Example: {"agentName":"fcNewsAgent","items":[{"newsId":"665f0c…","lat":50.11,"lon":8.68,"country":"DE","place":"Frankfurt","precision":"city","relevance":0.7,"summary":"EZB hebt Zinsen an.","headline":"EZB hebt Leitzins an","topics":["ECB","Interest Rates","Eurozone Economy"]}]}',
      inputSchema: {
        items: z.array(locationItem).min(1).max(100),
        agentName: z
          .string()
          .min(2)
          .max(40)
          .regex(/^[A-Za-z0-9._-]+$/)
          .optional()
          .describe('Name des einreichenden Agenten, z.B. "fcNewsAgent" — wird als enrichedBy gespeichert (Fallback: Auth-Identität)'),
      },
      requiredScope: 'write',
      annotations: { readOnlyHint: false, destructiveHint: false },
      handler: async (input, { db, auth, log }) => {
        const items = input.items as Array<z.infer<typeof locationItem>>;
        // Agentenname für die Provenienz; die echte Auth-Identität bleibt im Log.
        const enrichedBy = (input.agentName as string | undefined) ?? auth.keyName;
        const c = cols(db);
        const ids = items.map((i) => new ObjectId(i.newsId));
        const newsDocs = await c.news
          .find({ _id: { $in: ids } }, { projection: { enrichment: 1 }, maxTimeMS: MAX_TIME_MS })
          .toArray();
        const newsById = new Map(newsDocs.map((d) => [String(d._id), d]));
        const errors: string[] = [];
        let located = 0;
        let noLoc = 0;
        let updated = 0;
        const newsOps: Array<{ updateOne: { filter: Document; update: Document } }> = [];
        for (const [i, item] of items.entries()) {
          const news = newsById.get(item.newsId.toLowerCase());
          if (!news) {
            errors.push(`ERROR item ${i}: newsId ${item.newsId} not found in news`);
            continue;
          }
          if (
            !item.noLocation &&
            (item.lat == null || item.lon == null || !item.country || !item.precision || item.relevance == null)
          ) {
            errors.push(`ERROR item ${i}: lat, lon, country, precision and relevance are required (or set noLocation)`);
            continue;
          }
          if (news.enrichment != null) updated++;
          if (item.noLocation) noLoc++;
          else located++;
          newsOps.push({
            updateOne: {
              filter: { _id: news._id },
              // Der Block wird als Ganzes ersetzt — ein Re-Submit überschreibt gewollt.
              update: { $set: { enrichment: buildEnrichment(item, enrichedBy, new Date()) } },
            },
          });
        }
        if (newsOps.length > 0) {
          try {
            await c.news.bulkWrite(newsOps, { ordered: false });
          } catch (err) {
            errors.push(`ERROR enrichment write failed: ${String(err)}`);
          }
        }
        log.info({ located, noLoc, updated, errors: errors.length, by: auth.keyName }, 'news locations submitted');
        return [`ok: ${located} located, ${noLoc} noLocation (${updated} updated)`, ...errors].join('\n');
      },
    },
  ],
};
