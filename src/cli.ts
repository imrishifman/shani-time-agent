/**
 * Local operations CLI.
 *   npm run cli -- auth               start a temporary server just for the Google OAuth flow
 *   npm run cli -- calendars          list visible calendars and their IDs
 *   npm run cli -- events [days]      print upcoming events (default 7 days)
 *   npm run cli -- analyze            print the deterministic week analysis
 *   npm run cli -- brief [--send]     generate today's brief (and optionally send it)
 *   npm run cli -- weekly [--send]    generate the weekly plan (and optionally send + store proposals)
 *   npm run cli -- chat "message"     talk to the agent from the terminal
 *   npm run cli -- reminders          dry-run: which reminders would fire right now
 *   npm run cli -- prefs              list saved preferences
 *   npm run cli -- models             probe which Gemini models this project can actually use
 */
import { GoogleGenAI } from "@google/genai";
import { config } from "./config.js";
import * as gcal from "./calendar/google.js";
import { analyzeWeek, renderAnalysis } from "./calendar/analyze.js";
import { getPreference, kvGet, listPreferences } from "./db.js";
import { inQuietHours, now } from "./time.js";
import { buildDailyBrief, buildWeeklyPlan, chat, planningWeekStart, renderWeeklyPlanMessage } from "./agent/agent.js";
import { computeDueReminders } from "./jobs/reminders.js";
import { runDailyBrief } from "./jobs/daily-brief.js";
import { runWeeklyPlan } from "./jobs/weekly-plan.js";
import { sendToUser } from "./whatsapp/outbox.js";

const [cmd, ...rest] = process.argv.slice(2);
const flag = (f: string) => rest.includes(f);

async function main() {
  switch (cmd) {
    case "auth": {
      const { createApp } = await import("./server.js");
      const app = createApp();
      const server = app.listen(config.PORT, () => {
        console.log(`\nOpen this URL in the browser where ${config.USER_NAME} is logged into Google:\n\n  ${config.PUBLIC_URL}/auth/google\n`);
        console.log(`(The OAuth redirect must be registered as ${gcal.redirectUri})\n`);
      });
      const poll = setInterval(() => {
        if (gcal.isAuthorized()) {
          console.log("Connected. You can stop this with Ctrl+C.");
          clearInterval(poll);
          server.close();
        }
      }, 1000);
      break;
    }
    case "calendars": {
      for (const c of await gcal.listCalendars()) console.log(`${c.primary ? "*" : " "} ${c.summary}\n    ${c.id}`);
      break;
    }
    case "events": {
      const days = Number(rest[0] ?? 7);
      const from = now().startOf("day");
      const events = await gcal.listEvents(from.toISO()!, from.plus({ days }).toISO()!);
      for (const e of events)
        console.log(`${e.start.slice(0, 16)} → ${e.end.slice(11, 16)}  [${e.category.padEnd(8)}] ${e.title}${e.location ? ` @ ${e.location}` : ""}`);
      console.log(`\n${events.length} event(s)`);
      break;
    }
    case "analyze": {
      const ws = planningWeekStart();
      const events = await gcal.listEvents(ws.toISO()!, ws.plus({ days: 7 }).toISO()!);
      console.log(renderAnalysis(analyzeWeek(events, ws.toISO()!)));
      break;
    }
    case "brief": {
      if (flag("--send")) console.log(await runDailyBrief());
      else console.log(await buildDailyBrief());
      break;
    }
    case "weekly": {
      if (flag("--send")) console.log(await runWeeklyPlan());
      else {
        const r = await buildWeeklyPlan();
        console.log(renderWeeklyPlanMessage(r, r.plan.proposals.map((_, i) => i + 1)));
        console.log("\n--- raw plan ---\n" + JSON.stringify(r.plan, null, 2));
      }
      break;
    }
    case "chat": {
      const text = rest.join(" ").trim();
      if (!text) throw new Error('usage: chat "message"');
      const reply = await chat(text);
      await sendToUser(reply, "chat");
      break;
    }
    case "reminders": {
      const n = now();
      const events = await gcal.listEvents(n.minus({ hours: 6 }).toISO()!, n.plus({ hours: 4 }).toISO()!);
      const due = computeDueReminders(events, {
        now: n,
        leadMinutes: Number(getPreference("reminder_lead_minutes") ?? config.REMINDER_LEAD_MINUTES),
        override: (id) => getPreference(`reminder:${id}`),
        alreadySent: () => false,
        isQuiet: (dt) => inQuietHours(dt),
        snoozedUntil: kvGet<string>("reminders_snoozed_until"),
        language: getPreference("language") ?? config.ASSISTANT_LANGUAGE,
      });
      console.log(due.length ? due.map((d) => d.message).join("\n\n") : `Nothing due at ${n.toFormat("HH:mm")}.`);
      break;
    }
    case "models": {
      // Vertex exposes a different model set than the public Gemini API docs, and it
      // varies by region. Ask the project directly instead of trusting a docs page.
      const candidates = (rest[0] ?? [
        "gemini-3.8-flash",
        "gemini-3.7-flash",
        "gemini-3.6-flash",
        "gemini-3.5-flash",
        "gemini-3-flash-preview",
        "gemini-3.1-flash-lite",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
      ].join(",")).split(",");
      const locations = ["us-central1", "global"];
      const working: string[] = [];
      for (const location of locations) {
        const client = new GoogleGenAI({
          vertexai: true,
          ...(config.GOOGLE_CLOUD_PROJECT ? { project: config.GOOGLE_CLOUD_PROJECT } : {}),
          location,
        });
        for (const model of candidates) {
          try {
            await client.models.generateContent({
              model,
              contents: [{ role: "user", parts: [{ text: "hi" }] }],
              config: { maxOutputTokens: 20 },
            });
            console.log(`  OK    ${location.padEnd(12)} ${model}`);
            working.push(`${location} ${model}`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            const code = /"code":\s*(\d+)/.exec(msg)?.[1] ?? "err";
            console.log(`  ${code === "404" ? "404  " : "FAIL "} ${location.padEnd(12)} ${model}`);
          }
        }
      }
      console.log(working.length ? `\nUsable:\n${working.map((w) => "  " + w).join("\n")}` : "\nNothing worked. Check that Vertex AI is enabled and the VM has the cloud-platform scope.");
      break;
    }
    case "prefs": {
      for (const p of listPreferences()) console.log(`${p.key} = ${p.value}`);
      break;
    }
    default:
      console.log("Commands: auth | calendars | events [days] | analyze | brief [--send] | weekly [--send] | chat \"msg\" | reminders | prefs | models");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

