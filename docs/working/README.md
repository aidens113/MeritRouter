# Working documents

Index of efforts in progress or recently finished. Read the one you need, then only its
`Current State`. Format: the working-document protocol (header block, `Current State` under 150
lines, worker briefs, append-only ledger with real validation, open questions).

| Document | Status | Scope |
| --- | --- | --- |
| [agent-sessions-and-teams.md](agent-sessions-and-teams.md) | Active | Durable resumable agent sessions, failure resilience, coordinated agent teams. S1-S2, R1, T1-T3 done; live validation outstanding, R2 deferred. |
| [agent-working-doc-protocol.md](agent-working-doc-protocol.md) | Active | The protocol every working document follows (adopted from FluxIQ). |
| [importance-and-verification.md](importance-and-verification.md) | Active | Task importance and verification policy: contracts, deterministic checks, independent reviewers, reserved verification budget. V1, V2, V3 done; live-model validation outstanding. |
| [direct-providers.md](direct-providers.md) | Active | Call providers directly with keys entered in SwitchYard; automatic model discovery; FreeLLMAPI removed. P1-P4 done and merged 2026-10-20 (P4: Ollama, local servers, more providers); a live check with real keys remains. |
| [projects.md](projects.md) | Active | One install, many projects: projects grid, switcher, per-project jobs/brain/sessions, fair scheduling, gated global knowledge, global dashboard. J1-J3 done and merged 2026-10-20; repository auto-setup and the Live control added 2026-10-21. |
| [caching-and-continuity.md](caching-and-continuity.md) | Active | Provider prompt caching, model stickiness, cached-token pricing, truncation recovery, prefix-stable compaction. C1-C2 done and merged 2026-10-21; live check outstanding. |
| [labs.md](labs.md) | Active | Labs (lanes): isolated, runnable copies of a project per feature, each with its own branch, ports, data, and supervised services, where a team builds and tests; gated promotion into the target branch. Planned 2026-10-21; open questions for the user. |
| [web-search.md](web-search.md) | Active | Web search and page fetching for agents: pluggable backends (Ollama, Tavily, Brave, Exa, SearXNG), SSRF-guarded fetch, budgets, untrusted-content handling. Planned 2026-10-21. |
| [live-validation.md](live-validation.md) | Active | First runs against real providers and Claude Code: findings, fixes, open items (Ollama Cloud, Tetris job, panel auto-start). Started 2026-10-21. |
| [harness-roles-brain.md](harness-roles-brain.md) | Active | Harness, roles, brain, attribution, paid routes, presets, panel. Implemented; live provider checks outstanding. |
