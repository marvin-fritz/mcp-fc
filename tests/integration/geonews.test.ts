import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ObjectId } from 'mongodb';
import type { Db } from 'mongodb';
import { loadConfig } from '../../src/config.js';
import { closeMongo, getDb } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

const CAT = 'MCPFCTEST';
let h: Awaited<ReturnType<typeof testClient>>;
let hReadOnly: Awaited<ReturnType<typeof testClient>>;
let db: Db;
let newsIds: ObjectId[] = [];

beforeAll(async () => {
  const config = loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' });
  db = await getDb(config);
  await db.collection('newsGeo').deleteMany({ category: CAT });
  await db.collection('news').deleteMany({ category: CAT });
  const now = new Date();
  const docs = [1, 2, 3].map((i) => ({
    title: `Test News ${i} | mit Pipe`,
    description: `Beschreibung ${i}`,
    link: `https://test.mcp-fc.local/${i}`,
    image: `https://test.mcp-fc.local/img${i}.jpg`,
    sourceName: 'MCP-FC-Test',
    source: 'https://test.mcp-fc.local/',
    category: CAT,
    pubDate: new Date(now.getTime() - i * 60_000),
    createdAt: now,
  }));
  const res = await db.collection('news').insertMany(docs);
  newsIds = Object.values(res.insertedIds);
  h = await testClient(['read', 'write']);
  hReadOnly = await testClient(['read']);
});

afterAll(async () => {
  await db.collection('newsGeo').deleteMany({ newsId: { $in: newsIds } });
  await db.collection('news').deleteMany({ category: CAT });
  await h.close();
  await hReadOnly.close();
  await closeMongo();
});

describe('get_news_for_geocoding', () => {
  it('lists unlocated news with newsId column and sanitized cells', async () => {
    const res: any = await h.client.callTool({ name: 'get_news_for_geocoding', arguments: { category: CAT } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('newsId|date|category|source|title|description');
    expect(lines.length).toBe(4);
    expect(lines[1].split('|')[0]).toMatch(/^[a-f0-9]{24}$/);
    expect(text(res)).toContain('Test News 1 ¦ mit Pipe');
  });
});

describe('submit_news_locations', () => {
  it('rejects for read-only key', async () => {
    const res: any = await hReadOnly.client.callTool({
      name: 'submit_news_locations',
      arguments: { items: [{ newsId: String(newsIds[0]), noLocation: true }] },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/scope 'write'/);
  });

  it('writes locations and noLocation markers with denormalized fields', async () => {
    const res: any = await h.client.callTool({
      name: 'submit_news_locations',
      arguments: {
        items: [
          { newsId: String(newsIds[0]), lat: 50.1109, lon: 8.6821, country: 'de', place: 'Frankfurt am Main', precision: 'city', confidence: 0.9, relevance: 0.72, summary: 'EZB-Entscheid.' },
          { newsId: String(newsIds[1]), lat: 40.7128, lon: -74.006, country: 'US', place: 'New York', precision: 'city', relevance: 0.95 },
          { newsId: String(newsIds[2]), noLocation: true },
        ],
      },
    });
    expect(text(res)).toContain('ok: 2 located, 1 noLocation (0 updated)');
    const doc: any = await db.collection('newsGeo').findOne({ newsId: newsIds[0] });
    expect(doc.location).toEqual({ type: 'Point', coordinates: [8.6821, 50.1109] });
    expect(doc.country).toBe('DE');
    expect(doc.image).toBe('https://test.mcp-fc.local/img1.jpg');
    expect(doc.link).toBe('https://test.mcp-fc.local/1');
    expect(doc.locatable).toBe(true);
    expect(doc.locatedBy).toBe('test');
    expect(doc.summary).toBe('EZB-Entscheid.');
    expect(doc.relevance).toBe(0.72);
    const marker: any = await db.collection('newsGeo').findOne({ newsId: newsIds[2] });
    expect(marker.locatable).toBe(false);
    expect(marker.location).toBeUndefined();
    expect(marker.relevance).toBeUndefined();
    expect(marker.title).toContain('Test News 3');
  });

  it('requires relevance for located items and rejects out-of-range values', async () => {
    const missing: any = await h.client.callTool({
      name: 'submit_news_locations',
      arguments: { items: [{ newsId: String(newsIds[0]), lat: 1, lon: 1, country: 'FR', precision: 'city' }] },
    });
    expect(text(missing)).toContain('ok: 0 located, 0 noLocation (0 updated)');
    expect(text(missing)).toMatch(/ERROR item 0:.*relevance/);

    const outOfRange: any = await h.client.callTool({
      name: 'submit_news_locations',
      arguments: { items: [{ newsId: String(newsIds[0]), lat: 1, lon: 1, country: 'FR', precision: 'city', relevance: 1.5 }] },
    });
    expect(outOfRange.isError).toBe(true);
  });

  it('fetch afterwards returns 0 rows for the test category', async () => {
    const res: any = await h.client.callTool({ name: 'get_news_for_geocoding', arguments: { category: CAT } });
    expect(text(res)).toContain('# 0 rows');
  });

  it('re-submit updates idempotently', async () => {
    const res: any = await h.client.callTool({
      name: 'submit_news_locations',
      arguments: { items: [{ newsId: String(newsIds[0]), lat: 48.1351, lon: 11.582, country: 'DE', place: 'München', precision: 'city', relevance: 0.4 }] },
    });
    expect(text(res)).toContain('ok: 1 located, 0 noLocation (1 updated)');
    const doc: any = await db.collection('newsGeo').findOne({ newsId: newsIds[0] });
    expect(doc.place).toBe('München');
    expect(doc.relevance).toBe(0.4);
  });

  it('skips invalid items but writes valid ones', async () => {
    const unknownId = new ObjectId().toHexString();
    const res: any = await h.client.callTool({
      name: 'submit_news_locations',
      arguments: {
        items: [
          { newsId: unknownId, lat: 1, lon: 1, country: 'FR', precision: 'city', relevance: 0.5 },
          { newsId: String(newsIds[1]), lat: 51.5074, lon: -0.1278, country: 'GB', precision: 'city', relevance: 0.6 },
          { newsId: String(newsIds[2]), lat: 2, lon: 2 },
        ],
      },
    });
    const out = text(res);
    expect(out).toContain('ok: 1 located, 0 noLocation (1 updated)');
    expect(out).toContain(`ERROR item 0: newsId ${unknownId} not found`);
    expect(out).toContain('ERROR item 2:');
  });
});
