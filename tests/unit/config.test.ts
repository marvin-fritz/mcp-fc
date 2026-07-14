import { describe, expect, it } from 'vitest';
import { loadConfig, parseApiKeys } from '../../src/config.js';

describe('parseApiKeys', () => {
  it('parses names, keys and scopes', () => {
    const keys = parseApiKeys('agent1:sk_abc=read+write, agent2:sk_def=read');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatchObject({ name: 'agent1', key: 'sk_abc' });
    expect(keys[0].scopes.has('write')).toBe(true);
    expect(keys[1].scopes.has('write')).toBe(false);
    expect(keys[1].scopes.has('read')).toBe(true);
  });

  it('rejects malformed entries and unknown scopes', () => {
    expect(() => parseApiKeys('no-separator')).toThrow(/invalid/i);
    expect(() => parseApiKeys('a:k=admin')).toThrow(/scope/i);
  });
});

describe('loadConfig', () => {
  it('applies defaults and parses env', () => {
    const c = loadConfig({ MCP_API_KEYS: 'a:k=read' });
    expect(c.port).toBe(8814);
    expect(c.mongoUri).toBe('mongodb://127.0.0.1:27017');
    expect(c.mongoDb).toBe('financecentre');
    expect(c.authDisabled).toBe(false);
    expect(c.apiKeys).toHaveLength(1);
  });

  it('requires keys unless auth is disabled', () => {
    expect(() => loadConfig({})).toThrow(/MCP_API_KEYS/);
    expect(loadConfig({ MCP_AUTH_DISABLED: 'true' }).authDisabled).toBe(true);
  });
});
