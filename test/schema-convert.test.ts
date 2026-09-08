import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { toVertexSchema } from "../src/agent/schema-convert.js";
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
