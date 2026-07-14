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

describe('get_financials', () => {
  it('returns annual statement matrix for AAPL', async () => {
    const res: any = await h.client.callTool({ name: 'get_financials', arguments: { identifier: 'AAPL' } });
    const out = text(res);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^# APPLE INC \(AAPL\) — annual, USD millions/);
    expect(lines[1]).toMatch(/^item\|FY\d{4}/);
    expect(out).toContain('## income');
    expect(out).toContain('## balance');
    expect(out).toContain('## cashflow');
    expect(out).toMatch(/\nrevenue\|\d/);
    expect(out).toMatch(/\ngrossMargin\|[\d.]+%/);
    // eps is per-share, must not be scaled to millions (would render as 0)
    const eps = out.split('\n').find((l) => l.startsWith('epsBasic|'));
    expect(eps).toBeDefined();
    expect(eps!.split('|')[1]).not.toBe('0');
  });

  it('respects statements + periods params', async () => {
    const res: any = await h.client.callTool({
      name: 'get_financials',
      arguments: { identifier: 'AAPL', statements: ['income'], period: 'quarterly', periods: 2 },
    });
    const out = text(res);
    expect(out).toContain('## income');
    expect(out).not.toContain('## balance');
    const header = out.split('\n').find((l) => l.startsWith('item|'))!;
    expect(header.split('|')).toHaveLength(3);
  });

  it('errors on identifiers without filings', async () => {
    const res: any = await h.client.callTool({ name: 'get_financials', arguments: { identifier: 'zzz_nope' } });
    expect(res.isError).toBe(true);
  });
});
