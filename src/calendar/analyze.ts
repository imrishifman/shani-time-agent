import { DateTime } from "luxon";
import type { CalEvent, Category } from "./types.js";
import { minutesBetween, overlaps, parse, TZ } from "../time.js";

export type DaySummary = {
  date: string; // YYYY-MM-DD
  weekday: string;
  events: CalEvent[];
  minutesByCategory: Record<Category, number>;
  busyMinutes: number;
  firstStart?: string;
  lastEnd?: string;
  longestBackToBackMinutes: number;
  hasLunchBreak: boolean;
  freeBlocks: { start: string; end: string; minutes: number }[];
  flags: string[];
};

export type WeekAnalysis = {
  weekStart: string;
  weekEnd: string;
  days: DaySummary[];
  conflicts: { a: CalEvent; b: CalEvent }[];
  totals: Record<Category, number>;
  flags: string[];
};

export type AnalyzeOptions = {
  dayStart?: string; // "08:00"
  dayEnd?: string; // "22:00"
  minFreeBlockMinutes?: number;
  backToBackGapMinutes?: number;
};

const CATS: Category[] = ["school", "work", "personal", "other"];

function zeroCats(): Record<Category, number> {
  return { school: 0, work: 0, personal: 0, other: 0 };
}

/**
 * Deterministic weekly analysis. Pure function: events in, structured summary out.
 * `weekStartIso` should be local midnight of the first day; the week is 7 days.
 */
export function analyzeWeek(events: CalEvent[], weekStartIso: string, opts: AnalyzeOptions = {}): WeekAnalysis {
  const dayStart = opts.dayStart ?? "08:00";
  const dayEnd = opts.dayEnd ?? "22:00";
  const minFree = opts.minFreeBlockMinutes ?? 90;
  const b2bGap = opts.backToBackGapMinutes ?? 15;

  const ws = DateTime.fromISO(weekStartIso, { zone: TZ }).startOf("day");
  const we = ws.plus({ days: 7 });
  const timed = events.filter((e) => !e.allDay);

  const days: DaySummary[] = [];
  for (let i = 0; i < 7; i++) {
    const d0 = ws.plus({ days: i });
    const d1 = d0.plus({ days: 1 });
    const date = d0.toISODate()!;
    const dayEvents = events
      .filter((e) => parse(e.start) < d1 && parse(e.end) > d0)
      .sort((a, b) => a.start.localeCompare(b.start));
    const dayTimed = dayEvents.filter((e) => !e.allDay);

    const minutesByCategory = zeroCats();
    for (const e of dayTimed) {
      const s = DateTime.max(parse(e.start), d0);
      const en = DateTime.min(parse(e.end), d1);
      minutesByCategory[e.category] += Math.max(0, en.diff(s, "minutes").minutes);
    }
    const busyMinutes = CATS.reduce((acc, c) => acc + minutesByCategory[c], 0);

    // back-to-back streaks
    let longest = 0;
    let streakStart: string | undefined;
    let streakEnd: string | undefined;
    for (const e of dayTimed) {
      if (streakEnd && minutesBetween(streakEnd, e.start) <= b2bGap) {
        streakEnd = e.end > streakEnd ? e.end : streakEnd;
      } else {
        streakStart = e.start;
        streakEnd = e.end;
      }
      longest = Math.max(longest, minutesBetween(streakStart!, streakEnd!));
    }

    // free blocks inside the waking window
    const winStart = d0.set({ hour: +dayStart.slice(0, 2), minute: +dayStart.slice(3) });
    const winEnd = d0.set({ hour: +dayEnd.slice(0, 2), minute: +dayEnd.slice(3) });
    const freeBlocks: DaySummary["freeBlocks"] = [];
    let cursor = winStart;
    for (const e of dayTimed) {
      const s = parse(e.start);
      const en = parse(e.end);
      if (s > cursor) {
        const gapEnd = DateTime.min(s, winEnd);
        const mins = gapEnd.diff(cursor, "minutes").minutes;
        if (mins >= minFree && cursor < winEnd) freeBlocks.push({ start: cursor.toISO()!, end: gapEnd.toISO()!, minutes: Math.round(mins) });
      }
      if (en > cursor) cursor = en;
    }
    if (cursor < winEnd) {
      const mins = winEnd.diff(cursor, "minutes").minutes;
      if (mins >= minFree) freeBlocks.push({ start: cursor.toISO()!, end: winEnd.toISO()!, minutes: Math.round(mins) });
    }

    // lunch break: any 30+ minute gap touching 11:30–15:00
    const lunchStart = d0.set({ hour: 11, minute: 30 });
    const lunchEnd = d0.set({ hour: 15, minute: 0 });
    let hasLunchBreak = true;
    if (dayTimed.some((e) => parse(e.start) < lunchEnd && parse(e.end) > lunchStart)) {
      hasLunchBreak = false;
      let c = lunchStart;
      for (const e of dayTimed) {
        const s = parse(e.start);
        const en = parse(e.end);
        if (s > c && DateTime.min(s, lunchEnd).diff(c, "minutes").minutes >= 30) hasLunchBreak = true;
        if (en > c) c = en;
      }
      if (lunchEnd.diff(c, "minutes").minutes >= 30) hasLunchBreak = true;
    }

    const flags: string[] = [];
    if (busyMinutes > 10 * 60) flags.push(`long day: ${(busyMinutes / 60).toFixed(1)}h scheduled`);
    if (longest >= 4 * 60) flags.push(`${(longest / 60).toFixed(1)}h back-to-back without a break`);
    if (!hasLunchBreak) flags.push("no lunch break");
    if (minutesByCategory.school > 0 && minutesByCategory.work > 0 && busyMinutes > 8 * 60) flags.push("heavy school+work day");

    days.push({
      date,
      weekday: d0.toFormat("cccc"),
      events: dayEvents,
      minutesByCategory,
      busyMinutes,
      firstStart: dayTimed[0]?.start,
      lastEnd: dayTimed.length ? dayTimed.reduce((m, e) => (e.end > m ? e.end : m), dayTimed[0].end) : undefined,
      longestBackToBackMinutes: longest,
      hasLunchBreak,
      freeBlocks,
      flags,
    });
  }

  // conflicts
  const conflicts: WeekAnalysis["conflicts"] = [];
  for (let i = 0; i < timed.length; i++) {
    for (let j = i + 1; j < timed.length; j++) {
      const a = timed[i];
      const b = timed[j];
      if (b.start >= a.end) break; // sorted by start
      if (a.id !== b.id && overlaps(a.start, a.end, b.start, b.end)) conflicts.push({ a, b });
    }
  }

  const totals = zeroCats();
  for (const d of days) for (const c of CATS) totals[c] += d.minutesByCategory[c];

  const flags: string[] = [];
  if (conflicts.length) flags.push(`${conflicts.length} overlapping event(s)`);
  for (let i = 0; i < 6; i++) {
    const a = days[i];
    const b = days[i + 1];
    if (a.lastEnd && b.firstStart) {
      const rest = minutesBetween(a.lastEnd, b.firstStart);
      if (rest < 10 * 60) flags.push(`short night between ${a.weekday} and ${b.weekday}: ${(rest / 60).toFixed(1)}h from last event to first`);
    }
  }
  const busyDays = days.filter((d) => d.busyMinutes > 0).length;
  if (busyDays === 7) flags.push("no fully free day this week");

  return { weekStart: ws.toISO()!, weekEnd: we.toISO()!, days, conflicts, totals, flags };
}

/** Compact, LLM-friendly text rendering of the analysis. */
export function renderAnalysis(a: WeekAnalysis): string {
  const h = (m: number) => `${(m / 60).toFixed(1)}h`;
  const lines: string[] = [];
  lines.push(`Week ${a.weekStart.slice(0, 10)} → ${a.weekEnd.slice(0, 10)}`);
  lines.push(`Totals: school ${h(a.totals.school)}, work ${h(a.totals.work)}, personal ${h(a.totals.personal)}, other ${h(a.totals.other)}`);
  if (a.flags.length) lines.push(`Week flags: ${a.flags.join("; ")}`);
  for (const d of a.days) {
    lines.push("");
    lines.push(`## ${d.weekday} ${d.date} — busy ${h(d.busyMinutes)} (school ${h(d.minutesByCategory.school)}, work ${h(d.minutesByCategory.work)})${d.flags.length ? ` | FLAGS: ${d.flags.join("; ")}` : ""}`);
    for (const e of d.events) {
      const t = e.allDay ? "all-day" : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`;
      lines.push(`- [${e.category}] ${t} ${e.title}${e.location ? ` @ ${e.location}` : ""} (id=${e.id}, cal=${e.calendarId})`);
    }
    if (d.freeBlocks.length)
      lines.push(`  free: ${d.freeBlocks.map((f) => `${f.start.slice(11, 16)}–${f.end.slice(11, 16)} (${f.minutes}m)`).join(", ")}`);
  }
  if (a.conflicts.length) {
    lines.push("");
    lines.push("## Conflicts");
    for (const c of a.conflicts) lines.push(`- "${c.a.title}" (${c.a.start.slice(0, 16)}) overlaps "${c.b.title}" (${c.b.start.slice(0, 16)})`);
  }
  return lines.join("\n");
}

/** Free slots between two instants that are at least `minMinutes` long, inside the waking window. */
export function findFreeSlots(
  events: CalEvent[],
  fromIso: string,
  toIso: string,
  minMinutes: number,
  window: { start: string; end: string } = { start: "08:00", end: "22:00" },
): { start: string; end: string; minutes: number }[] {
  const from = parse(fromIso);
  const to = parse(toIso);
  const out: { start: string; end: string; minutes: number }[] = [];
  for (let d = from.startOf("day"); d < to; d = d.plus({ days: 1 })) {
    let cursor = DateTime.max(d.set({ hour: +window.start.slice(0, 2), minute: +window.start.slice(3) }), from);
    const end = DateTime.min(d.set({ hour: +window.end.slice(0, 2), minute: +window.end.slice(3) }), to);
    const dayEvents = events.filter((e) => !e.allDay && parse(e.start) < end && parse(e.end) > cursor).sort((a, b) => a.start.localeCompare(b.start));
    for (const e of dayEvents) {
      const s = parse(e.start);
      if (s > cursor) {
        const mins = DateTime.min(s, end).diff(cursor, "minutes").minutes;
        if (mins >= minMinutes) out.push({ start: cursor.toISO()!, end: DateTime.min(s, end).toISO()!, minutes: Math.round(mins) });
      }
      if (parse(e.end) > cursor) cursor = parse(e.end);
    }
    if (cursor < end) {
      const mins = end.diff(cursor, "minutes").minutes;
      if (mins >= minMinutes) out.push({ start: cursor.toISO()!, end: end.toISO()!, minutes: Math.round(mins) });
    }
  }
  return out;
}
