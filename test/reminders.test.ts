import "./setup.js";
import { test } from "node:test";
import assert from "node:assert/strict";
import { DateTime } from "luxon";
import { computeDueReminders, type ReminderOptions } from "../src/jobs/reminders.js";
import type { CalEvent } from "../src/calendar/types.js";

const ev = (id: string, s: string, e: string, extra: Partial<CalEvent> = {}): CalEvent => ({
  id,
  calendarId: "primary",
  title: id,
  start: `2026-09-08T${s}:00+03:00`,
  end: `2026-09-08T${e}:00+03:00`,
  allDay: false,
  category: "school",
  ...extra,
});

const at = (hhmm: string) => DateTime.fromISO(`2026-09-08T${hhmm}:00+03:00`).setZone("Asia/Jerusalem");

const base = (now: DateTime, over: Partial<ReminderOptions> = {}): ReminderOptions => ({
  now,
  leadMinutes: 10,
  override: () => undefined,
  alreadySent: () => false,
  isQuiet: () => false,
  ...over,
});

test("fires inside the lead window with wrap-up of the current event", () => {
  const events = [ev("Work shift", "08:00", "10:00", { category: "work" }), ev("Algebra", "10:00", "12:00", { location: "Room 3" })];
  const due = computeDueReminders(events, base(at("09:50")));
  assert.equal(due.length, 1);
  assert.equal(due[0].minutesUntil, 10);
  assert.match(due[0].message, /\*Algebra\* starts in 10 min/);
  assert.match(due[0].message, /10:00–12:00 · 📍 Room 3/);
  assert.match(due[0].message, /wrap up \*Work shift\*/);
});

test("does not fire before the lead window or after the grace period", () => {
  const events = [ev("Algebra", "10:00", "12:00")];
  assert.equal(computeDueReminders(events, base(at("09:49"))).length, 0);
  assert.equal(computeDueReminders(events, base(at("10:04"))).length, 0);
  assert.equal(computeDueReminders(events, base(at("10:02"))).length, 1);
});

test("respects per-event overrides, 'off', quiet hours, snooze and dedup", () => {
  const events = [ev("Algebra", "10:00", "12:00")];
  assert.equal(computeDueReminders(events, base(at("09:35"), { override: () => "30" })).length, 1);
  assert.equal(computeDueReminders(events, base(at("09:55"), { override: () => "off" })).length, 0);
  assert.equal(computeDueReminders(events, base(at("09:55"), { isQuiet: () => true })).length, 0);
  assert.equal(computeDueReminders(events, base(at("09:55"), { snoozedUntil: "2026-09-08T12:00:00+03:00" })).length, 0);
  assert.equal(computeDueReminders(events, base(at("09:55"), { alreadySent: () => true })).length, 0);
});

test("groups events starting at the same time and skips all-day events", () => {
  const events = [
    ev("Algebra", "10:00", "12:00"),
    ev("Lab", "10:00", "11:00"),
    { ...ev("Holiday", "00:00", "00:00"), allDay: true, end: "2026-09-09T00:00:00+03:00" },
  ];
  const due = computeDueReminders(events, base(at("09:52")));
  assert.equal(due.length, 1);
  assert.match(due[0].message, /Algebra \+ Lab/);
});

test("renders Hebrew templates when language is he", () => {
  const events = [ev("אלגברה", "10:00", "12:00")];
  const due = computeDueReminders(events, base(at("09:52"), { language: "he" }));
  assert.match(due[0].message, /מתחיל בעוד 8 דק/);
});
