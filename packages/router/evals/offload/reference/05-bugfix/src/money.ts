/** Formats integer cents as a dollar string, e.g. 1234 -> "$12.34", -150 -> "-$1.50". */
export function formatCurrencyCents(cents: number): string {
  const sign = cents < 0 ? "-" : "";
  const dollars = Math.abs(cents) / 100;
  return `${sign}$${dollars.toFixed(2)}`;
}

/** Clamps `value` into [min, max]. */
export function clampRange(value: number, min: number, max: number): number {
  if (value < min) return min;
  if (value > max) return max;
  return value;
}
