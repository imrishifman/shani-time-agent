import { google, type calendar_v3 } from "googleapis";
import type { OAuth2Client, Credentials } from "google-auth-library";
import { DateTime } from "luxon";
import { config } from "../config.js";
import { kvGet, kvSet } from "../db.js";
import { log } from "../logger.js";
import { classify } from "./classify.js";
import type { CalEvent, EventPatch, NewEvent } from "./types.js";
import { TZ } from "../time.js";

const TOKEN_KEY = "google_tokens";
const SCOPES = ["https://www.googleapis.com/auth/calendar"];

export const redirectUri = `${config.PUBLIC_URL.replace(/\/$/, "")}/auth/google/callback`;

let oauth: OAuth2Client | undefined;

function client(): OAuth2Client {
  if (oauth) return oauth;
  oauth = new google.auth.OAuth2(config.GOOGLE_CLIENT_ID, config.GOOGLE_CLIENT_SECRET, redirectUri);
  const saved = kvGet<Credentials>(TOKEN_KEY);
  if (saved) oauth.setCredentials(saved);
  oauth.on("tokens", (tokens) => {
    // Refresh tokens are only issued on first consent; merge so we never lose it.
    const merged = { ...(kvGet<Credentials>(TOKEN_KEY) ?? {}), ...tokens };
    kvSet(TOKEN_KEY, merged);
    log.debug("Google tokens refreshed");
  });
  return oauth;
}

export function isAuthorized(): boolean {
  const saved = kvGet<Credentials>(TOKEN_KEY);
  return !!saved?.refresh_token;
}

export function authUrl(): string {
  return client().generateAuthUrl({ access_type: "offline", prompt: "consent", scope: SCOPES });
}

export async function exchangeCode(code: string): Promise<void> {
  const { tokens } = await client().getToken(code);
  client().setCredentials(tokens);
  kvSet(TOKEN_KEY, { ...(kvGet<Credentials>(TOKEN_KEY) ?? {}), ...tokens });
}

function api(): calendar_v3.Calendar {
  if (!isAuthorized()) throw new Error("Google Calendar is not connected yet. Open /auth/google on the server to connect it.");
  return google.calendar({ version: "v3", auth: client() });
}

export async function listCalendars(): Promise<{ id: string; summary: string; primary: boolean; selected: boolean }[]> {
  const res = await api().calendarList.list();
  return (res.data.items ?? []).map((c) => ({
    id: c.id!,
    summary: c.summary ?? c.id!,
    primary: !!c.primary,
    // "selected" = shown in her Google Calendar UI. Hidden calendars (e.g. someone else's shared one) are ignored.
    selected: c.selected !== false,
  }));
}

function toCalEvent(calendarId: string, e: calendar_v3.Schema$Event): CalEvent | undefined {
  if (!e.id) return undefined;
  const allDay = !!e.start?.date;
  const start = allDay ? DateTime.fromISO(e.start!.date!, { zone: TZ }).toISO()! : e.start?.dateTime;
  const end = allDay ? DateTime.fromISO(e.end!.date!, { zone: TZ }).toISO()! : e.end?.dateTime;
  if (!start || !end) return undefined;
  const base = {
    id: e.id,
    calendarId,
    title: e.summary ?? "(untitled)",
    description: e.description ?? undefined,
    location: e.location ?? undefined,
    start: DateTime.fromISO(start).setZone(TZ).toISO()!,
    end: DateTime.fromISO(end).setZone(TZ).toISO()!,
    allDay,
    status: e.status ?? undefined,
    recurringEventId: e.recurringEventId ?? undefined,
    htmlLink: e.htmlLink ?? undefined,
  };
  return { ...base, category: classify(base) };
}

/** All events across all calendars the user can see, between two instants, expanded (recurring -> instances). */
export async function listEvents(fromIso: string, toIso: string): Promise<CalEvent[]> {
  const cal = api();
  const calendars = (await listCalendars()).filter((c) => c.selected);
  const all: CalEvent[] = [];
  for (const c of calendars) {
    let pageToken: string | undefined;
    do {
      const res = await cal.events.list({
        calendarId: c.id,
        timeMin: fromIso,
        timeMax: toIso,
        singleEvents: true,
        orderBy: "startTime",
        maxResults: 250,
        pageToken,
      });
      for (const e of res.data.items ?? []) {
        // skip declined invitations
        const me = e.attendees?.find((a) => a.self);
        if (me?.responseStatus === "declined") continue;
        if (e.status === "cancelled") continue;
        const ev = toCalEvent(c.id, e);
        if (ev) all.push(ev);
      }
      pageToken = res.data.nextPageToken ?? undefined;
    } while (pageToken);
  }
  all.sort((a, b) => a.start.localeCompare(b.start));
  return all;
}

export async function getEvent(calendarId: string, eventId: string): Promise<CalEvent | undefined> {
  const res = await api().events.get({ calendarId, eventId });
  return toCalEvent(calendarId, res.data);
}

function toGoogleTimes(start: string, end: string, allDay: boolean | undefined) {
  if (allDay) {
    return {
      start: { date: DateTime.fromISO(start, { zone: TZ }).toISODate() },
      end: { date: DateTime.fromISO(end, { zone: TZ }).toISODate() },
    };
  }
  return {
    start: { dateTime: DateTime.fromISO(start, { zone: TZ }).toISO(), timeZone: TZ },
    end: { dateTime: DateTime.fromISO(end, { zone: TZ }).toISO(), timeZone: TZ },
  };
}

export async function createEvent(ev: NewEvent): Promise<CalEvent> {
  const calendarId = ev.calendarId ?? config.DEFAULT_CALENDAR_ID;
  const res = await api().events.insert({
    calendarId,
    requestBody: {
      summary: ev.title,
      description: ev.description,
      location: ev.location,
      ...toGoogleTimes(ev.start, ev.end, ev.allDay),
    },
  });
  return toCalEvent(calendarId, res.data)!;
}

export async function updateEvent(calendarId: string, eventId: string, patch: EventPatch): Promise<CalEvent> {
  const current = await api().events.get({ calendarId, eventId });
  const allDay = !!current.data.start?.date;
  const body: calendar_v3.Schema$Event = {};
  if (patch.title !== undefined) body.summary = patch.title;
  if (patch.description !== undefined) body.description = patch.description;
  if (patch.location !== undefined) body.location = patch.location;
  if (patch.start || patch.end) {
    const curStart = current.data.start?.dateTime ?? current.data.start?.date!;
    const curEnd = current.data.end?.dateTime ?? current.data.end?.date!;
    Object.assign(body, toGoogleTimes(patch.start ?? curStart, patch.end ?? curEnd, allDay));
  }
  const res = await api().events.patch({ calendarId, eventId, requestBody: body });
  return toCalEvent(calendarId, res.data)!;
}

export async function deleteEvent(calendarId: string, eventId: string): Promise<void> {
  await api().events.delete({ calendarId, eventId });
}
