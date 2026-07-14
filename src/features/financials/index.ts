import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { resolveSecurity } from '../../db/identifiers.js';
import { fmtMillions, fmtNum, fmtPct, toNum } from '../../format/num.js';
import { ToolError, type FeatureModule } from '../types.js';

const STMT_KEYS = { income: 'incomeStatement', balance: 'balanceSheet', cashflow: 'cashFlow' } as const;
type StmtName = keyof typeof STMT_KEYS;
const RATIO_KEYS = new Set(['grossMargin', 'operatingMargin', 'netMargin', 'roe', 'roa']);
// per-share items stay in raw currency units, not millions
const isPerShare = (k: string) => k.startsWith('eps') || k.toLowerCase().includes('pershare');

export const financialsFeature: FeatureModule = {
  name: 'financials',
  tools: [
    {
      name: 'get_financials',
      title: 'Financial statements',
      description:
        'Income statement / balance sheet / cash flow from SEC filings as a compact matrix: rows = line items (values in currency millions, ratios like grossMargin/roe in %), columns = periods, newest first. period: annual (10-K/FY) or quarterly. Example: {"identifier":"AAPL","statements":["income"],"periods":4}',
      inputSchema: {
        identifier: z.string().min(1).describe('ISIN, ticker or name'),
        statements: z.array(z.enum(['income', 'balance', 'cashflow'])).optional().describe('default: all three'),
        period: z.enum(['annual', 'quarterly']).optional().describe('default annual'),
        periods: z.number().int().min(1).max(12).optional().describe('number of periods, default 4'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const ref = await resolveSecurity(db, input.identifier);
        if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
        if (!ref.cik && !ref.ticker) throw new ToolError(`no SEC mapping for ${ref.isin}`);
        const period = input.period ?? 'annual';
        const n = Math.min(input.periods ?? 4, 12);
        const match: Record<string, unknown> = ref.cik ? { cik: ref.cik } : { ticker: ref.ticker };
        match.fiscalPeriod = period === 'annual' ? 'FY' : { $in: ['Q1', 'Q2', 'Q3', 'Q4'] };
        const docs = await cols(db)
          .secFinancials.find(match, {
            projection: { incomeStatement: 1, balanceSheet: 1, cashFlow: 1, fiscalYear: 1, fiscalPeriod: 1, periodEnd: 1, currency: 1, filedAt: 1 },
            sort: { periodEnd: -1, filedAt: -1 },
            limit: n * 3,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        // dedupe amended filings: keep newest filedAt per periodEnd
        const seen = new Set<string>();
        const periodDocs = [];
        for (const d of docs) {
          if (!seen.has(d.periodEnd)) {
            seen.add(d.periodEnd);
            periodDocs.push(d);
            if (periodDocs.length === n) break;
          }
        }
        if (periodDocs.length === 0) throw new ToolError(`no ${period} SEC filings for ${ref.ticker ?? ref.isin}`);
        const stmts = (input.statements ?? ['income', 'balance', 'cashflow']) as StmtName[];
        const label = (d: any) => (d.fiscalPeriod === 'FY' ? `FY${d.fiscalYear}` : `${d.fiscalPeriod}'${String(d.fiscalYear).slice(2)}`);
        const lines: string[] = [
          `# ${ref.name} (${ref.ticker ?? ref.isin}) — ${period}, ${periodDocs[0].currency} millions (ratios in %)`,
          ['item', ...periodDocs.map(label)].join('|'),
        ];
        for (const stmt of stmts) {
          const key = STMT_KEYS[stmt];
          // union of item keys across periods, preserving first-seen order
          const items: string[] = [];
          for (const d of periodDocs) {
            for (const k of Object.keys(d[key] ?? {})) if (!items.includes(k)) items.push(k);
          }
          const rows: string[] = [];
          for (const item of items) {
            const values = periodDocs.map((d) => {
              const v = (d[key] ?? {})[item];
              if (toNum(v) === null) return '';
              if (RATIO_KEYS.has(item)) return fmtPct(v);
              if (isPerShare(item)) return fmtNum(v, 2);
              return fmtMillions(v);
            });
            if (values.every((v) => v === '')) continue;
            rows.push([item, ...values].join('|'));
          }
          if (rows.length > 0) lines.push(`## ${stmt}`, ...rows);
        }
        return lines.join('\n');
      },
    },
  ],
};
