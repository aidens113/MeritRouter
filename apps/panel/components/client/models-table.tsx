"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Search, SlidersHorizontal, Wrench } from "lucide-react";
import type { ModelRow } from "@/lib/models";
import { Modalities, ProvenanceBadge, StatusBadge, STATUS_LABEL, type StatusKey } from "../model-badges";
import { Badge, EmptyState, HelpTip, cx } from "../ui";
import { modelHref, params, pct, tokens } from "@/lib/format";

const STATUSES: StatusKey[] = ["active", "pending_confirmation", "quarantined", "disabled", "removed"];

export function ModelsTable({ rows, profiles, modalities, initialPlatform = "" }: { rows: ModelRow[]; profiles: string[]; modalities: string[]; initialPlatform?: string }) {
  const [q, setQ] = useState("");
  const [status, setStatus] = useState<string>("");
  const [platform, setPlatform] = useState(initialPlatform);
  const [modality, setModality] = useState("");
  const [eligibleFor, setEligibleFor] = useState("");
  const [overridesOnly, setOverridesOnly] = useState(false);
  const platforms = useMemo(() => [...new Set(rows.map((r) => r.providerId))].sort(), [rows]);
  const counts = useMemo(() => Object.fromEntries(STATUSES.map((s) => [s, rows.filter((r) => r.status === s).length])), [rows]);

  const shown = rows.filter((r) => {
    if (status && r.status !== status) return false;
    if (platform && r.providerId !== platform) return false;
    if (modality && !r.modalities.includes(modality)) return false;
    if (eligibleFor === "__none" ? r.eligibleCells > 0 : eligibleFor && !r.eligibleProfiles.includes(eligibleFor)) return false;
    if (overridesOnly && r.overrideFields.length === 0) return false;
    if (q) {
      const hay = `${r.name} ${r.id} ${r.headline}`.toLowerCase();
      if (!q.toLowerCase().split(/\s+/).every((w) => hay.includes(w))) return false;
    }
    return true;
  });
  const filtered = Boolean(q || status || platform || modality || eligibleFor || overridesOnly);

  return (
    <div>
      <div className="mb-3 flex flex-wrap gap-1.5" role="group" aria-label="Filter by status">
        <StatusChip active={!status} onClick={() => setStatus("")} label={`All · ${rows.length}`} />
        {STATUSES.filter((s) => counts[s]).map((s) => (
          <StatusChip key={s} active={status === s} onClick={() => setStatus(status === s ? "" : s)} label={`${STATUS_LABEL[s]} · ${counts[s]}`} />
        ))}
      </div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <label className="relative min-w-[14rem] flex-1">
          <span className="sr-only">Search models</span>
          <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-ink-3" aria-hidden />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, id, or status line" className="field pl-8" />
        </label>
        <Select label="Platform" value={platform} onChange={setPlatform} options={platforms.map((p) => [p, p])} />
        <Select label="Reads" value={modality} onChange={setModality} options={modalities.map((m) => [m, m])} />
        <Select label="Eligible for" value={eligibleFor} onChange={setEligibleFor} options={[...profiles.map((p) => [p, p] as [string, string]), ["__none", "nothing (unused)"]]} />
        <label className="flex items-center gap-1.5 text-sm text-ink-2">
          <input type="checkbox" checked={overridesOnly} onChange={(e) => setOverridesOnly(e.target.checked)} /> With overrides
        </label>
        {filtered ? (
          <button
            type="button"
            className="text-xs text-accent-ink hover:underline"
            onClick={() => {
              setQ("");
              setStatus("");
              setPlatform("");
              setModality("");
              setEligibleFor("");
              setOverridesOnly(false);
            }}
          >
            Clear filters
          </button>
        ) : null}
      </div>

      {shown.length === 0 ? (
        <EmptyState icon={<SlidersHorizontal size={22} />} title={rows.length ? "No models match these filters" : "No models in the catalog yet"}>
          {rows.length ? "Clear a filter to see more." : "Add a provider key on the Provider keys page and run a scan to find the models it can use, or add manual entries to the models file."}
        </EmptyState>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th>Status</th>
                <th>
                  <span className="inline-flex items-center gap-1">
                    Size <HelpTip term="provenance" />
                  </span>
                </th>
                <th>Reads</th>
                <th>Context / output</th>
                <th>
                  <span className="inline-flex items-center gap-1">
                    Free <HelpTip term="freeVerified" />
                  </span>
                </th>
                <th>
                  <span className="inline-flex items-center gap-1">
                    Reachable <HelpTip term="available" />
                  </span>
                </th>
                <th className="text-right">Used 7d</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td className="min-w-[15rem] max-w-[22rem]">
                    <Link href={modelHref(r.id)} className="font-medium text-ink hover:text-accent-ink hover:underline">
                      {r.name}
                    </Link>
                    <div className="mt-0.5 flex flex-wrap items-center gap-1.5 text-[11px] text-ink-3">
                      <Badge>{r.providerId}</Badge>
                      <span className="break-all font-mono">{r.gatewayModelId}</span>
                    </div>
                    <p className={cx("mt-1 text-xs", r.eligibleCells ? "text-ink-2" : "text-ink-3")}>{r.headline}</p>
                  </td>
                  <td>
                    <div className="flex flex-col items-start gap-1">
                      <StatusBadge status={r.status} {...(r.statusReason ? { title: r.statusReason } : {})} />
                      {r.overrideFields.length ? (
                        <Badge tone="accent" icon={<Wrench size={11} aria-hidden />} title={`Overridden: ${r.overrideFields.join(", ")}`}>
                          Overrides active
                        </Badge>
                      ) : null}
                    </div>
                  </td>
                  <td className="whitespace-nowrap">
                    <div className="tabular font-medium text-ink">{params(r.totalB)}</div>
                    {r.activeB ? <div className="text-[11px] text-ink-3">{params(r.activeB)} active (MoE)</div> : null}
                    <div className="mt-1">
                      <ProvenanceBadge params={r.params} />
                    </div>
                  </td>
                  <td className="min-w-[6.5rem]">
                    <Modalities list={r.modalities} />
                    {!r.supportsTools ? <div className="mt-1 text-[11px] text-ink-3">no tool calling</div> : null}
                  </td>
                  <td className="tabular whitespace-nowrap">
                    <div>{tokens(r.contextTokens)}</div>
                    <div className="text-[11px] text-ink-3">
                      out {tokens(r.outputTokens)}
                      {r.outputSource === "default" ? (
                        <span title="No provider reported this output limit: the value was assumed. Set the real limit in an override." className="ml-1 rounded bg-warn-soft px-1 text-warn-ink">
                          default
                        </span>
                      ) : null}
                    </div>
                  </td>
                  <td>{r.free ? <Badge tone="good" title={`Source: ${r.freeSource}`}>Free</Badge> : <Badge tone="bad" title={`Source: ${r.freeSource}`}>Not free</Badge>}</td>
                  <td>{r.available ? <Badge tone="good" title={`Sent directly to ${r.routeProvider}`}>Yes</Badge> : <Badge title="No usable key for its provider, or the provider no longer lists it">No</Badge>}</td>
                  <td className="tabular whitespace-nowrap text-right">
                    <div className="font-medium text-ink">{r.requests7d}</div>
                    {r.requests7d ? <div className={cx("text-[11px]", r.failed7d ? "text-warn-ink" : "text-ink-3")}>{pct(r.succeeded7d, r.requests7d)} ok</div> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="mt-2 text-xs text-ink-3">
        Showing {shown.length} of {rows.length} models.
      </p>
    </div>
  );
}

function StatusChip({ active, onClick, label }: { active: boolean; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={cx("rounded-full border px-3 py-1 text-xs font-medium transition-colors", active ? "border-accent bg-accent-soft text-accent-ink" : "border-line bg-surface text-ink-2 hover:bg-surface-2")}
    >
      {label}
    </button>
  );
}

export function Select({ label, value, onChange, options, anyLabel = "Any" }: { label: string; value: string; onChange: (v: string) => void; options: Array<[string, string]>; anyLabel?: string }) {
  return (
    <label className="flex items-center gap-1.5 text-sm text-ink-2">
      <span className="whitespace-nowrap">{label}</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="field w-auto py-1.5">
        <option value="">{anyLabel}</option>
        {options.map(([v, l]) => (
          <option key={v} value={v}>
            {l}
          </option>
        ))}
      </select>
    </label>
  );
}
