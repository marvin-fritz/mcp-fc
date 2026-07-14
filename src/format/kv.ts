/** key: value lines; entries with null/undefined/'' values are omitted. */
export function kv(pairs: Array<[string, unknown]>): string {
  return pairs
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}: ${v}`)
    .join('\n');
}
