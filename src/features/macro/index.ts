import { z } from 'zod';
import type { Document } from 'mongodb';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { fmtNum } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

const MAX_OBS = 500;
const CATALOG_PROJECTION = {
  projection: { seriesId: 1, name: 1, unit: 1, frequency: 1, category: 1, source: 1, observations: { $slice: -1 } },
  maxTimeMS: MAX_TIME_MS,
};

export const macroFeature: FeatureModule = {
  name: 'macro',
  tools: [
    {
      name: 'get_macro_series',
      title: 'Macro series',
      description:
        'Macro/economic time series (FRED, ECB). Without seriesId: catalog of all series. With seriesId: observations (date|value), optional from/to (YYYY-MM-DD), max 500 most recent within range. Example: {"seriesId":"CPIAUCSL","from":"2020-01-01"}',
      inputSchema: {
        seriesId: z.string().optional().describe('omit for catalog'),
        from: z.string().optional(),
        to: z.string().optional(),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const c = cols(db);
        if (!input.seriesId) {
          const [fredDocs, ecoDocs] = await Promise.all([
            c.fred.find({}, CATALOG_PROJECTION).toArray(),
            c.economicIndicators.find({}, CATALOG_PROJECTION).toArray(),
          ]);
          const row = (d: Document, source: string) => [
            d.seriesId,
            d.name,
            d.unit,
            d.frequency,
            d.category,
            source,
            d.observations?.[0]?.date ?? '',
          ];
          return table(
            ['seriesId', 'name', 'unit', 'freq', 'category', 'source', 'lastDate'],
            [...fredDocs.map((d) => row(d, 'fred')), ...ecoDocs.map((d) => row(d, d.source ?? 'other'))],
          );
        }
        const opts = { projection: { seriesId: 1, name: 1, unit: 1, frequency: 1, observations: 1 }, maxTimeMS: MAX_TIME_MS };
        const doc =
          (await c.fred.findOne({ seriesId: input.seriesId }, opts)) ??
          (await c.economicIndicators.findOne({ seriesId: input.seriesId }, opts));
        if (!doc) throw new ToolError(`unknown seriesId '${input.seriesId}' — call get_macro_series without seriesId for the catalog`);
        let obs = (doc.observations ?? []).filter(
          (o: Document) => o.value != null && (!input.from || o.date >= input.from) && (!input.to || o.date <= input.to),
        );
        let note = '';
        if (obs.length > MAX_OBS) {
          note = `# showing last ${MAX_OBS} of ${obs.length} — narrow the range\n`;
          obs = obs.slice(-MAX_OBS);
        }
        const body = table(['date', 'value'], obs.map((o: Document) => [o.date, fmtNum(o.value)]));
        return `# ${doc.seriesId} ${doc.name}, unit: ${doc.unit}, freq: ${doc.frequency}\n${note}${body}`;
      },
    },
  ],
};
