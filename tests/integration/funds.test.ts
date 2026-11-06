import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { closeMongo, getDb } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('search_funds', () => {
  it('finds funds by name, sorted by AUM desc', async () => {
    const res: any = await h.client.callTool({ name: 'search_funds', arguments: { query: 'capital', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('cik|name|aum(USDm)|positions|lastFiling|latestPeriod');
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe('get_fund_holdings', () => {
  it('returns holdings of the largest "capital" fund with pct column', async () => {
    const search: any = await h.client.callTool({ name: 'search_funds', arguments: { query: 'capital', limit: 1 } });
    const cik = text(search).split('\n').filter((l) => !l.startsWith('#'))[1].split('|')[0];
    const res: any = await h.client.callTool({ name: 'get_fund_holdings', arguments: { fund: cik, limit: 10 } });
    const out = text(res);
    expect(out.split('\n')[0]).toMatch(/^# .+ \(CIK \d+\) 13F \d{4}-\d{2}-\d{2}, total \$[\d.]+m, \d+ positions$/);
    const lines = out.split('\n').slice(1).filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('issuer|isin|value(USDm)|shares|pct');
    expect(lines.length).toBeLessThanOrEqual(11);
  });

  it('lists top holders of a stock', async () => {
    const res: any = await h.client.callTool({ name: 'get_fund_holdings', arguments: { identifier: 'AAPL', limit: 5 } });
    const out = text(res);
    expect(out.split('\n')[0]).toMatch(/^# holders of US0378331005, 13F \d{4}-\d{2}-\d{2}/);
    const lines = out.split('\n').slice(1);
    expect(lines[0]).toBe('fund|cik|value(USDm)|shares');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('requires fund or identifier', async () => {
    const res: any = await h.client.callTool({ name: 'get_fund_holdings', arguments: {} });
    expect(res.isError).toBe(true);
  });
});

// Self-checking against the local DB: expectations are computed from f13Filings directly.
describe('get_fund_holdings data quality (13F)', () => {
  const AAPL_CUSIP = '037833100';
  let db: Awaited<ReturnType<typeof getDb>>;

  beforeAll(async () => {
    db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
  });

  async function holders(period: string, limit = 200) {
    const res: any = await h.client.callTool({ name: 'get_fund_holdings', arguments: { identifier: 'AAPL', period, limit } });
    return text(res)
      .split('\n')
      .slice(2)
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => {
        const parts = l.split('|');
        return { cik: Number(parts[parts.length - 3]), shares: Number(parts[parts.length - 1].replace(/[^\d]/g, '')) };
      });
  }

  /** Latest complete period that has a superseded filing holding AAPL. */
  async function periodWithSuperseded(): Promise<string> {
    const doc = await db
      .collection('f13Filings')
      .find({ 'holdings.cusip': AAPL_CUSIP, supersededBy: { $ne: null } }, { projection: { reportPeriod: 1 }, sort: { reportPeriod: -1 }, limit: 1 })
      .toArray();
    return doc[0].reportPeriod;
  }

  it('lists every filer once', async () => {
    const rows = await holders(await periodWithSuperseded());
    expect(rows.length).toBeGreaterThan(10);
    expect(new Set(rows.map((r) => r.cik)).size).toBe(rows.length);
  });

  it('finds filers whose holdings carry no ISIN (match by CUSIP)', async () => {
    const period = await periodWithSuperseded();
    const [noIsin] = await db
      .collection('f13Filings')
      .aggregate([
        { $match: { reportPeriod: period, supersededBy: null, 'holdings.cusip': AAPL_CUSIP } },
        {
          $project: {
            cik: 1,
            h: {
              $filter: {
                input: '$holdings',
                cond: {
                  $and: [
                    { $eq: ['$$this.cusip', AAPL_CUSIP] },
                    { $eq: [{ $ifNull: ['$$this.isin', null] }, null] },
                    { $eq: [{ $ifNull: ['$$this.putCall', null] }, null] },
                  ],
                },
              },
            },
          },
        },
        { $unwind: '$h' },
        { $sort: { 'h.valueUsd': -1 } },
        { $limit: 1 },
      ])
      .toArray();
    if (!noIsin) return; // DB fully backfilled with ISINs — nothing to prove
    const rows = await holders(period);
    expect(rows.map((r) => r.cik)).toContain(noIsin.cik);
  });

  it('reports shares of active filings without options, summed per filer', async () => {
    const period = await periodWithSuperseded();
    const rows = await holders(period, 5);
    for (const row of rows) {
      const [agg] = await db
        .collection('f13Filings')
        .aggregate([
          { $match: { cik: row.cik, reportPeriod: period, supersededBy: null } },
          { $unwind: '$holdings' },
          { $match: { 'holdings.cusip': AAPL_CUSIP, 'holdings.putCall': null } },
          { $group: { _id: null, shares: { $sum: '$holdings.shares' } } },
        ])
        .toArray();
      expect(row.shares).toBe(agg.shares);
    }
  });

  it('fund view merges NEW HOLDINGS amendments and skips superseded filings', async () => {
    const [amendment] = await db
      .collection('f13Filings')
      .find({ formType: '13F-HR/A', amendmentType: 'NEW HOLDINGS', supersededBy: null }, { projection: { cik: 1, reportPeriod: 1 }, sort: { reportPeriod: -1 }, limit: 1 })
      .toArray();
    if (!amendment) return;
    const active = await db
      .collection('f13Filings')
      .aggregate([
        { $match: { cik: amendment.cik, reportPeriod: amendment.reportPeriod, supersededBy: null } },
        { $group: { _id: null, n: { $sum: { $size: { $ifNull: ['$holdings', []] } } } } },
      ])
      .toArray();
    const res: any = await h.client.callTool({
      name: 'get_fund_holdings',
      arguments: { fund: String(amendment.cik), period: amendment.reportPeriod, limit: 1 },
    });
    expect(text(res).split('\n')[0]).toContain(`, ${active[0].n} positions`);
  });
});
