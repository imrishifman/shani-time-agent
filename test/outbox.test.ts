import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMessage } from "../src/whatsapp/outbox.js";
import { inQuietHours } from "../src/time.js";
import { DateTime } from "luxon";

test("short messages are not split", () => {
  assert.deepEqual(chunkMessage("hello"), ["hello"]);
});

test("long messages split on paragraph boundaries under the limit", () => {
  const para = "x".repeat(400);
  const text = [para, para, para, para, para].join("\n\n");
  const chunks = chunkMessage(text, 1000);
  assert.ok(chunks.length >= 2);
  for (const c of chunks) assert.ok(c.length <= 1000);
  assert.equal(chunks.join("\n\n").replace(/\s/g, ""), text.replace(/\s/g, ""));
});

test("quiet hours wrap midnight", () => {
  const d = (h: number) => DateTime.fromObject({ year: 2026, month: 9, day: 8, hour: h }, { zone: "Asia/Jerusalem" });
  assert.equal(inQuietHours(d(23), "23:00", "07:00"), true);
  assert.equal(inQuietHours(d(2), "23:00", "07:00"), true);
  assert.equal(inQuietHours(d(7), "23:00", "07:00"), false);
  assert.equal(inQuietHours(d(12), "23:00", "07:00"), false);
});
