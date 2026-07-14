# Deployment (plain Node, no Docker)

## Build & install (on the server)

    git clone https://github.com/marvin-fritz/mcp-fc.git /opt/mcp-fc
    cd /opt/mcp-fc
    npm ci
    npm run build

Updates later:

    cd /opt/mcp-fc && git pull && npm ci && npm run build && sudo systemctl restart mcp-fc

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
