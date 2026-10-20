// The CLI's help text (`switchyard --help`).

export const HELP = `switchyard - delegate bounded tasks to approved free model pools

Usage: switchyard <command> [options]   (global: --config <file>, --json)

Setup
  init [dir] [--preset <name>]  write switchyard.config.yaml and models.yaml
                                presets: claude-code (default), standalone-free,
                                standalone-hybrid, standalone-paid
  doctor                        check config, gateway, admin access, models, and repositories
  models [--all]                list models with status and eligibility
  models scan                   scan FreeLLMAPI's catalog and sync per-model chains
  models show <id>              full analysis of one model
  models confirm <id> [--params <B>] [--active <B>]   accept or set parameter counts
  models enable|disable <id>    force a model on or off
  route <profile> <tier>        preview which models would serve a task type at a tier

Tasks
  worker                        run the worker loop until interrupted
  submit <file|-> [--wait] [--timeout s] [--importance low|normal|high|critical] [--importance-reason "<why>"]
                                submit task JSON (object or array); --importance fills in
                                tasks that set none (high and critical need a reason)
  status [ids...]               task status (recent tasks when no ids)
  await <ids...> [--timeout s]  wait for results
  collect <ids...>              print finished results
  cancel <ids...>               cancel tasks
  resume <id>                   requeue interrupted work: a session id (s_...) continues
                                that session; a task id continues its latest session
                                (coding tasks start over in a fresh worktree)
  accept <id> [--reason "<why>"]   accept a finished result as you (needs_supervisor and
                                not_verified results need a reason)
  reject <id> --reason "<why>"  reject a finished result; it becomes unmet
  artifact <ref>                print an artifact
  usage [--hours n]             requests, tokens, and outcomes

Agent sessions (every model call and tool call, in order)
  sessions [--status s[,s]] [--task id] [--job id] [--limit n]   list sessions, newest first
                                statuses: running, completed, failed, interrupted, cancelled
  session <id> [--after seq] [--limit n]   timeline (--json prints the raw page)

Paid keys (direct routes; secrets are encrypted at rest)
  keys [list]                   keys with billing class, spend, balance, cap
  keys add <provider> [--label x] [--billing paid_credits|paid_postpaid|trial|free_tier] [--balance usd] [--cap usd]
                                reads the secret from SWITCHYARD_NEW_KEY
  keys enable|disable|remove <id>
  keys spend                    spend against budgets

Standalone jobs (a SwitchYard supervisor plans, delegates, verifies, integrates)
  run "<goal>" --repo <alias> [--check "<cmd>"] [--criteria "<text>"] [--wait]
  jobs                          list jobs
  job <id>                      job status, workers, branch, questions; sub-jobs (tree with
                                branches and carved budgets), merge queue, recent channel posts
  channel <job> [--after id] [--limit n] [--kind k[,k]]   the job's team channel, oldest first
                                (kinds: finding, blocker, interface_contract); posts are data
  plan <job>                    the job's task graph: nodes with state, tier, and importance,
                                dependencies, critical path (*), file leases, why nodes wait
  metrics <job|task>            team metrics: wall-clock, parallelism over time (peak, mean),
                                critical path (planned and actual), requests and cost per
                                completed task, verification share, waiting time by reason
  questions                     questions supervisors are waiting on
  answer <id> "<answer>"        answer one

Brain (shared knowledge) and attribution
  brain ls [prefix] | read <path> | search <query>
  brain requests | approve <id> [reason] | deny <id> [reason]
  blame <repo-alias> <path> [--ref <branch>]   which agent and model wrote each line

Qualification
  qualify <model-id> [--trials n]   run the private eval suite pinned to one model
  qualify status                    leaderboard (grades any finished runs first)
  compare [--eval id[,id]] [--goals <file>] [--team-factor n] [--team-requests n] --dry-run | --yes
                                    run the same goals as a team job and as a single agent and
                                    record both metric sets; prints the planned request budget,
                                    runs only with --yes, within qualification.max_requests_per_day
  compare list | show <id>          recorded comparisons

Operations (storage.durability: normal | full sets SQLite's synchronous level)
  backup <dir> [--include-master-key]   online snapshot of the database, session logs, and
                                artifacts into a new directory (never worktrees)
  restore <dir> [--force]       restore a backup; refused while a worker holds live leases,
                                and over existing state unless --force (which moves it aside)
  daemon [--max-restarts n] [--window s] [--max-delay s]   run the worker and restart it on
                                failure with backoff; logs under <storage>/logs/
  service install|uninstall|status [--name n] [--dry-run]   run the daemon at logon as a
                                systemd user unit, launchd agent, or Windows scheduled task
`;
