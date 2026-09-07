import { DateTime } from "luxon";
import * as gcal from "../calendar/google.js";
import { setPreference } from "../db.js";
import { TZ } from "../time.js";
import type { Operation } from "./schemas.js";

const iso = (s: string) => {
  const dt = DateTime.fromISO(s, { zone: TZ });
  if (!dt.isValid) throw new Error(`Invalid datetime "${s}"`);
  return dt.toISO()!;
};

/** Execute a list of calendar operations in order. Returns one human-readable line per operation. */
export async function applyOperations(ops: Operation[]): Promise<string[]> {
  const out: string[] = [];
  for (const op of ops) {
    switch (op.type) {
      case "create": {
        const ev = await gcal.createEvent({
          title: op.title,
          start: iso(op.start),
          end: iso(op.end),
          location: op.location ?? undefined,
          description: op.description ?? undefined,
        });
        setPreference(`category:${ev.id}`, op.category);
        out.push(`created "${ev.title}" ${ev.start.slice(0, 16)}`);
        break;
      }
      case "move": {
        const ev = await gcal.updateEvent(op.calendar_id, op.event_id, { start: iso(op.new_start), end: iso(op.new_end) });
        out.push(`moved "${ev.title}" to ${ev.start.slice(0, 16)}`);
        break;
      }
      case "update": {
        const ev = await gcal.updateEvent(op.calendar_id, op.event_id, {
          title: op.title ?? undefined,
          location: op.location ?? undefined,
          description: op.description ?? undefined,
        });
        out.push(`updated "${ev.title}"`);
        break;
      }
      case "delete": {
        const ev = await gcal.getEvent(op.calendar_id, op.event_id);
        await gcal.deleteEvent(op.calendar_id, op.event_id);
        out.push(`deleted "${ev?.title ?? op.event_id}"`);
        break;
      }
    }
  }
  return out;
}
