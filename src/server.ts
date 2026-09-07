import express from "express";
import { config } from "./config.js";
import * as gcal from "./calendar/google.js";
import { log } from "./logger.js";
import { chat } from "./agent/agent.js";
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
