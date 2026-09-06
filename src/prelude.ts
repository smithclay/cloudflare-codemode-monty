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
  const blocks = namespaces.map(({ name, tools }) => {
    const className = `_CodeMode_${name}`;
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
