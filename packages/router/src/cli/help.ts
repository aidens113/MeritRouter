// The CLI's help text (`switchyard --help`).

export const HELP = `switchyard - delegate bounded tasks to the models your provider keys can use

Usage: switchyard <command> [options]   (global: --config <file>, --project <slug>, --json)

Projects (one install holds many; providers, models, routing, and budgets are global)
  The project a command works in: --project, else SWITCHYARD_PROJECT, else the only project,
  else the project whose repository contains the working directory; otherwise commands that
  need one fail and list the projects. Lists (status, jobs, sessions, questions, usage, brain)
  show every project when none can be chosen.
  projects [list] [--all]       projects with repositories, running and queued jobs and tasks,
                                last activity, and attention items (--all adds archived ones)
  projects create <slug> [--name "<name>"] [--repo <alias>=<path> ...]
                                add projects.<slug> to the config (each repository folder is created
                                or set up with git as needed) and create its brain folders; a single-project
                                config is converted first (its repositories move under its slug)
  projects delete <slug> --confirm <slug>   delete a project: its settings, tasks, sessions,
                                SwitchYard worktrees, and brain folder (repositories, branches,
                                and request and spend history stay); refused while it has running
                                or queued tasks, and for the last project; without --confirm it
                                prints what would be removed
  projects archive|unarchive <slug>   hide a project (its settings, tasks, sessions, and brain
                                are kept); refused while it has running or queued tasks

Setup
  Config: --config, else SWITCHYARD_CONFIG, else nearest ancestor switchyard.config.yaml,
          else platform user config directory (override its directory with SWITCHYARD_HOME).
  setup [dir] [--preset <name>] [--repo <alias>=<path> ...] [--port <n>] [--no-panel]
                                create the discovered/default config and start the bundled panel;
                                no placeholder repositories, existing files kept; --no-panel only initializes
  init [dir] [--preset <name>] [--project <slug>] [--name "<name>"] [--repo <alias>=<path> ...]
                                write switchyard.config.yaml (global settings plus a first
                                project, default my-project) and models.yaml
                                presets: claude-code (default), standalone-free,
                                standalone-hybrid, standalone-paid
  panel                         start the web panel (http://127.0.0.1:<panel.port>) unless it is
                                already running; the MCP server and worker also start it
                                (panel.auto_start)
  doctor                        check config, each provider (keys, cooldowns, invalid keys,
                                last model listing), secrets in the config, models, and per
                                project its repositories and brain folders (--project: one)
  mcp [--no-worker] [--http [--host <h>] [--port <n>]]
                                the MCP server for Claude Code, Codex, ChatGPT, and other MCP
                                clients, serving one project; stdio by default (the client
                                launches it); --http serves Streamable HTTP at
                                http://127.0.0.1:4478/mcp (--host or --port imply --http).
                                SWITCHYARD_MCP_TOKEN, when set, is required on every request
                                (Authorization: Bearer <token>, or the URL /mcp/<token>); it
                                must be set for a non-loopback --host. --no-worker leaves the
                                worker to a daemon
  models [--all]                list models with status and eligibility
  models scan                   list the models of every provider with a usable key, refresh
                                free daily quotas and paid prices (exit 1 if nothing was listed)
  models show <id>              full analysis of one model
  models confirm <id> [--params <B>] [--active <B>]   accept or set parameter counts
  models enable|disable <id>    force a model on or off
  route <profile> <tier>        preview which models would serve a task type at a tier

Tasks
  worker                        run the worker loop for every project until interrupted
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

Labs (project-scoped isolated branches, ports, data and configured services)
  labs [list]                   retained labs; --json includes safe service/check details
  labs create <name> [goal]      create from the project's configured recipe
  labs status <name>            services, URLs, exact heads and checks
  labs start|stop|refresh <name> queue a lifecycle request to the Labs supervisor
  labs restart <name> [service] restart all or one declared service
  labs check <name> <check>      run a declared revision-bound check
  labs logs <name> <service>     bounded service logs
  labs promote <name> [--reason text]   prepare exact checked promotion; manual policy prints commands
  labs destroy <name> --confirm <name>  stop owned services and remove clean worktrees/data; branches remain
  labs operations <name>        persisted lifecycle outcomes; --timeout bounds command waits
  labs serve                    foreground service supervision for all projects; no model worker
  labs supervisor-start|supervisor-stop|supervisor-status   background supervisor management

Provider keys (stored encrypted in the vault; keys under providers in the config are listed too)
  keys [list] [provider]        every key with its source, billing class, status (ok, cooling
                                down until, INVALID, out of credits), and last four characters
  keys add <provider> --billing free_tier|paid_credits|paid_postpaid|trial [--label x]
           [--rpm n] [--rpd n] [--tpm n] [--tpd n] [--quota-group g] [--account-id id]
           [--balance usd] [--cap usd] [--test] [--no-scan]
                                the secret comes from SWITCHYARD_NEW_KEY or a hidden prompt,
                                never the command line; --test lists its models first and
                                stores the key only if that works; the provider's models are
                                then listed for routing (--no-scan skips it, e.g. offline)
  keys add tavily|brave|exa [--label x]
                                a web search key for agents' web_search (never used for chat;
                                no billing class, no model listing); keys list shows it too
  keys test [provider|id|ref]   list the models each key can use (a rejected key is marked
                                invalid; nothing is added to the catalog: run models scan)
  keys enable|disable|remove <id>   vault keys (config keys are changed in the config file)
  keys spend                    paid spend against budgets

Standalone jobs (a SwitchYard supervisor plans, delegates, verifies, integrates)
  run "<goal>" --repo <alias> [--lab <name>] [--check "<cmd>"] [--criteria "<text>"] [--wait]
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
  budget list [--status s|all] [--job <id>]   workers' requests for more model requests
                                (pending by default) with each job's pool
  budget approve <id> [--grant N] [--reason "..."] | deny <id> [--reason "..."]
                                decide one (an approval comes out of the job's pool)

Brain (shared knowledge) and attribution
  brain ls [prefix] | read <path> | search <query>
  brain requests | approve <id> [reason] | deny <id> [reason]
  blame <repo-alias> <path> [--ref <branch>]   which agent and model wrote each line (the
                                alias is the project's)

Qualification
  qualify <model-id> [--trials n]   run the private eval suite pinned to one model
  qualify status                    leaderboard (grades any finished runs first)
  compare [--eval id[,id]] [--goals <file>] [--team-factor n] [--team-requests n] --dry-run | --yes
                                    run the same goals as a team job and as a single agent and
                                    record both metric sets; prints the planned request budget,
                                    runs only with --yes, within qualification.max_requests_per_day
  compare list | show <id>          recorded comparisons

Operations (install-wide: every project; --project is refused here.
storage.durability: normal | full sets SQLite's synchronous level)
  backup <dir> [--include-master-key]   online snapshot of the database, session logs, and
                                artifacts, plus the brain repository as a git bundle, into a
                                new directory (never worktrees; brain mounts are listed, not
                                copied)
  restore <dir> [--force]       restore a backup and its brain; refused while a worker holds
                                live leases, over a brain with uncommitted changes, and over
                                existing state unless --force (which moves it aside)
  daemon [run] [--max-restarts n] [--window s] [--max-delay s]   run one worker for every
                                project and restart it on failure with backoff; logs under
                                <storage>/logs/
  daemon start | status | stop [--timeout s]   the same in the background; status shows the
                                daemon and each project's queued and running tasks
  service install|uninstall|status [--name n] [--dry-run]   run the daemon at logon as a
                                systemd user unit, launchd agent, or Windows scheduled task
`;
