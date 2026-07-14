import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { OAuthClientInformationFull, OAuthTokenRevocationRequest, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { Scope } from '../../config.js';
import { AuthStore } from './store.js';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken, verifyAccessToken } from './tokens.js';
import { renderLoginPage } from './loginPage.js';

export interface OAuthProviderDeps {
  store: AuthStore;
  jwtSecret: string;
  issuer: string;
}

/** OAuth 2.1 provider: login against finanz-copilot users, JWT access tokens, rotating refresh tokens. */
export class McpOAuthProvider implements OAuthServerProvider {
  constructor(private deps: OAuthProviderDeps) {}

  get clientsStore(): OAuthRegisteredClientsStore {
    return this.deps.store.clients;
  }

  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    res.status(200).type('html').send(
      renderLoginPage({
        clientName: client.client_name ?? client.client_id,
        clientId: client.client_id,
        redirectUri: params.redirectUri,
        codeChallenge: params.codeChallenge,
        state: params.state,
        scopes: params.scopes ?? [],
        resource: params.resource?.toString(),
      }),
    );
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    const doc = await this.deps.store.peekCode(authorizationCode);
    if (!doc || doc.clientId !== client.client_id) throw new InvalidGrantError('invalid authorization code');
    return doc.codeChallenge;
  }

  async exchangeAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<OAuthTokens> {
    const doc = await this.deps.store.consumeCode(authorizationCode);
    if (!doc || doc.clientId !== client.client_id) throw new InvalidGrantError('invalid authorization code');
    return this.issueTokens(client.client_id, doc.userId, doc.email, doc.scopes);
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const rotated = await this.deps.store.rotateRefreshToken(refreshToken, client.client_id);
    if (!rotated) throw new InvalidGrantError('invalid refresh token');
    const accessToken = await signAccessToken(this.deps.jwtSecret, this.deps.issuer, {
      userId: rotated.doc.userId,
      email: rotated.doc.email,
      scopes: rotated.doc.scopes,
      clientId: client.client_id,
    });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: rotated.next,
      scope: rotated.doc.scopes.join(' '),
    };
  }

  async verifyAccessToken(token: string): Promise<AuthInfo> {
    const v = await verifyAccessToken(this.deps.jwtSecret, this.deps.issuer, token);
    if (!v) throw new InvalidTokenError('invalid or expired token');
    return { token, clientId: v.clientId, scopes: v.scopes, expiresAt: v.expiresAt, extra: { email: v.email, userId: v.userId } };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: OAuthTokenRevocationRequest): Promise<void> {
    await this.deps.store.revokeRefreshToken(request.token);
  }

  private async issueTokens(clientId: string, userId: string, email: string, scopes: Scope[]): Promise<OAuthTokens> {
    const accessToken = await signAccessToken(this.deps.jwtSecret, this.deps.issuer, { userId, email, scopes, clientId });
    const refreshToken = await this.deps.store.createRefreshToken({ clientId, userId, email, scopes });
    return {
      access_token: accessToken,
      token_type: 'bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope: scopes.join(' '),
    };
  }
}
