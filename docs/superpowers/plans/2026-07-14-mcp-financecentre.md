# mcp-fc Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** MCP server (Streamable HTTP, stateless) that serves finance data from the local MongoDB `financecentre` to AI agents via ~11 read-only, token-efficient domain tools.

**Architecture:** Express hosts a stateless `POST /mcp` endpoint; per request a fresh `McpServer` + `StreamableHTTPServerTransport` is created. Feature modules (securities, prices, financials, insider, funds, political, macro, news) each export a `FeatureModule` with `ToolDef`s registered by a central registry that enforces API-key scopes. A thin db layer (native `mongodb` driver, pooled singleton) and a `format` layer (pipe tables, key:value blocks, compact numbers) are shared by all features.

**Tech Stack:** TypeScript (strict, ESM, NodeNext), Node ≥ 20, `@modelcontextprotocol/sdk`, `express`, `mongodb`, `zod@^3`, `pino`, `dotenv`, `vitest`, `tsx`.

## Global Constraints

- Node ≥ 20, `"type": "module"`, TS `strict: true`, module/moduleResolution `NodeNext` (imports use `.js` extension).
- Spec: `docs/superpowers/specs/2026-07-14-mcp-financecentre-design.md`.
- Every MongoDB query: explicit projection, `maxTimeMS: 5000` (constant `MAX_TIME_MS` from `src/db/client.ts`).
- All v1 tools: `requiredScope: 'read'`, `annotations: { readOnlyHint: true }`.
- `limit` defaults 25 (search tools may state otherwise), hard caps per tool per spec table.
- Output: pipe tables without padding (`table()`), `key: value` blocks (`kv()`), dates `YYYY-MM-DD`, money columns named with unit e.g. `mcap(USDm)`, ratios/returns as `%` with 1 decimal.
- "More rows exist" is detected by fetching `limit + 1` docs (never `countDocuments`).
- Business errors: `throw new ToolError('<what> — <next step>')`. Registry converts to `isError` text `ERROR: ...`.
- Uniform security parameter: tools take `identifier` (ISIN, ticker, or name substring) resolved via `resolveSecurity` — deliberate improvement over the spec's `isin` param naming.
- Integration tests hit the real local DB read-only (`mongodb://127.0.0.1:27017/financecentre`) and must assert only on stable facts (e.g. Fraport = `DE0005773303`, AAPL exists, FRED series `CPIAUCSL` exists).
- Commits: conventional style (`feat: …`, `test: …`, `chore: …`) ending with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

## File Map

```
package.json, tsconfig.json, vitest.config.ts, .gitignore, .env.example
scripts/ensure-indexes.ts
deploy/mcp-fc.service, deploy/DEPLOY.md, README.md
src/
├── config.ts            # loadConfig, parseApiKeys, Scope, ApiKeyDef, Config
├── server.ts            # buildApp, main (dotenv only here)
├── mcp.ts               # createMcpServer (registry + scope check + logging)
├── auth/apiKey.ts       # authenticate, makeAuthMiddleware, AuthContext
├── db/client.ts         # connectMongo, getDb, closeMongo, MAX_TIME_MS
├── db/collections.ts    # cols(db)
├── db/identifiers.ts    # resolveSecurity, SecurityRef, ISIN_RE, escapeRegex
├── format/num.ts        # toNum, fmtNum, fmtMillions, fmtPct, fmtDate, fmtDateTime
├── format/kv.ts         # kv
├── format/table.ts      # table
└── features/
    ├── types.ts         # ToolDef, FeatureModule, ToolCtx, ToolError
    ├── index.ts         # allFeatures
    ├── securities/index.ts  # search_securities, get_security_snapshot, screen_stocks
    ├── prices/index.ts      # get_price_history
    ├── financials/index.ts  # get_financials
    ├── insider/index.ts     # get_insider_trades
    ├── funds/index.ts       # search_funds, get_fund_holdings
    ├── political/index.ts   # get_political_trades
    ├── macro/index.ts       # get_macro_series
    └── news/index.ts        # search_news
tests/
├── helpers/mcp.ts       # testClient(), text()
├── unit/{config,format,auth}.test.ts
├── integration/{securities,prices,financials,insider,funds,political,macro,news}.test.ts
└── e2e/server.test.ts
```

---

### Task 1: Scaffold + config parsing

**Files:**
- Create: `package.json`, `tsconfig.json`, `vitest.config.ts`, `.gitignore`, `.env.example`, `src/config.ts`
- Test: `tests/unit/config.test.ts`

**Interfaces:**
- Produces: `type Scope = 'read' | 'write'`; `interface ApiKeyDef { name: string; key: string; scopes: Set<Scope> }`; `interface Config { port: number; mongoUri: string; mongoDb: string; authDisabled: boolean; logLevel: string; apiKeys: ApiKeyDef[] }`; `parseApiKeys(raw: string): ApiKeyDef[]`; `loadConfig(env?: NodeJS.ProcessEnv): Config`.

- [ ] **Step 1: Scaffold project**

```bash
cd /Users/marvinfritz/Documents/Projekte/mcp-fc
npm init -y
npm i @modelcontextprotocol/sdk express mongodb zod@^3 pino dotenv
npm i -D typescript vitest tsx @types/express @types/node
```

Then edit `package.json` — set these fields (keep generated deps):

```json
{
  "name": "mcp-fc",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "engines": { "node": ">=20" },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "start": "node dist/server.js",
    "dev": "tsx src/server.ts",
    "test": "vitest run",
    "ensure-indexes": "tsx scripts/ensure-indexes.ts"
  }
}
```

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src",
    "sourceMap": true
  },
  "include": ["src"]
}
```

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
```

Create `.gitignore`:

```
node_modules/
dist/
.env
*.log
```

Create `.env.example`:

```
MCP_PORT=8814
MONGODB_URI=mongodb://127.0.0.1:27017
MONGODB_DB=financecentre
# comma-separated: <keyName>:<key>=<scope>[+<scope>]   scopes: read, write
MCP_API_KEYS=agent1:CHANGE_ME_LONG_RANDOM=read
MCP_AUTH_DISABLED=false
LOG_LEVEL=info
```

- [ ] **Step 2: Write the failing test**

`tests/unit/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { loadConfig, parseApiKeys } from '../../src/config.js';

describe('parseApiKeys', () => {
  it('parses names, keys and scopes', () => {
    const keys = parseApiKeys('agent1:sk_abc=read+write, agent2:sk_def=read');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({ name: 'agent1', key: 'sk_abc' });
    expect(keys[0].scopes.has('write')).toBe(true);
    expect(keys[1].scopes.has('write')).toBe(false);
    expect(keys[1].scopes.has('read')).toBe(true);
  });

  it('rejects malformed entries and unknown scopes', () => {
    expect(() => parseApiKeys('no-separator')).toThrow(/invalid/i);
    expect(() => parseApiKeys('a:k=admin')).toThrow(/scope/i);
  });
});

describe('loadConfig', () => {
  it('applies defaults and parses env', () => {
    const c = loadConfig({ MCP_API_KEYS: 'a:k=read' });
    expect(c.port).toBe(8814);
    expect(c.mongoUri).toBe('mongodb://127.0.0.1:27017');
    expect(c.mongoDb).toBe('financecentre');
    expect(c.authDisabled).toBe(false);
    expect(c.apiKeys).toHaveLength(1);
  });

  it('requires keys unless auth is disabled', () => {
    expect(() => loadConfig({})).toThrow(/MCP_API_KEYS/);
    expect(loadConfig({ MCP_AUTH_DISABLED: 'true' }).authDisabled).toBe(true);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: FAIL — cannot resolve `src/config.js`.

- [ ] **Step 4: Implement `src/config.ts`**

```ts
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
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json vitest.config.ts .gitignore .env.example src/config.ts tests/unit/config.test.ts
git commit -m "feat: scaffold project and config parsing with scoped API keys"
```

---

### Task 2: Token-efficient format helpers

**Files:**
- Create: `src/format/num.ts`, `src/format/kv.ts`, `src/format/table.ts`
- Test: `tests/unit/format.test.ts`

**Interfaces:**
- Produces: `toNum(v: unknown): number | null`; `fmtNum(v: unknown, dec?: number): string`; `fmtMillions(v: unknown): string`; `fmtPct(v: unknown): string`; `fmtDate(v: unknown): string`; `fmtDateTime(v: unknown): string`; `kv(pairs: Array<[string, unknown]>): string`; `table(headers: string[], rows: Array<Array<string | number | null | undefined>>, meta?: { offset?: number; hasMore?: boolean }): string`.
- Consumes: nothing.

- [ ] **Step 1: Write the failing test**

`tests/unit/format.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateTime, fmtMillions, fmtNum, fmtPct, toNum } from '../../src/format/num.js';
import { kv } from '../../src/format/kv.js';
import { table } from '../../src/format/table.js';

describe('num', () => {
  it('toNum handles numbers, Decimal128-like and Long-like objects, null', () => {
    expect(toNum(82.68)).toBe(82.68);
    expect(toNum({ toString: () => '82.6800' } as unknown)).toBe(82.68);
    expect(toNum(null)).toBeNull();
    expect(toNum(undefined)).toBeNull();
    expect(toNum('abc')).toBeNull();
  });

  it('fmtNum trims trailing zeros, caps decimals', () => {
    expect(fmtNum(82.68)).toBe('82.68');
    expect(fmtNum({ toString: () => '82.6800' })).toBe('82.68');
    expect(fmtNum(1234.5678)).toBe('1234.57');
    expect(fmtNum(null)).toBe('');
  });

  it('fmtMillions converts raw units to millions with 1 decimal', () => {
    expect(fmtMillions(416_161_000_000)).toBe('416161');
    expect(fmtMillions(8_123_456_789)).toBe('8123.5');
    expect(fmtMillions(null)).toBe('');
  });

  it('fmtPct renders ratio as percent with 1 decimal', () => {
    expect(fmtPct(0.469052)).toBe('46.9%');
    expect(fmtPct(0.003831)).toBe('0.4%');
    expect(fmtPct(null)).toBe('');
  });

  it('fmtDate/fmtDateTime', () => {
    expect(fmtDate(new Date('2026-07-11T17:35:00Z'))).toBe('2026-07-11');
    expect(fmtDate('2025-09-27')).toBe('2025-09-27');
    expect(fmtDate('1996-12')).toBe('1996-12');
    expect(fmtDateTime(new Date('2026-07-11T17:35:00Z'))).toBe('2026-07-11 17:35');
  });
});

describe('kv', () => {
  it('renders key: value lines and skips empty values', () => {
    expect(kv([['name', 'Fraport'], ['x', null], ['y', ''], ['isin', 'DE0005773303']]))
      .toBe('name: Fraport\nisin: DE0005773303');
  });
});

describe('table', () => {
  it('renders header and pipe rows without padding', () => {
    expect(table(['a', 'b'], [['1', 'x'], [2, null]])).toBe('a|b\n1|x\n2|');
  });

  it('renders 0 rows marker', () => {
    expect(table(['a'], [])).toBe('# 0 rows');
  });

  it('adds truncation meta when more rows exist', () => {
    const out = table(['a'], [['1'], ['2']], { offset: 0, hasMore: true });
    expect(out.startsWith('# rows 1-2, more available — refine filters or use offset=2\n')).toBe(true);
  });

  it('adds offset meta when offset > 0', () => {
    const out = table(['a'], [['3']], { offset: 2, hasMore: false });
    expect(out.startsWith('# rows 3-3\n')).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/format.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/format/num.ts`:

```ts
export function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') {
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Compact number: ≤`dec` decimals (default 4), ≤2 decimals for |n| ≥ 1000, no trailing zeros. */
export function fmtNum(v: unknown, dec = 4): string {
  const n = toNum(v);
  if (n === null) return '';
  return trimZeros(n.toFixed(Math.abs(n) >= 1000 ? Math.min(dec, 2) : dec));
}

/** Raw currency units → millions, 1 decimal. */
export function fmtMillions(v: unknown): string {
  const n = toNum(v);
  if (n === null) return '';
  return trimZeros((n / 1e6).toFixed(1));
}

/** Ratio (0.469) → '46.9%'. */
export function fmtPct(v: unknown): string {
  const n = toNum(v);
  if (n === null) return '';
  return `${trimZeros((n * 100).toFixed(1))}%`;
}

export function fmtDate(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export function fmtDateTime(v: unknown): string {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
```

`src/format/kv.ts`:

```ts
/** key: value lines; entries with null/undefined/'' values are omitted. */
export function kv(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}
```

`src/format/table.ts`:

```ts
export interface TableMeta {
  offset?: number;
  hasMore?: boolean;
}

/** Pipe-separated table without padding. First line = headers. */
export function table(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
  meta?: TableMeta,
): string {
  if (rows.length === 0) return '# 0 rows';
  const lines: string[] = [];
  const offset = meta?.offset ?? 0;
  if (meta?.hasMore) {
    lines.push(`# rows ${offset + 1}-${offset + rows.length}, more available — refine filters or use offset=${offset + rows.length}`);
  } else if (offset > 0) {
    lines.push(`# rows ${offset + 1}-${offset + rows.length}`);
  }
  lines.push(headers.join('|'));
  for (const r of rows) {
    lines.push(r.map((c) => (c == null ? '' : String(c))).join('|'));
  }
  return lines.join('\n');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/format.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/format tests/unit/format.test.ts
git commit -m "feat: token-efficient format helpers (tables, kv, numbers)"
```

---

### Task 3: API-key auth with scopes

**Files:**
- Create: `src/auth/apiKey.ts`
- Test: `tests/unit/auth.test.ts`

**Interfaces:**
- Consumes: `ApiKeyDef`, `Config`, `Scope` from `src/config.ts`.
- Produces: `interface AuthContext { keyName: string; scopes: Set<Scope> }`; `authenticate(header: string | undefined, keys: ApiKeyDef[]): AuthContext | null`; `makeAuthMiddleware(config: Config): RequestHandler` (sets `res.locals.auth`, sends 401 JSON otherwise; when `config.authDisabled` sets `{ keyName: 'dev', scopes: read+write }`).

- [ ] **Step 1: Write the failing test**

`tests/unit/auth.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { authenticate } from '../../src/auth/apiKey.js';
import type { ApiKeyDef } from '../../src/config.js';

const keys: ApiKeyDef[] = [
  { name: 'agent1', key: 'sk_abc123', scopes: new Set(['read']) },
  { name: 'agent2', key: 'sk_def456', scopes: new Set(['read', 'write']) },
];

describe('authenticate', () => {
  it('accepts a valid bearer key and returns its context', () => {
    const ctx = authenticate('Bearer sk_def456', keys);
    expect(ctx?.keyName).toBe('agent2');
    expect(ctx?.scopes.has('write')).toBe(true);
  });

  it('rejects missing header, wrong scheme, unknown key', () => {
    expect(authenticate(undefined, keys)).toBeNull();
    expect(authenticate('Basic sk_abc123', keys)).toBeNull();
    expect(authenticate('Bearer nope', keys)).toBeNull();
    expect(authenticate('Bearer sk_abc12', keys)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/auth.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/auth/apiKey.ts`**

```ts
import { createHash, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { ApiKeyDef, Config, Scope } from '../config.js';

export interface AuthContext {
  keyName: string;
  scopes: Set<Scope>;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

export function authenticate(header: string | undefined, keys: ApiKeyDef[]): AuthContext | null {
  if (!header?.startsWith('Bearer ')) return null;
  const presented = sha256(header.slice('Bearer '.length).trim());
  for (const k of keys) {
    if (timingSafeEqual(presented, sha256(k.key))) {
      return { keyName: k.name, scopes: k.scopes };
    }
  }
  return null;
}

export function makeAuthMiddleware(config: Config): RequestHandler {
  return (req, res, next) => {
    if (config.authDisabled) {
      res.locals.auth = { keyName: 'dev', scopes: new Set<Scope>(['read', 'write']) } satisfies AuthContext;
      next();
      return;
    }
    const auth = authenticate(req.headers.authorization, config.apiKeys);
    if (!auth) {
      res.status(401).json({ error: 'unauthorized' });
      return;
    }
    res.locals.auth = auth;
    next();
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/auth.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/auth tests/unit/auth.test.ts
git commit -m "feat: bearer API-key auth with timing-safe compare and scopes"
```

---

### Task 4: DB layer (client, collections, identifier resolution)

**Files:**
- Create: `src/db/client.ts`, `src/db/collections.ts`, `src/db/identifiers.ts`
- Test: `tests/integration/identifiers.test.ts`

**Interfaces:**
- Consumes: `Config` from `src/config.ts`.
- Produces:
  - `MAX_TIME_MS = 5000`; `connectMongo(config: Config): Promise<MongoClient>`; `getDb(config: Config): Promise<Db>`; `closeMongo(): Promise<void>`.
  - `cols(db: Db)` returning `{ stockIndex, stockPrices, stockMetrics, secFinancials, insiderTrades, f13Filings, funds, politicalFilings, fred, economicIndicators, news }` (each `Collection<Document>`).
  - `interface SecurityRef { isin: string; ticker: string | null; name: string; cik: number | null }`; `resolveSecurity(db: Db, identifier: string): Promise<SecurityRef | null>`; `ISIN_RE: RegExp`; `escapeRegex(s: string): string`.

- [ ] **Step 1: Write the failing test**

`tests/integration/identifiers.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/identifiers.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/db/client.ts`:

```ts
import { Db, MongoClient } from 'mongodb';
import type { Config } from '../config.js';

/** Hard budget for every query/aggregation. */
export const MAX_TIME_MS = 5000;

let client: MongoClient | null = null;

export async function connectMongo(config: Config): Promise<MongoClient> {
  if (!client) {
    client = new MongoClient(config.mongoUri, { maxPoolSize: 10 });
    await client.connect();
  }
  return client;
}

export async function getDb(config: Config): Promise<Db> {
  return (await connectMongo(config)).db(config.mongoDb);
}

export async function closeMongo(): Promise<void> {
  await client?.close();
  client = null;
}
```

`src/db/collections.ts`:

```ts
import type { Db } from 'mongodb';

/** Whitelisted collections. Internal collections (users, chats, stats, …) are never exposed. */
export function cols(db: Db) {
  return {
    stockIndex: db.collection('stockIndex'),
    stockPrices: db.collection('stockPrices'),
    stockMetrics: db.collection('stockMetrics'),
    secFinancials: db.collection('secFinancials'),
    insiderTrades: db.collection('insiderTrades'),
    f13Filings: db.collection('f13Filings'),
    funds: db.collection('funds'),
    politicalFilings: db.collection('politicalFilings'),
    fred: db.collection('fred'),
    economicIndicators: db.collection('economicIndicators'),
    news: db.collection('news'),
  };
}
```

`src/db/identifiers.ts`:

```ts
import type { Db, Document } from 'mongodb';
import { MAX_TIME_MS } from './client.js';
import { cols } from './collections.js';

export interface SecurityRef {
  isin: string;
  ticker: string | null;
  name: string;
  cik: number | null;
}

export const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PROJECTION = { projection: { isin: 1, ticker: 1, name: 1, 'identifiers.cik': 1 }, maxTimeMS: MAX_TIME_MS };

/** Resolve ISIN, ticker or name substring to a security via stockIndex. */
export async function resolveSecurity(db: Db, identifier: string): Promise<SecurityRef | null> {
  const c = cols(db).stockIndex;
  const id = identifier.trim();
  const upper = id.toUpperCase();
  let doc: Document | null = null;
  if (ISIN_RE.test(upper)) doc = await c.findOne({ isin: upper }, PROJECTION);
  if (!doc) doc = await c.findOne({ ticker: upper }, PROJECTION);
  if (!doc) doc = await c.findOne({ name: { $regex: escapeRegex(id), $options: 'i' } }, PROJECTION);
  if (!doc) return null;
  return {
    isin: doc.isin,
    ticker: doc.ticker ?? null,
    name: doc.name,
    cik: doc.identifiers?.cik ?? null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/identifiers.test.ts`
Expected: PASS (4 tests, requires local mongod).

- [ ] **Step 5: Commit**

```bash
git add src/db tests/integration/identifiers.test.ts
git commit -m "feat: mongo client singleton, collection whitelist, security resolution"
```

---

### Task 5: Feature contract, registry, MCP server factory

**Files:**
- Create: `src/features/types.ts`, `src/features/index.ts`, `src/mcp.ts`
- Test: `tests/unit/mcp.test.ts` (uses a fake feature; no DB needed — pass a dummy `db`)

**Interfaces:**
- Consumes: `Scope` from `src/config.ts`, `AuthContext` from `src/auth/apiKey.ts`.
- Produces:
  - `interface ToolCtx { db: Db; auth: AuthContext; log: Logger }`
  - `interface ToolDef { name: string; title: string; description: string; inputSchema: ZodRawShape; requiredScope: Scope; annotations: { readOnlyHint: boolean; destructiveHint?: boolean }; handler(input: any, ctx: ToolCtx): Promise<string> }`
  - `interface FeatureModule { name: string; tools: ToolDef[] }`
  - `class ToolError extends Error {}`
  - `allFeatures: FeatureModule[]` (empty for now; features append themselves in later tasks)
  - `interface Deps { db: Db; log: Logger }`; `createMcpServer(deps: Deps, auth: AuthContext, features?: FeatureModule[]): McpServer`

- [ ] **Step 1: Write the failing test**

`tests/unit/mcp.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/mcp.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement**

`src/features/types.ts`:

```ts
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import type { ZodRawShape } from 'zod';
import type { Scope } from '../config.js';
import type { AuthContext } from '../auth/apiKey.js';

export interface ToolCtx {
  db: Db;
  auth: AuthContext;
  log: Logger;
}

export interface ToolDef {
  name: string;
  title: string;
  /** Include units and one example call — agents rely on this. */
  description: string;
  inputSchema: ZodRawShape;
  requiredScope: Scope;
  annotations: { readOnlyHint: boolean; destructiveHint?: boolean };
  handler(input: any, ctx: ToolCtx): Promise<string>;
}

export interface FeatureModule {
  name: string;
  tools: ToolDef[];
}

/** Business error whose message is shown verbatim to the agent (prefixed with ERROR:). */
export class ToolError extends Error {}
```

`src/features/index.ts`:

```ts
import type { FeatureModule } from './types.js';

/** All registered feature modules. Add new features here. */
export const allFeatures: FeatureModule[] = [];
```

`src/mcp.ts`:

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/mcp.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features src/mcp.ts tests/unit/mcp.test.ts
git commit -m "feat: feature-module contract and scope-enforcing MCP server factory"
```

---

### Task 6: HTTP server (stateless Streamable HTTP) + healthz + E2E

**Files:**
- Create: `src/server.ts`, `tests/helpers/mcp.ts`
- Test: `tests/e2e/server.test.ts`

**Interfaces:**
- Consumes: `loadConfig`, `makeAuthMiddleware`, `getDb`, `createMcpServer`, `Deps`, `AuthContext`.
- Produces: `buildApp(config: Config, deps: Deps): express.Express`; test helper `testClient(scopes?): Promise<{ client: Client; close(): Promise<void> }>` and `text(res: any): string`.

- [ ] **Step 1: Write the failing test**

`tests/helpers/mcp.ts` (shared by all later integration tests):

```ts
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
```

`tests/e2e/server.test.ts`:

```ts
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

  it('serves MCP tool listing with a valid key', async () => {
    const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
      requestInit: { headers: { authorization: 'Bearer testkey123' } },
    });
    const client = new Client({ name: 'e2e', version: '0' });
    await client.connect(transport);
    const tools = await client.listTools();
    expect(Array.isArray(tools.tools)).toBe(true);
    await client.close();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/e2e/server.test.ts`
Expected: FAIL — `src/server.js` not found.

- [ ] **Step 3: Implement `src/server.ts`**

```ts
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
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/e2e/server.test.ts`
Expected: PASS (4 tests). Note: `tools` list is empty at this point — the test only checks it is an array.

- [ ] **Step 5: Commit**

```bash
git add src/server.ts tests/helpers/mcp.ts tests/e2e/server.test.ts
git commit -m "feat: stateless streamable-http endpoint with auth and healthz"
```

---

### Task 7: Securities feature (search, snapshot, screener)

**Files:**
- Create: `src/features/securities/index.ts`
- Modify: `src/features/index.ts` (register module)
- Test: `tests/integration/securities.test.ts`

**Interfaces:**
- Consumes: `cols`, `MAX_TIME_MS`, `resolveSecurity`, `ISIN_RE`, `escapeRegex`, `table`, `kv`, `fmtNum`, `fmtMillions`, `fmtPct`, `fmtDateTime`, `ToolError`, `FeatureModule`.
- Produces: `securitiesFeature: FeatureModule` with tools `search_securities`, `get_security_snapshot`, `screen_stocks`.

- [ ] **Step 1: Write the failing test**

`tests/integration/securities.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('search_securities', () => {
  it('finds Fraport by name with pipe-table output', async () => {
    const res: any = await h.client.callTool({ name: 'search_securities', arguments: { query: 'Fraport' } });
    const out = text(res);
    expect(out.split('\n')[0]).toBe('isin|ticker|name|sector|industryGroup|indices|exch');
    expect(out).toContain('DE0005773303');
  });

  it('finds by ticker', async () => {
    const res: any = await h.client.callTool({ name: 'search_securities', arguments: { query: 'AAPL' } });
    expect(text(res)).toContain('US0378331005');
  });

  it('returns 0 rows marker for no match', async () => {
    const res: any = await h.client.callTool({ name: 'search_securities', arguments: { query: 'zzz_nope_zzz' } });
    expect(text(res)).toBe('# 0 rows');
  });
});

describe('get_security_snapshot', () => {
  it('returns kv block with core fields', async () => {
    const res: any = await h.client.callTool({ name: 'get_security_snapshot', arguments: { identifier: 'DE0005773303' } });
    const out = text(res);
    expect(out).toContain('name: FRAPORT');
    expect(out).toContain('isin: DE0005773303');
    expect(out).toMatch(/lastPrice: [\d.]+ [A-Z]{3}/);
  });

  it('errors helpfully on unknown identifier', async () => {
    const res: any = await h.client.callTool({ name: 'get_security_snapshot', arguments: { identifier: 'zzz_nope' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/search_securities/);
  });
});

describe('screen_stocks', () => {
  it('screens by index sorted by marketCap desc', async () => {
    const res: any = await h.client.callTool({
      name: 'screen_stocks',
      arguments: { index: 'DAX', sortBy: 'marketCap', limit: 5 },
    });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('isin|ticker|name|sector|mcap(USDm)|r1D%|r1M%|r1Y%|rYTD%|52wPos');
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.length).toBeLessThanOrEqual(6);
  });

  it('caps limit at 100', async () => {
    const res: any = await h.client.callTool({ name: 'screen_stocks', arguments: { limit: 5000 } });
    const dataLines = text(res).split('\n').filter((l) => !l.startsWith('#')).length - 1;
    expect(dataLines).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/securities.test.ts`
Expected: FAIL — tools not found (`search_securities` unknown).

- [ ] **Step 3: Implement `src/features/securities/index.ts`**

```ts
import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { ISIN_RE, escapeRegex, resolveSecurity } from '../../db/identifiers.js';
import { kv } from '../../format/kv.js';
import { fmtDateTime, fmtMillions, fmtNum, fmtPct } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

const SORT_FIELDS: Record<string, string> = {
  marketCap: 'marketCap',
  return1D: 'metrics.return1D',
  return1M: 'metrics.return1M',
  return3M: 'metrics.return3M',
  return6M: 'metrics.return6M',
  return1Y: 'metrics.return1Y',
  returnYTD: 'metrics.returnYTD',
  rangePosition52w: 'metrics.rangePosition52w',
};

export const securitiesFeature: FeatureModule = {
  name: 'securities',
  tools: [
    {
      name: 'search_securities',
      title: 'Search securities',
      description:
        'Find stocks/securities by name substring, ticker or ISIN. Returns master data (isin, ticker, name, sector, industryGroup, index memberships, exchange). Example: {"query":"Fraport"}',
      inputSchema: {
        query: z.string().min(1).describe('name substring, ticker or ISIN'),
        limit: z.number().int().min(1).max(50).optional().describe('max rows, default 25'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 50);
        const q = String(input.query).trim();
        const upper = q.toUpperCase();
        const or: object[] = [{ name: { $regex: escapeRegex(q), $options: 'i' } }, { ticker: upper }];
        if (ISIN_RE.test(upper)) or.push({ isin: upper });
        const docs = await cols(db)
          .stockIndex.find(
            { $or: or },
            {
              projection: { isin: 1, ticker: 1, name: 1, 'classification.sector': 1, 'classification.industryGroup': 1, indices: 1, exchangeCode: 1 },
              limit: lim + 1,
              maxTimeMS: MAX_TIME_MS,
            },
          )
          .toArray();
        const hasMore = docs.length > lim;
        return table(
          ['isin', 'ticker', 'name', 'sector', 'industryGroup', 'indices', 'exch'],
          docs.slice(0, lim).map((d) => [
            d.isin,
            d.ticker,
            d.name,
            d.classification?.sector,
            d.classification?.industryGroup,
            (d.indices ?? []).join(','),
            d.exchangeCode,
          ]),
          { hasMore },
        );
      },
    },
    {
      name: 'get_security_snapshot',
      title: 'Security snapshot',
      description:
        'Compact profile of one security: master data, last trade price, marketCap (USD millions), returns (1D/1M/3M/6M/1Y/YTD in %), 52-week range position. identifier = ISIN, ticker or name. Example: {"identifier":"AAPL"}',
      inputSchema: {
        identifier: z.string().min(1).describe('ISIN, ticker or name'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const ref = await resolveSecurity(db, input.identifier);
        if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
        const c = cols(db);
        const [idx, met, last] = await Promise.all([
          c.stockIndex.findOne(
            { isin: ref.isin },
            { projection: { 'classification.sector': 1, 'classification.industryGroup': 1, indices: 1, exchangeCode: 1 }, maxTimeMS: MAX_TIME_MS },
          ),
          c.stockMetrics.findOne({ isin: ref.isin }, { projection: { metrics: 1, country: 1, marketCap: 1, dataAsOf: 1 }, maxTimeMS: MAX_TIME_MS }),
          c.stockPrices
            .find({ isin: ref.isin }, { projection: { price: 1, currency: 1, tradeTime: 1, source: 1 }, sort: { tradeTime: -1 }, limit: 1, maxTimeMS: MAX_TIME_MS })
            .toArray()
            .then((a) => a[0]),
        ]);
        const m = (met?.metrics ?? {}) as Record<string, unknown>;
        const rets = (
          [
            ['1D', 'return1D'],
            ['1M', 'return1M'],
            ['3M', 'return3M'],
            ['6M', 'return6M'],
            ['1Y', 'return1Y'],
            ['YTD', 'returnYTD'],
          ] as const
        )
          .map(([label, key]) => (m[key] == null ? null : `${label} ${fmtPct(m[key])}`))
          .filter(Boolean)
          .join(' | ');
        return kv([
          ['name', ref.name],
          ['isin', ref.isin],
          ['ticker', ref.ticker],
          ['exchange', idx?.exchangeCode],
          ['sector', idx?.classification?.sector],
          ['industryGroup', idx?.classification?.industryGroup],
          ['indices', (idx?.indices ?? []).join(',')],
          ['country', met?.country],
          ['marketCap(USDm)', fmtMillions(met?.marketCap)],
          ['lastPrice', last ? `${fmtNum(last.price)} ${last.currency} (${fmtDateTime(last.tradeTime)}, ${last.source})` : null],
          ['returns', rets || null],
          ['52wRangePos', m.rangePosition52w == null ? null : fmtPct(m.rangePosition52w)],
          ['metricsAsOf', met?.dataAsOf],
        ]);
      },
    },
    {
      name: 'screen_stocks',
      title: 'Screen stocks',
      description:
        'Screen/rank companies via computed metrics. Filters: sector, industryGroup, index (e.g. "DAX", "S&P 500"), country (ISO2), marketCapMinM/marketCapMaxM (USD millions). sortBy: marketCap|return1D|return1M|return3M|return6M|return1Y|returnYTD|rangePosition52w. Returns are %. Example: {"index":"DAX","sortBy":"return1Y","limit":10}',
      inputSchema: {
        sector: z.string().optional(),
        industryGroup: z.string().optional(),
        index: z.string().optional().describe('index membership, e.g. DAX'),
        country: z.string().length(2).optional(),
        marketCapMinM: z.number().optional().describe('min marketCap in USD millions'),
        marketCapMaxM: z.number().optional().describe('max marketCap in USD millions'),
        sortBy: z.enum(['marketCap', 'return1D', 'return1M', 'return3M', 'return6M', 'return1Y', 'returnYTD', 'rangePosition52w']).optional(),
        order: z.enum(['asc', 'desc']).optional().describe('default desc'),
        limit: z.number().int().min(1).optional().describe('default 25, max 100'),
        offset: z.number().int().min(0).optional(),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 100);
        const offset = input.offset ?? 0;
        const filter: Record<string, unknown> = {};
        if (input.sector) filter.sector = input.sector;
        if (input.industryGroup) filter.industryGroup = input.industryGroup;
        if (input.index) filter.indices = input.index;
        if (input.country) filter.country = input.country.toUpperCase();
        if (input.marketCapMinM != null || input.marketCapMaxM != null) {
          filter.marketCap = {
            ...(input.marketCapMinM != null ? { $gte: input.marketCapMinM * 1e6 } : {}),
            ...(input.marketCapMaxM != null ? { $lte: input.marketCapMaxM * 1e6 } : {}),
          };
        }
        const sortField = SORT_FIELDS[input.sortBy ?? 'marketCap'];
        const dir = input.order === 'asc' ? 1 : -1;
        const docs = await cols(db)
          .stockMetrics.find(filter, {
            projection: { isin: 1, ticker: 1, name: 1, sector: 1, marketCap: 1, metrics: 1 },
            sort: { [sortField]: dir },
            skip: offset,
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        return table(
          ['isin', 'ticker', 'name', 'sector', 'mcap(USDm)', 'r1D%', 'r1M%', 'r1Y%', 'rYTD%', '52wPos'],
          docs.slice(0, lim).map((d) => {
            const m = (d.metrics ?? {}) as Record<string, unknown>;
            return [
              d.isin,
              d.ticker,
              d.name,
              d.sector,
              fmtMillions(d.marketCap),
              fmtPct(m.return1D),
              fmtPct(m.return1M),
              fmtPct(m.return1Y),
              fmtPct(m.returnYTD),
              fmtPct(m.rangePosition52w),
            ];
          }),
          { offset, hasMore },
        );
      },
    },
  ],
};
```

Modify `src/features/index.ts`:

```ts
import type { FeatureModule } from './types.js';
import { securitiesFeature } from './securities/index.js';

/** All registered feature modules. Add new features here. */
export const allFeatures: FeatureModule[] = [securitiesFeature];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/securities.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features tests/integration/securities.test.ts
git commit -m "feat: securities feature (search, snapshot, screener)"
```

---

### Task 8: Prices feature (OHLC history)

**Files:**
- Create: `src/features/prices/index.ts`
- Modify: `src/features/index.ts` (add `pricesFeature`)
- Test: `tests/integration/prices.test.ts`

**Interfaces:**
- Consumes: same helpers as Task 7.
- Produces: `pricesFeature: FeatureModule` with tool `get_price_history`.

- [ ] **Step 1: Write the failing test**

`tests/integration/prices.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('get_price_history', () => {
  it('returns daily OHLC candles for the last 90 days by default', async () => {
    const res: any = await h.client.callTool({ name: 'get_price_history', arguments: { identifier: 'DE0005773303' } });
    const out = text(res);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^# DE0005773303 day OHLC, [A-Z]{3}$/);
    expect(lines[1]).toBe('date|open|high|low|close|volume');
    expect(lines.length).toBeGreaterThan(2);
    // candle rows are date|numbers
    expect(lines[2]).toMatch(/^\d{4}-\d{2}-\d{2}\|/);
  });

  it('rejects ranges that would exceed 400 candles', async () => {
    const res: any = await h.client.callTool({
      name: 'get_price_history',
      arguments: { identifier: 'DE0005773303', from: '2000-01-01', to: '2026-01-01', interval: 'day' },
    });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/coarser interval|shorter range/);
  });

  it('supports monthly aggregation over multi-year ranges', async () => {
    const res: any = await h.client.callTool({
      name: 'get_price_history',
      arguments: { identifier: 'Fraport', from: '2024-01-01', interval: 'month' },
    });
    const lines = text(res).split('\n');
    expect(lines[1]).toBe('date|open|high|low|close|volume');
    expect(lines.length).toBeGreaterThan(3);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/prices.test.ts`
Expected: FAIL — tool not found.

- [ ] **Step 3: Implement `src/features/prices/index.ts`**

```ts
import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { resolveSecurity } from '../../db/identifiers.js';
import { fmtDate, fmtNum } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

const MAX_CANDLES = 400;
const DAYS_PER_UNIT = { day: 1, week: 7, month: 30 } as const;

export const pricesFeature: FeatureModule = {
  name: 'prices',
  tools: [
    {
      name: 'get_price_history',
      title: 'Price history (OHLC)',
      description:
        'OHLC candles aggregated server-side from trade data. interval: day|week|month (default day). Default range: last 90 days. Max 400 candles — use coarser intervals for long ranges. Dates YYYY-MM-DD. Example: {"identifier":"AAPL","from":"2026-01-01","interval":"week"}',
      inputSchema: {
        identifier: z.string().min(1).describe('ISIN, ticker or name'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        interval: z.enum(['day', 'week', 'month']).optional(),
        source: z.string().optional().describe('restrict to one exchange feed, e.g. xetra, lsx'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const ref = await resolveSecurity(db, input.identifier);
        if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
        const interval = (input.interval ?? 'day') as keyof typeof DAYS_PER_UNIT;
        const to = input.to ? new Date(`${input.to}T23:59:59.999Z`) : new Date();
        const from = input.from ? new Date(`${input.from}T00:00:00Z`) : new Date(to.getTime() - 90 * 86_400_000);
        if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) {
          throw new ToolError('invalid from/to range — use YYYY-MM-DD with from < to');
        }
        const estimated = Math.ceil((to.getTime() - from.getTime()) / 86_400_000 / DAYS_PER_UNIT[interval]);
        if (estimated > MAX_CANDLES) {
          throw new ToolError(`~${estimated} candles exceeds ${MAX_CANDLES} — use a coarser interval or shorter range`);
        }
        const match: Record<string, unknown> = { isin: ref.isin, tradeTime: { $gte: from, $lte: to } };
        if (input.source) match.source = input.source;
        const candles = await cols(db)
          .stockPrices.aggregate(
            [
              { $match: match },
              { $sort: { tradeTime: 1 } },
              {
                $group: {
                  _id: { $dateTrunc: { date: '$tradeTime', unit: interval } },
                  open: { $first: '$price' },
                  high: { $max: '$price' },
                  low: { $min: '$price' },
                  close: { $last: '$price' },
                  volume: { $sum: { $ifNull: ['$size', 0] } },
                  ccy: { $first: '$currency' },
                },
              },
              { $sort: { _id: 1 } },
            ],
            { maxTimeMS: MAX_TIME_MS, allowDiskUse: false },
          )
          .toArray();
        if (candles.length === 0) return `# 0 rows — no trades for ${ref.isin} in range`;
        const body = table(
          ['date', 'open', 'high', 'low', 'close', 'volume'],
          candles.map((c) => [fmtDate(c._id), fmtNum(c.open), fmtNum(c.high), fmtNum(c.low), fmtNum(c.close), fmtNum(c.volume, 0)]),
        );
        return `# ${ref.isin} ${interval} OHLC, ${candles[0].ccy}\n${body}`;
      },
    },
  ],
};
```

Modify `src/features/index.ts` — add to list:

```ts
import type { FeatureModule } from './types.js';
import { securitiesFeature } from './securities/index.js';
import { pricesFeature } from './prices/index.js';

/** All registered feature modules. Add new features here. */
export const allFeatures: FeatureModule[] = [securitiesFeature, pricesFeature];
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/prices.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features tests/integration/prices.test.ts
git commit -m "feat: price history tool with server-side OHLC aggregation"
```

---

### Task 9: Financials feature (statement matrix)

**Files:**
- Create: `src/features/financials/index.ts`
- Modify: `src/features/index.ts` (add `financialsFeature`)
- Test: `tests/integration/financials.test.ts`

**Interfaces:**
- Consumes: same helpers; note `secFinancials` values are Int64 raw currency units (driver promotes to JS number), ratio keys are floats.
- Produces: `financialsFeature: FeatureModule` with tool `get_financials`.

- [ ] **Step 1: Write the failing test**

`tests/integration/financials.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('get_financials', () => {
  it('returns annual statement matrix for AAPL', async () => {
    const res: any = await h.client.callTool({ name: 'get_financials', arguments: { identifier: 'AAPL' } });
    const out = text(res);
    const lines = out.split('\n');
    expect(lines[0]).toMatch(/^# APPLE INC \(AAPL\) — annual, USD millions/);
    expect(lines[1]).toMatch(/^item\|FY\d{4}/);
    expect(out).toContain('## income');
    expect(out).toContain('## balance');
    expect(out).toContain('## cashflow');
    expect(out).toMatch(/\nrevenue\|\d/);
    // margins rendered as %
    expect(out).toMatch(/\ngrossMargin\|[\d.]+%/);
  });

  it('respects statements + periods params', async () => {
    const res: any = await h.client.callTool({
      name: 'get_financials',
      arguments: { identifier: 'AAPL', statements: ['income'], period: 'quarterly', periods: 2 },
    });
    const out = text(res);
    expect(out).toContain('## income');
    expect(out).not.toContain('## balance');
    // header row: item + exactly 2 period columns
    const header = out.split('\n').find((l) => l.startsWith('item|'))!;
    expect(header.split('|')).toHaveLength(3);
  });

  it('errors on identifiers without filings', async () => {
    const res: any = await h.client.callTool({ name: 'get_financials', arguments: { identifier: 'zzz_nope' } });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/financials.test.ts`
Expected: FAIL — tool not found.

- [ ] **Step 3: Implement `src/features/financials/index.ts`**

```ts
import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { resolveSecurity } from '../../db/identifiers.js';
import { fmtMillions, fmtPct, toNum } from '../../format/num.js';
import { ToolError, type FeatureModule } from '../types.js';

const STMT_KEYS = { income: 'incomeStatement', balance: 'balanceSheet', cashflow: 'cashFlow' } as const;
type StmtName = keyof typeof STMT_KEYS;
const RATIO_KEYS = new Set(['grossMargin', 'operatingMargin', 'netMargin', 'roe', 'roa']);

export const financialsFeature: FeatureModule = {
  name: 'financials',
  tools: [
    {
      name: 'get_financials',
      title: 'Financial statements',
      description:
        'Income statement / balance sheet / cash flow from SEC filings as a compact matrix: rows = line items (values in currency millions, ratios like grossMargin/roe in %), columns = periods, newest first. period: annual (10-K/FY) or quarterly. Example: {"identifier":"AAPL","statements":["income"],"periods":4}',
      inputSchema: {
        identifier: z.string().min(1).describe('ISIN, ticker or name'),
        statements: z.array(z.enum(['income', 'balance', 'cashflow'])).optional().describe('default: all three'),
        period: z.enum(['annual', 'quarterly']).optional().describe('default annual'),
        periods: z.number().int().min(1).max(12).optional().describe('number of periods, default 4'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const ref = await resolveSecurity(db, input.identifier);
        if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
        if (!ref.cik && !ref.ticker) throw new ToolError(`no SEC mapping for ${ref.isin}`);
        const period = input.period ?? 'annual';
        const n = Math.min(input.periods ?? 4, 12);
        const match: Record<string, unknown> = ref.cik ? { cik: ref.cik } : { ticker: ref.ticker };
        match.fiscalPeriod = period === 'annual' ? 'FY' : { $in: ['Q1', 'Q2', 'Q3', 'Q4'] };
        const docs = await cols(db)
          .secFinancials.find(match, {
            projection: { incomeStatement: 1, balanceSheet: 1, cashFlow: 1, fiscalYear: 1, fiscalPeriod: 1, periodEnd: 1, currency: 1, filedAt: 1 },
            sort: { periodEnd: -1, filedAt: -1 },
            limit: n * 3,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        // dedupe amended filings: keep newest filedAt per periodEnd
        const seen = new Set<string>();
        const periodDocs = [];
        for (const d of docs) {
          if (!seen.has(d.periodEnd)) {
            seen.add(d.periodEnd);
            periodDocs.push(d);
            if (periodDocs.length === n) break;
          }
        }
        if (periodDocs.length === 0) throw new ToolError(`no ${period} SEC filings for ${ref.ticker ?? ref.isin}`);
        const stmts = (input.statements ?? ['income', 'balance', 'cashflow']) as StmtName[];
        const label = (d: any) => (d.fiscalPeriod === 'FY' ? `FY${d.fiscalYear}` : `${d.fiscalPeriod}'${String(d.fiscalYear).slice(2)}`);
        const lines: string[] = [
          `# ${ref.name} (${ref.ticker ?? ref.isin}) — ${period}, ${periodDocs[0].currency} millions (ratios in %)`,
          ['item', ...periodDocs.map(label)].join('|'),
        ];
        for (const stmt of stmts) {
          const key = STMT_KEYS[stmt];
          // union of item keys across periods, preserving first-seen order
          const items: string[] = [];
          for (const d of periodDocs) {
            for (const k of Object.keys(d[key] ?? {})) if (!items.includes(k)) items.push(k);
          }
          const rows: string[] = [];
          for (const item of items) {
            const values = periodDocs.map((d) => {
              const v = (d[key] ?? {})[item];
              if (toNum(v) === null) return '';
              return RATIO_KEYS.has(item) ? fmtPct(v) : fmtMillions(v);
            });
            if (values.every((v) => v === '')) continue;
            rows.push([item, ...values].join('|'));
          }
          if (rows.length > 0) lines.push(`## ${stmt}`, ...rows);
        }
        return lines.join('\n');
      },
    },
  ],
};
```

Modify `src/features/index.ts` — add `financialsFeature` to imports and the `allFeatures` array (same pattern as Task 8).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/financials.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features tests/integration/financials.test.ts
git commit -m "feat: financial statements tool with period-matrix output"
```

---

### Task 10: Insider trades feature

**Files:**
- Create: `src/features/insider/index.ts`
- Modify: `src/features/index.ts` (add `insiderFeature`)
- Test: `tests/integration/insider.test.ts`

**Interfaces:**
- Consumes: same helpers. Data facts: `transactionType` ∈ {BUY, SELL, AWARD, OPTION_EXERCISE, TRANSFER, OTHER}; `shares`, `pricePerShare`, `totalAmountSigned` are Decimal128; `transactionDate` is Date.
- Produces: `insiderFeature: FeatureModule` with tool `get_insider_trades`.

- [ ] **Step 1: Write the failing test**

`tests/integration/insider.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('get_insider_trades', () => {
  it('lists market-wide trades with company column, newest first', async () => {
    const res: any = await h.client.callTool({ name: 'get_insider_trades', arguments: { limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('date|company|insider|role|type|shares|price|total|ccy');
    expect(lines.length).toBe(6);
    const d1 = lines[1].split('|')[0];
    const d2 = lines[5].split('|')[0];
    expect(d1 >= d2).toBe(true);
  });

  it('filters by company (drops company column) and type', async () => {
    const res: any = await h.client.callTool({
      name: 'get_insider_trades',
      arguments: { identifier: 'AAPL', transactionType: 'SELL', limit: 5 },
    });
    const out = text(res);
    const lines = out.split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('date|insider|role|type|shares|price|total|ccy');
    for (const row of lines.slice(1)) expect(row.split('|')[3]).toBe('SELL');
  });

  it('caps limit at 100', async () => {
    const res: any = await h.client.callTool({ name: 'get_insider_trades', arguments: { limit: 1000 } });
    const rows = text(res).split('\n').filter((l) => !l.startsWith('#')).length - 1;
    expect(rows).toBeLessThanOrEqual(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/insider.test.ts`
Expected: FAIL — tool not found.

- [ ] **Step 3: Implement `src/features/insider/index.ts`**

```ts
import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { resolveSecurity } from '../../db/identifiers.js';
import { fmtDate, fmtNum } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

export const insiderFeature: FeatureModule = {
  name: 'insider',
  tools: [
    {
      name: 'get_insider_trades',
      title: 'Insider trades',
      description:
        'Insider transactions, newest first. Without identifier: market-wide. transactionType: BUY|SELL|AWARD|OPTION_EXERCISE|TRANSFER|OTHER. minAmount filters |total| in instrument currency. total is signed (negative = disposal). Example: {"identifier":"AAPL","transactionType":"BUY","from":"2026-01-01"}',
      inputSchema: {
        identifier: z.string().optional().describe('ISIN, ticker or name; omit for market-wide'),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        transactionType: z.enum(['BUY', 'SELL', 'AWARD', 'OPTION_EXERCISE', 'TRANSFER', 'OTHER']).optional(),
        minAmount: z.number().optional().describe('min absolute transaction value'),
        limit: z.number().int().min(1).optional().describe('default 25, max 100'),
        offset: z.number().int().min(0).optional(),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 100);
        const offset = input.offset ?? 0;
        const filter: Record<string, unknown> = {};
        if (input.identifier) {
          const ref = await resolveSecurity(db, input.identifier);
          if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
          filter.isin = ref.isin;
        }
        if (input.from || input.to) {
          filter.transactionDate = {
            ...(input.from ? { $gte: new Date(`${input.from}T00:00:00Z`) } : {}),
            ...(input.to ? { $lte: new Date(`${input.to}T23:59:59.999Z`) } : {}),
          };
        }
        if (input.transactionType) filter.transactionType = input.transactionType;
        if (input.minAmount != null) filter.totalAmount = { $gte: input.minAmount };
        const docs = await cols(db)
          .insiderTrades.find(filter, {
            projection: {
              transactionDate: 1,
              companyName: 1,
              insiderName: 1,
              insiderRole: 1,
              transactionType: 1,
              shares: 1,
              pricePerShare: 1,
              totalAmountSigned: 1,
              currency: 1,
            },
            sort: { transactionDate: -1 },
            skip: offset,
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        const withCompany = !filter.isin;
        const headers = withCompany
          ? ['date', 'company', 'insider', 'role', 'type', 'shares', 'price', 'total', 'ccy']
          : ['date', 'insider', 'role', 'type', 'shares', 'price', 'total', 'ccy'];
        return table(
          headers,
          docs.slice(0, lim).map((d) => {
            const base = [
              fmtDate(d.transactionDate),
              d.insiderName,
              d.insiderRole,
              d.transactionType,
              fmtNum(d.shares, 0),
              fmtNum(d.pricePerShare),
              fmtNum(d.totalAmountSigned, 0),
              d.currency,
            ];
            if (withCompany) base.splice(1, 0, d.companyName);
            return base;
          }),
          { offset, hasMore },
        );
      },
    },
  ],
};
```

Modify `src/features/index.ts` — add `insiderFeature` to the array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/insider.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features tests/integration/insider.test.ts
git commit -m "feat: insider trades tool with market-wide and per-company modes"
```

---

### Task 11: Funds feature (13F search + holdings)

**Files:**
- Create: `src/features/funds/index.ts`
- Modify: `src/features/index.ts` (add `fundsFeature`)
- Test: `tests/integration/funds.test.ts`

**Interfaces:**
- Consumes: same helpers. Data facts: `funds` docs have `{ cik, companyName, portfolioValueUsd, positionCount, lastFilingDate, latestReportPeriod }`; `f13Filings` docs have `{ cik, companyName, reportPeriod ('YYYY-MM-DD'), filedAt, holdings: [{ issuer, cusip, isin, valueUsd, shares, putCall }] }`.
- Produces: `fundsFeature: FeatureModule` with tools `search_funds`, `get_fund_holdings`.

- [ ] **Step 1: Write the failing test**

`tests/integration/funds.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('search_funds', () => {
  it('finds funds by name, sorted by AUM desc', async () => {
    const res: any = await h.client.callTool({ name: 'search_funds', arguments: { query: 'capital', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('cik|name|aum(USDm)|positions|lastFiling|latestPeriod');
    expect(lines.length).toBeGreaterThan(1);
  });
});

describe('get_fund_holdings', () => {
  it('returns holdings of the largest "capital" fund with pct column', async () => {
    const search: any = await h.client.callTool({ name: 'search_funds', arguments: { query: 'capital', limit: 1 } });
    const cik = text(search).split('\n').filter((l) => !l.startsWith('#'))[1].split('|')[0];
    const res: any = await h.client.callTool({ name: 'get_fund_holdings', arguments: { fund: cik, limit: 10 } });
    const out = text(res);
    expect(out.split('\n')[0]).toMatch(/^# .+ \(CIK \d+\) 13F \d{4}-\d{2}-\d{2}, total \$[\d.]+m, \d+ positions$/);
    const lines = out.split('\n').slice(1).filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('issuer|isin|value(USDm)|shares|pct');
    expect(lines.length).toBeLessThanOrEqual(11);
  });

  it('lists top holders of a stock', async () => {
    const res: any = await h.client.callTool({ name: 'get_fund_holdings', arguments: { identifier: 'AAPL', limit: 5 } });
    const out = text(res);
    expect(out.split('\n')[0]).toMatch(/^# holders of US0378331005, 13F \d{4}-\d{2}-\d{2}$/);
    const lines = out.split('\n').slice(1);
    expect(lines[0]).toBe('fund|cik|value(USDm)|shares');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('requires fund or identifier', async () => {
    const res: any = await h.client.callTool({ name: 'get_fund_holdings', arguments: {} });
    expect(res.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/funds.test.ts`
Expected: FAIL — tools not found.

- [ ] **Step 3: Implement `src/features/funds/index.ts`**

```ts
import { z } from 'zod';
import type { Db, Document } from 'mongodb';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { escapeRegex, resolveSecurity } from '../../db/identifiers.js';
import { fmtDate, fmtMillions, fmtNum, fmtPct } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

async function findFund(db: Db, q: string): Promise<Document | null> {
  const c = cols(db).funds;
  const opts = { projection: { cik: 1, companyName: 1 }, maxTimeMS: MAX_TIME_MS };
  if (/^\d+$/.test(q.trim())) return c.findOne({ cik: Number.parseInt(q, 10) }, opts);
  return c.findOne(
    { companyName: { $regex: escapeRegex(q.trim()), $options: 'i' } },
    { ...opts, sort: { portfolioValueUsd: -1 } },
  );
}

export const fundsFeature: FeatureModule = {
  name: 'funds',
  tools: [
    {
      name: 'search_funds',
      title: 'Search funds',
      description:
        '13F institutional managers by name substring or CIK. aum = latest reported portfolio value. Example: {"query":"Berkshire"}',
      inputSchema: {
        query: z.string().min(1).describe('fund name substring or CIK'),
        limit: z.number().int().min(1).max(50).optional().describe('default 25'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 50);
        const q = String(input.query).trim();
        const filter = /^\d+$/.test(q)
          ? { cik: Number.parseInt(q, 10) }
          : { companyName: { $regex: escapeRegex(q), $options: 'i' } };
        const docs = await cols(db)
          .funds.find(filter, {
            projection: { cik: 1, companyName: 1, portfolioValueUsd: 1, positionCount: 1, lastFilingDate: 1, latestReportPeriod: 1 },
            sort: { portfolioValueUsd: -1 },
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        return table(
          ['cik', 'name', 'aum(USDm)', 'positions', 'lastFiling', 'latestPeriod'],
          docs.slice(0, lim).map((d) => [d.cik, d.companyName, fmtMillions(d.portfolioValueUsd), d.positionCount, d.lastFilingDate, d.latestReportPeriod]),
          { hasMore },
        );
      },
    },
    {
      name: 'get_fund_holdings',
      title: '13F holdings',
      description:
        'Either fund → its 13F portfolio (latest or given reportPeriod), or identifier (stock) → top institutional holders. Values in USD millions. period format YYYY-MM-DD (quarter end). Example: {"fund":"Berkshire"} or {"identifier":"AAPL"}',
      inputSchema: {
        fund: z.string().optional().describe('fund name substring or CIK'),
        identifier: z.string().optional().describe('stock ISIN, ticker or name — lists top holders'),
        period: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('reportPeriod, default latest'),
        limit: z.number().int().min(1).optional().describe('default 50, max 200'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 50, 200);
        const c = cols(db);
        if (input.fund) {
          const fund = await findFund(db, input.fund);
          if (!fund) throw new ToolError(`fund '${input.fund}' not found — use search_funds`);
          const filing = (
            await c.f13Filings
              .find(
                { cik: fund.cik, ...(input.period ? { reportPeriod: input.period } : {}) },
                { projection: { holdings: 1, reportPeriod: 1 }, sort: { reportPeriod: -1, filedAt: -1 }, limit: 1, maxTimeMS: MAX_TIME_MS },
              )
              .toArray()
          )[0];
          if (!filing) throw new ToolError(`no 13F filing for CIK ${fund.cik}${input.period ? ` at ${input.period}` : ''}`);
          const holdings = (filing.holdings ?? []) as Document[];
          const total = holdings.reduce((s, x) => s + (x.valueUsd ?? 0), 0);
          const top = [...holdings].sort((a, b) => (b.valueUsd ?? 0) - (a.valueUsd ?? 0)).slice(0, lim);
          const body = table(
            ['issuer', 'isin', 'value(USDm)', 'shares', 'pct'],
            top.map((x) => [
              x.putCall ? `${x.issuer} (${x.putCall})` : x.issuer,
              x.isin,
              fmtMillions(x.valueUsd),
              fmtNum(x.shares, 0),
              total > 0 ? fmtPct((x.valueUsd ?? 0) / total) : '',
            ]),
            { hasMore: holdings.length > lim },
          );
          return `# ${fund.companyName} (CIK ${fund.cik}) 13F ${filing.reportPeriod}, total $${fmtMillions(total)}m, ${holdings.length} positions\n${body}`;
        }
        if (input.identifier) {
          const ref = await resolveSecurity(db, input.identifier);
          if (!ref) throw new ToolError(`unknown identifier '${input.identifier}' — use search_securities`);
          let period = input.period;
          if (!period) {
            const latest = await c.f13Filings
              .aggregate(
                [{ $match: { 'holdings.isin': ref.isin } }, { $group: { _id: null, p: { $max: '$reportPeriod' } } }],
                { maxTimeMS: MAX_TIME_MS },
              )
              .toArray();
            period = latest[0]?.p;
            if (!period) throw new ToolError(`no 13F holdings found for ${ref.isin}`);
          }
          const holders = await c.f13Filings
            .aggregate(
              [
                { $match: { 'holdings.isin': ref.isin, reportPeriod: period } },
                { $unwind: '$holdings' },
                { $match: { 'holdings.isin': ref.isin } },
                { $project: { companyName: 1, cik: 1, valueUsd: '$holdings.valueUsd', shares: '$holdings.shares' } },
                { $sort: { valueUsd: -1 } },
                { $limit: lim },
              ],
              { maxTimeMS: MAX_TIME_MS },
            )
            .toArray();
          const body = table(
            ['fund', 'cik', 'value(USDm)', 'shares'],
            holders.map((x) => [x.companyName, x.cik, fmtMillions(x.valueUsd), fmtNum(x.shares, 0)]),
          );
          return `# holders of ${ref.isin}, 13F ${fmtDate(period)}\n${body}`;
        }
        throw new ToolError('provide either fund or identifier');
      },
    },
  ],
};
```

Modify `src/features/index.ts` — add `fundsFeature` to the array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/funds.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features tests/integration/funds.test.ts
git commit -m "feat: funds feature (13F search, portfolio and top-holder views)"
```

---

### Task 12: Political trades feature

**Files:**
- Create: `src/features/political/index.ts`
- Modify: `src/features/index.ts` (add `politicalFeature`)
- Test: `tests/integration/political.test.ts`

**Interfaces:**
- Consumes: same helpers. Data facts: `politicalFilings` docs `{ chamber: 'house'|'senate', filer: { fullName, state, party }, filingDate: 'YYYY-MM-DD', trades: [{ transactionDate: 'YYYY-MM-DD', ticker, asset, transactionType, amountRangeLow, amountRangeHigh, amountExact, owner }] }`.
- Produces: `politicalFeature: FeatureModule` with tool `get_political_trades`.

- [ ] **Step 1: Write the failing test**

`tests/integration/political.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('get_political_trades', () => {
  it('lists recent congressional trades', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { limit: 10 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('txDate|filed|politician|chamber|ticker|asset|type|amount|owner');
    expect(lines.length).toBeGreaterThan(1);
  });

  it('filters by ticker', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { identifier: 'AMZN', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    for (const row of lines.slice(1)) expect(row.split('|')[4]).toBe('AMZN');
  });

  it('filters by chamber', async () => {
    const res: any = await h.client.callTool({ name: 'get_political_trades', arguments: { chamber: 'house', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    for (const row of lines.slice(1)) expect(row.split('|')[3]).toBe('house');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/political.test.ts`
Expected: FAIL — tool not found.

- [ ] **Step 3: Implement `src/features/political/index.ts`**

```ts
import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { escapeRegex, resolveSecurity } from '../../db/identifiers.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

function fmtAmount(low: number | null, high: number | null, exact: number | null): string {
  if (exact != null) return `$${Math.round(exact / 1000)}k`;
  if (low == null && high == null) return '';
  const k = (v: number | null) => (v == null ? '?' : `${Math.round(v / 1000)}k`);
  return `$${k(low)}-${k(high)}`;
}

export const politicalFeature: FeatureModule = {
  name: 'political',
  tools: [
    {
      name: 'get_political_trades',
      title: 'Congressional trades',
      description:
        'Stock trades disclosed by US Congress members, ordered by filing date desc. transactionType codes: P=purchase, S=sale, SP=partial sale, EX=exchange. amount is the disclosed range. Example: {"politician":"Pelosi"} or {"identifier":"NVDA","chamber":"house"}',
      inputSchema: {
        politician: z.string().optional().describe('politician name substring'),
        identifier: z.string().optional().describe('stock ISIN, ticker or name'),
        chamber: z.enum(['house', 'senate']).optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe('min filingDate'),
        limit: z.number().int().min(1).optional().describe('default 25, max 100'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 100);
        let ticker: string | null = null;
        if (input.identifier) {
          const ref = await resolveSecurity(db, input.identifier);
          ticker = ref?.ticker ?? input.identifier.toUpperCase();
        }
        const match: Record<string, unknown> = { parseStatus: 'parsed' };
        if (input.politician) match['filer.fullName'] = { $regex: escapeRegex(input.politician), $options: 'i' };
        if (input.chamber) match.chamber = input.chamber;
        if (input.from) match.filingDate = { $gte: input.from };
        if (ticker) match['trades.ticker'] = ticker;
        const rows = await cols(db)
          .politicalFilings.aggregate(
            [
              { $match: match },
              { $sort: { filingDate: -1 } },
              { $limit: 500 },
              { $unwind: '$trades' },
              ...(ticker ? [{ $match: { 'trades.ticker': ticker } }] : []),
              {
                $project: {
                  filingDate: 1,
                  chamber: 1,
                  name: '$filer.fullName',
                  txDate: '$trades.transactionDate',
                  ticker: '$trades.ticker',
                  asset: '$trades.asset',
                  type: '$trades.transactionType',
                  low: '$trades.amountRangeLow',
                  high: '$trades.amountRangeHigh',
                  exact: '$trades.amountExact',
                  owner: '$trades.owner',
                },
              },
              { $limit: lim + 1 },
            ],
            { maxTimeMS: MAX_TIME_MS },
          )
          .toArray();
        if (rows.length === 0 && input.politician) {
          throw new ToolError(`no parsed filings match politician '${input.politician}'`);
        }
        const hasMore = rows.length > lim;
        return table(
          ['txDate', 'filed', 'politician', 'chamber', 'ticker', 'asset', 'type', 'amount', 'owner'],
          rows.slice(0, lim).map((r) => [
            r.txDate,
            r.filingDate,
            r.name,
            r.chamber,
            r.ticker,
            typeof r.asset === 'string' ? r.asset.slice(0, 40) : r.asset,
            r.type,
            fmtAmount(r.low, r.high, r.exact),
            r.owner,
          ]),
          { hasMore },
        );
      },
    },
  ],
};
```

Modify `src/features/index.ts` — add `politicalFeature` to the array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/political.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features tests/integration/political.test.ts
git commit -m "feat: congressional trades tool"
```

---

### Task 13: Macro feature (FRED + ECB series)

**Files:**
- Create: `src/features/macro/index.ts`
- Modify: `src/features/index.ts` (add `macroFeature`)
- Test: `tests/integration/macro.test.ts`

**Interfaces:**
- Consumes: same helpers. Data facts: `fred` (36 docs, no `source` field → label `fred`) and `economicIndicators` (20 docs, `source` e.g. `ecb`) share the shape `{ seriesId, name, unit, frequency, category, observations: [{ date: 'YYYY-MM-DD'|'YYYY-MM', value: number|null }] }`.
- Produces: `macroFeature: FeatureModule` with tool `get_macro_series`.

- [ ] **Step 1: Write the failing test**

`tests/integration/macro.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('get_macro_series', () => {
  it('lists the catalog when called without seriesId', async () => {
    const res: any = await h.client.callTool({ name: 'get_macro_series', arguments: {} });
    const out = text(res);
    const lines = out.split('\n');
    expect(lines[0]).toBe('seriesId|name|unit|freq|category|source|lastDate');
    expect(out).toContain('CPIAUCSL');
  });

  it('returns observations for a series with range filter', async () => {
    const res: any = await h.client.callTool({
      name: 'get_macro_series',
      arguments: { seriesId: 'CPIAUCSL', from: '2024-01-01' },
    });
    const out = text(res);
    expect(out.split('\n')[0]).toMatch(/^# CPIAUCSL /);
    expect(out.split('\n')[1]).toBe('date|value');
    const first = out.split('\n')[2].split('|')[0];
    expect(first >= '2024-01-01').toBe(true);
  });

  it('errors on unknown seriesId', async () => {
    const res: any = await h.client.callTool({ name: 'get_macro_series', arguments: { seriesId: 'NOPE123' } });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/catalog/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/integration/macro.test.ts`
Expected: FAIL — tool not found.

- [ ] **Step 3: Implement `src/features/macro/index.ts`**

```ts
import { z } from 'zod';
import type { Document } from 'mongodb';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { fmtNum } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';

const MAX_OBS = 500;
const CATALOG_PROJECTION = {
  projection: { seriesId: 1, name: 1, unit: 1, frequency: 1, category: 1, source: 1, observations: { $slice: -1 } },
  maxTimeMS: MAX_TIME_MS,
};

export const macroFeature: FeatureModule = {
  name: 'macro',
  tools: [
    {
      name: 'get_macro_series',
      title: 'Macro series',
      description:
        'Macro/economic time series (FRED, ECB). Without seriesId: catalog of all series. With seriesId: observations (date|value), optional from/to (YYYY-MM-DD), max 500 most recent within range. Example: {"seriesId":"CPIAUCSL","from":"2020-01-01"}',
      inputSchema: {
        seriesId: z.string().optional().describe('omit for catalog'),
        from: z.string().optional(),
        to: z.string().optional(),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const c = cols(db);
        if (!input.seriesId) {
          const [fredDocs, ecoDocs] = await Promise.all([
            c.fred.find({}, CATALOG_PROJECTION).toArray(),
            c.economicIndicators.find({}, CATALOG_PROJECTION).toArray(),
          ]);
          const row = (d: Document, source: string) => [
            d.seriesId,
            d.name,
            d.unit,
            d.frequency,
            d.category,
            source,
            d.observations?.[0]?.date ?? '',
          ];
          return table(
            ['seriesId', 'name', 'unit', 'freq', 'category', 'source', 'lastDate'],
            [...fredDocs.map((d) => row(d, 'fred')), ...ecoDocs.map((d) => row(d, d.source ?? 'other'))],
          );
        }
        const opts = { projection: { seriesId: 1, name: 1, unit: 1, frequency: 1, observations: 1 }, maxTimeMS: MAX_TIME_MS };
        const doc =
          (await c.fred.findOne({ seriesId: input.seriesId }, opts)) ??
          (await c.economicIndicators.findOne({ seriesId: input.seriesId }, opts));
        if (!doc) throw new ToolError(`unknown seriesId '${input.seriesId}' — call get_macro_series without seriesId for the catalog`);
        let obs = (doc.observations ?? []).filter(
          (o: Document) => o.value != null && (!input.from || o.date >= input.from) && (!input.to || o.date <= input.to),
        );
        let note = '';
        if (obs.length > MAX_OBS) {
          note = `# showing last ${MAX_OBS} of ${obs.length} — narrow the range\n`;
          obs = obs.slice(-MAX_OBS);
        }
        const body = table(['date', 'value'], obs.map((o: Document) => [o.date, fmtNum(o.value)]));
        return `# ${doc.seriesId} ${doc.name}, unit: ${doc.unit}, freq: ${doc.frequency}\n${note}${body}`;
      },
    },
  ],
};
```

Modify `src/features/index.ts` — add `macroFeature` to the array.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/integration/macro.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/features tests/integration/macro.test.ts
git commit -m "feat: macro series tool with catalog and range-filtered observations"
```

---

### Task 14: News feature + text index

**Files:**
- Create: `src/features/news/index.ts`, `scripts/ensure-indexes.ts`
- Modify: `src/features/index.ts` (add `newsFeature`)
- Test: `tests/integration/news.test.ts`

**Interfaces:**
- Consumes: same helpers. Data facts: `news` docs `{ pubDate: Date, sourceName, category (UPPERCASE), title, link, description }`. Text search requires the `news_text` index this task creates.
- Produces: `newsFeature: FeatureModule` with tool `search_news`; idempotent `npm run ensure-indexes`.

- [ ] **Step 1: Create and run the index script**

`scripts/ensure-indexes.ts`:

```ts
import { loadConfig } from '../src/config.js';
import { closeMongo, getDb } from '../src/db/client.js';

const db = await getDb(loadConfig({ ...process.env, MCP_AUTH_DISABLED: 'true' }));
console.log('creating news text index (idempotent, may take a minute on ~500k docs)…');
await db.collection('news').createIndex({ title: 'text', description: 'text' }, { name: 'news_text' });
console.log('done');
await closeMongo();
```

Run: `npm run ensure-indexes`
Expected: `done` (first run may take 1–3 minutes).

- [ ] **Step 2: Write the failing test**

`tests/integration/news.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closeMongo } from '../../src/db/client.js';
import { testClient, text } from '../helpers/mcp.js';

let h: Awaited<ReturnType<typeof testClient>>;

beforeAll(async () => {
  h = await testClient();
});

afterAll(async () => {
  await h.close();
  await closeMongo();
});

describe('search_news', () => {
  it('returns latest news without query', async () => {
    const res: any = await h.client.callTool({ name: 'search_news', arguments: { limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines[0]).toBe('date|source|title|link');
    expect(lines.length).toBe(6);
    const d1 = lines[1].split('|')[0];
    const d5 = lines[5].split('|')[0];
    expect(d1 >= d5).toBe(true);
  });

  it('full-text searches titles/descriptions', async () => {
    const res: any = await h.client.callTool({ name: 'search_news', arguments: { query: 'inflation', limit: 5 } });
    const lines = text(res).split('\n').filter((l) => !l.startsWith('#'));
    expect(lines.length).toBeGreaterThan(1);
  });

  it('includeDescription adds the column', async () => {
    const res: any = await h.client.callTool({ name: 'search_news', arguments: { limit: 2, includeDescription: true } });
    const header = text(res).split('\n').find((l) => l.startsWith('date|'))!;
    expect(header).toBe('date|source|title|link|description');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/integration/news.test.ts`
Expected: FAIL — tool not found.

- [ ] **Step 4: Implement `src/features/news/index.ts`**

```ts
import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { escapeRegex } from '../../db/identifiers.js';
import { fmtDate } from '../../format/num.js';
import { table } from '../../format/table.js';
import type { FeatureModule } from '../types.js';

export const newsFeature: FeatureModule = {
  name: 'news',
  tools: [
    {
      name: 'search_news',
      title: 'Search news',
      description:
        'Financial news, newest first. query = full-text search over title+description (omit for latest). Filters: from/to (pubDate, YYYY-MM-DD), source (name substring, e.g. Handelsblatt), category (e.g. COMPANIES). Example: {"query":"inflation ECB","from":"2026-06-01"}',
      inputSchema: {
        query: z.string().optional(),
        from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        source: z.string().optional(),
        category: z.string().optional(),
        includeDescription: z.boolean().optional().describe('adds description column (more tokens)'),
        limit: z.number().int().min(1).max(50).optional().describe('default 25'),
        offset: z.number().int().min(0).optional(),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 50);
        const offset = input.offset ?? 0;
        const filter: Record<string, unknown> = {};
        if (input.query) filter.$text = { $search: input.query };
        if (input.from || input.to) {
          filter.pubDate = {
            ...(input.from ? { $gte: new Date(`${input.from}T00:00:00Z`) } : {}),
            ...(input.to ? { $lte: new Date(`${input.to}T23:59:59.999Z`) } : {}),
          };
        }
        if (input.source) filter.sourceName = { $regex: escapeRegex(input.source), $options: 'i' };
        if (input.category) filter.category = input.category.toUpperCase();
        const projection: Record<string, unknown> = { pubDate: 1, sourceName: 1, title: 1, link: 1 };
        if (input.includeDescription) projection.description = 1;
        const docs = await cols(db)
          .news.find(filter, {
            projection,
            sort: { pubDate: -1 },
            skip: offset,
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        const hasMore = docs.length > lim;
        const headers = ['date', 'source', 'title', 'link'];
        if (input.includeDescription) headers.push('description');
        return table(
          headers,
          docs.slice(0, lim).map((d) => {
            const row: Array<string | null | undefined> = [fmtDate(d.pubDate), d.sourceName, d.title, d.link];
            if (input.includeDescription) row.push(d.description);
            return row;
          }),
          { offset, hasMore },
        );
      },
    },
  ],
};
```

Modify `src/features/index.ts` — final registry:

```ts
import type { FeatureModule } from './types.js';
import { securitiesFeature } from './securities/index.js';
import { pricesFeature } from './prices/index.js';
import { financialsFeature } from './financials/index.js';
import { insiderFeature } from './insider/index.js';
import { fundsFeature } from './funds/index.js';
import { politicalFeature } from './political/index.js';
import { macroFeature } from './macro/index.js';
import { newsFeature } from './news/index.js';

/** All registered feature modules. Add new features here. */
export const allFeatures: FeatureModule[] = [
  securitiesFeature,
  pricesFeature,
  financialsFeature,
  insiderFeature,
  fundsFeature,
  politicalFeature,
  macroFeature,
  newsFeature,
];
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/integration/news.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/features scripts tests/integration/news.test.ts
git commit -m "feat: news search with full-text index and ensure-indexes script"
```

---

### Task 15: Deploy assets, README, full verification

**Files:**
- Create: `deploy/mcp-fc.service`, `deploy/DEPLOY.md`, `README.md`

**Interfaces:**
- Consumes: everything above; no new code interfaces.

- [ ] **Step 1: Create `deploy/mcp-fc.service`**

```ini
[Unit]
Description=mcp-fc MCP server (financecentre)
After=network.target mongod.service

[Service]
Type=simple
User=mcp-fc
WorkingDirectory=/opt/mcp-fc
EnvironmentFile=/opt/mcp-fc/.env
ExecStart=/usr/bin/node /opt/mcp-fc/dist/server.js
Restart=on-failure
RestartSec=3
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=

[Install]
WantedBy=multi-user.target
```

- [ ] **Step 2: Create `deploy/DEPLOY.md`**

```markdown
# Deployment (plain Node, no Docker)

## Build & install

    npm ci
    npm run build
    # copy to server: dist/, package.json, package-lock.json, deploy/
    # on the server:
    npm ci --omit=dev

## Configure

Create `/opt/mcp-fc/.env` from `.env.example`. Generate keys with:

    openssl rand -hex 32

Entry format: `MCP_API_KEYS=<name>:<key>=read` (comma-separated for multiple agents;
scopes: `read`, later `write`).

## One-time DB preparation

    npm run ensure-indexes   # creates the news full-text index

## systemd

    sudo cp deploy/mcp-fc.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now mcp-fc
    curl -s localhost:8814/healthz   # → {"ok":true,"db":"up"}

## Reverse proxy

Expose only `POST /mcp` and optionally `GET /healthz` via HTTPS. The server is
stateless — you can run several instances behind the proxy for scale-out.

## Agent configuration

MCP endpoint: `https://<host>/mcp`, transport: streamable-http,
header: `Authorization: Bearer <key>`.
```

- [ ] **Step 3: Create `README.md`**

```markdown
# mcp-fc

MCP server exposing the `financecentre` MongoDB (stocks, prices, SEC financials,
insider trades, 13F funds, congressional trades, macro series, news) to AI agents.
Streamable HTTP (stateless), scoped API keys, token-efficient pipe-table output.

## Quick start

    cp .env.example .env   # set MCP_API_KEYS or MCP_AUTH_DISABLED=true for dev
    npm ci
    npm run ensure-indexes
    npm run dev            # or: npm run build && npm start

## Tools (v1, read-only)

search_securities · get_security_snapshot · screen_stocks · get_price_history ·
get_financials · get_insider_trades · search_funds · get_fund_holdings ·
get_political_trades · get_macro_series · search_news

## Adding a feature

1. Create `src/features/<name>/index.ts` exporting a `FeatureModule`.
2. Add it to `allFeatures` in `src/features/index.ts`.
3. Add an integration test in `tests/integration/`.
Write tools: set `requiredScope: 'write'` and grant the scope to a key.

Design: docs/superpowers/specs/2026-07-14-mcp-financecentre-design.md
Deployment: deploy/DEPLOY.md

## Tests

    npm test   # unit + integration + e2e (needs local MongoDB with financecentre)
```

- [ ] **Step 4: Full verification**

Run: `npm run build && npm test`
Expected: build succeeds with no TS errors; all test files pass.

Then a smoke test of the built server:

```bash
MCP_AUTH_DISABLED=true node dist/server.js &
sleep 1
curl -s localhost:8814/healthz
# expect {"ok":true,"db":"up"}
curl -s -X POST localhost:8814/mcp -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}' | head -c 400
# expect a JSON tools list containing search_securities
kill %1
```

- [ ] **Step 5: Commit**

```bash
git add deploy README.md
git commit -m "docs: deployment assets and readme"
```

---

## Plan Self-Review (completed)

- **Spec coverage:** all 11 spec tools ✔ (spec's `isin` params intentionally generalized to `identifier`); stateless transport ✔ (Task 6); scopes ✔ (Tasks 1/3/5); format rules ✔ (Task 2); news text index ✔ (Task 14); healthz ✔; systemd/DEPLOY ✔ (Task 15); maxTimeMS/projections ✔ (global constraint, all features).
- **Placeholders:** none; every step has full code or exact commands.
- **Type consistency:** `table(headers, rows, {offset, hasMore})`, `kv(pairs)`, `fmt*`, `resolveSecurity → SecurityRef`, `ToolDef/FeatureModule/ToolError`, `createMcpServer(deps, auth, features?)`, `testClient(scopes?) → {client, close}` used consistently across Tasks 2–14.
