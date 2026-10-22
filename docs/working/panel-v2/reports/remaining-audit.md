# Report: remaining-panel-audit
## Outcome
Done: bounded D5/D6 audit recorded; three authorized link fixes implemented for supervisor validation.
## What changed and why
Read-only audit against `e00dfd5` and the architecture map, followed by three source fixes expressly authorized by the supervisor. Session workspace aliases and commits now use project-scoped helpers (Qualification retains text); Jobs lists link parent jobs; agent Requests rows link known model endpoints. No builds, tests, services or user configuration used.
### Concrete gaps
1. D5: job detail `apps/panel/app/p/[slug]/jobs/[id]/page.tsx:361` wraps Supervisor transcript in a closed Disclosure. Existing Transcript renders inner ToolCall details, Tool result details (around 410), and Job brief details (around 425). From default Overview, Sessions tab + transcript disclosure + inner detail is three clicks to existing data. Smallest fix: remove the outer disclosure or make it defaultOpen. Supervisor notified; this file is outside this worker's edit ownership.
2. D6: `components/session-detail.tsx:264` Workspace repository alias, base commit and last commit are plain values. Use repoHref and CommitLink with current base; reserved Qualification scope must retain text because its base has no repo/commit routes. Implemented in the authorized focused follow-up.
3. D6: `app/p/[slug]/jobs/page.tsx:104` parent job name/id is plain text. Link with jobHref(base,parentJobId). Implemented in the authorized focused follow-up.
4. D6: `app/p/[slug]/agents/[id]/page.tsx:29` Requests rows display served model/endpoint as text. Use ModelLink when endpointId is present; preserve unknown fallback. Implemented in the authorized focused follow-up.
5. D6: `components/task-detail.tsx:179` Goal metadata joins repositoryAliases/writableRepository as plaintext; job detail Branches around 316 also names each repository alias as text. Supervisor notified; outside authorized worker edit ownership.
### Bounded baseline retention and anchor inventory
The nine dense surfaces below retain every baseline literal CardHeader title. This is a section-presence inventory, not proof of every nested datum or browser interaction.
| Surface | Baseline sections retained and current destination | Baseline anchors |
| --- | --- | --- |
| Install dashboard | Queues by project -> Projects; running/queued jobs -> Activity; usage/paid -> Usage; Worker/provider health -> Health | none literal |
| Project overview | Jobs/repositories -> Overview; Worker -> Activity; request chart/tasks by tier -> Usage | none literal |
| Job detail | Questions stays shared; Goal/Details/Result -> Overview; Worker tasks -> Team; Branches -> Changes; sessions/transcript -> Sessions | questions stays shared; child plan/team/metrics/merge-queue/channel IDs mapped by Tabs |
| Task detail | Goal shared; Result/artifacts -> Result; contract/verification -> Verification; difficulty/attempts -> Routing; model/web requests -> Usage; sessions/timeline -> Sessions | web-requests -> Usage |
| Session detail | Event log -> Timeline; Details/workspace/runs/spawned -> Details; added Requests tab | no baseline literal IDs; after/limit retained by tab links |
| Model detail | Facts/parameter evidence -> Overview; eligibility -> Eligibility; qualification -> Qualification; requests -> Usage; Controls -> Controls | controls -> Controls; id query kept |
| Keys | provider cards -> Keys; Add key -> Add; web search -> Web; paid spend -> Paid | add/web-search/paid and dynamic provider-<id> mapped |
| Global settings | General/routing/task types/web+paid/brain+roles + existing Rulebook/YAML | all literal and generated IDs mapped with sectionTab |
| Project settings | General/repositories/brain -> General; scheduling -> Scheduling; verification/team/commands/roles -> Policy; danger -> Danger | NAV IDs all mapped to owning tab |
### Dynamic settings retention
`git diff e00dfd5` is empty for settings-schema.ts, project settings forms.tsx/overrides.tsx, and client settings-form.tsx/settings-rows.tsx. Thus existing fields, generated row controls and their rendering implementations remain unchanged. Global SECTIONS still renders each of providers/models/discovery/tiers/routing/scoring/qualification/execution/allocation/coding/panel in its owning tab. All configured profiles generate profile-<name> and land in Task types. Supervisor/web/paid/brain/roles and optional mounts/auto-approval components retain their original prop data and conditions. Multi-project repositories remain links to project settings; global brain mounts/auto-approval remain conditional on existing global entries exactly as baseline.
### Old query/navigation compatibility
Global settings baseline recognized form/rulebook/yaml. rulebook and yaml survive unchanged; explicit `?tab=form` now falls back to general, with other old form sections one tab click away. All old section hashes map to their owner even with tab=form because TabAnchors replaces the tab query while preserving other parameters. This is a semantic compatibility caveat, not evidence of lost fields. Models retain id across tabs. Session after/limit remain across tabs and pagination returns to default Timeline. Keys/project settings/dashboard previously had no tab-query semantics. Existing global legacy redirects remain in next.config.ts.
## Commands run and observed results
Source reads, rg, git show e00dfd5, targeted git diff, and a read-only literal-title/ID inventory. `git diff --check` passed after the focused changes. No literal title losses in nine surfaces; no supporting dynamic settings renderer/schema changes.
## Not verified
No browser behavior, arbitrary free text/JSON entity mentions, every possible configuration, every timeline payload or runtime pagination boundary. No exhaustive claim that all D5/D6 requirements pass. Source was changing concurrently; references are approximate line positions at inspection.
## Open questions or contradictions found
The architecture map's promise of <=2 clicks conflicts with the extra transcript disclosure. The three assigned link gaps are patched. Transcript nesting and repository metadata links remain supervisor-owned findings; all fixes still need supervisor browser review before closure.
