import { z } from 'zod';
import type { Db, Document } from 'mongodb';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { escapeRegex, resolveSecurity } from '../../db/identifiers.js';
import { fmtDate, fmtMillions, fmtNum, fmtPct } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';
import { ACTIVE, FULL_SNAPSHOT, HOLDERS_MAX_TIME_MS, cusipFromIsin, holdersPipeline } from './holders.js';

async function findFund(db: Db, q: string): Promise<Document | null> {
  const c = cols(db).funds;
  const opts = { projection: { cik: 1, companyName: 1 }, maxTimeMS: MAX_TIME_MS };
  if (/^\d+$/.test(q.trim())) return c.findOne({ cik: Number.parseInt(q, 10) }, opts);
  return c.findOne(
    { companyName: { $regex: escapeRegex(q.trim()), $options: 'i' } },
    { ...opts, sort: { portfolioValueUsd: -1 } },
  );
}

export const fundsFeature: FeatureModule = {
  name: 'funds',
  tools: [
    {
      name: 'search_funds',
      title: 'Search funds',
      description:
        '13F institutional managers by name substring or CIK. aum = latest reported portfolio value. Example: {"query":"Berkshire"}',
      inputSchema: {
        query: z.string().min(1).describe('fund name substring or CIK'),
        limit: z.number().int().min(1).max(50).optional().describe('default 25'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 50);
        const q = String(input.query).trim();
        const filter = /^\d+$/.test(q)
          ? { cik: Number.parseInt(q, 10) }
          : { companyName: { $regex: escapeRegex(q), $options: 'i' } };
        const docs = await cols(db)
          .funds.find(filter, {
            projection: { cik: 1, companyName: 1, portfolioValueUsd: 1, positionCount: 1, lastFilingDate: 1, latestReportPeriod: 1 },
            sort: { portfolioValueUsd: -1 },
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        return table(
          ['cik', 'name', 'aum(USDm)', 'positions', 'lastFiling', 'latestPeriod'],
          docs.slice(0, lim).map((d) => [d.cik, d.companyName, fmtMillions(d.portfolioValueUsd), d.positionCount, d.lastFilingDate, d.latestReportPeriod]),
          { hasMore },
        );
      },
    },
    {
      name: 'get_fund_holdings',
      title: '13F holdings',
      description:
        'Either fund → its 13F portfolio (latest or given reportPeriod), or identifier (stock) → top institutional holders. Values in USD millions. period format YYYY-MM-DD (quarter end). Example: {"fund":"Berkshire"} or {"identifier":"AAPL"}',
      inputSchema: {
        fund: z.string().optional().describe('fund name substring or CIK'),
        identifier: z.string().optional().describe('stock ISIN, ticker or name — lists top holders'),
        period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('reportPeriod, default latest'),
        limit: z.number().int().min(1).optional().describe('default 50, max 200'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 50, 200);
        const c = cols(db);
        if (input.fund) {
          const fund = await findFund(db, input.fund);
          if (!fund) throw new ToolError(`fund '${input.fund}' not found — use search_funds`);
          const active = { cik: fund.cik, ...ACTIVE };
          let period: string | undefined = input.period;
          if (!period) {
            const latest = await c.f13Filings
              .find({ ...active, ...FULL_SNAPSHOT }, { projection: { reportPeriod: 1 }, sort: { reportPeriod: -1 }, limit: 1, maxTimeMS: MAX_TIME_MS })
              .toArray();
            period = latest[0]?.reportPeriod;
          }
          // the period's portfolio = its active full snapshot plus additive NEW HOLDINGS amendments
          const filings = period
            ? await c.f13Filings.find({ ...active, reportPeriod: period }, { projection: { holdings: 1 }, maxTimeMS: MAX_TIME_MS }).toArray()
            : [];
          if (filings.length === 0) throw new ToolError(`no 13F filing for CIK ${fund.cik}${input.period ? ` at ${input.period}` : ''}`);
          const filing = { reportPeriod: period };
          const holdings = filings.flatMap((f) => (f.holdings ?? []) as Document[]);
          const total = holdings.reduce((s, x) => s + (x.valueUsd ?? 0), 0);
          const top = [...holdings].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)).slice(0, lim);
          const body = table(
            ['issuer', 'isin', 'value(USDm)', 'shares', 'pct'],
            top.map((x) => [
              x.putCall ? `${x.issuer} (${x.putCall})` : x.issuer,
              x.isin,
              fmtMillions(x.valueUsd),
              fmtNum(x.shares, 0),
              total > 0 ? fmtPct((x.valueUsd ?? 0) / total) : '',
            ]),
            { hasMore: holdings.length > lim },
          );
          return `# ${fund.companyName} (CIK ${fund.cik}) 13F ${filing.reportPeriod}, total $${fmtMillions(total)}m, ${holdings.length} positions\n${body}`;
        }
        if (input.identifier) {
          const ref = await resolveSecurity(db, input.identifier);
          if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
          // per-period match + $filter keeps this in the milliseconds even for widely-held stocks
          const cusip = cusipFromIsin(ref.isin);
          const holdersFor = (p: string) =>
            c.f13Filings.aggregate(holdersPipeline(p, ref.isin, cusip, lim), { maxTimeMS: HOLDERS_MAX_TIME_MS }).toArray();
          let period = input.period;
          let holders: Document[] = [];
          if (period) {
            holders = await holdersFor(period);
          } else {
            // 13F filings trickle in ~45 days after quarter end — take the newest period with any holders
            const periods = (await c.f13Filings.distinct('reportPeriod')).filter(Boolean).sort().reverse();
            for (const p of periods.slice(0, 4)) {
              holders = await holdersFor(p as string);
              if (holders.length > 0) {
                period = p as string;
                break;
              }
            }
          }
          if (!period || holders.length === 0) throw new ToolError(`no 13F holdings found for ${ref.isin}`);
          const body = table(
            ['fund', 'cik', 'value(USDm)', 'shares'],
            holders.map((x) => [x.companyName, x.cik, fmtMillions(x.valueUsd), fmtNum(x.shares, 0)]),
          );
          return `# holders of ${ref.isin}, 13F ${fmtDate(period)}, one row per filer, share positions only (recent quarters may be partially filed — pass period for a complete one)\n${body}`;
        }
        throw new ToolError('provide either fund or identifier');
      },
    },
  ],
};
