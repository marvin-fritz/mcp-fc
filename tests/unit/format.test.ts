import { describe, expect, it } from 'vitest';
import { fmtDate, fmtDateTime, fmtMillions, fmtNum, fmtPct, toNum } from '../../src/format/num.js';
import { kv } from '../../src/format/kv.js';
import { table } from '../../src/format/table.js';

describe('num', () => {
  it('toNum handles numbers, Decimal128-like and Long-like objects, null', () => {
    expect(toNum(82.68)).toBe(82.68);
    expect(toNum({ toString: () => '82.6800' } as unknown)).toBe(82.68);
    expect(toNum(null)).toBeNull();
    expect(toNum(undefined)).toBeNull();
    expect(toNum('abc')).toBeNull();
  });

  it('fmtNum trims trailing zeros, caps decimals', () => {
    expect(fmtNum(82.68)).toBe('82.68');
    expect(fmtNum({ toString: () => '82.6800' })).toBe('82.68');
    expect(fmtNum(1234.5678)).toBe('1234.57');
    expect(fmtNum(null)).toBe('');
  });

  it('fmtMillions converts raw units to millions with 1 decimal', () => {
    expect(fmtMillions(416_161_000_000)).toBe('416161');
    expect(fmtMillions(8_123_456_789)).toBe('8123.5');
    expect(fmtMillions(null)).toBe('');
  });

  it('fmtPct renders ratio as percent with 1 decimal', () => {
    expect(fmtPct(0.469052)).toBe('46.9%');
    expect(fmtPct(0.003831)).toBe('0.4%');
    expect(fmtPct(null)).toBe('');
  });

  it('fmtDate/fmtDateTime', () => {
    expect(fmtDate(new Date('2026-07-11T17:35:00Z'))).toBe('2026-07-11');
    expect(fmtDate('2025-09-27')).toBe('2025-09-27');
    expect(fmtDate('1996-12')).toBe('1996-12');
    expect(fmtDateTime(new Date('2026-07-11T17:35:00Z'))).toBe('2026-07-11 17:35');
  });
});

describe('kv', () => {
  it('renders key: value lines and skips empty values', () => {
    expect(kv([['name', 'Fraport'], ['x', null], ['y', ''], ['isin', 'DE0005773303']]))
      .toBe('name: Fraport\nisin: DE0005773303');
  });
});

describe('table', () => {
  it('renders header and pipe rows without padding', () => {
    expect(table(['a', 'b'], [['1', 'x'], [2, null]])).toBe('a|b\n1|x\n2|');
  });

  it('renders 0 rows marker', () => {
    expect(table(['a'], [])).toBe('# 0 rows');
  });

  it('adds truncation meta when more rows exist', () => {
    const out = table(['a'], [['1'], ['2']], { offset: 0, hasMore: true });
    expect(out.startsWith('# rows 1-2, more available — refine filters or use offset=2\n')).toBe(true);
  });

  it('sanitizes pipes and newlines inside cells', () => {
    expect(table(['a', 'b'], [['x|y', 'l1\nl2\r\nl3']])).toBe('a|b\nx¦y|l1 l2 l3');
  });

  it('adds offset meta when offset > 0', () => {
    const out = table(['a'], [['3']], { offset: 2, hasMore: false });
    expect(out.startsWith('# rows 3-3\n')).toBe(true);
  });
});
