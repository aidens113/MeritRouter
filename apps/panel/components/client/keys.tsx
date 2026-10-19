"use client";

import { useState } from "react";
import { Check, KeyRound, Pencil, Plus, Trash2, X } from "lucide-react";
import type { SafeKey } from "@/lib/keys";
import { ActionStatus, useAction } from "./actions";
import { Badge, buttonClass, cx, HelpTip, type Tone } from "../ui";
import { dateTime } from "@/lib/format";
import { FreeKeyBilling } from "./paid";

function statusTone(s: string): Tone {
  const v = s.toLowerCase();
  if (["healthy", "ok", "active", "valid"].includes(v)) return "good";
  if (v.includes("rate") || v.includes("cool")) return "warn";
  if (v.includes("invalid") || v.includes("error") || v.includes("revoked")) return "bad";
  return "neutral";
}

export function KeyRow({ k, billing }: { k: SafeKey; billing: string }) {
  const { run, busy, error, message } = useAction();
  const [editing, setEditing] = useState(false);
  const [label, setLabel] = useState(k.label);
  const [group, setGroup] = useState(k.groupLabel ?? "");
  const [arming, setArming] = useState(false);

  return (
    <li className={cx("px-4 py-3", !k.enabled && "bg-surface-2/60")}>
      <div className="flex flex-wrap items-center gap-3">
        <KeyRound size={15} className="text-ink-3" aria-hidden />
        {editing ? (
          <div className="flex flex-1 flex-wrap items-end gap-2">
            <label className="text-xs text-ink-3">
              Label
              <input value={label} onChange={(e) => setLabel(e.target.value)} className="field mt-0.5 w-48" />
            </label>
            <label className="text-xs text-ink-3">
              Quota group <HelpTip term="quotaScope" />
              <input value={group} onChange={(e) => setGroup(e.target.value)} className="field mt-0.5 w-48" placeholder="e.g. personal-account" />
            </label>
            <button
              type="button"
              className={buttonClass("primary", true)}
              disabled={busy}
              onClick={async () => {
                const r = await run(`/api/keys/${k.id}`, "PATCH", { label, groupLabel: group.trim() ? group.trim() : null }, { success: "Saved" });
                if (r.ok) setEditing(false);
              }}
            >
              <Check size={13} aria-hidden /> Save
            </button>
            <button type="button" className={buttonClass("ghost", true)} onClick={() => setEditing(false)}>
              <X size={13} aria-hidden /> Cancel
            </button>
          </div>
        ) : (
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-ink">{k.label || `Key #${k.id}`}</span>
              <Badge tone={statusTone(k.status)}>{k.status.replace(/_/g, " ")}</Badge>
              {!k.enabled ? <Badge>disabled</Badge> : null}
              {k.groupLabel ? <Badge tone="accent" title="Keys in the same group share one quota">group: {k.groupLabel}</Badge> : null}
            </div>
            <div className="mt-0.5 text-xs text-ink-3">
              Secret hidden · added {dateTime(k.createdAt)}
              {k.lastCheckedAt ? ` · checked ${dateTime(k.lastCheckedAt)}` : ""}
            </div>
          </div>
        )}
        {!editing ? (
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-3">
              <FreeKeyBilling id={k.id} platform={k.platform} current={billing} />
            </span>
            <label className="mr-2 inline-flex cursor-pointer items-center gap-2 text-xs text-ink-2">
              <input type="checkbox" role="switch" className="sr-only" checked={k.enabled} disabled={busy} onChange={(e) => run(`/api/keys/${k.id}`, "PATCH", { enabled: e.target.checked })} />
              <span className={cx("relative h-5 w-9 rounded-full transition-colors", k.enabled ? "bg-accent" : "bg-surface-3")} aria-hidden>
                <span className={cx("absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all", k.enabled ? "left-4.5" : "left-0.5")} />
              </span>
              {k.enabled ? "Enabled" : "Disabled"}
            </label>
            <button type="button" className={buttonClass("ghost", true)} onClick={() => setEditing(true)} aria-label="Edit label and group">
              <Pencil size={13} aria-hidden />
            </button>
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
                await run(`/api/keys/${k.id}`, "DELETE", undefined, { success: "Key deleted" });
              }}
              aria-label="Delete key"
            >
              <Trash2 size={13} aria-hidden /> {arming ? "Delete permanently?" : ""}
            </button>
          </div>
        ) : null}
      </div>
      <div className="mt-1">
        <ActionStatus error={error} message={message} />
      </div>
    </li>
  );
}

export function AddKeyForm({ providers, groups }: { providers: Array<{ id: string; name: string }>; groups: string[] }) {
  const [platform, setPlatform] = useState("");
  const [label, setLabel] = useState("");
  const [secret, setSecret] = useState("");
  const [group, setGroup] = useState("");
  const { run, busy, error, message } = useAction();
  return (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("/api/keys", "POST", { platform, label, key: secret, groupLabel: group.trim() || null }, { success: "Key added. FreeLLMAPI will check it shortly." });
        if (r.ok) {
          setSecret("");
          setLabel("");
        }
        // The secret is never kept after a failed attempt either.
        if (!r.ok) setSecret("");
      }}
    >
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <label className="block text-sm text-ink-2">
          Service
          {providers.length ? (
            <select value={platform} onChange={(e) => setPlatform(e.target.value)} className="field mt-1" required>
              <option value="" disabled>
                Choose…
              </option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          ) : (
            <input value={platform} onChange={(e) => setPlatform(e.target.value)} className="field mt-1" placeholder="e.g. groq" required />
          )}
        </label>
        <label className="block text-sm text-ink-2">
          Label
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="field mt-1" placeholder="e.g. work account" />
        </label>
        <label className="block text-sm text-ink-2">
          API key
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className="field mt-1 font-mono" placeholder="paste the key" autoComplete="new-password" required />
        </label>
        <label className="block text-sm text-ink-2">
          <span className="inline-flex items-center gap-1">
            Quota group <HelpTip term="quotaScope" />
          </span>
          <input value={group} onChange={(e) => setGroup(e.target.value)} className="field mt-1" placeholder="same account? same group" list="key-groups" />
          <datalist id="key-groups">
            {groups.map((g) => (
              <option key={g} value={g} />
            ))}
          </datalist>
        </label>
      </div>
      <p className="text-xs text-ink-3">The key is sent straight to FreeLLMAPI and stored there. It is never shown again, here or anywhere else in the panel.</p>
      <div className="flex items-center gap-3">
        <button type="submit" className={buttonClass("primary")} disabled={busy || !platform || !secret}>
          <Plus size={14} aria-hidden /> Add key
        </button>
        <ActionStatus error={error} message={message} />
      </div>
    </form>
  );
}
