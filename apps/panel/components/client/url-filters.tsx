"use client";

import { usePathname, useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { Search } from "lucide-react";

export type FilterField =
  | { name: string; label: string; kind: "select"; options: Array<[string, string]>; anyLabel?: string }
  | { name: string; label: string; kind: "text"; placeholder?: string };

/** Filter row bound to the URL query, so filtered views can be bookmarked and survive refresh. */
export function UrlFilters({ fields, values }: { fields: FilterField[]; values: Record<string, string> }) {
  const router = useRouter();
  const path = usePathname();
  const [pending, start] = useTransition();
  const [draft, setDraft] = useState(values);
  const key = JSON.stringify(values);
  // Reset the draft only when the applied filters change (not on every live refresh).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDraft(JSON.parse(key) as Record<string, string>), [key]);

  const apply = (next: Record<string, string>) => {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(next)) if (v) qs.set(k, v);
    start(() => router.replace(qs.size ? `${path}?${qs}` : path));
  };
  const any = Object.values(values).some(Boolean);

  return (
    <form
      className="flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        apply(draft);
      }}
      aria-busy={pending}
    >
      {fields.map((f) =>
        f.kind === "select" ? (
          <label key={f.name} className="flex flex-col gap-1 text-xs text-ink-3">
            {f.label}
            <select
              value={draft[f.name] ?? ""}
              onChange={(e) => {
                const next = { ...draft, [f.name]: e.target.value };
                setDraft(next);
                apply(next);
              }}
              className="field w-auto py-1.5"
            >
              <option value="">{f.anyLabel ?? "Any"}</option>
              {f.options.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label key={f.name} className="flex min-w-[12rem] flex-1 flex-col gap-1 text-xs text-ink-3">
            {f.label}
            <span className="relative">
              <Search size={14} className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2" aria-hidden />
              <input
                value={draft[f.name] ?? ""}
                onChange={(e) => setDraft({ ...draft, [f.name]: e.target.value })}
                onBlur={() => draft[f.name] !== values[f.name] && apply(draft)}
                placeholder={f.placeholder}
                className="field pl-8"
              />
            </span>
          </label>
        ),
      )}
      <button type="submit" className="sr-only">
        Apply
      </button>
      {any ? (
        <button
          type="button"
          className="mb-2 text-xs text-accent-ink hover:underline"
          onClick={() => {
            const cleared = Object.fromEntries(Object.keys(values).map((k) => [k, ""]));
            setDraft(cleared);
            apply({});
          }}
        >
          Clear filters
        </button>
      ) : null}
      {pending ? <span className="mb-2 text-xs text-ink-3">Loading…</span> : null}
    </form>
  );
}
