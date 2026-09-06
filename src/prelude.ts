/**
 * The generated Python prelude.
 *
 * Monty's JS binding has no host-object support — a method call on a host
 * object is refused with "method calls on host objects are not supported"
 * (see `answerFunctionCall` in @pydantic/monty) — and `__getattr__` is not
 * dispatched for host lookups either. So the ergonomic `github.list_issues(…)`
 * namespace the model writes against is generated Python: one class per
 * provider, one `async def` per tool, each forwarding to the single
 * `__codemode_call` host function.
 *
 * The prelude is fed to Monty as its own snippet, before the model's code, so
 * tracebacks report the model's own line numbers.
 */

import { DISPATCH_NAME, type MontyNamespace } from "./bridge.js";

/**
 * `*args, **kwargs` forwarding means `f({"a": 1})`, `f(a=1)` and `f(1, 2)` all
 * reach the host as the argument list Cloudflare's resolved tool functions
 * expect (positional args, keyword args appended as a trailing object).
 */
export function buildPrelude(namespaces: MontyNamespace[]): string {
  if (namespaces.length === 0) return "";
  // Class names are implementation details, not public provider names. Pick
  // names outside the public namespace so a provider can never overwrite
  // another provider's proxy.
  const occupied = new Set(namespaces.map(({ name }) => name));
  const blocks = namespaces.map(({ name, tools }, index) => {
    const className = implementationName(index, occupied);
    const methods = tools.map(
      ({ pythonName }) =>
        `    async def ${pythonName}(self, *args, **kwargs):\n` +
        `        return await ${DISPATCH_NAME}(${JSON.stringify(name)}, ${JSON.stringify(pythonName)}, *args, **kwargs)\n`,
    );
    const body = methods.length > 0 ? methods.join("\n") : "    pass\n";
    return `class ${className}:\n${body}\n${name} = ${className}()\n`;
  });
  return blocks.join("\n");
}

/** Allocate a Python-valid private class name that cannot shadow a provider. */
function implementationName(index: number, occupied: Set<string>): string {
  let suffix = index;
  let name = `__monty_codemode_namespace_${suffix}`;
  while (occupied.has(name)) name = `__monty_codemode_namespace_${++suffix}`;
  occupied.add(name);
  return name;
}
