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
