import { createHash, randomBytes } from "node:crypto";
import YAML from "yaml";
import { z } from "zod";
import type { Actor } from "../attribution/index.js";
import type { Principal } from "./access.js";

/**
 * Gated promotion of a lesson to global knowledge (decision D9). Only supervisors (and people)
 * promote; no grant lets an agent write `global/` directly (`systemManaged` in access.ts). A
 * supervisor's lesson must pass, in order:
 *
 * 1. a deterministic check (`projectSpecificIssues`): it names nothing of its project (slug,
 *    name, repository aliases or paths, files inside them) and cites at least one source in the
 *    project's brain;
 * 2. an independent review on a model other than the supervisor's (a `PromotionReviewPort`,
 *    implemented by `verification/promotion-review.ts` through the Gate), judging "applies beyond
 *    this project" against a fixed rubric. Without an eligible reviewer the promotion waits;
 * 3. optionally (`brain.global_requires_approval`) a person's approval.
 *
 * A rejected lesson is saved to the project (`projects/<p>/decisions/lessons/`) with the reason.
 * Every promotion has a record under `projects/<p>/promotions/<id>.md` (written only by
 * SwitchYard), which is what the panel lists; a global lesson's front matter carries its project,
 * supervisor, sources, and review verdict with the reviewer's model.
 */

/** `reverted`: a person removed the approved lesson from `global/` again (who, when, and why are kept). */
export const PROMOTION_STATUSES = ["pending_review", "pending_approval", "approved", "rejected", "reverted"] as const;
export type PromotionStatus = (typeof PROMOTION_STATUSES)[number];

/** Review attempts (reviewer failures or inconclusive verdicts) before a person must decide. */
export const MAX_PROMOTION_REVIEWS = 3;

export interface PromotionCandidate {
  title: string;
  body: string;
  sources: string[];
}

/** What a lesson must not name: its project and that project's repositories. */
export interface ProjectScope {
  slug: string;
  name: string;
  repositories: Array<{ alias: string; path: string }>;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const slash = (s: string) => s.replace(/\\/g, "/");

/** Path-like tokens in prose: at least one `/` (or `\`) between name characters. */
const PATH_TOKEN_RE = /[A-Za-z0-9_.@-]+(?:[/\\][A-Za-z0-9_.@-]+)+/g;

/**
 * The deterministic check. Returns the reasons the candidate is project-specific or unsupported
 * (empty when it may go to review). `brainHas` tells whether a brain path exists; `repoHas`
 * whether a relative path exists inside a repository root.
 */
export function projectSpecificIssues(c: PromotionCandidate, scope: ProjectScope, io: { brainHas: (rel: string) => boolean; repoHas: (root: string, rel: string) => boolean }): string[] {
  const issues: string[] = [];
  const title = c.title.trim();
  const body = c.body.trim();
  if (!title) issues.push("the lesson needs a title");
  if (title.length > 200) issues.push("the title is longer than 200 characters");
  if (!body) issues.push("the lesson needs a body");
  if (body.length > 20_000) issues.push("the body is longer than 20000 characters");
  const text = `${title}\n${body}`;

  const terms: Array<{ term: string; what: string }> = [
    { term: scope.slug, what: "the project's slug" },
    { term: scope.name, what: "the project's name" },
    ...scope.repositories.map((r) => ({ term: r.alias, what: `repository alias` })),
  ];
  const seen = new Set<string>();
  for (const { term, what } of terms) {
    const t = term.trim();
    if (t.length < 2 || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    if (new RegExp(`(?<![A-Za-z0-9])${escapeRe(t)}(?![A-Za-z0-9])`, "i").test(text)) issues.push(`it names ${what} "${t}"`);
  }

  const lower = slash(text).toLowerCase();
  for (const r of scope.repositories) {
    const root = slash(r.path).replace(/\/+$/, "");
    if (root && lower.includes(root.toLowerCase())) issues.push(`it names the path of repository ${r.alias}`);
  }
  const tokens = new Set((text.match(PATH_TOKEN_RE) ?? []).map((t) => slash(t).replace(/^\.\/+/, "").replace(/[.,;:]+$/, "")));
  for (const token of tokens) {
    if (!token || token.startsWith("/") || token.split("/").includes("..")) continue;
    const r = scope.repositories.find((repo) => {
      try {
        return io.repoHas(repo.path, token);
      } catch {
        return false;
      }
    });
    if (r) issues.push(`it names ${token}, a path inside repository ${r.alias}`);
  }

  const own = `projects/${scope.slug}/`;
  if (!c.sources.length) issues.push(`cite at least one source in the project's brain (${own}...)`);
  if (c.sources.length > 20) issues.push("cite at most 20 sources");
  let ownCited = false;
  for (const s of c.sources) {
    const p = slash(s).replace(/^\.?\/+/, "");
    const inScope = p.toLowerCase().startsWith(own.toLowerCase()) || p.toLowerCase().startsWith("global/");
    if (!inScope) issues.push(`source ${s} is not in this project's brain or global/`);
    else if (!io.brainHas(p)) issues.push(`source ${s} does not exist in the brain`);
    else if (p.toLowerCase().startsWith(own.toLowerCase())) ownCited = true;
  }
  if (c.sources.length && !ownCited) issues.push(`cite at least one existing source in the project's brain (${own}...)`);
  return issues;
}

/** The text a review is bound to (title, body, sources). */
export function candidateDigest(c: PromotionCandidate): string {
  return `lesson-${createHash("sha256").update(JSON.stringify({ title: c.title.trim(), body: c.body.trim(), sources: c.sources })).digest("hex").slice(0, 16)}`;
}

// ---------- the reviewer port ----------

export interface PromotionReviewRequest {
  project: string;
  recordId: string;
  /** What the verdict must name as its examined revision. */
  digest: string;
  candidate: PromotionCandidate;
  /** The cited sources' text (clipped), shown to the reviewer as evidence. */
  sources: Array<{ path: string; text: string }>;
  /** The promoting supervisor: its task (whose models it used) and its model, when known. */
  supervisor: { taskId: string | null; model: string | null };
}

export type PromotionReviewStart = { kind: "started"; reviewTaskId: string; reviewer: string } | { kind: "unavailable"; reason: string };

export type PromotionReviewResult =
  | { kind: "running" }
  | { kind: "verdict"; verdict: "pass" | "fail" | "inconclusive"; reasons: string[]; reviewer: string | null; reviewerModel: string | null; rubric: string }
  | { kind: "failed"; reason: string };

/** An independent reviewer of promotions (verification/promotion-review.ts runs it through the Gate). */
export interface PromotionReviewPort {
  start(r: PromotionReviewRequest): Promise<PromotionReviewStart>;
  result(reviewTaskId: string, expect: { digest: string; supervisor: { taskId: string | null; model: string | null } }): PromotionReviewResult;
}

// ---------- records ----------

const Iso = z.string().min(1).max(40);
export const PromotionRecordSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9_-]{1,120}$/),
    project: z.string().min(1).max(100),
    title: z.string().min(1).max(200),
    status: z.enum(PROMOTION_STATUSES),
    sources: z.array(z.string().min(1).max(400)).max(20),
    digest: z.string().min(1).max(100),
    supervisor: z.object({ agent: z.string().min(1).max(200), model: z.string().max(200).nullable(), task: z.string().max(100).nullable(), job: z.string().max(100).nullable() }).strict(),
    created_at: Iso,
    review: z
      .object({
        attempts: z.number().int().min(0),
        task_id: z.string().max(100).nullable(),
        reviewer: z.string().max(300).nullable(),
        reviewer_model: z.string().max(300).nullable(),
        verdict: z.enum(["pass", "fail", "inconclusive"]).nullable(),
        reasons: z.array(z.string().max(2000)).max(30),
        rubric: z.string().max(100).nullable(),
      })
      .strict(),
    /** Why it waits, or why it was rejected. */
    reason: z.string().max(4000).nullable(),
    decided_by: z.string().max(200).nullable(),
    decided_at: Iso.nullable(),
    global_path: z.string().max(400).nullable(),
    lesson_path: z.string().max(400).nullable(),
    /** Set when a person reverted the global lesson (absent on records written before reverts existed). */
    reverted_by: z.string().max(200).nullable().optional(),
    reverted_at: Iso.nullable().optional(),
    revert_reason: z.string().max(1000).nullable().optional(),
  })
  .strict();
export type PromotionRecordMeta = z.infer<typeof PromotionRecordSchema>;
export type PromotionRecord = PromotionRecordMeta & { body: string; path: string };

export interface PromotionOutcome {
  id: string | null;
  status: PromotionStatus;
  /** The global lesson (approved), the project lesson (rejected), or the record (pending). */
  path: string;
  commit: string | null;
  reason: string | null;
  /** The deterministic check's findings, when it rejected the lesson. */
  issues: string[];
}

function splitFrontMatter(text: string): { meta: unknown; rest: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return null;
  try {
    return { meta: YAML.parse(m[1]!), rest: m[2]! };
  } catch {
    return null;
  }
}

function frontMatter(meta: unknown, title: string, body: string, footer = ""): string {
  return `---\n${YAML.stringify(meta).trimEnd()}\n---\n\n# ${title}\n\n${body.trim()}\n${footer ? `\n${footer}\n` : ""}`;
}

export function parseRecord(text: string, rel: string): PromotionRecord | null {
  const fm = splitFrontMatter(text);
  if (!fm) return null;
  const meta = PromotionRecordSchema.safeParse(fm.meta);
  if (!meta.success) return null;
  const body = fm.rest.replace(/^\s*# [^\n]*\n+/, "").trimEnd();
  return { ...meta.data, body, path: rel };
}

/** A record's front matter fields (without the body and path a parsed record carries). */
function metaOf(r: PromotionRecordMeta | PromotionRecord): PromotionRecordMeta {
  const { body: _body, path: _path, ...meta } = r as PromotionRecord;
  return meta;
}

function renderRecord(r: PromotionRecordMeta, body: string): string {
  return frontMatter(metaOf(r), r.title, body);
}

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "lesson";

// ---------- the workflow ----------

/** What the promotion workflow needs from its Brain (bound to the Brain's private writer). */
export interface PromotionHost {
  scope(): ProjectScope;
  /** Whether a brain path exists. */
  exists(rel: string): boolean;
  /** A brain file's text (no access check: SwitchYard's own read), or null. */
  readText(rel: string): string | null;
  /** Markdown file names directly inside a brain folder. */
  listDir(rel: string): string[];
  repoHas(root: string, rel: string): boolean;
  /** Write and commit under the repository lock; a function returning null skips the write. */
  write(rel: string, content: string | ((current: string | null) => string | null), actor: Actor, message: string): Promise<{ path: string; commit: string | null }>;
  requiresApproval(): boolean;
  reviewer(): PromotionReviewPort | null;
  error(message: string, issues?: string[]): Error;
  now(): number;
}

const SYSTEM: Actor = { agent: "switchyard", role: "tool" };
const SOURCE_TEXT_MAX = 4000;

export class GlobalPromotions {
  /** Promotions, settles, and decisions run one at a time in this process (see `serial`). */
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly h: PromotionHost) {}

  /**
   * Run one operation after the previous ones. A settle triggered while a promotion is still
   * recording its review task would otherwise see no review running and start a second one.
   */
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.catch(() => undefined).then(fn);
    this.queue = run;
    return run;
  }

  private get slug(): string {
    return this.h.scope().slug;
  }

  private dir(): string {
    return `projects/${this.slug}/promotions`;
  }

  private iso(): string {
    return new Date(this.h.now()).toISOString();
  }

  /** Promote a lesson. People write global knowledge directly; supervisors go through the gates. */
  promote(p: Principal, actor: Actor, c: PromotionCandidate): Promise<PromotionOutcome> {
    return this.serial(() => this.doPromote(p, actor, c));
  }

  private async doPromote(p: Principal, actor: Actor, c: PromotionCandidate): Promise<PromotionOutcome> {
    if (p.kind === "agent" && p.role !== "supervisor") throw this.h.error("only supervisors promote lessons");
    const candidate: PromotionCandidate = { title: c.title.trim().replace(/\s+/g, " "), body: c.body.trim(), sources: [...new Set(c.sources.map((s) => slash(s.trim()).replace(/^\.?\/+/, "")).filter(Boolean))] };
    if (p.kind === "human") {
      if (!candidate.title || !candidate.body) throw this.h.error("a lesson needs a title and a body");
      const res = await this.writeGlobal(null, candidate, {
        project: this.slug,
        promoted_by: p.name ?? actor.agent,
        sources: candidate.sources,
        review: null,
        approved_by: p.name ?? actor.agent,
      });
      return { id: null, status: "approved", path: res.path, commit: res.commit, reason: null, issues: [] };
    }

    const id = `${new Date(this.h.now()).toISOString().slice(0, 10).replace(/-/g, "")}-${slugify(candidate.title).slice(0, 60)}-${randomBytes(3).toString("hex")}`;
    const record: PromotionRecordMeta = {
      id,
      project: this.slug,
      title: (candidate.title || "untitled").slice(0, 200),
      status: "pending_review",
      sources: candidate.sources.slice(0, 20).map((s) => s.slice(0, 400)),
      digest: candidateDigest(candidate),
      // A supervisor principal names its job (its own task) as jobId; its task id is null.
      supervisor: { agent: actor.agent.slice(0, 200), model: actor.model ?? null, task: p.taskId ?? actor.task ?? p.jobId, job: p.jobId },
      created_at: this.iso(),
      review: { attempts: 0, task_id: null, reviewer: null, reviewer_model: null, verdict: null, reasons: [], rubric: null },
      reason: null,
      decided_by: null,
      decided_at: null,
      global_path: null,
      lesson_path: null,
    };
    const issues = projectSpecificIssues(candidate, this.h.scope(), { brainHas: (rel) => this.h.exists(rel), repoHas: (root, rel) => this.h.repoHas(root, rel) });
    if (issues.length) {
      const reason = `not global knowledge: ${issues.join("; ")}`;
      const rejected = await this.rejectTo({ ...record, status: "rejected", reason: reason.slice(0, 4000), decided_by: "switchyard (project-specificity check)", decided_at: this.iso() }, candidate.body);
      return { id, status: "rejected", path: rejected.lesson_path!, commit: null, reason, issues };
    }
    const rel = `${this.dir()}/${id}.md`;
    await this.h.write(rel, renderRecord({ ...record, reason: "waiting for an independent review" }, candidate.body), actor, `Propose global lesson: ${record.title}`);
    const after = await this.startReview(id);
    return { id, status: after?.status ?? "pending_review", path: rel, commit: null, reason: after?.reason ?? null, issues: [] };
  }

  get(id: string): PromotionRecord | null {
    if (!/^[a-z0-9_-]{1,120}$/.test(id)) return null;
    const rel = `${this.dir()}/${id}.md`;
    const text = this.h.readText(rel);
    return text === null ? null : parseRecord(text, rel);
  }

  /** This project's promotion records, newest first (records that fail validation are skipped). */
  list(opts: { status?: PromotionStatus } = {}): PromotionRecord[] {
    const out: PromotionRecord[] = [];
    for (const name of this.h.listDir(this.dir())) {
      const r = this.get(name.replace(/\.md$/, ""));
      if (r && (!opts.status || r.status === opts.status)) out.push(r);
    }
    return out.sort((a, b) => b.created_at.localeCompare(a.created_at) || b.id.localeCompare(a.id));
  }

  /**
   * Move waiting promotions on: collect finished reviews, start reviews for promotions that have
   * none running (a reviewer may have become available), and finish approved promotions whose
   * global lesson is missing (an interrupted write). Safe to call from several processes: every
   * transition re-checks the record's status under the brain lock.
   */
  settle(): Promise<number> {
    return this.serial(() => this.doSettle());
  }

  private async doSettle(): Promise<number> {
    let changed = 0;
    for (const r of this.list()) {
      if (r.status === "approved" && r.global_path === null) {
        await this.finishApproval(r);
        changed++;
        continue;
      }
      if (r.status !== "pending_review") continue;
      if (!r.review.task_id) {
        if (r.review.attempts >= MAX_PROMOTION_REVIEWS) continue;
        const after = await this.startReview(r.id);
        if (after?.review.task_id) changed++;
        continue;
      }
      const port = this.h.reviewer();
      if (!port) continue;
      const res = port.result(r.review.task_id, { digest: r.digest, supervisor: { taskId: r.supervisor.task, model: r.supervisor.model } });
      if (res.kind === "running") continue;
      changed++;
      if (res.kind === "failed" || res.verdict === "inconclusive") {
        const why = res.kind === "failed" ? res.reason : `the reviewer could not decide: ${res.reasons.join("; ") || "inconclusive"}`;
        const exhausted = r.review.attempts >= MAX_PROMOTION_REVIEWS;
        await this.transition(r.id, "pending_review", (x) => ({
          ...x,
          review: { ...x.review, task_id: null, ...(res.kind === "verdict" ? { verdict: res.verdict, reasons: res.reasons.slice(0, 30), reviewer: res.reviewer, reviewer_model: res.reviewerModel, rubric: res.rubric } : {}) },
          reason: `${why.slice(0, 1500)}${exhausted ? `; ${MAX_PROMOTION_REVIEWS} reviews did not settle it, so a person decides` : "; another review will be tried"}`,
        }));
        if (!exhausted) await this.startReview(r.id);
        continue;
      }
      const review = { ...r.review, verdict: res.verdict, reasons: res.reasons.slice(0, 30), reviewer: res.reviewer, reviewer_model: res.reviewerModel, rubric: res.rubric };
      if (res.verdict === "fail") {
        const reason = `the reviewer judged it not global: ${res.reasons.join("; ") || "failed the rubric"}`.slice(0, 4000);
        const cur = await this.transition(r.id, "pending_review", (x) => ({ ...x, status: "rejected", review, reason, decided_by: `reviewer ${res.reviewer ?? "?"}`, decided_at: this.iso() }));
        if (cur) await this.rejectTo(cur, cur.body, true);
        continue;
      }
      if (this.h.requiresApproval()) {
        await this.transition(r.id, "pending_review", (x) => ({ ...x, status: "pending_approval", review, reason: "the review passed; waiting for a person's approval (brain.global_requires_approval)" }));
        continue;
      }
      const cur = await this.transition(r.id, "pending_review", (x) => ({ ...x, status: "approved", review, reason: null, decided_by: "switchyard (review passed)", decided_at: this.iso() }));
      if (cur) await this.finishApproval(cur);
    }
    return changed;
  }

  /**
   * Record that a person reverted this promotion's global lesson (the file is already removed, see
   * `Brain.remove`): an approved record becomes `reverted` with who, when, and why. `settle()` only
   * finishes `approved` records, so a reverted lesson is never written again. Returns the record,
   * or null when it is unknown or not approved.
   */
  markReverted(id: string, by: string, reason: string): Promise<PromotionRecord | null> {
    return this.serial(() => this.transition(id, "approved", (x) => ({ ...x, status: "reverted", reverted_by: (by.trim() || "user").slice(0, 200), reverted_at: this.iso(), revert_reason: reason.trim().slice(0, 1000) })));
  }

  /** A person approves a waiting promotion (pending approval, or pending review when no reviewer settles it). */
  approve(by: Principal, id: string, note?: string): Promise<PromotionRecord> {
    return this.serial(() => this.doApprove(by, id, note));
  }

  private async doApprove(by: Principal, id: string, note?: string): Promise<PromotionRecord> {
    const who = this.person(by);
    const r = this.get(id);
    if (!r) throw this.h.error(`unknown promotion ${id}`);
    if (r.status !== "pending_approval" && r.status !== "pending_review") throw this.h.error(`promotion ${id} is ${r.status}`);
    const cur = await this.transition(id, r.status, (x) => ({ ...x, status: "approved", reason: note ? note.slice(0, 4000) : null, decided_by: who, decided_at: this.iso() }));
    if (!cur) throw this.h.error(`promotion ${id} changed meanwhile; reload it`);
    return this.finishApproval(cur);
  }

  /** A person rejects a waiting promotion; the lesson is kept in the project with the reason. */
  reject(by: Principal, id: string, reason: string): Promise<PromotionRecord> {
    return this.serial(() => this.doReject(by, id, reason));
  }

  private async doReject(by: Principal, id: string, reason: string): Promise<PromotionRecord> {
    const who = this.person(by);
    if (!reason.trim()) throw this.h.error("a rejection needs a reason");
    const r = this.get(id);
    if (!r) throw this.h.error(`unknown promotion ${id}`);
    if (r.status !== "pending_approval" && r.status !== "pending_review") throw this.h.error(`promotion ${id} is ${r.status}`);
    const cur = await this.transition(id, r.status, (x) => ({ ...x, status: "rejected", reason: `rejected by ${who}: ${reason.trim()}`.slice(0, 4000), decided_by: who, decided_at: this.iso() }));
    if (!cur) throw this.h.error(`promotion ${id} changed meanwhile; reload it`);
    return this.rejectTo(cur, cur.body, true);
  }

  private person(by: Principal): string {
    if (by.kind !== "human") throw this.h.error("only a person approves or rejects a promotion");
    return by.name ?? "user";
  }

  /** Start (or restart) the review of a pending promotion; records why it waits when none can run. */
  private async startReview(id: string): Promise<PromotionRecord | null> {
    const r = this.get(id);
    if (!r || r.status !== "pending_review" || r.review.task_id) return r;
    const port = this.h.reviewer();
    if (!port) return this.transition(id, "pending_review", (x) => ({ ...x, reason: "no promotion reviewer is available in this process; the promotion waits for review" }));
    const sources = r.sources.map((s) => ({ path: s, text: (this.h.readText(s) ?? "").slice(0, SOURCE_TEXT_MAX) }));
    let start: PromotionReviewStart;
    try {
      start = await port.start({ project: r.project, recordId: r.id, digest: r.digest, candidate: { title: r.title, body: r.body, sources: r.sources }, sources, supervisor: { taskId: r.supervisor.task, model: r.supervisor.model } });
    } catch (err) {
      start = { kind: "unavailable", reason: `the review could not start: ${(err as Error).message}` };
    }
    if (start.kind === "unavailable") {
      const reason = start.reason;
      return this.transition(id, "pending_review", (x) => ({ ...x, reason: `waiting for review: ${reason}`.slice(0, 4000) }));
    }
    const started = start;
    return this.transition(id, "pending_review", (x) => ({ ...x, review: { ...x.review, attempts: x.review.attempts + 1, task_id: started.reviewTaskId, reviewer: started.reviewer }, reason: `under review by ${started.reviewer} (task ${started.reviewTaskId})` }));
  }

  /**
   * Rewrite a record if it still has status `from` (checked under the brain lock); returns the
   * new record, or null when it changed meanwhile.
   */
  private async transition(id: string, from: PromotionStatus, fn: (r: PromotionRecord) => PromotionRecordMeta & { body?: string }): Promise<PromotionRecord | null> {
    const rel = `${this.dir()}/${id}.md`;
    let next: PromotionRecord | null = null;
    await this.h.write(
      rel,
      (current) => {
        const cur = current === null ? null : parseRecord(current, rel);
        if (!cur || cur.status !== from) return null;
        const parsed = PromotionRecordSchema.parse(metaOf({ ...cur, ...fn(cur) }));
        next = { ...parsed, body: cur.body, path: rel };
        return renderRecord(parsed, cur.body);
      },
      SYSTEM,
      `Update promotion ${id}`,
    );
    return next;
  }

  /** Write the approved lesson to global/ (once) and record where it went. */
  private async finishApproval(r: PromotionRecord): Promise<PromotionRecord> {
    const res = await this.writeGlobal(r.id, { title: r.title, body: r.body, sources: r.sources }, {
      project: r.project,
      promoted_by: r.supervisor.agent,
      supervisor_model: r.supervisor.model,
      supervisor_task: r.supervisor.task,
      sources: r.sources,
      review: r.review.verdict ? { verdict: r.review.verdict, reviewer: r.review.reviewer, reviewer_model: r.review.reviewer_model, review_task: r.review.task_id, rubric: r.review.rubric, reasons: r.review.reasons } : null,
      approved_by: r.decided_by,
    });
    const rel = r.path;
    let out: PromotionRecord = { ...r, global_path: res.path };
    await this.h.write(
      rel,
      (current) => {
        const cur = current === null ? null : parseRecord(current, rel);
        if (!cur || cur.status !== "approved" || cur.global_path === res.path) return null;
        out = { ...cur, global_path: res.path };
        return renderRecord({ ...metaOf(cur), global_path: res.path }, cur.body);
      },
      SYSTEM,
      `Promotion ${r.id}: approved as ${res.path}`,
    );
    return out;
  }

  /**
   * Write a lesson to `global/lessons/` with provenance. A file of the same name from another
   * promotion is never overwritten: the next free `-<n>` name is used. A promotion's own file is
   * rewritten in place (an interrupted approval finishing).
   */
  private async writeGlobal(promotionId: string | null, c: PromotionCandidate, provenance: Record<string, unknown>): Promise<{ path: string; commit: string | null }> {
    const base = `global/lessons/${slugify(c.title)}`;
    const meta = { kind: "lesson", ...(promotionId ? { promotion: promotionId } : {}), ...provenance, promoted_at: this.iso() };
    const text = frontMatter(meta, c.title, c.body);
    for (let n = 1; n < 100; n++) {
      const rel = n === 1 ? `${base}.md` : `${base}-${n}.md`;
      let wrote = false;
      const res = await this.h.write(
        rel,
        (current) => {
          if (current !== null) {
            const fm = splitFrontMatter(current);
            const owner = (fm?.meta as { promotion?: unknown } | null)?.promotion;
            if (!promotionId || owner !== promotionId) return null;
          }
          wrote = true;
          return text;
        },
        SYSTEM,
        `Promote lesson: ${c.title}${provenance.project ? ` (from ${String(provenance.project)})` : ""}`,
      );
      if (wrote) return res;
    }
    throw this.h.error(`too many global lessons named ${base}`);
  }

  /** Save a rejected lesson in the project (decisions/lessons/) with the reason, and point the record at it. */
  private async rejectTo(r: PromotionRecordMeta, body: string, recordExists = false): Promise<PromotionRecord> {
    const base = `projects/${r.project}/decisions/lessons/${slugify(r.title)}`;
    const meta = {
      kind: "project_lesson",
      promotion: r.id,
      not_global: r.reason,
      project: r.project,
      proposed_by: r.supervisor.agent,
      sources: r.sources,
      ...(r.review.verdict ? { review: { verdict: r.review.verdict, reviewer: r.review.reviewer, reviewer_model: r.review.reviewer_model, rubric: r.review.rubric } } : {}),
      saved_at: this.iso(),
    };
    const text = frontMatter(meta, r.title, body, `> Not promoted to global knowledge: ${r.reason ?? "rejected"}`);
    let lessonPath: string | null = null;
    for (let n = 1; n < 100 && !lessonPath; n++) {
      const rel = n === 1 ? `${base}.md` : `${base}-${n}.md`;
      await this.h.write(
        rel,
        (current) => {
          if (current !== null && (splitFrontMatter(current)?.meta as { promotion?: unknown } | null)?.promotion !== r.id) return null;
          lessonPath = rel;
          return text;
        },
        SYSTEM,
        `Keep lesson in project: ${r.title}`,
      );
    }
    if (!lessonPath) throw this.h.error(`too many project lessons named ${base}`);
    const rel = `${this.dir()}/${r.id}.md`;
    const final: PromotionRecordMeta = { ...metaOf(r), lesson_path: lessonPath };
    if (!recordExists) await this.h.write(rel, renderRecord(final, body), SYSTEM, `Promotion ${r.id}: rejected`);
    else await this.h.write(rel, (current) => (current !== null && parseRecord(current, rel)?.status === "rejected" ? renderRecord(final, body) : null), SYSTEM, `Promotion ${r.id}: rejected`);
    return { ...final, body, path: rel };
  }
}
