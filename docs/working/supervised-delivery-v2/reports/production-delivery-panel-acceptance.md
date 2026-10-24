# Production delivery panel acceptance

Status: Partial — functional scenarios pass; mobile Markdown table usability defect found and reported for a narrow feature fix. Latest settings copy fix is not in the tested snapshot.

## Environment and isolation

- Verified release snapshot `D:/SwitchYardRouter-delivery-v2-release`, checkpoint `9c80b12`, Windows/Chrome, production Next server `http://127.0.0.1:4480`.
- Root confirmed recursive production build passed before launch. No source or test edits made in the snapshot. Full router suite belongs to root, not this report.
- Seeded `apps/panel/.demo` with `node scripts/seed-demo.mjs`: observed exit 0, all fixture assertions passed. Nested team completed with criteria met, one subjob, three integrations, one rebased integration, four team posts, verified twin runs. Comparison team peaked at two concurrent workers and seven requests. Fixture Labs stopped after their seed health checks. Nonfatal seed warning: repeated analysis did not reuse a cached verdict.
- Only fake/scripted providers and loopback fixture services used. No real configuration, Brain, repository, provider quota, or port 4477 used.
- Owned production server PID **24648**, port **4480**, explicitly bound to the release `.demo/meritrouter.config.yaml`. Root requested it remain running for independent verification and accepted cleanup ownership. All QA Chrome instances were closed.

## Observed acceptance

Corrected final browser/API run: **17/17 scenarios passed; zero browser `pageerror` exceptions**. Initial run had three QA locator failures: exact matching on wrapping labels included select-option/current-textarea text. Corrected temporary selectors and reran all scenarios successfully; no product source changed to make tests pass.

1. Fourteen affected page/API GETs returned 200: project Brain documents/memory/access/promotions, standalone global memory, Global Knowledge, both settings tabs, tasks/filter, catalog, project/global typed memory, historical receipt preview.
2. Ordinary note create-only collision returned 409. Two concurrent writes against one digest yielded exactly one 200 and one 409. Actual editor preserved dirty input after an external change, let the user review latest content, and saved a merged revision.
3. Foreign-project raw read returned 403; excessive catalog limit returned 400; foreign-Origin mutation returned 403; missing project for project-scoped typed memory returned 400.
4. History page continuation preserved its original page size, and a later HEAD rejected its stale cursor with 409. History, blame and related document views returned 200.
5. Each run added 60 project documents and 80 higher-scoring foreign-project search matches. Catalog pages of 25 were disjoint; search returned 30 own-project results despite competing foreign hits. Writes invalidated catalog/search generation cursors with 409.
6. Project and standalone global preference UI each created, updated and revoked a real typed record: `qa-mvlseb2j-project` / `qa-mvlseb2j-global`, revision 3, revoked. Exact instruction/source and `panel-user` human author were retained. Stale digest and raw-editor typed-memory bypass returned 409, including mixed-case project memory path. Typed project fact creation worked through the actual documents UI; raw edit directed the operator to typed memory.
7. Actual seeded historical context manifests rendered through the lazy receipt UI. API returned ten valid receipts across supervisor/inspector/summarizer/reviewer/analyst roles. Querying a demo task from storefront returned 404. These are stored historical manifests, not a claim about future injection.
8. Settings UI changed workflow to delegated delivery, saved/reloaded a changed request budget, and verified default budget fields 600/80/80/200. Original demo workflow/budget restored through API. Removing then adding supervise via actual UI produced `mode/tools: supervisor`, null model-request cap and 8000 output tokens; original profile restored.
9. Task acceptance filter rendered `Not verified`. A synthetic product specification attached to an already accepted legacy demo supervise task (`t_0mvls6rc4f1205b8685bc`) displayed both **Criteria met** and **Evidence incomplete / Not decided**. This fixture checks labeling only; it does not claim an actual v2 delivery lifecycle succeeded. Root owns separate lifecycle verification.
10. Desktop and 390px mobile memory/Brain layouts rendered without document-level horizontal overflow. Visual review nevertheless exposed the table defect below.

Thirty warm production full-document navigations to a short selected Brain document (including heading availability): **p50 188 ms, p95 281 ms, maximum 326 ms**. This excludes server cold start and initial large-catalog indexing; it is not a 10k-file cold-browser benchmark.

## Defects and limits

- **Mobile Markdown tables:** at 390px, generated Brain index has six rows 166–204px tall, table height 1148.5px. Computed DOM shows the fourth Title column begins at x347, width85.94px with only ~62px text width; long titles wrap into 8–10 lines while the document links require only35.56px height. The table is399px wide inside an existing horizontal-scroll wrapper, so most of the title sits offscreen yet drives enormous blank visible rows. Cause: `components/markdown.tsx` table uses unrestricted `data-table` width100% from global CSS with no readable minimum column/table width. Reported to root; recommend a narrowly scoped readable minimum width on Markdown tables, preserving the existing horizontal scrolling and complete title content. Snapshot unmodified. Root requested this follow-up after independent screenshot review.
- **Stale missing-supervise explanatory copy:** tested snapshot still says 100B/30 requests although payload is null cap/8000 output and routing quality evidence is required. Root reports feature source corrected; that correction requires rebuilt production verification. Screenshot retained.
- No Docker runtime acceptance or real-provider model qualification performed here. No cold start/10k-file browser claim. No full-suite claim from this worker.

## Reproducible evidence

Temporary scripts: `%TEMP%/meritrouter-release9c80b12-qa.cjs` and `meritrouter-release9c80b12-product-fixture.mjs`. Main script output directory: `C:/Users/mrjoh/AppData/Local/Temp/meritrouter-release9c80b12-qa`.

- `results.json`: final 17/17 scenario details, API statuses, receipt roles, warm timings. `results-first-run.json` retains locator failures for audit.
- Visually inspected `editor-desktop.png`, `global-memory-desktop.png`, `global-memory-mobile.png`, `brain-mobile.png`.
- Further screenshots: `project-memory-desktop.png`, `memory-receipts-desktop.png`, `settings-delivery-desktop.png`, `settings-add-supervise-copy.png`, `tasks-acceptance-desktop.png`, `task-product-distinction-desktop.png`. Root independently inspected global/mobile/product distinction screenshots.
- Demo fixtures retained for root independent review, including the synthetic product spec and isolated QA notes/memory/catalog documents. Server log/PID files use `%TEMP%/meritrouter-release9c80b12-panel.*`.

Only this report changed in the feature worktree. No commits or pushes by this worker.
