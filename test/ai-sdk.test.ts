/**
 * The AI SDK path end to end: a model emits a Code Mode tool call carrying
 * Python, `streamText` routes it to `createMontyCodeTool`, and the program runs
 * in Monty calling two host tools.
 *
 * The model is mocked so this is deterministic and free; `examples/ai-sdk.ts`
 * is the same wiring against a real Claude model.
 */
import { afterAll, expect, it } from "vitest";
import { generateText, stepCountIs, tool } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type { LanguageModelV4Usage } from "@ai-sdk/provider";
import { z } from "zod";
import { MontyExecutor, createMontyCodeTool } from "../src/index.js";

/** The V4 usage shape; the numbers are irrelevant to these tests. */
const USAGE: LanguageModelV4Usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const executor = new MontyExecutor();
afterAll(() => executor.close());

const notified: string[] = [];

const tools = {
  getWeather: tool({
    description: "Get the current weather for a location",
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => ({
      location,
      temperature: { London: 61, Lisbon: 81, "San Francisco": 74 }[location] ?? 68,
    }),
  }),
  notify: tool({
    description: "Send a notification",
    inputSchema: z.object({ message: z.string() }),
    execute: async ({ message }) => {
      notified.push(message);
      return { sent: true };
    },
  }),
};

/** The Python a model is expected to produce for "notify me about the warm cities". */
const MODEL_PYTHON = `cities = ["London", "Lisbon", "San Francisco"]
warm = []
for city in cities:
    weather = await codemode.getWeather({"location": city})
    if weather["temperature"] > 70:
        warm.append(weather["location"])

await codemode.notify({"message": "Warm today: " + ", ".join(warm)})
warm`;

it("runs a model-authored Python program that calls two tools", async () => {
  let call = 0;
  const model = new MockLanguageModelV4({
    doGenerate: async () => {
      call += 1;
      return call === 1
        ? {
            finishReason: { unified: "tool-calls" as const, raw: "tool_use" },
            usage: USAGE,
            content: [
              {
                type: "tool-call" as const,
                toolCallId: "c1",
                toolName: "codemode",
                input: JSON.stringify({ code: MODEL_PYTHON }),
              },
            ],
            warnings: [],
          }
        : {
            finishReason: { unified: "stop" as const, raw: "end_turn" },
            usage: USAGE,
            content: [{ type: "text" as const, text: "Lisbon and San Francisco are warm." }],
            warnings: [],
          };
    },
  });

  const codemode = createMontyCodeTool({ tools, executor });
  const result = await generateText({
    model,
    tools: { codemode },
    stopWhen: stepCountIs(3),
    prompt: "Notify me about the warm cities.",
  });

  const toolResult = result.steps[0]?.toolResults[0];
  expect(toolResult?.output).toEqual({ result: ["Lisbon", "San Francisco"] });
  expect(notified).toEqual(["Warm today: Lisbon, San Francisco"]);
  expect(result.text).toContain("Lisbon");
});

it("hands the model a Python API block in the tool description", async () => {
  let seenTools: unknown;
  const model = new MockLanguageModelV4({
    doGenerate: async ({ tools: t }) => {
      seenTools = t;
      return {
        finishReason: { unified: "stop" as const, raw: "end_turn" },
        usage: USAGE,
        content: [{ type: "text" as const, text: "ok" }],
        warnings: [],
      };
    },
  });

  await generateText({
    model,
    tools: { codemode: createMontyCodeTool({ tools, executor }) },
    prompt: "hi",
  });

  const description = (seenTools as { description: string }[])[0]!.description;
  expect(description).toContain("class codemode:");
  expect(description).toContain("async def getWeather");
  expect(description).toContain("Python");
});
