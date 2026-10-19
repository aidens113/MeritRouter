"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Table2, BarChart3 } from "lucide-react";
import { buttonClass } from "../ui";

/**
 * Hand-rolled SVG charts following the dataviz method: fixed categorical slot order (validated
 * palette in globals.css), thin marks with 4px rounded data-ends, 2px surface gaps, hairline
 * grid, legend for >= 2 series, hover + focus tooltip, and a table view twin.
 */

export interface Series {
  key: string;
  label: string;
  /** CSS color (normally a var(--series-n) token). */
  color: string;
  values: number[];
}

function useWidth<T extends HTMLElement>(): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [w, setW] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.floor(entries[0]?.contentRect.width ?? 0)));
    ro.observe(el);
    setW(Math.floor(el.getBoundingClientRect().width));
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

function niceMax(v: number): { max: number; step: number } {
  if (v <= 0) return { max: 4, step: 1 };
  const raw = v / 4;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const s = step < 1 ? 1 : step;
  return { max: Math.ceil(v / s) * s, step: s };
}

function fmtBucket(ms: number, short: boolean, bucketMinutes: number): string {
  const d = new Date(ms);
  if (bucketMinutes >= 1440) return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
  const hm = d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  if (short) return hm;
  const end = new Date(ms + bucketMinutes * 60_000).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  return `${d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" })} ${hm}–${end}`;
}

function roundedTop(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function Legend({ series, shape = "rect" }: { series: Array<Pick<Series, "key" | "label" | "color">>; shape?: "rect" | "line" }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-2">
      {series.map((s) => (
        <li key={s.key} className="flex items-center gap-1.5">
          {shape === "rect" ? <span className="h-2.5 w-2.5 rounded-[3px]" style={{ background: s.color }} aria-hidden /> : <span className="h-0.5 w-3 rounded" style={{ background: s.color }} aria-hidden />}
          <span className="max-w-[16rem] truncate" title={s.label}>
            {s.label}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ViewToggle({ table, onChange }: { table: boolean; onChange: (t: boolean) => void }) {
  return (
    <button type="button" className={buttonClass("ghost", true)} onClick={() => onChange(!table)} aria-pressed={table}>
      {table ? <BarChart3 size={13} aria-hidden /> : <Table2 size={13} aria-hidden />}
      {table ? "Chart" : "Table"}
    </button>
  );
}

/** Stacked columns over time (requests per bucket, stacked by model). */
export function StackedColumns({
  buckets,
  series,
  bucketMinutes,
  unit = "requests",
  height = 220,
}: {
  buckets: number[];
  series: Series[];
  bucketMinutes: number;
  unit?: string;
  height?: number;
}) {
  const formatBucket = (ms: number, short: boolean) => fmtBucket(ms, short, bucketMinutes);
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const totals = useMemo(() => buckets.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0)), [buckets, series]);
  const { max, step } = niceMax(Math.max(0, ...totals));
  const padL = 36;
  const padB = 22;
  const padT = 8;
  const plotW = Math.max(0, width - padL - 4);
  const plotH = height - padB - padT;
  const band = buckets.length ? plotW / buckets.length : 0;
  const colW = Math.max(2, Math.min(24, band * 0.7));
  const y = (v: number) => padT + plotH - (v / max) * plotH;
  const ticks: number[] = [];
  for (let v = 0; v <= max + 1e-9; v += step) ticks.push(v);
  const labelEvery = Math.max(1, Math.ceil(buckets.length / Math.max(1, Math.floor(plotW / 64))));

  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {series.length >= 2 ? <Legend series={series} /> : <span />}
        <ViewToggle table={table} onChange={setTable} />
      </div>
      {table ? (
        <div className="max-h-80 overflow-auto rounded-lg border border-line">
          <table className="data-table tabular">
            <thead>
              <tr>
                <th>Time</th>
                {series.map((s) => (
                  <th key={s.key}>{s.label}</th>
                ))}
                <th>Total</th>
              </tr>
            </thead>
            <tbody>
              {buckets.map((b, i) =>
                totals[i] ? (
                  <tr key={b}>
                    <td>{formatBucket(b, false)}</td>
                    {series.map((s) => (
                      <td key={s.key}>{s.values[i] ?? 0}</td>
                    ))}
                    <td className="font-medium">{totals[i]}</td>
                  </tr>
                ) : null,
              )}
            </tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative w-full min-w-0 overflow-hidden" style={{ height }} onPointerLeave={() => setHover(null)}>
          {width > 0 ? (
            <svg width={width} height={height} role="img" aria-label={`Stacked column chart of ${unit} over time`}>
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={padL} x2={padL + plotW} y1={y(t)} y2={y(t)} stroke={t === 0 ? "var(--axis)" : "var(--grid)"} strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={padL - 6} y={y(t)} dy="0.32em" textAnchor="end" className="tabular fill-ink-3 text-[10px]">
                    {t.toLocaleString("en-US")}
                  </text>
                </g>
              ))}
              {buckets.map((b, i) => {
                const cx0 = padL + i * band + (band - colW) / 2;
                let acc = 0;
                const segs = series
                  .map((s) => ({ s, v: s.values[i] ?? 0 }))
                  .filter((d) => d.v > 0);
                return (
                  <g key={b} opacity={hover === null || hover === i ? 1 : 0.55}>
                    {segs.map((d, j) => {
                      const y0 = y(acc);
                      acc += d.v;
                      const y1 = y(acc);
                      const h = Math.max(1, y0 - y1 - (j > 0 ? 2 : 0));
                      const top = j === segs.length - 1;
                      return top ? (
                        <path key={d.s.key} d={roundedTop(cx0, y1, colW, h, 4)} fill={d.s.color} />
                      ) : (
                        <rect key={d.s.key} x={cx0} y={y1} width={colW} height={h} fill={d.s.color} />
                      );
                    })}
                    <rect
                      x={padL + i * band}
                      y={padT}
                      width={band}
                      height={plotH}
                      fill="transparent"
                      tabIndex={totals[i] ? 0 : -1}
                      aria-label={`${formatBucket(b, false)}: ${totals[i]} ${unit}`}
                      onPointerEnter={() => setHover(i)}
                      onFocus={() => setHover(i)}
                      onBlur={() => setHover(null)}
                      className="outline-none"
                    />
                    {i % labelEvery === 0 ? (
                      <text x={padL + i * band + band / 2} y={height - 6} textAnchor="middle" className="tabular fill-ink-3 text-[10px]">
                        {formatBucket(b, true)}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          ) : null}
          {hover !== null && width > 0 ? (
            <ChartTooltip
              x={padL + hover * band + band / 2}
              width={width}
              title={formatBucket(buckets[hover]!, false)}
              rows={[...series].reverse().map((s) => ({ key: s.key, label: s.label, color: s.color, value: s.values[hover] ?? 0 }))}
              total={totals[hover] ?? 0}
              unit={unit}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}

function ChartTooltip({ x, width, title, rows, total, unit }: { x: number; width: number; title: string; rows: Array<{ key: string; label: string; color: string; value: number }>; total: number; unit: string }) {
  const left = Math.min(Math.max(8, x + 12), Math.max(8, width - 232));
  const shown = rows.filter((r) => r.value > 0);
  return (
    <div className="pointer-events-none absolute top-1 z-10 w-56 rounded-lg border border-line bg-surface p-2.5 text-xs shadow-lg" style={{ left }}>
      <div className="mb-1.5 text-ink-3">{title}</div>
      {shown.length === 0 ? <div className="text-ink-3">No {unit}</div> : null}
      {shown.map((r) => (
        <div key={r.key} className="flex items-center gap-2 py-0.5">
          <span className="h-0.5 w-3 shrink-0 rounded" style={{ background: r.color }} aria-hidden />
          <span className="tabular font-semibold text-ink">{r.value.toLocaleString("en-US")}</span>
          <span className="truncate text-ink-2">{r.label}</span>
        </div>
      ))}
      {shown.length > 1 ? (
        <div className="mt-1 border-t border-line pt-1 text-ink-2">
          <span className="tabular font-semibold text-ink">{total.toLocaleString("en-US")}</span> total {unit}
        </div>
      ) : null}
    </div>
  );
}

/** Horizontal stacked bars, one row per category (e.g. tasks per tier: completed vs not). */
export function StackedBars({ rows, series, unit = "tasks" }: { rows: Array<{ key: string; label: string; hint?: string }>; series: Series[]; unit?: string }) {
  const [table, setTable] = useState(false);
  const [hover, setHover] = useState<string | null>(null);
  const totals = rows.map((_, i) => series.reduce((s, x) => s + (x.values[i] ?? 0), 0));
  const max = Math.max(1, ...totals);
  return (
    <div>
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        {series.length >= 2 ? <Legend series={series} /> : <span />}
        <ViewToggle table={table} onChange={setTable} />
      </div>
      {table ? (
        <table className="data-table tabular rounded-lg border border-line">
          <thead>
            <tr>
              <th>Category</th>
              {series.map((s) => (
                <th key={s.key}>{s.label}</th>
              ))}
              <th>Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.key}>
                <td>{r.label}</td>
                {series.map((s) => (
                  <td key={s.key}>{s.values[i] ?? 0}</td>
                ))}
                <td className="font-medium">{totals[i]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <ul className="space-y-2.5">
          {rows.map((r, i) => {
            const total = totals[i] ?? 0;
            const segs = series.map((s) => ({ s, v: s.values[i] ?? 0 })).filter((d) => d.v > 0);
            return (
              <li key={r.key} className="grid grid-cols-[6.5rem_1fr_3rem] items-center gap-3">
                <div className="min-w-0">
                  <div className="text-xs font-medium text-ink">{r.label}</div>
                  {r.hint ? <div className="truncate text-[11px] text-ink-3">{r.hint}</div> : null}
                </div>
                <div
                  className="relative h-4"
                  tabIndex={total ? 0 : -1}
                  onPointerEnter={() => setHover(r.key)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(r.key)}
                  onBlur={() => setHover(null)}
                  aria-label={`${r.label}: ${segs.map((d) => `${d.v} ${d.s.label}`).join(", ") || `no ${unit}`}`}
                >
                  <SegmentRow segs={segs} max={max} />
                  {hover === r.key && total ? (
                    <div className="pointer-events-none absolute left-0 top-5 z-10 rounded-lg border border-line bg-surface p-2 text-xs shadow-lg">
                      {segs.map((d) => (
                        <div key={d.s.key} className="flex items-center gap-2">
                          <span className="h-0.5 w-3 rounded" style={{ background: d.s.color }} aria-hidden />
                          <span className="tabular font-semibold text-ink">{d.v}</span>
                          <span className="text-ink-2">{d.s.label}</span>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
                <div className="tabular text-right text-xs font-medium text-ink">{total}</div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function SegmentRow({ segs, max }: { segs: Array<{ s: Series; v: number }>; max: number }) {
  return (
    <div className="flex h-4 w-full overflow-hidden rounded-r-[4px] bg-surface-2">
      {segs.map((d, j) => (
        <div
          key={d.s.key}
          className={j === segs.length - 1 ? "rounded-r-[4px]" : ""}
          style={{ width: `${(d.v / max) * 100}%`, background: d.s.color, borderLeft: j > 0 ? "2px solid var(--surface)" : undefined }}
        />
      ))}
    </div>
  );
}
