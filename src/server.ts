import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import express from 'express';
import pino from 'pino';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadConfig, type Config } from './config.js';
import { makeAuthMiddleware, type AuthContext } from './auth/apiKey.js';
import { getDb } from './db/client.js';
import { createMcpServer, type Deps } from './mcp.js';

export function buildApp(config: Config, deps: Deps): express.Express {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '1mb' }));

  app.get('/healthz', async (_req, res) => {
    try {
      await deps.db.command({ ping: 1 });
      res.json({ ok: true, db: 'up' });
    } catch {
      res.status(503).json({ ok: false, db: 'down' });
    }
  });

  app.post('/mcp', makeAuthMiddleware(config), async (req, res) => {
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
  const db = await getDb(config);
  const app = buildApp(config, { db, log });
  app.listen(config.port, () => log.info(`mcp-fc listening on :${config.port}`));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
