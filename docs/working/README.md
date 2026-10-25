# Working documents

Index of efforts in progress or recently finished. Read the one you need, then only its
`Current State`. Format: the working-document protocol (header block, `Current State` under 150
lines, worker briefs, append-only ledger with real validation, open questions).

| Document | Status | Scope |
| --- | --- | --- |
| [project-grid-deletion.md](project-grid-deletion.md) | Complete | Grid deletion and pending-request retirement verified; both clones removed through UI, sources preserved, panel restarted. Full suite had one browser timing failure that passed isolated rerun. |
| [supervisor-lifecycle-stall.md](supervisor-lifecycle-stall.md) | Active | Model stall handoff verified42/42 plus recursive checks; full1501pass/1HTTPcleanupfailure/3skip, corrected fixture4/4. Core repair45/45tests integrated; API/UI unfinished. Plan preservation root98/98 serial/typecheck/build verified; publication next. |
| [supervised-delivery-v2.md](supervised-delivery-v2.md) | Active | Supervisor bootstrap/recovery/batching corrections verified and activated; renewed Facebook supervisor running, product acceptance pending. Earlier interactive adapter acceptance still blocked by absent Docker engine. |
| [instagram-meritrouter-assessment.md](instagram-meritrouter-assessment.md) | Complete | All18tasks/19sessions and live panel reviewed;364requests reconciled; framework defects, supervision limits and prioritized operating improvements. |
| [instagram-meritrouter-trial.md](instagram-meritrouter-trial.md) | Complete | Worker-only local app acceptance, observed framework gaps, and published four-worker defaults. |
| [cost-first-routing.md](cost-first-routing.md) | Complete | Cost-first defaults/docs; visible cropped Overview charts with ranges; project selector and authorized panel restart. |
| [meritrouter-rename.md](meritrouter-rename.md) | Complete | Complete MeritRouter identity, safe existing-install migration, readable docs and agent-first README onboarding. |
| [correctness-and-panel-flows.md](correctness-and-panel-flows.md) | Complete | Accepted audit fixes, repository containment/security policy, supervisor approvals and connected panel flows; no live deployment. |
| [post-change-fix-audit.md](post-change-fix-audit.md) | Superseded | Audit findings implemented by correctness-and-panel-flows; historical baseline and fix plan. |
| [roadmap-completion.md](roadmap-completion.md) | Active | User-authorized execution of the remaining audit: correctness, Labs, packaging, provider/project follow-ups and acceptance. |
| [external-supervisor-guidance.md](external-supervisor-guidance.md) | Complete | Accepted default-OFF MCP final supervisor permission, bounded sub-supervisors, UI/explicit-request controls;734-test integrated acceptance. |
| [distributed-and-lab-extensions.md](distributed-and-lab-extensions.md) | Active | Static browser and async ledger/queue prerequisites accepted; task-Lab integration and Compose validation active. Hydrated browser, Compose runtime and PostgreSQL/multi-host remain open. |
| [handoff.md](handoff.md) | Active | **Start here:** the state of every effort, the user's live install, and what to do next (2026-10-22). |
| [agent-sessions-and-teams.md](agent-sessions-and-teams.md) | Active | Durable resumable agent sessions, failure resilience, coordinated agent teams. S1-S2, R1, T1-T3 done; live validation outstanding, R2 deferred. |
| [agent-working-doc-protocol.md](agent-working-doc-protocol.md) | Active | The protocol every working document follows (adopted from FluxIQ). |
| [importance-and-verification.md](importance-and-verification.md) | Active | Task importance and verification policy: contracts, deterministic checks, independent reviewers, reserved verification budget. V1, V2, V3 done; live-model validation outstanding. |
| [direct-providers.md](direct-providers.md) | Active | Call providers directly with keys entered in MeritRouter; automatic model discovery; FreeLLMAPI removed. P1-P4 done and merged 2026-10-20 (P4: Ollama, local servers, more providers); a live check with real keys remains. |
| [projects.md](projects.md) | Active | One install, many projects: projects grid, switcher, per-project jobs/brain/sessions, fair scheduling, gated global knowledge, global dashboard. J1-J3 done and merged 2026-10-20; repository auto-setup and the Live control added 2026-10-21. |
| [caching-and-continuity.md](caching-and-continuity.md) | Active | Provider prompt caching, model stickiness, cached-token pricing, truncation recovery, prefix-stable compaction. C1-C2 done and merged 2026-10-21; live check outstanding. |
| [budget-control.md](budget-control.md) | Active | Supervisor-set request budgets for delegated tasks, and workers asking their supervisor for more. B1 and B2 implemented and accepted; panel requests/pools verified in demo. Real-provider/transport checks remain. |
| [panel-v2.md](panel-v2.md) | Complete | U1-U3 plus reopened completion audit accepted: scoped brain/entity links, Activity, repaired seed, live browser checks, 622 tests. |
| [labs.md](labs.md) | Active | L1-L4 accepted: isolated feature branches/data/ports/services, team tools, checked promotion and panel. L5 extensions remain active. |
| [web-search.md](web-search.md) | Active | Web search and page fetching for agents: pluggable backends (Ollama, Tavily, Brave, Exa, SearXNG), SSRF-guarded fetch, budgets, untrusted-content handling. Planned 2026-10-21. |
| [live-validation.md](live-validation.md) | Active | First runs against real providers and Claude Code: findings, fixes, open items (Ollama Cloud, Tetris job, panel auto-start). Started 2026-10-21. |
| [harness-roles-brain.md](harness-roles-brain.md) | Active | Harness, roles, brain, attribution, paid routes, presets, panel. Implemented; live provider checks outstanding. |
