import { describe, expect, it } from 'vitest';
import { authenticate } from '../../src/auth/apiKey.js';
import type { ApiKeyDef } from '../../src/config.js';

const keys: ApiKeyDef[] = [
  { name: 'agent1', key: 'sk_abc123', scopes: new Set(['read']) },
  { name: 'agent2', key: 'sk_def456', scopes: new Set(['read', 'write']) },
];

describe('authenticate', () => {
  it('accepts a valid bearer key and returns its context', () => {
    const ctx = authenticate('Bearer sk_def456', keys);
    expect(ctx?.keyName).toBe('agent2');
    expect(ctx?.scopes.has('write')).toBe(true);
  });

  it('rejects missing header, wrong scheme, unknown key', () => {
    expect(authenticate(undefined, keys)).toBeNull();
    expect(authenticate('Basic sk_abc123', keys)).toBeNull();
    expect(authenticate('Bearer nope', keys)).toBeNull();
    expect(authenticate('Bearer sk_abc12', keys)).toBeNull();
  });
});
