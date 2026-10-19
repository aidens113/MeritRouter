/** Formatting helpers shared by server and client components. */

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return "–";
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${trim(n / 1e9)}B`;
  if (abs >= 1e6) return `${trim(n / 1e6)}M`;
  if (abs >= 1e4) return `${trim(n / 1e3)}K`;
  return n.toLocaleString("en-US");
}

function trim(v: number): string {
  return v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1).replace(/\.0$/, "") : v.toFixed(2).replace(/\.?0+$/, "");
}

export function num(n: number | null | undefined): string {
  return n === null || n === undefined ? "–" : n.toLocaleString("en-US");
}

export function pct(part: number, whole: number, digits = 0): string {
  if (!whole) return "–";
  return `${((part / whole) * 100).toFixed(digits)}%`;
}

export function params(b: number | null | undefined): string {
  if (b === null || b === undefined) return "?";
  if (b >= 1000) return `${trim(b / 1000)}T`;
  return `${b >= 10 ? Math.round(b) : trim(b)}B`;
}

export function tokens(n: number | null | undefined): string {
  if (n === null || n === undefined) return "unknown";
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`;
  if (n >= 1000) return `${Math.round(n / 1000)}K`;
  return String(n);
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

export function ago(ms: number | null | undefined, now = Date.now()): string {
  if (ms === null || ms === undefined) return "never";
  const d = ms - now;
  const abs = Math.abs(d);
  if (abs < 45_000) return d > 0 ? "in a few seconds" : "just now";
  if (abs < 3_600_000) return rtf.format(Math.round(d / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(d / 3_600_000), "hour");
  return rtf.format(Math.round(d / 86_400_000), "day");
}

export function dateTime(ms: number | string | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const d = typeof ms === "string" ? new Date(ms) : new Date(ms);
  if (Number.isNaN(d.getTime())) return "–";
  return d.toLocaleString("en-GB", { year: "numeric", month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  return `${Math.floor(ms / 60_000)}m ${Math.round((ms % 60_000) / 1000)}s`;
}

export function humanize(s: string): string {
  return s.replace(/_/g, " ");
}

export function shortId(id: string, n = 10): string {
  return id.length > n ? `${id.slice(0, n)}…` : id;
}

export function modelHref(id: string): string {
  return `/models/detail?id=${encodeURIComponent(id)}`;
}

/** Compact timestamp for dense tables: "19 Oct 00:34:29". */
export function shortDateTime(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "–";
  const d = new Date(ms);
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
}
