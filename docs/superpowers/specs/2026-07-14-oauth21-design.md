# mcp-fc — OAuth 2.1 mit Finanz-Copilot-Accounts (Design v2)

Datum: 2026-07-14
Status: Approved (Design vom User bestätigt: „Passt.")
Baut auf: `2026-07-14-mcp-financecentre-design.md`

## Zweck

mcp-fc soll als **Custom Connector auf claude.ai** einsetzbar sein (Web, Desktop,
Mobile — „von überall"). claude.ai-Connectoren unterstützen keine statischen
API-Keys, sondern verlangen OAuth 2.1 mit Dynamic Client Registration. Das Login
erfolgt mit den **bestehenden Finanz-Copilot-Accounts** (`financecentre.users`).
API-Key-Auth bleibt parallel voll funktionsfähig (Claude Code, curl, n8n).

## Entscheidungen

| Thema | Entscheidung |
|---|---|
| Rollenverteilung | mcp-fc ist Authorization Server **und** Resource Server (AS = RS, Issuer = `MCP_PUBLIC_URL`) |
| SDK-Bausteine | `mcpAuthRouter` (Discovery, /authorize, /token, /register, /revoke inkl. PKCE-Validierung und Rate-Limits), `OAuthServerProvider`-Interface, `AuthInfo` |
| User-Login | E-Mail + Passwort gegen `financecentre.users`: `bcryptjs.compare` gegen `password` (`$2b$`-Hash); nur `isActive: true` && `isLocked: false`; **keine Schreibzugriffe** auf users (failedLoginAttempts bleibt Sache der Haupt-App) |
| Rollen → Scopes | `role: 'admin'` → `read+write`; alle anderen (`member`) → `read` |
| Access Token | JWT HS256 via `jose`, TTL 60 min; Claims: `sub` (userId), `email`, `scope` (space-separated), `client_id`, `iss` = MCP_PUBLIC_URL, `aud` = 'mcp-fc' — stateless verifizierbar (Multi-Instanz-fähig) |
| Refresh Token | Random 256-bit hex, TTL 30 Tage, **Rotation bei jedem Gebrauch**, gespeichert in Mongo |
| Auth Codes | Random 256-bit hex, TTL 10 min, single-use; speichert codeChallenge/redirectUri/scopes/userId |
| Storage | Eigene Mongo-DB **`mcp-fc`** (`MONGODB_AUTH_DB`, default `mcp-fc`): Collections `oauthClients`, `oauthCodes`, `oauthRefreshTokens` mit TTL-Indexen; `financecentre` bleibt read-only für Auth (nur users-Lookup) |
| DCR | `registerClient` implementiert (claude.ai registriert sich selbst); Clients ohne Secret (public client + PKCE) |
| Duale Auth auf /mcp | Bearer wird erst gegen API-Keys geprüft (timing-safe), sonst als JWT verifiziert; beide liefern denselben `AuthContext { keyName, scopes }` (bei OAuth: keyName = E-Mail) |
| 401-Verhalten | `WWW-Authenticate: Bearer resource_metadata="<PUBLIC_URL>/.well-known/oauth-protected-resource"` — damit startet claude.ai den OAuth-Flow |
| Feature-Toggle | OAuth-Endpoints werden nur gemountet, wenn `MCP_JWT_SECRET` gesetzt ist; ohne Secret verhält sich der Server exakt wie v1 (API-Key only) |
| Login-Rate-Limit | In-Memory: max. 5 Fehlversuche pro (E-Mail+IP) in 15 min (pro Instanz; bewusst einfach) |
| Login-Seite | Serverseitig gerendertes minimales HTML (dunkel, ohne Assets/CDN), zeigt Client-Name + angeforderte Scopes; Formular POSTet nach `/oauth/login` |

## Ablauf (claude.ai Custom Connector)

```
claude.ai                    mcp-fc (AS+RS)                     financecentre
   │ POST /mcp (ohne Token)      │                                   │
   │◄─ 401 + WWW-Authenticate ───│                                   │
   │ GET /.well-known/… ─────────►│  (Discovery via mcpAuthRouter)   │
   │ POST /register ─────────────►│  → oauthClients (mcp-fc DB)      │
   │ Browser: GET /authorize ────►│  → Login-Seite (HTML)            │
   │ Browser: POST /oauth/login ─►│  bcrypt-Check ───────────────────► users (read)
   │◄─ 302 redirect_uri?code=… ──│  → oauthCodes                    │
   │ POST /token (code+PKCE) ────►│  → JWT + Refresh-Token           │
   │ POST /mcp (Bearer JWT) ─────►│  verify → AuthContext → Tools    │
```

## Komponenten

```
src/auth/
├── apiKey.ts            # (bestehend, unverändert) API-Key-Prüfung
├── unified.ts           # NEU: makeUnifiedAuthMiddleware — API-Key ODER JWT → res.locals.auth
└── oauth/
    ├── provider.ts      # McpOAuthProvider implements OAuthServerProvider
    ├── store.ts         # Mongo-Stores: clients / codes / refresh tokens (+ ensureAuthIndexes)
    ├── tokens.ts        # signAccessToken / verifyAccessToken (jose, HS256)
    ├── users.ts         # verifyUserLogin(db, email, password) → { userId, email, scopes } | Fehlercode
    ├── rateLimit.ts     # LoginRateLimiter (in-memory)
    └── loginPage.ts     # renderLoginPage(params, error?) → HTML-String
```

- `server.ts`: mountet bei gesetztem `MCP_JWT_SECRET` den `mcpAuthRouter`
  (issuerUrl = MCP_PUBLIC_URL, scopesSupported ['read','write'], resourceName
  'financecentre MCP') und `POST /oauth/login`; `/mcp` nutzt die neue
  Unified-Middleware statt der reinen API-Key-Middleware.
- `provider.authorize()` rendert die Login-Seite und trägt die OAuth-Parameter
  (client_id, redirect_uri, code_challenge, state, scopes, resource) als hidden
  fields; `POST /oauth/login` validiert client_id + redirect_uri **erneut gegen
  den registrierten Client**, prüft Credentials, erzeugt den Code und redirectet.
  Bei Fehlern wird die Seite mit Fehlermeldung erneut gerendert (HTTP 200).
- PKCE (S256) validiert der SDK-Token-Handler über
  `challengeForAuthorizationCode` (skipLocalPkceValidation bleibt false).
- `revokeToken` löscht Refresh-Tokens (Access-JWTs laufen natürlich aus).

## Konfiguration (neu in .env)

```
MCP_PUBLIC_URL=https://mcp.finanz-copilot.de   # Issuer; ohne Angabe: http://localhost:<port>
MCP_JWT_SECRET=<openssl rand -hex 32>          # aktiviert OAuth; leer = API-Key-only-Modus
MONGODB_AUTH_DB=mcp-fc                         # Storage-DB für OAuth-Artefakte
```

Neue Dependencies: `jose`, `bcryptjs`.

## nginx

Zusätzlich freigeben (alle → 127.0.0.1:8814): `/.well-known/` (Prefix),
`= /authorize`, `= /oauth/login`, `= /token`, `= /register`, `= /revoke`.
`deploy/nginx-mcp.finanz-copilot.de.conf` wird entsprechend erweitert.

## Sicherheit

- PKCE S256 verpflichtend (SDK erzwingt es bei public clients).
- redirect_uri wird bei /authorize (SDK) **und** /oauth/login (wir) gegen die
  registrierten URIs des Clients geprüft.
- Auth-Codes: single-use, 10 min TTL; Refresh-Rotation invalidiert Altes.
- JWT-Verify prüft iss + aud + exp; Secret nur in .env (chmod 600).
- Login-Formular: keine externen Assets, autocomplete="current-password",
  Rate-Limit gegen Brute-Force; users-Collection bleibt für Tools unerreichbar
  (nicht in `cols()`-Whitelist).
- Tokens/Codes werden nie geloggt (nur E-Mail + Client-ID in Auth-Logs).

## Fehlerbehandlung

- Falsche Credentials / gesperrter / inaktiver User → Login-Seite mit neutraler
  Meldung („E-Mail oder Passwort falsch bzw. Konto gesperrt").
- Rate-Limit überschritten → Login-Seite mit Hinweis, HTTP 429.
- Ungültiger/abgelaufener Code oder Refresh-Token → OAuth-Standardfehler
  (`invalid_grant`) durch SDK-Handler.
- JWT ungültig/abgelaufen auf /mcp → 401 + WWW-Authenticate (claude.ai refresht
  bzw. re-authentifiziert automatisch).

## Tests

- **Unit:** tokens (sign/verify roundtrip, falsches Secret, abgelaufen),
  users (role→scope-Mapping), rateLimit (5. Fehlversuch blockt, Fenster läuft ab),
  unified auth (API-Key-Pfad unverändert, JWT-Pfad, kaputtes Token → null).
- **Integration (echter Mongo, Test-User `test.oauth@mcp-fc.local` wird angelegt
  und im Teardown gelöscht):** kompletter Flow DCR → GET /authorize (Login-Seite)
  → POST /oauth/login → Code aus Redirect → POST /token mit PKCE → /mcp-Call mit
  JWT → Refresh-Rotation (alter Refresh-Token danach ungültig). Negativ: falsches
  Passwort, isLocked-User, falscher PKCE-Verifier, wiederverwendeter Code.
- **Regression:** alle bestehenden 57 Tests bleiben grün; ohne MCP_JWT_SECRET
  bleibt das Verhalten identisch zu v1 (E2E-Test deckt das ab).

## Rollout

1. Server: `git pull`, `npm ci`, `npm run build`; `.env` um MCP_PUBLIC_URL +
   MCP_JWT_SECRET ergänzen; nginx-Config ersetzen + reload; `systemctl restart mcp-fc`.
2. claude.ai → Settings → Connectors → „Add custom connector" →
   `https://mcp.finanz-copilot.de/mcp` → Login mit Finanz-Copilot-Account.
3. Danach auf Web/Desktop/Mobile verfügbar (synchronisiert über den Account).

## Bewusst nicht enthalten (YAGNI)

- Kein Consent-Screen mit Scope-Checkboxen (Scopes folgen der Rolle).
- Kein Token-Introspection-Endpoint, keine Client-Secrets (nur public clients).
- Kein verteiltes Rate-Limit (in-memory reicht für 7 User).
- users-Verwaltung (Anlegen, Sperren, Passwort-Reset) bleibt in der Haupt-App.
