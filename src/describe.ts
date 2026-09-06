/**
 * Python-flavoured API documentation for the model.
 *
 * Cloudflare's `generateTypes` renders TypeScript declarations, which would be
 * actively misleading in a Python prompt, so this is the one piece of upstream
 * presentation the package replaces. It stays deliberately shallow: enough for
 * a model to see namespace, function name, description and argument shape —
 * not a JSON Schema to Python type generator.
 */

import { asSchema } from "ai";
import type { JSONSchema7, JSONSchema7Definition } from "json-schema";

/** Anything with an AI SDK / Code Mode tool shape. */
type ToolLike = {
  description?: unknown;
  inputSchema?: unknown;
  parameters?: unknown;
};

export interface DescribedTool {
  /** The name the sandbox calls, e.g. `list_issues`. */
  pythonName: string;
  tool: ToolLike;
}

const MAX_DEPTH = 6;

/** Render one provider as a Python class the model can read. */
export function describeNamespace(name: string, tools: DescribedTool[]): string {
  if (tools.length === 0) return `class ${name}:\n    pass`;
  const methods = tools.map(({ pythonName, tool }) => {
    const schema = jsonSchemaOf(tool);
    const args = schema ? renderType(schema, schema, 0) : "dict";
    const doc = docstring(tool, schema);
    return `    async def ${pythonName}(args: ${args}) -> object:${doc}`;
  });
  return `class ${name}:\n${methods.join("\n\n")}`;
}

/** Render every provider, with a short legend for the notation used. */
export function describeProviders(namespaces: { name: string; tools: DescribedTool[] }[]): string {
  const header = [
    "# Available tools. Every call is async — use `await`.",
    "# Argument shapes are written inline; a key marked `?` is optional.",
  ].join("\n");
  return [header, ...namespaces.map((ns) => describeNamespace(ns.name, ns.tools))].join("\n\n");
}

function docstring(tool: ToolLike, schema: JSONSchema7 | undefined): string {
  const lines: string[] = [];
  const description = typeof tool.description === "string" ? tool.description.trim() : "";
  if (description) lines.push(...description.split(/\r?\n/));
  for (const [field, prop] of Object.entries(schema?.properties ?? {})) {
    if (typeof prop === "object" && prop !== null && typeof prop.description === "string") {
      lines.push(`${field}: ${prop.description.replace(/\r?\n/g, " ")}`);
    }
  }
  if (lines.length === 0) return " ...";
  const body = lines.map((line) => `        ${line}`).join("\n");
  return `\n        """\n${body}\n        """`;
}

/**
 * Pull JSON Schema out of a tool's input schema. `asSchema` is the AI SDK's own
 * normalizer — the same call `@cloudflare/codemode/ai` makes — so Zod schemas,
 * `jsonSchema()` wrappers and raw Standard Schema values are all handled.
 */
function jsonSchemaOf(tool: ToolLike): JSONSchema7 | undefined {
  const raw = tool.inputSchema ?? tool.parameters;
  if (raw === null || raw === undefined) return undefined;
  try {
    return asSchema(raw as never).jsonSchema as JSONSchema7;
  } catch {
    return undefined;
  }
}

function renderType(schema: JSONSchema7Definition, root: JSONSchema7, depth: number): string {
  if (typeof schema === "boolean") return schema ? "Any" : "None";
  if (depth > MAX_DEPTH) return "Any";

  if (typeof schema.$ref === "string") {
    const resolved = resolveRef(schema.$ref, root);
    return resolved ? renderType(resolved, root, depth + 1) : "Any";
  }

  const union = schema.anyOf ?? schema.oneOf;
  if (union) {
    const parts = [...new Set(union.map((member) => renderType(member, root, depth + 1)))];
    return parts.length > 0 ? parts.join(" | ") : "Any";
  }

  if (schema.enum) {
    return `Literal[${schema.enum.map((value) => JSON.stringify(value)).join(", ")}]`;
  }
  if (schema.const !== undefined) return `Literal[${JSON.stringify(schema.const)}]`;

  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  switch (type) {
    case "string":
      return "str";
    case "integer":
      return "int";
    case "number":
      return "float";
    case "boolean":
      return "bool";
    case "null":
      return "None";
    case "array": {
      const items = Array.isArray(schema.items) ? schema.items[0] : schema.items;
      return items ? `list[${renderType(items, root, depth + 1)}]` : "list";
    }
    case "object":
      return renderObject(schema, root, depth);
    default:
      return schema.properties ? renderObject(schema, root, depth) : "Any";
  }
}

function renderObject(schema: JSONSchema7, root: JSONSchema7, depth: number): string {
  const properties = Object.entries(schema.properties ?? {});
  if (properties.length === 0) return "dict";
  const required = new Set(schema.required ?? []);
  const fields = properties.map(([key, prop]) => {
    const optional = required.has(key) ? "" : "?";
    return `${JSON.stringify(key)}${optional}: ${renderType(prop, root, depth + 1)}`;
  });
  return `{${fields.join(", ")}}`;
}

/** Resolve a local `#/$defs/...` pointer; anything else is opaque. */
function resolveRef(ref: string, root: JSONSchema7): JSONSchema7Definition | undefined {
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const rawSegment of ref.slice(2).split("/")) {
    const segment = rawSegment.replace(/~1/g, "/").replace(/~0/g, "~");
    if (node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node as JSONSchema7Definition | undefined;
}
