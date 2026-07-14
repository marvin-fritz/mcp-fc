import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { escapeRegex, resolveSecurity } from '../../db/identifiers.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

function fmtAmount(low: number | null, high: number | null, exact: number | null): string {
  if (exact != null) return `$${Math.round(exact / 1000)}k`;
  if (low == null && high == null) return '';
  const k = (v: number | null) => (v == null ? '?' : `${Math.round(v / 1000)}k`);
  return `$${k(low)}-${k(high)}`;
}

export const politicalFeature: FeatureModule = {
  name: 'political',
  tools: [
    {
      name: 'get_political_trades',
      title: 'Congressional trades',
      description:
        'Stock trades disclosed by US Congress members, ordered by filing date desc. transactionType codes: P=purchase, S=sale, SP=partial sale, EX=exchange. amount is the disclosed range. Example: {"politician":"Pelosi"} or {"identifier":"NVDA","chamber":"house"}',
      inputSchema: {
        politician: z.string().optional().describe('politician name substring'),
        identifier: z.string().optional().describe('stock ISIN, ticker or name'),
        chamber: z.enum(['house', 'senate']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('min filingDate'),
        limit: z.number().int().min(1).optional().describe('default 25, max 100'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 100);
        let ticker: string | null = null;
        if (input.identifier) {
          const ref = await resolveSecurity(db, input.identifier);
          ticker = ref?.ticker ?? input.identifier.toUpperCase();
        }
        const match: Record<string, unknown> = { parseStatus: 'parsed' };
        if (input.politician) match['filer.fullName'] = { $regex: escapeRegex(input.politician), $options: 'i' };
        if (input.chamber) match.chamber = input.chamber;
        if (input.from) match.filingDate = { $gte: input.from };
        if (ticker) match['trades.ticker'] = ticker;
        const rows = await cols(db)
          .politicalFilings.aggregate(
            [
              { $match: match },
              { $sort: { filingDate: -1 } },
              { $limit: 500 },
              { $unwind: '$trades' },
              ...(ticker ? [{ $match: { 'trades.ticker': ticker } }] : []),
              {
                $project: {
                  filingDate: 1,
                  chamber: 1,
                  name: '$filer.fullName',
                  txDate: '$trades.transactionDate',
                  ticker: '$trades.ticker',
                  asset: '$trades.asset',
                  type: '$trades.transactionType',
                  low: '$trades.amountRangeLow',
                  high: '$trades.amountRangeHigh',
                  exact: '$trades.amountExact',
                  owner: '$trades.owner',
                },
              },
              { $limit: lim + 1 },
            ],
            { maxTimeMS: MAX_TIME_MS },
          )
          .toArray();
        if (rows.length === 0 && input.politician) {
          throw new ToolError(`no parsed filings match politician '${input.politician}'`);
        }
        const hasMore = rows.length > lim;
        return table(
          ['txDate', 'filed', 'politician', 'chamber', 'ticker', 'asset', 'type', 'amount', 'owner'],
          rows.slice(0, lim).map((r) => [
            r.txDate,
            r.filingDate,
            r.name,
            r.chamber,
            r.ticker,
            typeof r.asset === 'string' ? r.asset.slice(0, 40) : r.asset,
            r.type,
            fmtAmount(r.low, r.high, r.exact),
            r.owner,
          ]),
          { hasMore },
        );
      },
    },
  ],
};
