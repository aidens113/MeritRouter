import { z } from "zod";
import { git } from "../workspaces/git.js";

const boundedText = z.string().refine(value => !value.includes("\0") && Buffer.byteLength(value) <= 65536, "Commit message exceeds supported UTF-8 bounds");
const inputSchema = z.object({
  message: boundedText,
  trailers: z.array(z.string().min(1).max(4096).refine(value => !/[\0\r\n]/.test(value))).max(40),
}).strict();

/**
 * Native non-editor `commit -m ... --trailer ...` preparation without an index/ref write.
 * Git cleans whitespace before applying trailers and cleans the result again afterwards.
 * Delegate formatting to Git so safe trailer placement/key/separator configuration survives.
 */
export async function prepareCommitMessage(repo: string, input: z.input<typeof inputSchema>): Promise<string> {
  const parsed = inputSchema.parse(input);
  const raw = await git(repo, ["config", "--null", "--get-regexp", "^(commit\\.(cleanup|verbose)|i18n\\.commitencoding|core\\.commentchar)$"], { allowExit: [1], maxBuffer: 65536, timeoutMs: 10000 });
  const settings = new Map<string, string>();
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    const split = entry.indexOf("\n");
    const key = (split < 0 ? entry : entry.slice(0, split)).toLowerCase(), value = split < 0 ? "" : entry.slice(split + 1);
    // Native config parsing also visits earlier values; never hide an invalid/verbose
    // entry behind a later false value or mistake a valueless boolean for an unset key.
    if (key === "commit.verbose" && !/^(false|no|off|0)$/i.test(value)) throw new Error("Unsupported commit.verbose; selected publication requires verbose diff insertion disabled");
    settings.set(key, value);
  }
  const configuredCleanup = settings.get("commit.cleanup"), encoding = settings.get("i18n.commitencoding"),
    verbose = settings.get("commit.verbose"), commentChar = settings.get("core.commentchar");
  const cleanup = configuredCleanup ?? "default";
  if (!["default", "whitespace", "strip", "verbatim", "scissors"].includes(cleanup)) throw new Error("Unsupported commit.cleanup; selected publication requires a supported non-editor cleanup mode");
  if (encoding !== undefined && !/^utf-?8$/i.test(encoding)) throw new Error("Unsupported i18n.commitEncoding; selected publication requires UTF-8");
  if (verbose !== undefined && !/^(false|no|off|0)$/i.test(verbose)) throw new Error("Unsupported commit.verbose; selected publication requires verbose diff insertion disabled");
  if (commentChar === "auto") throw new Error("Unsupported core.commentChar=auto; select an explicit comment character before publication");

  let message = parsed.message && !parsed.message.endsWith("\n") ? `${parsed.message}\n` : parsed.message;
  if (cleanup !== "verbatim") message = await git(repo, ["stripspace"], { input: message, maxBuffer: 65536, timeoutMs: 10000 });
  if (parsed.trailers.length) message = await git(repo, ["interpret-trailers", "--no-divider", ...parsed.trailers.flatMap(value => ["--trailer", value])], { input: message, maxBuffer: 65536, timeoutMs: 10000 });
  if (cleanup !== "verbatim") message = await git(repo, ["stripspace", ...(cleanup === "strip" ? ["--strip-comments"] : [])], { input: message, maxBuffer: 65536, timeoutMs: 10000 });
  boundedText.parse(message);
  // Match native commit's empty-message refusal; signoff-only whitespace is not a message.
  if (!message.length || cleanup !== "verbatim" && message.split("\n").every(line => !line.trim() || line.startsWith("Signed-off-by: "))) throw new Error("Selected publication refuses an empty commit message");
  return message;
}
