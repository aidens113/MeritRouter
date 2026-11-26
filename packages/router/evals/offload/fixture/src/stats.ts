/** Average of `nums`; throws on an empty array. Deliberately has no test file yet (the fixture's
 * "write missing tests" task). */
export function average(nums: number[]): number {
  if (nums.length === 0) throw new Error("average of empty array");
  let sum = 0;
  for (const n of nums) sum += n;
  return sum / nums.length;
}

/** Clamps `value` into [0, 1]. See money.ts's `clampRange`: the fixture's "refactor" task asks
 * for one shared `clamp` helper used by both. */
export function clampToUnitRange(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}
