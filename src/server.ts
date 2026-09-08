import express from "express";
import { timingSafeEqual } from "node:crypto";
import { config } from "./config.js";
import * as gcal from "./calendar/google.js";
import { log } from "./logger.js";
import { buildDailyBrief, chat } from "./agent/agent.js";
import { MODEL } from "./agent/client.js";
import { listPreferences, pendingProposals, recentMessages } from "./db.js";
import { flushOutbox, sendToUser } from "./whatsapp/outbox.js";

const publicUrl = config.PUBLIC_URL.replace(/\/$/, "");

// Inbound messages are processed one at a time so two quick messages can't race each other.
let queue: Promise<void> = Promise.resolve();
function enqueue(task: () => Promise<void>) {
  queue = queue.then(task).catch((err) => log.error("Inbound processing failed", err));
}

export async function handleInbound(text: string): Promise<void> {
  await flushOutbox();
  let reply: string;
  try {
    reply = await chat(text);
  } catch (err) {
    log.error("Agent error", err);
    reply = "Something went wrong on my side. Please try again in a minute.";
  }
  await sendToUser(reply, "chat");
}

export function createApp() {
  const app = express();
  app.use(express.urlencoded({ extended: false }));
  app.use(express.json());

  /**
   * Diagnostics, disabled unless DIAG_TOKEN is set. These expose calendar-derived
   * text, so the token is compared in constant time and never logged.
   */
  const diagAuthorised = (req: express.Request): boolean => {
    const expected = config.DIAG_TOKEN;
    if (!expected) return false;
    const supplied = req.header("X-Diag-Token") ?? (typeof req.query.token === "string" ? req.query.token : "");
    const a = Buffer.from(supplied);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
  };

  const guardDiag: express.RequestHandler = (req, res, next) => {
    if (!config.DIAG_TOKEN) return res.status(404).send("Not found");
    if (!diagAuthorised(req)) return res.status(403).json({ error: "bad or missing diagnostics token" });
    next();
  };

  app.get("/diag", guardDiag, (_req, res) => {
    res.json({
      model: MODEL,
      location: config.GOOGLE_CLOUD_LOCATION,
      timezone: config.TIMEZONE,
      provider: config.WHATSAPP_PROVIDER,
      googleConnected: gcal.isAuthorized(),
      schedules: {
        dailyBrief: config.DAILY_BRIEF_CRON,
        weeklyPlan: config.WEEKLY_PLAN_CRON,
        reminderLeadMinutes: config.REMINDER_LEAD_MINUTES,
      },
      preferences: listPreferences().map((p) => p.key),
      pendingProposals: pendingProposals().length,
      recentMessages: recentMessages(10, "1970-01-01T00:00:00.000Z").map((m) => ({
        at: m.created_at,
        direction: m.direction,
        kind: m.kind,
        preview: m.body.slice(0, 300),
      })),
    });
  });

  // Generates a brief on demand and reports whether the model or the fallback wrote it.
  app.get("/diag/brief", guardDiag, async (_req, res) => {
    try {
      const brief = await buildDailyBrief();
      res.json(brief);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.get("/health", (_req, res) => {
    res.json({ ok: true, googleConnected: gcal.isAuthorized(), provider: config.WHATSAPP_PROVIDER });
  });

  // ---- Google OAuth ----
  app.get("/auth/google", (_req, res) => res.redirect(gcal.authUrl()));
  app.get("/auth/google/callback", async (req, res) => {
    const code = req.query.code;
    if (typeof code !== "string") return res.status(400).send("Missing code");
    try {
      await gcal.exchangeCode(code);
      const cals = await gcal.listCalendars();
      res.send(
        `<h2>Google Calendar connected ✅</h2><p>Calendars visible:</p><ul>${cals
          .map((c) => `<li>${c.summary}${c.primary ? " (primary)" : ""} — <code>${c.id}</code></li>`)
          .join("")}</ul><p>You can close this tab.</p>`,
      );
    } catch (err) {
      log.error("OAuth exchange failed", err);
      res.status(500).send("OAuth failed, check server logs.");
    }
  });

  // ---- Twilio WhatsApp webhook ----
  app.post("/webhooks/whatsapp", async (req, res) => {
    const params = req.body as Record<string, string>;
    if (config.WHATSAPP_PROVIDER === "twilio" && config.VALIDATE_TWILIO_SIGNATURE) {
      const { validateSignature } = await import("./whatsapp/twilio.js");
      const sig = req.header("X-Twilio-Signature");
      if (!validateSignature(sig, `${publicUrl}/webhooks/whatsapp`, params)) {
        log.warn("Rejected webhook with bad Twilio signature");
        return res.status(403).send("Bad signature");
      }
    }
    // Always answer Twilio quickly with empty TwiML; replies go out via the REST API.
    res.type("text/xml").send("<Response></Response>");

    const from = params.From ?? "";
    if (from !== config.userWhatsApp) {
      log.warn(`Ignoring message from unknown sender ${from}`);
      return;
    }
    const body = (params.Body ?? "").trim();
    const numMedia = Number(params.NumMedia ?? "0");
    if (!body) {
      if (numMedia > 0) enqueue(async () => { await sendToUser("I can only read text messages for now 🙂", "chat"); });
      return;
    }
    log.info(`Inbound: ${body.slice(0, 80)}`);
    enqueue(() => handleInbound(body));
  });

  return app;
}
