import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import express from 'express';
import type { Db } from 'mongodb';
import pino from 'pino';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { loadConfig, type Config } from './config.js';
import type { AuthContext } from './auth/apiKey.js';
import { makeUnifiedAuthMiddleware } from './auth/unified.js';
import { McpOAuthProvider } from './auth/oauth/provider.js';
import { AuthStore } from './auth/oauth/store.js';
import { makeLoginRouter } from './auth/oauth/loginRoute.js';
import { connectMongo, getDb } from './db/client.js';
import { createMcpServer, type Deps } from './mcp.js';

export function buildApp(config: Config, deps: Deps, authDb?: Db): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 'loopback');
  app.use(express.json({ limit: '1mb' }));

  let provider: McpOAuthProvider | null = null;
  if (config.jwtSecret && authDb) {
    const store = new AuthStore(authDb);
    provider = new McpOAuthProvider({ store, jwtSecret: config.jwtSecret, issuer: config.publicUrl });
    app.use(
      mcpAuthRouter({
        provider,
        issuerUrl: new URL(config.publicUrl),
        scopesSupported: ['read', 'write'],
        resourceName: 'financecentre MCP',
      }),
    );
    app.use(makeLoginRouter({ store, usersDb: deps.db, log: deps.log }));
  }

  app.get('/healthz', async (_req, res) => {
    try {
      await deps.db.command({ ping: 1 });
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  app.post('/mcp', makeUnifiedAuthMiddleware(config, provider), async (req, res) => {
    // Stateless: fresh server + transport per request, no session ids.
    const server = createMcpServer(deps, res.locals.auth as AuthContext);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (e) {
      deps.log.error({ err: e }, 'mcp request failed');
      if (!res.headersSent) res.status(500).json({ error: 'internal error' });
    }
  });

  app.all('/mcp', (_req, res) => {
    res.status(405).json({ error: 'stateless server — POST only' });
  });

  return app;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const log = pino({ level: config.logLevel });
  const client = await connectMongo(config);
  const db = await getDb(config);
  let authDb: Db | undefined;
  if (config.jwtSecret) {
    authDb = client.db(config.mongoAuthDb);
    await new AuthStore(authDb).ensureIndexes();
    log.info({ issuer: config.publicUrl }, 'oauth enabled');
  }
  const app = buildApp(config, { db, log }, authDb);
  app.listen(config.port, () => log.info(`mcp-fc listening on :${config.port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
