/**
 * agenttrio MCP server. Tools: flow_status, flow_run, flow_check.
 *
 * Why the low-level Server instead of McpServer: the high-level
 * helper converts zod schemas to JSON Schema and injects keys that
 * are not in this tool's public spec ("$schema" and
 * "additionalProperties"), which breaks exact tool-list/schema
 * parity with the spec. This file serves tools/list with the
 * spec's exact input schemas as explicit literals, while zod still
 * validates every tools/call argument set.
 *
 * The documented argument shapes: flow_status takes {}, flow_run
 * takes {"task": "..."}, and flow_check takes {} or
 * {"name": "configured-name"}. Successful replies carry the report
 * as a JSON text block plus structuredContent, matching the
 * documented wire contract; failures are isError results.
 *
 * Server options (after the `mcp` subcommand): --config <file>,
 * --workspace <path>, --model <name>, --trusted. With no approved
 * config, every tool answers isError naming the missing
 * configuration, before any model or check call.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { flowCheck, flowRun, flowStatus, formatPayload, VERSION } from "./agenttrio.js";
import type { FlowDeps } from "./types.js";

const NoArgs = z.object({});
const RunArgs = z.object({ task: z.string().min(1) });
const CheckArgs = z.object({ name: z.string().min(1).optional() });

const TOOLS = [
  {
    name: "flow_status",
    description: "Report the workspace/flow status: workspace, Ollama backend reachability, configured models, agent budgets, and configured checks.",
    inputSchema: { type: "object" as const, properties: {} },
  },
  {
    name: "flow_run",
    description: "Run a bounded planner-coder-reviewer workflow on the task with a host-enforced verification gate.",
    inputSchema: {
      type: "object" as const,
      properties: { task: { type: "string" as const, description: "The task to run through the planner, coder, and reviewer workflow." } },
      required: ["task"],
    },
  },
  {
    name: "flow_check",
    description: "Run the workspace's configured checks (all, or one named check) and report the results.",
    inputSchema: {
      type: "object" as const,
      properties: { name: { type: "string" as const, description: "Name of one configured check to run; omit to run all checks." } },
    },
  },
];

/** Parse the server-startup options that follow the `mcp` subcommand. */
export function serveDepsFromArgv(argv: string[]): FlowDeps {
  const deps: FlowDeps = {};
  const idx = argv.indexOf("mcp");
  const rest = idx >= 0 ? argv.slice(idx + 1) : argv.slice(2);
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === "--config") deps.configPath = rest[++i];
    else if (arg === "--workspace") deps.workspaceDir = rest[++i];
    else if (arg === "--model") deps.modelOverride = rest[++i];
    else if (arg === "--trusted") deps.trusted = true;
  }
  return deps;
}

function result(value: unknown) {
  return {
    content: [{ type: "text" as const, text: formatPayload(value) }],
    structuredContent: value as Record<string, unknown>,
  };
}

function errorResult(err: unknown) {
  return {
    content: [
      { type: "text" as const, text: err instanceof Error ? err.message : String(err) },
    ],
    isError: true,
  };
}

const deps = serveDepsFromArgv(process.argv);

const server = new Server(
  { name: "agenttrio", version: VERSION },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    let out: unknown;
    if (name === "flow_status") {
      NoArgs.parse(args ?? {});
      out = await flowStatus(deps);
    } else if (name === "flow_run") {
      const parsed = RunArgs.parse(args ?? {});
      out = await flowRun(parsed.task, deps);
    } else if (name === "flow_check") {
      const parsed = CheckArgs.parse(args ?? {});
      out = await flowCheck(parsed.name, deps);
    } else {
      throw new McpError(ErrorCode.MethodNotFound, `Unknown tool: ${name}`);
    }
    return result(out);
  } catch (err) {
    if (err instanceof McpError) throw err;
    return errorResult(err);
  }
});

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
}

void main();
