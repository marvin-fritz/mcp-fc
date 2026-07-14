import bcrypt from 'bcryptjs';
import type { Db } from 'mongodb';
import type { Scope } from '../../config.js';
import { MAX_TIME_MS } from '../../db/client.js';
import { escapeRegex } from '../../db/identifiers.js';

export type LoginResult =
  | { ok: true; userId: string; email: string; scopes: Scope[] }
  | { ok: false; reason: 'invalid' | 'locked' };

export function scopesForRole(role: unknown): Scope[] {
  return role === 'admin' ? ['read', 'write'] : ['read'];
}

/** Read-only login check against financecentre.users (bcrypt $2b$ hashes). */
export async function verifyUserLogin(db: Db, email: string, password: string): Promise<LoginResult> {
  const user = await db.collection('users').findOne(
    { email: { $regex: `^${escapeRegex(email.trim())}$`, $options: 'i' } },
    { projection: { password: 1, email: 1, role: 1, isActive: 1, isLocked: 1 }, maxTimeMS: MAX_TIME_MS },
  );
  if (!user || typeof user.password !== 'string') return { ok: false, reason: 'invalid' };
  const match = await bcrypt.compare(password, user.password);
  if (!match) return { ok: false, reason: 'invalid' };
  if (user.isActive === false || user.isLocked === true) return { ok: false, reason: 'locked' };
  return { ok: true, userId: String(user._id), email: String(user.email), scopes: scopesForRole(user.role) };
}
