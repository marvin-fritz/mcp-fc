import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHash, randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import type { Db } from 'mongodb';
import bcrypt from 'bcryptjs';
import pino from 'pino';
import { loadConfig } from '../../src/config.js';
import { closeMongo, connectMongo, getDb } from '../../src/db/client.js';
import { buildApp } from '../../src/server.js';

const TEST_EMAIL = 'test.oauth@mcp-fc.local';
const TEST_PW = 's3cret-test-pw';
const LOCKED_EMAIL = 'locked.oauth@mcp-fc.local';
const REDIRECT = 'http://127.0.0.1:59999/callback';
const AUTH_DB = 'mcp-fc-test-flow';

const verifier = randomBytes(32).toString('hex');
const challenge = createHash('sha256').update(verifier).digest('base64url');

let httpServer: Server;
let baseUrl: string;
let usersDb: Db;
let clientId: string;

const form = (data: Record<string, string>) => new URLSearchParams(data).toString();

beforeAll(async () => {
  const config = loadConfig({
    ...process.env,
    MCP_AUTH_DISABLED: 'false',
    MCP_API_KEYS: 'e2e:testkey123=read',
    MCP_JWT_SECRET: 'flow-test-secret',
    MCP_PUBLIC_URL: 'http://localhost',
    MONGODB_AUTH_DB: AUTH_DB,
  });
  const client = await connectMongo(config);
  usersDb = await getDb(config);
  await usersDb.collection('users').deleteMany({ email: { $in: [TEST_EMAIL, LOCKED_EMAIL] } });
  await client.db(AUTH_DB).dropDatabase();
  const hash = await bcrypt.hash(TEST_PW, 10);
  await usersDb.collection('users').insertOne({
    email: TEST_EMAIL, name: 'OAuth Test', password: hash,
    isActive: true, isLocked: false, role: 'admin', createdAt: new Date(), updatedAt: new Date(),
  });
  await usersDb.collection('users').insertOne({
    email: LOCKED_EMAIL, name: 'Locked Test', password: hash,
    isActive: true, isLocked: true, role: 'member', createdAt: new Date(), updatedAt: new Date(),
  });
  const app = buildApp(config, { db: usersDb, log: pino({ level: 'silent' }) }, client.db(AUTH_DB));
  httpServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  httpServer?.close();
  await usersDb?.collection('users').deleteMany({ email: { $in: [TEST_EMAIL, LOCKED_EMAIL] } });
  const config = loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' });
  await (await connectMongo(config)).db(AUTH_DB).dropDatabase();
  await closeMongo();
});

describe('discovery & registration', () => {
  it('serves AS metadata', async () => {
    const res = await fetch(`${baseUrl}/.well-known/oauth-authorization-server`);
    expect(res.status).toBe(200);
    const meta: any = await res.json();
    expect(meta.issuer.replace(/\/$/, '')).toBe('http://localhost');
    expect(meta.token_endpoint).toContain('/token');
    expect(meta.registration_endpoint).toContain('/register');
  });

  it('401 on /mcp advertises resource metadata', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    expect(res.headers.get('www-authenticate')).toContain('resource_metadata=');
  });

  it('registers a client dynamically', async () => {
    const res = await fetch(`${baseUrl}/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        redirect_uris: [REDIRECT], client_name: 'Flow Test',
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'],
      }),
    });
    expect(res.status).toBe(201);
    const body: any = await res.json();
    clientId = body.client_id;
    expect(clientId).toBeTruthy();
  });
});

describe('authorization code flow', () => {
  let code: string;
  let accessToken: string;
  let refreshToken: string;

  it('GET /authorize renders the login page', async () => {
    const url = `${baseUrl}/authorize?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(REDIRECT)}&code_challenge=${challenge}&code_challenge_method=S256&state=xyz&scope=read`;
    const res = await fetch(url);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('action="/oauth/login"');
    expect(html).toContain('Flow Test');
  });

  it('rejects wrong password with error page (no redirect)', async () => {
    const res = await fetch(`${baseUrl}/oauth/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state: 'xyz', scope: 'read', email: TEST_EMAIL, password: 'wrong' }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('falsch');
  });

  it('rejects locked user', async () => {
    const res = await fetch(`${baseUrl}/oauth/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, scope: 'read', email: LOCKED_EMAIL, password: TEST_PW }),
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('gesperrt');
  });

  it('valid login redirects with code and state', async () => {
    const res = await fetch(`${baseUrl}/oauth/login`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, state: 'xyz', scope: 'read', email: TEST_EMAIL, password: TEST_PW }),
    });
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe(REDIRECT);
    expect(loc.searchParams.get('state')).toBe('xyz');
    code = loc.searchParams.get('code')!;
    expect(code).toMatch(/^[a-f0-9]{64}$/);
  });

  it('rejects token exchange with wrong PKCE verifier', async () => {
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code, code_verifier: 'wrong-verifier-wrong-verifier-wrong-verifier', client_id: clientId, redirect_uri: REDIRECT }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('exchanges code for tokens (admin → read+write)', async () => {
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.token_type).toBe('bearer');
    expect(body.scope).toBe('read write');
    accessToken = body.access_token;
    refreshToken = body.refresh_token;
  });

  it('rejects code reuse', async () => {
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'authorization_code', code, code_verifier: verifier, client_id: clientId, redirect_uri: REDIRECT }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
  });

  it('JWT works on /mcp (tools/list)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.result.tools.length).toBeGreaterThanOrEqual(11);
  });

  it('rotates refresh tokens and invalidates the old one', async () => {
    const res = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    expect(res.status).toBe(200);
    const body: any = await res.json();
    expect(body.access_token).toBeTruthy();
    const reuse = await fetch(`${baseUrl}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId }),
    });
    expect(reuse.status).toBeGreaterThanOrEqual(400);
  });

  it('API key auth still works alongside OAuth', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', authorization: 'Bearer testkey123' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
  });
});
