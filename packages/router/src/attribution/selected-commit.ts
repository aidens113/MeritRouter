import { z } from "zod";
import { lstat } from "node:fs/promises";
import path from "node:path";
import { actorIdentity, trailerArgs } from "./index.js";
import { git } from "../workspaces/git.js";
import { gitIndexSnapshot, withGitIndexTransaction, withHeadGitIndex } from "../workspaces/git-index-transaction.js";
import { ensureProjectMetadataExcluded } from "../workspaces/metadata-exclusion.js";
import { stageSelectedIntoOwnedIndex } from "../workspaces/metadata-staging.js";
import { isProjectMetadataPath } from "../projects/metadata-policy.js";
import { archiveCommitReceipt, assertNoPendingCommitPublication, CommitObjectSchema, createCommitReceipt, updateCommitReceipt, type CommitReceiptHandle } from "./selected-commit-receipts.js";
import { publishSelectedRef, SelectedRefPublicationError, type PreparedRefControl } from "./selected-ref-publication.js";

const text = z.string().max(4096).refine(value => !value.includes("\0"));
export const SelectedCommitInputSchema = z.object({
  actor: z.object({ agent: text.min(1), role: text.min(1), model: text.nullish(), task: text.nullish(), job: text.nullish(), tier: text.nullish(), request: text.nullish() }).strict(),
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
/** Trusted host-only callbacks for observed validation/fault injection; not model runtime input. */
export interface SelectedCommitControl {
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

/** Fixed trusted setup identity/message; no Actor mode switch is accepted from model input. */
export function commitInitialApplicationSnapshot(repo: string, kind: "created" | "snapshot", control: SelectedCommitControl = {}): Promise<SelectedCommitOutcome> {
  const selected = z.enum(["created", "snapshot"]).parse(kind);
  return commitSelectedInternal(repo, { actor: { agent: "MeritRouter", role: "setup" }, message: selected === "created" ? "MeritRouter: initial commit" : "MeritRouter: initial snapshot", allowEmpty: true }, control, true);
}

async function commitSelectedInternal(repo: string, input: SelectedCommitInput, control: SelectedCommitControl, setup: boolean): Promise<SelectedCommitOutcome> {
  const parsed = SelectedCommitInputSchema.parse(input);
  await assertNoPendingCommitPublication(repo);
  await ensureProjectMetadataExcluded(repo);
  if (control.admitted) await control.admitted();
  const identity = setup ? { name: "MeritRouter", email: "meritrouter@localhost" } : actorIdentity(parsed.actor);
  const env = { GIT_AUTHOR_NAME: identity.name, GIT_AUTHOR_EMAIL: identity.email, GIT_COMMITTER_NAME: identity.name, GIT_COMMITTER_EMAIL: identity.email };
  let receipt: CommitReceiptHandle | null = null, publication: "none" | "attempted" | "published" | "uncertain" = "none";
  try {
    const candidate = await withGitIndexTransaction(repo, async preserved => {
      await assertNoPendingCommitPublication(repo, { archiveTerminal: true }); // Admission before a lock wait cannot authorize a later publication.
      const snapshot = gitIndexSnapshot(preserved);
      // Do not flatten a merge/cherry-pick/revert into a misleading one-parent commit.
      for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"]) {
        const file = (await git(repo, ["rev-parse", "--git-path", marker])).trim();
        try { await lstat(path.resolve(repo, file)); throw new Error("Selected commit requires sequencer/merge recovery first"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
      }
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
        const trailers = setup ? "" : trailerArgs(parsed.actor, parsed.extraTrailers).filter((_, index) => index % 2 === 1).join("\n");
        const payload = `${parsed.message}${trailers ? `\n\n${trailers}` : ""}`;
        const message = payload.endsWith("\n") ? payload : `${payload}\n`;
        const commit = CommitObjectSchema.parse((await git(repo, ["commit-tree", tree, ...(snapshot.head ? ["-p", snapshot.head] : [])], { env, input: message })).trim());
        if (control.sealed) await control.sealed();
        return { commit, tree };
      });
    }, async snapshot => {
      if (!snapshot.result.commit) return;
      receipt = await createCommitReceipt(snapshot, snapshot.result.commit, snapshot.result.tree);
      if (control.intent) await control.intent(receipt.record.id);
      if (control.beforePrepare) await control.beforePrepare();
      publication = "attempted";
      try {
        await publishSelectedRef(repo, { gitDirectory: snapshot.gitDirectory, head: snapshot.head, branch: snapshot.branch, commit: snapshot.result.commit, env }, { prepared: control.prepared, committing: control.committing, timeoutMs: control.refTimeoutMs });
      } catch (error) {
        if (error instanceof SelectedRefPublicationError) publication = error.publication === "published" ? "published" : error.publication === "uncertain" ? "uncertain" : "none";
        else publication = "none"; // Publisher tags every error after starting its protocol; earlier errors have no ref effect.
        throw error;
      }
      publication = "published";
      await updateCommitReceipt(receipt, "head_published");
      if (control.refPublished) await control.refPublished(receipt.record.id);
    });
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
