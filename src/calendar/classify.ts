import type { CalEvent, Category } from "./types.js";
import { config } from "../config.js";
import { getPreference } from "../db.js";

const SCHOOL_WORDS = [
  "lecture", "class", "seminar", "exam", "test", "quiz", "assignment", "homework", "study", "lab", "tutorial",
  "course", "university", "college", "campus", "thesis", "midterm", "final", "professor", "semester", "workshop",
  // Hebrew
  "הרצאה", "שיעור", "תרגול", "מבחן", "בוחן", "מטלה", "שיעורי בית", "לימוד", "לימודים", "מעבדה", "קורס",
  "אוניברסיטה", "מכללה", "קמפוס", "סמינר", "סמסטר", "מרצה", "הגשה",
];
const WORK_WORDS = [
  "shift", "work", "meeting", "standup", "sync", "client", "office", "1:1", "interview", "deadline", "sprint",
  "review", "call", "demo", "presentation", "project",
  // Hebrew
  "משמרת", "עבודה", "פגישה", "לקוח", "משרד", "ראיון", "פרויקט", "מצגת", "שיחה",
];
const PERSONAL_WORDS = [
  "gym", "doctor", "dentist", "birthday", "dinner", "lunch", "family", "friends", "date", "vacation", "flight",
  "therapy", "haircut", "yoga", "run", "workout",
  "חדר כושר", "רופא", "רופאה", "שיניים", "יום הולדת", "ארוחת ערב", "משפחה", "חברים", "חופשה", "טיסה", "טיפול", "אימון",
];

function hasWord(text: string, words: string[]): boolean {
  const t = text.toLowerCase();
  return words.some((w) => t.includes(w));
}

/**
 * Classify an event as school / work / personal / other.
 * Priority: explicit calendar mapping > per-event preference override > learned keyword prefs > built-in keywords.
 */
export function classify(ev: Omit<CalEvent, "category">): Category {
  if (config.schoolCalendarIds.includes(ev.calendarId)) return "school";
  if (config.workCalendarIds.includes(ev.calendarId)) return "work";

  const override = getPreference(`category:${ev.recurringEventId ?? ev.id}`);
  if (override && isCategory(override)) return override;

  const text = `${ev.title} ${ev.description ?? ""} ${ev.location ?? ""}`;

  // User-taught keywords, e.g. preference "keywords:school" = "Reichman, Dr. Levi"
  for (const cat of ["school", "work", "personal"] as const) {
    const learned = getPreference(`keywords:${cat}`);
    if (learned && hasWord(text, learned.split(",").map((s) => s.trim().toLowerCase()).filter(Boolean))) return cat;
  }

  if (hasWord(text, SCHOOL_WORDS)) return "school";
  if (hasWord(text, WORK_WORDS)) return "work";
  if (hasWord(text, PERSONAL_WORDS)) return "personal";
  return "other";
}

export function isCategory(s: string): s is Category {
  return s === "school" || s === "work" || s === "personal" || s === "other";
}
