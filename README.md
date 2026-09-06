# @smithclay/cloudflare-codemode-monty

[![CI](https://github.com/smithclay/cloudflare-codemode-monty/actions/workflows/ci.yml/badge.svg)](https://github.com/smithclay/cloudflare-codemode-monty/actions/workflows/ci.yml)

A [Monty](https://github.com/pydantic/monty) execution backend for [Cloudflare Code Mode](https://github.com/cloudflare/agents/tree/main/packages/codemode) that lets models orchestrate Code Mode tools using sandboxed **Python** instead of JavaScript.

> **Status: experimental, v0.** The API is small on purpose and will change. It is tested under Node, inside workerd (`wrangler dev --local`), and with a temporary production-edge smoke test.

## Why

Code Mode's premise is that a model orchestrates tools better by writing a program than by emitting one tool call per turn. Cloudflare's executor runs that program as JavaScript in a dynamically-loaded Worker. This package supplies a Python/Monty execution path for the AI SDK tool-provider subset:

```
LLM writes Python
      ↓
Monty executes it (sandboxed interpreter, wasm or subprocess)
      ↓
host function suspension  (await codemode.get_weather({...}))
      ↓
Cloudflare Code Mode providers  (ResolvedProvider.fns — schema-validated)
      ↓
real tools
```

Cloudflare's AI SDK adapter supplies the **tool model**: providers, namespaces, JSON Schema and approval filtering. Monty supplies the **code execution model**: Python parsing, sandboxing, async host-function suspension, value conversion and error propagation. This package adapts the supported intersection; it does not emulate Code Mode's JavaScript runtime.

## Install

```bash
npm install @smithclay/cloudflare-codemode-monty @cloudflare/codemode ai
```

`@cloudflare/codemode` and `ai` are peer dependencies. `@pydantic/monty` comes along as a dependency.

## Example

```ts
import { tool } from "ai";
import { z } from "zod";
import { MontyExecutor, createMontyCodeTool } from "@smithclay/cloudflare-codemode-monty";

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

const executor = new MontyExecutor();
const codemode = createMontyCodeTool({ tools, executor });

const result = streamText({ model, messages, tools: { codemode } });
```

The model then writes Python, and one execution replaces four round trips:

```python
weather = await codemode.getWeather({"location": "San Francisco"})

if weather["temperature"] > 70:
    await codemode.notify({"message": "Nice weather today"})

weather
```

The value of the final expression becomes `ExecuteResult.result`; `print()` output becomes `logs`.

Runnable examples: [`examples/ai-sdk.ts`](examples/ai-sdk.ts) (Node + a real model), [`examples/cloudflare-worker`](examples/cloudflare-worker) (direct Code Mode execution in workerd), and [`examples/cloudflare-think-agent`](examples/cloudflare-think-agent) (a stateful Think agent that calls Monty Code Mode).

## Public API

```ts
export { MontyExecutor, createMontyCodeTool, DEFAULT_MONTY_DESCRIPTION };
export type { MontyExecutorOptions, CreateMontyCodeToolOptions, MontyPool };
```

`MontyExecutor` structurally implements Cloudflare's `Executor` interface, but it supports a deliberately narrow contract: Python source plus direct `ResolvedProvider` namespaces containing `name` and `fns` (or the equivalent bare function record). It rejects connector bindings and non-empty JavaScript `ResolvedProvider.prelude` values.

Use `createMontyCodeTool` for the supported AI SDK integration. `MontyExecutor` is **not** a drop-in executor for `createCodemodeRuntime`: that runtime supplies JavaScript descriptions, source normalization, provider preludes, connectors, durable replay and approval behavior that Monty does not implement.

```ts
const executor = new MontyExecutor();
await executor.execute("1 + 2", []); // { result: 3 }
await executor.close(); // shuts down a pool the executor created
```

`MontyExecutorOptions`:

| Option   | Default                   | Notes                                                                                    |
| -------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `pool`   | `Monty.create()` (Node)   | A Monty pool or a factory. Required in a Worker — see below.                             |
| `limits` | `{ maxDurationSecs: 30 }` | Sandbox budget. The clock only runs while Python runs, not while a tool call is awaited. |

## The Python namespace

Each Cloudflare provider becomes a Python global with one method per tool. That namespace is _generated Python_, fed to Monty as its own snippet before the model's code:

```python
class __monty_codemode_namespace_0:
    async def list_issues(self, *args, **kwargs):
        return await __codemode_call("github", "list_issues", *args, **kwargs)

github = __monty_codemode_namespace_0()
```

`*args, **kwargs` forwarding means `f({"a": 1})`, `f(a=1)` and `f(1, 2)` all reach the resolved tool function as the argument list Cloudflare's own `ToolDispatcher` would have produced. Feeding the prelude separately keeps the model's line numbers correct in tracebacks.

Monty's JS binding has no host-object support (`methodCall` is refused with _"method calls on host objects are not supported"_) and does not dispatch `__getattr__` through a host lookup, so a generated prelude is the only way to get `github.list_issues(...)` rather than `await __codemode_call("github", "list_issues", ...)`. See [Upstream notes](#upstream-notes).

### Value boundary

Python tool inputs and the final result use a deliberately narrow conversion contract: null, booleans, finite numbers, strings, lists and string-keyed dictionaries. Python `set` values and dictionaries with non-string keys fail at this boundary instead of becoming arrays or stringifying/collapsing keys. Monty marker values plus `Date`, `ArrayBuffer` and `Uint8Array` values remain opaque. Conversion is limited to tool inputs and final results; session/interpreter state remains in Monty's representation.

## Runtime support

### Node — supported and tested

`new MontyExecutor()` starts Monty's crash-isolated subprocess pool via the native addon. The full test suite runs here.

### Cloudflare Workers — works, with caveats

Verified by actually running it: [`test/worker.e2e.mjs`](test/worker.e2e.mjs) boots `wrangler dev --local` (workerd) against the example Worker and drives Python, async tool calls, logs and tracebacks through it. Pure Python, async host tools, `asyncio.gather`, `print()` capture and tracebacks all behaved exactly as under Node.

You must supply the wasm module yourself:

```ts
import montyWasm from "./node_modules/@pydantic/monty/dist/worker/monty_wasm_runtime.wasm";
import { MontyExecutor } from "@smithclay/cloudflare-codemode-monty";
import { createMontyWasmPool } from "@smithclay/cloudflare-codemode-monty/worker";

const executor = new MontyExecutor({
  pool: () => createMontyWasmPool(montyWasm),
  limits: { maxDurationSecs: 10 },
});
```

with a `CompiledWasm` rule in `wrangler.jsonc`:

```jsonc
{ "rules": [{ "type": "CompiledWasm", "globs": ["**/*.wasm"], "fallthrough": true }] }
```

Caveats found during the spike:

- **Bundle size.** The Monty wasm runtime is ~17 MB raw, ~5.2 MB gzipped. The example Worker measures **17.9 MB / 5.5 MB gzip**. That fits the paid plan's 10 MB compressed limit but **exceeds the free plan's 3 MB**.
- **`Monty.create()` from `@pydantic/monty/wasm` does not work in workerd.** Wrangler resolves the `browser` condition, whose loader does `fetch(new URL("./monty_wasm_runtime.wasm", import.meta.url))` and fails with `Invalid URL string`. `createWorkerPool(module)` — what `createMontyWasmPool` wraps — is the supported path.
- **No preemption.** workerd has no `Worker` global, so Monty selects its in-process backend. Sessions are still isolated from one another (the worker is `Reset` between them), but a runaway snippet cannot be hard-killed. Keep `limits.maxDurationSecs` set; it is enforced inside the interpreter.
- **Production checks are smoke tests.** `npm run test:worker:smoke` deploys the example to an isolated temporary account and verifies its public GET and POST paths. It does not cover sustained load, regional behavior, or every account-level limit.
- **`@bjorn3/browser_wasi_shim`** is imported by `@pydantic/monty/wasm` but only declared as a devDependency there, so this package depends on it directly.

### Sandboxing

Monty is a sandboxed interpreter with no filesystem and no network, and this package configures no mounts and no `os` callback. That is the guarantee — nothing stronger. Under Node each session is a separate subprocess (a crash takes down only that session); in a Worker the interpreter runs in-process and cannot be preempted. Treat model-written Python as untrusted input to your _tools_: the sandbox constrains what the code can reach, but every tool you expose is reachable.

## Upstream notes

Behaviour verified against `@cloudflare/codemode@0.5.1` and `@pydantic/monty@0.0.21`, and differing from what you might expect:

- **`@cloudflare/codemode` cannot be imported outside workerd.** Both `.` and `./ai` transitively `import "cloudflare:workers"` at module scope, so `resolveProvider`, `sanitizeToolName`, `generateTypes` and `runCode` are unusable under Node. This package therefore imports Cloudflare **types only** and reimplements the ~40 lines of provider normalization, approval filtering and `asSchema` validation that `createCodeTool` performs, matching upstream behaviour exactly.
- **There is no `positionalArgs`.** Nothing in 0.5.1 has that flag. What exists is a variadic contract: `ResolvedProvider.fns` is `(...args) => Promise<unknown>` and `ToolDispatcher` spreads the sandbox's argument list (upstream's own `codemode.run(name, input)` uses two). The Python prelude forwards positional arguments the same way.
- **`runCode`/`normalizeCode` are JavaScript-specific.** `normalizeCode` parses with acorn and reshapes source into an async arrow function. Only its `stripCodeFences` step has a Python analogue, which the executor applies; the rest is skipped because a Monty snippet is already a program whose trailing expression is its result.
- **`ResolvedProvider.prelude`** is sandbox-side _JavaScript_ and is rejected here. Expose equivalent behavior as a resolved host function; silently ignoring an override would change tool semantics.
- **Monty maps Python `dict` to a JS `Map`** and `set` to a `Set`. Tool inputs and the final result are converted to plain objects/arrays so JSON Schema validation and JSON serialization work.
- **Awaiting a host function requires it to return a promise.** The dispatcher is always `async`, so `await codemode.tool(...)` always works.
- **Monty's importable stdlib is small** — `asyncio`, `json`, `math`, `re`, `datetime`, `itertools`, `collections` and `os` resolve; `random`, `functools`, `statistics`, `base64`, `hashlib` and `urllib` do not. The generated tool description says so.

## Not implemented in v0

Cloudflare's `createCodemodeRuntime`, snapshots, Durable Object persistence, resumable execution, approvals, rollback, R2 snapshot storage, MCP/OpenAPI adapters, filesystem emulation, Python package installation, streaming logs, caching, execution pooling beyond Monty's own. Cloudflare's `ExecuteOptions.connectors` (Workers-RPC connector bindings) and JavaScript `ResolvedProvider.prelude` values are rejected with clear errors rather than silently ignored.

## Development

```bash
npm install
npm test          # vitest: executor, tool, bridge, AI SDK integration (Node)
npm run test:worker  # boots wrangler dev and runs Python inside workerd
npm run test:worker:smoke  # temporary production deployment + public GET/POST checks
npm run typecheck
npm run format:check  # Oxfmt
npm run lint          # OXLint correctness and suspicious rules
npm run build
npm run check     # build + format + lint + typecheck + test
```

`examples/ai-sdk.ts` needs `ANTHROPIC_API_KEY`:

```bash
ANTHROPIC_API_KEY=... npx tsx examples/ai-sdk.ts
```

## Releases and security

The public npm release path uses npm trusted publishing (GitHub Actions OIDC) and npm provenance; no long-lived npm publish token is stored in this repository. See the [release setup and process](docs/releasing.md), and report vulnerabilities through the [security policy](SECURITY.md).

## License

MIT
