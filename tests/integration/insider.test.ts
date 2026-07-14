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

describe('get_insider_trades', () => {
  it('lists market-wide trades with company column, newest first', async () => {
    const res: any = await h.client.callTool({ name: 'get_insider_trades', arguments: { limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('date|company|insider|role|type|shares|price|total|ccy');
    expect(lines.length).toBe(6);
    const d1 = lines[1].split('|')[0];
    const d2 = lines[5].split('|')[0];
    expect(d1 >= d2).toBe(true);
  });

  it('filters by company (drops company column) and type', async () => {
    const res: any = await h.client.callTool({
      name: 'get_insider_trades',
      arguments: { identifier: 'AAPL', transactionType: 'SELL', limit: 5 },
    });
    const out = text(res);
    const lines = out.split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('date|insider|role|type|shares|price|total|ccy');
    for (const row of lines.slice(1)) expect(row.split('|')[3]).toBe('SELL');
  });

  it('caps limit at 100', async () => {
    const res: any = await h.client.callTool({ name: 'get_insider_trades', arguments: { limit: 1000 } });
    const rows = text(res).split('\n').filter((l) => !l.startsWith('#')).length - 1;
    expect(rows).toBeLessThanOrEqual(100);
  });
});
