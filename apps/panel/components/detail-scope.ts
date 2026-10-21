/**
 * Where a task or session detail view is shown: a project's pages (`/p/<slug>`), or the
 * Qualification page (`/all/qualification`) for the reserved `_qualification` project's work.
 */
export interface DetailScope {
  /** The project the item belongs to: a project slug, or `_qualification`. */
  project: string;
  /** Path task, job, and session links start from (`/p/<slug>` or `/all/qualification`). */
  base: string;
  /** The list the page's back link returns to. */
  back: { href: string; label: string };
  /** Resume, cancel, and acceptance actions (a project's pages only). */
  actions: boolean;
  /** Whether `base` has list and job pages (the Qualification page has neither: a job links to its task view). */
  lists: boolean;
}
