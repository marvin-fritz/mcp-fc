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

describe('search_securities', () => {
  it('finds Fraport by name with pipe-table output', async () => {
    const res: any = await h.client.callTool({ name: 'search_securities', arguments: { query: 'Fraport' } });
    const out = text(res);
    expect(out.split('\n')[0]).toBe('isin|ticker|name|sector|industryGroup|indices|exch');
    expect(out).toContain('DE0005773303');
  });

  it('finds by ticker', async () => {
    const res: any = await h.client.callTool({ name: 'search_securities', arguments: { query: 'AAPL' } });
    expect(text(res)).toContain('US0378331005');
  });

  it('returns 0 rows marker for no match', async () => {
    const res: any = await h.client.callTool({ name: 'search_securities', arguments: { query: 'zzz_nope_zzz' } });
    expect(text(res)).toBe('# 0 rows');
  });
});

describe('get_security_snapshot', () => {
  it('returns kv block with core fields', async () => {
    const res: any = await h.client.callTool({ name: 'get_security_snapshot', arguments: { identifier: 'DE0005773303' } });
    const out = text(res);
    expect(out).toContain('name: FRAPORT');
    expect(out).toContain('isin: DE0005773303');
    expect(out).toMatch(/lastPrice: [\d.]+ [A-Z]{3}/);
  });

  it('errors helpfully on unknown identifier', async () => {
    const res: any = await h.client.callTool({ name: 'get_security_snapshot', arguments: { identifier: 'zzz_nope' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/search_securities/);
  });
});

describe('screen_stocks', () => {
  it('screens by index sorted by marketCap desc', async () => {
    const res: any = await h.client.callTool({
      name: 'screen_stocks',
      arguments: { index: 'DAX', sortBy: 'marketCap', limit: 5 },
    });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('isin|ticker|name|sector|mcap(USDm)|r1D%|r1M%|r1Y%|rYTD%|52wPos');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it('caps limit at 100', async () => {
    const res: any = await h.client.callTool({ name: 'screen_stocks', arguments: { limit: 5000 } });
    const dataLines = text(res).split('\n').filter((l) => !l.startsWith('#')).length - 1;
    expect(dataLines).toBeLessThanOrEqual(100);
  });
});
