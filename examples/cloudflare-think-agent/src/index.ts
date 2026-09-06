/**
 * A stateful Cloudflare Think agent whose only model-callable tool is Monty
 * Code Mode. Think owns the chat loop and Durable Object state; Monty runs the
 * Python program the model supplies to the `codemode` tool.
 */
import { Think } from "@cloudflare/think";
import { routeAgentRequest } from "agents";
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import montyWasm from "../../../node_modules/@pydantic/monty/dist/worker/monty_wasm_runtime.wasm";
import { MontyExecutor, createMontyCodeTool } from "@smithclay/cloudflare-codemode-monty";
import { createMontyWasmPool } from "@smithclay/cloudflare-codemode-monty/worker";

interface Env extends Cloudflare.Env {
  AI: Ai;
  MontyProjectAgent: DurableObjectNamespace<MontyProjectAgent>;
}

const projects = [
  { id: "atlas", name: "Atlas", owner: "Lina", status: "active" },
  { id: "beacon", name: "Beacon", owner: "Malik", status: "active" },
  { id: "cedar", name: "Cedar", owner: "Elena", status: "paused" },
];

const tasks = [
  { projectId: "atlas", title: "Add audit log", priority: "high", status: "open" },
  { projectId: "atlas", title: "Write migration guide", priority: "medium", status: "open" },
  { projectId: "beacon", title: "Repair retry queue", priority: "high", status: "open" },
  { projectId: "beacon", title: "Update runbook", priority: "high", status: "open" },
  { projectId: "cedar", title: "Archive staging data", priority: "high", status: "open" },
];

const readOnlyTools = {
  listProjects: tool({
    description: "List all projects in the synthetic, read-only project tracker.",
    inputSchema: z.object({}),
    execute: async () => projects,
  }),
  listTasks: tool({
    description: "List tasks for one project in the synthetic, read-only project tracker.",
    inputSchema: z.object({ projectId: z.string() }),
    execute: async ({ projectId }) => tasks.filter((task) => task.projectId === projectId),
  }),
};

// The pool is shared by an isolate, while MontyExecutor checks out a fresh
// interpreter session for each Code Mode execution.
const executor = new MontyExecutor({
  pool: () => createMontyWasmPool(montyWasm),
  limits: { maxDurationSecs: 10 },
});

const codemode = createMontyCodeTool({ tools: readOnlyTools, executor });

export class MontyProjectAgent extends Think<Env> {
  override workspaceBash = false;

  getModel() {
    return "@cf/moonshotai/kimi-k2.7-code";
  }

  getSystemPrompt() {
    return [
      "You are a project-tracker analyst.",
      "Use the codemode tool for every question about project data.",
      "Write Python that composes the available read-only APIs and return only the facts needed to answer.",
    ].join(" ");
  }

  getTools(): ToolSet {
    return { codemode };
  }

  beforeTurn() {
    return { activeTools: ["codemode"] };
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return (await routeAgentRequest(request, env)) ?? new Response("Not found", { status: 404 });
  },
} satisfies ExportedHandler<Env>;
