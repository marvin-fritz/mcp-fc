import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import pino from 'pino';
import { loadConfig } from '../../src/config.js';
import { closeMongo, getDb } from '../../src/db/client.js';
import { buildApp } from '../../src/server.js';

let httpServer: Server;
let baseUrl: string;

beforeAll(async () => {
  const config = loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'false', MCP_API_KEYS: 'e2e:testkey123=read' });
  const db = await getDb(config);
  const app = buildApp(config, { db, log: pino({ level: 'silent' }) });
  httpServer = app.listen(0);
  baseUrl = `http://127.0.0.1:${(httpServer.address() as AddressInfo).port}`;
});

afterAll(async () => {
  httpServer.close();
  await closeMongo();
});

describe('HTTP server', () => {
  it('healthz is public and reports db up', async () => {
    const res = await fetch(`${baseUrl}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, db: 'up' });
  });

  it('rejects /mcp without key', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }),
    });
    expect(res.status).toBe(401);
  });

  it('rejects GET /mcp (stateless, POST only)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, { headers: { authorization: 'Bearer testkey123' } });
    expect(res.status).toBe(405);
  });

  it('completes an MCP handshake with a valid key', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer testkey123' } },
    });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    await expect(client.ping()).resolves.toBeDefined();
    await client.close();
  });
});
