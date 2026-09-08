import { DateTime } from "luxon";
import { config } from "../config.js";
import { addMessage, enqueueOutbox, kvGet, kvSet, markOutbox, pendingOutbox } from "../db.js";
import { log } from "../logger.js";
import { getProvider, WindowClosedError } from "./provider.js";

const MAX_CHUNK = 1500; // WhatsApp/Twilio limit is 1600 chars per message

/** Split long text on paragraph/line boundaries so each chunk fits in one WhatsApp message. */
export function chunkMessage(text: string, max = MAX_CHUNK): string[] {
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const para of text.split(/\n(?=\n)/)) {
    const piece = para.length > max ? para.match(new RegExp(`[\\s\\S]{1,${max}}(?:\\n|$)`, "g")) ?? [para] : [para];
    for (const p of piece) {
      if ((current + "\n" + p).length > max && current) {
        chunks.push(current.trim());
        current = p;
      } else current = current ? `${current}\n${p}` : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

const ACTIVE_FROM_KEY = "active_whatsapp_from";

/**
 * Remember which Twilio number she actually messaged, so replies go back through the
 * same conversation. An account can have several senders (a trial number and the
 * sandbox, say), and replying from the wrong one silently fails for the recipient.
 */
export function rememberActiveSender(to: string | undefined) {
  if (!to || !to.startsWith("whatsapp:")) return;
  if (kvGet<string>(ACTIVE_FROM_KEY) === to) return;
  kvSet(ACTIVE_FROM_KEY, to);
  log.info(`Replies will now be sent from ${to}`);
}

export function activeSender(): string | undefined {
  return kvGet<string>(ACTIVE_FROM_KEY) ?? config.TWILIO_WHATSAPP_FROM;
}

async function deliver(body: string): Promise<void> {
  const provider = await getProvider();
  const from = activeSender();
  for (const chunk of chunkMessage(body)) {
    await provider.send(config.userWhatsApp, chunk, from);
  }
}

/**
 * Send a message to the user. Records it in the conversation log.
 * If WhatsApp's 24h window is closed, queues it and (once per ~23h) sends the re-engagement template
 * so she can reply and re-open the window; queued messages flush on her next inbound message.
 * Returns true if delivered now.
 */
export async function sendToUser(body: string, kind = "chat", opts: { queueIfClosed?: boolean } = {}): Promise<boolean> {
  try {
    await deliver(body);
    // Recorded only after delivery succeeds. Logging on attempt made a failed send
    // look identical to a delivered one, which hid a broken sender for a full day.
    addMessage("out", body, kind);
    log.info(`Sent ${kind} message (${body.length} chars) from ${activeSender() ?? "default"}`);
    return true;
  } catch (err) {
    if (err instanceof WindowClosedError) {
      if (opts.queueIfClosed === false) {
        log.warn(`24h window closed; dropped time-sensitive ${kind} message`);
        return false;
      }
      addMessage("out", body, kind);
      enqueueOutbox(body, kind);
      log.warn(`24h window closed; queued ${kind} message`);
      await maybeSendReengagementTemplate();
      return false;
    }
    log.error(`Failed to send ${kind} message`, err);
    return false;
  }
}

async function maybeSendReengagementTemplate() {
  const sid = config.TWILIO_TEMPLATE_CONTENT_SID;
  if (!sid) {
    log.warn("No TWILIO_TEMPLATE_CONTENT_SID configured; message will wait until she writes first.");
    return;
  }
  const last = kvGet<string>("last_template_sent");
  if (last && DateTime.fromISO(last).plus({ hours: 23 }) > DateTime.now()) return;
  const provider = await getProvider();
  await provider.sendTemplate(config.userWhatsApp, sid, { 1: config.USER_NAME });
  kvSet("last_template_sent", DateTime.now().toISO());
  log.info("Sent re-engagement template");
}

/** Deliver anything that was queued while the window was closed. Call when an inbound message arrives. */
export async function flushOutbox(): Promise<number> {
  const rows = pendingOutbox();
  let sent = 0;
  for (const row of rows) {
    try {
      await deliver(row.body);
      markOutbox(row.id, "sent");
      sent++;
    } catch (err) {
      if (err instanceof WindowClosedError) break;
      markOutbox(row.id, "failed", String(err));
      log.error(`Failed to flush outbox #${row.id}`, err);
    }
  }
  if (sent) log.info(`Flushed ${sent} queued message(s)`);
  return sent;
}
