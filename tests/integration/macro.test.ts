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

describe('get_macro_series', () => {
  it('lists the catalog when called without seriesId', async () => {
    const res: any = await h.client.callTool({ name: 'get_macro_series', arguments: {} });
    const out = text(res);
    const lines = out.split('\n');
    expect(lines[0]).toBe('seriesId|name|unit|freq|category|source|lastDate');
    expect(out).toContain('CPIAUCSL');
  });

  it('returns observations for a series with range filter', async () => {
    const res: any = await h.client.callTool({
      name: 'get_macro_series',
      arguments: { seriesId: 'CPIAUCSL', from: '2024-01-01' },
    });
    const out = text(res);
    expect(out.split('\n')[0]).toMatch(/^# CPIAUCSL /);
    expect(out.split('\n')[1]).toBe('date|value');
    const first = out.split('\n')[2].split('|')[0];
    expect(first >= '2024-01-01').toBe(true);
  });

  it('errors on unknown seriesId', async () => {
    const res: any = await h.client.callTool({ name: 'get_macro_series', arguments: { seriesId: 'NOPE123' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/catalog/);
  });
});
