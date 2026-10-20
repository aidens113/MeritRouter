// Terminal text primitives shared by the CLI's renderers: printing, a fixed-width table, one-line
// excerpts, and UTC timestamps and durations.

export function out(value: unknown, json: boolean): void {
  if (json || typeof value !== "string") process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  else process.stdout.write(`${value}\n`);
}

export function table(rows: Array<Record<string, unknown>>): string {
  if (!rows.length) return "(none)";
  const cols = Object.keys(rows[0]!);
  const width = cols.map((c) => Math.min(60, Math.max(c.length, ...rows.map((r) => String(r[c] ?? "").length))));
  const line = (vals: string[]) => vals.map((v, i) => v.slice(0, width[i]).padEnd(width[i]!)).join("  ");
  return [line(cols), line(width.map((w) => "-".repeat(w))), ...rows.map((r) => line(cols.map((c) => String(r[c] ?? ""))))].join("\n");
}

export const oneLine = (text: string, max = 120): string => {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 3)}...` : t;
};
export const clock = (ms: number) => new Date(ms).toISOString().slice(11, 23);
export const stamp = (ms: number) => `${new Date(ms).toISOString().slice(0, 19).replace("T", " ")}Z`;
export function duration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const s = Math.floor(ms / 1000);
  return s < 3600 ? `${Math.floor(s / 60)}m${s % 60}s` : `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}
export const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
