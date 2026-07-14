import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import type { AuthContext } from './auth/apiKey.js';
import { allFeatures } from './features/index.js';
import { ToolError, type FeatureModule } from './features/types.js';

export interface Deps {
  db: Db;
  log: Logger;
}

const errResult = (msg: string) => ({
  content: [{ type: 'text' as const, text: `ERROR: ${msg}` }],
  isError: true,
});

/** Build a per-request MCP server with all feature tools, enforcing key scopes. */
export function createMcpServer(deps: Deps, auth: AuthContext, features: FeatureModule[] = allFeatures): McpServer {
  const server = new McpServer({ name: 'mcp-fc', version: '0.1.0' });
  for (const feature of features) {
    for (const tool of feature.tools) {
      server.registerTool(
        tool.name,
        {
          title: tool.title,
          description: tool.description,
          inputSchema: tool.inputSchema,
          annotations: tool.annotations,
        },
        async (input: any) => {
          if (!auth.scopes.has(tool.requiredScope)) {
            return errResult(`key '${auth.keyName}' lacks scope '${tool.requiredScope}' required by ${tool.name}`);
          }
          const start = Date.now();
          try {
            const text = await tool.handler(input, { db: deps.db, auth, log: deps.log });
            deps.log.info({ tool: tool.name, key: auth.keyName, ms: Date.now() - start }, 'tool ok');
            return { content: [{ type: 'text' as const, text }] };
          } catch (e) {
            if (e instanceof ToolError) {
              deps.log.warn({ tool: tool.name, key: auth.keyName, ms: Date.now() - start, err: e.message }, 'tool error');
              return errResult(e.message);
            }
            deps.log.error({ tool: tool.name, key: auth.keyName, err: e }, 'tool failed');
            return errResult('internal error — retry or narrow the query');
          }
        },
      );
    }
  }
  return server;
}
