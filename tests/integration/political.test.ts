import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

const HEADER = 'txDate|published|lagDays|politician|bioguideId|party|chamber|ticker|isin|asset|assetType|type|amount|owner|late';
const COL = Object.fromEntries(HEADER.split('|').map((c, i) => [c, i]));

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

async function rows(args: Record<string, unknown>): Promise<string[][]> {
  const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: args });
  expect(res.isError ?? false).toBe(false);
  const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
  expect(lines[0]).toBe(HEADER);
  return lines.slice(1).map((l) => l.split('|'));
}

describe('get_political_trades', () => {
  it('lists recent congressional trades from politicalTrades', async () => {
    const r = await rows({ limit: 10 });
    expect(r.length).toBeGreaterThan(0);
    expect(r.length).toBeLessThanOrEqual(10);
    // newest transaction date first
    const dates = r.map((c) => c[COL.txDate]).filter(Boolean);
    expect([...dates].sort().reverse()).toEqual(dates);
  });

  it('filters by identifier (ticker resolved to ISIN)', async () => {
    const r = await rows({ identifier: 'AMZN', limit: 5 });
    expect(r.length).toBeGreaterThan(0);
    for (const c of r) expect(c[COL.isin]).toBe('US0231351067');
  });

  it('filters by identifier given as ISIN', async () => {
    const r = await rows({ identifier: 'US67066G1040', limit: 5 });
    expect(r.length).toBeGreaterThan(0);
    for (const c of r) expect(c[COL.isin]).toBe('US67066G1040');
  });

  it('filters by chamber', async () => {
    for (const c of await rows({ chamber: 'house', limit: 5 })) expect(c[COL.chamber]).toBe('house');
  });

  it('filters by party', async () => {
    const r = await rows({ party: 'D', limit: 5 });
    expect(r.length).toBeGreaterThan(0);
    for (const c of r) expect(c[COL.party]).toBe('D');
  });

  it('filters by state', async () => {
    const r = await rows({ state: 'ca', limit: 5 });
    expect(r.length).toBeGreaterThan(0);
  });

  it('filters by transactionType', async () => {
    const r = await rows({ transactionType: 'S', limit: 5 });
    expect(r.length).toBeGreaterThan(0);
    for (const c of r) expect(c[COL.type]).toBe('S');
  });

  it('accepts a bioguide ID as politician', async () => {
    const r = await rows({ politician: 'P000197', limit: 5 });
    expect(r.length).toBeGreaterThan(0);
    for (const c of r) expect(c[COL.bioguideId]).toBe('P000197');
  });

  it('resolves a politician name via the politicians collection', async () => {
    const r = await rows({ politician: 'Pelosi', limit: 5 });
    expect(r.length).toBeGreaterThan(0);
    for (const c of r) expect(c[COL.bioguideId]).toBe('P000197');
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
      arguments: { politician: 'Zzzznonexistentname', chamber: 'house', party: 'I', state: 'ZZ', transactionType: 'E', from: '2099-01-01' },
    });
    expect(res.isError).toBe(true);
    const msg = text(res);
    expect(msg).toContain("politician 'Zzzznonexistentname'");
    expect(msg).toContain("chamber 'house'");
    expect(msg).toContain("party 'I'");
    expect(msg).toContain("state 'ZZ'");
    expect(msg).toContain("transactionType 'E'");
    expect(msg).toContain("from '2099-01-01'");
  });
});

describe('get_politician_profile', () => {
  it('profiles Pelosi with committees, bands and top securities', async () => {
    const res: any = await h.client.callTool({ name: 'get_politician_profile', arguments: { politician: 'Pelosi' } });
    expect(res.isError ?? false).toBe(false);
    const out = text(res);
    expect(out).toContain('bioguideId: P000197');
    expect(out).toContain('window: all');
    expect(out).toMatch(/^trades: \d+/m);
    expect(out).toMatch(/^volume: /m);
    expect(out).toMatch(/^net: /m);
    expect(out).toContain('# top securities by volume\nisin|ticker|asset|trades|volume|net');
  });

  it('accepts a bioguide ID and a window', async () => {
    const res: any = await h.client.callTool({ name: 'get_politician_profile', arguments: { politician: 'P000197', window: '1y' } });
    expect(res.isError ?? false).toBe(false);
    expect(text(res)).toContain('window: 1y');
  });

  it('lists candidates for an ambiguous name', async () => {
    const res: any = await h.client.callTool({ name: 'get_politician_profile', arguments: { politician: 'Johnson' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/ambiguous: .*\([A-Z]\d{6}, /);
  });

  it('errors on an unknown politician', async () => {
    const res: any = await h.client.callTool({ name: 'get_politician_profile', arguments: { politician: 'Zzzznonexistentname' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('unknown politician');
  });
});

describe('get_congress_flow', () => {
  it('summarizes the last 90 days', async () => {
    const res: any = await h.client.callTool({ name: 'get_congress_flow', arguments: { window: '90d', limit: 5 } });
    expect(res.isError ?? false).toBe(false);
    const out = text(res);
    expect(out).toContain('window: 90d (by publication date)');
    expect(out).toMatch(/^trades: \d+/m);
    expect(out).toMatch(/^politicians: \d+/m);
    expect(out).toContain('# top bought (net)');
    expect(out).toContain('# top sold (net)');
    expect(out).toContain('# sectors');
  });
});

describe('get_security_snapshot congress lines', () => {
  it('shows congress lines for NVDA before metricsAsOf, or none at all', async () => {
    const res: any = await h.client.callTool({ name: 'get_security_snapshot', arguments: { identifier: 'NVDA' } });
    expect(res.isError ?? false).toBe(false);
    const out = text(res);
    if (out.includes('congressTrades90d')) {
      expect(out).toMatch(/congressTrades90d: \d+ \(\d+ buys, \d+ sells, \d+ politicians\)/);
      expect(out).toMatch(/congressNet90d: /);
      expect(out).toMatch(/congressLastTrade: \d{4}-\d{2}-\d{2} /);
      if (out.includes('metricsAsOf')) expect(out.indexOf('congressTrades90d')).toBeLessThan(out.indexOf('metricsAsOf'));
    } else {
      expect(out).not.toContain('congress');
    }
  });
});
