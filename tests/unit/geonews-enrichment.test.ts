import { describe, expect, it } from 'vitest';
import { buildEnrichment } from '../../src/features/geonews/enrichment.js';

const AT = new Date('2026-08-11T08:00:00.000Z');

describe('buildEnrichment', () => {
  it('baut den vollen Block für ein verortetes Item mit Topics', () => {
    const block = buildEnrichment(
      {
        lat: 50.11, lon: 8.68, country: 'de', place: 'Frankfurt', precision: 'city',
        confidence: 0.9, relevance: 0.72, summary: 'EZB-Entscheid.',
        headline: 'EZB hebt Leitzins an', topics: ['ECB', 'Interest Rates'],
      },
      'fc-geo-agent', AT,
    );
    expect(block).toEqual({
      enrichedBy: 'fc-geo-agent',
      enrichedAt: AT,
      relevance: 0.72,
      headline: 'EZB hebt Leitzins an',
      summary: 'EZB-Entscheid.',
      topics: ['ECB', 'Interest Rates'],
      geo: {
        locatable: true,
        location: { type: 'Point', coordinates: [8.68, 50.11] },
        country: 'DE',
        place: 'Frankfurt',
        precision: 'city',
        confidence: 0.9,
      },
    });
  });

  it('erfasst Topics und relevance auch ohne Ort — kein Ort heißt nicht themenlos', () => {
    const block = buildEnrichment(
      { noLocation: true, relevance: 0.6, topics: ['US Economy', 'US Job Market', 'DAX'] },
      'fc-geo-agent', AT,
    );
    expect(block.geo).toEqual({ locatable: false });
    expect(block.relevance).toBe(0.6);
    expect(block.topics).toEqual(['US Economy', 'US Job Market', 'DAX']);
  });

  it('lässt fehlende optionale Felder weg statt null zu schreiben', () => {
    const block = buildEnrichment(
      { lat: 1, lon: 2, country: 'US', precision: 'country', relevance: 0.3 },
      'fc-geo-agent', AT,
    );
    expect(block).not.toHaveProperty('headline');
    expect(block).not.toHaveProperty('summary');
    expect(block).not.toHaveProperty('topics');
    expect(block.geo).not.toHaveProperty('place');
    expect(block.geo).not.toHaveProperty('confidence');
  });

  it('minimales noLocation-Item bleibt gültig (Abwärtskompatibilität zur Routine)', () => {
    const block = buildEnrichment({ noLocation: true }, 'fc-geo-agent', AT);
    expect(block).toEqual({ enrichedBy: 'fc-geo-agent', enrichedAt: AT, geo: { locatable: false } });
  });

  it('schreibt kein isins-Feld, wenn der bisherige Block keine ISINs hat', () => {
    const previous = { enrichedBy: 'aladinTagger', enrichedAt: AT, relevance: 0.4, topics: ['DAX'], partial: true };
    const block = buildEnrichment({ noLocation: true, relevance: 0.5 }, 'fcNewsAgent', AT, previous);
    expect(block).not.toHaveProperty('isins');
  });
});
