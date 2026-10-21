# Report: live-control

## Outcome

Done. `AutoRefresh` now shows its status and its control as two separate elements. Pausing asks for confirmation in a new reusable, accessible `ConfirmDialog`. All ~26 call sites are unchanged: the export name and props (`{ seconds?: number }`) are the same.

## What changed and why

- `apps/panel/components/client/confirm-dialog.tsx` (new): `ConfirmDialog`, built on a native `<dialog>` opened with `showModal()`, so the rest of the page is inert.
  - Props: `open`, `onClose`, `onConfirm` (may return a promise; the dialog disables both buttons and shows a spinner until it settles, then calls `onClose`), `title`, `description`, `confirmLabel` (default "Confirm"), `cancelLabel` (default "Cancel"), `tone` (`"default"` gives a primary button, `"danger"` gives `buttonClass("danger")`).
  - Accessibility: `aria-modal="true"`, plus `aria-labelledby` and `aria-describedby` pointing at the title `<h2>` and the description `<p>` (ids come from `useId`). Focus moves to Cancel when it opens (`autoFocus` and an explicit `focus()`). Tab and Shift+Tab wrap inside the dialog. Esc is handled on `cancel`: it calls `preventDefault` and then `onClose`, so the parent's state drives the close. A backdrop click cancels, but only when the press also started on the backdrop. On close, focus returns to whatever was focused when it opened.
  - Styling: panel tokens (`bg-surface`, `border-line-strong`, `text-ink`/`ink-2`, a `bg-surface-2` footer) and `backdrop:bg-black/50`. It sets `m-auto` explicitly, because Tailwind preflight zeroes the user-agent dialog margin.
- `apps/panel/components/client/actions.tsx`: only `AutoRefresh` changed, plus the import of `ConfirmDialog`.
  - The component is now a `role="group"` labelled "Live page updates". It contains:
    - **Status chip:** a non-interactive `<span role="status" aria-live="polite">`. Live shows a green pulsing dot (`motion-safe:animate-ping`), "Live" and "· updates every Ns". Paused shows a muted dot, "Paused" and "· not updating". The `title` explains the same in full.
    - **Separate button:** `buttonClass("secondary", true)`, labelled "Pause updates" with a pause icon or "Resume updates" with a play icon.
    - **ConfirmDialog:** the title, body and button labels are exactly as in the brief.
  - "Pause updates" opens the dialog. Confirming pauses the page. "Resume updates" resumes at once and calls `router.refresh()` straight away, so the page catches up without waiting a full interval.
  - The button stays the same DOM node across the label change, so after confirming, focus returns to the button, which now reads "Resume updates".
  - The interval logic is unchanged.

## Commands run and observed results

- `pnpm --filter switchyard-router build`: exit 0. It built `packages/router/dist` in this shared worktree, which includes the other worker's in-progress router edits as they stood then.
- `pnpm -r typecheck`: router and panel both "Done", exit 0.
- `pnpm --filter switchyard-panel build`: exit 0, and the full route list was printed.
- `pnpm --filter switchyard-panel seed:demo`: "Demo ready". This rewrote `apps/panel/.demo` (gitignored).
- I ran `next start -p 4602` against `.demo/switchyard.config.yaml`. `GET /p/demo/tasks` returned 200, and its HTML contains the group, "Pause updates", and "updates every 6s".
- I drove headless Chrome over CDP with a scratch script (`live-control-cdp.mjs`). It ran at widths 1440 and 600, and in light and dark themes (via `data-theme` plus emulated `prefers-color-scheme`). From `results.txt`:
  - Opening the dialog: it opens and focus is on Cancel, inside the dialog.
  - Tab moves to "Pause updates", a second Tab wraps to Cancel, and Shift+Tab wraps back to "Pause updates". This was tested at light-1440.
  - A backdrop click closes the dialog, and focus returns to the "Pause updates" trigger.
  - The Cancel button closes it, and focus returns to the trigger.
  - Esc closes it, and focus returns to the trigger. This held in all four combinations.
  - Confirming leaves the status reading "Paused· not updating", with focus on "Resume updates". This held in all four combinations.
  - "Resume updates" sets the status back to "Live· updates every 6s", with no dialog.
  - There was no horizontal page overflow at any width.
- I looked at the screenshots:
  - Tasks header: the chip and button sit right-aligned at 1440, and wrap below the description at 600.
  - Dialog: it is centred, the backdrop dims the page, and it is readable in both themes.
  - Paused state: the dot is grey and the label reads "Resume updates".
- I also took plain screenshots of the project overview (1440 and 600) and a task detail at 600. There, the control sits beside "New job", "Resume" and "Cancel task" without crowding.
- I stopped the panel. The background task stop left an orphaned `node` process listening on 4602, so I killed it (PID 25032). Afterwards no listener remained on 4602. Port 4477 was never used.

Screenshots and results are in the scratchpad: `C:/Users/mrjoh/AppData/Local/Temp/claude/d--SwitchYardRouter/f513290c-d4c1-4d44-81c0-be35d4674ab1/scratchpad/live-control-shots/`
- `tasks-{live,dialog,paused}-{light,dark}-{1440,600}.png`
- `overview-{1440,600}.png`
- `task-detail-{1440,600}.png`
- `results.txt`

## Not verified

- A real screen reader announcing the `aria-live` change. I only checked the attributes and the DOM text.
- Browsers other than Chrome (Firefox and Safari handling of `<dialog>`, backdrop clicks and focus return).
- Keyboard opening with Enter or Space on the trigger. Opening was tested by mouse via CDP only.
- That refreshes actually stop while paused. The interval logic is unchanged and is gated on `paused`, but I did not count network requests.
- The other ~24 call sites were not each rendered. They only compile against the unchanged props. I looked at the Tasks, overview and task-detail pages.
- Router tests were not run. The brief did not ask for them, and I made no router change.

## Open questions or contradictions found

- The status text reads "Live· updates every 6s" when concatenated, because the separator comes from CSS gap. Visually it reads "Live · updates every 6s". A screen reader may run the words together slightly. Adding a literal space would be a cosmetic fix.
- These confirmations could adopt `ConfirmDialog` later (I left them unchanged):
  - The two-click arming `confirm` on `ActionButton` (`components/client/actions.tsx`), which is used by:
    - "Confirm cancel" on Tasks rows (`app/p/[slug]/tasks/page.tsx`) and task detail (`components/task-detail.tsx`): a good fit, with `tone="danger"`.
    - "Confirm: cancel job" (`app/p/[slug]/jobs/[id]/page.tsx`): `tone="danger"`.
    - Qualification "Use up to N requests?" / "Start run?" (`app/all/qualification/page.tsx`): this spends quota, so it is a good fit with `tone="default"`.
  - The cleanest route is a `confirm` mode on `ActionButton` that opens the dialog. `onConfirm` can already return the `run(...)` promise.
- This worktree is shared. The router `dist/`, the panel `.next/` and `apps/panel/.demo` were rebuilt or re-seeded during this run, while the other worker's edits were in place.
