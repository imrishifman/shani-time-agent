import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toVertexSchema, toVertexSchemaObject } from "../src/agent/schema-convert.js";
import { WeeklyPlan } from "../src/agent/schemas.js";

test("strips $schema and safe-integer noise", () => {
  const s = toVertexSchema(z.object({ n: z.number().int().min(15).default(60), a: z.string() }));
  assert.equal("$schema" in s, false);
  const props = s.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.n.minimum, 15, "a real bound is kept");
  assert.equal("maximum" in props.n, false, "the JS safe-int ceiling is dropped");
  assert.deepEqual(s.required, ["a"], "defaults are optional on input");
});

test("rewrites oneOf to anyOf and const to enum", () => {
  const u = z.discriminatedUnion("type", [
    z.object({ type: z.literal("create"), title: z.string() }),
    z.object({ type: z.literal("delete"), id: z.string() }),
  ]);
  const s = toVertexSchema(u);
  assert.equal("oneOf" in s, false);
  const variants = s.anyOf as Array<{ properties: Record<string, Record<string, unknown>> }>;
  assert.equal(variants.length, 2);
  assert.deepEqual(variants[0].properties.type.enum, ["create"]);
  assert.equal("const" in variants[0].properties.type, false);
});

test("the weekly plan schema converts without leftovers", () => {
  const s = JSON.stringify(toVertexSchema(WeeklyPlan, "output"));
  assert.equal(s.includes("$schema"), false);
  assert.equal(s.includes("\"oneOf\""), false);
  assert.equal(s.includes("\"const\""), false);
  assert.ok(s.includes("proposals") && s.includes("observations"));
});

test("Schema-object form uses uppercase types and drops unsupported keys", () => {
  const s = toVertexSchemaObject(
    z.object({
      title: z.string().describe("the title"),
      count: z.number().int().min(1),
      tags: z.array(z.string()),
      nested: z.object({ ok: z.boolean() }),
    }),
  );
  assert.equal(s.type, "OBJECT");
  const p = s.properties as Record<string, Record<string, unknown>>;
  assert.equal(p.title.type, "STRING");
  assert.equal(p.title.description, "the title");
  assert.equal(p.count.type, "INTEGER");
  assert.equal(p.tags.type, "ARRAY");
  assert.equal((p.tags.items as Record<string, unknown>).type, "STRING");
  assert.equal(p.nested.type, "OBJECT");
  assert.equal("additionalProperties" in s, false, "not part of the Vertex Schema object");
  assert.equal("$schema" in s, false);
});

test("nullable fields collapse to a type plus nullable", () => {
  const s = toVertexSchemaObject(z.object({ note: z.string().nullable() }), "output");
  const note = (s.properties as Record<string, Record<string, unknown>>).note;
  assert.equal(note.type, "STRING");
  assert.equal(note.nullable, true);
  assert.equal("anyOf" in note, false);
});

test("the weekly plan converts to a valid Schema object", () => {
  const s = toVertexSchemaObject(WeeklyPlan, "output");
  assert.equal(s.type, "OBJECT");
  const props = s.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.proposals.type, "ARRAY");
  const op = ((props.proposals.items as Record<string, unknown>).properties as Record<string, Record<string, unknown>>).operations;
  assert.equal(op.type, "ARRAY");
  // the discriminated union survives as anyOf with uppercase member types
  const variants = (op.items as Record<string, unknown>).anyOf as Array<Record<string, unknown>>;
  assert.ok(Array.isArray(variants) && variants.length === 4);
  assert.ok(variants.every((v) => v.type === "OBJECT"));
  const raw = JSON.stringify(s);
  assert.equal(raw.includes('"const"'), false);
  assert.equal(raw.includes('"oneOf"'), false);
  assert.equal(raw.includes("additionalProperties"), false);
});
