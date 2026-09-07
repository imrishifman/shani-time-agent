import { DateTime, Interval } from "luxon";
import { config } from "./config.js";

export const TZ = config.TIMEZONE;

export const now = () => DateTime.now().setZone(TZ);
export const parse = (iso: string) => DateTime.fromISO(iso, { zone: TZ });
export const fmtTime = (iso: string) => parse(iso).toFormat("HH:mm");
export const fmtDate = (iso: string) => parse(iso).toFormat("ccc d LLL");
export const fmtDateLong = (dt: DateTime) => dt.toFormat("cccc, d LLLL yyyy");
export const isoDate = (dt: DateTime) => dt.toISODate()!;

/** Start of the "planning week" (Sunday) containing `dt`. Israeli work week is Sun–Thu. */
export function weekStart(dt: DateTime): DateTime {
  const d = dt.startOf("day");
  // luxon: weekday 1=Mon..7=Sun
  return d.weekday === 7 ? d : d.minus({ days: d.weekday });
}

export function minutesBetween(aIso: string, bIso: string): number {
  return Math.round(parse(bIso).diff(parse(aIso), "minutes").minutes);
}

export function overlaps(aStart: string, aEnd: string, bStart: string, bEnd: string): boolean {
  return Interval.fromISO(`${aStart}/${aEnd}`).overlaps(Interval.fromISO(`${bStart}/${bEnd}`));
}

/** "HH:mm" -> minutes since midnight */
export function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

/** True when `dt` falls inside the quiet-hours window (which may wrap midnight). */
export function inQuietHours(dt: DateTime, start = config.QUIET_HOURS_START, end = config.QUIET_HOURS_END): boolean {
  const m = dt.hour * 60 + dt.minute;
  const s = hhmmToMinutes(start);
  const e = hhmmToMinutes(end);
  return s <= e ? m >= s && m < e : m >= s || m < e;
}
