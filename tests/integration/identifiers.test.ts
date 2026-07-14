import { afterAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { closeMongo, getDb } from '../../src/db/client.js';
import { resolveSecurity } from '../../src/db/identifiers.js';

const config = loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' });

afterAll(async () => {
  await closeMongo();
});

describe('resolveSecurity (real DB)', () => {
  it('resolves an ISIN', async () => {
    const db = await getDb(config);
    const ref = await resolveSecurity(db, 'DE0005773303');
    expect(ref?.isin).toBe('DE0005773303');
    expect(ref?.ticker).toBe('FRA');
  });

  it('resolves a ticker (case-insensitive) with cik', async () => {
    const db = await getDb(config);
    const ref = await resolveSecurity(db, 'aapl');
    expect(ref?.isin).toBe('US0378331005');
    expect(ref?.cik).toBe(320193);
  });

  it('resolves a name substring', async () => {
    const db = await getDb(config);
    const ref = await resolveSecurity(db, 'Fraport');
    expect(ref?.isin).toBe('DE0005773303');
  });

  it('returns null for garbage', async () => {
    const db = await getDb(config);
    expect(await resolveSecurity(db, 'zzz_no_such_thing_zzz')).toBeNull();
  });
});
