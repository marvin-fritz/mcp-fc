/** enrichment-Block für das news-Dokument — alle vom Agenten gesammelten Daten. */
import type { Document } from 'mongodb';

export interface EnrichmentInput {
  noLocation?: boolean;
  lat?: number;
  lon?: number;
  country?: string;
  place?: string;
  precision?: 'country' | 'region' | 'city';
  confidence?: number;
  relevance?: number;
  summary?: string;
  headline?: string;
  topics?: string[];
}

/**
 * `geo` ist bewusst nur ein Teilbereich des Blocks: relevance, headline,
 * summary und topics sind ortsunabhängig und werden auch bei
 * `locatable: false` erfasst (kein Ort heißt nicht themenlos oder unwichtig).
 * Der Block wird als Ganzes per `$set: { enrichment: … }` geschrieben —
 * Re-Submits ersetzen ihn vollständig, das ist gewollt. Einzige Ausnahme sind
 * die `isins` aus `previous`: Die ermittelt nur der Aladin-Fast-Lane-Tagger
 * (Firmen → stockIndex), der Agent liefert sie nie mit. Ohne Übernahme gingen
 * sie verloren, sobald der Agent einen partial-Block vervollständigt.
 */
export function buildEnrichment(
  item: EnrichmentInput,
  enrichedBy: string,
  enrichedAt: Date,
  previous?: Document | null,
): Document {
  const geo: Document = item.noLocation
    ? { locatable: false }
    : {
        locatable: true,
        location: { type: 'Point', coordinates: [item.lon, item.lat] },
        country: item.country?.toUpperCase(),
        ...(item.place ? { place: item.place } : {}),
        precision: item.precision,
        ...(item.confidence != null ? { confidence: item.confidence } : {}),
      };
  return {
    enrichedBy,
    enrichedAt,
    ...(item.relevance != null ? { relevance: item.relevance } : {}),
    ...(item.headline ? { headline: item.headline } : {}),
    ...(item.summary ? { summary: item.summary } : {}),
    ...(item.topics && item.topics.length > 0 ? { topics: item.topics } : {}),
    ...(previous?.isins ? { isins: previous.isins } : {}),
    geo,
  };
}
