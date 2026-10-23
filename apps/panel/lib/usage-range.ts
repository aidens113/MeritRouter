import { z } from "zod";

/** URL-backed rolling windows shared by install and project usage. */
export const USAGE_RANGES = [
  { id: "1h", label: "Last hour", hours: 1, bucketMinutes: 5 },
  { id: "24h", label: "Last 24 hours", hours: 24, bucketMinutes: 60 },
  { id: "7d", label: "Last 7 days", hours: 168, bucketMinutes: 360 },
  { id: "30d", label: "Last 30 days", hours: 720, bucketMinutes: 1440 },
] as const;
const RangeSchema = z.enum(["1h", "24h", "7d", "30d"]).catch("24h");
export function usageRange(raw: string | string[] | undefined) {
  const id = RangeSchema.parse(raw);
  return USAGE_RANGES.find(range => range.id === id) ?? USAGE_RANGES[1];
}
/** Trim empty edges while retaining gaps between data points; empty windows retain their axes. */
export function usageBuckets(now: number, hours: number, bucketMinutes: number, data?: { first: number; last: number }): number[] {
  const step = bucketMinutes * 60_000;
  const lower = Math.floor((now - hours * 3_600_000) / step) * step;
  const upper = Math.floor(now / step) * step;
  const first = data ? Math.max(lower, Math.floor(data.first / step) * step) : lower;
  const last = data ? Math.min(upper, Math.floor(data.last / step) * step) : upper;
  return Array.from({ length: Math.max(0, Math.round((last - first) / step) + 1) }, (_, i) => first + i * step);
}
