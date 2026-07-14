import { describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Db } from 'mongodb';
import pino from 'pino';
import { z } from 'zod';
import { createMcpServer } from '../../src/mcp.js';
import { ToolError, type FeatureModule } from '../../src/features/types.js';

const fake: FeatureModule = {
  name: 'fake',
  tools: [
    {
      name: 'echo',
      title: 'Echo',
      description: 'echoes',
      inputSchema: { msg: z.string() },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input) => `echo:${input.msg}`,
    },
    {
      name: 'boom',
      title: 'Boom',
      description: 'throws',
      inputSchema: {},
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async () => {
        throw new ToolError('nothing found — try search_securities');
      },
    },
    {
      name: 'write_thing',
      title: 'Write',
      description: 'needs write scope',
      inputSchema: {},
      requiredScope: 'write',
      annotations: { readOnlyHint: false },
      handler: async () => 'wrote',
    },
  ],
};

async function connect(scopes: Array<'read' | 'write'>) {
  const server = createMcpServer(
    { db: {} as Db, log: pino({ level: 'silent' }) },
    { keyName: 'test', scopes: new Set(scopes) },
    [fake],
  );
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  const client = new Client({ name: 't', version: '0' });
  await client.connect(ct);
  return client;
}

describe('createMcpServer registry', () => {
  it('lists registered tools', async () => {
    const client = await connect(['read']);
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual(['boom', 'echo', 'write_thing']);
  });

  it('runs a handler and wraps result as text content', async () => {
    const client = await connect(['read']);
    const res: any = await client.callTool({ name: 'echo', arguments: { msg: 'hi' } });
    expect(res.content[0].text).toBe('echo:hi');
    expect(res.isError ?? false).toBe(false);
  });

  it('maps ToolError to isError text', async () => {
    const client = await connect(['read']);
    const res: any = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe('ERROR: nothing found — try search_securities');
  });

  it('denies tools whose scope the key lacks', async () => {
    const client = await connect(['read']);
    const res: any = await client.callTool({ name: 'write_thing', arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/scope 'write'/);
  });
});
