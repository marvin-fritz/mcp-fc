import type { Db, Document } from 'mongodb';
import { MAX_TIME_MS } from './client.js';
import { cols } from './collections.js';

export interface SecurityRef {
  isin: string;
  ticker: string | null;
  name: string;
  cik: number | null;
}

export const ISIN_RE = /^[A-Z]{2}[A-Z0-9]{9}[0-9]$/;

export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const PROJECTION = { projection: { isin: 1, ticker: 1, name: 1, 'identifiers.cik': 1 }, maxTimeMS: MAX_TIME_MS };

/** Resolve ISIN, ticker or name substring to a security via stockIndex. */
export async function resolveSecurity(db: Db, identifier: string): Promise<SecurityRef | null> {
  const c = cols(db).stockIndex;
  const id = identifier.trim();
  const upper = id.toUpperCase();
  let doc: Document | null = null;
  if (ISIN_RE.test(upper)) doc = await c.findOne({ isin: upper }, PROJECTION);
  if (!doc) doc = await c.findOne({ ticker: upper }, PROJECTION);
  if (!doc) doc = await c.findOne({ name: { $regex: escapeRegex(id), $options: 'i' } }, PROJECTION);
  if (!doc) return null;
  return {
    isin: doc.isin,
    ticker: doc.ticker ?? null,
    name: doc.name,
    cik: doc.identifiers?.cik ?? null,
  };
}
