import { z } from "zod";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { ActorSchema, actorIdentity, trailerArgs } from "./actor.js";
import { prepareCommitMessage } from "./commit-message.js";
import { git } from "../workspaces/git.js";
import { assertSafeIndexInput, gitIndexSnapshot, withGitIndexTransaction, withHeadGitIndex, type GitIndexCapability } from "../workspaces/git-index-transaction.js";
import { ensureProjectMetadataExcluded } from "../workspaces/metadata-exclusion.js";
import { stageSelectedIntoOwnedIndex } from "../workspaces/metadata-staging.js";
import { isProjectMetadataPath } from "../projects/metadata-policy.js";
import { withRepositoryMutation, type RepositoryMutationCapability } from "../workspaces/repository-mutation.js";
import { archiveCommitReceipt, assertNoPendingCommitPublication, CommitObjectSchema, createCommitReceipt, updateCommitReceipt, type CommitReceiptHandle } from "./selected-commit-receipts.js";
import { publishSelectedRef, SelectedRefPublicationError, type PreparedRefControl } from "./selected-ref-publication.js";

const text = z.string().max(4096).refine(value => !value.includes("\0"));
export const SelectedCommitInputSchema = z.object({
  actor: ActorSchema,
  message: z.string().max(32768).refine(value => !value.includes("\0")),
  paths: z.array(z.string().min(1).max(4096)).max(128).optional(), allowEmpty: z.boolean().default(false),
  extraTrailers: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9-]*$/), text).default({})
    .refine(value => Object.keys(value).length <= 32 && Buffer.byteLength(JSON.stringify(value)) <= 8192, "Extra trailers exceed supported bounds"),
}).strict();
export type SelectedCommitInput = z.input<typeof SelectedCommitInputSchema>;
export const SelectedCommitOutcomeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("unchanged"), commit: z.null() }).strict(),
  z.object({ kind: z.literal("committed"), commit: CommitObjectSchema, receiptId: z.string() }).strict(),
  z.object({ kind: z.enum(["refused", "reconciliation_required", "publication_uncertain"]), commit: CommitObjectSchema, receiptId: z.string(), reason: z.string().max(4096) }).strict(),
]);
export type SelectedCommitOutcome = z.infer<typeof SelectedCommitOutcomeSchema>;
const SelectedCommitFailureSchema = z.object({
  kind: z.enum(["refused", "reconciliation_required", "publication_uncertain"]), commit: CommitObjectSchema,
  receiptId: z.string().regex(/^pc_[a-f0-9]{32}$/), reason: z.string().max(4096),
}).strict();
export class SelectedCommitError extends Error {
  readonly detail: z.infer<typeof SelectedCommitFailureSchema>;
  constructor(input: z.input<typeof SelectedCommitFailureSchema>) {
    const detail = SelectedCommitFailureSchema.parse(input);
    super(detail.reason); this.name = "SelectedCommitError"; this.detail = detail;
  }
}
/** Existing wrappers retain string|null success, but never flatten unresolved effects to null. */
export function unpackSelectedCommitOutcome(input: SelectedCommitOutcome): string | null {
  const result = SelectedCommitOutcomeSchema.parse(input);
  if (result.kind === "unchanged") return null;
  if (result.kind === "committed") return result.commit;
  throw new SelectedCommitError(result);
}
const CapturedCommitInputSchema = SelectedCommitInputSchema.omit({ paths: true, allowEmpty: true }).extend({ head: CommitObjectSchema, tree: CommitObjectSchema }).strict();
interface CapturedTree { head: string; tree: string }
/** Trusted host-only callbacks for observed validation/fault injection; not model runtime input. */
export interface SelectedCommitControl {
  mutation?: RepositoryMutationCapability;
  assertAuthority?: () => void;
  admitted?: () => Promise<void>;
  sealed?: () => Promise<void>;
  intent?: (receiptId: string) => Promise<void>;
  beforePrepare?: () => Promise<void>;
  prepared?: PreparedRefControl["prepared"];
  committing?: PreparedRefControl["committing"];
  refPublished?: (receiptId: string) => Promise<void>;
  refTimeoutMs?: number;
}

/** Commit immutable selected application bytes, retaining unrelated original staged entries. */
export function commitSelectedApplication(repo: string, input: SelectedCommitInput, control: SelectedCommitControl = {}): Promise<SelectedCommitOutcome> {
  return commitSelectedInternal(repo, input, control, false);
}

/** Publish only the immutable tree already captured by verification; never restage app bytes. */
export function commitCapturedApplication(repo: string, input: z.input<typeof CapturedCommitInputSchema>, control: SelectedCommitControl = {}): Promise<SelectedCommitOutcome> {
  const { head, tree, ...selected } = CapturedCommitInputSchema.parse(input);
  return commitSelectedInternal(repo, selected, control, false, { head, tree });
}

/** Fixed trusted setup identity/message; no Actor mode switch is accepted from model input. */
export function commitInitialApplicationSnapshot(repo: string, kind: "created" | "snapshot", control: SelectedCommitControl = {}): Promise<SelectedCommitOutcome> {
  const selected = z.enum(["created", "snapshot"]).parse(kind);
  return commitSelectedInternal(repo, { actor: { agent: "MeritRouter", role: "setup" }, message: selected === "created" ? "MeritRouter: initial commit" : "MeritRouter: initial snapshot", allowEmpty: true, ...(selected === "created" ? { paths: [] } : {}) }, control, true);
}

async function commitSelectedInternal(repo: string, input: SelectedCommitInput, control: SelectedCommitControl, setup: boolean, captured?: CapturedTree): Promise<SelectedCommitOutcome> {
  const parsed = SelectedCommitInputSchema.parse(input);
  control.assertAuthority?.();
  // Register nested mutation immediately, so even unawaited trusted callers are fenced
  // and drained by their parent before its lifecycle lock can be released.
  if (control.mutation !== undefined) return withRepositoryMutation([repo], async () => {
    const message = await selectedMessage(repo, parsed, setup);
    if (control.admitted) await control.admitted();
    return publishSelectedCommit(repo, parsed, control, setup, message, captured);
  }, { capability: control.mutation });
  const message = await selectedMessage(repo, parsed, setup);
  if (control.admitted) await control.admitted();
  control.assertAuthority?.();
  return withRepositoryMutation([repo], () => publishSelectedCommit(repo, parsed, control, setup, message, captured));
}

function selectedMessage(repo: string, parsed: z.output<typeof SelectedCommitInputSchema>, setup: boolean): Promise<string> {
  return setup ? Promise.resolve(`${parsed.message}\n`) : prepareCommitMessage(repo, {
    message: parsed.message, trailers: trailerArgs(parsed.actor, parsed.extraTrailers).filter((_, index) => index % 2 === 1),
  });
}

async function publishSelectedCommit(repo: string, parsed: z.output<typeof SelectedCommitInputSchema>, control: SelectedCommitControl, setup: boolean, message: string, captured?: CapturedTree): Promise<SelectedCommitOutcome> {
  control.assertAuthority?.();
  await ensureProjectMetadataExcluded(repo);
  const identity = setup ? { name: "MeritRouter", email: "meritrouter@localhost" } : actorIdentity(parsed.actor);
  const env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
  let receipt: CommitReceiptHandle | null = null, publication: "none" | "attempted" | "published" | "uncertain" = "none";
  try {
    const candidate = await withGitIndexTransaction(repo, async preserved => {
      await assertNoPendingCommitPublication(repo, { archiveTerminal: true }); // Admission before a lock wait cannot authorize a later publication.
      const snapshot = gitIndexSnapshot(preserved);
      control.assertAuthority?.();
      // A native Git writer can establish independent history after repository setup's
      // earlier unborn check. Initial setup must not append a synthetic child commit.
      if (setup && snapshot.head) return { commit: null, tree: CommitObjectSchema.parse((await git(repo, ["rev-parse", `${snapshot.head}^{tree}`])).trim()) };
      // Do not flatten a merge/cherry-pick/revert into a misleading one-parent commit.
      for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
        const file = (await git(repo, ["rev-parse", "--git-path", marker])).trim();
        try { await lstat(path.resolve(repo, file)); throw new Error("Selected commit requires sequencer/merge recovery first"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
      if (captured) return captureImmutableCommit(repo, preserved, captured, snapshot.head, env, message, control);
      return withHeadGitIndex(preserved, async selected => {
        const baseline = CommitObjectSchema.parse((await git(repo, ["write-tree"], { index: selected })).trim());
        const files = await stageSelectedIntoOwnedIndex(repo, preserved, parsed.paths === undefined ? {} : { paths: parsed.paths });
        let chunk: string[] = [], bytes = 0;
        const apply = async () => {
          if (!chunk.length) return;
          const patch = await git(repo, ["diff", "--cached", "--binary", "--no-renames", baseline, "--", ...chunk.map(file => `:(literal)${file}`)], { index: preserved });
          if (patch) await git(repo, ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], { index: selected, input: patch });
          chunk = []; bytes = 0;
        };
        for (const file of files) { if (chunk.length >= 64 || bytes + file.length > 20000) await apply(); chunk.push(file); bytes += file.length; }
        await apply();
        const tree = CommitObjectSchema.parse((await git(repo, ["write-tree"], { index: selected })).trim());
        const names = (await git(repo, ["ls-tree", "-r", "--name-only", "-z", tree])).split("\0").filter(Boolean);
        if (names.length > 20000 || names.some(isProjectMetadataPath)) throw new Error("Selected candidate tree contains private or excessive entries");
        if (tree === baseline && !parsed.allowEmpty) return { commit: null, tree };
        const commit = CommitObjectSchema.parse((await git(repo, ["commit-tree", tree, ...(snapshot.head ? ["-p", snapshot.head] : [])], { env, input: message })).trim());
        if (control.sealed) await control.sealed();
        return { commit, tree };
      });
    }, async snapshot => {
      if (!snapshot.result.commit) return;
      control.assertAuthority?.();
      receipt = await createCommitReceipt(snapshot, snapshot.result.commit, snapshot.result.tree);
      if (control.intent) await control.intent(receipt.record.id);
      if (control.beforePrepare) await control.beforePrepare();
      control.assertAuthority?.();
      publication = "attempted";
      try {
        await publishSelectedRef(repo, { gitDirectory: snapshot.gitDirectory, head: snapshot.head, branch: snapshot.branch, commit: snapshot.result.commit, env }, { prepared: async process => { control.assertAuthority?.(); if (control.prepared) await control.prepared(process); control.assertAuthority?.(); }, committing: control.committing, timeoutMs: control.refTimeoutMs });
      } catch (error) {
        if (error instanceof SelectedRefPublicationError) publication = error.publication === "published" ? "published" : error.publication === "uncertain" ? "uncertain" : "none";
        else publication = "none"; // Publisher tags every error after starting its protocol; earlier errors have no ref effect.
        throw error;
      }
      publication = "published";
      await updateCommitReceipt(receipt, "head_published");
      control.assertAuthority?.();
      if (control.refPublished) await control.refPublished(receipt.record.id);
      control.assertAuthority?.();
    });
    control.assertAuthority?.();
    if (!candidate.commit) return SelectedCommitOutcomeSchema.parse({ kind: "unchanged", commit: null });
    const completed = receipt as CommitReceiptHandle | null;
    if (!completed) throw new Error("Selected commit publication receipt is missing");
    await updateCommitReceipt(completed, "complete");
    // Publication already succeeded. Archive contention/failure leaves terminal evidence;
    // it must not downgrade a completed publication to index reconciliation required.
    try { await archiveCommitReceipt(completed); } catch { /* Next under-lock admission can retire terminal evidence. */ }
    return SelectedCommitOutcomeSchema.parse({ kind: "committed", commit: candidate.commit, receiptId: completed.record.id });
  } catch (error) {
    const retained = receipt as CommitReceiptHandle | null;
    if (!retained) throw error;
    const state = publication as string;
    const kind = state === "published" ? "reconciliation_required" : state === "uncertain" || state === "attempted" ? "publication_uncertain" : "refused";
    try {
      await updateCommitReceipt(retained, kind === "refused" ? "refused" : kind === "publication_uncertain" ? "uncertain" : "head_published");
      if (kind === "refused") await archiveCommitReceipt(retained);
    } catch { /* Prepared receipt and backups remain authoritative evidence. */ }
    return SelectedCommitOutcomeSchema.parse({ kind, commit: retained.record.commit, receiptId: retained.record.id, reason: (error instanceof Error ? error.message : String(error)).slice(0, 4096) });
  }
}

async function captureImmutableCommit(repo: string, index: GitIndexCapability, captured: CapturedTree, head: string, env: Record<string, string>, message: string, control: SelectedCommitControl): Promise<{ commit: string | null; tree: string }> {
  const read = async (args: string[], indexed = false) => {
    control.assertAuthority?.();
    const result = await git(repo, args, indexed ? { index } : {});
    control.assertAuthority?.(); return result;
  };
  if (head !== captured.head) throw new Error("Checked candidate HEAD changed before sealing");
  const entries = (await read(["ls-files", "--stage", "-z"], true)).split("\0").filter(Boolean);
  if (entries.length > 20000) throw new Error("Checked candidate index exceeds supported bounds");
  for (const entry of entries) {
    const match = /^([0-7]{6}) [a-f0-9]{40,64} 0\t([\s\S]+)$/.exec(entry);
    if (!match || match[1] === "160000") throw new Error("Unsupported checked candidate index entry");
    await assertSafeIndexInput(repo, match[2]!, true);
  }
  if ((await read(["write-tree"], true)).trim() !== captured.tree) throw new Error("Checked candidate index differs from the verified tree");
  if ((await read(["diff", "--name-only", "-z"])).length || (await read(["ls-files", "--others", "--exclude-standard", "-z"])).length) throw new Error("Checked candidate has unsealed source changes");
  if ((await read(["rev-parse", `${head}^{tree}`])).trim() === captured.tree) return { commit: null, tree: captured.tree };
  const commit = CommitObjectSchema.parse((await git(repo, ["commit-tree", captured.tree, "-p", head], { env, input: message })).trim());
  control.assertAuthority?.(); if (control.sealed) await control.sealed(); control.assertAuthority?.();
  return { commit, tree: captured.tree };
}
