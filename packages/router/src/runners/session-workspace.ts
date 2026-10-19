import type { SessionRecorder } from "../sessions/recorder.js";
import type { WorkspaceRepo } from "../sessions/events.js";
import { git } from "../workspaces/git.js";

/**
 * A run's workspace pointer (worktree, base commit, last committed head per repository),
 * recorded in its session whenever it changes, so a resumed session can compare the worktree
 * with the last head it committed. Without a session it records nothing.
 */
export class WorkspacePointer {
  private readonly repos = new Map<string, WorkspaceRepo>();
  private last = "";

  constructor(
    private readonly session: SessionRecorder | null,
    repos: WorkspaceRepo[],
  ) {
    for (const r of repos) this.repos.set(r.alias, { ...r });
    this.record();
  }

  /** Set one repository's head (a commit just made) and record the change. */
  setHead(alias: string, head: string | null): void {
    const r = this.repos.get(alias);
    if (!r || !head || r.head === head) return;
    r.head = head;
    this.record();
  }

  /** Re-read every repository's HEAD (after tools that commit, such as cherry-picks and undo). */
  async refresh(): Promise<void> {
    if (!this.session) return;
    for (const r of this.repos.values()) {
      const head = (await git(r.worktree, ["rev-parse", "HEAD"]).catch(() => "")).trim();
      if (head) r.head = head;
    }
    this.record();
  }

  private record(): void {
    if (!this.session || this.session.ended) return;
    const workspace = { repos: [...this.repos.values()].map((r) => ({ ...r })) };
    const json = JSON.stringify(workspace);
    if (json === this.last) return;
    this.last = json;
    this.session.setWorkspace(workspace);
  }
}
