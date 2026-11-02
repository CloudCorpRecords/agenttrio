import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  ConfigError,
  configFromToml,
  flowCheck,
  flowRun,
  flowStatus,
  ollamaExecutor,
  parseReviewerApproval,
  parseToml,
  resolveModel,
  nodeCheckRunner,
} from "../src/agenttrio.js";
import type {
  CheckConfig,
  CheckResult,
  FetchFn,
  FlowConfig,
  HttpResponse,
  ModelExecutor,
} from "../src/types.js";

const TOML = `
workspace_dir = "/work/proj"

[ollama]
base_url = "http://127.0.0.1:11434"
model = "qwen2.5-coder:7b"
timeout = 120

[models]
planner = "plan-model"
reviewer = "review-model"

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

[checks.lint]
cmd = ["npm", "run", "lint"]
timeout = 30000
required = false
kind = "lint"
filetypes = ["*"]
`;

function baseConfig(overrides: Partial<FlowConfig> = {}): FlowConfig {
  return {
    workspaceDir: "/work/proj",
    ollama: { baseUrl: "http://127.0.0.1:11434", model: "base-model", timeoutSeconds: 120, allowRemote: false },
    models: { planner: "plan-model", coder: "code-model", reviewer: "review-model" },
    agent: { maxIterations: 6, maxCycles: 2, maxToolCalls: 64, maxContextChars: 100000 },
    checks: [
      { name: "lint", cmd: ["npm", "run", "lint"], timeoutMs: 30000, required: false, kind: "lint", filetypes: ["*"] },
      { name: "test", cmd: ["npm", "test"], timeoutMs: 60000, required: true, kind: "test", filetypes: ["ts"] },
    ],
    trusted: true,
    configPath: "/cfg/operator.toml",
    ...overrides,
  };
}

interface FakeExecutor extends ModelExecutor {
  calls: { role: string; model: string }[];
  probes: number;
}

function fakeExecutor(
  answers: Partial<Record<"planner" | "coder" | "reviewer", string>> = {},
  probeResult: { reachable: boolean; models: string[]; detail?: string } = { reachable: true, models: ["base-model"] },
): FakeExecutor {
  const exec: FakeExecutor = {
    calls: [],
    probes: 0,
    async complete(role, model) {
      exec.calls.push({ role, model });
      return answers[role] ?? `${role}-output`;
    },
    async probe() {
      exec.probes += 1;
      return probeResult;
    },
  };
  return exec;
}

function fakeRunner(results: Record<string, boolean>) {
  const seen: string[] = [];
  const runner = async (check: CheckConfig): Promise<CheckResult> => {
    seen.push(check.name);
    const passed = results[check.name] ?? true;
    return { name: check.name, required: check.required, kind: check.kind, passed, exitCode: passed ? 0 : 1, output: "" };
  };
  return { runner, seen };
}

function httpJson(body: unknown, status = 200): HttpResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? "OK" : "Error",
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

describe("TOML config parsing", () => {
  it("parses the documented operator config shape", () => {
    const config = configFromToml(parseToml(TOML, "test.toml"), "test.toml");
    assert.equal(config.workspaceDir, "/work/proj");
    assert.equal(config.ollama.baseUrl, "http://127.0.0.1:11434");
    assert.equal(config.ollama.model, "qwen2.5-coder:7b");
    assert.equal(config.ollama.timeoutSeconds, 120);
    assert.equal(config.models.planner, "plan-model");
    assert.equal(config.models.coder, undefined);
    assert.equal(config.agent.maxCycles, 2);
    assert.equal(config.agent.maxContextChars, 100000);
    assert.equal(config.checks.length, 2);
    assert.equal(config.checks[0].name, "lint");
    assert.equal(config.checks[1].name, "test");
    assert.deepEqual(config.checks[1].cmd, ["npm", "test"]);
    assert.equal(config.checks[1].timeoutMs, 60000);
    assert.equal(config.checks[1].required, true);
    assert.equal(config.checks[1].kind, "test");
    assert.deepEqual(config.checks[1].filetypes, ["ts"]);
  });

  it("fills documented defaults when sections are omitted", () => {
    const config = configFromToml(parseToml('workspace_dir = "/w"\n', "t.toml"), "t.toml");
    assert.equal(config.ollama.baseUrl, "http://127.0.0.1:11434");
    assert.equal(config.ollama.timeoutSeconds, 120);
    assert.equal(config.agent.maxIterations, 6);
    assert.equal(config.agent.maxToolCalls, 64);
    assert.deepEqual(config.checks, []);
  });

  it("rejects a malformed line as a ConfigError", () => {
    assert.throws(() => parseToml("this is not toml\n", "bad.toml"), ConfigError);
  });

  it("resolveModel: --model override wins, then role, then ollama model", () => {
    const config = baseConfig();
    assert.equal(resolveModel(config, "planner", "override"), "override");
    assert.equal(resolveModel(config, "planner"), "plan-model");
    const noRoles = baseConfig({ models: {} });
    assert.equal(resolveModel(noRoles, "coder"), "base-model");
  });
});

describe("config resolution honesty", () => {
  it("missing config fails flow_status before any executor call", async () => {
    const executor = fakeExecutor();
    await assert.rejects(
      flowStatus({ executor, env: { XDG_CONFIG_HOME: "/none", HOME: "/none" }, fileExists: async () => false }),
      (err: unknown) => err instanceof ConfigError && /Missing configuration/.test((err as Error).message),
    );
    assert.equal(executor.probes, 0);
    assert.equal(executor.calls.length, 0);
  });

  it("an explicit --config path that does not exist is named in the error", async () => {
    await assert.rejects(
      flowStatus({ configPath: "/missing/operator.toml", fileExists: async () => false }),
      /\/missing\/operator\.toml/,
    );
  });

  it("auto-loads only $XDG_CONFIG_HOME/flow/config.toml", async () => {
    const seen: string[] = [];
    const out = await flowStatus({
      env: { XDG_CONFIG_HOME: "/xdg" },
      fileExists: async (p) => {
        seen.push(p);
        return p === "/xdg/flow/config.toml";
      },
      readTextFile: async () => TOML,
      executor: fakeExecutor(),
      trusted: false,
    });
    assert.deepEqual(seen, ["/xdg/flow/config.toml"]);
    assert.equal(out.configPath, "/xdg/flow/config.toml");
    assert.equal(out.workspaceDir, "/work/proj");
  });

  it("non-loopback Ollama endpoint without allow_remote is a config error", async () => {
    const config = baseConfig({
      ollama: { baseUrl: "http://192.0.2.10:11434", model: "m", timeoutSeconds: 120, allowRemote: false },
    });
    await assert.rejects(flowStatus({ config, executor: fakeExecutor() }), /allow_remote/);
  });

  it("a dotted ollama.allow_remote key at the root enables a remote endpoint", async () => {
    const text = 'workspace_dir = "/w"\nollama.allow_remote = true\n\n[ollama]\nbase_url = "http://192.0.2.10:11434"\nmodel = "m"\n';
    const out = await flowStatus({
      configPath: "/cfg/op.toml",
      fileExists: async () => true,
      readTextFile: async () => text,
      executor: fakeExecutor(),
    });
    assert.equal(out.ollama.baseUrl, "http://192.0.2.10:11434");
  });
});

describe("flowStatus", () => {
  it("reports workspace, models, budgets, checks and reachability", async () => {
    const out = await flowStatus({ config: baseConfig(), executor: fakeExecutor() });
    assert.equal(out.workspaceDir, "/work/proj");
    assert.equal(out.trusted, true);
    assert.equal(out.ollama.reachable, true);
    assert.deepEqual(out.ollama.availableModels, ["base-model"]);
    assert.deepEqual(out.models, { planner: "plan-model", coder: "code-model", reviewer: "review-model" });
    assert.equal(out.agent.maxToolCalls, 64);
    assert.deepEqual(out.checks, [
      { name: "lint", required: false, kind: "lint" },
      { name: "test", required: true, kind: "test" },
    ]);
  });

  it("an unreachable backend is reported in the status, not hidden", async () => {
    const out = await flowStatus({
      config: baseConfig(),
      executor: fakeExecutor({}, { reachable: false, models: [], detail: "connect ECONNREFUSED" }),
    });
    assert.equal(out.ollama.reachable, false);
    assert.equal(out.ollama.detail, "connect ECONNREFUSED");
  });

  it("the default Ollama executor probes /api/tags through the injected fetch", async () => {
    const urls: string[] = [];
    const fetchFn: FetchFn = async (url) => {
      urls.push(url);
      return httpJson({ models: [{ name: "qwen2.5-coder:7b" }, { name: "llama3" }] });
    };
    const out = await flowStatus({ config: baseConfig(), fetchFn });
    assert.deepEqual(urls, ["http://127.0.0.1:11434/api/tags"]);
    assert.equal(out.ollama.reachable, true);
    assert.deepEqual(out.ollama.availableModels, ["qwen2.5-coder:7b", "llama3"]);
  });
});

describe("flowCheck", () => {
  it("requires trusted mode, before any check runs", async () => {
    const { runner, seen } = fakeRunner({});
    await assert.rejects(
      flowCheck(undefined, { config: baseConfig({ trusted: false }), checkRunner: runner }),
      /trusted mode/,
    );
    assert.deepEqual(seen, []);
  });

  it("runs all configured checks and reports the aggregate", async () => {
    const { runner, seen } = fakeRunner({ lint: true, test: false });
    const out = await flowCheck(undefined, { config: baseConfig(), checkRunner: runner });
    assert.deepEqual(seen, ["lint", "test"]);
    assert.equal(out.requested, null);
    assert.equal(out.passed, false);
    assert.equal(out.results.length, 2);
  });

  it("runs exactly one named check when a name is given", async () => {
    const { runner, seen } = fakeRunner({});
    const out = await flowCheck("lint", { config: baseConfig(), checkRunner: runner });
    assert.deepEqual(seen, ["lint"]);
    assert.equal(out.requested, "lint");
    assert.equal(out.passed, true);
  });

  it("an unknown check name is an error naming what is configured", async () => {
    const { runner } = fakeRunner({});
    await assert.rejects(
      flowCheck("nope", { config: baseConfig(), checkRunner: runner }),
      /Unknown check "nope".*lint, test/,
    );
  });
});

describe("parseReviewerApproval", () => {
  it("reads structured approval and rejection", () => {
    assert.equal(parseReviewerApproval('{"approved": true}'), true);
    assert.equal(parseReviewerApproval('{"approved": false, "reason": "x"}'), false);
    assert.equal(parseReviewerApproval('```json\n{"approved": true}\n```'), true);
    assert.equal(parseReviewerApproval('{"verdict": "approve"}'), true);
    assert.equal(parseReviewerApproval("looks fine to me"), false);
    assert.equal(parseReviewerApproval(""), false);
  });
});

describe("flowRun", () => {
  it("verifies when planner/coder complete, required checks pass, and the reviewer approves", async () => {
    const executor = fakeExecutor({
      planner: "the plan",
      coder: "the code",
      reviewer: '{"approved": true}',
    });
    const { runner, seen } = fakeRunner({});
    const out = await flowRun("do the thing", {
      config: baseConfig(),
      executor,
      checkRunner: runner,
    });
    assert.equal(out.verified, true);
    assert.equal(out.cyclesUsed, 1);
    assert.equal(out.plannerOutput, "the plan");
    assert.equal(out.coderOutput, "the code");
    assert.equal(out.reviewer.approved, true);
    assert.equal(out.note, undefined);
    assert.deepEqual(executor.calls.map((c) => c.role), ["planner", "coder", "reviewer"]);
    assert.deepEqual(executor.calls.map((c) => c.model), ["plan-model", "code-model", "review-model"]);
    assert.deepEqual(seen, ["lint", "test"]);
  });

  it("is not verified when a required check fails, even if the reviewer approves, and retries within max_cycles", async () => {
    const executor = fakeExecutor({ reviewer: '{"approved": true}' });
    const { runner } = fakeRunner({ test: false });
    const out = await flowRun("do the thing", { config: baseConfig(), executor, checkRunner: runner });
    assert.equal(out.verified, false);
    assert.equal(out.cyclesUsed, 2);
    assert.match(out.note ?? "", /not every required check passed/);
    assert.equal(executor.calls.filter((c) => c.role === "coder").length, 2);
  });

  it("is not verified when no required check is configured", async () => {
    const config = baseConfig({
      checks: [{ name: "lint", cmd: ["true"], timeoutMs: 1000, required: false, kind: "lint", filetypes: [] }],
    });
    const executor = fakeExecutor({ reviewer: '{"approved": true}' });
    const { runner } = fakeRunner({});
    const out = await flowRun("task", { config, executor, checkRunner: runner });
    assert.equal(out.verified, false);
    assert.match(out.note ?? "", /no required check ran/);
  });

  it("is not verified when the reviewer withholds structured approval", async () => {
    const executor = fakeExecutor({ reviewer: "I cannot approve this." });
    const { runner } = fakeRunner({});
    const config = baseConfig({ agent: { maxIterations: 6, maxCycles: 1, maxToolCalls: 64, maxContextChars: 100000 } });
    const out = await flowRun("task", { config, executor, checkRunner: runner });
    assert.equal(out.verified, false);
    assert.equal(out.reviewer.approved, false);
    assert.match(out.note ?? "", /reviewer did not return structured approval/);
  });

  it("requires trusted mode and a configured model, failing before any model call", async () => {
    const executor = fakeExecutor();
    await assert.rejects(
      flowRun("task", { config: baseConfig({ trusted: false }), executor, checkRunner: fakeRunner({}).runner }),
      /trusted mode/,
    );
    const noModel = baseConfig({ models: {}, ollama: { baseUrl: "http://127.0.0.1:11434", timeoutSeconds: 120, allowRemote: false } });
    await assert.rejects(
      flowRun("task", { config: noModel, executor, checkRunner: fakeRunner({}).runner }),
      /no model configured for the planner role/,
    );
    assert.equal(executor.calls.length, 0);
  });
});

describe("Ollama executor over injected fetch", () => {
  it("complete() posts to /api/chat and returns the message content", async () => {
    const calls: { url: string; body?: string }[] = [];
    const fetchFn: FetchFn = async (url, init) => {
      calls.push({ url, body: init?.body });
      return httpJson({ message: { role: "assistant", content: "hello from model" } });
    };
    const executor = ollamaExecutor(baseConfig(), fetchFn);
    const out = await executor.complete("planner", "plan-model", "prompt text");
    assert.equal(out, "hello from model");
    assert.equal(calls[0].url, "http://127.0.0.1:11434/api/chat");
    const body = JSON.parse(calls[0].body ?? "{}") as Record<string, unknown>;
    assert.equal(body.model, "plan-model");
    assert.equal(body.stream, false);
  });

  it("an HTTP error from Ollama is surfaced, never fabricated", async () => {
    const fetchFn: FetchFn = async () => httpJson("model not found", 404);
    const executor = ollamaExecutor(baseConfig(), fetchFn);
    await assert.rejects(executor.complete("coder", "missing", "x"), /HTTP 404/);
    const probe = await executor.probe();
    assert.equal(probe.reachable, false);
  });
});

describe("nodeCheckRunner", () => {
  it("runs a real argv array and reports pass/fail by exit code", async () => {
    const ok = await nodeCheckRunner(
      { name: "ok", cmd: ["node", "-e", "process.exit(0)"], timeoutMs: 10000, required: true, kind: "test", filetypes: [] },
      undefined,
    );
    assert.equal(ok.passed, true);
    assert.equal(ok.exitCode, 0);
    const bad = await nodeCheckRunner(
      { name: "bad", cmd: ["node", "-e", "process.exit(3)"], timeoutMs: 10000, required: true, kind: "test", filetypes: [] },
      undefined,
    );
    assert.equal(bad.passed, false);
    assert.equal(bad.exitCode, 3);
  });

  it("an empty cmd array fails honestly without spawning anything", async () => {
    const out = await nodeCheckRunner(
      { name: "empty", cmd: [], timeoutMs: 1000, required: true, kind: "check", filetypes: [] },
      undefined,
    );
    assert.equal(out.passed, false);
    assert.equal(out.exitCode, null);
    assert.match(out.output, /empty cmd/);
  });
});
