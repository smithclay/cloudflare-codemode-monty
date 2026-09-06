/**
 * The bridge between Cloudflare Code Mode's `ResolvedProvider[]` and Monty's
 * `externalLookup`.
 *
 * One host function — `__codemode_call` — serves every provider and every
 * tool. The generated Python prelude (see `prelude.ts`) is what makes
 * `codemode.get_weather({...})` reach it; this module owns the JS half:
 * resolving `(provider, tool)` back to the Cloudflare-resolved function and
 * converting Monty's Python values into the plain JS the tool expects.
 */

import type { ResolvedProvider } from "@cloudflare/codemode";

/** The single host function the Python prelude dispatches through. */
export const DISPATCH_NAME = "__codemode_call";

/** Raised for a provider set Monty cannot expose; surfaced as `ExecuteResult.error`. */
export class MontyBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MontyBridgeError";
  }
}

/**
 * Python keywords and soft keywords. A tool or provider named after one of
 * these cannot become a Python identifier, so it gets a `_` suffix — the same
 * escape Cloudflare's `sanitizeToolName` applies for JavaScript reserved words.
 */
const PYTHON_KEYWORDS = new Set([
  "False",
  "None",
  "True",
  "and",
  "as",
  "assert",
  "async",
  "await",
  "break",
  "case",
  "class",
  "continue",
  "def",
  "del",
  "elif",
  "else",
  "except",
  "finally",
  "for",
  "from",
  "global",
  "if",
  "import",
  "in",
  "is",
  "lambda",
  "match",
  "nonlocal",
  "not",
  "or",
  "pass",
  "raise",
  "return",
  "try",
  "type",
  "while",
  "with",
  "yield",
]);

/**
 * Sanitize a tool name into a valid Python identifier. Mirrors Cloudflare's
 * `sanitizeToolName` (hyphens/dots/spaces to `_`, other invalid characters
 * dropped, digit-leading names prefixed) against Python's keyword list rather
 * than JavaScript's. It is reimplemented rather than imported because
 * `@cloudflare/codemode` only loads inside workerd (it imports
 * `cloudflare:workers` at module scope) and this package also runs under Node.
 */
export function pythonName(name: string): string {
  let safe = name.replace(/[-.\s]/g, "_").replace(/[^a-zA-Z0-9_]/g, "");
  if (safe === "") return "_";
  if (/^[0-9]/.test(safe)) safe = `_${safe}`;
  if (PYTHON_KEYWORDS.has(safe)) safe = `${safe}_`;
  // Names such as `__init__` and `__slots__` affect Python class creation and
  // instance construction. The generated prelude uses a class for each
  // provider, so expose those tool names with an extra suffix instead.
  if (safe.startsWith("__") && safe.endsWith("__")) safe = `${safe}_`;
  return safe;
}

/** One provider as the sandbox sees it: a Python global with method names. */
export interface MontyNamespace {
  /** The Python global, e.g. `github`. */
  name: string;
  /** Python method name paired with the Cloudflare tool name it dispatches to. */
  tools: { pythonName: string; toolName: string }[];
}

/**
 * A validated, data-only description of the Python tool surface.
 *
 * It deliberately contains provider and tool names only — no host functions.
 * That makes it safe to reuse when a session is restored against a new host:
 * `bindToolDefinition()` verifies the new host still supplies this exact
 * surface before it creates a dispatcher.
 */
export interface MontyToolDefinition {
  namespaces: MontyNamespace[];
}

export interface MontyBridge {
  /** The `__codemode_call` implementation handed to Monty's `externalLookup`. */
  dispatch: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Convert a value Monty produced from Python at a host boundary.
 *
 * The supported contract is JSON-like values: null, booleans, finite numbers,
 * strings, arrays, and records with string keys. Monty maps Python `dict` to a
 * JS `Map`, which is converted to a plain record only when every key is a
 * string. Python sets and non-string dictionary keys are rejected rather than
 * silently changing meaning. Date, binary, and Monty marker values are passed
 * through as opaque values because this conversion is not their serializer.
 *
 * This runs only for tool inputs and final results. Monty session state remains
 * in Monty's own representation.
 */
export function montyToJs(value: unknown): unknown {
  return convertBoundaryValue(value, "value");
}

function convertBoundaryValue(value: unknown, path: string): unknown {
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value) {
      if (typeof key !== "string") {
        throw new MontyBridgeError(
          `Monty bridge only supports string dictionary keys at ${path}; received ${typeof key}`,
        );
      }
      setOwn(out, key, convertBoundaryValue(item, `${path}.${key}`));
    }
    return out;
  }
  if (value instanceof Set) {
    throw new MontyBridgeError(`Monty bridge does not support Python sets at ${path}`);
  }
  if (Array.isArray(value))
    return value.map((item, index) => convertBoundaryValue(item, `${path}[${index}]`));
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new MontyBridgeError(`Monty bridge only supports finite numbers at ${path}`);
    }
    return value;
  }
  if (typeof value !== "object") {
    throw new MontyBridgeError(`Monty bridge does not support ${typeof value} values at ${path}`);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date)
    return value;
  // Monty's marker objects (`__monty_type__`: Date/DateTime/TimeDelta/Exception)
  // are already plain and are passed through whole.
  if (Object.hasOwn(value, "__monty_type__")) return value;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new MontyBridgeError(
      `Monty bridge does not support ${value.constructor.name} values at ${path}`,
    );
  }
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    setOwn(out, key, convertBoundaryValue(item, `${path}.${key}`));
  }
  return out;
}

/** Preserve every Python dictionary key as own data, including `__proto__`. */
function setOwn(target: Record<string, unknown>, key: string, value: unknown): void {
  Object.defineProperty(target, key, {
    configurable: true,
    enumerable: true,
    value,
    writable: true,
  });
}

/**
 * Prepare the Python-visible namespace layout from a set of providers.
 *
 * This validates naming and collisions without retaining live functions, so
 * descriptions, generated Python, and a future restored execution can share
 * one stable definition.
 */
export function prepareToolDefinition(providers: ResolvedProvider[]): MontyToolDefinition {
  const namespaces: MontyNamespace[] = [];
  const claimedNamespaces = new Set<string>();

  for (const provider of providers) {
    const namespace = provider.name;
    if (namespace !== pythonName(namespace)) {
      throw new MontyBridgeError(`Provider name "${namespace}" is not a valid Python identifier`);
    }
    if (namespace === DISPATCH_NAME) {
      throw new MontyBridgeError(`Provider name "${namespace}" is reserved`);
    }
    if (claimedNamespaces.has(namespace)) {
      throw new MontyBridgeError(`Duplicate provider name "${namespace}"`);
    }
    claimedNamespaces.add(namespace);

    const tools: MontyNamespace["tools"] = [];
    const claimed = new Map<string, string>();

    for (const toolName of Object.keys(provider.fns)) {
      const method = pythonName(toolName);
      const existing = claimed.get(method);
      if (existing !== undefined && existing !== toolName) {
        throw new MontyBridgeError(
          `Tool names "${existing}" and "${toolName}" both sanitize to "${method}" in provider "${namespace}"`,
        );
      }
      claimed.set(method, toolName);
      tools.push({ pythonName: method, toolName });
    }

    namespaces.push({ name: namespace, tools });
  }

  return { namespaces };
}

/**
 * Bind a prepared definition to one concrete host's resolved functions.
 *
 * A host must provide the same providers and raw tool names as the definition;
 * otherwise restoration could execute code against a changed tool surface.
 */
export function bindToolDefinition(
  definition: MontyToolDefinition,
  providers: ResolvedProvider[],
): MontyBridge {
  const providersByName = new Map<string, ResolvedProvider>();
  for (const provider of providers) {
    if (providersByName.has(provider.name)) {
      throw new MontyBridgeError(
        `Duplicate provider name "${provider.name}" while binding tool definition`,
      );
    }
    providersByName.set(provider.name, provider);
  }

  if (providersByName.size !== definition.namespaces.length) {
    throw new MontyBridgeError("Host providers do not match the prepared tool definition");
  }

  // provider -> python method name -> the Cloudflare-resolved function.
  const routes = new Map<string, Map<string, (...args: unknown[]) => Promise<unknown>>>();
  for (const namespace of definition.namespaces) {
    const provider = providersByName.get(namespace.name);
    if (provider === undefined) {
      throw new MontyBridgeError(
        `Host is missing provider "${namespace.name}" from the prepared tool definition`,
      );
    }

    const fnsByToolName = new Map(Object.entries(provider.fns));
    if (fnsByToolName.size !== namespace.tools.length) {
      throw new MontyBridgeError(
        `Host tools for provider "${namespace.name}" do not match the prepared tool definition`,
      );
    }

    const fns = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    for (const { pythonName: method, toolName } of namespace.tools) {
      const fn = fnsByToolName.get(toolName);
      if (typeof fn !== "function") {
        throw new MontyBridgeError(
          `Host does not match the prepared tool definition: missing tool "${namespace.name}.${toolName}"`,
        );
      }
      fns.set(method, fn);
    }
    routes.set(namespace.name, fns);
  }

  const dispatch = async (...args: unknown[]): Promise<unknown> => {
    const [namespace, method, ...callArgs] = args as [string, string, ...unknown[]];
    const fns = routes.get(namespace);
    if (fns === undefined) {
      throw new Error(`No such tool namespace: "${namespace}"`);
    }
    const fn = fns.get(method);
    if (fn === undefined) {
      const known = [...fns.keys()].toSorted().join(", ") || "(none)";
      throw new Error(`No such tool: "${namespace}.${method}". Available: ${known}`);
    }
    // Monty hands positional args through as-is and appends keyword arguments
    // as a trailing record, which matches how Cloudflare's ToolDispatcher
    // spreads sandbox arguments into a resolved tool function.
    return await fn(...callArgs.map(montyToJs));
  };

  return { dispatch };
}
