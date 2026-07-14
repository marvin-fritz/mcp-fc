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
    expect(lines[0]).toBe('txDate|filed|politician|chamber|ticker|asset|type|amount|owner');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('filters by ticker', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { identifier: 'AMZN', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    for (const row of lines.slice(1)) expect(row.split('|')[4]).toBe('AMZN');
  });

  it('filters by chamber', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { chamber: 'house', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    for (const row of lines.slice(1)) expect(row.split('|')[3]).toBe('house');
  });
});
