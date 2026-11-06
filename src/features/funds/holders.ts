import type { Document } from 'mongodb';

/**
 * Active 13F filings only: a RESTATEMENT replaces earlier filings of the same period
 * (Kraken sets supersededBy on them). `null` also matches the missing field.
 */
export const ACTIVE = { supersededBy: null } as const;

/**
 * Time budget of the holders aggregation only (the global MAX_TIME_MS is 5 s). It has to read
 * every active filing of the period that holds the security, each with all embedded holdings:
 * for AAPL that is ~6,000 of ~9,000 filings per quarter, measured 1.7–6.4 s on prod
 * (2026-11-06). An index hint does not help — `holdings.cusip` alone spans all periods.
 */
export const HOLDERS_MAX_TIME_MS = 25_000;

/** Full snapshots of a period: originals and RESTATEMENTs, not NEW HOLDINGS amendments. */
export const FULL_SNAPSHOT: Document = {
  $or: [{ formType: { $ne: '13F-HR/A' } }, { amendmentType: { $ne: 'NEW HOLDINGS' } }],
};

/**
 * 13F lists securities by CUSIP; for CUSIP-based ISINs (US, CA) the CUSIP is characters 3–11.
 * Kraken derives holdings.isin from the CUSIP, and filings stored before that backfill have no
 * ISIN at all — matching the CUSIP finds them too.
 */
export function cusipFromIsin(isin: string): string | null {
  return /^(US|CA)[0-9A-Z]{9}[0-9]$/.test(isin) ? isin.slice(2, 11) : null;
}

/**
 * Top holders of one security in one report period: active filings, share positions only
 * (puts/calls excluded), one row per filer — a 13F lists a security once per manager or
 * discretion split, and NEW HOLDINGS amendments add to the original of the same period.
 */
export function holdersPipeline(period: string, isin: string, cusip: string | null, limit: number): Document[] {
  const field = cusip ? 'cusip' : 'isin';
  const value = cusip ?? isin;
  return [
    { $match: { reportPeriod: period, ...ACTIVE, [`holdings.${field}`]: value } },
    {
      $project: {
        companyName: 1,
        cik: 1,
        h: {
          $filter: {
            input: '$holdings',
            cond: { $and: [{ $eq: [`$$this.${field}`, value] }, { $eq: [{ $ifNull: ['$$this.putCall', null] }, null] }] },
          },
        },
      },
    },
    { $unwind: '$h' },
    {
      $group: {
        _id: '$cik',
        companyName: { $first: '$companyName' },
        valueUsd: { $sum: '$h.valueUsd' },
        shares: { $sum: '$h.shares' },
      },
    },
    { $sort: { valueUsd: -1, _id: 1 } },
    { $limit: limit },
    { $project: { _id: 0, cik: '$_id', companyName: 1, valueUsd: 1, shares: 1 } },
  ];
}
