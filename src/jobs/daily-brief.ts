import * as gcal from "../calendar/google.js";
import { log } from "../logger.js";
import { buildDailyBrief } from "../agent/agent.js";
import { sendToUser } from "../whatsapp/outbox.js";

export async function runDailyBrief(): Promise<string> {
  if (!gcal.isAuthorized()) {
    log.warn("Skipping daily brief: Google Calendar not connected");
    return "";
  }
  const brief = await buildDailyBrief();
  if (brief.source === "fallback") log.warn(`Daily brief fell back to the plain list: ${brief.error ?? "unknown reason"}`);
  await sendToUser(brief.text, "brief");
  return brief.text;
}
