/** Patch für die news-Collection aus einem Geo-Submit-Item. */

export interface GeoPatchInput {
  noLocation?: boolean;
  relevance?: number;
  summary?: string;
  country?: string;
  place?: string;
}

/**
 * Baut das `$set`-Dokument, mit dem der zugehörige news-Doc um die
 * Geo-Informationen ergänzt wird. Die Denormalisierung macht die
 * Relevanz-Sortierung in der REST-API zu einem Index-Scan.
 *
 * Bei `noLocation` wird bewusst KEINE `relevance` gesetzt: „kein sinnvoller
 * Ort" heißt nicht „unwichtig", und eine 0 wäre eine Falschaussage.
 */
export function buildNewsPatch(
  item: GeoPatchInput,
  locatedAt: Date,
): { $set: Record<string, unknown> } {
  if (item.noLocation) {
    return { $set: { geoLocatedAt: locatedAt } };
  }
  return {
    $set: {
      relevance: item.relevance,
      geoSummary: item.summary ?? null,
      country: item.country ? item.country.toUpperCase() : null,
      place: item.place ?? null,
      geoLocatedAt: locatedAt,
    },
  };
}
