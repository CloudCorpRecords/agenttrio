/**
 * agenttrio core: bounded planner -> coder -> reviewer workflows.
 *
 *   flow_status  workspace/flow status report
 *   flow_run     run one task through planner -> coder -> checks ->
 *                reviewer, behind a host-enforced verification gate
 *   flow_check   run the workspace's configured checks (all, or one
 *                named check) and report the results
 *
 * Configuration (operator-reviewed TOML, per the documented spec):
 * - `--config FILE` explicitly approves loading that operator file.
 *   A workspace `config.toml` / `.flow.toml` is NEVER auto-loaded;
 *   only `$XDG_CONFIG_HOME/flow/config.toml` loads automatically.
 * - Root key `workspace_dir`; sections [ollama] (base_url default
 *   http://127.0.0.1:11434, model, timeout in seconds),
 *   [models] (planner / coder / reviewer), [agent] (max_iterations,
 *   max_cycles, max_tool_calls, max_context_chars), and
 *   [checks.<name>] (cmd argv array, timeout in MILLISECONDS,
 *   required, kind, filetypes).
 * - Default mode is read-only; trusted mode (--trusted) allows
 *   project edits and explicitly configured named checks, so
 *   flow_run and flow_check require it.
 * - A non-loopback Ollama endpoint requires ollama.allow_remote.
 * - If no configuration can be resolved at all, every tool fails
 *   with an error naming the missing configuration BEFORE any
 *   model or check call is made — nothing is fabricated.
 *
 * Verification gate for flow_run (documented local interpretation
 * of the spec's gate, narrowed to what this rebuild can observe):
 * a run is `verified: true` only when the planner and coder
 * complete within budgets, at least one required named check runs
 * and every required check passes, and a separate read-only
 * reviewer returns structured approval (a JSON object with
 * "approved": true in its answer). The spec's remaining gate
 * conditions — per-file static analysis of changed files and
 * buffer cleanliness during verification — are not observable
 * here because this rebuild's coder produces a textual result and
 * edits no files; that gap is recorded in BUILD-REPORT.md.
 *
 * Documented local interpretations:
 * - The [agent] budget defaults use the spec's example values
 *   (6 / 2 / 64 / 100000) when a config omits them.
 * - Role model resolution: --model override wins, then the
 *   [models] role entry, then [ollama] model.
 * - The Ollama wire calls are POST /api/chat and GET /api/tags on
 *   the configured base_url (Ollama's standard local HTTP API);
 *   the spec documents Ollama as the backend but no route shapes.
 * - Prompts are truncated to max_context_chars before each call,
 *   and the coder/reviewer cycle repeats up to max_cycles times
 *   until the gate verifies or the budget is exhausted.
 *
 * All external access sits behind injectable dependencies
 * (ModelExecutor / FetchFn / CheckRunner in types.ts); tests use
 * fakes only — no network, no live Ollama, no real check commands.
 */
import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  CheckConfig,
  CheckResult,
  CheckRunner,
  FetchFn,
  FlowCheckReport,
  FlowConfig,
  FlowDeps,
  FlowRunReport,
  FlowStatusReport,
  ModelExecutor,
} from "./types.js";

export const VERSION = "0.1.0";

export const DEFAULT_OLLAMA_BASE_URL = "http://127.0.0.1:11434";
export const DEFAULT_OLLAMA_TIMEOUT_SECONDS = 120;

/** Error raised for missing or invalid operator configuration. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

// ---------------------------------------------------------------------------
// Minimal TOML reader for the documented config subset
// ---------------------------------------------------------------------------

type TomlValue = string | number | boolean | string[];

function stripComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === "#" && !inDouble && !inSingle) return line.slice(0, i);
  }
  return line;
}

function parseTomlValue(raw: string, source: string): TomlValue {
  const value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return inner
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const parsed = parseTomlValue(part, source);
        if (typeof parsed !== "string") {
          throw new ConfigError(`Invalid config in ${source}: array entries must be strings, got "${part}"`);
        }
        return parsed;
      });
  }
  if (
    (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
    (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
  ) {
    return value.slice(1, -1);
  }
  if (value === "true") return true;
  if (value === "false") return false;
  if (/^-?\d+(\.\d+)?$/.test(value)) return Number(value);
  throw new ConfigError(`Invalid config in ${source}: unsupported value "${value}"`);
}

/** Parse the documented TOML subset into a flat section map. */
export function parseToml(text: string, source = "<config>"): Record<string, Record<string, TomlValue>> {
  const sections: Record<string, Record<string, TomlValue>> = { "": {} };
  let current = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      current = sectionMatch[1].trim();
      sections[current] ??= {};
      continue;
    }
    const eq = line.indexOf("=");
    if (eq < 0) {
      throw new ConfigError(`Invalid config in ${source}: expected "key = value", got "${line}"`);
    }
    const key = line.slice(0, eq).trim();
    const value = parseTomlValue(line.slice(eq + 1), source);
    // A dotted key at the root (e.g. ollama.allow_remote) belongs to
    // the named section; inside a section it stays a literal key.
    if (current === "" && key.includes(".")) {
      const dot = key.indexOf(".");
      const section = key.slice(0, dot);
      sections[section] ??= {};
      sections[section][key.slice(dot + 1)] = value;
    } else {
      sections[current][key] = value;
    }
  }
  return sections;
}

function asString(value: TomlValue | undefined): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function asNumber(value: TomlValue | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function asBool(value: TomlValue | undefined, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function asStringArray(value: TomlValue | undefined): string[] {
  return Array.isArray(value) ? value.filter((v) => typeof v === "string") : [];
}

/** Build a FlowConfig from parsed TOML sections. */
export function configFromToml(
  sections: Record<string, Record<string, TomlValue>>,
  source: string,
): FlowConfig {
  const root = sections[""] ?? {};
  const ollama = sections["ollama"] ?? {};
  const models = sections["models"] ?? {};
  const agent = sections["agent"] ?? {};
  const checks: CheckConfig[] = [];
  for (const [section, values] of Object.entries(sections)) {
    if (!section.startsWith("checks.")) continue;
    const name = section.slice("checks.".length);
    checks.push({
      name,
      cmd: asStringArray(values["cmd"]),
      timeoutMs: asNumber(values["timeout"], 60_000),
      required: asBool(values["required"], false),
      kind: asString(values["kind"]) ?? "check",
      filetypes: asStringArray(values["filetypes"]),
    });
  }
  checks.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    workspaceDir: asString(root["workspace_dir"]),
    ollama: {
      baseUrl: (asString(ollama["base_url"]) ?? DEFAULT_OLLAMA_BASE_URL).replace(/\/+$/, ""),
      model: asString(ollama["model"]),
      timeoutSeconds: asNumber(ollama["timeout"], DEFAULT_OLLAMA_TIMEOUT_SECONDS),
      allowRemote: asBool(ollama["allow_remote"], false),
    },
    models: {
      planner: asString(models["planner"]),
      coder: asString(models["coder"]),
      reviewer: asString(models["reviewer"]),
    },
    agent: {
      maxIterations: asNumber(agent["max_iterations"], 6),
      maxCycles: asNumber(agent["max_cycles"], 2),
      maxToolCalls: asNumber(agent["max_tool_calls"], 64),
      maxContextChars: asNumber(agent["max_context_chars"], 100_000),
    },
    checks,
    trusted: false,
    configPath: source,
  };
}

// ---------------------------------------------------------------------------
// Config resolution
// ---------------------------------------------------------------------------

/** The one auto-discovered config path: $XDG_CONFIG_HOME/flow/config.toml. */
export function autoConfigPath(env: Record<string, string | undefined>): string {
  const xdg = typeof env.XDG_CONFIG_HOME === "string" ? env.XDG_CONFIG_HOME.trim() : "";
  const base = xdg || join(typeof env.HOME === "string" && env.HOME ? env.HOME : homedir(), ".config");
  return join(base, "flow", "config.toml");
}

function isLoopback(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "127.0.0.1" || host === "localhost" || host === "::1" || host === "[::1]";
  } catch {
    return false;
  }
}

function applyOverrides(config: FlowConfig, deps: FlowDeps): FlowConfig {
  const out: FlowConfig = {
    ...config,
    ollama: { ...config.ollama },
    models: { ...config.models },
    agent: { ...config.agent },
    checks: config.checks.map((c) => ({ ...c })),
  };
  if (deps.workspaceDir && deps.workspaceDir.trim()) out.workspaceDir = deps.workspaceDir.trim();
  if (deps.trusted !== undefined) out.trusted = deps.trusted;
  if (!isLoopback(out.ollama.baseUrl) && !out.ollama.allowRemote) {
    throw new ConfigError(
      `Invalid configuration: Ollama endpoint ${out.ollama.baseUrl} is not loopback; ` +
        `non-loopback endpoints require ollama.allow_remote=true in the operator config.`,
    );
  }
  return out;
}

/**
 * Resolve the operator configuration. A pre-resolved config in deps
 * wins; then an explicitly approved --config file; then the one
 * auto-discovered XDG path. When none exists, throws a ConfigError
 * naming the missing configuration — before any external call.
 */
export async function resolveConfig(deps: FlowDeps = {}): Promise<FlowConfig> {
  if (deps.config) return applyOverrides(deps.config, deps);
  const read = deps.readTextFile ?? ((path: string) => readFile(path, "utf8"));
  const exists =
    deps.fileExists ??
    (async (path: string) => {
      try {
        await access(path);
        return true;
      } catch {
        return false;
      }
    });
  const env = deps.env ?? process.env;
  let path: string | undefined;
  if (deps.configPath && deps.configPath.trim()) {
    path = deps.configPath.trim();
    if (!(await exists(path))) {
      throw new ConfigError(
        `Missing configuration: the operator config file given via --config was not found: ${path}`,
      );
    }
  } else {
    const auto = autoConfigPath(env);
    if (await exists(auto)) path = auto;
  }
  if (!path) {
    throw new ConfigError(
      "Missing configuration: no operator config file was provided. " +
        "Pass --config <file> to approve an operator TOML file, or place one at " +
        "$XDG_CONFIG_HOME/flow/config.toml (the only auto-loaded location). " +
        "A workspace config.toml / .flow.toml is never auto-loaded.",
    );
  }
  let text: string;
  try {
    text = await read(path);
  } catch (err) {
    throw new ConfigError(
      `Missing configuration: could not read the operator config file ${path}: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return applyOverrides(configFromToml(parseToml(text, path), path), deps);
}

/** Resolve the model for one role: --model, then [models], then [ollama] model. */
export function resolveModel(
  config: FlowConfig,
  role: "planner" | "coder" | "reviewer",
  override?: string,
): string | null {
  if (override && override.trim()) return override.trim();
  return config.models[role] ?? config.ollama.model ?? null;
}

function requireModel(config: FlowConfig, role: "planner" | "coder" | "reviewer", override?: string): string {
  const model = resolveModel(config, role, override);
  if (!model) {
    throw new ConfigError(
      `Missing configuration: no model configured for the ${role} role. ` +
        `Set [ollama] model or [models] ${role} in the operator config, or pass --model.`,
    );
  }
  return model;
}

function requireTrusted(config: FlowConfig, tool: string): void {
  if (!config.trusted) {
    throw new ConfigError(
      `Configuration error: ${tool} requires trusted mode. Default mode is read-only; ` +
        `trusted mode (--trusted) allows project edits and explicitly configured named checks.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Default Ollama model executor (injectable fetch)
// ---------------------------------------------------------------------------

const defaultFetch: FetchFn = async (url, init) => {
  const res = await fetch(url, init);
  return { ok: res.ok, status: res.status, statusText: res.statusText, text: () => res.text() };
};

/** Build the default Ollama-backed ModelExecutor over an injected fetch. */
export function ollamaExecutor(config: FlowConfig, fetchFn: FetchFn = defaultFetch): ModelExecutor {
  const base = config.ollama.baseUrl;
  async function call(path: string, method: string, body?: Record<string, unknown>): Promise<unknown> {
    let response;
    try {
      response = await fetchFn(`${base}${path}`, {
        method,
        headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch (err) {
      throw new Error(
        `Failed to reach Ollama at ${base}${path}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    const text = await response.text();
    if (!response.ok) {
      const detail = text.trim().slice(0, 300);
      throw new Error(`Ollama request failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  return {
    async complete(role, model, prompt) {
      const data = (await call("/api/chat", "POST", {
        model,
        messages: [{ role: "user", content: prompt }],
        stream: false,
      })) as Record<string, unknown> | string;
      if (typeof data === "string") return data;
      const message = data?.message as Record<string, unknown> | undefined;
      if (message && typeof message.content === "string") return message.content;
      if (typeof data?.response === "string") return data.response;
      throw new Error(`Ollama chat response for the ${role} role carried no message content.`);
    },
    async probe() {
      try {
        const data = (await call("/api/tags", "GET")) as Record<string, unknown> | string;
        const models: string[] = [];
        if (typeof data === "object" && data !== null && Array.isArray(data.models)) {
          for (const entry of data.models as Record<string, unknown>[]) {
            if (entry && typeof entry.name === "string") models.push(entry.name);
          }
        }
        return { reachable: true, models };
      } catch (err) {
        return {
          reachable: false,
          models: [],
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };
}

function executorFor(config: FlowConfig, deps: FlowDeps): ModelExecutor {
  return deps.executor ?? ollamaExecutor(config, deps.fetchFn ?? defaultFetch);
}

// ---------------------------------------------------------------------------
// Default check runner (real argv execution; tests inject a fake)
// ---------------------------------------------------------------------------

/** Run one check's exact argv array with its millisecond timeout; no shell. */
export const nodeCheckRunner: CheckRunner = (check, workspaceDir) =>
  new Promise<CheckResult>((resolvePromise) => {
    if (check.cmd.length === 0) {
      resolvePromise({
        name: check.name,
        required: check.required,
        kind: check.kind,
        passed: false,
        exitCode: null,
        output: "check has an empty cmd array in the operator config",
      });
      return;
    }
    execFile(
      check.cmd[0],
      check.cmd.slice(1),
      { cwd: workspaceDir, timeout: check.timeoutMs, maxBuffer: 256 * 1024 },
      (err, stdout, stderr) => {
        const output = `${stdout ?? ""}${stderr ?? ""}`.slice(0, 8000);
        if (!err) {
          resolvePromise({
            name: check.name,
            required: check.required,
            kind: check.kind,
            passed: true,
            exitCode: 0,
            output,
          });
          return;
        }
        const code = typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code as number) : null;
        resolvePromise({
          name: check.name,
          required: check.required,
          kind: check.kind,
          passed: false,
          exitCode: code,
          output: output || err.message,
        });
      },
    );
  });

async function runChecks(
  config: FlowConfig,
  deps: FlowDeps,
  selected: CheckConfig[],
): Promise<CheckResult[]> {
  const runner = deps.checkRunner ?? nodeCheckRunner;
  const results: CheckResult[] = [];
  // The runtime is deliberately sequential: checks run one at a time.
  for (const check of selected) {
    results.push(await runner(check, config.workspaceDir));
  }
  return results;
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

/** flow_status: report the workspace/flow status. Read-only; no trusted mode needed. */
export async function flowStatus(deps: FlowDeps = {}): Promise<FlowStatusReport> {
  const config = await resolveConfig(deps);
  const executor = executorFor(config, deps);
  const probe = await executor.probe();
  const report: FlowStatusReport = {
    workspaceDir: config.workspaceDir ?? null,
    configPath: config.configPath ?? null,
    trusted: config.trusted,
    ollama: {
      baseUrl: config.ollama.baseUrl,
      model: config.ollama.model ?? null,
      reachable: probe.reachable,
      availableModels: probe.models,
    },
    models: {
      planner: resolveModel(config, "planner", deps.modelOverride),
      coder: resolveModel(config, "coder", deps.modelOverride),
      reviewer: resolveModel(config, "reviewer", deps.modelOverride),
    },
    agent: config.agent,
    checks: config.checks.map((c) => ({ name: c.name, required: c.required, kind: c.kind })),
  };
  if (!probe.reachable && probe.detail) report.ollama.detail = probe.detail;
  return report;
}

/** flow_check: run all configured checks, or one named check. Requires trusted mode. */
export async function flowCheck(name?: string, deps: FlowDeps = {}): Promise<FlowCheckReport> {
  const config = await resolveConfig(deps);
  requireTrusted(config, "flow_check");
  let selected = config.checks;
  const requested = typeof name === "string" && name.trim() ? name.trim() : null;
  if (requested) {
    const found = config.checks.find((c) => c.name === requested);
    if (!found) {
      const known = config.checks.map((c) => c.name).join(", ") || "(none configured)";
      throw new Error(`Unknown check "${requested}": the operator config defines: ${known}`);
    }
    selected = [found];
  }
  const results = await runChecks(config, deps, selected);
  return {
    workspaceDir: config.workspaceDir ?? null,
    requested,
    results,
    passed: results.every((r) => r.passed),
  };
}

function truncate(text: string, maxChars: number): string {
  return text.length > maxChars ? text.slice(0, maxChars) : text;
}

/** Parse a reviewer's structured approval out of its raw answer. */
export function parseReviewerApproval(raw: string): boolean {
  const trimmed = raw.trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") {
      if (parsed.approved === true) return true;
      if (typeof parsed.verdict === "string" && parsed.verdict.toLowerCase() === "approve") return true;
    }
  } catch {
    // Not structured JSON: no approval can be read from it.
  }
  return false;
}

/** flow_run: bounded planner -> coder -> checks -> reviewer, behind the verification gate. */
export async function flowRun(task: string, deps: FlowDeps = {}): Promise<FlowRunReport> {
  const config = await resolveConfig(deps);
  requireTrusted(config, "flow_run");
  const executor = executorFor(config, deps);
  const plannerModel = requireModel(config, "planner", deps.modelOverride);
  const coderModel = requireModel(config, "coder", deps.modelOverride);
  const reviewerModel = requireModel(config, "reviewer", deps.modelOverride);
  const maxChars = config.agent.maxContextChars;

  const plannerOutput = await executor.complete(
    "planner",
    plannerModel,
    truncate(
      `You are the planner in a bounded planner-coder-reviewer workflow. ` +
        `Plan the following task in at most ${config.agent.maxIterations} steps. Task: ${task}`,
      maxChars,
    ),
  );

  let coderOutput = "";
  let checks: CheckResult[] = [];
  let reviewerRaw = "";
  let reviewerApproved = false;
  let cyclesUsed = 0;
  const maxCycles = Math.max(1, config.agent.maxCycles);
  for (let cycle = 1; cycle <= maxCycles; cycle++) {
    cyclesUsed = cycle;
    coderOutput = await executor.complete(
      "coder",
      coderModel,
      truncate(
        `You are the coder in a bounded planner-coder-reviewer workflow. ` +
          `Carry out this task following the plan. Task: ${task}\nPlan:\n${plannerOutput}` +
          (cycle > 1
            ? `\nThe previous attempt was not verified. Reviewer said:\n${reviewerRaw}\nCheck results:\n${JSON.stringify(checks)}`
            : ""),
        maxChars,
      ),
    );
    checks = await runChecks(config, deps, config.checks);
    reviewerRaw = await executor.complete(
      "reviewer",
      reviewerModel,
      truncate(
        `You are a separate read-only reviewer. Review the coder's result for the task ` +
          `"${task}". The plan was:\n${plannerOutput}\nThe coder produced:\n${coderOutput}\n` +
          `Configured check results:\n${JSON.stringify(checks)}\n` +
          `Answer with a single JSON object: {"approved": true} or {"approved": false, "reason": "..."}.`,
        maxChars,
      ),
    );
    reviewerApproved = parseReviewerApproval(reviewerRaw);
    const required = checks.filter((c) => c.required);
    const gateOk = required.length >= 1 && required.every((c) => c.passed) && reviewerApproved;
    if (gateOk) break;
  }

  const required = checks.filter((c) => c.required);
  const verified = required.length >= 1 && required.every((c) => c.passed) && reviewerApproved;
  const report: FlowRunReport = {
    task,
    workspaceDir: config.workspaceDir ?? null,
    models: { planner: plannerModel, coder: coderModel, reviewer: reviewerModel },
    plannerOutput,
    coderOutput,
    checks,
    reviewer: { approved: reviewerApproved, raw: reviewerRaw },
    cyclesUsed,
    verified,
  };
  if (!verified) {
    const reasons: string[] = [];
    if (required.length === 0) reasons.push("no required check ran");
    else if (!required.every((c) => c.passed)) reasons.push("not every required check passed");
    if (!reviewerApproved) reasons.push("the reviewer did not return structured approval");
    report.note = `Run completed but is not verified: ${reasons.join("; ")}.`;
  }
  return report;
}

/** Render a payload as the JSON text block MCP clients show. */
export function formatPayload(payload: unknown): string {
  return typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}
