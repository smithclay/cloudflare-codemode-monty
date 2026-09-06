/**
 * Monty Python execution for Cloudflare Code Mode.
 *
 * Cloudflare Code Mode supplies the tool model — providers, schemas, approval
 * filtering, the `Executor` contract. Monty supplies the code execution model —
 * Python parsing, sandboxing, async host-function suspension, value conversion
 * and error propagation. This package is the seam between them.
 */

export { MontyExecutor } from "./executor.js";
export type { MontyExecutorOptions, MontyPool } from "./executor.js";
export { createMontyCodeTool, DEFAULT_MONTY_DESCRIPTION } from "./tool.js";
export type { CreateMontyCodeToolOptions } from "./tool.js";
