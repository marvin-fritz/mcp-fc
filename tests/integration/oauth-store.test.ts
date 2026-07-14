import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config.js';
import { closeMongo, connectMongo } from '../../src/db/client.js';
import { AuthStore } from '../../src/auth/oauth/store.js';
import type { Db } from 'mongodb';

let db: Db;
let store: AuthStore;

beforeAll(async () => {
  const config = loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' });
  db = (await connectMongo(config)).db('mcp-fc-test-store');
  store = new AuthStore(db);
  await store.ensureIndexes();
});

afterAll(async () => {
  await db.dropDatabase();
  await closeMongo();
});

describe('AuthStore clients (DCR)', () => {
  it('registers and retrieves a client', async () => {
    const client = await store.clients.registerClient!({
      redirect_uris: ['https://claude.ai/cb'],
      client_name: 'Test Client',
      token_endpoint_auth_method: 'none',
    } as any);
    expect(client.client_id).toMatch(/^[a-f0-9]{32}$/);
    const fetched = await store.clients.getClient(client.client_id);
    expect(fetched?.client_name).toBe('Test Client');
    expect(fetched?.redirect_uris).toEqual(['https://claude.ai/cb']);
  });

  it('returns undefined for unknown client', async () => {
    expect(await store.clients.getClient('nope')).toBeUndefined();
  });
});

describe('AuthStore codes', () => {
  it('creates, peeks and consumes a code exactly once', async () => {
    const code = await store.createCode({
      clientId: 'c1', userId: 'u1', email: 'a@b.de', scopes: ['read'],
      codeChallenge: 'ch', redirectUri: 'https://claude.ai/cb',
    });
    const peeked = await store.peekCode(code);
    expect(peeked?.codeChallenge).toBe('ch');
    const consumed = await store.consumeCode(code);
    expect(consumed?.userId).toBe('u1');
    expect(await store.consumeCode(code)).toBeNull();
    expect(await store.peekCode(code)).toBeNull();
  });
});

describe('AuthStore refresh tokens', () => {
  it('rotates: old token invalid after rotation, new one works', async () => {
    const t1 = await store.createRefreshToken({ clientId: 'c1', userId: 'u1', email: 'a@b.de', scopes: ['read'] });
    const r1 = await store.rotateRefreshToken(t1, 'c1');
    expect(r1?.doc.email).toBe('a@b.de');
    expect(await store.rotateRefreshToken(t1, 'c1')).toBeNull();
    const r2 = await store.rotateRefreshToken(r1!.next, 'c1');
    expect(r2).not.toBeNull();
  });

  it('rejects rotation for wrong client', async () => {
    const t = await store.createRefreshToken({ clientId: 'c1', userId: 'u1', email: 'a@b.de', scopes: ['read'] });
    expect(await store.rotateRefreshToken(t, 'other-client')).toBeNull();
  });
});
