import * as gcal from "../calendar/google.js";
import { buildWeeklyPlan, renderWeeklyPlanMessage } from "../agent/agent.js";
import { expirePendingProposals, insertProposal } from "../db.js";
import { log } from "../logger.js";
import { sendToUser } from "../whatsapp/outbox.js";

export async function runWeeklyPlan(): Promise<string> {
  if (!gcal.isAuthorized()) {
    log.warn("Skipping weekly plan: Google Calendar not connected");
    return "";
  }
  const result = await buildWeeklyPlan();
  const ws = result.weekStart.toISODate()!;
  // Anything still pending from previous weeks is stale now.
  expirePendingProposals(ws);
  const labels: number[] = [];
  result.plan.proposals.forEach((p, i) => {
    labels.push(i + 1);
    insertProposal(ws, i + 1, p.title, p.rationale, p.operations);
  });
  const message = renderWeeklyPlanMessage(result, labels);
  await sendToUser(message, "plan");
  log.info(`Weekly plan sent with ${result.plan.proposals.length} proposal(s)`);
  return message;
}
