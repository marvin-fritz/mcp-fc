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

describe('get_price_history', () => {
  it('returns daily OHLC candles for the last 90 days by default', async () => {
    const res: any = await h.client.callTool({ name: 'get_price_history', arguments: { identifier: 'DE0005773303' } });
    const out = text(res);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^# DE0005773303 day OHLC, [A-Z]{3}$/);
    expect(lines[1]).toBe('date|open|high|low|close|volume');
    expect(lines.length).toBeGreaterThan(2);
    expect(lines[2]).toMatch(/^\d{4}-\d{2}-\d{2}\|/);
  });

  it('rejects ranges that would exceed 400 candles', async () => {
    const res: any = await h.client.callTool({
      name: 'get_price_history',
      arguments: { identifier: 'DE0005773303', from: '2000-01-01', to: '2026-01-01', interval: 'day' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/coarser interval|shorter range/);
  });

  it('supports monthly aggregation over multi-year ranges', async () => {
    const res: any = await h.client.callTool({
      name: 'get_price_history',
      arguments: { identifier: 'Fraport', from: '2024-01-01', interval: 'month' },
    });
    const lines = text(res).split('\n');
    expect(lines[1]).toBe('date|open|high|low|close|volume');
    expect(lines.length).toBeGreaterThan(3);
  });
});
