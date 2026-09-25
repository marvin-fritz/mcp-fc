/**
 * Pure amount/window helpers for congressional trades (no I/O).
 *
 * Amount rules mirror webapi `app/services/congress_calc.py`:
 * - amountExact beats the disclosed class;
 * - a class without upper bound ("over $50M") counts with its lower bound and marks the sum open;
 * - buys = P, sells = S/SP; E (exchange) counts for neither side;
 * - net = [buyLow − sellHigh, buyHigh − sellLow].
 */

export const WINDOWS = ['90d', 'ytd', '1y', 'all'] as const;
export type Window = (typeof WINDOWS)[number];

export const BUY_CODES = ['P'];
export const SELL_CODES = ['S', 'SP'];

export interface Band {
  low: number;
  high: number;
  /** Upper bound unknown (open class on the buy/volume side). */
  highOpen?: boolean;
  /** Lower bound unknown (open class on the sell side of a net band). */
  lowOpen?: boolean;
}

const DAY_MS = 86_400_000;

/** Inclusive start of a window; `all` has none. */
export function windowStart(window: Window, now: Date): Date | null {
  switch (window) {
    case '90d':
      return new Date(now.getTime() - 90 * DAY_MS);
    case '1y':
      return new Date(now.getTime() - 365 * DAY_MS);
    case 'ytd':
      return new Date(Date.UTC(now.getUTCFullYear(), 0, 1));
    case 'all':
      return null;
  }
}

/** Compact USD: $500, $15k, $1.0M, $2.5B. */
export function fmtUsd(v: number): string {
  const sign = v < 0 ? '-' : '';
  const a = Math.abs(v);
  if (a < 1_000) return `${sign}$${Math.round(a)}`;
  if (a < 1_000_000) return `${sign}$${Math.round(a / 1_000)}k`;
  if (a < 1_000_000_000) return `${sign}$${(a / 1_000_000).toFixed(1)}M`;
  return `${sign}$${(a / 1_000_000_000).toFixed(1)}B`;
}

/** Band as text: "$1.0M-$5.0M", open upper bound "≥$50.0M", zero "—". */
export function fmtBand(b: Band): string {
  const { low, high, highOpen = false, lowOpen = false } = b;
  if (low === 0 && high === 0 && !highOpen && !lowOpen) return '—';
  if (highOpen && lowOpen) return `${fmtUsd(low)}-${fmtUsd(high)} (open)`;
  if (highOpen) return `≥${fmtUsd(low)}`;
  if (lowOpen) return `≤${fmtUsd(high)}`;
  if (low === high) return fmtUsd(low);
  return `${fmtUsd(low)}-${fmtUsd(high)}`;
}

/** Amount of a single trade: exact value, disclosed class, or open class. */
export function fmtTradeAmount(low: number | null | undefined, high: number | null | undefined, exact: number | null | undefined): string {
  if (exact != null) return fmtUsd(exact);
  if (low == null && high == null) return '';
  if (high == null) return `≥${fmtUsd(low as number)}`;
  if (low == null) return `≤${fmtUsd(high)}`;
  return `${fmtUsd(low)}-${fmtUsd(high)}`;
}

type Row = Record<string, unknown>;
const n = (row: Row, k: string): number => (typeof row[k] === 'number' ? (row[k] as number) : 0);
const b = (row: Row, k: string): boolean => row[k] === true;

/** Total volume of a grouped row (from amountAccumulators). */
export function volumeBand(row: Row): Required<Band> {
  return { low: n(row, 'volLow'), high: n(row, 'volHigh'), highOpen: b(row, 'open'), lowOpen: false };
}

/** Buy − sell of a grouped row: [buyLow − sellHigh, buyHigh − sellLow]. */
export function netBand(row: Row): Required<Band> {
  return {
    low: n(row, 'buyLow') - n(row, 'sellHigh'),
    high: n(row, 'buyHigh') - n(row, 'sellLow'),
    highOpen: b(row, 'buyOpen'),
    lowOpen: b(row, 'sellOpen'),
  };
}

export function bandMid(band: Band): number {
  return Math.floor((band.low + band.high) / 2);
}

export function medianOf(values: Array<number | null | undefined> | null | undefined): number | null {
  const clean = (values ?? []).filter((v): v is number => typeof v === 'number').sort((x, y) => x - y);
  if (clean.length === 0) return null;
  const mid = Math.floor(clean.length / 2);
  return clean.length % 2 ? clean[mid] : (clean[mid - 1] + clean[mid]) / 2;
}

/** Distinct bioguideIds of a group; trades without politician mapping (null) do not count. */
export function politicianCount(ids: Array<string | null | undefined> | null | undefined): number {
  return (ids ?? []).filter(Boolean).length;
}

// ── Mongo expressions ───────────────────────────────────────────────
// Comparisons against null via $gt/$lte: missing fields sort before null in BSON.

const LO = { $ifNull: ['$amountExact', '$amountLow'] };
const HI = { $ifNull: ['$amountExact', '$amountHigh'] };

/** $addFields stage: per-trade _lo/_hi/_open/_side/_onTime/_lateKnown. */
export function amountStage(): Record<string, unknown> {
  const priced = { $gt: [LO, null] };
  return {
    $addFields: {
      _priced: priced,
      _lo: { $cond: [priced, LO, 0] },
      _hi: { $cond: [{ $gt: [HI, null] }, HI, { $cond: [priced, LO, 0] }] },
      _open: { $and: [priced, { $lte: [HI, null] }] },
      _side: {
        $switch: {
          branches: [
            { case: { $in: ['$transactionType', BUY_CODES] }, then: 'buy' },
            { case: { $in: ['$transactionType', SELL_CODES] }, then: 'sell' },
          ],
          default: null,
        },
      },
      _onTime: { $cond: [{ $eq: ['$isLate', false] }, 1, 0] },
      _lateKnown: { $cond: [{ $eq: [{ $type: '$isLate' }, 'bool'] }, 1, 0] },
    },
  };
}

const side = (name: string, value: unknown) => ({ $cond: [{ $eq: ['$_side', name] }, value, 0] });

/** $group accumulators over amountStage() fields. */
export function amountAccumulators(): Record<string, unknown> {
  return {
    tradeCount: { $sum: 1 },
    unpriced: { $sum: { $cond: ['$_priced', 0, 1] } },
    volLow: { $sum: '$_lo' },
    volHigh: { $sum: '$_hi' },
    open: { $max: '$_open' },
    buyCount: { $sum: side('buy', 1) },
    sellCount: { $sum: side('sell', 1) },
    buyLow: { $sum: side('buy', '$_lo') },
    buyHigh: { $sum: side('buy', '$_hi') },
    sellLow: { $sum: side('sell', '$_lo') },
    sellHigh: { $sum: side('sell', '$_hi') },
    buyOpen: { $max: { $and: [{ $eq: ['$_side', 'buy'] }, '$_open'] } },
    sellOpen: { $max: { $and: [{ $eq: ['$_side', 'sell'] }, '$_open'] } },
    onTime: { $sum: '$_onTime' },
    lateKnown: { $sum: '$_lateKnown' },
  };
}
