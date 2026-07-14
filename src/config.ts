export type Scope = 'read' | 'write';

export interface ApiKeyDef {
  name: string;
  key: string;
  scopes: Set<Scope>;
}

export interface Config {
  port: number;
  mongoUri: string;
  mongoDb: string;
  authDisabled: boolean;
  logLevel: string;
  apiKeys: ApiKeyDef[];
}

const VALID_SCOPES: ReadonlySet<string> = new Set(['read', 'write']);

export function parseApiKeys(raw: string): ApiKeyDef[] {
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((entry) => {
      const m = entry.match(/^([^:=\s]+):([^=\s]+)=(.+)$/);
      if (!m) throw new Error(`invalid MCP_API_KEYS entry (expected name:key=scope+scope): ${entry.slice(0, 24)}`);
      const scopes = m[3].split('+').map((s) => s.trim());
      for (const sc of scopes) {
        if (!VALID_SCOPES.has(sc)) throw new Error(`invalid scope '${sc}' in MCP_API_KEYS (allowed: read, write)`);
      }
      return { name: m[1], key: m[2], scopes: new Set(scopes as Scope[]) };
    });
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const authDisabled = env.MCP_AUTH_DISABLED === 'true';
  const apiKeys = parseApiKeys(env.MCP_API_KEYS ?? '');
  if (!authDisabled && apiKeys.length === 0) {
    throw new Error('MCP_API_KEYS is required unless MCP_AUTH_DISABLED=true');
  }
  return {
    port: Number(env.MCP_PORT ?? 8814),
    mongoUri: env.MONGODB_URI ?? 'mongodb://127.0.0.1:27017',
    mongoDb: env.MONGODB_DB ?? 'financecentre',
    authDisabled,
    logLevel: env.LOG_LEVEL ?? 'info',
    apiKeys,
  };
}
