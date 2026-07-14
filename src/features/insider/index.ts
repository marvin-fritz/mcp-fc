import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { resolveSecurity } from '../../db/identifiers.js';
import { fmtDate, fmtNum } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

export const insiderFeature: FeatureModule = {
  name: 'insider',
  tools: [
    {
      name: 'get_insider_trades',
      title: 'Insider trades',
      description:
        'Insider transactions, newest first. Without identifier: market-wide. transactionType: BUY|SELL|AWARD|OPTION_EXERCISE|TRANSFER|OTHER. minAmount filters |total| in instrument currency. total is signed (negative = disposal). Example: {"identifier":"AAPL","transactionType":"BUY","from":"2026-01-01"}',
      inputSchema: {
        identifier: z.string().optional().describe('ISIN, ticker or name; omit for market-wide'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        transactionType: z.enum(['BUY', 'SELL', 'AWARD', 'OPTION_EXERCISE', 'TRANSFER', 'OTHER']).optional(),
        minAmount: z.number().optional().describe('min absolute transaction value'),
        limit: z.number().int().min(1).optional().describe('default 25, max 100'),
        offset: z.number().int().min(0).optional(),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 100);
        const offset = input.offset ?? 0;
        const filter: Record<string, unknown> = {};
        if (input.identifier) {
          const ref = await resolveSecurity(db, input.identifier);
          if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
          filter.isin = ref.isin;
        }
        if (input.from || input.to) {
          filter.transactionDate = {
            ...(input.from ? { $gte: new Date(`${input.from}T00:00:00Z`) } : {}),
            ...(input.to ? { $lte: new Date(`${input.to}T23:59:59.999Z`) } : {}),
          };
        }
        if (input.transactionType) filter.transactionType = input.transactionType;
        if (input.minAmount != null) filter.totalAmount = { $gte: input.minAmount };
        const docs = await cols(db)
          .insiderTrades.find(filter, {
            projection: {
              transactionDate: 1,
              companyName: 1,
              insiderName: 1,
              insiderRole: 1,
              transactionType: 1,
              shares: 1,
              pricePerShare: 1,
              totalAmountSigned: 1,
              currency: 1,
            },
            sort: { transactionDate: -1 },
            skip: offset,
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        const withCompany = !filter.isin;
        const headers = withCompany
          ? ['date', 'company', 'insider', 'role', 'type', 'shares', 'price', 'total', 'ccy']
          : ['date', 'insider', 'role', 'type', 'shares', 'price', 'total', 'ccy'];
        return table(
          headers,
          docs.slice(0, lim).map((d) => {
            const base = [
              fmtDate(d.transactionDate),
              d.insiderName,
              d.insiderRole,
              d.transactionType,
              fmtNum(d.shares, 0),
              fmtNum(d.pricePerShare),
              fmtNum(d.totalAmountSigned, 0),
              d.currency,
            ];
            if (withCompany) base.splice(1, 0, d.companyName);
            return base;
          }),
          { offset, hasMore },
        );
      },
    },
  ],
};
