/**
 * Minimal Cloudflare Worker running Code Mode on Monty.
 *
 * The wasm runtime is imported as a `CompiledWasm` module (see the rule in
 * wrangler.jsonc) and handed to the executor's pool: inside workerd there are
 * no subprocesses and no `Worker` global, so Monty runs its interpreter
 * in-process against that module.
 *
 * GET /            → runs a fixed Python program that calls two tools
 * POST / {code}    → runs your own Python
 */
import montyWasm from "../../../node_modules/@pydantic/monty/dist/worker/monty_wasm_runtime.wasm";
import { tool } from "ai";
import { z } from "zod";
import { MontyExecutor, createMontyCodeTool } from "@smithclay/cloudflare-codemode-monty";
import { createMontyWasmPool } from "@smithclay/cloudflare-codemode-monty/worker";

const tools = {
  getWeather: tool({
    description: "Get the weather for a location",
    inputSchema: z.object({ location: z.string() }),
    execute: async ({ location }) => ({ location, temperature: 72, conditions: "sunny" }),
  }),
  notify: tool({
    description: "Send a notification",
    inputSchema: z.object({ message: z.string() }),
    execute: async ({ message }) => ({ sent: true, message }),
  }),
};

const DEMO = `weather = await codemode.getWeather({"location": "San Francisco"})
notified = None
if weather["temperature"] > 70:
    notified = await codemode.notify({"message": "Nice weather in " + weather["location"]})
print("temperature was", weather["temperature"])
{"weather": weather, "notified": notified}`;

// One pool per isolate, shared by every request; the executor checks out a
// fresh session (with its own globals) per execution.
const executor = new MontyExecutor({
  pool: () => createMontyWasmPool(montyWasm),
  limits: { maxDurationSecs: 10 },
});

const codemode = createMontyCodeTool({ tools, executor });

export default {
  async fetch(request: Request): Promise<Response> {
    const code = request.method === "POST" ? await request.text() : DEMO;
    try {
      const output = await codemode.execute!(
        { code },
        { toolCallId: "worker", messages: [], context: undefined },
      );
      return Response.json({ ok: true, ...output });
    } catch (error) {
      return Response.json({ ok: false, error: (error as Error).message }, { status: 400 });
    }
  },
};
