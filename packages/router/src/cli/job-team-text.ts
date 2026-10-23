import type { ChannelPostView, JobChannelView, JobTeamView, MergeBranchView, TeamTreeNode } from "../admin/job-team.js";
import { plural, stamp } from "./terminal.js";

// The team view as terminal text (`meritrouter job` and `meritrouter channel`). Channel posts are
// model output: each is printed as `> `-quoted lines under a header naming its author, never as
// a line of its own that could pass for the CLI's output. Control characters were stripped when
// the post was stored.

function nodeLine(n: TeamTreeNode, self: boolean): string {
  const parts = [`${n.label ?? n.taskId} [${n.profile}] ${n.state}${n.acceptance ? ` / ${n.acceptance}` : ""}`];
  if (n.kind === "job") parts.push(`level ${n.depth}`);
  if (self) parts.push("(this job)");
  if (n.branches.length) parts.push(`branch ${n.branches.map((b) => `${b.alias} ${b.branch}`).join(", ")}`);
  if (n.budget) {
    const b = n.budget;
    const of = b.parentRemaining !== null ? ` of ${b.parentRemaining} left` : "";
    parts.push(`budget ${b.carved} carved${of}: used ${b.used}, ${b.returned === null ? "held while open" : `${b.returned} returned`}`);
  } else if (n.kind === "job") parts.push(`requests ${n.requestsUsed}`);
  if (n.label) parts.push(n.taskId);
  return parts.join("  ");
}

function treeLines(n: TeamTreeNode, indent: number, self: boolean): string[] {
  return [`${"  ".repeat(indent)}${nodeLine(n, self)}`, ...n.children.flatMap((c) => treeLines(c, indent + 1, false))];
}

export function mergeQueueLines(queues: MergeBranchView[], ownJobId: string): string[] {
  return queues.flatMap((q) => [
    `  ${q.repo} ${q.branch}${q.jobId === ownJobId ? "" : ` (sub-job ${q.jobLabel ?? q.jobId})`}${q.active ? `, ${q.active} in progress` : ""}:`,
    ...q.items.map((i, k) => `    ${k + 1}. ${i.taskLabel ?? i.taskId} [${i.kind}] ${i.state}: ${i.outcome}`),
  ]);
}

/** One post: a header line, then its text as `> `-quoted lines. */
export function postLines(p: ChannelPostView, showJob: boolean): string[] {
  const refs = p.refs.length ? `refs ${p.refs.map((r) => r.label ?? r.taskId).join(", ")}` : "job-wide";
  const head = `  #${p.id} ${stamp(p.createdAt)} ${p.kind} by ${p.author.label} (${p.author.role})${showJob ? ` in ${p.jobLabel ?? p.jobId}` : ""}; ${refs}`;
  return [head, ...p.text.split("\n").map((l) => `    > ${l}`)];
}

const kindCounts = (byKind: Record<string, number>) =>
  Object.entries(byKind)
    .filter(([, n]) => n > 0)
    .map(([k, n]) => `${k} ${n}`)
    .join(", ");

/** The team part of `meritrouter job <id>`: the sub-job tree, the merge queues, and recent channel posts. */
export function jobTeamLines(v: JobTeamView, recentPosts = 5): string[] {
  const out: string[] = [];
  if (v.parentJobId) out.push(`sub-job of ${v.parentLabel ?? v.parentJobId} (${v.parentJobId}); reports into its working document`);
  if (v.subJobs || v.parentJobId) {
    out.push(`team: level ${v.depth} of at most ${v.maxDepth} (team.max_depth); ${plural(v.subJobs, "sub-job")} below this job`);
    out.push(...treeLines(v.tree, 1, true));
  }
  if (v.queues.length) out.push("merge queue (one integration per branch at a time):", ...mergeQueueLines(v.queues, v.jobId));
  if (v.channel.total) {
    const shown = v.channel.posts.slice(-recentPosts);
    out.push(`team channel: ${plural(v.channel.total, "post")} (${kindCounts(v.channel.byKind)}); latest ${shown.length}. ${v.channel.notice}`);
    out.push(...shown.flatMap((p) => postLines(p, v.subJobs > 0)));
    out.push(`  all posts: meritrouter channel ${v.jobId}`);
  }
  return out;
}

/** `meritrouter channel <job>`. */
export function channelText(v: JobChannelView): string {
  const head = `team channel of job ${v.jobLabel ? `${v.jobLabel} (${v.jobId})` : v.jobId}: ${plural(v.total, "post")}${v.total ? ` (${kindCounts(v.byKind)})` : ""}`;
  if (!v.posts.length) return [head, v.total ? "(no posts after that id)" : "(no posts yet)"].join("\n");
  const last = v.posts.at(-1)!.id;
  return [head, v.notice, "", ...v.posts.flatMap((p) => postLines(p, false)), ...(v.hasMore ? ["", `more posts: meritrouter channel ${v.jobId} --after ${last}`] : [])].join("\n");
}
