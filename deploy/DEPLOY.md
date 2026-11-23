# Deployment (plain Node, no Docker)

## Build & install (on the server)

    git clone https://github.com/marvin-fritz/mcp-fc.git /opt/mcp-fc
    cd /opt/mcp-fc
    npm ci
    npm run build

Updates later (on kvm12996 via the shared deploy tool, see Finanz-Copilot/ops/fc-deploy):

    fc-deploy mcp-fc            # on the server, or `bin/fc-deploy mcp-fc` from the workspace

This runs `update.sh`: `npm ci` only when `package-lock.json` changed, build into
`dist.new` and swap with `dist` (previous build kept in `dist.prev`),
`ensure-indexes`, restart, `/healthz` check. Rollback: `fc-deploy rollback mcp-fc`.
Without fc-deploy: `sudo bash /opt/mcp-fc/update.sh` (pulls `origin main` itself).

## Configure

Create `/opt/mcp-fc/.env` from `.env.example`. Generate keys with:

    openssl rand -hex 32

Entry format: `MCP_API_KEYS=<name>:<key>=read` (comma-separated for multiple agents;
scopes: `read`, later `write`).

For claude.ai connector support additionally set in `.env`:

    MCP_PUBLIC_URL=https://mcp.finanz-copilot.de
    MCP_JWT_SECRET=$(openssl rand -hex 32)

Then update the nginx vhost (adds /.well-known, /authorize, /oauth/login,
/token, /register, /revoke) and restart:

    sudo cp deploy/nginx-mcp.finanz-copilot.de.conf /etc/nginx/sites-available/mcp.finanz-copilot.de
    sudo nginx -t && sudo systemctl reload nginx
    sudo systemctl restart mcp-fc

claude.ai → Settings → Connectors → Add custom connector →
`https://mcp.finanz-copilot.de/mcp` → sign in with a finanz-copilot account.

## One-time DB preparation

    npm run ensure-indexes   # news full-text index + newsGeo indexes

Re-run after deploying versions with schema/index changes.

The geolocation agent needs a write key:

    MCP_API_KEYS=agent1:<key>=read,geoagent:<key2>=read+write

## systemd

    sudo cp deploy/mcp-fc.service /etc/systemd/system/
    sudo systemctl daemon-reload
    sudo systemctl enable --now mcp-fc
    curl -s localhost:8814/healthz   # → {"ok":true,"db":"up"}

## Reverse proxy (nginx)

Ready-made vhost: `deploy/nginx-mcp.finanz-copilot.de.conf` — exposes only
`POST /mcp` and `GET /healthz`. The server is stateless — you can run several
instances behind the proxy for scale-out.

    sudo cp deploy/nginx-mcp.finanz-copilot.de.conf /etc/nginx/sites-available/mcp.finanz-copilot.de
    sudo ln -s /etc/nginx/sites-available/mcp.finanz-copilot.de /etc/nginx/sites-enabled/
    sudo nginx -t && sudo systemctl reload nginx
    sudo certbot --nginx -d mcp.finanz-copilot.de   # needs the DNS A record first

## Agent configuration

MCP endpoint: `https://<host>/mcp`, transport: streamable-http,
header: `Authorization: Bearer <key>`.
