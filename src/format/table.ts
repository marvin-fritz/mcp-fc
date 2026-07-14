export interface TableMeta {
  offset?: number;
  hasMore?: boolean;
}

/** Pipe-separated table without padding. First line = headers. */
export function table(
  headers: string[],
  rows: Array<Array<string | number | null | undefined>>,
  meta?: TableMeta,
): string {
  if (rows.length === 0) return '# 0 rows';
  const lines: string[] = [];
  const offset = meta?.offset ?? 0;
  if (meta?.hasMore) {
    lines.push(`# rows ${offset + 1}-${offset + rows.length}, more available — refine filters or use offset=${offset + rows.length}`);
  } else if (offset > 0) {
    lines.push(`# rows ${offset + 1}-${offset + rows.length}`);
  }
  lines.push(headers.join('|'));
  for (const r of rows) {
    lines.push(r.map((c) => (c == null ? '' : String(c))).join('|'));
  }
  return lines.join('\n');
}
