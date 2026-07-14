import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { resolveSecurity } from '../../db/identifiers.js';
import { fmtDate, fmtNum } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

const MAX_CANDLES = 400;
const DAYS_PER_UNIT = { day: 1, week: 7, month: 30 } as const;

export const pricesFeature: FeatureModule = {
  name: 'prices',
  tools: [
    {
      name: 'get_price_history',
      title: 'Price history (OHLC)',
      description:
        'OHLC candles aggregated server-side from trade data. interval: day|week|month (default day). Default range: last 90 days. Max 400 candles — use coarser intervals for long ranges. Dates YYYY-MM-DD. Example: {"identifier":"AAPL","from":"2026-01-01","interval":"week"}',
      inputSchema: {
        identifier: z.string().min(1).describe('ISIN, ticker or name'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        interval: z.enum(['day', 'week', 'month']).optional(),
        source: z.string().optional().describe('restrict to one exchange feed, e.g. xetra, lsx'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const ref = await resolveSecurity(db, input.identifier);
        if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
        const interval = (input.interval ?? 'day') as keyof typeof DAYS_PER_UNIT;
        const to = input.to ? new Date(`${input.to}T23:59:59.999Z`) : new Date();
        const from = input.from ? new Date(`${input.from}T00:00:00Z`) : new Date(to.getTime() - 90 * 86_400_000);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
          throw new ToolError('invalid from/to range — use YYYY-MM-DD with from < to');
        }
        const estimated = Math.ceil((to.getTime() - from.getTime()) / 86_400_000 / DAYS_PER_UNIT[interval]);
        if (estimated > MAX_CANDLES) {
          throw new ToolError(`~${estimated} candles exceeds ${MAX_CANDLES} — use a coarser interval or shorter range`);
        }
        const match: Record<string, unknown> = { isin: ref.isin, tradeTime: { $gte: from, $lte: to } };
        if (input.source) match.source = input.source;
        const candles = await cols(db)
          .stockPrices.aggregate(
            [
              { $match: match },
              { $sort: { tradeTime: 1 } },
              {
                $group: {
                  _id: { $dateTrunc: { date: '$tradeTime', unit: interval } },
                  open: { $first: '$price' },
                  high: { $max: '$price' },
                  low: { $min: '$price' },
                  close: { $last: '$price' },
                  volume: { $sum: { $ifNull: ['$size', 0] } },
                  ccy: { $first: '$currency' },
                },
              },
              { $sort: { _id: 1 } },
            ],
            { maxTimeMS: MAX_TIME_MS, allowDiskUse: false },
          )
          .toArray();
        if (candles.length === 0) return `# 0 rows — no trades for ${ref.isin} in range`;
        const body = table(
          ['date', 'open', 'high', 'low', 'close', 'volume'],
          candles.map((c) => [fmtDate(c._id), fmtNum(c.open), fmtNum(c.high), fmtNum(c.low), fmtNum(c.close), fmtNum(c.volume, 0)]),
        );
        return `# ${ref.isin} ${interval} OHLC, ${candles[0].ccy}\n${body}`;
      },
    },
  ],
};
