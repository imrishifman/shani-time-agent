import "dotenv/config";
import { z } from "zod";

const csv = (s: string | undefined) =>
  (s ?? "")
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

const schema = z.object({
  // Vertex AI. On a Compute Engine VM these can stay empty: the SDK picks up the
  // project from the instance metadata and authenticates with its service account.
  GOOGLE_CLOUD_PROJECT: z.string().optional(),
  GOOGLE_CLOUD_LOCATION: z.string().default("us-central1"),
  GEMINI_MODEL: z.string().default("gemini-3.8-flash"),

  USER_NAME: z.string().default("Shani"),
  USER_WHATSAPP_NUMBER: z.string().regex(/^\+\d{8,15}$/, "E.164 phone number like +9725XXXXXXX"),
  ASSISTANT_LANGUAGE: z.string().default("en"),
  TIMEZONE: z.string().default("America/New_York"),

  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  SCHOOL_CALENDAR_IDS: z.string().optional(),
  WORK_CALENDAR_IDS: z.string().optional(),
  DEFAULT_CALENDAR_ID: z.string().default("primary"),

  WHATSAPP_PROVIDER: z.enum(["twilio", "console"]).default("twilio"),
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_WHATSAPP_FROM: z.string().optional(),
  TWILIO_TEMPLATE_CONTENT_SID: z.string().optional(),

  PORT: z.coerce.number().default(3000),
  PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  VALIDATE_TWILIO_SIGNATURE: z
    .string()
    .default("true")
    .transform((v) => v !== "false"),

  DAILY_BRIEF_CRON: z.string().default("30 7 * * *"),
  WEEKLY_PLAN_CRON: z.string().default("0 19 * * 0"),
  REMINDER_LEAD_MINUTES: z.coerce.number().int().min(1).max(120).default(10),
  QUIET_HOURS_START: z.string().regex(/^\d{2}:\d{2}$/).default("23:00"),
  QUIET_HOURS_END: z.string().regex(/^\d{2}:\d{2}$/).default("07:00"),

  DATABASE_PATH: z.string().default("./data/agent.sqlite"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`).join("\n");
  throw new Error(`Invalid configuration (check your .env):\n${issues}`);
}

const env = parsed.data;

if (env.WHATSAPP_PROVIDER === "twilio") {
  for (const k of ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN", "TWILIO_WHATSAPP_FROM"] as const) {
    if (!env[k]) throw new Error(`${k} is required when WHATSAPP_PROVIDER=twilio`);
  }
}

export const config = {
  ...env,
  schoolCalendarIds: csv(env.SCHOOL_CALENDAR_IDS),
  workCalendarIds: csv(env.WORK_CALENDAR_IDS),
  userWhatsApp: `whatsapp:${env.USER_WHATSAPP_NUMBER}`,
};

export type Config = typeof config;
