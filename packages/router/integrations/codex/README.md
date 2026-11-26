# Codex integration

`meritrouter connect codex --project <slug> [--repo <dir>] [--project-dir <dir>]` registers this
MCP server with Codex and appends an offload reminder to the repository's `AGENTS.md`.

Verified against `docs/setup.md`'s own Codex section (`codex mcp add`, under "Connect an MCP
client"): Codex keeps its MCP servers in `~/.codex/config.toml` (or `$CODEX_HOME/config.toml`,
shared by the CLI and the IDE extension) as:

```toml
[mcp_servers.meritrouter]
command = 'node'
args = ['/abs/MeritRouter/packages/router/dist/cli.js', 'mcp', '--config', '/abs/path/meritrouter.config.yaml', '--project', 'my-app']
```

`connect codex` merges exactly that section (replacing a prior `[mcp_servers.meritrouter]` block
of its own on re-run, leaving every other server untouched) instead of running `codex mcp add`
itself, since that command is not guaranteed to be installed where `meritrouter` runs.

Codex has no hook mechanism equivalent to Claude Code's `.claude/settings.json` hooks, so
`connect codex --hooks` is refused rather than silently doing nothing: there is nothing here for
`--hooks` to install. Use `meritrouter inbox` yourself before ending a Codex session, or follow
the appended `AGENTS.md` reminder.
