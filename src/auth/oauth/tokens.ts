import { SignJWT, jwtVerify } from 'jose';
import type { Scope } from '../../config.js';

export const ACCESS_TOKEN_TTL_SECONDS = 3600;
const AUDIENCE = 'mcp-fc';

export interface AccessTokenClaims {
  userId: string;
  email: string;
  scopes: Scope[];
  clientId: string;
}

export interface VerifiedAccessToken extends AccessTokenClaims {
  /** seconds since epoch */
  expiresAt: number;
}

const key = (secret: string) => new TextEncoder().encode(secret);

export async function signAccessToken(secret: string, issuer: string, claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ email: claims.email, scope: claims.scopes.join(' '), client_id: claims.clientId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(claims.userId)
    .setIssuer(issuer)
    .setAudience(AUDIENCE)
    .setIssuedAt()
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(key(secret));
}

export async function verifyAccessToken(secret: string, issuer: string, token: string): Promise<VerifiedAccessToken | null> {
  try {
    const { payload } = await jwtVerify(token, key(secret), { issuer, audience: AUDIENCE });
    if (!payload.sub || typeof payload.email !== 'string') return null;
    return {
      userId: payload.sub,
      email: payload.email,
      scopes: String(payload.scope ?? '').split(' ').filter(Boolean) as Scope[],
      clientId: String(payload.client_id ?? ''),
      expiresAt: payload.exp ?? 0,
    };
  } catch {
    return null;
  }
}
