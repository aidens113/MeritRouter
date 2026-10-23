# MeritRouter

**Ask your coding agent:**

```text
Use MeritRouter for this repository. Check its MCP connection and setup guide first.
Keep my current agent as supervisor, delegate small tasks and review their evidence.
Keep paid routing off and outside-repository actions on human approval only.
Guide me to enter credentials in the panel; never put secrets in chat or Git.
```

MeritRouter routes bounded work to approved models and records results for your supervisor
to review. This package contains the library, `meritrouter` CLI, MCP server and web panel.

After installing a locally built tarball, register a project:

```sh
meritrouter setup --preset claude-code --project my-app --repo app="/absolute/path/to/my-app"
```

Open the printed panel URL, add a provider key, review model eligibility, then connect your
agent using the absolute config path printed by setup. Reconnect the agent and try a small
read-only task. Use the [setup guide](https://github.com/aidens113/MeritRouter/blob/main/docs/setup.md)
for exact MCP registration and other client options.

Paid routing is off by default. Human approval is required for host commands by default.
External autonomous coding runners and automatic worker Task Lab execution remain unavailable
without their enforced sandbox or durable execution proof. Use the native runner.

- [Project README and source installation](https://github.com/aidens113/MeritRouter#readme)
- [Documentation](https://github.com/aidens113/MeritRouter/blob/main/docs/README.md)
- [Existing installation migration](https://github.com/aidens113/MeritRouter/blob/main/docs/setup.md#upgrading-from-switchyard)

The package requires Node.js 22.11 or later and Git. Building from source additionally needs
pnpm 10.5. These instructions do not assume a public npm release.
