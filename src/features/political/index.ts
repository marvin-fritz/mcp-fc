import type { Db, Document } from 'mongodb';
import { z } from 'zod';
import { MAX_TIME_MS } from '../../db/client.js';
import { cols } from '../../db/collections.js';
import { ISIN_RE, escapeRegex, resolveSecurity } from '../../db/identifiers.js';
import { kv } from '../../format/kv.js';
import { fmtDate, fmtPct } from '../../format/num.js';
import { table } from '../../format/table.js';
import { ToolError, type FeatureModule } from '../types.js';
import {
  WINDOWS,
  amountAccumulators,
  amountStage,
  bandMid,
  fmtBand,
  fmtOption,
  fmtTradeAmount,
  medianOf,
  netBand,
  notSuperseded,
  politicianCount,
  sideBand,
  volumeBand,
  windowStart,
  type Window,
} from './amounts.js';

const BIOGUIDE_RE = /^[A-Z]\d{6}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 86_400_000;

const POLITICIAN_PROJECTION = {
  _id: 0,
  bioguideId: 1,
  fullName: 1,
  party: 1,
  chamber: 1,
  state: 1,
  district: 1,
  inOffice: 1,
  committees: 1,
};

const TRADE_PROJECTION = {
  _id: 0,
  transactionDate: 1,
  publishedAt: 1,
  reportingLagDays: 1,
  filerName: 1,
  bioguideId: 1,
  party: 1,
  chamber: 1,
  ticker: 1,
  isin: 1,
  assetName: 1,
  issuerName: 1,
  assetType: 1,
  transactionType: 1,
  amountLow: 1,
  amountHigh: 1,
  amountExact: 1,
  owner: 1,
  isLate: 1,
  option: 1,
};

/** Security key for rollups: ISIN, else ticker, else disclosed asset name. */
const SECURITY_KEY = { $ifNull: ['$isin', { $ifNull: ['$ticker', '$assetName'] }] };
const SECURITY_EXTRA = {
  isin: { $max: '$isin' },
  ticker: { $max: '$ticker' },
  name: { $max: { $ifNull: ['$issuerName', '$assetName'] } },
};

const yesNo = (v: unknown) => (v === true ? 'yes' : v === false ? 'no' : '');
const clip = (v: unknown) => (typeof v === 'string' ? v.slice(0, 40) : (v as string | null | undefined));
const dayStart = (d: string) => new Date(`${d}T00:00:00.000Z`);
const dayEnd = (d: string) => new Date(`${d}T23:59:59.999Z`);

/** Politicians whose name or alias contains `q`, or the one with bioguide ID `q`. */
async function findPoliticians(db: Db, q: string, limit: number): Promise<Document[]> {
  const id = q.trim().toUpperCase();
  let filter: Document;
  if (BIOGUIDE_RE.test(id)) {
    filter = { bioguideId: id };
  } else {
    const re = { $regex: escapeRegex(q.trim()), $options: 'i' };
    filter = { $or: [{ fullName: re }, { aliases: re }] };
  }
  return cols(db).politicians.find(filter, { projection: POLITICIAN_PROJECTION, limit, maxTimeMS: MAX_TIME_MS }).toArray();
}

function seat(p: Document): string | null {
  if (!p.state) return null;
  return p.district != null ? `${p.state}-${p.district}` : p.state;
}

function politicianLabel(p: Document): string {
  return `${p.fullName} (${p.bioguideId}, ${[p.party, seat(p), p.chamber].filter(Boolean).join(' ')})`;
}

/** Committees first, then subcommittees; "name (title)". */
function fmtCommittees(list: unknown): string {
  if (!Array.isArray(list)) return '';
  const sorted = list.filter((c) => c?.name).sort((a, b) => Number(a.parentCode != null) - Number(b.parentCode != null));
  const items = sorted.slice(0, 15).map((c) => (c.title ? `${c.name} (${c.title})` : c.name));
  const more = sorted.length > 15 ? `; +${sorted.length - 15} more` : '';
  return items.join('; ') + more;
}

function grouped(match: Document, key: unknown, extra: Document = {}): Document[] {
  return [{ $match: match }, amountStage(), { $group: { _id: key, ...amountAccumulators(), ...extra } }];
}

async function agg(db: Db, pipeline: Document[]): Promise<Document[]> {
  return cols(db).politicalTrades.aggregate(pipeline, { maxTimeMS: MAX_TIME_MS }).toArray();
}

/**
 * Congress lines for get_security_snapshot: trades of the last 90 days (transaction date)
 * on one ISIN. Empty when there are none, so the lines drop out of the kv block.
 */
export async function congressSnapshot(db: Db, isin: string, now = new Date()): Promise<Array<[string, unknown]>> {
  const [row] = await agg(db, [
    { $match: { ...notSuperseded(), isin, transactionDate: { $gte: new Date(now.getTime() - 90 * DAY_MS) } } },
    { $sort: { transactionDate: -1 } },
    amountStage(),
    {
      $group: {
        _id: null,
        ...amountAccumulators(),
        politicians: { $addToSet: '$bioguideId' },
        lastDate: { $first: '$transactionDate' },
        lastName: { $first: '$filerName' },
        lastType: { $first: '$transactionType' },
      },
    },
  ]);
  if (!row) return [];
  return [
    ['congressTrades90d', `${row.tradeCount} (${row.buyCount} buys, ${row.sellCount} sells, ${politicianCount(row.politicians)} politicians)`],
    ['congressNet90d', fmtBand(netBand(row))],
    ['congressLastTrade', [fmtDate(row.lastDate), row.lastName, row.lastType ? `(${row.lastType})` : null].filter(Boolean).join(' ')],
  ];
}

const AMOUNT_NOTE =
  'Amounts are disclosed ranges (bands), never exact values: "≥" marks an open "over" class; net = [buyLow − sellHigh, buyHigh − sellLow]. Buys = P, sells = S/SP; E (exchange) counts for neither side. Amended originals are excluded.';

export const politicalFeature: FeatureModule = {
  name: 'political',
  tools: [
    {
      name: 'get_political_trades',
      title: 'Congressional trades',
      description:
        'Trades disclosed by US Congress members (one row per trade line), newest transaction date first. transactionType: P=purchase, S=sale, SP=partial sale, E=exchange. amount is the disclosed range (exact when disclosed, "≥" for open classes) — never a precise value. published = date the disclosure became public, lagDays = days from trade to disclosure, late = filed after the 45-day deadline. Option details follow the asset name in brackets. Amended originals are hidden. politician = name part or bioguide ID; identifier = ISIN, ticker or name; from/to filter the transaction date. Example: {"politician":"Pelosi"} or {"identifier":"NVDA","transactionType":"P","from":"2026-01-01"}',
      inputSchema: {
        politician: z.string().min(1).optional().describe('name part or bioguide ID (e.g. P000197)'),
        identifier: z.string().min(1).optional().describe('stock ISIN, ticker or name'),
        chamber: z.enum(['house', 'senate']).optional(),
        party: z.enum(['R', 'D', 'I']).optional().describe('party of the politician'),
        state: z.string().regex(/^[A-Za-z]{2}$/).optional().describe('two-letter US state, e.g. CA'),
        transactionType: z.enum(['P', 'S', 'SP', 'E']).optional().describe('P=purchase, S=sale, SP=partial sale, E=exchange'),
        owner: z.enum(['self', 'SP', 'JT', 'DC']).optional().describe('owner: self, SP=spouse, JT=joint, DC=dependent child'),
        assetType: z.string().min(1).optional().describe('e.g. stock, option'),
        from: z.string().regex(DATE_RE).optional().describe('min transaction date YYYY-MM-DD'),
        to: z.string().regex(DATE_RE).optional().describe('max transaction date YYYY-MM-DD'),
        limit: z.number().int().min(1).optional().describe('default 25, max 100'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const lim = Math.min(input.limit ?? 25, 100);
        const match: Document = notSuperseded();
        if (input.politician) {
          const id = input.politician.trim().toUpperCase();
          if (BIOGUIDE_RE.test(id)) {
            match.bioguideId = id;
          } else {
            const ids = (await findPoliticians(db, input.politician, 50)).map((p) => p.bioguideId);
            // Unknown to the politicians master data: fall back to the name on the filing.
            if (ids.length > 0) match.bioguideId = { $in: ids };
            else match.filerName = { $regex: escapeRegex(input.politician.trim()), $options: 'i' };
          }
        }
        let idLabel: string | null = null;
        if (input.identifier) {
          const upper = input.identifier.trim().toUpperCase();
          if (ISIN_RE.test(upper)) {
            match.isin = upper;
            idLabel = upper;
          } else {
            const ref = await resolveSecurity(db, input.identifier);
            if (ref) {
              // Trades ohne ISIN (Auflösung fehlgeschlagen) tragen oft trotzdem den Ticker.
              idLabel = ref.isin;
              match.$or = ref.ticker ? [{ isin: ref.isin }, { ticker: ref.ticker }] : [{ isin: ref.isin }];
            } else {
              match.ticker = idLabel = upper;
            }
          }
        }
        if (input.chamber) match.chamber = input.chamber;
        if (input.party) match.party = input.party;
        if (input.state) match.state = input.state.toUpperCase();
        if (input.transactionType) match.transactionType = input.transactionType;
        if (input.owner) match.owner = input.owner;
        if (input.assetType) match.assetType = input.assetType.toLowerCase();
        if (input.from || input.to) {
          match.transactionDate = {
            ...(input.from ? { $gte: dayStart(input.from) } : {}),
            ...(input.to ? { $lte: dayEnd(input.to) } : {}),
          };
        }
        const rows = await cols(db)
          .politicalTrades.find(match, {
            projection: TRADE_PROJECTION,
            sort: { transactionDate: -1, tradeKey: -1 },
            limit: lim + 1,
            maxTimeMS: MAX_TIME_MS,
          })
          .toArray();
        if (rows.length === 0) {
          const activeFilters: string[] = [];
          if (input.politician) activeFilters.push(`politician '${input.politician}'`);
          if (input.identifier) activeFilters.push(`identifier '${idLabel ?? input.identifier}'`);
          if (input.chamber) activeFilters.push(`chamber '${input.chamber}'`);
          if (input.party) activeFilters.push(`party '${input.party}'`);
          if (input.state) activeFilters.push(`state '${input.state.toUpperCase()}'`);
          if (input.transactionType) activeFilters.push(`transactionType '${input.transactionType}'`);
          if (input.owner) activeFilters.push(`owner '${input.owner}'`);
          if (input.assetType) activeFilters.push(`assetType '${input.assetType}'`);
          if (input.from) activeFilters.push(`from '${input.from}'`);
          if (input.to) activeFilters.push(`to '${input.to}'`);
          // No filters set: an empty table is a legitimate (if unlikely) answer.
          // Any filter set: a bare empty table is more likely a typo/mismatch,
          // so name every active filter to help the agent correct the call.
          if (activeFilters.length > 0) {
            throw new ToolError(`no congressional trades match ${activeFilters.join(', ')}`);
          }
        }
        const hasMore = rows.length > lim;
        return table(
          ['txDate', 'published', 'lagDays', 'politician', 'bioguideId', 'party', 'chamber', 'ticker', 'isin', 'asset', 'assetType', 'type', 'amount', 'owner', 'late'],
          rows.slice(0, lim).map((r) => {
            const asset = clip(r.issuerName ?? r.assetName);
            const opt = fmtOption(r.option);
            return [
              fmtDate(r.transactionDate),
              fmtDate(r.publishedAt),
              r.reportingLagDays,
              r.filerName,
              r.bioguideId,
              r.party,
              r.chamber,
              r.ticker,
              r.isin,
              opt ? `${asset ?? ''} [${opt}]` : asset,
              r.assetType,
              r.transactionType,
              fmtTradeAmount(r.amountLow, r.amountHigh, r.amountExact),
              r.owner,
              yesNo(r.isLate),
            ];
          }),
          { hasMore },
        );
      },
    },
    {
      name: 'get_politician_profile',
      title: 'Politician profile',
      description: `Profile of one US Congress member: master data, committees (with titles), trade statistics within a window by transaction date (trades, buys/sells, volume band, net band, share filed on time, median reporting lag in days, last trade, top sectors) plus a table of the top 10 securities by volume (trades, volume band, net band). ${AMOUNT_NOTE} window: 90d|ytd|1y|all (default all). politician = name part or bioguide ID; an ambiguous name returns the candidate list. Example: {"politician":"Pelosi"} or {"politician":"P000197","window":"1y"}`,
      inputSchema: {
        politician: z.string().min(1).describe('name part or bioguide ID (e.g. P000197)'),
        window: z.enum(WINDOWS).optional().describe('90d|ytd|1y|all, default all'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const window: Window = input.window ?? 'all';
        const q = String(input.politician).trim();
        const candidates = await findPoliticians(db, q, 11);
        if (candidates.length === 0) {
          throw new ToolError(`unknown politician '${q}' — try a last name or a bioguide ID (e.g. P000197)`);
        }
        let pol = candidates[0];
        if (candidates.length > 1) {
          const exact = candidates.filter((c) => String(c.fullName ?? '').toLowerCase() === q.toLowerCase());
          if (exact.length !== 1) {
            const list = candidates.slice(0, 10).map(politicianLabel).join('; ');
            const more = candidates.length > 10 ? '; …' : '';
            throw new ToolError(`'${q}' is ambiguous: ${list}${more} — pass a bioguide ID`);
          }
          pol = exact[0];
        }
        const match: Document = { ...notSuperseded(), bioguideId: pol.bioguideId };
        const start = windowStart(window, new Date());
        if (start) match.transactionDate = { $gte: start };
        const [[overall], sectors, securities] = await Promise.all([
          agg(
            db,
            grouped(match, null, {
              lastTradeDate: { $max: '$transactionDate' },
              // Reporting lag only for trades with a trustworthy date (as webapi).
              lags: { $push: { $cond: [{ $ne: ['$quality.dateSuspect', true] }, '$reportingLagDays', '$$REMOVE'] } },
            }),
          ),
          agg(db, [...grouped(match, '$sector'), { $match: { _id: { $ne: null } } }, { $sort: { tradeCount: -1, volHigh: -1 } }, { $limit: 5 }]),
          agg(db, [...grouped(match, SECURITY_KEY, SECURITY_EXTRA), { $sort: { volHigh: -1, tradeCount: -1 } }, { $limit: 10 }]),
        ]);
        const row: Document = overall ?? {};
        const lateKnown = Number(row.lateKnown ?? 0);
        const unpriced = Number(row.unpriced ?? 0);
        const head = kv([
          ['name', pol.fullName],
          ['bioguideId', pol.bioguideId],
          ['party', pol.party],
          ['chamber', pol.chamber],
          ['state', seat(pol)],
          ['inOffice', yesNo(pol.inOffice)],
          ['committees', fmtCommittees(pol.committees)],
          ['window', `${window} (by transaction date)`],
          ['trades', `${row.tradeCount ?? 0}${unpriced > 0 ? ` (${unpriced} without amount)` : ''}`],
          ['buysSells', overall ? `${row.buyCount} buys, ${row.sellCount} sells` : null],
          ['volume', overall ? fmtBand(volumeBand(row)) : null],
          ['net', overall ? fmtBand(netBand(row)) : null],
          ['filedOnTime', lateKnown > 0 ? `${fmtPct(Number(row.onTime ?? 0) / lateKnown)} (n=${lateKnown})` : null],
          ['medianLagDays', medianOf(row.lags)],
          ['lastTrade', row.lastTradeDate ? fmtDate(row.lastTradeDate) : null],
          ['topSectors', sectors.map((s) => `${s._id} (${s.tradeCount})`).join(', ')],
        ]);
        if (securities.length === 0) return head;
        const top = table(
          ['isin', 'ticker', 'asset', 'trades', 'volume', 'net'],
          securities.map((s) => [s.isin, s.ticker, clip(s.name), s.tradeCount, fmtBand(volumeBand(s)), fmtBand(netBand(s))]),
        );
        return `${head}\n\n# top securities by volume\n${top}`;
      },
    },
    {
      name: 'get_congress_flow',
      title: 'Congress trading flow',
      description: `Aggregate trading flow of US Congress members within a window by publication date (what became public): trades, politicians, buys/sells, volume band, then the top bought and top sold securities by net band (isin, ticker, name, trades, net) and buy/sell/net bands per sector. ${AMOUNT_NOTE} Trades with a suspect date are excluded. window: 90d|ytd|1y|all (default 90d). Example: {"window":"90d"} or {"window":"ytd","party":"R","limit":5}`,
      inputSchema: {
        window: z.enum(WINDOWS).optional().describe('90d|ytd|1y|all, default 90d'),
        chamber: z.enum(['house', 'senate']).optional(),
        party: z.enum(['R', 'D', 'I']).optional(),
        limit: z.number().int().min(1).optional().describe('rows per top list, default 10, max 50'),
      },
      requiredScope: 'read',
      annotations: { readOnlyHint: true },
      handler: async (input, { db }) => {
        const window: Window = input.window ?? '90d';
        const lim = Math.min(input.limit ?? 10, 50);
        const match: Document = { ...notSuperseded(), 'quality.dateSuspect': { $ne: true } };
        const start = windowStart(window, new Date());
        if (start) match.publishedAt = { $gte: start };
        if (input.chamber) match.chamber = input.chamber;
        if (input.party) match.party = input.party;
        // 2 × net midpoint: same sign and order as the midpoint, no division needed.
        const netMid2 = { $subtract: [{ $add: ['$buyLow', '$buyHigh'] }, { $add: ['$sellLow', '$sellHigh'] }] };
        const [[overall], [tops], sectors] = await Promise.all([
          agg(db, grouped(match, null, { politicians: { $addToSet: '$bioguideId' } })),
          agg(db, [
            ...grouped({ ...match, isin: { $ne: null } }, '$isin', SECURITY_EXTRA),
            { $addFields: { _net: netMid2 } },
            {
              $facet: {
                bought: [{ $match: { _net: { $gt: 0 } } }, { $sort: { _net: -1, tradeCount: -1 } }, { $limit: lim }],
                sold: [{ $match: { _net: { $lt: 0 } } }, { $sort: { _net: 1, tradeCount: -1 } }, { $limit: lim }],
              },
            },
          ]),
          agg(db, [...grouped(match, '$sector'), { $match: { _id: { $ne: null } } }]),
        ]);
        const row: Document = overall ?? {};
        const head = kv([
          ['window', `${window} (by publication date)`],
          ['chamber', input.chamber],
          ['party', input.party],
          ['trades', row.tradeCount ?? 0],
          ['politicians', politicianCount(row.politicians)],
          ['buysSells', overall ? `${row.buyCount} buys, ${row.sellCount} sells` : null],
          ['volume', overall ? fmtBand(volumeBand(row)) : null],
        ]);
        const securityTable = (list: Document[] | undefined) =>
          table(
            ['isin', 'ticker', 'name', 'trades', 'net'],
            (list ?? []).map((s) => [s.isin, s.ticker, clip(s.name), s.tradeCount, fmtBand(netBand(s))]),
          );
        const sectorTable = table(
          ['sector', 'trades', 'buy', 'sell', 'net'],
          sectors
            .map((s) => ({ s, net: netBand(s) }))
            .sort((a, b) => Math.abs(bandMid(b.net)) - Math.abs(bandMid(a.net)))
            .map(({ s, net }) => [s._id, s.tradeCount, fmtBand(sideBand(s, 'buy')), fmtBand(sideBand(s, 'sell')), fmtBand(net)]),
        );
        return [
          head,
          `# top bought (net)\n${securityTable(tops?.bought)}`,
          `# top sold (net)\n${securityTable(tops?.sold)}`,
          `# sectors\n${sectorTable}`,
        ].join('\n\n');
      },
    },
  ],
};
