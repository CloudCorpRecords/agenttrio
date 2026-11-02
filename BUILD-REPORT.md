# agenttrio — Build Report

MCP Rebuild 1000 (Batch 9). Clean-room rebuild of
qompassai/phlow (rank 515, 0★, Tier A), built from the spec in
`specs-batch9/phlow.md`, whose parameter source is the original
README's "MCP wire contract" section — the argument shapes are
exact documented JSON. Fixture:
`harness/fixtures/phlow-tools-original.json`, `_source` labelled
"docs-derived from specs-batch9/phlow.md (README wire contract
read firsthand 2026-10-27); full documented set of 3". No original
server was probed and no original code was looked at. Local build
only — nothing pushed or published.

Identity: repo `agenttrio`, npm `@reneturcios/agenttrio`,
MCP name `io.github.CloudCorpRecords/agenttrio`, version `0.1.0`,
bin `agenttrio` → `dist/cli.js`.

## Files created (19/19 per TEMPLATE.md checklist)

- `package.json` — bin `agenttrio: dist/cli.js`, `mcpName` set,
  scripts build=`tsc` / dev=`tsx src/cli.ts` / test=`tsx --test test/*.test.ts`
- `server.json` — description "Bounded planner-coder-reviewer
  workflows: status, verified run, and configured checks." =
  **86 chars** (≤100 ✓); npm entry carries `version: 0.1.0`; OCI
  entry `ghcr.io/cloudcorprecords/agenttrio:0.1.0` carries **no**
  `version` field (verified programmatically)
- `Dockerfile` — node:20-alpine two-stage, ENTRYPOINT
  `node /app/dist/cli.js`, CMD `mcp`, label
  `io.modelcontextprotocol.server.name="io.github.CloudCorpRecords/agenttrio"`
- `tsconfig.json` (identical to the fleet template), `.gitignore`,
  `LICENSE` (MIT, Copyright (c) 2026 Rene Turcios), `README.md`
  (fresh text), `CHANGELOG.md` (single 0.1.0 entry, 2026-10-27)
- `src/index.ts`, `src/cli.ts` (`status`, `run`, `check`, `mcp`,
  `--version`; exit 2 usage / 1 runtime), `src/mcp.ts`,
  `src/types.ts`, `src/agenttrio.ts` (core logic, `VERSION = "0.1.0"`)
- `test/agenttrio.test.ts`
- `.github/workflows/{ci,publish,publish-container,registry-publish}.yml`
  (from the fleet template; image name and smoke-test server name
  changed to agenttrio)

## Tools implemented (3)

The full documented set — the README states the tool list is
intentionally only these three:

- `flow_status` — arguments `{}`. Report: workspaceDir, configPath,
  trusted, Ollama baseUrl/model/reachability/available models,
  per-role models, agent budgets, configured checks.
- `flow_run` — arguments `{"task": "..."}` (task: required string).
  Bounded planner → coder → checks → reviewer cycles behind the
  verification gate (below).
- `flow_check` — arguments `{}` or `{"name": "configured-name"}`.
  Runs all configured checks, or one named check; an unknown name
  is an error listing the configured names.

Successful MCP replies carry the report as a JSON text block plus
`structuredContent`, and failures are `isError` results, matching
the documented wire contract.

## Implementation notes

- `src/mcp.ts` uses the SDK's low-level `Server`
  (`sdk/server/index.js` + `StdioServerTransport`) with explicit
  inputSchema literals exactly matching the fixture — per the
  standing fleet rule: `McpServer`'s zod-to-JSON-Schema conversion
  injects `$schema` / `additionalProperties` keys absent from the
  defined spec. Zod still validates every `tools/call`.
- **Configuration** is the spec's operator-reviewed TOML model,
  parsed by a minimal TOML reader covering exactly the documented
  subset (root `workspace_dir`; `[ollama]`, `[models]`, `[agent]`,
  `[checks.<name>]`; string/number/bool/string-array values;
  dotted root keys such as `ollama.allow_remote`). `--config`
  explicitly approves a file; a workspace `config.toml` /
  `.flow.toml` is never auto-loaded; only
  `$XDG_CONFIG_HOME/flow/config.toml` auto-loads. `--workspace`
  overrides the workspace, `--model` overrides every role.
  Non-loopback Ollama endpoints are refused unless
  `ollama.allow_remote=true`. **Missing configuration is an honest
  error naming it, raised before any model or check call** (tests
  assert the injected executor is never touched in that case).
- **Trusted gate (documented local interpretation):** the spec
  says default mode is read-only and `--trusted` allows project
  edits and explicitly configured named checks; this rebuild
  therefore requires trusted mode for `flow_run` and `flow_check`,
  while `flow_status` works read-only.
- **Injectable dependencies:** the model backend is a
  `ModelExecutor` (default: Ollama over an injectable `FetchFn`,
  POST `/api/chat` and GET `/api/tags` on the configured
  base_url); checks run through an injectable `CheckRunner`
  (default: real argv execution via `execFile`, no shell, the
  config's millisecond timeout, 256 KiB output cap). Tests use
  fake executor / fetch / runner only — no live network, no live
  Ollama, no live claims.
- **Verification gate (documented local interpretation):** a run
  is `verified: true` only when the planner and coder complete,
  at least one required named check runs and every required check
  passes, and the separate read-only reviewer returns structured
  approval (its answer parses as JSON with `"approved": true`, or
  `"verdict": "approve"`). Cycles repeat up to `max_cycles`; an
  unverified completed run returns `verified: false` with a
  `note` naming the failed condition(s) — it is not an error.
- Role model resolution: `--model` wins, then `[models] <role>`,
  then `[ollama] model`; a role with no model at all is a config
  error naming the role, before any model call. Prompts are
  truncated to `max_context_chars`.

## Verification (foreground, exact outputs)

### 1. Typecheck and build
```
$ ./node_modules/.bin/tsc --noEmit ; echo exit=$?
exit=0
$ npm run build   # tsc -> dist/, including dist/cli.js
exit=0
```

### 2. Tests
```
$ npm test   # tsx --test test/*.test.ts
ℹ tests 26
ℹ pass 26
ℹ fail 0
```
Covers: full documented TOML shape (checks sorted, ms timeouts,
per-role models) and documented defaults; malformed TOML →
ConfigError; model-resolution precedence; missing config failing
`flow_status` before any executor call, an explicit missing
`--config` path named in the error, XDG-only auto-load,
non-loopback refusal without `allow_remote`, and the dotted
`ollama.allow_remote` root key; status report contents plus an
unreachable backend reported (not hidden) and the `/api/tags`
probe through a fake fetch; `flow_check` trusted gating (runner
untouched when untrusted), all/named selection, unknown-name
error; reviewer-approval parsing (plain JSON, code-fenced JSON,
verdict form, prose → no approval); `flow_run` verified happy
path (role order planner/coder/reviewer with resolved models,
cyclesUsed 1), failing required check → unverified with retry to
max_cycles, no-required-check → unverified, reviewer withholding
approval → unverified, trusted/model gating before any model
call; the Ollama executor over fake fetch (`/api/chat` body
shape, HTTP 404 surfaced, probe false); and the real
`nodeCheckRunner` on `node -e` argv (exit 0 passes, exit 3 fails
with exitCode 3, empty cmd fails honestly).

### 3. CLI / MCP smoke
`--version` → `0.1.0` (exit 0); no args, unknown command, and
`run` with no task print Usage and exit 2 (validation before any
config read). `status` with no resolvable config exits 1 with
"Missing configuration: no operator config file was provided…".
MCP `initialize` over stdio →
`serverInfo: {"name":"agenttrio","version":"0.1.0"}`; a stdio
`tools/call` for `flow_status` with a smoke config whose Ollama
base_url pointed at a closed local port returned
`reachable: false` with the connection detail (no live Ollama
exists in this VM and none is claimed); `flow_run` with `{}`
returned isError from zod validation (`task` required) before any
config work. CLI `check --config <smoke> --trusted` ran the
configured `node -e` check and passed (exit 0); the same command
without `--trusted` exited 1 naming the trusted requirement.

### 4. Parity (harness)
```
$ python3 ~/workspace/mcp-rebuild-100/harness/parity.py \
    --original ~/workspace/mcp-rebuild-100/harness/fixtures/phlow-tools-original.json \
    --rebuild "stdio:node <abs path>/builds/agenttrio/dist/cli.js mcp" \
    --out ~/workspace/mcp-rebuild-100/builds/agenttrio/parity-out
verdict=PASS parity_pct=100.0 original_tools=3 rebuild_tools=3 missing=[] extra=[] schema_diffs=[]
(exit 0)
```
(parity.json: identical verdict PASS at 100.0.) Original side is
tools-file mode, so `fixture_results` records
`SKIPPED-TOOLS-FILE-MODE` — expected harness semantics, not an
error.

## Lockfile status

`package-lock.json` was generated clean via Route 3: a temp copy
holding only `package.json` (no `node_modules`, no `dist`),
offline `npm install --package-lock-only --ignore-scripts
--offline`, verified after generation — parses as JSON, top-level
`name` is `@reneturcios/agenttrio`, version `0.1.0`,
**128 package entries** — then only the lockfile was copied back.
Local `node_modules` is a symlink to the sibling burnmeter build's
`node_modules`, used only for the local build/test; it is
gitignored and not part of the lockfile generation.

## Spec ambiguities resolved (documented local interpretations)

- **Tool descriptions:** the README gives no per-tool description
  strings, only an argument table; the spec's descriptions are
  marked paraphrases. This rebuild's three descriptions are fresh
  prose written from those paraphrases and are used identically
  in `src/mcp.ts` and the fixture.
- **Gate conditions not observable here:** the spec's gate also
  requires per-changed-file static analysis and unchanged/clean
  buffers during verification, tied to the original's editor
  integration. This rebuild's coder produces a textual result and
  edits no files, so those two conditions cannot be observed; the
  gate implements the observable subset (completion, required
  checks, structured reviewer approval) and says so in the core
  docstring. The Neovim/Rose editor bridge (`--nvim`, editor_*
  schemas) is an optional integration of the original and is not
  reimplemented; no tool surface depends on it.
- **Ollama wire routes:** the spec documents Ollama as the
  backend but no HTTP route shapes; the executor uses Ollama's
  standard local routes (`/api/chat`, `/api/tags`).
- **[agent] budget defaults:** the spec gives the budget values
  as examples (6 / 2 / 64 / 100000); they are used as the defaults
  when a config omits them.
- **Trusted gating of flow_check:** read from the spec's
  read-only-by-default / `--trusted` wording, as described above.
- **CLI shape:** the spec documents `flow status/run/check`-style
  CLI use with exit codes 0/1/2; the rebuild's subcommands are
  `status`, `run <task>`, and `check [name]`, with the `mcp`
  server taking the documented serve-style options
  (`--config`, `--workspace`, `--model`, `--trusted`).

## Gaps / honest notes

- Docs-derived spec: parity proves the rebuild matches this
  program's defined spec (tool names + exact documented input
  schemas), not a hand-probed original server. Report shapes are
  this rebuild's documented local interpretations.
- No live Ollama run was performed or claimed; behaviour is
  proven on fake executor/fetch/runner fixtures and one local
  real-argv check (`node -e`), plus a closed-port probe that
  honestly reported the backend unreachable.
- Container build not exercised locally; the publish-container
  workflow smoke-tests the image at publish time.
