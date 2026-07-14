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

## Auth

Two parallel mechanisms on `POST /mcp`:

- **API keys** (`MCP_API_KEYS`) — for Claude Code, curl, n8n: `Authorization: Bearer <key>`.
- **OAuth 2.1** (enabled when `MCP_JWT_SECRET` is set) — for claude.ai custom
  connectors (web/desktop/mobile). Login uses finanz-copilot accounts
  (`financecentre.users`, read-only); role `admin` → scopes `read write`,
  `member` → `read`. JWT access tokens (1 h), rotating refresh tokens (30 d),
  PKCE + dynamic client registration. OAuth data lives in the `mcp-fc` database.

## Adding a feature

1. Create `src/features/<name>/index.ts` exporting a `FeatureModule`.
2. Add it to `allFeatures` in `src/features/index.ts`.
3. Add an integration test in `tests/integration/`.

Write tools: set `requiredScope: 'write'` and grant the scope to a key.

Design: docs/superpowers/specs/2026-07-14-mcp-financecentre-design.md
Deployment: deploy/DEPLOY.md

## Tests

    npm test   # unit + integration + e2e (needs local MongoDB with financecentre)
