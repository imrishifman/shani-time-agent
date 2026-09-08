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
