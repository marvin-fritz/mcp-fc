import { describe, expect, it } from 'vitest';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken, verifyAccessToken } from '../../src/auth/oauth/tokens.js';
import { scopesForRole } from '../../src/auth/oauth/users.js';
import { LoginRateLimiter } from '../../src/auth/oauth/rateLimit.js';
import { renderLoginPage } from '../../src/auth/oauth/loginPage.js';

const SECRET = 'unit-test-secret';
const ISSUER = 'http://test.local';

describe('access tokens', () => {
  it('sign/verify roundtrip preserves claims', async () => {
    const token = await signAccessToken(SECRET, ISSUER, { userId: 'u1', email: 'a@b.de', scopes: ['read'], clientId: 'c1' });
    const v = await verifyAccessToken(SECRET, ISSUER, token);
    expect(v).toMatchObject({ userId: 'u1', email: 'a@b.de', scopes: ['read'], clientId: 'c1' });
    expect(v!.expiresAt).toBeGreaterThan(Date.now() / 1000);
    expect(v!.expiresAt).toBeLessThanOrEqual(Date.now() / 1000 + ACCESS_TOKEN_TTL_SECONDS + 5);
  });

  it('rejects wrong secret and wrong issuer', async () => {
    const token = await signAccessToken(SECRET, ISSUER, { userId: 'u1', email: 'a@b.de', scopes: ['read'], clientId: 'c1' });
    expect(await verifyAccessToken('other', ISSUER, token)).toBeNull();
    expect(await verifyAccessToken(SECRET, 'http://evil.local', token)).toBeNull();
    expect(await verifyAccessToken(SECRET, ISSUER, 'garbage')).toBeNull();
  });
});

describe('scopesForRole', () => {
  it('maps admin to read+write, everyone else to read', () => {
    expect(scopesForRole('admin')).toEqual(['read', 'write']);
    expect(scopesForRole('member')).toEqual(['read']);
    expect(scopesForRole(undefined)).toEqual(['read']);
  });
});

describe('LoginRateLimiter', () => {
  it('blocks after 5 failures within window and unblocks after window', () => {
    const rl = new LoginRateLimiter(5, 1000);
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) {
      expect(rl.isBlocked('k', t0 + i)).toBe(false);
      rl.recordFailure('k', t0 + i);
    }
    expect(rl.isBlocked('k', t0 + 10)).toBe(true);
    expect(rl.isBlocked('k', t0 + 2000)).toBe(false);
  });

  it('reset clears failures', () => {
    const rl = new LoginRateLimiter(1, 1000);
    rl.recordFailure('k', 0);
    expect(rl.isBlocked('k', 1)).toBe(true);
    rl.reset('k');
    expect(rl.isBlocked('k', 2)).toBe(false);
  });
});

describe('renderLoginPage', () => {
  it('contains form fields and escapes html in params', () => {
    const html = renderLoginPage({
      clientName: '<script>x</script>',
      clientId: 'c1',
      redirectUri: 'https://claude.ai/cb',
      codeChallenge: 'ch',
      state: 's"t',
      scopes: ['read'],
      error: 'Fehler & mehr',
      email: 'a@b.de',
    });
    expect(html).toContain('action="/oauth/login"');
    expect(html).toContain('name="password"');
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('Fehler &amp; mehr');
    expect(html).toContain('value="a@b.de"');
  });
});
