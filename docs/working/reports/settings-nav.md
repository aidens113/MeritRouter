# Worker report: settings-nav

Worktree `D:/sy-wt/sn`, branch `feat/settings-nav`. Nothing committed.

## Outcome

Done. The Settings page's section list now works as a menu: clicking jumps and selects, scrolling selects, the URL hash follows, and deep links open at the section with its item selected. The list also shows on narrow screens, where it was hidden before. I checked the behaviour by driving headless Chrome over the DevTools protocol, because plain `--screenshot` cannot capture a scrolled page (see below).

## What changed and why

- `apps/panel/components/client/section-nav.tsx` (new): the `SectionNav` client component.
  - **Clicking an item** prevents the default jump and smooth-scrolls to the section with `scrollIntoView`. The scroll is instant when the user prefers reduced motion. The item is selected at once and the hash is written with `history.replaceState(history.state, ...)`. Focus moves to the section (`tabindex=-1`, `preventScroll`), the same as a native in-page link. Clicks with a modifier key or a non-left button keep the browser's default behaviour.
  - **Lock while a jump runs.** During a jump the clicked item stays selected until scroll events have been quiet for 160 ms. After that nothing is recomputed until the user scrolls again. This lets a short section near the end (such as `brain-auto-approve`) stay selected even though it never reaches the top. A wheel or touchstart releases the lock at once.
  - **Scroll-spy.** A scroll listener throttled with `requestAnimationFrame` picks the last section whose top is within its own computed `scroll-margin-top` plus 24 px. When the page is at the bottom it picks the last section, which covers requirement 2's case of a last section too short to reach the top. When the selection changes because of scrolling, the hash is updated with `replaceState`, so no history entries are added.
  - **Deep links.** On mount, a known `#id` selects that item and scrolls to the section instantly. A `hashchange` listener handles hash changes made elsewhere.
  - **Keeping the selected item visible.** When the list itself overflows (the horizontal strip on narrow screens, or a tall list on short desktop windows), the selected item is scrolled into the middle of the list. Only the list scrolls; the page does not.
  - **Selected style.** It reuses the main sidebar's active classes from `shell.tsx`: `bg-accent-soft font-medium text-accent-ink`, and `text-ink-2 hover:bg-surface-2 hover:text-ink` otherwise. Items are `<a href="#id">` links, so they are focusable and work without JS. The selected item has `aria-current="location"`.
  - **Layout.** At `xl` and above it is a vertical list, sticky at `top-6`, that scrolls inside itself when taller than the window. Below `xl` it is a sticky, horizontally scrollable strip with the page background. It sits at `top-[53px]` below `lg`, just under the shell's sticky mobile top bar, and at `top-0` from `lg` to `xl`.
- `apps/panel/app/settings/page.tsx`:
  - Replaced the inline `<aside class="hidden xl:block">` list with `<SectionNav items=... />`. The section ids and titles are the same as before.
  - The wrapper is now `space-y-4 xl:grid xl:grid-cols-[12rem_1fr] xl:gap-6 xl:space-y-0`. Below `xl` the nav's parent is the block that holds all the sections, so the sticky strip works there. At `xl` the nav is a grid item with `self-start`.
  - The content column gets `[&>section[id]]:scroll-mt-28 xl:[&>section[id]]:scroll-mt-6`. Headings clear the mobile top bar plus the strip (53 + 45 px) and get 24 px of breathing room on desktop. Because this is plain CSS, it also applies to the browser's own fragment scroll before hydration.
  - I renamed the label of the existing view tabs (Settings / Rulebook / Raw YAML) from `aria-label="Settings sections"` to `"Settings views"`. Otherwise two nav landmarks on the page would share one name.

## Requirements

1. **Click jumps and selects.** Verified: clicking `scoring` selected it within 60 ms, and once settled its top was 24 px (the scroll margin) with focus on the section. `paid-models` behaved the same way.
2. **Scroll-spy.** Verified: wheel +1200 selected `discovery`, +1500 more selected `scoring`, the bottom selected `roles` (the last section), and the top selected `providers`.
3. **Hash and deep links.** Verified:
   - `/settings#paid` opens with `paid` at top 24 and "Paid routing" selected.
   - `#roles` opens at the bottom with "Roles" selected.
   - `#brain-auto-approve`, which cannot reach the top, opens with its own item selected.
   - Clicks and scroll-spy changes added no history entries (`historyDelta: 0`; the history length stayed at 10, then 12, across clicks and wheels).
4. **Scroll margin.** Verified: on desktop the section's top lands at 24 px. On mobile (390x844), `#paid` has its top at 112 px while the sticky strip ends at 98 px, so the heading is not covered.
5. **Keyboard.** Verified: `focus()` on an item followed by an Enter key event scrolled to `brain` (top 24), selected it, and moved focus to the section. `aria-current="location"` is on the selected item only.
6. **Narrow screens.** Verified at 390x844:
   - The deep link selects `paid`, and the selected chip is visible inside the strip.
   - There is no horizontal page overflow.
   - Tapping `brain-mounts` jumps there (top 112) and selects it.
   - Scrolling up 2500 px selects `paid-providers`.

## Commands run and observed results

- `pnpm --filter switchyard-router build`: tsc finished with no errors.
- `pnpm -r typecheck`: router Done, panel Done.
- `pnpm --filter switchyard-panel build`: succeeded, and `/settings` is listed as dynamic.
- `pnpm --filter switchyard-panel seed:demo`: printed "Demo ready".
- `SWITCHYARD_CONFIG=.demo/switchyard.config.yaml npx next start -H 127.0.0.1 -p 4596`:
  - `/settings` returned 200.
  - All 26 nav ids exist as `<section id>` in the HTML.
  - I stopped the panel afterwards (the port 4596 listener was killed and the port confirmed free).
- Headless `--screenshot` at 1280x1000 (`--virtual-time-budget=6000`):
  - `/settings` rendered correctly with "Providers" selected.
  - `/settings#paid` and `/settings#roles` came out **blank**: a 5865-byte image of only the page background.
  - This is a limitation of `--screenshot`, not of the change. The same blank image is produced with `--disable-javascript` for `/settings#paid`, where only the browser's native fragment scroll runs. `/settings#nothing`, which does not scroll, renders normally. `--dump-dom` of `/settings#paid` showed `aria-current="location"` on "Paid routing", which confirms the state but says nothing about scroll position.
- To check scroll position I wrote a small DevTools-protocol driver using Node 22's built-in WebSocket, with no puppeteer: `docs/working/reports/settings-nav-shots/ (not committed: binary screenshots and the throwaway check script) settings-nav-cdp-check.mjs`.
  - It loads pages, sends real mouse clicks, wheel events and key events, and reads `scrollY`, `location.hash`, `aria-current`, section tops, `history.length` and `document.activeElement`.
  - It captures screenshots with `Page.captureScreenshot`.
  - Results are in `cdp-results.txt`, quoted in the Requirements section above. No console errors or exceptions were recorded.
  - To run it, start the panel on 4596, then `node settings-nav-cdp-check.mjs <outDir> <scratchDir>`.

Screenshots (all in `D:/sy-wt/sn/docs/working/reports/settings-nav-shots/ (not committed: binary screenshots and the throwaway check script) `), all of which I looked at:
- `cdp-desktop-deep-paid.png`: scrolled to Paid routing with "Paid routing" highlighted.
- `cdp-desktop-deep-roles.png`: at the bottom with "Roles" highlighted.
- `cdp-mobile-click-brain-mounts.png`: the mobile strip under the top bar, with "Brain mounts" highlighted and the section heading visible below the strip.
- Also `cdp-desktop-top.png`, `cdp-desktop-scrolled.png`, `cdp-desktop-bottom.png`, `cdp-desktop-click-paid-models.png` and `cdp-mobile-deep-paid.png`.
- `settings-top.png` (correct), and `settings-paid.png` / `settings-roles.png`, the blank `--screenshot` outputs kept as evidence of the limitation.

## Not verified

- I watched no smooth-scroll animation; only the settled positions were checked.
- I did not test reduced motion, light theme, real touch devices (only emulated mobile metrics and wheel), Safari or Firefox.
- I did not test client-side navigation from another panel page to `/settings#paid`. Next's own hash handling plus the mount effect should cover it, but I did not test it.
- I did not check the screen-reader announcement of `aria-current="location"`.
- I did not test the 1024-1280 px (lg to xl) layout, where the strip sticks at `top-0`.
- I did not run the router vitest suite, because the change is panel-only.

## Open questions or contradictions found

- The PNGs and the `.mjs` driver sit under `docs/working/reports/settings-nav-shots/ (not committed: binary screenshots and the throwaway check script) `. The supervisor may not want binary screenshots committed.
- Before this change the section list was `hidden` below `xl` (1280 px), so on laptops and phones there was no list at all. It now shows as a sticky strip there. That is a visible layout change at those widths.
