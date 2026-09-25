import { describe, expect, it } from 'vitest';
import {
  WINDOWS,
  amountAccumulators,
  amountStage,
  bandMid,
  fmtBand,
  fmtOption,
  fmtTradeAmount,
  fmtUsd,
  medianOf,
  netBand,
  notSuperseded,
  politicianCount,
  sideBand,
  volumeBand,
  windowStart,
} from '../../src/features/political/amounts.js';

describe('fmtUsd', () => {
  it('compacts to k / M / B', () => {
    expect(fmtUsd(0)).toBe('$0');
    expect(fmtUsd(500)).toBe('$500');
    expect(fmtUsd(1_001)).toBe('$1k');
    expect(fmtUsd(15_000)).toBe('$15k');
    expect(fmtUsd(1_000_000)).toBe('$1.0M');
    expect(fmtUsd(50_000_000)).toBe('$50.0M');
    expect(fmtUsd(2_500_000_000)).toBe('$2.5B');
    expect(fmtUsd(-250_000)).toBe('-$250k');
  });
});

describe('fmtBand', () => {
  it('renders a closed band', () => {
    expect(fmtBand({ low: 1_000_000, high: 5_000_000, highOpen: false })).toBe('$1.0M-$5.0M');
  });

  it('renders an open upper bound as ≥ low', () => {
    expect(fmtBand({ low: 50_000_000, high: 50_000_000, highOpen: true })).toBe('≥$50.0M');
  });

  it('renders zero as a dash', () => {
    expect(fmtBand({ low: 0, high: 0, highOpen: false })).toBe('—');
  });

  it('collapses equal bounds', () => {
    expect(fmtBand({ low: 15_000, high: 15_000 })).toBe('$15k');
  });

  it('renders an open lower bound as ≤ high', () => {
    expect(fmtBand({ low: -50_000_000, high: 15_000, lowOpen: true })).toBe('≤$15k');
  });

  it('marks a band open on both sides', () => {
    expect(fmtBand({ low: -1_000_000, high: 1_000_000, highOpen: true, lowOpen: true })).toBe('-$1.0M-$1.0M (open)');
  });
});

describe('fmtTradeAmount', () => {
  it('prefers the exact amount', () => {
    expect(fmtTradeAmount(1_001, 15_000, 12_345)).toBe('$12k');
  });

  it('renders the disclosed class', () => {
    expect(fmtTradeAmount(1_001, 15_000, null)).toBe('$1k-$15k');
  });

  it('renders an open class (no upper bound)', () => {
    expect(fmtTradeAmount(50_000_001, null, null)).toBe('≥$50.0M');
  });

  it('is empty without any amount', () => {
    expect(fmtTradeAmount(null, null, null)).toBe('');
  });
});

describe('netBand / volumeBand', () => {
  it('computes net as [buyLow − sellHigh, buyHigh − sellLow]', () => {
    const row = { buyLow: 100, buyHigh: 300, sellLow: 50, sellHigh: 200, buyOpen: false, sellOpen: false };
    expect(netBand(row)).toEqual({ low: -100, high: 250, highOpen: false, lowOpen: false });
  });

  it('carries open classes to the matching side', () => {
    const row = { buyLow: 50_000_001, buyHigh: 50_000_001, sellLow: 0, sellHigh: 0, buyOpen: true, sellOpen: false };
    expect(netBand(row)).toEqual({ low: 50_000_001, high: 50_000_001, highOpen: true, lowOpen: false });
    expect(netBand({ sellLow: 1_001, sellHigh: 15_000, sellOpen: true })).toMatchObject({ low: -15_000, high: -1_001, lowOpen: true });
  });

  it('defaults missing fields to zero', () => {
    expect(netBand({})).toEqual({ low: 0, high: 0, highOpen: false, lowOpen: false });
    expect(volumeBand({ volLow: 1_001, volHigh: 15_000, open: true })).toEqual({ low: 1_001, high: 15_000, highOpen: true, lowOpen: false });
  });

  it('bandMid is the integer midpoint', () => {
    expect(bandMid({ low: -100, high: 250 })).toBe(75);
  });
});

describe('windowStart', () => {
  const now = new Date('2026-09-25T12:00:00Z');

  it('knows all windows', () => {
    expect(WINDOWS).toEqual(['90d', 'ytd', '1y', 'all']);
  });

  it('90d and 1y count back from now', () => {
    expect(windowStart('90d', now)?.toISOString()).toBe('2026-06-27T12:00:00.000Z');
    expect(windowStart('1y', now)?.toISOString()).toBe('2025-09-25T12:00:00.000Z');
  });

  it('ytd starts on Jan 1 UTC', () => {
    expect(windowStart('ytd', now)?.toISOString()).toBe('2026-01-01T00:00:00.000Z');
  });

  it('all has no start', () => {
    expect(windowStart('all', now)).toBeNull();
  });
});

describe('medianOf / politicianCount', () => {
  it('medianOf ignores nulls', () => {
    expect(medianOf([10, null, 30, 20])).toBe(20);
    expect(medianOf([10, 20])).toBe(15);
    expect(medianOf([null])).toBeNull();
    expect(medianOf(undefined)).toBeNull();
  });

  it('politicianCount ignores null bioguideIds', () => {
    expect(politicianCount(['P000197', null, 'S001234'])).toBe(2);
    expect(politicianCount(undefined)).toBe(0);
  });
});

describe('amountStage / amountAccumulators', () => {
  it('exact amount beats the class, open class falls back to the lower bound', () => {
    const f = (amountStage() as any).$addFields;
    expect(f._lo.$cond[1]).toEqual({ $ifNull: ['$amountExact', '$amountLow'] });
    expect(f._hi.$cond[0]).toEqual({ $gt: [{ $ifNull: ['$amountExact', '$amountHigh'] }, null] });
    expect(f._hi.$cond[2]).toEqual({ $cond: [f._priced, { $ifNull: ['$amountExact', '$amountLow'] }, 0] });
    expect(f._open).toEqual({ $and: [f._priced, { $lte: [{ $ifNull: ['$amountExact', '$amountHigh'] }, null] }] });
  });

  it('buys are P, sells S/SP, E counts for neither side', () => {
    const branches = (amountStage() as any).$addFields._side.$switch.branches;
    expect(branches).toEqual([
      { case: { $in: ['$transactionType', ['P']] }, then: 'buy' },
      { case: { $in: ['$transactionType', ['S', 'SP']] }, then: 'sell' },
    ]);
    expect((amountStage() as any).$addFields._side.$switch.default).toBeNull();
  });

  it('accumulates counts, volume and per-side bands', () => {
    const acc = amountAccumulators() as any;
    expect(Object.keys(acc).sort()).toEqual(
      ['buyCount', 'buyHigh', 'buyLow', 'buyOpen', 'lateKnown', 'onTime', 'open', 'sellCount', 'sellHigh', 'sellLow', 'sellOpen', 'tradeCount', 'unpriced', 'volHigh', 'volLow'].sort(),
    );
    expect(acc.buyLow).toEqual({ $sum: { $cond: [{ $eq: ['$_side', 'buy'] }, '$_lo', 0] } });
    expect(acc.sellHigh).toEqual({ $sum: { $cond: [{ $eq: ['$_side', 'sell'] }, '$_hi', 0] } });
  });
});

describe('sideBand / notSuperseded', () => {
  it('sideBand picks one side of a grouped row', () => {
    const row = { buyLow: 1, buyHigh: 2, buyOpen: true, sellLow: 3, sellHigh: 4 };
    expect(sideBand(row, 'buy')).toEqual({ low: 1, high: 2, highOpen: true, lowOpen: false });
    expect(sideBand(row, 'sell')).toEqual({ low: 3, high: 4, highOpen: false, lowOpen: false });
  });

  it('notSuperseded hides amended originals', () => {
    expect(notSuperseded()).toEqual({ supersededBy: { $exists: false } });
  });
});

describe('fmtOption', () => {
  it('renders a compact option description', () => {
    expect(fmtOption({ action: 'Buy', contracts: 10, callPut: 'CALL', strike: 120, expiry: new Date('2027-01-15T00:00:00Z') }))
      .toBe('call @120 exp 2027-01-15 x10 buy');
  });

  it('skips missing parts and empty options', () => {
    expect(fmtOption({ callPut: 'put' })).toBe('put');
    expect(fmtOption(null)).toBe('');
  });
});
