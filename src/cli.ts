#!/usr/bin/env node
/**
 * agenttrio CLI.
 *
 *   agenttrio status [options]
 *   agenttrio run <task> [options]
 *   agenttrio check [name] [options]
 *   agenttrio mcp [options]
 *
 * Options: --config <file> (approve an operator TOML file),
 * --workspace <path>, --model <name>, --trusted (allow project
 * edits and explicitly configured named checks; run/check need it).
 * Argument validation happens before any config check.
 * Exit codes: 0 success, 1 runtime error, 2 usage error.
 */
import { flowCheck, flowRun, flowStatus, formatPayload, VERSION } from "./agenttrio.js";
import type { FlowDeps } from "./types.js";

function usage(): never {
  console.error(`Usage:
  agenttrio status [--config <file>] [--workspace <path>] [--model <name>] [--trusted]
  agenttrio run <task> [--config <file>] [--workspace <path>] [--model <name>] [--trusted]
  agenttrio check [name] [--config <file>] [--workspace <path>] [--model <name>] [--trusted]
  agenttrio mcp [--config <file>] [--workspace <path>] [--model <name>] [--trusted]
  agenttrio --version

Configuration: --config approves an operator TOML file; otherwise only
$XDG_CONFIG_HOME/flow/config.toml loads automatically. Default mode is
read-only; run and check require --trusted.`);
  process.exit(2);
}

interface Parsed {
  deps: FlowDeps;
  positional: string[];
}

function parseRest(rest: string[]): Parsed {
  const deps: FlowDeps = {};
  const positional: string[] = [];
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config" || arg === "--workspace" || arg === "--model") {
      const value = rest[i + 1];
      if (!value) usage();
      if (arg === "--config") deps.configPath = value;
      else if (arg === "--workspace") deps.workspaceDir = value;
      else deps.modelOverride = value;
      i++;
    } else if (arg === "--trusted") {
      deps.trusted = true;
    } else if (arg.startsWith("--")) {
      usage();
    } else {
      positional.push(arg);
    }
  }
  return { deps, positional };
}

async function main(): Promise<void> {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === "--version" || cmd === "-v") {
    console.log(VERSION);
    return;
  }
  if (cmd === "mcp") {
    // Validate startup options as usage before starting the server.
    parseRest(rest);
    await import("./mcp.js");
    return;
  }
  if (!cmd) usage();
  const known = ["status", "run", "check"];
  if (!known.includes(cmd)) usage();
  const { deps, positional } = parseRest(rest);
  // Argument validation first — before any configuration is read.
  if (cmd === "status" && positional.length !== 0) usage();
  if (cmd === "run" && positional.length !== 1) usage();
  if (cmd === "check" && positional.length > 1) usage();
  try {
    let out: unknown;
    if (cmd === "status") out = await flowStatus(deps);
    else if (cmd === "run") out = await flowRun(positional[0], deps);
    else out = await flowCheck(positional[0], deps);
    console.log(formatPayload(out));
  } catch (err) {
    console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

void main();
