import { afterAll, describe, expect, it } from "vitest";
import { tool } from "ai";
import { lazySchema } from "@ai-sdk/provider-utils";
import { z } from "zod";
import { MontyExecutor, createMontyCodeTool } from "../src/index.js";
import { describeNamespace } from "../src/describe.js";

const executor = new MontyExecutor();
afterAll(() => executor.close());

const weatherTools = {
  getWeather: tool({
    description: "Get the weather for a location",
    inputSchema: z.object({
      location: z.string().describe("City name, e.g. San Francisco"),
      units: z.enum(["c", "f"]).optional(),
    }),
    execute: async ({ location }) => ({ location, temperature: 72, conditions: "sunny" }),
  }),
  notify: tool({
    description: "Send a notification",
    inputSchema: z.object({ message: z.string() }),
    execute: async ({ message }) => ({ sent: true, message }),
  }),
};

/** AI SDK tools carry an `execute` whose second argument is call options we don't use. */
async function run(codeTool: ReturnType<typeof createMontyCodeTool>, code: string) {
  const output = await codeTool.execute!(
    { code },
    { toolCallId: "t", messages: [], context: undefined },
  );
  // Only a streaming tool returns an AsyncIterable; this one always resolves a value.
  return output as { result: unknown; logs?: string[] };
}

describe("description", () => {
  const codeTool = createMontyCodeTool({ tools: weatherTools, executor });

  it("documents the tools as Python, not TypeScript", () => {
    const description = codeTool.description!;
    expect(description).toContain("class codemode:");
    expect(description).toContain("async def getWeather(args:");
    expect(description).toContain('"location": str');
    expect(description).toContain("Get the weather for a location");
    expect(description).not.toContain("declare const");
    expect(description).not.toContain("=> Promise<");
  });

  it("marks optional keys and renders enums as Literal", () => {
    expect(codeTool.description).toContain('"units"?: Literal["c", "f"]');
  });

  it("carries field descriptions into the docstring", () => {
    expect(codeTool.description).toContain("location: City name, e.g. San Francisco");
  });

  it("tells the model it is writing Python for Monty", () => {
    expect(codeTool.description).toMatch(/Python/);
    expect(codeTool.description).toContain("FINAL EXPRESSION");
  });

  it("honours a custom description with the {{types}} placeholder", () => {
    const custom = createMontyCodeTool({
      tools: weatherTools,
      executor,
      description: "Only this. {{types}}",
    });
    expect(custom.description).toMatch(/^Only this\. /);
    expect(custom.description).toContain("class codemode:");
  });
});

describe("execution", () => {
  const codeTool = createMontyCodeTool({ tools: weatherTools, executor });

  it("takes { code } and returns { result }", async () => {
    await expect(run(codeTool, "1 + 1")).resolves.toEqual({ result: 2 });
  });

  it("runs a multi-step program that calls two tools", async () => {
    const output = await run(
      codeTool,
      [
        'weather = await codemode.getWeather({"location": "San Francisco"})',
        'if weather["temperature"] > 70:',
        '    await codemode.notify({"message": "Nice weather today"})',
        "weather",
      ].join("\n"),
    );
    expect(output.result).toEqual({
      location: "San Francisco",
      temperature: 72,
      conditions: "sunny",
    });
  });

  it("validates tool input against the tool's own schema", async () => {
    await expect(run(codeTool, "await codemode.getWeather({})")).rejects.toThrow(
      /Code execution failed/,
    );
  });

  it("fails setup when a tool schema cannot be normalized", () => {
    const schemaError = new Error("schema unavailable");
    const inputSchema = lazySchema(() => {
      throw schemaError;
    });

    expect(() =>
      createMontyCodeTool({
        executor,
        tools: {
          guarded: tool({ inputSchema, execute: async () => "must not run" }),
        },
      }),
    ).toThrow(schemaError);
  });

  it("keeps description generation best-effort for an incomplete schema", () => {
    const inputSchema = lazySchema(() => {
      throw new Error("schema unavailable");
    });

    expect(() =>
      describeNamespace("codemode", [{ pythonName: "guarded", tool: { inputSchema } }]),
    ).not.toThrow();
  });

  it("throws with the captured output when the program fails", async () => {
    await expect(run(codeTool, 'print("halfway")\nraise ValueError("boom")')).rejects.toThrow(
      /Console output:\nhalfway/,
    );
  });

  it("returns logs alongside the result", async () => {
    await expect(run(codeTool, 'print("hi")\n7')).resolves.toEqual({
      result: 7,
      logs: ["hi"],
    });
  });
});

describe("providers", () => {
  it("exposes each named provider as its own Python namespace", async () => {
    const codeTool = createMontyCodeTool({
      executor,
      tools: [
        {
          name: "github",
          tools: {
            listIssues: tool({
              description: "List issues",
              inputSchema: z.object({ repo: z.string() }),
              execute: async ({ repo }) => [
                { repo, state: "open" },
                { repo, state: "closed" },
              ],
            }),
          },
        },
        {
          name: "state",
          tools: {
            save: tool({
              description: "Save a value",
              inputSchema: z.object({ count: z.number() }),
              execute: async ({ count }) => ({ saved: count }),
            }),
          },
        },
      ],
    });

    expect(codeTool.description).toContain("class github:");
    expect(codeTool.description).toContain("class state:");

    const output = await run(
      codeTool,
      [
        'issues = await github.listIssues({"repo": "cloudflare/agents"})',
        'open_issues = [i for i in issues if i["state"] == "open"]',
        'await state.save({"count": len(open_issues)})',
      ].join("\n"),
    );
    expect(output.result).toEqual({ saved: 1 });
  });

  it("hides tools that need approval", async () => {
    const codeTool = createMontyCodeTool({
      executor,
      tools: {
        safe: tool({
          description: "Safe",
          inputSchema: z.object({}),
          execute: async () => "ok",
        }),
        dangerous: tool({
          description: "Dangerous",
          inputSchema: z.object({}),
          needsApproval: true,
          execute: async () => "should never run",
        }),
      },
    });
    expect(codeTool.description).toContain("async def safe");
    expect(codeTool.description).not.toContain("async def dangerous");
    await expect(run(codeTool, "await codemode.dangerous({})")).rejects.toThrow(/AttributeError/);
  });

  it("keeps a provider's own `types` block verbatim", () => {
    const codeTool = createMontyCodeTool({
      executor,
      tools: [{ name: "custom", tools: {}, types: "# hand written docs" }],
    });
    expect(codeTool.description).toContain("# hand written docs");
    expect(codeTool.description).not.toContain("class custom:");
  });

  it("does not document tools that do not have a host execute function", () => {
    const codeTool = createMontyCodeTool({
      executor,
      tools: {
        runnable: tool({
          description: "Can run in Monty",
          inputSchema: z.object({}),
          execute: async () => "ok",
        }),
        clientOnly: tool({
          description: "Only the client can run this",
          inputSchema: z.object({}),
        }),
      },
    });
    expect(codeTool.description).toContain("async def runnable");
    expect(codeTool.description).not.toContain("async def clientOnly");
  });

  it("fails construction when tool names collide after Python normalization", () => {
    expect(() =>
      createMontyCodeTool({
        executor,
        tools: {
          "a-b": tool({ inputSchema: z.object({}), execute: async () => "first" }),
          "a.b": tool({ inputSchema: z.object({}), execute: async () => "second" }),
        },
      }),
    ).toThrow(/both sanitize to "a_b"/);
  });
});
