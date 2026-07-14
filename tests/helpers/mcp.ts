import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import pino from 'pino';
import { loadConfig } from '../../src/config.js';
import { getDb } from '../../src/db/client.js';
import { createMcpServer } from '../../src/mcp.js';
import type { Scope } from '../../src/config.js';

/** MCP client wired to a real server instance over an in-memory transport, real local DB. */
export async function testClient(scopes: Scope[] = ['read']) {
  const config = loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' });
  const db = await getDb(config);
  const server = createMcpServer({ db, log: pino({ level: 'silent' }) }, { keyName: 'test', scopes: new Set(scopes) });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 'test', version: '0.0.0' });
  await client.connect(ct);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export function text(res: any): string {
  return res.content[0].text as string;
}
