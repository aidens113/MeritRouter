"use client";

import { useRouter } from "next/navigation";
import { useId, useState, type ReactNode } from "react";
import { FolderPlus, Plus, RefreshCw, Trash2 } from "lucide-react";
import { buttonClass, cx } from "../ui";
import { callApi } from "./actions";
import { projectBase, SLUG_RE, slugify } from "@/lib/links";

type Repo = { alias: string; path: string; writable: boolean };
type Mount = { prefix: string; path: string; commit: boolean };
type FieldErrors = Record<string, string[]>;

const SLUG_HINT = "Lower-case letters, digits, '.', '_', '-', starting with a letter or digit. Used in URLs and in the brain (projects/<slug>/).";

function Field({ id, label, hint, errors, children }: { id: string; label: ReactNode; hint?: ReactNode; errors?: string[]; children: ReactNode }) {
  return (
    <div className="min-w-0">
      <label htmlFor={id} className="block text-sm font-medium text-ink">
        {label}
      </label>
      <div className="mt-1">{children}</div>
      {errors?.length ? (
        <ul id={`${id}-error`} className="mt-1 space-y-0.5 text-xs text-bad-ink">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-xs text-ink-3">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Create a project: name, slug (derived from the name until you edit it), repositories (checked on
 * the server: each must exist and be a git repository), and optional brain mounts. The server
 * validates everything; its errors come back per field and show beside the input.
 */
export function NewProjectForm({ configDir }: { configDir: string }) {
  const router = useRouter();
  const uid = useId();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugEdited, setSlugEdited] = useState(false);
  const [repos, setRepos] = useState<Repo[]>([{ alias: "app", path: "", writable: true }]);
  const [mounts, setMounts] = useState<Mount[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const fe = (k: string) => fieldErrors[k];
  const invalid = (k: string) => Boolean(fe(k)?.length);
  const describedBy = (id: string, k: string) => (invalid(k) ? `${id}-error` : `${id}-hint`);
  const slugProblem = slug && !SLUG_RE.test(slug) ? "Not a valid slug: lower-case letters, digits, '.', '_', '-', starting with a letter or digit." : null;

  const setRepo = (i: number, patch: Partial<Repo>) => setRepos((rs) => rs.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const setMount = (i: number, patch: Partial<Mount>) => setMounts((ms) => ms.map((m, j) => (j === i ? { ...m, ...patch } : m)));
  const filled = <T,>(rows: T[], used: (x: T) => boolean) => rows.map((x, i) => [x, i] as const).filter(([x]) => used(x)).map(([, i]) => i);
  const repoUsed = (r: Repo) => Boolean(r.alias.trim() || r.path.trim());
  const mountUsed = (m: Mount) => Boolean(m.prefix.trim() || m.path.trim());

  const submit = async () => {
    setBusy(true);
    setError(null);
    setFieldErrors({});
    const body = {
      name: name.trim(),
      slug: slug.trim(),
      // Rows left completely empty are ignored rather than reported.
      repositories: repos.filter(repoUsed).map((r) => ({ alias: r.alias.trim(), path: r.path.trim(), writable: r.writable })),
      mounts: mounts.filter(mountUsed).map((m) => ({ prefix: m.prefix.trim(), path: m.path.trim(), commit: m.commit })),
    };
    const r = await callApi("/api/projects", "POST", body);
    if (r.ok) {
      const created = (r.project as { slug?: string } | undefined)?.slug ?? body.slug;
      router.push(projectBase(created));
      router.refresh();
      return;
    }
    setBusy(false);
    // Field keys index the rows sent; map them back to the rows on screen (empty rows were not sent).
    const sentRepos = filled(repos, repoUsed);
    const sentMounts = filled(mounts, mountUsed);
    const mapped: FieldErrors = {};
    for (const [k, v] of Object.entries((r.fieldErrors as FieldErrors | undefined) ?? {})) {
      const m = /^(repositories|mounts)\.(\d+)(\..*)?$/.exec(k);
      const key = m ? `${m[1]}.${(m[1] === "repositories" ? sentRepos : sentMounts)[Number(m[2])] ?? m[2]}${m[3] ?? ""}` : k;
      mapped[key] = [...(mapped[key] ?? []), ...v];
    }
    setFieldErrors(mapped);
    setError(r.error ?? "The project was not created.");
  };

  const nameId = `${uid}-name`;
  const slugId = `${uid}-slug`;

  return (
    <form
      noValidate
      className="space-y-6"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      {error ? (
        <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft px-3 py-2 text-sm text-bad-ink">
          {error}
        </div>
      ) : null}

      <div className="grid gap-4 sm:grid-cols-2">
        <Field id={nameId} label="Name" hint="Shown on the projects grid and in the switcher." errors={fe("name")}>
          <input
            id={nameId}
            value={name}
            onChange={(e) => {
              setName(e.target.value);
              if (!slugEdited) setSlug(slugify(e.target.value));
            }}
            className={cx("field", invalid("name") && "border-bad")}
            placeholder="e.g. Storefront"
            maxLength={80}
            autoFocus
            aria-invalid={invalid("name")}
            aria-describedby={describedBy(nameId, "name")}
          />
        </Field>
        <Field id={slugId} label="Slug" hint={slugProblem ?? SLUG_HINT} errors={fe("slug")}>
          <input
            id={slugId}
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase());
              setSlugEdited(true);
            }}
            className={cx("field font-mono text-[13px]", (invalid("slug") || slugProblem) && "border-bad")}
            placeholder="e.g. storefront"
            maxLength={64}
            spellCheck={false}
            autoCapitalize="off"
            aria-invalid={invalid("slug") || Boolean(slugProblem)}
            aria-describedby={describedBy(slugId, "slug")}
          />
        </Field>
      </div>

      <fieldset className="space-y-3">
        <legend className="text-sm font-medium text-ink">Repositories</legend>
        <p className="text-xs text-ink-3">
          Each needs an alias (how tasks name it) and its folder: absolute, or relative to <span className="break-all font-mono">{configDir}</span>. The folder must exist and be a git repository. Two projects may use the same alias.
        </p>
        {repos.map((r, i) => {
          const aliasId = `${uid}-repo-${i}-alias`;
          const pathId = `${uid}-repo-${i}-path`;
          const ak = `repositories.${i}.alias`;
          const pk = `repositories.${i}.path`;
          return (
            <div key={i} className="grid gap-2 rounded-lg border border-line p-3 sm:grid-cols-[9rem_1fr_auto] sm:items-start">
              <Field id={aliasId} label={<span className="text-xs">Alias</span>} errors={fe(ak)}>
                <input id={aliasId} value={r.alias} onChange={(e) => setRepo(i, { alias: e.target.value })} className={cx("field font-mono text-[13px]", invalid(ak) && "border-bad")} placeholder="app" spellCheck={false} aria-invalid={invalid(ak)} aria-describedby={describedBy(aliasId, ak)} />
              </Field>
              <Field id={pathId} label={<span className="text-xs">Folder</span>} errors={fe(pk)}>
                <input id={pathId} value={r.path} onChange={(e) => setRepo(i, { path: e.target.value })} className={cx("field font-mono text-[13px]", invalid(pk) && "border-bad")} placeholder="../my-app" spellCheck={false} aria-invalid={invalid(pk)} aria-describedby={describedBy(pathId, pk)} />
              </Field>
              <div className="flex items-center gap-3 sm:pt-6">
                <label className="flex items-center gap-1.5 text-xs text-ink-2">
                  <input type="checkbox" checked={r.writable} onChange={(e) => setRepo(i, { writable: e.target.checked })} /> writable
                </label>
                <button type="button" className={buttonClass("ghost", true)} onClick={() => setRepos((rs) => rs.filter((_, j) => j !== i))} aria-label={`Remove repository ${r.alias || i + 1}`}>
                  <Trash2 size={13} aria-hidden />
                </button>
              </div>
            </div>
          );
        })}
        <button type="button" className={buttonClass("secondary", true)} onClick={() => setRepos((rs) => [...rs, { alias: "", path: "", writable: true }])}>
          <Plus size={13} aria-hidden /> Add repository
        </button>
      </fieldset>

      <details className="rounded-lg border border-line" open={mounts.length > 0}>
        <summary className="cursor-pointer px-3 py-2 text-sm font-medium text-ink">Brain mounts (optional)</summary>
        <div className="space-y-3 border-t border-line p-3">
          <p className="text-xs text-ink-3">Extra folders of markdown this project&apos;s agents can read in the brain under a prefix, such as the docs folder of a repository.</p>
          {mounts.map((m, i) => {
            const prefixId = `${uid}-mount-${i}-prefix`;
            const pathId = `${uid}-mount-${i}-path`;
            const xk = `mounts.${i}.prefix`;
            const pk = `mounts.${i}.path`;
            return (
              <div key={i} className="grid gap-2 sm:grid-cols-[9rem_1fr_auto] sm:items-start">
                <Field id={prefixId} label={<span className="text-xs">Prefix</span>} errors={fe(xk)}>
                  <input id={prefixId} value={m.prefix} onChange={(e) => setMount(i, { prefix: e.target.value })} className={cx("field font-mono text-[13px]", invalid(xk) && "border-bad")} placeholder="docs" spellCheck={false} aria-invalid={invalid(xk)} aria-describedby={describedBy(prefixId, xk)} />
                </Field>
                <Field id={pathId} label={<span className="text-xs">Folder</span>} errors={fe(pk)}>
                  <input id={pathId} value={m.path} onChange={(e) => setMount(i, { path: e.target.value })} className={cx("field font-mono text-[13px]", invalid(pk) && "border-bad")} placeholder="../my-app/docs" spellCheck={false} aria-invalid={invalid(pk)} aria-describedby={describedBy(pathId, pk)} />
                </Field>
                <div className="flex items-center gap-3 sm:pt-6">
                  <label className="flex items-center gap-1.5 text-xs text-ink-2">
                    <input type="checkbox" checked={m.commit} onChange={(e) => setMount(i, { commit: e.target.checked })} /> commit edits
                  </label>
                  <button type="button" className={buttonClass("ghost", true)} onClick={() => setMounts((ms) => ms.filter((_, j) => j !== i))} aria-label={`Remove mount ${m.prefix || i + 1}`}>
                    <Trash2 size={13} aria-hidden />
                  </button>
                </div>
              </div>
            );
          })}
          <button type="button" className={buttonClass("secondary", true)} onClick={() => setMounts((ms) => [...ms, { prefix: "", path: "", commit: false }])}>
            <Plus size={13} aria-hidden /> Add mount
          </button>
        </div>
      </details>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <button type="submit" className={buttonClass("primary")} disabled={busy}>
          {busy ? <RefreshCw size={14} className="animate-spin" aria-hidden /> : <FolderPlus size={15} aria-hidden />} Create project
        </button>
        <span className="text-xs text-ink-3">Opens the new project&apos;s overview.</span>
      </div>
    </form>
  );
}
