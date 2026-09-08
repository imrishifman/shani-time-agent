import type { FunctionDeclaration } from "@google/genai";
import { z } from "zod";
import { DateTime } from "luxon";
import * as gcal from "../calendar/google.js";
import { findFreeSlots } from "../calendar/analyze.js";
import { isCategory } from "../calendar/classify.js";
import type { CalEvent } from "../calendar/types.js";
import { deletePreference, getProposal, kvSet, pendingProposals, resolveProposal, setPreference } from "../db.js";
import { log } from "../logger.js";
import { TZ, now } from "../time.js";
import { applyOperations } from "./apply.js";
import { toVertexSchemaObject } from "./schema-convert.js";

export type AgentTool = {
  declaration: FunctionDeclaration;
  run: (args: Record<string, unknown>) => Promise<string>;
};

/**
 * Wraps a Zod schema and handler into a Gemini function declaration.
 * Arguments are validated before the handler runs; a validation failure is returned
 * to the model as text so it can correct itself instead of crashing the turn.
 */
function defineTool<S extends z.ZodType>(opts: {
  name: string;
  description: string;
  inputSchema: S;
  run: (args: z.infer<S>) => Promise<string>;
}): AgentTool {
  return {
    declaration: {
      name: opts.name,
      description: opts.description,
      parameters: toVertexSchemaObject(opts.inputSchema) as FunctionDeclaration["parameters"],
    },
    run: async (raw) => {
      const parsed = opts.inputSchema.safeParse(raw ?? {});
      if (!parsed.success) {
        const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
        return `Invalid arguments for ${opts.name}: ${detail}`;
      }
      try {
        return await opts.run(parsed.data);
      } catch (err) {
        log.error(`Tool ${opts.name} failed`, err);
        return `${opts.name} failed: ${err instanceof Error ? err.message : String(err)}`;
      }
    },
  };
}

const fmt = (e: CalEvent) =>
  `${e.allDay ? "all-day" : `${e.start.slice(0, 16)} → ${e.end.slice(11, 16)}`} | ${e.title} [${e.category}]${e.location ? ` @ ${e.location}` : ""} (event_id=${e.id}, calendar_id=${e.calendarId})`;

const localIso = (s: string) => {
  const dt = DateTime.fromISO(s, { zone: TZ });
  if (!dt.isValid) throw new Error(`Invalid datetime "${s}": ${dt.invalidExplanation}`);
  return dt.toISO()!;
};

export const getEvents = defineTool({
  name: "get_events",
  description:
    "List calendar events between two dates (from_date inclusive, to_date exclusive). Use this before answering any question about her schedule or before changing anything.",
  inputSchema: z.object({
    from_date: z.string().describe("YYYY-MM-DD"),
    to_date: z.string().describe("YYYY-MM-DD, exclusive. For a single day, use the next day."),
  }),
  run: async ({ from_date, to_date }) => {
    const from = DateTime.fromISO(from_date, { zone: TZ }).startOf("day");
    const to = DateTime.fromISO(to_date, { zone: TZ }).startOf("day");
    if (!from.isValid || !to.isValid) return "Dates must be YYYY-MM-DD.";
    const events = await gcal.listEvents(from.toISO()!, to.toISO()!);
    if (!events.length) return `No events between ${from_date} and ${to_date}.`;
    return events.map(fmt).join("\n");
  },
});

export const findFree = defineTool({
  name: "find_free_slots",
  description: "Find free time slots of at least min_minutes between two dates, within waking hours.",
  inputSchema: z.object({
    from_date: z.string().describe("YYYY-MM-DD"),
    to_date: z.string().describe("YYYY-MM-DD, exclusive"),
    min_minutes: z.number().int().min(15).default(60),
    earliest: z.string().default("08:00").describe("HH:MM"),
    latest: z.string().default("22:00").describe("HH:MM"),
  }),
  run: async ({ from_date, to_date, min_minutes, earliest, latest }) => {
    const from = DateTime.max(DateTime.fromISO(from_date, { zone: TZ }).startOf("day"), now());
    const to = DateTime.fromISO(to_date, { zone: TZ }).startOf("day");
    const events = await gcal.listEvents(from.startOf("day").toISO()!, to.toISO()!);
    const slots = findFreeSlots(events, from.toISO()!, to.toISO()!, min_minutes, { start: earliest, end: latest });
    if (!slots.length) return "No free slots found.";
    return slots.map((s) => `${s.start.slice(0, 16)} → ${s.end.slice(11, 16)} (${s.minutes} min)`).join("\n");
  },
});

export const createEvent = defineTool({
  name: "create_event",
  description: "Create a new calendar event.",
  inputSchema: z.object({
    title: z.string(),
    start: z.string().describe("Local ISO datetime, e.g. 2026-09-08T14:00"),
    end: z.string().describe("Local ISO datetime"),
    all_day: z.boolean().default(false),
    location: z.string().optional(),
    description: z.string().optional(),
    category: z.enum(["school", "work", "personal", "other"]).optional().describe("Remembered so the event is classified correctly"),
  }),
  run: async (input) => {
    const ev = await gcal.createEvent({
      title: input.title,
      start: localIso(input.start),
      end: localIso(input.end),
      allDay: input.all_day,
      location: input.location,
      description: input.description,
    });
    if (input.category) setPreference(`category:${ev.id}`, input.category);
    return `Created: ${fmt(ev)}`;
  },
});

export const updateEvent = defineTool({
  name: "update_event",
  description: "Move or edit an existing event. Only the fields you pass are changed. To move an event, pass both start and end.",
  inputSchema: z.object({
    event_id: z.string(),
    calendar_id: z.string(),
    title: z.string().optional(),
    start: z.string().optional().describe("Local ISO datetime"),
    end: z.string().optional().describe("Local ISO datetime"),
    location: z.string().optional(),
    description: z.string().optional(),
  }),
  run: async ({ event_id, calendar_id, ...patch }) => {
    const ev = await gcal.updateEvent(calendar_id, event_id, {
      ...patch,
      start: patch.start ? localIso(patch.start) : undefined,
      end: patch.end ? localIso(patch.end) : undefined,
    });
    return `Updated: ${fmt(ev)}`;
  },
});

export const deleteEvent = defineTool({
  name: "delete_event",
  description: "Delete an event. Destructive: only call with confirmed=true after she explicitly confirmed this specific event.",
  inputSchema: z.object({
    event_id: z.string(),
    calendar_id: z.string(),
    confirmed: z.boolean().describe("true only if she explicitly confirmed deleting this event"),
  }),
  run: async ({ event_id, calendar_id, confirmed }) => {
    if (!confirmed) return "Not deleted: ask her to confirm the deletion first.";
    const ev = await gcal.getEvent(calendar_id, event_id);
    await gcal.deleteEvent(calendar_id, event_id);
    return `Deleted: ${ev ? fmt(ev) : event_id}`;
  },
});

export const savePreference = defineTool({
  name: "save_preference",
  description:
    "Remember a durable planning preference (work hours, study habits, commute, course names, reminder lead time, preferred language).",
  inputSchema: z.object({
    key: z.string().describe("snake_case key, e.g. reminder_lead_minutes, study_time_of_day, commute_minutes, work_days, keywords:school, language"),
    value: z.string(),
  }),
  run: async ({ key, value }) => {
    if (key.startsWith("category:") && !isCategory(value)) return "category values must be school, work, personal or other";
    setPreference(key, value);
    return `Saved ${key} = ${value}`;
  },
});

export const forgetPreference = defineTool({
  name: "forget_preference",
  description: "Delete a saved preference by key.",
  inputSchema: z.object({ key: z.string() }),
  run: async ({ key }) => {
    deletePreference(key);
    return `Forgot ${key}`;
  },
});

export const setEventReminder = defineTool({
  name: "set_event_reminder",
  description: "Change the reminder lead time for one specific event (minutes before start), or disable it with minutes_before=0.",
  inputSchema: z.object({
    event_id: z.string(),
    minutes_before: z.number().int().min(0).max(240),
  }),
  run: async ({ event_id, minutes_before }) => {
    setPreference(`reminder:${event_id}`, minutes_before === 0 ? "off" : String(minutes_before));
    return minutes_before === 0 ? `Reminder disabled for ${event_id}` : `Will remind ${minutes_before} min before ${event_id}`;
  },
});

export const snoozeReminders = defineTool({
  name: "snooze_reminders",
  description: "Pause all move-on reminders until a given local datetime, for example during a vacation or an exam.",
  inputSchema: z.object({ until: z.string().describe("Local ISO datetime, e.g. 2026-09-10T08:00") }),
  run: async ({ until }) => {
    const iso = localIso(until);
    kvSet("reminders_snoozed_until", iso);
    return `Reminders paused until ${iso.slice(0, 16)}`;
  },
});

export const listProposals = defineTool({
  name: "list_proposals",
  description: "Show the pending proposals from the last weekly plan with their operations.",
  inputSchema: z.object({}),
  run: async () => {
    const rows = pendingProposals();
    if (!rows.length) return "No pending proposals.";
    return rows.map((p) => `proposal ${p.label} (id=${p.id}) ${p.title}\n  why: ${p.rationale}\n  ops: ${p.operations}`).join("\n");
  },
});

export const applyProposals = defineTool({
  name: "apply_proposals",
  description: "Apply one or more pending weekly-plan proposals by id, executing their calendar operations.",
  inputSchema: z.object({
    ids: z.array(z.number().int()).min(1).describe("Proposal ids, not display numbers, from the context"),
  }),
  run: async ({ ids }) => {
    const out: string[] = [];
    for (const id of ids) {
      const p = getProposal(id);
      if (!p || p.status !== "pending") {
        out.push(`#${id}: not found or not pending`);
        continue;
      }
      try {
        const results = await applyOperations(JSON.parse(p.operations));
        resolveProposal(id, "applied", results.join("; "));
        out.push(`#${id} applied: ${results.join("; ")}`);
      } catch (err) {
        resolveProposal(id, "failed", String(err));
        out.push(`#${id} FAILED: ${String(err)}`);
      }
    }
    return out.join("\n");
  },
});

export const rejectProposals = defineTool({
  name: "reject_proposals",
  description: "Dismiss pending proposals by id. Nothing in the calendar changes.",
  inputSchema: z.object({ ids: z.array(z.number().int()).min(1) }),
  run: async ({ ids }) => {
    for (const id of ids) resolveProposal(id, "rejected");
    return `Dismissed ${ids.map((i) => `#${i}`).join(", ")}`;
  },
});

export const chatTools: AgentTool[] = [
  getEvents,
  findFree,
  createEvent,
  updateEvent,
  deleteEvent,
  savePreference,
  forgetPreference,
  setEventReminder,
  snoozeReminders,
  listProposals,
  applyProposals,
  rejectProposals,
];

export const toolsByName = new Map(chatTools.map((t) => [t.declaration.name!, t]));
