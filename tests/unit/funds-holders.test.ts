import { describe, expect, it } from 'vitest';
import { ACTIVE, cusipFromIsin, holdersPipeline } from '../../src/features/funds/holders.js';

describe('cusipFromIsin', () => {
  it('extracts the CUSIP from US and CA ISINs', () => {
    expect(cusipFromIsin('US0378331005')).toBe('037833100');
    expect(cusipFromIsin('CA82509L1076')).toBe('82509L107');
  });

  it('returns null for ISINs that are not CUSIP based', () => {
    expect(cusipFromIsin('IE00B4BNMY34')).toBeNull();
    expect(cusipFromIsin('DE0007037129')).toBeNull();
    expect(cusipFromIsin('US037833100')).toBeNull();
  });
});

describe('holdersPipeline', () => {
  const [match, project, , group] = holdersPipeline('2025-12-31', 'US0378331005', '037833100', 50);

  it('matches active filings of the period by CUSIP', () => {
    // ISINs are derived from the CUSIP; filings stored before the ISIN backfill have none
    expect(match.$match).toEqual({ reportPeriod: '2025-12-31', ...ACTIVE, 'holdings.cusip': '037833100' });
    expect(ACTIVE).toEqual({ supersededBy: null });
  });

  it('keeps share positions only (no puts/calls)', () => {
    const cond = project.$project.h.$filter.cond;
    expect(cond.$and).toContainEqual({ $eq: [{ $ifNull: ['$$this.putCall', null] }, null] });
  });

  it('sums all rows of one filer', () => {
    expect(group.$group._id).toBe('$cik');
    expect(group.$group.shares).toEqual({ $sum: '$h.shares' });
  });

  it('falls back to the ISIN when no CUSIP can be derived', () => {
    const [m] = holdersPipeline('2025-12-31', 'IE00B4BNMY34', null, 50);
    expect(m.$match['holdings.isin']).toBe('IE00B4BNMY34');
    expect(m.$match['holdings.cusip']).toBeUndefined();
  });
});
