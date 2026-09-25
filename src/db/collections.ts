import type { Db } from 'mongodb';

/** Whitelisted collections. Internal collections (users, chats, stats, …) are never exposed. */
export function cols(db: Db) {
  return {
    stockIndex: db.collection('stockIndex'),
    stockPrices: db.collection('stockPrices'),
    stockMetrics: db.collection('stockMetrics'),
    secFinancials: db.collection('secFinancials'),
    insiderTrades: db.collection('insiderTrades'),
    f13Filings: db.collection('f13Filings'),
    funds: db.collection('funds'),
    politicalFilings: db.collection('politicalFilings'),
    /** Flat congressional trades and politician master data (written by Kraken, read-only here). */
    politicalTrades: db.collection('politicalTrades'),
    politicians: db.collection('politicians'),
    fred: db.collection('fred'),
    economicIndicators: db.collection('economicIndicators'),
    news: db.collection('news'),
  };
}
