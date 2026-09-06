import { afterAll, describe, expect, it } from "vitest";
import type { ResolvedProvider } from "@cloudflare/codemode";
import { MontyExecutor } from "../src/index.js";

const executor = new MontyExecutor();
afterAll(() => executor.close());

/** A provider in the shape `resolveProvider()` produces: a name and raw fns. */
function provider(name: string, fns: ResolvedProvider["fns"]): ResolvedProvider {
  return { name, fns };
}

describe("pure Python", () => {
  it("returns the value of the final expression", async () => {
    await expect(executor.execute("1 + 2", [])).resolves.toEqual({ result: 3 });
  });

  it("runs control flow and comprehensions", async () => {
    const result = await executor.execute(
      "values = [1, 2, 3, 4]\nsum([x for x in values if x % 2 == 0])",
      [],
    );
    expect(result).toEqual({ result: 6 });
  });

  it("converts Python dicts into plain JS objects", async () => {
    const result = await executor.execute('{"a": 1, "b": [1, 2], "c": {"d": True}}', []);
    expect(result.result).toEqual({ a: 1, b: [1, 2], c: { d: true } });
  });

  it("strips a markdown code fence", async () => {
    await expect(executor.execute("```python\n40 + 2\n```", [])).resolves.toEqual({ result: 42 });
  });
});

describe("async tool calls", () => {
  it("awaits an async host function", async () => {
    const tools = [
      provider("codemode", { hello: async (args) => `hello ${(args as { name: string }).name}` }),
    ];
    const result = await executor.execute('await codemode.hello({"name": "Clay"})', tools);
    expect(result).toEqual({ result: "hello Clay" });
  });

  it("accepts keyword arguments as the tool input object", async () => {
    const tools = [provider("codemode", { echo: async (args) => args })];
    const result = await executor.execute('await codemode.echo(name="Clay", n=2)', tools);
    expect(result.result).toEqual({ name: "Clay", n: 2 });
  });

  it("passes __proto__ dictionary keys to tools as ordinary own properties", async () => {
    const tools = [
      provider("codemode", {
        inspect: async (args) => {
          const input = args as Record<string, unknown>;
          return {
            hasOwnProto: Object.hasOwn(input, "__proto__"),
            inheritedAdmin: input.admin === true,
            isPlainObject: Object.getPrototypeOf(input) === Object.prototype,
            protoValue: input["__proto__"],
          };
        },
      }),
    ];
    const result = await executor.execute(
      'await codemode.inspect({"__proto__": {"admin": True}})',
      tools,
    );
    expect(result).toEqual({
      result: {
        hasOwnProto: true,
        inheritedAdmin: false,
        isPlainObject: true,
        protoValue: { admin: true },
      },
    });
  });

  it("passes multiple positional arguments straight through", async () => {
    const seen: unknown[][] = [];
    const tools = [
      provider("codemode", {
        run: async (...args) => {
          seen.push(args);
          return "ok";
        },
      }),
    ];
    const result = await executor.execute('await codemode.run("snippet", {"x": 1})', tools);
    expect(result).toEqual({ result: "ok" });
    expect(seen).toEqual([["snippet", { x: 1 }]]);
  });

  it("chains one tool's output into the next", async () => {
    const tools = [
      provider("codemode", {
        first: async (args) => ({ doubled: (args as { x: number }).x * 2 }),
        second: async (args) => `got ${(args as { x: number }).x}`,
      }),
    ];
    const result = await executor.execute(
      [
        'a = await codemode.first({"x": 21})',
        'b = await codemode.second({"x": a["doubled"]})',
        "b",
      ].join("\n"),
      tools,
    );
    expect(result).toEqual({ result: "got 42" });
  });

  it("runs concurrent tool calls with asyncio.gather", async () => {
    const tools = [
      provider("codemode", {
        slow: async (args) => {
          await new Promise((resolve) => setTimeout(resolve, 20));
          return (args as { n: number }).n;
        },
      }),
    ];
    const result = await executor.execute(
      [
        "import asyncio",
        'results = await asyncio.gather(codemode.slow({"n": 1}), codemode.slow({"n": 2}))',
        "sum(results)",
      ].join("\n"),
      tools,
    );
    expect(result).toEqual({ result: 3 });
  });
});

describe("multiple providers", () => {
  it("exposes each provider under its own Python namespace", async () => {
    const tools = [
      provider("github", { list_issues: async () => [{ state: "open" }, { state: "closed" }] }),
      provider("state", { save: async (args) => ({ saved: args }) }),
    ];
    const result = await executor.execute(
      [
        "issues = await github.list_issues({})",
        'open_issues = [i for i in issues if i["state"] == "open"]',
        'saved = await state.save({"count": len(open_issues)})',
        "saved",
      ].join("\n"),
      tools,
    );
    expect(result.result).toEqual({ saved: { count: 1 } });
  });

  it("sanitizes tool names into Python identifiers", async () => {
    const tools = [provider("codemode", { "get-weather.now": async () => "sunny" })];
    const result = await executor.execute("await codemode.get_weather_now({})", tools);
    expect(result).toEqual({ result: "sunny" });
  });

  it("sanitizes Python lifecycle method names", async () => {
    const tools = [provider("codemode", { __init__: async () => "ready" })];
    const result = await executor.execute("await codemode.__init___({})", tools);
    expect(result).toEqual({ result: "ready" });
  });
});

describe("errors", () => {
  it("returns a Python traceback for a raised exception", async () => {
    const result = await executor.execute('x = 1\nraise ValueError("boom")', []);
    expect(result.result).toBeUndefined();
    expect(result.error).toContain("ValueError: boom");
    expect(result.error).toContain("line 2");
  });

  it("returns a syntax error", async () => {
    const result = await executor.execute("def (", []);
    expect(result.error).toContain("SyntaxError");
  });

  it("surfaces a throwing JS tool as a Python error", async () => {
    const tools = [
      provider("codemode", {
        boom: async () => {
          throw new Error("upstream API is down");
        },
      }),
    ];
    const result = await executor.execute("await codemode.boom({})", tools);
    expect(result.error).toContain("upstream API is down");
  });

  it("reports an unknown tool clearly", async () => {
    const tools = [provider("codemode", { hello: async () => "hi" })];
    const result = await executor.execute("await codemode.nope({})", tools);
    expect(result.error).toContain("nope");
    expect(result.error).toContain("AttributeError");
  });

  it("reports an unknown namespace clearly", async () => {
    const result = await executor.execute("await nosuch.thing({})", []);
    expect(result.error).toContain("NameError");
    expect(result.error).toContain("nosuch");
  });

  it("rejects a provider name that is not a Python identifier", async () => {
    const result = await executor.execute("1", [provider("my-tools", {})]);
    expect(result.error).toContain("not a valid Python identifier");
  });

  it("rejects duplicate provider names", async () => {
    const result = await executor.execute("1", [provider("a", {}), provider("a", {})]);
    expect(result.error).toContain("Duplicate provider");
  });

  it("rejects connector bindings, which are not supported yet", async () => {
    const result = await executor.execute("1", [], {
      connectors: [{ name: "x", binding: { callTool: async () => null } }],
    });
    expect(result.error).toContain("connector bindings");
  });

  it("never throws", async () => {
    await expect(executor.execute("raise RuntimeError('x')", [])).resolves.toBeTypeOf("object");
  });
});

describe("logs", () => {
  it("captures print output alongside the result", async () => {
    const result = await executor.execute('print("hello")\nprint("world")\n42', []);
    expect(result).toEqual({ result: 42, logs: ["hello", "world"] });
  });

  it("keeps logs when the program fails", async () => {
    const result = await executor.execute('print("before")\nraise ValueError("boom")', []);
    expect(result.logs).toEqual(["before"]);
    expect(result.error).toContain("ValueError: boom");
  });
});

describe("legacy fns record", () => {
  it("accepts a bare fns record under the default codemode namespace", async () => {
    const result = await executor.execute("await codemode.ping({})", {
      ping: async () => "pong",
    });
    expect(result).toEqual({ result: "pong" });
  });
});
