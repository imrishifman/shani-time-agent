import { DateTime } from "luxon";
import { config } from "../config.js";
import * as gcal from "../calendar/google.js";
import type { CalEvent } from "../calendar/types.js";
import { getPreference, kvGet, markReminderSent, pruneReminders, reminderAlreadySent } from "../db.js";
import { log } from "../logger.js";
import { inQuietHours, now, parse } from "../time.js";
import { sendToUser } from "../whatsapp/outbox.js";

export type Reminder = { events: CalEvent[]; current: CalEvent[]; minutesUntil: number; message: string };

export type ReminderOptions = {
  now: DateTime;
  leadMinutes: number;
  /** per-event override: minutes as string, "off", or undefined */
  override: (eventId: string) => string | undefined;
  alreadySent: (eventId: string) => boolean;
  isQuiet: (dt: DateTime) => boolean;
  snoozedUntil?: string;
  language?: string;
  graceMinutes?: number;
};

function leadFor(e: CalEvent, opts: ReminderOptions): number | null {
  const o = opts.override(e.id) ?? (e.recurringEventId ? opts.override(e.recurringEventId) : undefined);
  if (o === "off") return null;
  if (o && /^\d+$/.test(o)) return Number(o);
  return opts.leadMinutes;
}

const T = {
  en: {
    startsIn: (title: string, m: number) => `⏰ *${title}* starts in ${m} min`,
    startsNow: (title: string) => `⏰ *${title}* starts now`,
    wrapUp: (cur: string) => `Time to wrap up *${cur}* and move on.`,
    moveOn: () => `Time to move on.`,
  },
  he: {
    startsIn: (title: string, m: number) => `⏰ *${title}* מתחיל בעוד ${m} דק׳`,
    startsNow: (title: string) => `⏰ *${title}* מתחיל עכשיו`,
    wrapUp: (cur: string) => `הגיע הזמן לסיים את *${cur}* ולעבור הלאה.`,
    moveOn: () => `הגיע הזמן לעבור הלאה.`,
  },
};

/**
 * Pure function: which reminders are due right now?
 * Groups events that start at the same minute into one message.
 */
export function computeDueReminders(events: CalEvent[], opts: ReminderOptions): Reminder[] {
  const grace = opts.graceMinutes ?? 3;
  const n = opts.now;
  if (opts.snoozedUntil && n < DateTime.fromISO(opts.snoozedUntil)) return [];
  if (opts.isQuiet(n)) return [];
  const t = T[(opts.language ?? "en") as keyof typeof T] ?? T.en;

  const due = new Map<string, CalEvent[]>();
  for (const e of events) {
    if (e.allDay || e.status === "cancelled") continue;
    const lead = leadFor(e, opts);
    if (lead === null) continue;
    const start = parse(e.start);
    const fireAt = start.minus({ minutes: lead });
    if (n < fireAt || n > start.plus({ minutes: grace })) continue;
    if (opts.alreadySent(e.id)) continue;
    const key = start.toISO()!;
    due.set(key, [...(due.get(key) ?? []), e]);
  }

  const out: Reminder[] = [];
  for (const [key, group] of due) {
    const start = DateTime.fromISO(key);
    const minutesUntil = Math.max(0, Math.round(start.diff(n, "minutes").minutes));
    const current = events.filter((e) => !e.allDay && !group.includes(e) && parse(e.start) <= n && parse(e.end) > n);
    const titles = group.map((e) => e.title).join(" + ");
    const lines: string[] = [];
    lines.push(minutesUntil > 0 ? t.startsIn(titles, minutesUntil) : t.startsNow(titles));
    const first = group[0];
    const range = `${first.start.slice(11, 16)}–${first.end.slice(11, 16)}`;
    const loc = group.find((e) => e.location)?.location;
    lines.push(`${range}${loc ? ` · 📍 ${loc}` : ""}`);
    lines.push(current.length ? t.wrapUp(current.map((e) => e.title).join(", ")) : t.moveOn());
    out.push({ events: group, current, minutesUntil, message: lines.join("\n") });
  }
  return out;
}

// ---- runtime -------------------------------------------------------------

let cache: { fetchedAt: DateTime; events: CalEvent[] } | undefined;
let running = false;

async function upcomingEvents(n: DateTime): Promise<CalEvent[]> {
  if (cache && n.diff(cache.fetchedAt, "minutes").minutes < 2) return cache.events;
  const events = await gcal.listEvents(n.minus({ hours: 6 }).toISO()!, n.plus({ hours: 4 }).toISO()!);
  cache = { fetchedAt: n, events };
  return events;
}

/** Called every minute by the scheduler. */
export async function reminderTick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    if (!gcal.isAuthorized()) return;
    const n = now();
    const events = await upcomingEvents(n);
    const language = getPreference("language") ?? config.ASSISTANT_LANGUAGE;
    const due = computeDueReminders(events, {
      now: n,
      leadMinutes: Number(getPreference("reminder_lead_minutes") ?? config.REMINDER_LEAD_MINUTES),
      override: (id) => getPreference(`reminder:${id}`),
      alreadySent: (id) => reminderAlreadySent(id, "start"),
      isQuiet: (dt) => inQuietHours(dt),
      snoozedUntil: kvGet<string>("reminders_snoozed_until"),
      language,
    });
    for (const r of due) {
      for (const e of r.events) markReminderSent(e.id, "start");
      try {
        await sendToUser(r.message, "reminder", { queueIfClosed: false });
      } catch (err) {
        log.error("Failed to send reminder", err);
      }
    }
    if (n.minute === 0) pruneReminders(n.minus({ days: 7 }).toUTC().toISO()!);
  } catch (err) {
    log.error("Reminder tick failed", err);
  } finally {
    running = false;
  }
}
