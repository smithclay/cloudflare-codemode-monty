/**
 * Cloudflare Workers entry point.
 *
 * A Worker has no subprocesses, so the Node pool from `@pydantic/monty` cannot
 * run there. `@pydantic/monty/wasm` covers it — but only through
 * `createWorkerPool(module)`: its own `Monty.create()` resolves to the browser
 * loader inside workerd and fails trying to `fetch()` the wasm asset. The
 * module therefore has to be imported by the Worker and handed in.
 *
 * ```ts
 * import montyWasm from "../node_modules/@pydantic/monty/dist/worker/monty_wasm_runtime.wasm";
 * import { MontyExecutor } from "@smithclay/cloudflare-codemode-monty";
 * import { createMontyWasmPool } from "@smithclay/cloudflare-codemode-monty/worker";
 *
 * const executor = new MontyExecutor({ pool: () => createMontyWasmPool(montyWasm) });
 * ```
 *
 * Requires a `CompiledWasm` rule for `**\/*.wasm` in `wrangler.jsonc`. The
 * bundled runtime is ~17 MB raw / ~5.2 MB gzipped, so the Worker only fits
 * under the paid plan's 10 MB compressed limit.
 */

import { createWorkerPool, type WasmPoolOptions } from "@pydantic/monty/wasm";
import type { MontyPool } from "./executor.js";

export type { WasmPoolOptions };

/**
 * Create a Monty pool backed by the wasm runtime, for use as
 * `MontyExecutor`'s `pool`. In workerd there is no `Worker` global, so the pool
 * runs the interpreter in-process: sessions are isolated from each other, but a
 * runaway snippet cannot be preempted — keep `limits.maxDurationSecs` set.
 */
export async function createMontyWasmPool(
  module: WebAssembly.Module,
  options?: WasmPoolOptions,
): Promise<MontyPool> {
  return await createWorkerPool(module, options);
}

export { MontyExecutor } from "./executor.js";
export type { MontyExecutorOptions, MontyPool } from "./executor.js";
export { createMontyCodeTool, DEFAULT_MONTY_DESCRIPTION } from "./tool.js";
export type { CreateMontyCodeToolOptions } from "./tool.js";
