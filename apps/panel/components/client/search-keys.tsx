"use client";

import { useState } from "react";
import { Plus } from "lucide-react";
import { ActionStatus, useAction } from "./actions";
import { buttonClass } from "../ui";

export interface SearchServiceOption {
  id: string;
  displayName: string;
  signupUrl: string;
  note: string;
}

/**
 * Add a Tavily, Brave, or Exa key for agents' web search. The key goes to the encrypted vault
 * (like provider keys) and is never routed for chat; the secret is cleared from the page after
 * submitting, whether or not it was stored.
 */
export function AddSearchKeyForm({ services }: { services: SearchServiceOption[] }) {
  const [service, setService] = useState("");
  const [secret, setSecret] = useState("");
  const [label, setLabel] = useState("");
  const { run, busy, error, errors, message } = useAction();
  const chosen = services.find((s) => s.id === service) ?? null;
  return (
    <form
      className="space-y-3"
      autoComplete="off"
      onSubmit={async (e) => {
        e.preventDefault();
        const r = await run("/api/web-search", "POST", { service, secret, label }, { success: "Search key stored in the encrypted vault. Only its last four characters are ever shown." });
        setSecret("");
        if (r.ok) setLabel("");
      }}
    >
      <div className="grid gap-3 md:grid-cols-3">
        <label className="block text-xs font-medium text-ink-2">
          Search service
          <select value={service} onChange={(e) => setService(e.target.value)} className="field mt-1" required>
            <option value="" disabled>
              Choose…
            </option>
            {services.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </label>
        <label className="block text-xs font-medium text-ink-2">
          API key
          <input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} className="field mt-1 font-mono" placeholder="paste the key" autoComplete="new-password" required minLength={8} />
        </label>
        <label className="block text-xs font-medium text-ink-2">
          Label (optional)
          <input value={label} onChange={(e) => setLabel(e.target.value)} className="field mt-1" maxLength={80} placeholder="personal" />
        </label>
      </div>
      {chosen ? (
        <p className="text-xs text-ink-3">
          {chosen.displayName}: {chosen.note}. Get a key at{" "}
          <a href={chosen.signupUrl} target="_blank" rel="noreferrer" className="text-accent-ink hover:underline">
            {chosen.signupUrl}
          </a>
          .
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" disabled={busy || !service || secret.length < 8} className={buttonClass("primary", true)}>
          <Plus size={13} aria-hidden /> Add search key
        </button>
      </div>
      <ActionStatus error={error} message={message} errors={errors} />
    </form>
  );
}
