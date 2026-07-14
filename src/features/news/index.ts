import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { escapeRegex } from '../../db/identifiers.js';
import { fmtDate } from '../../format/num.js';
import { table } from '../../format/table.js';
import type { FeatureModule } from '../types.js';

export const newsFeature: FeatureModule = {
  name: 'news',
  tools: [
    {
      name: 'search_news',
      title: 'Search news',
      description:
        'Financial news, newest first. query = full-text search over title+description (omit for latest). Filters: from/to (pubDate, YYYY-MM-DD), source (name substring, e.g. Handelsblatt), category (e.g. COMPANIES). Example: {"query":"inflation ECB","from":"2026-06-01"}',
      inputSchema: {
        query: z.string().optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        source: z.string().optional(),
        category: z.string().optional(),
        includeDescription: z.boolean().optional().describe('adds description column (more tokens)'),
        limit: z.number().int().min(1).max(50).optional().describe('default 25'),
        offset: z.number().int().min(0).optional(),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 50);
        const offset = input.offset ?? 0;
        const filter: Record<string, unknown> = {};
        if (input.query) filter.$text = { $search: input.query };
        if (input.from || input.to) {
          filter.pubDate = {
            ...(input.from ? { $gte: new Date(`${input.from}T00:00:00Z`) } : {}),
            ...(input.to ? { $lte: new Date(`${input.to}T23:59:59.999Z`) } : {}),
          };
        }
        if (input.source) filter.sourceName = { $regex: escapeRegex(input.source), $options: 'i' };
        if (input.category) filter.category = input.category.toUpperCase();
        const projection: Record<string, unknown> = { pubDate: 1, sourceName: 1, title: 1, link: 1 };
        if (input.includeDescription) projection.description = 1;
        const docs = await cols(db)
          .news.find(filter, {
            projection,
            sort: { pubDate: -1 },
            skip: offset,
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        const headers = ['date', 'source', 'title', 'link'];
        if (input.includeDescription) headers.push('description');
        return table(
          headers,
          docs.slice(0, lim).map((d) => {
            const row: Array<string | null | undefined> = [fmtDate(d.pubDate), d.sourceName, d.title, d.link];
            if (input.includeDescription) row.push(d.description);
            return row;
          }),
          { offset, hasMore },
        );
      },
    },
  ],
};
