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
  await sendToUser(brief, "brief");
  return brief;
}
