# MeritRouter

MeritRouter routes tasks to suitable paid and free models to help reduce your AI costs.
It matches task requirements to model capabilities within your policies and budgets,
and gives coding agents a framework for executable checks, independent review and
recorded evidence before accepting delegated work.

**Ask your coding agent:**

```text
Use MeritRouter for this repository. Check its MCP connection and setup guide first.
Keep my current agent as supervisor, delegate small tasks and review their evidence.
Reduce model costs using capable free and paid routes within configured budgets.
Keep outside-repository actions on human approval only.
Guide me to enter credentials in the panel; never put secrets in chat or Git.
```

This package contains the library, `meritrouter` CLI, MCP server and web panel.

After installing a locally built tarball, register a project:

```sh
meritrouter setup --preset claude-code --project my-app --repo app="/absolute/path/to/my-app"
```

Open the printed panel URL, add a provider key, review model eligibility, then connect your
agent using the absolute config path printed by setup. Reconnect the agent and try a small
read-only task. Use the [setup guide](https://github.com/aidens113/MeritRouter/blob/main/docs/setup.md)
for exact MCP registration and other client options.

Paid routing is enabled by default with a $5 rolling weekly cap: T1-T3 workers can use paid
routes when eligible free routes are exhausted; T4 returns to the supervisor. Paid requests
still require eligible credentials, known prices and budget headroom. Existing explicit
settings are preserved. Set `paid.enabled: false` for strictly free routing; the
`standalone-free` preset also selects a free-only supervisor. See the setup guide for
[cost controls](https://github.com/aidens113/MeritRouter/blob/main/docs/setup.md#cost-controls-and-routing-defaults).
Human approval is required for host commands by default.
External autonomous coding runners and automatic worker Task Lab execution remain unavailable
without their enforced sandbox or durable execution proof. Use the native runner.

- [Project README and source installation](https://github.com/aidens113/MeritRouter#readme)
- [Documentation](https://github.com/aidens113/MeritRouter/blob/main/docs/README.md)
- [Existing installation migration](https://github.com/aidens113/MeritRouter/blob/main/docs/setup.md#upgrading-from-switchyard)

The package requires Node.js 22.11 or later and Git. Building from source additionally needs
pnpm 10.5. These instructions do not assume a public npm release.
