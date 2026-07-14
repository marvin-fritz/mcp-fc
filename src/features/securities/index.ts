import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { ISIN_RE, escapeRegex, resolveSecurity } from '../../db/identifiers.js';
import { kv } from '../../format/kv.js';
import { fmtDateTime, fmtMillions, fmtNum, fmtPct } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

const SORT_FIELDS: Record<string, string> = {
  marketCap: 'marketCap',
  return1D: 'metrics.return1D',
  return1M: 'metrics.return1M',
  return3M: 'metrics.return3M',
  return6M: 'metrics.return6M',
  return1Y: 'metrics.return1Y',
  returnYTD: 'metrics.returnYTD',
  rangePosition52w: 'metrics.rangePosition52w',
};

export const securitiesFeature: FeatureModule = {
  name: 'securities',
  tools: [
    {
      name: 'search_securities',
      title: 'Search securities',
      description:
        'Find stocks/securities by name substring, ticker or ISIN. Returns master data (isin, ticker, name, sector, industryGroup, index memberships, exchange). Example: {"query":"Fraport"}',
      inputSchema: {
        query: z.string().min(1).describe('name substring, ticker or ISIN'),
        limit: z.number().int().min(1).max(50).optional().describe('max rows, default 25'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 50);
        const q = String(input.query).trim();
        const upper = q.toUpperCase();
        const or: object[] = [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { ticker: upper }];
        if (ISIN_RE.test(upper)) or.push({ isin: upper });
        const docs = await cols(db)
          .stockIndex.find(
            { $or: or },
            {
              projection: { isin: 1, ticker: 1, name: 1, 'classification.sector': 1, 'classification.industryGroup': 1, indices: 1, exchangeCode: 1 },
              limit: lim + 1,
              maxTimeMS: MAX_TIME_MS,
            },
          )
          .toArray();
        const hasMore = docs.length > lim;
        return table(
          ['isin', 'ticker', 'name', 'sector', 'industryGroup', 'indices', 'exch'],
          docs.slice(0, lim).map((d) => [
            d.isin,
            d.ticker,
            d.name,
            d.classification?.sector,
            d.classification?.industryGroup,
            (d.indices ?? []).join(','),
            d.exchangeCode,
          ]),
          { hasMore },
        );
      },
    },
    {
      name: 'get_security_snapshot',
      title: 'Security snapshot',
      description:
        'Compact profile of one security: master data, last trade price, marketCap (USD millions), returns (1D/1M/3M/6M/1Y/YTD in %), 52-week range position. identifier = ISIN, ticker or name. Example: {"identifier":"AAPL"}',
      inputSchema: {
        identifier: z.string().min(1).describe('ISIN, ticker or name'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const ref = await resolveSecurity(db, input.identifier);
        if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
        const c = cols(db);
        const [idx, met, last] = await Promise.all([
          c.stockIndex.findOne(
            { isin: ref.isin },
            { projection: { 'classification.sector': 1, 'classification.industryGroup': 1, indices: 1, exchangeCode: 1 }, maxTimeMS: MAX_TIME_MS },
          ),
          c.stockMetrics.findOne({ isin: ref.isin }, { projection: { metrics: 1, country: 1, marketCap: 1, dataAsOf: 1 }, maxTimeMS: MAX_TIME_MS }),
          c.stockPrices
            .find({ isin: ref.isin }, { projection: { price: 1, currency: 1, tradeTime: 1, source: 1 }, sort: { tradeTime: -1 }, limit: 1, maxTimeMS: MAX_TIME_MS })
            .toArray()
            .then((a) => a[0]),
        ]);
        const m = (met?.metrics ?? {}) as Record<string, unknown>;
        const rets = (
          [
            ['1D', 'return1D'],
            ['1M', 'return1M'],
            ['3M', 'return3M'],
            ['6M', 'return6M'],
            ['1Y', 'return1Y'],
            ['YTD', 'returnYTD'],
          ] as const
        )
          .map(([label, key]) => (m[key] == null ? null : `${label} ${fmtPct(m[key])}`))
          .filter(Boolean)
          .join(' | ');
        return kv([
          ['name', ref.name],
          ['isin', ref.isin],
          ['ticker', ref.ticker],
          ['exchange', idx?.exchangeCode],
          ['sector', idx?.classification?.sector],
          ['industryGroup', idx?.classification?.industryGroup],
          ['indices', (idx?.indices ?? []).join(',')],
          ['country', met?.country],
          ['marketCap(USDm)', fmtMillions(met?.marketCap)],
          ['lastPrice', last ? `${fmtNum(last.price)} ${last.currency} (${fmtDateTime(last.tradeTime)}, ${last.source})` : null],
          ['returns', rets || null],
          ['52wRangePos', m.rangePosition52w == null ? null : fmtPct(m.rangePosition52w)],
          ['metricsAsOf', met?.dataAsOf],
        ]);
      },
    },
    {
      name: 'screen_stocks',
      title: 'Screen stocks',
      description:
        'Screen/rank companies via computed metrics. Filters: sector, industryGroup, index (e.g. "DAX", "S&P 500"), country (ISO2), marketCapMinM/marketCapMaxM (USD millions). sortBy: marketCap|return1D|return1M|return3M|return6M|return1Y|returnYTD|rangePosition52w. Returns are %. Example: {"index":"DAX","sortBy":"return1Y","limit":10}',
      inputSchema: {
        sector: z.string().optional(),
        industryGroup: z.string().optional(),
        index: z.string().optional().describe('index membership, e.g. DAX'),
        country: z.string().length(2).optional(),
        marketCapMinM: z.number().optional().describe('min marketCap in USD millions'),
        marketCapMaxM: z.number().optional().describe('max marketCap in USD millions'),
        sortBy: z.enum(['marketCap', 'return1D', 'return1M', 'return3M', 'return6M', 'return1Y', 'returnYTD', 'rangePosition52w']).optional(),
        order: z.enum(['asc', 'desc']).optional().describe('default desc'),
        limit: z.number().int().min(1).optional().describe('default 25, max 100'),
        offset: z.number().int().min(0).optional(),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 100);
        const offset = input.offset ?? 0;
        const filter: Record<string, unknown> = {};
        if (input.sector) filter.sector = input.sector;
        if (input.industryGroup) filter.industryGroup = input.industryGroup;
        if (input.index) filter.indices = input.index;
        if (input.country) filter.country = input.country.toUpperCase();
        if (input.marketCapMinM != null || input.marketCapMaxM != null) {
          filter.marketCap = {
            ...(input.marketCapMinM != null ? { $gte: input.marketCapMinM * 1e6 } : {}),
            ...(input.marketCapMaxM != null ? { $lte: input.marketCapMaxM * 1e6 } : {}),
          };
        }
        const sortField = SORT_FIELDS[input.sortBy ?? 'marketCap'];
        const dir = input.order === 'asc' ? 1 : -1;
        const docs = await cols(db)
          .stockMetrics.find(filter, {
            projection: { isin: 1, ticker: 1, name: 1, sector: 1, marketCap: 1, metrics: 1 },
            sort: { [sortField]: dir },
            skip: offset,
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        return table(
          ['isin', 'ticker', 'name', 'sector', 'mcap(USDm)', 'r1D%', 'r1M%', 'r1Y%', 'rYTD%', '52wPos'],
          docs.slice(0, lim).map((d) => {
            const m = (d.metrics ?? {}) as Record<string, unknown>;
            return [
              d.isin,
              d.ticker,
              d.name,
              d.sector,
              fmtMillions(d.marketCap),
              fmtPct(m.return1D),
              fmtPct(m.return1M),
              fmtPct(m.return1Y),
              fmtPct(m.returnYTD),
              fmtPct(m.rangePosition52w),
            ];
          }),
          { offset, hasMore },
        );
      },
    },
  ],
};
