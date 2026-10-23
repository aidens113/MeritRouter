"use client";

import Link from "next/link";
import { useState } from "react";
import { Ban, Pin, Plus, Star, Trash2, TriangleAlert } from "lucide-react";
import { ActionStatus, useAction } from "./actions";
import { Badge, buttonClass, cx, EmptyState, HelpTip } from "../ui";
import { modelHref } from "@/lib/format";

export interface OverrideRow {
  id: number;
  profile: string | null;
  tier: string | null;
  kind: "force" | "prefer" | "block";
  endpointId: string;
  modelName: string;
  allowBelowFloor: boolean;
  note: string | null;
  enabled: boolean;
  modelMissing: boolean;
}

const KIND = {
  force: { label: "Force", tone: "serious" as const, icon: Pin, text: "only this model is used" },
  prefer: { label: "Prefer", tone: "accent" as const, icon: Star, text: "tried first, others stay as fallbacks" },
  block: { label: "Block", tone: "bad" as const, icon: Ban, text: "never used" },
};

export function OverridesList({ rows }: { rows: OverrideRow[] }) {
  if (!rows.length)
    return (
      <EmptyState title="No manual routing rules">
        MeritRouter is choosing models automatically everywhere. Add a rule below to force, prefer, or block a model for a task type or tier.
      </EmptyState>
    );
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Rule</th>
            <th>Applies to</th>
            <th>Model</th>
            <th>Note</th>
            <th>Enabled</th>
            <th className="text-right">Remove</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <OverrideRowView key={r.id} r={r} />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OverrideRowView({ r }: { r: OverrideRow }) {
  const { run, busy, error } = useAction();
  const [note, setNote] = useState(r.note ?? "");
  const [arming, setArming] = useState(false);
  const k = KIND[r.kind];
  const Icon = k.icon;
  return (
    <tr className={cx(!r.enabled && "opacity-60")}>
      <td className="whitespace-nowrap">
        <Badge tone={k.tone} icon={<Icon size={11} aria-hidden />}>
          {k.label}
        </Badge>
        <div className="mt-1 text-[11px] text-ink-3">{k.text}</div>
        {r.allowBelowFloor ? (
          <div className="mt-1">
            <Badge tone="warn" icon={<TriangleAlert size={11} aria-hidden />}>
              below size floor allowed
            </Badge>
          </div>
        ) : null}
      </td>
      <td className="whitespace-nowrap">
        <span className="font-medium text-ink">{r.profile ?? "all task types"}</span>
        <span className="text-ink-3"> / </span>
        <span className="font-medium text-ink">{r.tier ?? "all tiers"}</span>
      </td>
      <td className="max-w-[16rem]">
        <Link href={modelHref(r.endpointId)} className="text-ink hover:text-accent-ink hover:underline">
          {r.modelName}
        </Link>
        <div className="break-all font-mono text-[11px] text-ink-3">{r.endpointId}</div>
        {r.modelMissing ? <div className="text-[11px] text-bad-ink">model no longer in the catalog</div> : null}
      </td>
      <td className="min-w-[14rem]">
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          onBlur={() => note !== (r.note ?? "") && run(`/api/routing-overrides/${r.id}`, "PATCH", { note })}
          placeholder="Add a note"
          className="field py-1 text-xs"
          aria-label="Note"
        />
        <ActionStatus error={error} />
      </td>
      <td>
        <label className="inline-flex cursor-pointer items-center gap-2">
          <input type="checkbox" role="switch" checked={r.enabled} disabled={busy} onChange={(e) => run(`/api/routing-overrides/${r.id}`, "PATCH", { enabled: e.target.checked })} className="peer sr-only" />
          <span className={cx("relative h-5 w-9 rounded-full transition-colors", r.enabled ? "bg-accent" : "bg-surface-3")} aria-hidden>
            <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", r.enabled ? "left-4.5" : "left-0.5")} />
          </span>
          <span className="text-xs text-ink-2">{r.enabled ? "On" : "Off"}</span>
        </label>
      </td>
      <td className="text-right">
        <button
          type="button"
          disabled={busy}
          className={buttonClass(arming ? "danger" : "ghost", true)}
          onClick={async () => {
            if (!arming) {
              setArming(true);
              setTimeout(() => setArming(false), 4000);
              return;
            }
            await run(`/api/routing-overrides/${r.id}`, "DELETE");
          }}
          aria-label="Remove rule"
        >
          <Trash2 size={13} aria-hidden /> {arming ? "Confirm remove" : ""}
        </button>
      </td>
    </tr>
  );
}

export function AddOverrideForm({ profiles, tiers, models, defaults }: { profiles: string[]; tiers: string[]; models: Array<{ id: string; name: string; sizeB: number | null; status: string }>; defaults?: { profile?: string; tier?: string } }) {
  const [kind, setKind] = useState<"force" | "prefer" | "block">("prefer");
  const [profile, setProfile] = useState(defaults?.profile ?? "");
  const [tier, setTier] = useState(defaults?.tier ?? "");
  const [endpointId, setEndpointId] = useState("");
  const [below, setBelow] = useState(false);
  const [note, setNote] = useState("");
  const { run, busy, error, message } = useAction();

  return (
    <form
      className="space-y-4"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run(
          "/api/routing-overrides",
          "POST",
          { kind, profile: profile || null, tier: tier || null, endpointId, allowBelowFloor: kind === "force" && below, note: note || undefined, enabled: true },
          { success: "Rule added" },
        );
        if (r.ok) {
          setNote("");
          setBelow(false);
        }
      }}
    >
      <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Rule kind">
        {(Object.keys(KIND) as Array<keyof typeof KIND>).map((k) => {
          const d = KIND[k];
          const Icon = d.icon;
          return (
            <label key={k} className={cx("cursor-pointer rounded-lg border px-3 py-2 text-sm", kind === k ? "border-accent bg-accent-soft" : "border-line hover:bg-surface-2")}>
              <span className="flex items-center gap-2 font-medium text-ink">
                <input type="radio" name="kind" checked={kind === k} onChange={() => setKind(k)} />
                <Icon size={14} aria-hidden /> {d.label}
              </span>
              <span className="mt-0.5 block pl-5 text-xs text-ink-3">{d.text}</span>
            </label>
          );
        })}
      </div>
      <div className="grid gap-3 md:grid-cols-[1fr_1fr_2fr]">
        <label className="block text-sm text-ink-2">
          Task type
          <select value={profile} onChange={(e) => setProfile(e.target.value)} className="field mt-1">
            <option value="">All task types</option>
            {profiles.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-ink-2">
          Tier
          <select value={tier} onChange={(e) => setTier(e.target.value)} className="field mt-1">
            <option value="">All tiers</option>
            {tiers.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-sm text-ink-2">
          Model
          <select value={endpointId} onChange={(e) => setEndpointId(e.target.value)} className="field mt-1" required>
            <option value="" disabled>
              Choose a model…
            </option>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name} · {m.sizeB === null ? "size unknown" : `${m.sizeB}B`}
                {m.status !== "active" ? ` · ${m.status.replace("_", " ")}` : ""}
              </option>
            ))}
          </select>
        </label>
      </div>
      {kind === "force" ? (
        <label className={cx("flex items-start gap-2 rounded-lg border px-3 py-2 text-sm", below ? "border-warn/50 bg-warn-soft" : "border-line")}>
          <input type="checkbox" checked={below} onChange={(e) => setBelow(e.target.checked)} className="mt-0.5" />
          <span>
            <span className="flex items-center gap-1 font-medium text-ink">
              Allow below the size floor <HelpTip term="belowFloor" />
            </span>
            <span className="block text-xs text-ink-2">
              {below ? (
                <strong className="text-warn-ink">Warning: a model smaller than the floor will handle this work. Every request is recorded as below-floor. Check results closely.</strong>
              ) : (
                "Off: the forced model must still be at least as large as the size floor, or no model is used."
              )}
            </span>
          </span>
        </label>
      ) : null}
      <label className="block text-sm text-ink-2">
        Note (optional)
        <input value={note} onChange={(e) => setNote(e.target.value)} className="field mt-1" placeholder="Why this rule exists" />
      </label>
      <div className="flex items-center gap-3">
        <button type="submit" className={buttonClass("primary")} disabled={busy || !endpointId}>
          <Plus size={14} aria-hidden /> Add rule
        </button>
        <ActionStatus error={error} message={message} />
      </div>
    </form>
  );
}
