import { closeSync, existsSync, openSync, readFileSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { z } from "zod";
import { commitAs, parseTrailers, type Actor } from "../attribution/index.js";
import { normalizeBrainPath } from "../brain/brain.js";
import type { PromotionRecord, PromotionStatus } from "../brain/promotion.js";
import { SwitchyardError } from "../core/errors.js";
import type { Switchyard } from "../core/service.js";
import { git } from "../workspaces/git.js";

// Global knowledge for the panel (decision D9): what landed in `global/` and where it came from,
// the promotions waiting for a person, and reverting a global entry. Supervisors write `global/`
// only through the gated promotion in brain/promotion.ts; people review it here.

const HUMAN = { kind: "human" } as const;
const PROMOTION_ID_RE = /^[a-z0-9_-]{1,120}$/;
const GLOSSARY = "global/glossary.md";
/** Commit trailers a revert records (who, why, and what was removed). */
const REVERT_TRAILERS = { by: "Reverted-By", reason: "Revert-Reason", title: "Reverted-Title", promotion: "Promotion", project: "Project" } as const;

/** Where a global entry came from, read from its front matter (null fields when not recorded). */
export interface GlobalProvenance {
  project: string | null;
  promotion: string | null;
  /** The supervisor (or person) that promoted it. */
  promotedBy: string | null;
  supervisorModel: string | null;
  supervisorTask: string | null;
  sources: string[];
  review: { verdict: string | null; reviewer: string | null; reviewerModel: string | null; reviewTask: string | null; rubric: string | null; reasons: string[] } | null;
  approvedBy: string | null;
  promotedAt: string | null;
}

export interface GlobalEntry {
  path: string;
  title: string;
  kind: "lesson" | "glossary" | "other";
  /** The entry's markdown without its front matter (and without the leading title heading). */
  body: string;
  /** Null when the file has no front matter (written by hand, or before D9). */
  provenance: GlobalProvenance | null;
  mtime: number;
  /** Whether the panel may revert it (every global entry except the glossary file itself). */
  revertable: boolean;
}

export interface GlobalRevert {
  commit: string;
  date: string;
  /** The removed brain paths (usually one). */
  paths: string[];
  subject: string;
  revertedBy: string | null;
  reason: string | null;
  title: string | null;
  promotion: string | null;
  project: string | null;
}

export interface GlobalKnowledge {
  generatedAt: number;
  /** `brain.global_requires_approval`: supervisors' promotions wait for a person after review. */
  requiresApproval: boolean;
  lessons: GlobalEntry[];
  glossary: GlobalEntry | null;
  /** Other files under `global/` (facts, notes written by people). */
  other: GlobalEntry[];
  /** Global entries removed from the brain, newest first (from the brain's git history). */
  reverts: GlobalRevert[];
}

const Str = z.string().max(4000);
const OptStr = z
  .union([Str, z.number(), z.null()])
  .optional()
  .transform((v) => (v === undefined || v === null ? null : String(v)));
const ProvenanceSchema = z
  .object({
    project: OptStr,
    promotion: OptStr,
    promoted_by: OptStr,
    supervisor_model: OptStr,
    supervisor_task: OptStr,
    sources: z.array(Str).max(50).optional().catch([]),
    review: z
      .object({ verdict: OptStr, reviewer: OptStr, reviewer_model: OptStr, review_task: OptStr, rubric: OptStr, reasons: z.array(Str).max(50).optional().catch([]) })
      .passthrough()
      .nullable()
      .optional()
      .catch(null),
    approved_by: OptStr,
    promoted_at: z
      .union([Str, z.date()])
      .optional()
      .nullable()
      .transform((v) => (v instanceof Date ? v.toISOString() : (v ?? null))),
  })
  .passthrough();

function splitEntry(text: string): { meta: unknown; rest: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: null, rest: text };
  try {
    return { meta: YAML.parse(m[1]!), rest: m[2]! };
  } catch {
    return { meta: null, rest: m[2]! };
  }
}

/** Parse a global entry's front matter into provenance (null when it has none or it does not validate). */
export function parseGlobalProvenance(text: string): { provenance: GlobalProvenance | null; body: string; title: string | null } {
  const { meta, rest } = splitEntry(text);
  const heading = /^\s*# ([^\n]+)\n*/.exec(rest);
  const body = (heading ? rest.slice(heading[0].length) : rest).trimEnd();
  const title = heading ? heading[1]!.trim() : null;
  if (!meta || typeof meta !== "object") return { provenance: null, body, title };
  const p = ProvenanceSchema.safeParse(meta);
  if (!p.success) return { provenance: null, body, title };
  const d = p.data;
  return {
    title,
    body,
    provenance: {
      project: d.project,
      promotion: d.promotion,
      promotedBy: d.promoted_by,
      supervisorModel: d.supervisor_model,
      supervisorTask: d.supervisor_task,
      sources: d.sources ?? [],
      review: d.review ? { verdict: d.review.verdict, reviewer: d.review.reviewer, reviewerModel: d.review.reviewer_model, reviewTask: d.review.review_task, rubric: d.review.rubric, reasons: d.review.reasons ?? [] } : null,
      approvedBy: d.approved_by,
      promotedAt: d.promoted_at,
    },
  };
}

function entryOf(sy: Switchyard, rel: string): GlobalEntry | null {
  const r = sy.brain.resolve(rel);
  if (!existsSync(r.abs)) return null;
  const text = readFileSync(r.abs, "utf8");
  const { provenance, body, title } = parseGlobalProvenance(text);
  const kind: GlobalEntry["kind"] = rel === GLOSSARY ? "glossary" : rel.startsWith("global/lessons/") ? "lesson" : "other";
  return { path: rel, title: title ?? path.posix.basename(rel, ".md"), kind, body, provenance, mtime: statSync(r.abs).mtimeMs, revertable: rel !== GLOSSARY };
}

/** The global brain's entries with provenance, and the history of removed ones. */
export async function globalKnowledge(sy: Switchyard, opts: { revertLimit?: number } = {}): Promise<GlobalKnowledge> {
  const brain = sy.brain;
  await brain.ensure();
  const entries = brain
    .list(HUMAN, "global")
    .map((e) => entryOf(sy, e.path))
    .filter((e): e is GlobalEntry => e !== null);
  const byNewest = (a: GlobalEntry, b: GlobalEntry) => (b.provenance?.promotedAt ?? "").localeCompare(a.provenance?.promotedAt ?? "") || b.mtime - a.mtime;
  return {
    generatedAt: Date.now(),
    requiresApproval: sy.cfg.brain.global_requires_approval,
    lessons: entries.filter((e) => e.kind === "lesson").sort(byNewest),
    glossary: entries.find((e) => e.kind === "glossary") ?? null,
    other: entries.filter((e) => e.kind === "other").sort(byNewest),
    reverts: await globalReverts(sy, opts.revertLimit ?? 50),
  };
}

/** Global entries removed from the brain (by a revert, or by hand), newest first. */
export async function globalReverts(sy: Switchyard, limit = 50): Promise<GlobalRevert[]> {
  const r = sy.brain.resolve("global");
  if (!r.repo || !r.commit || !existsSync(path.join(r.repo, ".git"))) return [];
  const raw = await git(r.repo, ["log", `-${Math.max(1, Math.min(limit, 500))}`, "--diff-filter=D", "--name-only", "--format=%x1e%H%x1f%aI%x1f%s%x1f%(trailers:unfold)%x1f", "--", r.repoRel || "."]).catch(() => "");
  const prefix = r.repoRel ? `${r.repoRel}/` : "";
  return raw
    .split("\x1e")
    .map((rec) => rec.trim())
    .filter(Boolean)
    .map((rec) => {
      const [commit, date, subject, trailers, files] = rec.split("\x1f");
      const t = parseTrailers(trailers ?? "");
      const paths = (files ?? "")
        .split(/\r?\n/)
        .map((f) => f.trim())
        .filter(Boolean)
        .map((f) => `global/${prefix && f.startsWith(prefix) ? f.slice(prefix.length) : f.replace(/^global\//, "")}`);
      return {
        commit: commit!,
        date: date!,
        subject: subject ?? "",
        paths,
        revertedBy: t[REVERT_TRAILERS.by] ?? t.Agent ?? null,
        reason: t[REVERT_TRAILERS.reason] ?? null,
        title: t[REVERT_TRAILERS.title] ?? null,
        promotion: t[REVERT_TRAILERS.promotion] ?? null,
        project: t[REVERT_TRAILERS.project] ?? null,
      };
    });
}

/** A promotion as the panel lists it: the record plus whether a person may decide it now. */
export interface PromotionView extends PromotionRecord {
  /** Pending approval, or pending review with no review running (no reviewer, or reviews did not settle). */
  awaitingPerson: boolean;
}

/** Promotions across projects (or one project), newest first; `status` filters them. */
export function promotionsView(sy: Switchyard, opts: { project?: string; status?: PromotionStatus | "awaiting_person" } = {}): PromotionView[] {
  if (opts.project !== undefined) requireProject(sy, opts.project);
  const status = opts.status === "awaiting_person" ? undefined : opts.status;
  const all = sy.promotions({ ...(opts.project ? { project: opts.project } : {}), ...(status ? { status } : {}) }).map((r) => ({ ...r, awaitingPerson: awaitingPerson(r) }));
  return opts.status === "awaiting_person" ? all.filter((r) => r.awaitingPerson) : all;
}

function awaitingPerson(r: PromotionRecord): boolean {
  return r.status === "pending_approval" || (r.status === "pending_review" && !r.review.task_id);
}

function requireProject(sy: Switchyard, project: string): void {
  if (!sy.projects.get(project)) throw new SwitchyardError("not_found", `unknown project ${project}`);
}

/**
 * A person approves or rejects a waiting promotion of `project`. A rejection needs a reason; the
 * lesson is then kept in the project. Only waiting promotions can be decided.
 */
export async function decideGlobalPromotion(sy: Switchyard, project: string, id: string, approve: boolean, by: string, reason = ""): Promise<PromotionView> {
  requireProject(sy, project);
  if (!PROMOTION_ID_RE.test(id)) throw new SwitchyardError("task_invalid", `invalid promotion id ${id}`);
  const current = sy.brainFor(project).promotions.get(id);
  if (!current) throw new SwitchyardError("not_found", `unknown promotion ${id} in project ${project}`);
  if (!approve && !reason.trim()) throw new SwitchyardError("reason_required", "a rejection needs a reason; it is kept with the lesson in the project");
  if (!awaitingPerson(current)) {
    const why = current.status === "pending_review" ? `it is under review (task ${current.review.task_id})` : `it was already ${current.status}${current.decided_by ? ` by ${current.decided_by}` : ""}`;
    throw new SwitchyardError("usage", `promotion ${id} cannot be decided now: ${why}`);
  }
  try {
    const r = await sy.decidePromotion(project, id, approve, by, reason.trim());
    return { ...r, awaitingPerson: awaitingPerson(r) };
  } catch (err) {
    const e = err as Error & { code?: unknown };
    if (e.code === "brain_rejected") throw new SwitchyardError("usage", e.message);
    throw err;
  }
}

export interface RevertOutcome {
  path: string;
  commit: string;
  revertedBy: string;
  reason: string;
  title: string;
  promotion: string | null;
  project: string | null;
}

/** Validate a path a person asked to revert: a markdown file under `global/`, not the glossary. */
function revertPath(input: string): string {
  let rel: string;
  try {
    rel = normalizeBrainPath(input);
  } catch (err) {
    throw new SwitchyardError("task_invalid", (err as Error).message);
  }
  if (!rel.startsWith("global/") || !rel.endsWith(".md")) throw new SwitchyardError("task_invalid", `only global entries (global/**/*.md) can be reverted: ${input}`);
  if (rel === GLOSSARY) throw new SwitchyardError("task_invalid", "the glossary is one shared file; edit its terms on a project's Brain page instead of reverting it");
  return rel;
}

/**
 * Hold the brain repository's cross-process lock (the same lock file `Brain` writes take), so a
 * revert never interleaves with a promotion or another write.
 */
async function withBrainLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const lock = path.join(repo, ".switchyard-brain.lock");
  const deadline = Date.now() + 15_000;
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 60_000) unlinkSync(lock);
      } catch {
        // the lock disappeared meanwhile
      }
      if (Date.now() > deadline) throw new SwitchyardError("usage", "the brain is locked by another process; try again");
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  try {
    return await fn();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already removed
    }
  }
}

/**
 * Revert a global entry: one brain commit, made as a person, that removes the file. The commit
 * records who reverted it and why (trailers `Reverted-By`, `Revert-Reason`, and the entry's title,
 * promotion, and project), so the entry and its removal stay in the brain's history. The
 * promotion record (if any) is left as it was: it still names where the lesson went, so a settle
 * never writes it again.
 */
export async function revertGlobalEntry(sy: Switchyard, input: string, by: string, reason: string): Promise<RevertOutcome> {
  const rel = revertPath(input);
  const why = reason.trim().replace(/\s+/g, " ");
  if (!why) throw new SwitchyardError("reason_required", "say why the entry is reverted; the reason is recorded in the brain's history");
  const who = by.trim() || "user";
  const brain = sy.brain;
  await brain.ensure();
  const r = brain.resolve(rel);
  if (!r.repo || !r.commit) throw new SwitchyardError("usage", `${rel} is not committed by SwitchYard (brain.commit is off, or its mount does not commit), so a revert could not be recorded`);
  const repo = r.repo;
  const out = await withBrainLock(repo, async () => {
    if (!existsSync(r.abs)) throw new SwitchyardError("not_found", `${rel} does not exist (already reverted?)`);
    const text = readFileSync(r.abs, "utf8");
    const parsed = parseGlobalProvenance(text);
    const title = (parsed.title ?? path.posix.basename(rel, ".md")).slice(0, 200);
    const actor: Actor = { agent: "human", role: "human" };
    // A file written outside SwitchYard and never committed is recorded first, so the revert removes a tracked file.
    const tracked = (await git(repo, ["ls-files", "--", r.repoRel])).trim();
    if (!tracked) await commitAs(repo, actor, "Record edits made outside SwitchYard", { paths: [r.repoRel] });
    unlinkSync(r.abs);
    const trailers: Record<string, string> = { [REVERT_TRAILERS.by]: who.slice(0, 200), [REVERT_TRAILERS.reason]: why.slice(0, 1000), [REVERT_TRAILERS.title]: title };
    if (parsed.provenance?.promotion) trailers[REVERT_TRAILERS.promotion] = parsed.provenance.promotion;
    if (parsed.provenance?.project) trailers[REVERT_TRAILERS.project] = parsed.provenance.project;
    const commit = await commitAs(repo, actor, `Revert global entry ${rel}`.slice(0, 200), { paths: [r.repoRel], extraTrailers: trailers });
    if (!commit) throw new SwitchyardError("usage", `removing ${rel} produced no commit`);
    if (sy.cfg.brain.push) await git(repo, ["push", "-q"]).catch(() => undefined);
    return { path: rel, commit, revertedBy: who, reason: why, title, promotion: parsed.provenance?.promotion ?? null, project: parsed.provenance?.project ?? null };
  });
  await brain.refreshIndex().catch(() => undefined);
  return out;
}
