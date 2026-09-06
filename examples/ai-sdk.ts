/**
 * End-to-end AI SDK example: a model orchestrates two tools with Python.
 *
 *   ANTHROPIC_API_KEY=... npx tsx examples/ai-sdk.ts
 *
 * The prompt deliberately needs a tool call, a data transformation, a
 * conditional second tool call, and a returned value — the thing Code Mode
 * exists for. Doing it with plain tool calling would cost four round trips
 * through the model; here it is one Python program.
 */
import { anthropic } from "@ai-sdk/anthropic";
import { stepCountIs, streamText, tool } from "ai";
import { z } from "zod";
import { MontyExecutor, createMontyCodeTool } from "../src/index.js";

const forecast: Record<string, { temperature: number; conditions: string }> = {
  London: { temperature: 61, conditions: "drizzle" },
  "San Francisco": { temperature: 74, conditions: "sunny" },
  Lisbon: { temperature: 81, conditions: "clear" },
  Reykjavik: { temperature: 44, conditions: "windy" },
};

const tools = {
  getWeather: tool({
    description: "Get the current weather for a location",
    inputSchema: z.object({ location: z.string().describe("City name") }),
    execute: async ({ location }) => ({
      location,
      ...(forecast[location] ?? { temperature: 68, conditions: "unknown" }),
    }),
  }),
  notify: tool({
    description: "Send a notification to the user",
    inputSchema: z.object({ message: z.string() }),
    execute: async ({ message }) => {
      console.log(`  [notify] ${message}`);
      return { sent: true, message };
    },
  }),
};

const executor = new MontyExecutor();
const codemode = createMontyCodeTool({ tools, executor });

const result = streamText({
  model: anthropic(process.env.MODEL ?? "claude-opus-5"),
  stopWhen: stepCountIs(5),
  tools: { codemode },
  prompt: [
    "Check the weather in London, San Francisco, Lisbon and Reykjavik.",
    "Notify me once with a single message naming only the cities above 70F,",
    "then tell me which city is warmest.",
    "Use the codemode tool and do all the filtering in Python — one execution.",
  ].join(" "),
});

for await (const part of result.fullStream) {
  if (part.type === "text-delta") process.stdout.write(part.text);
  if (part.type === "tool-call" && part.toolName === "codemode") {
    console.log("\n--- Python the model wrote ---");
    console.log((part.input as { code: string }).code);
    console.log("--- end ---");
  }
  if (part.type === "tool-result") {
    console.log("--- result ---");
    console.log(JSON.stringify(part.output, null, 2));
  }
  if (part.type === "tool-error") console.error("--- tool error ---\n", part.error);
}
console.log();
await executor.close();
