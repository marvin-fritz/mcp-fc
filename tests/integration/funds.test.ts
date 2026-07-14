import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
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
