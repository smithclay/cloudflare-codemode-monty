/**
 * `MontyExecutor` — a Cloudflare Code Mode `Executor` whose sandbox is Monty.
 *
 * Cloudflare's contract is `execute(code, providers, options?) => ExecuteResult`
 * and "implementations should never throw"; everything below funnels into that.
 * The only substitution is the language: `code` is a Python program, not a JS
 * async arrow function. The supported provider subset is `name` plus `fns`:
 * JavaScript provider preludes and connector bindings are rejected explicitly.
 */

import {
  CollectStreams,
  Monty,
  MontyError,
  MontyRuntimeError,
  MontySyntaxError,
  type CheckoutOptions,
  type MontySession,
  type ResourceLimits,
} from "@pydantic/monty";
import type {
  ExecuteOptions,
  ExecuteResult,
  Executor,
  ResolvedProvider,
} from "@cloudflare/codemode";
import { DISPATCH_NAME, bindToolDefinition, montyToJs, prepareToolDefinition } from "./bridge.js";
import { buildPrelude } from "./prelude.js";

/**
 * The subset of a Monty pool this package uses. Both `Monty` (the Node
 * subprocess pool from `@pydantic/monty`) and `WorkerPool` (the wasm pool from
 * `@pydantic/monty/wasm`, used inside a Cloudflare Worker) satisfy it.
 */
export interface MontyPool {
  checkout(options?: CheckoutOptions): Promise<MontySession>;
  close(): Promise<void>;
}

export interface MontyExecutorOptions {
  /**
   * The Monty pool to run code in, or a factory for one (called at most once,
   * lazily). Defaults to a Node subprocess pool via `Monty.create()`.
   *
   * A pool the executor created — from the default or from a factory — is shut
   * down by `close()`. A pool instance passed here directly is borrowed and
   * never closed, so several executors can share one.
   *
   * Inside a Cloudflare Worker there is no subprocess pool: import the wasm
   * module and pass `createMontyWasmPool(montyWasm)` from
   * `@smithclay/cloudflare-codemode-monty/worker`.
   */
  pool?: MontyPool | (() => MontyPool | Promise<MontyPool>);
  /**
   * Sandbox resource limits for each execution. Defaults to a 30s execution
   * budget. The clock only advances while the interpreter runs, so time spent
   * awaiting a host tool call does not count against it.
   */
  limits?: ResourceLimits;
}

const DEFAULT_LIMITS: ResourceLimits = { maxDurationSecs: 30 };

/** Runs LLM-generated Python in Monty, dispatching tool calls back to the host. */
export class MontyExecutor implements Executor {
  readonly #limits: ResourceLimits;
  readonly #createPool: () => MontyPool | Promise<MontyPool>;
  /** False only for a pool instance passed in, so `close()` never shuts down a borrowed one. */
  readonly #owned: boolean;
  #pool: Promise<MontyPool> | undefined;

  constructor(options: MontyExecutorOptions = {}) {
    this.#limits = options.limits ?? DEFAULT_LIMITS;
    const pool = options.pool;
    this.#owned = typeof pool !== "object";
    this.#createPool =
      pool === undefined ? defaultPool : typeof pool === "function" ? pool : () => pool;
  }

  async execute(
    code: string,
    providersOrFns: ResolvedProvider[] | Record<string, (...args: unknown[]) => Promise<unknown>>,
    options?: ExecuteOptions,
  ): Promise<ExecuteResult> {
    if (options?.connectors?.length) {
      return {
        result: undefined,
        error:
          "MontyExecutor does not support connector bindings yet — pass tools as ResolvedProvider[] instead.",
      };
    }

    const providers: ResolvedProvider[] = Array.isArray(providersOrFns)
      ? providersOrFns
      : [{ name: "codemode", fns: providersOrFns }];

    const preludeProvider = providers.find((provider) => provider.prelude?.trim());
    if (preludeProvider) {
      return {
        result: undefined,
        error:
          `MontyExecutor does not support the JavaScript prelude on provider "${preludeProvider.name}". ` +
          "Expose its behavior as a resolved function instead.",
      };
    }

    const printer = new CollectStreams();
    let session: MontySession | undefined;
    try {
      const definition = prepareToolDefinition(providers);
      const { dispatch } = bindToolDefinition(definition, providers);
      const prelude = buildPrelude(definition.namespaces);
      const pool = await this.#ensurePool();
      session = await pool.checkout({ limits: this.#limits });
      // Fed separately so the model's code keeps its own line numbers in tracebacks.
      if (prelude) await session.feedRun(prelude);
      const result = await session.feedRun(normalizePythonCode(code), {
        externalLookup: { [DISPATCH_NAME]: dispatch },
        printCallback: printer,
      });
      return withLogs({ result: montyToJs(result) }, printer);
    } catch (error) {
      return withLogs({ result: undefined, error: formatError(error) }, printer);
    } finally {
      // A crashed worker is already discarded; closing again must not mask the result.
      await session?.close().catch(() => {});
    }
  }

  /** Shut down the pool, unless it was passed in as an instance this executor borrowed. */
  async close(): Promise<void> {
    if (!this.#owned || this.#pool === undefined) return;
    const pool = await this.#pool.catch(() => undefined);
    this.#pool = undefined;
    await pool?.close();
  }

  async [Symbol.asyncDispose](): Promise<void> {
    await this.close();
  }

  #ensurePool(): Promise<MontyPool> {
    // Memoized so concurrent executions share one pool rather than racing to build several.
    this.#pool ??= Promise.resolve(this.#createPool());
    return this.#pool;
  }
}

async function defaultPool(): Promise<MontyPool> {
  try {
    return await Monty.create();
  } catch (error) {
    throw new Error(
      "Could not start the default Monty pool. Inside a Cloudflare Worker, import the wasm " +
        "module and pass `pool: createMontyWasmPool(montyWasm)` from " +
        `"@smithclay/cloudflare-codemode-monty/worker". Cause: ${messageOf(error)}`,
      { cause: error },
    );
  }
}

/**
 * Strip a markdown code fence, mirroring the `stripCodeFences` step of
 * Cloudflare's `normalizeCode`. The rest of that function reshapes JavaScript
 * into an async arrow function via acorn and has no Python analogue: a Monty
 * snippet is already a program whose trailing expression is its result.
 */
function normalizePythonCode(code: string): string {
  const source = code.trim();
  const fenced = source.match(/^```(?:python|py)?\s*\n([\s\S]*?)```\s*$/);
  return (fenced?.[1] ?? source).trim();
}

/** Render a failure as text the model can act on: a Python traceback where one exists. */
function formatError(error: unknown): string {
  if (error instanceof MontyRuntimeError || error instanceof MontySyntaxError) {
    return error.display("traceback");
  }
  // Every other MontyError (crashed worker, typing, protocol) has no traceback.
  if (error instanceof MontyError) return error.display("type-msg");
  return messageOf(error);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Attach captured `print()` output, matching `ExecuteResult.logs`. */
function withLogs(result: ExecuteResult, printer: CollectStreams): ExecuteResult {
  const logs: string[] = [];
  for (const { stream, text } of printer.output) {
    for (const line of text.split("\n")) {
      if (line === "") continue;
      logs.push(stream === "stderr" ? `[stderr] ${line}` : line);
    }
  }
  return logs.length > 0 ? { ...result, logs } : result;
}
