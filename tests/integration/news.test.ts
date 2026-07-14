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

describe('search_news', () => {
  it('returns latest news without query', async () => {
    const res: any = await h.client.callTool({ name: 'search_news', arguments: { limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('date|source|title|link');
    expect(lines.length).toBe(6);
    const d1 = lines[1].split('|')[0];
    const d5 = lines[5].split('|')[0];
    expect(d1 >= d5).toBe(true);
  });

  it('full-text searches titles/descriptions', async () => {
    const res: any = await h.client.callTool({ name: 'search_news', arguments: { query: 'inflation', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(1);
  });

  it('includeDescription adds the column', async () => {
    const res: any = await h.client.callTool({ name: 'search_news', arguments: { limit: 2, includeDescription: true } });
    const header = text(res).split('\n').find((l) => l.startsWith('date|'))!;
    expect(header).toBe('date|source|title|link|description');
  });
});
