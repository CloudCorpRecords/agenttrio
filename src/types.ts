/**
 * agenttrio types.
 *
 * The runtime is configured by an operator-reviewed TOML file:
 * a workspace directory at the root, an [ollama] backend section,
 * optional per-role [models], [agent] budgets, and one
 * [checks.<name>] table per configured check. Everything that
 * touches the outside world — the model backend and the check
 * runner — is described here as an injectable dependency so the
 * core logic is testable with fakes and no network.
 */

/** Minimal HTTP response surface the Ollama client needs. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  statusText?: string;
  text(): Promise<string>;
}

/** Injectable fetch used for every Ollama HTTP call. */
export type FetchFn = (
  url: string,
  init?: {
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<HttpResponse>;

/** One configured workspace check, from a [checks.<name>] table. */
export interface CheckConfig {
  name: string;
  /** Exact argv array; no shell is involved in running it. */
  cmd: string[];
  /** Timeout in milliseconds, as documented for the config file. */
  timeoutMs: number;
  required: boolean;
  /** test / lint / typecheck / diagnostics / build / check. */
  kind: string;
  filetypes: string[];
}

/** The [ollama] section of the operator config. */
export interface OllamaConfig {
  baseUrl: string;
  model?: string;
  /** Request timeout in seconds. */
  timeoutSeconds: number;
  allowRemote: boolean;
}

/** Per-role model overrides from the [models] section. */
export interface RoleModels {
  planner?: string;
  coder?: string;
  reviewer?: string;
}

/** The [agent] budgets section. */
export interface AgentBudgets {
  maxIterations: number;
  maxCycles: number;
  maxToolCalls: number;
  maxContextChars: number;
}

/** A fully resolved operator configuration. */
export interface FlowConfig {
  workspaceDir?: string;
  ollama: OllamaConfig;
  models: RoleModels;
  agent: AgentBudgets;
  checks: CheckConfig[];
  /** True only when trusted mode was granted (--trusted). */
  trusted: boolean;
  /** Where the config came from, when it came from a file. */
  configPath?: string;
}

/** Result of running one configured check. */
export interface CheckResult {
  name: string;
  required: boolean;
  kind: string;
  passed: boolean;
  exitCode: number | null;
  /** Captured output, truncated; may be empty. */
  output: string;
}

/** Injectable runner for configured checks. */
export type CheckRunner = (
  check: CheckConfig,
  workspaceDir: string | undefined,
) => Promise<CheckResult>;

/**
 * Injectable model backend. The default implementation talks to a
 * local Ollama server over HTTP (see agenttrio.ts); tests inject a
 * fake that answers per role.
 */
export interface ModelExecutor {
  /** Return the model's text completion for one role invocation. */
  complete(role: "planner" | "coder" | "reviewer", model: string, prompt: string): Promise<string>;
  /** Probe whether the backend answers at all (used by flow_status). */
  probe(): Promise<{ reachable: boolean; models: string[]; detail?: string }>;
}

/** Options / injectable dependencies accepted by every core function. */
export interface FlowDeps {
  /** A pre-resolved config; wins over configPath / auto-discovery. */
  config?: FlowConfig;
  /** Explicitly approved operator config file (--config). */
  configPath?: string;
  /** Workspace override (--workspace); wins over the config file. */
  workspaceDir?: string;
  /** Model override (--model); applies to every role. */
  modelOverride?: string;
  /** Trusted mode (--trusted): allows edits and configured checks. */
  trusted?: boolean;
  /** Injectable model backend; defaults to the Ollama executor. */
  executor?: ModelExecutor;
  /** Injectable fetch used to build the default Ollama executor. */
  fetchFn?: FetchFn;
  /** Injectable check runner; defaults to a real argv runner. */
  checkRunner?: CheckRunner;
  /** Injectable file reader for config loading (tests). */
  readTextFile?: (path: string) => Promise<string>;
  /** Injectable existence probe for the auto-discovered config. */
  fileExists?: (path: string) => Promise<boolean>;
  /** Environment override for tests (XDG_CONFIG_HOME / HOME). */
  env?: Record<string, string | undefined>;
}

/** Report returned by flow_status / `agenttrio status`. */
export interface FlowStatusReport {
  workspaceDir: string | null;
  configPath: string | null;
  trusted: boolean;
  ollama: {
    baseUrl: string;
    model: string | null;
    reachable: boolean;
    availableModels: string[];
    detail?: string;
  };
  models: { planner: string | null; coder: string | null; reviewer: string | null };
  agent: AgentBudgets;
  checks: { name: string; required: boolean; kind: string }[];
}

/** Report returned by flow_check / `agenttrio check`. */
export interface FlowCheckReport {
  workspaceDir: string | null;
  /** The single check name requested, or null when all were run. */
  requested: string | null;
  results: CheckResult[];
  /** True when every check that ran passed. */
  passed: boolean;
}

/** Report returned by flow_run / `agenttrio run`. */
export interface FlowRunReport {
  task: string;
  workspaceDir: string | null;
  models: { planner: string | null; coder: string | null; reviewer: string | null };
  plannerOutput: string;
  coderOutput: string;
  checks: CheckResult[];
  reviewer: { approved: boolean; raw: string };
  cyclesUsed: number;
  /** The verification-gate verdict; see the gate rules in agenttrio.ts. */
  verified: boolean;
  /** Present when the run completed but the gate did not verify it. */
  note?: string;
}
