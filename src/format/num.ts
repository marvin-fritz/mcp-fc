export function toNum(v: unknown): number | null {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'object') {
    const n = Number(String(v));
    return Number.isFinite(n) ? n : null;
  }
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function trimZeros(s: string): string {
  return s.includes('.') ? s.replace(/\.?0+$/, '') : s;
}

/** Compact number: ≤`dec` decimals (default 4), ≤2 decimals for |n| ≥ 1000, no trailing zeros. */
export function fmtNum(v: unknown, dec = 4): string {
  const n = toNum(v);
  if (n === null) return '';
  return trimZeros(n.toFixed(Math.abs(n) >= 1000 ? Math.min(dec, 2) : dec));
}

/** Raw currency units → millions, 1 decimal. */
export function fmtMillions(v: unknown): string {
  const n = toNum(v);
  if (n === null) return '';
  return trimZeros((n / 1e6).toFixed(1));
}

/** Ratio (0.469) → '46.9%'. */
export function fmtPct(v: unknown): string {
  const n = toNum(v);
  if (n === null) return '';
  return `${trimZeros((n * 100).toFixed(1))}%`;
}

export function fmtDate(v: unknown): string {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

export function fmtDateTime(v: unknown): string {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 16).replace('T', ' ');
}
