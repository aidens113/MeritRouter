import { clamp } from "./clamp.js";

/** Average of `nums`; throws on an empty array. */
export function average(nums: number[]): number {
  if (nums.length === 0) throw new Error("average of empty array");
  let sum = 0;
  for (const n of nums) sum += n;
  return sum / nums.length;
}

/** Clamps `value` into [0, 1]. */
export function clampToUnitRange(value: number): number {
  return clamp(value, 0, 1);
}
