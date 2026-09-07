export type Category = "school" | "work" | "personal" | "other";

export type CalEvent = {
  id: string;
  calendarId: string;
  title: string;
  description?: string;
  location?: string;
  /** ISO 8601 with offset. For all-day events: the local midnight of the start day. */
  start: string;
  /** ISO 8601 with offset. For all-day events: local midnight of the day AFTER the last day (exclusive). */
  end: string;
  allDay: boolean;
  category: Category;
  status?: string;
  recurringEventId?: string;
  htmlLink?: string;
};

export type NewEvent = {
  title: string;
  start: string;
  end: string;
  allDay?: boolean;
  location?: string;
  description?: string;
  calendarId?: string;
};

export type EventPatch = Partial<Pick<NewEvent, "title" | "start" | "end" | "location" | "description">>;
