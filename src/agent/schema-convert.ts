import { z } from "zod";

type Json = Record<string, unknown>;

const SAFE_INT_MAX = 9007199254740991;

/**
 * Zod -> JSON Schema in the dialect Vertex accepts.
 *
 * Zod 4's output is standards-compliant but carries a few things Vertex either
 * rejects or does not need:
 *  - `$schema`, which is metadata rather than a constraint
 *  - `oneOf`, where Vertex expects `anyOf`
 *  - `const`, which Vertex expresses as a single-value `enum`
 *  - the JS safe-integer bounds Zod attaches to every `.int()`
 */
export function toVertexSchema(schema: z.ZodType, io: "input" | "output" = "input"): Json {
  return sanitize(z.toJSONSchema(schema, { io }) as Json);
}

function sanitize(node: unknown): Json {
  if (Array.isArray(node)) return node.map(sanitize) as unknown as Json;
  if (node === null || typeof node !== "object") return node as Json;

  const out: Json = {};
  for (const [key, value] of Object.entries(node as Json)) {
    if (key === "$schema") continue;
    if (key === "minimum" && value === -SAFE_INT_MAX) continue;
    if (key === "maximum" && value === SAFE_INT_MAX) continue;
    if (key === "const") {
      out.enum = [value];
      continue;
    }
    out[key === "oneOf" ? "anyOf" : key] = sanitize(value);
  }
  return out;
}

const TYPE_MAP: Record<string, string> = {
  string: "STRING",
  number: "NUMBER",
  integer: "INTEGER",
  boolean: "BOOLEAN",
  array: "ARRAY",
  object: "OBJECT",
};

/** Keys the Vertex `Schema` object understands. Anything else is dropped. */
const ALLOWED = new Set([
  "type", "format", "title", "description", "nullable", "enum", "items",
  "properties", "required", "minimum", "maximum", "minItems", "maxItems", "anyOf",
]);

/**
 * Zod -> the Vertex `Schema` object (uppercase type names).
 *
 * Gemini 2.5 predates the `parametersJsonSchema` / `responseJsonSchema` fields and
 * only understands this shape, so it is the portable choice across model families.
 */
export function toVertexSchemaObject(schema: z.ZodType, io: "input" | "output" = "input"): Json {
  return toSchemaObject(toVertexSchema(schema, io));
}

function toSchemaObject(node: Json): Json {
  const out: Json = {};

  // Zod renders `.nullable()` as either a union with "null" or a type array.
  let type = node.type;
  if (Array.isArray(type)) {
    const real = type.filter((t) => t !== "null");
    if (type.includes("null")) out.nullable = true;
    type = real[0];
  }
  if (Array.isArray(node.anyOf)) {
    const variants = (node.anyOf as Json[]).filter((v) => v.type !== "null");
    if (variants.length !== (node.anyOf as Json[]).length) out.nullable = true;
    if (variants.length === 1) return { ...toSchemaObject(variants[0]), ...out };
    out.anyOf = variants.map(toSchemaObject);
  }

  for (const [key, value] of Object.entries(node)) {
    if (!ALLOWED.has(key) || key === "anyOf" || key === "type") continue;
    if (key === "properties") {
      out.properties = Object.fromEntries(Object.entries(value as Json).map(([k, v]) => [k, toSchemaObject(v as Json)]));
    } else if (key === "items") {
      out.items = toSchemaObject(value as Json);
    } else {
      out[key] = value;
    }
  }

  if (typeof type === "string" && TYPE_MAP[type]) out.type = TYPE_MAP[type];
  return out;
}
