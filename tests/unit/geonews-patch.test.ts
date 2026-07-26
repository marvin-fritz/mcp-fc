import { describe, expect, it } from 'vitest';
import { buildNewsPatch } from '../../src/features/geonews/newsPatch.js';

const AT = new Date('2026-07-24T08:00:00.000Z');

describe('buildNewsPatch', () => {
  it('überträgt alle Geo-Felder eines verorteten Items', () => {
    const patch = buildNewsPatch(
      { relevance: 0.85, summary: 'EZB hebt Zinsen an.', country: 'de', place: 'Frankfurt' },
      AT,
    );
    expect(patch.$set).toEqual({
      relevance: 0.85,
      geoSummary: 'EZB hebt Zinsen an.',
      geoTitle: null,
      country: 'DE',
      place: 'Frankfurt',
      geoLocatedAt: AT,
    });
  });

  it('setzt fehlende optionale Felder explizit auf null', () => {
    const patch = buildNewsPatch({ relevance: 0.3, country: 'US' }, AT);
    expect(patch.$set.geoSummary).toBeNull();
    expect(patch.$set.place).toBeNull();
  });

  it('setzt bei noLocation keine relevance — kein Ort heißt nicht unwichtig', () => {
    const patch = buildNewsPatch({ noLocation: true }, AT);
    expect(patch.$set).toEqual({ geoLocatedAt: AT });
    expect('relevance' in patch.$set).toBe(false);
  });

  it('normalisiert den Ländercode auf Großbuchstaben', () => {
    expect(buildNewsPatch({ relevance: 0.5, country: 'gb' }, AT).$set.country).toBe('GB');
  });

  it('überträgt geoTitle, wenn der Agent eine deutsche Schlagzeile liefert', () => {
    const patch = buildNewsPatch(
      { relevance: 0.8, title: 'EZB hebt Leitzins auf 4,0 Prozent', country: 'DE' },
      AT,
    );
    expect(patch.$set.geoTitle).toBe('EZB hebt Leitzins auf 4,0 Prozent');
  });

  it('setzt geoTitle auf null, wenn keine Schlagzeile geliefert wurde', () => {
    expect(buildNewsPatch({ relevance: 0.5, country: 'US' }, AT).$set.geoTitle).toBeNull();
  });
});
