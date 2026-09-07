import cron from "node-cron";
import { config } from "../config.js";
import { log } from "../logger.js";
import { runDailyBrief } from "./daily-brief.js";
import { reminderTick } from "./reminders.js";
import { runWeeklyPlan } from "./weekly-plan.js";

function guard(name: string, fn: () => Promise<unknown>) {
  let busy = false;
  return async () => {
    if (busy) return;
    busy = true;
    try {
      await fn();
    } catch (err) {
      log.error(`${name} failed`, err);
    } finally {
      busy = false;
    }
  };
}

export function startScheduler() {
  const tz = config.TIMEZONE;
  for (const [name, expr] of [
    ["DAILY_BRIEF_CRON", config.DAILY_BRIEF_CRON],
    ["WEEKLY_PLAN_CRON", config.WEEKLY_PLAN_CRON],
  ]) {
    if (!cron.validate(expr)) throw new Error(`${name} is not a valid cron expression: "${expr}"`);
  }
  cron.schedule(config.DAILY_BRIEF_CRON, guard("daily brief", runDailyBrief), { timezone: tz });
  cron.schedule(config.WEEKLY_PLAN_CRON, guard("weekly plan", runWeeklyPlan), { timezone: tz });
  cron.schedule("* * * * *", guard("reminders", reminderTick), { timezone: tz });
  log.info(`Scheduler started (tz=${tz}): brief "${config.DAILY_BRIEF_CRON}", weekly "${config.WEEKLY_PLAN_CRON}", reminders every minute`);
}
