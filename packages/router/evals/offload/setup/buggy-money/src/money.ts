/** Formats integer cents as a dollar string, e.g. 1234 -> "$12.34", -150 -> "-$1.50". */
export function formatCurrencyCents(cents: number): string {
  const dollars = cents / 100;
  // BUG (fixture task "bug fix with failing test"): toFixed keeps the minus sign with the
  // number, so this produces "$-1.50" instead of "-$1.50".
  return `$${dollars.toFixed(2)}`;
}

/** Clamps `value` into [min, max]. Duplicated (in spirit) by `clampToUnitRange` in stats.ts; the
 * fixture's "refactor" task asks for one shared `clamp` helper used by both. */
export function clampRange(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
