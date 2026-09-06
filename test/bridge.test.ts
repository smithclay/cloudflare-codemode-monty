import { describe, expect, it } from "vitest";
import {
  MontyBridgeError,
  bindToolDefinition,
  montyToJs,
  prepareToolDefinition,
  pythonName,
} from "../src/bridge.js";
import { buildPrelude } from "../src/prelude.js";

const fn = async () => "ok";

describe("pythonName", () => {
  it("maps tool names onto valid Python identifiers", () => {
    expect(pythonName("get-weather")).toBe("get_weather");
    expect(pythonName("list.issues now")).toBe("list_issues_now");
    expect(pythonName("2fa")).toBe("_2fa");
    expect(pythonName("weather!")).toBe("weather");
  });

  it("escapes Python keywords, including ones JavaScript does not reserve", () => {
    expect(pythonName("lambda")).toBe("lambda_");
    expect(pythonName("pass")).toBe("pass_");
    expect(pythonName("None")).toBe("None_");
    expect(pythonName("class")).toBe("class_");
  });

  it("escapes names that would change generated class semantics", () => {
    expect(pythonName("__init__")).toBe("__init___");
    expect(pythonName("__slots__")).toBe("__slots___");
  });
});

describe("montyToJs", () => {
  it("turns Python dicts (JS Maps) into plain objects, recursively", () => {
    const value = new Map<string, unknown>([
      ["a", 1],
      ["b", [new Map([["c", 2]])]],
      ["d", [1, 2]],
    ]);
    expect(montyToJs(value)).toEqual({ a: 1, b: [{ c: 2 }], d: [1, 2] });
  });

  it("passes Monty marker objects through untouched", () => {
    const marker = { __monty_type__: "Date", year: 2026, month: 9, day: 6 };
    expect(montyToJs(marker)).toBe(marker);
  });

  it("leaves primitives and binary data alone", () => {
    const bytes = new Uint8Array([1, 2]);
    expect(montyToJs(bytes)).toBe(bytes);
    expect(montyToJs(null)).toBeNull();
    expect(montyToJs("x")).toBe("x");
  });

  it("preserves __proto__ as an own dictionary key", () => {
    const result = montyToJs(new Map([["__proto__", new Map([["admin", true]])]])) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(result, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
    expect(result.admin).toBeUndefined();
    expect(result["__proto__"]).toEqual({ admin: true });
  });

  it("rejects values that would be converted with different Python semantics", () => {
    expect(() => montyToJs(new Set(["a"]))).toThrow(/does not support Python sets/);
    expect(() => montyToJs(new Map([[1, "one"]]))).toThrow(/string dictionary keys/);
    expect(() => montyToJs(Number.POSITIVE_INFINITY)).toThrow(/finite numbers/);
  });
});

describe("prepareToolDefinition", () => {
  it("rejects provider names that cannot be Python globals", () => {
    expect(() => prepareToolDefinition([{ name: "my-tools", fns: {} }])).toThrow(MontyBridgeError);
    expect(() => prepareToolDefinition([{ name: "__codemode_call", fns: {} }])).toThrow(/reserved/);
    expect(() =>
      prepareToolDefinition([
        { name: "a", fns: {} },
        { name: "a", fns: {} },
      ]),
    ).toThrow(/Duplicate/);
  });

  it("rejects two tools that collapse onto the same Python name", () => {
    expect(() =>
      prepareToolDefinition([{ name: "codemode", fns: { "a-b": fn, "a.b": fn } }]),
    ).toThrow(/both sanitize to "a_b"/);
  });
});

describe("bindToolDefinition", () => {
  it("routes a dispatch call to the resolved tool function", async () => {
    const providers = [{ name: "codemode", fns: { hello: async (a: unknown) => a } }];
    const definition = prepareToolDefinition(providers);
    const { dispatch } = bindToolDefinition(definition, providers);
    await expect(dispatch("codemode", "hello", new Map([["n", 1]]))).resolves.toEqual({ n: 1 });
    await expect(dispatch("codemode", "hello", new Map([[1, "one"]]))).rejects.toThrow(
      /string dictionary keys/,
    );
  });

  it("names the available tools when one is missing", async () => {
    const providers = [{ name: "codemode", fns: { hello: fn } }];
    const { dispatch } = bindToolDefinition(prepareToolDefinition(providers), providers);
    await expect(dispatch("codemode", "nope")).rejects.toThrow(/Available: hello/);
    await expect(dispatch("other", "hello")).rejects.toThrow(/No such tool namespace/);
  });

  it("requires a replacement host to match the prepared tool definition", () => {
    const definition = prepareToolDefinition([{ name: "codemode", fns: { hello: fn } }]);
    expect(() =>
      bindToolDefinition(definition, [{ name: "codemode", fns: { goodbye: fn } }]),
    ).toThrow(/does not match the prepared tool definition/);
  });

  it("binds an unchanged definition to a replacement host", async () => {
    const definition = prepareToolDefinition([{ name: "codemode", fns: { hello: fn } }]);
    const { dispatch } = bindToolDefinition(definition, [
      { name: "codemode", fns: { hello: async () => "replacement" } },
    ]);
    await expect(dispatch("codemode", "hello")).resolves.toBe("replacement");
  });
});

describe("buildPrelude", () => {
  it("is empty when there are no providers", () => {
    expect(buildPrelude([])).toBe("");
  });

  it("emits one class per provider, bound to a module-level global", () => {
    const prelude = buildPrelude([
      { name: "github", tools: [{ pythonName: "list_issues", toolName: "list-issues" }] },
    ]);
    expect(prelude).toContain("class __monty_codemode_namespace_0:");
    expect(prelude).toContain("async def list_issues(self, *args, **kwargs):");
    expect(prelude).toContain('await __codemode_call("github", "list_issues", *args, **kwargs)');
    expect(prelude).toContain("github = __monty_codemode_namespace_0()");
  });

  it("keeps implementation names out of the public provider namespace", () => {
    const prelude = buildPrelude([
      { name: "__monty_codemode_namespace_0", tools: [] },
      { name: "b", tools: [] },
    ]);
    expect(prelude).toContain("class __monty_codemode_namespace_1:");
    expect(prelude).toContain("__monty_codemode_namespace_0 = __monty_codemode_namespace_1()");
  });

  it("emits a usable class for a provider with no tools", () => {
    expect(buildPrelude([{ name: "empty", tools: [] }])).toContain("    pass");
  });
});
