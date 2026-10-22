import type { ParamEvidence } from "./catalog.js";

const NUM = String.raw`(\d+(?:\.\d+)?)`;

/**
 * Parameter counts from a model id or display name, e.g. `qwen3-235b-a22b`, `30B-A3B`,
 * `llama-3.1-8b-instruct`, `gpt-oss-120b`. Heuristic: never treated as exact.
 */
export function parseParamsFromName(text: string): { totalB: number; activeB: number | null; detail: string } | null {
  const t = text.toLowerCase();
  const moe = new RegExp(String.raw`(?:^|[^a-z0-9.])${NUM}b[-_ ]?a${NUM}b(?![a-z0-9])`).exec(t);
  if (moe) return { totalB: Number(moe[1]), activeB: Number(moe[2]), detail: `name "${text}" contains ${moe[1]}B total / ${moe[2]}B active` };
  const experts = new RegExp(String.raw`(?:^|[^a-z0-9.])(\d+)x${NUM}b(?![a-z0-9])`).exec(t);
  if (experts) {
    // NxMB naming over-counts shared weights; record it but only as a heuristic upper bound.
    return { totalB: Number(experts[1]) * Number(experts[2]), activeB: null, detail: `name "${text}" contains ${experts[0].replace(/^[^0-9]/, "")} (expert count x size, approximate)` };
  }
  const plain = [...t.matchAll(new RegExp(String.raw`(?:^|[^a-z0-9.])${NUM}b(?![a-z0-9])`, "g"))].map((m) => Number(m[1]));
  if (plain.length === 0) return null;
  const totalB = Math.max(...plain);
  return { totalB, activeB: null, detail: `name "${text}" contains ${totalB}B${plain.length > 1 ? " (largest of several numbers)" : ""}` };
}

/** Counts stated in prose, e.g. "12B active parameters out of 120B total". */
export function parseParamsFromDescription(text: string): { totalB: number; activeB: number | null; detail: string } | null {
  const t = text.replace(/\s+/g, " ");
  const unit = String.raw`\s*(?:b\b|billion)`;
  const total =
    new RegExp(String.raw`${NUM}${unit}\s*(?:total|parameters? in total)`, "i").exec(t) ??
    new RegExp(String.raw`out of ${NUM}${unit}`, "i").exec(t) ??
    new RegExp(String.raw`${NUM}${unit}[- ]param(?:eter)?s?`, "i").exec(t) ??
    new RegExp(String.raw`${NUM}${unit} parameter`, "i").exec(t);
  if (!total) return null;
  const active = new RegExp(String.raw`${NUM}${unit}\s*(?:active|activated)`, "i").exec(t);
  const totalB = Number(total[1]);
  const activeB = active && Number(active[1]) < totalB ? Number(active[1]) : null;
  return { totalB, activeB, detail: `description states "${total[0].trim()}"${active ? ` and "${active[0].trim()}"` : ""}` };
}

export interface ResolvedParams {
  totalParametersB: number | null;
  activeParametersB: number | null;
  source: ParamEvidence["source"];
  confidence: "exact" | "agreed" | "heuristic" | "unknown";
  evidence: ParamEvidence[];
}

const close = (a: number, b: number, tol = 0.15) => Math.abs(a - b) / Math.max(a, b) <= tol;
const round = (n: number) => Math.round(n * 10) / 10;

/**
 * Combine evidence. Hugging Face weight metadata is exact; two independent heuristics that
 * agree within 15% are "agreed"; a single heuristic is "heuristic"; nothing is "unknown".
 */
export function resolveParams(evidence: ParamEvidence[]): ResolvedParams {
  const hf = evidence.find((e) => e.source === "huggingface" && e.totalB !== null);
  const heuristics = evidence.filter((e) => (e.source === "name" || e.source === "description" || e.source === "provider") && e.totalB !== null);
  const activeFrom = evidence.find((e) => e.activeB !== null);
  if (hf) {
    return { totalParametersB: round(hf.totalB!), activeParametersB: activeFrom?.activeB ?? null, source: "huggingface", confidence: "exact", evidence };
  }
  if (heuristics.length >= 2) {
    const [a, b] = heuristics as [ParamEvidence, ParamEvidence];
    if (close(a.totalB!, b.totalB!)) {
      return { totalParametersB: Math.min(a.totalB!, b.totalB!), activeParametersB: activeFrom?.activeB ?? null, source: a.source, confidence: "agreed", evidence };
    }
  }
  if (heuristics.length >= 1) {
    // Disagreeing heuristics: take the smaller (conservative for size floors).
    const smallest = heuristics.reduce((m, e) => (e.totalB! < m.totalB! ? e : m));
    return { totalParametersB: smallest.totalB, activeParametersB: activeFrom?.activeB ?? null, source: smallest.source, confidence: "heuristic", evidence };
  }
  return { totalParametersB: null, activeParametersB: null, source: "unknown", confidence: "unknown", evidence };
}
