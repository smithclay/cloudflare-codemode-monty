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

export interface MontyBridge {
  namespaces: MontyNamespace[];
  /** The `__codemode_call` implementation handed to Monty's `externalLookup`. */
  dispatch: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Convert a value Monty produced from Python into plain JS.
 *
 * Monty maps a Python `dict` to a JS `Map` and a `set` to a `Set`. Cloudflare's
 * resolved tool functions validate their input against a JSON Schema (Zod or an
 * AI SDK `jsonSchema()` wrapper), which expects plain objects and arrays — so
 * every value crossing into a tool, and the final result crossing back to the
 * model, is normalized here.
 */
export function montyToJs(value: unknown): unknown {
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of value) setOwn(out, String(key), montyToJs(item));
    return out;
  }
  if (value instanceof Set) return Array.from(value, montyToJs);
  if (Array.isArray(value)) return value.map(montyToJs);
  if (value === null || typeof value !== "object") return value;
  if (value instanceof Uint8Array || value instanceof ArrayBuffer || value instanceof Date)
    return value;
  // Monty's marker objects (`__monty_type__`: Date/DateTime/TimeDelta/Exception)
  // are already plain and are passed through whole.
  if ("__monty_type__" in value) return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) setOwn(out, key, montyToJs(item));
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
 * Build the Python-visible namespace layout and the single dispatch function
 * for a set of Cloudflare-resolved providers.
 */
export function buildBridge(providers: ResolvedProvider[]): MontyBridge {
  const namespaces: MontyNamespace[] = [];
  // provider -> python method name -> the Cloudflare-resolved function.
  const routes = new Map<string, Map<string, (...args: unknown[]) => Promise<unknown>>>();

  for (const provider of providers) {
    const namespace = provider.name;
    if (namespace !== pythonName(namespace)) {
      throw new MontyBridgeError(`Provider name "${namespace}" is not a valid Python identifier`);
    }
    if (namespace === DISPATCH_NAME) {
      throw new MontyBridgeError(`Provider name "${namespace}" is reserved`);
    }
    if (routes.has(namespace)) {
      throw new MontyBridgeError(`Duplicate provider name "${namespace}"`);
    }

    const fns = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const tools: MontyNamespace["tools"] = [];
    const claimed = new Map<string, string>();

    for (const [toolName, fn] of Object.entries(provider.fns)) {
      const method = pythonName(toolName);
      const existing = claimed.get(method);
      if (existing !== undefined && existing !== toolName) {
        throw new MontyBridgeError(
          `Tool names "${existing}" and "${toolName}" both sanitize to "${method}" in provider "${namespace}"`,
        );
      }
      claimed.set(method, toolName);
      fns.set(method, fn);
      tools.push({ pythonName: method, toolName });
    }

    routes.set(namespace, fns);
    namespaces.push({ name: namespace, tools });
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

  return { namespaces, dispatch };
}
