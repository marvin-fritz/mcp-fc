import { Router, urlencoded } from 'express';
import type { Db } from 'mongodb';
import type { Logger } from 'pino';
import { AuthStore } from './store.js';
import { verifyUserLogin } from './users.js';
import { LoginRateLimiter } from './rateLimit.js';
import { renderLoginPage } from './loginPage.js';

export interface LoginRouteDeps {
  store: AuthStore;
  /** financecentre db (users lookup, read-only) */
  usersDb: Db;
  log: Logger;
}

/** Handles the credentials POST from the login page rendered by McpOAuthProvider.authorize(). */
export function makeLoginRouter(deps: LoginRouteDeps): Router {
  const router = Router();
  const limiter = new LoginRateLimiter();

  router.post('/oauth/login', urlencoded({ extended: false }), async (req, res) => {
    const b = (req.body ?? {}) as Record<string, string>;
    const clientId = String(b.client_id ?? '');
    const redirectUri = String(b.redirect_uri ?? '');
    const codeChallenge = String(b.code_challenge ?? '');
    const state = b.state ? String(b.state) : undefined;
    const scopes = String(b.scope ?? '').split(' ').filter(Boolean);
    const resource = b.resource ? String(b.resource) : undefined;
    const email = String(b.email ?? '');
    const password = String(b.password ?? '');

    // Re-validate client + redirect_uri against the registered client (form fields are attacker-controlled).
    const client = await deps.store.clients.getClient(clientId);
    if (!client || !codeChallenge || !client.redirect_uris.includes(redirectUri)) {
      res.status(400).json({ error: 'invalid_request' });
      return;
    }

    const page = (error: string, status = 200): void => {
      res.status(status).type('html').send(
        renderLoginPage({
          clientName: client.client_name ?? client.client_id,
          clientId,
          redirectUri,
          codeChallenge,
          state,
          scopes,
          resource,
          error,
          email,
        }),
      );
    };

    const rlKey = `${email.trim().toLowerCase()}|${req.ip}`;
    if (limiter.isBlocked(rlKey)) {
      page('Zu viele Fehlversuche — bitte in 15 Minuten erneut versuchen.', 429);
      return;
    }

    const result = await verifyUserLogin(deps.usersDb, email, password);
    if (!result.ok) {
      limiter.recordFailure(rlKey);
      deps.log.warn({ email: email.trim().toLowerCase(), reason: result.reason }, 'oauth login failed');
      page('E-Mail oder Passwort falsch bzw. Konto gesperrt.');
      return;
    }

    limiter.reset(rlKey);
    // Scopes follow the account role (spec) — the client's requested scopes are informational only.
    const code = await deps.store.createCode({
      clientId,
      userId: result.userId,
      email: result.email,
      scopes: result.scopes,
      codeChallenge,
      redirectUri,
      resource,
    });
    const url = new URL(redirectUri);
    url.searchParams.set('code', code);
    if (state) url.searchParams.set('state', state);
    deps.log.info({ email: result.email, client: clientId }, 'oauth login ok');
    res.redirect(url.toString());
  });

  return router;
}
