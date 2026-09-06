/**
 * `createMontyCodeTool` — the AI SDK entry point.
 *
 * Cloudflare's `createCodeTool` is JavaScript-shaped in three places: it
 * generates TypeScript declarations for the prompt, its description tells the
 * model to write an async arrow function, and `runCode` reshapes the source
 * with an acorn-based normalizer. Everything else — provider normalization,
 * approval filtering, schema validation, the `{ code }` input, the
 * `{ result, logs }` output, the throw-on-error contract — is reproduced here
 * exactly, because `@cloudflare/codemode` only loads inside workerd (it imports
 * `cloudflare:workers` at module scope) and this package also runs under Node.
 */

import { asSchema, jsonSchema, tool, type Tool } from "ai";
import type { CodeInput, CodeOutput, CreateCodeToolOptions } from "@cloudflare/codemode/ai";
import type { Executor, ResolvedProvider, ToolProvider } from "@cloudflare/codemode";
import { buildBridge } from "./bridge.js";
import { describeProviders } from "./describe.js";

/** Same options as Cloudflare's `createCodeTool`; `{{types}}` is the Python API block. */
export type CreateMontyCodeToolOptions = CreateCodeToolOptions;

export const DEFAULT_MONTY_DESCRIPTION = `Execute Python code to achieve a goal.

{{types}}

Write a Python program that Monty can run — a sandboxed subset of CPython with no
filesystem and no network. A few stdlib modules are importable (asyncio, json, math,
re, datetime, itertools, collections); most are not, so prefer plain Python.

- Every tool call is async: \`await codemode.get_weather({"location": "London"})\`.
- Top-level \`await\` works. Do NOT wrap the program in a function or define main().
- Arguments are a single dict, or keyword arguments: \`await codemode.notify(message="hi")\`.
- The value of the FINAL EXPRESSION is returned. End with the value you want back.
- \`print()\` output is captured and returned alongside the result.

Example:
weather = await codemode.get_weather({"location": "San Francisco"})
if weather["temperature"] > 70:
    await codemode.notify({"message": "Nice weather today"})
weather`;

const codeSchema = jsonSchema<CodeInput>({
  type: "object",
  properties: {
    code: { type: "string", description: "Python program to execute in the Monty sandbox" },
  },
  required: ["code"],
  additionalProperties: false,
});

/**
 * Build a Code Mode tool that hands model-written Python to a `MontyExecutor`.
 *
 * ```ts
 * const codemode = createMontyCodeTool({ tools: myTools, executor: new MontyExecutor() });
 * ```
 */
export function createMontyCodeTool(
  options: CreateMontyCodeToolOptions,
): Tool<CodeInput, CodeOutput> {
  const providers = normalizeProviders(options.tools);
  const prepared = providers.map((provider) => ({
    name: provider.name ?? "codemode",
    tools: filterTools(provider.tools),
    types: provider.types,
  }));
  const resolved = prepared.map(({ name, tools }) => ({ name, fns: extractFns(tools) }));

  // The bridge is the source of truth for the Python namespace. Validate it
  // before creating a tool description so the model cannot be shown a surface
  // that every execution would reject (for example, colliding tool names).
  const { namespaces } = buildBridge(resolved);
  const preparedByName = new Map(prepared.map((provider) => [provider.name, provider]));
  const documented = namespaces.flatMap(({ name, tools }) => {
    const provider = preparedByName.get(name)!;
    if (provider.types !== undefined) return [];
    return [
      {
        name,
        tools: tools.map(({ pythonName, toolName }) => ({
          pythonName,
          tool: provider.tools[toolName]!,
        })),
      },
    ];
  });

  // A provider's custom type block replaces its generated block, as it does in
  // Cloudflare's createCodeTool().
  const custom = providers.filter((p) => p.types !== undefined).map((p) => p.types as string);
  const typeBlock = [describeProviders(documented), ...custom].join("\n\n");
  const executor = options.executor;

  return tool({
    description: (options.description ?? DEFAULT_MONTY_DESCRIPTION).replace("{{types}}", typeBlock),
    inputSchema: codeSchema,
    execute: async ({ code }) => runMontyCode({ code, executor, providers: resolved }),
  });
}

/**
 * The Python counterpart of Cloudflare's `runCode`: an executor never throws,
 * so a failed run is turned into a thrown tool error carrying the captured
 * output, and a successful one returns `{ result, logs? }`.
 */
export async function runMontyCode({
  code,
  executor,
  providers,
}: {
  code: string;
  executor: Executor;
  providers: ResolvedProvider[];
}): Promise<CodeOutput> {
  const executeResult = await executor.execute(code, providers);
  if (executeResult.error) {
    const logContext = executeResult.logs?.length
      ? `\n\nConsole output:\n${executeResult.logs.join("\n")}`
      : "";
    throw new Error(`Code execution failed: ${executeResult.error}${logContext}`);
  }
  return executeResult.logs?.length
    ? { result: executeResult.result, logs: executeResult.logs }
    : { result: executeResult.result };
}

type ToolRecord = Record<string, Record<string, unknown>>;

/** Raw tool records are wrapped as one default `codemode` provider (upstream `normalizeProviders`). */
function normalizeProviders(tools: CreateMontyCodeToolOptions["tools"]): ToolProvider[] {
  return Array.isArray(tools) ? tools : [{ tools }];
}

/** Keep only tools the sandbox can both advertise and execute. */
function filterTools(tools: ToolProvider["tools"]): ToolRecord {
  const kept: ToolRecord = {};
  for (const [name, t] of Object.entries(tools as ToolRecord)) {
    const needsApproval = t.needsApproval;
    if (needsApproval === true || typeof needsApproval === "function") continue;
    if (typeof t.execute !== "function") continue;
    kept[name] = t;
  }
  return kept;
}

/** Extract execute functions, validating input against each tool's schema (upstream `/ai` behaviour). */
function extractFns(tools: ToolRecord): Record<string, (...args: unknown[]) => Promise<unknown>> {
  const fns: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const [name, t] of Object.entries(tools)) {
    const execute = t.execute;
    if (typeof execute !== "function") continue;
    const raw = t.inputSchema ?? t.parameters;
    // Match Cloudflare's AI adapter: schema normalization is part of the
    // execution boundary, so a broken lazy schema must fail rather than make
    // an otherwise schema-backed tool run unchecked.
    const schema = raw !== null && raw !== undefined ? asSchema(raw as never) : undefined;
    fns[name] = schema?.validate
      ? async (args: unknown) => {
          const validated = await schema.validate!(args);
          if (!validated.success) throw validated.error;
          return execute(validated.value);
        }
      : (execute as (...args: unknown[]) => Promise<unknown>);
  }
  return fns;
}
