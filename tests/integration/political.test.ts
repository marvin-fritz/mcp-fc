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

describe('get_political_trades', () => {
  it('lists recent congressional trades', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { limit: 10 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('txDate|filed|politician|party|chamber|ticker|asset|assetType|type|amount|owner');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('filters by ticker', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { identifier: 'AMZN', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    for (const row of lines.slice(1)) expect(row.split('|')[5]).toBe('AMZN');
  });

  it('filters by chamber', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { chamber: 'house', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    for (const row of lines.slice(1)) expect(row.split('|')[4]).toBe('house');
  });

  it('filters by party', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { party: 'D', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(1);
    for (const row of lines.slice(1)) expect(row.split('|')[3]).toBe('D');
  });

  it('throws a descriptive error naming the single active filter when nothing matches', async () => {
    const res: any = await h.client.callTool({
      name: 'get_political_trades',
      arguments: { from: '2099-01-01' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("from '2099-01-01'");
  });

  it('throws a descriptive error naming all active filters when nothing matches', async () => {
    const res: any = await h.client.callTool({
      name: 'get_political_trades',
      arguments: { politician: 'Zzzznonexistentname', chamber: 'house', party: 'I', from: '2099-01-01' },
    });
    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toContain("politician 'Zzzznonexistentname'");
    expect(msg).toContain("chamber 'house'");
    expect(msg).toContain("party 'I'");
    expect(msg).toContain("from '2099-01-01'");
  });
});
