import { describe, expect, it } from 'vitest';
import { buildInsiderFilter } from '../../src/features/insider/index.js';

describe('buildInsiderFilter', () => {
  it('always excludes trades replaced by a correction notice', () => {
    expect(buildInsiderFilter({})).toEqual({ supersededBy: null });
    expect(buildInsiderFilter({ transactionType: 'BUY' }, 'CH0012627250')).toEqual({
      supersededBy: null,
      isin: 'CH0012627250',
      transactionType: 'BUY',
    });
  });

  it('keeps date range and amount filters', () => {
    const filter = buildInsiderFilter({ from: '2026-01-01', to: '2026-01-31', minAmount: 1000 });
    expect(filter.supersededBy).toBeNull();
    expect(filter.transactionDate).toEqual({
      $gte: new Date('2026-01-01T00:00:00Z'),
      $lte: new Date('2026-01-31T23:59:59.999Z'),
    });
    expect(filter.totalAmount).toEqual({ $gte: 1000 });
  });
});
