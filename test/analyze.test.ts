import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { analyzeWeek, findFreeSlots } from "../src/calendar/analyze.js";
import type { CalEvent } from "../src/calendar/types.js";

const TZ = "+03:00";
const ev = (id: string, day: string, s: string, e: string, category: CalEvent["category"], extra: Partial<CalEvent> = {}): CalEvent => ({
  id,
  calendarId: "primary",
  title: id,
  start: `${day}T${s}:00${TZ}`,
  end: `${day}T${e}:00${TZ}`,
  allDay: false,
  category,
  ...extra,
});

// Week of Sunday 2026-09-06
const WS = "2026-09-06T00:00:00+03:00";

test("categorizes hours per day and totals", () => {
  const events = [ev("lecture", "2026-09-06", "09:00", "12:00", "school"), ev("shift", "2026-09-06", "13:00", "18:00", "work")];
  const a = analyzeWeek(events, WS);
  assert.equal(a.days[0].minutesByCategory.school, 180);
  assert.equal(a.days[0].minutesByCategory.work, 300);
  assert.equal(a.totals.work, 300);
  assert.equal(a.days[0].hasLunchBreak, true); // 12:00–13:00 gap
});

test("detects conflicts, missing lunch, and back-to-back streaks", () => {
  const events = [
    ev("a", "2026-09-07", "09:00", "12:30", "school"),
    ev("b", "2026-09-07", "12:30", "15:00", "work"),
    ev("c", "2026-09-07", "14:00", "16:00", "work"),
  ];
  const a = analyzeWeek(events, WS);
  const mon = a.days[1];
  assert.equal(a.conflicts.length, 1);
  assert.equal(mon.hasLunchBreak, false);
  assert.ok(mon.longestBackToBackMinutes >= 7 * 60);
  assert.ok(mon.flags.some((f) => f.includes("back-to-back")));
  assert.ok(mon.flags.includes("no lunch break"));
  assert.ok(a.flags.some((f) => f.includes("overlapping")));
});

test("finds free blocks inside the waking window", () => {
  const events = [ev("a", "2026-09-08", "10:00", "12:00", "school")];
  const a = analyzeWeek(events, WS, { dayStart: "08:00", dayEnd: "20:00", minFreeBlockMinutes: 90 });
  const tue = a.days[2];
  assert.deepEqual(
    tue.freeBlocks.map((f) => [f.start.slice(11, 16), f.end.slice(11, 16), f.minutes]),
    [["08:00", "10:00", 120], ["12:00", "20:00", 480]],
  );
});

test("flags short nights between days", () => {
  const events = [ev("late", "2026-09-09", "20:00", "23:30", "work"), ev("early", "2026-09-10", "08:00", "10:00", "school")];
  const a = analyzeWeek(events, WS);
  assert.ok(a.flags.some((f) => f.includes("short night")));
});

test("findFreeSlots respects min length and the from instant", () => {
  const events = [ev("a", "2026-09-08", "09:00", "10:00", "work"), ev("b", "2026-09-08", "11:00", "17:00", "work")];
  const slots = findFreeSlots(events, "2026-09-08T08:30:00+03:00", "2026-09-09T00:00:00+03:00", 60, { start: "08:00", end: "22:00" });
  assert.deepEqual(
    slots.map((s) => [s.start.slice(11, 16), s.end.slice(11, 16)]),
    [["10:00", "11:00"], ["17:00", "22:00"]],
  );
});

test("all-day events are listed but do not count as busy time", () => {
  const events: CalEvent[] = [
    { id: "hol", calendarId: "primary", title: "Holiday", start: "2026-09-11T00:00:00+03:00", end: "2026-09-12T00:00:00+03:00", allDay: true, category: "other" },
  ];
  const a = analyzeWeek(events, WS);
  assert.equal(a.days[5].events.length, 1);
  assert.equal(a.days[5].busyMinutes, 0);
});
