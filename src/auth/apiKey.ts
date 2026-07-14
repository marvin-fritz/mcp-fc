import { createHash, timingSafeEqual } from 'node:crypto';
import type { ApiKeyDef, Scope } from '../config.js';

export interface AuthContext {
  keyName: string;
  scopes: Set<Scope>;
}

const sha256 = (s: string): Buffer => createHash('sha256').update(s).digest();

export function authenticate(header: string | undefined, keys: ApiKeyDef[]): AuthContext | null {
  if (!header?.startsWith('Bearer ')) return null;
  const presented = sha256(header.slice('Bearer '.length).trim());
  for (const k of keys) {
    if (timingSafeEqual(presented, sha256(k.key))) {
      return { keyName: k.name, scopes: k.scopes };
    }
  }
  return null;
}
