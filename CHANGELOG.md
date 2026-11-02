# Changelog

## 0.1.0 (2026-10-27)

- Initial release.
- CLI: `agenttrio status`, `agenttrio run <task>`,
  `agenttrio check [name]`, and `agenttrio mcp` (all accept
  `--config <file>`, `--workspace <path>`, `--model <name>`, and
  `--trusted`).
- MCP server (`agenttrio mcp`, stdio) with exactly three tools:
  `flow_status`, `flow_run`, and `flow_check`, using the argument
  shapes documented for the original tool.
- Operator configuration is read from an explicitly approved TOML
  file (`--config`); a workspace `config.toml` / `.flow.toml` is
  never auto-loaded. Only `$XDG_CONFIG_HOME/flow/config.toml`
  loads automatically, as documented.
- `flow_run` drives a bounded planner → coder → reviewer workflow
  against a local Ollama backend (default
  `http://127.0.0.1:11434`), then applies the verification gate: a
  run is `verified` only when the planner and coder complete, at
  least one required configured check runs and every required
  check passes, and a separate read-only reviewer returns
  structured approval.
- `flow_check` runs the workspace's configured checks (all of
  them, or one named check) through an injectable check runner.
- The model backend and the check runner sit behind injectable
  dependencies, so the test suite runs entirely on fakes with no
  network and no live Ollama server.
