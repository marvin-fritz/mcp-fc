import type { RequestHandler } from 'express';
import type { Config, Scope } from '../config.js';
import { authenticate, type AuthContext } from './apiKey.js';
import type { McpOAuthProvider } from './oauth/provider.js';

/** Bearer auth for /mcp: API key first, then OAuth JWT. 401s advertise the OAuth resource metadata. */
export function makeUnifiedAuthMiddleware(config: Config, provider: McpOAuthProvider | null): RequestHandler {
  const metadataUrl = `${config.publicUrl}/.well-known/oauth-protected-resource`;
  return async (req, res, next) => {
    if (config.authDisabled) {
      res.locals.auth = { keyName: 'dev', scopes: new Set<Scope>(['read', 'write']) } satisfies AuthContext;
      next();
      return;
    }
    const header = req.headers.authorization;
    const viaKey = authenticate(header, config.apiKeys);
    if (viaKey) {
      res.locals.auth = viaKey;
      next();
      return;
    }
    if (provider && header?.startsWith('Bearer ')) {
      try {
        const info = await provider.verifyAccessToken(header.slice('Bearer '.length).trim());
        res.locals.auth = {
          keyName: String(info.extra?.email ?? info.clientId),
          scopes: new Set(info.scopes as Scope[]),
        } satisfies AuthContext;
        next();
        return;
      } catch {
        // invalid JWT — fall through to 401
      }
    }
    res.set('WWW-Authenticate', `Bearer resource_metadata="${metadataUrl}"`);
    res.status(401).json({ error: 'unauthorized' });
  };
}
