# agenttrio

agenttrio runs bounded agent workflows made of three roles — a
planner, a coder, and a separate read-only reviewer — against a
local Ollama backend. It reports the workspace status, runs one
task through the trio behind a host-enforced verification gate,
and runs the workspace's configured checks. One binary serves a
command-line interface and a stdio MCP server with exactly three
tools.

Work is bounded by the operator config: model turns per role,
coder → verification → reviewer cycles, total tool calls, and
context size all have explicit budgets, and a run is only
`verified` when the gate below passes — never on the model's say
alone.

## Configuration

agenttrio reads an operator-reviewed TOML file. Passing `--config
<file>` explicitly approves loading that file; a workspace
`config.toml` or `.flow.toml` is **never** auto-loaded. The only
auto-loaded location is `$XDG_CONFIG_HOME/flow/config.toml`.

```toml
workspace_dir = "/absolute/path/to/workspace"

[ollama]
base_url = "http://127.0.0.1:11434"
model = "qwen2.5-coder:7b"
timeout = 120

[models]
planner = "qwen2.5-coder:7b"
coder = "qwen2.5-coder:7b"
reviewer = "qwen2.5-coder:7b"

[agent]
max_iterations = 6
max_cycles = 2
max_tool_calls = 64
max_context_chars = 100000

[checks.test]
cmd = ["npm", "test"]
timeout = 60000
required = true
kind = "test"
filetypes = ["ts"]
```

Notes that matter:

- Check `timeout` values are **milliseconds**; the Ollama
  `timeout` is seconds.
- `--workspace` overrides the config's workspace, and `--model`
  overrides every role's model.
- A non-loopback Ollama endpoint is refused unless the config sets
  `ollama.allow_remote = true`.
- Default mode is read-only. `run` and `check` require `--trusted`,
  which is what allows project edits and explicitly configured
  named checks.
- With no resolvable configuration, every command fails with an
  error naming the missing configuration — nothing is invented.
- Ollama itself is external: run `ollama serve` and pull a
  tool-capable model (for example `ollama pull qwen2.5-coder:7b`)
  before expecting runs to work.

## Install

```bash
npx @reneturcios/agenttrio status --config /path/to/operator.toml
```

Or run the container image:

```bash
docker run -i ghcr.io/cloudcorprecords/agenttrio
```

The container defaults to the MCP server (see below). Pass CLI
arguments to use it as a CLI instead; mount your config and
workspace into the container if you use it that way.

## CLI

```bash
agenttrio status --config operator.toml
agenttrio run "Fix the failing parser test" --config operator.toml --trusted
agenttrio check --config operator.toml --trusted
agenttrio check test --config operator.toml --trusted

agenttrio --version
```

Reports print as JSON. Exit codes follow the documented scheme:
`0` on success, `1` for a runtime failure (including an
unverifiable run configuration), and `2` for usage errors.
Arguments are validated before any configuration is read, so a
malformed invocation is always a usage error.

### The verification gate

A `run` is reported `verified: true` only when all of these hold:

- the planner and coder complete within their budgets;
- at least one required named check runs, and every required check
  passes;
- a separate read-only reviewer returns structured approval (a
  JSON object with `"approved": true`).

If the gate fails, the cycle repeats (coder → checks → reviewer)
up to `max_cycles`, and the final report says `verified: false`
with a `note` naming which condition failed.

## MCP server

One bin serves both faces. The `mcp` subcommand starts a stdio
MCP server (newline-delimited JSON-RPC):

```bash
npx -y @reneturcios/agenttrio mcp --config /path/to/operator.toml --trusted
```

MCP client configuration:

```json
{
  "mcpServers": {
    "agenttrio": {
      "command": "npx",
      "args": ["-y", "@reneturcios/agenttrio", "mcp", "--config", "/path/to/operator.toml", "--trusted"]
    }
  }
}
```

Replies carry the report as a JSON text block plus
`structuredContent`; failures are returned as `isError` results.
The server is deliberately sequential.

### Tools

The tool list is intentionally only these three tools.

| Tool | Input | What it returns |
| --- | --- | --- |
| `flow_status` | `{}` | The status report: workspace, Ollama reachability and available models, per-role models, agent budgets, and configured checks. |
| `flow_run` | `{"task": "..."}` | The run report: planner/coder output, check results, reviewer decision, cycles used, and the `verified` gate verdict. |
| `flow_check` | `{}` or `{"name": "configured-name"}` | The check report: every result for the checks that ran and whether they all passed. Omit `name` to run all configured checks. |

## Development

```bash
npm install
npm run build   # tsc -> dist/
npm test        # node test runner over test/*.test.ts, no network (fake executor/fetch/runner only)
npm run dev     # run the CLI from source via tsx
```

## License

MIT — see `LICENSE`.
