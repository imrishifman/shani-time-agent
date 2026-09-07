import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { DateTime } from "luxon";
import { config } from "../config.js";
import * as gcal from "../calendar/google.js";
import { analyzeWeek, renderAnalysis } from "../calendar/analyze.js";
import type { CalEvent } from "../calendar/types.js";
import { addMessage, recentMessages } from "../db.js";
import { log } from "../logger.js";
import { fmtDateLong, now, parse, weekStart } from "../time.js";
import { anthropic, FALLBACK_PARAMS, MODEL, textOf } from "./client.js";
import { dynamicContext, langName, STABLE_SYSTEM } from "./prompts.js";
import { WeeklyPlan, type Operation } from "./schemas.js";
import { chatTools } from "./tools.js";

function systemBlocks(): Anthropic.Beta.BetaTextBlockParam[] {
  return [
    { type: "text", text: STABLE_SYSTEM, cache_control: { type: "ephemeral" } },
    { type: "text", text: dynamicContext() },
  ];
}

const fmtEv = (e: CalEvent) =>
  `- ${e.allDay ? "all-day" : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`} ${e.title} [${e.category}]${e.location ? ` @ ${e.location}` : ""}`;

// ---------------------------------------------------------------------------
// Chat: inbound WhatsApp message -> reply (with tools)
// ---------------------------------------------------------------------------

/**
 * Handle one inbound message. Stores the inbound text; the caller is responsible for
 * sending (and thereby storing) the reply via sendToUser().
 */
export async function chat(userText: string): Promise<string> {
  addMessage("in", userText);

  const since = DateTime.utc().minus({ hours: 24 }).toISO()!;
  const history = recentMessages(30, since);
  const messages: Anthropic.Beta.BetaMessageParam[] = [];
  for (const m of history) {
    if (!messages.length && m.direction === "out") continue; // conversation must start with a user turn
    messages.push({ role: m.direction === "in" ? "user" : "assistant", content: m.body });
  }
  if (!messages.length || messages[messages.length - 1].role !== "user") messages.push({ role: "user", content: userText });

  const runner = anthropic.beta.messages.toolRunner({
    model: MODEL,
    max_tokens: 8000,
    system: systemBlocks(),
    tools: chatTools,
    messages,
    max_iterations: 12,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    ...FALLBACK_PARAMS,
  });

  const final = await runner;
  if (final.stop_reason === "refusal") {
    log.warn("Model refused", final.stop_details);
    return "Sorry, I can't help with that one. Anything else about your schedule?";
  }
  const text = textOf(final);
  if (!text) {
    log.warn("Empty reply from model", { stop_reason: final.stop_reason });
    return "I got a bit lost there. Could you say that again in a different way?";
  }
  return text;
}

// ---------------------------------------------------------------------------
// Daily brief
// ---------------------------------------------------------------------------

export async function buildDailyBrief(day: DateTime = now()): Promise<string> {
  const d0 = day.startOf("day");
  const d1 = d0.plus({ days: 1 });
  const d2 = d0.plus({ days: 2 });
  const events = await gcal.listEvents(d0.toISO()!, d2.toISO()!);
  const today = events.filter((e) => parse(e.start) < d1 && parse(e.end) > d0);
  const tomorrow = events.filter((e) => parse(e.start) < d2 && parse(e.end) > d1);

  const data = [
    `Date: ${fmtDateLong(d0)}`,
    `Today's events:`,
    today.length ? today.map(fmtEv).join("\n") : "(nothing scheduled)",
    ``,
    `Tomorrow's events:`,
    tomorrow.length ? tomorrow.map(fmtEv).join("\n") : "(nothing scheduled)",
  ].join("\n");

  const instructions = `Write ${config.USER_NAME}'s morning brief for today in ${langName(config.ASSISTANT_LANGUAGE)} (unless a saved preference says otherwise).
Structure, all in plain WhatsApp text (bold with *asterisks*, no headers):
1. One-line greeting with the weekday.
2. Today's events in order: "HH:MM–HH:MM *Title*" plus location if present. Keep them on separate lines.
3. One or two useful notes: a long gap and what it's good for (study if a school deadline/exam is coming, otherwise rest), a conflict, a very early/late item, or a missing lunch break. Skip this if there is nothing worth saying.
4. If there are pending weekly-plan proposals (see context), one line reminding her she can reply "apply N".
5. Last line: when tomorrow starts (first event) or that tomorrow is free.
Under 900 characters. No filler, no motivational quotes.

${data}`;

  try {
    const res = await anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: systemBlocks(),
      messages: [{ role: "user", content: instructions }],
      thinking: { type: "adaptive" },
      output_config: { effort: "low" },
      ...FALLBACK_PARAMS,
    });
    const text = textOf(res);
    if (text) return text;
    log.warn("Empty brief from model; using fallback", { stop_reason: res.stop_reason });
  } catch (err) {
    log.error("Brief generation failed; using fallback", err);
  }
  // Deterministic fallback so the brief never silently disappears.
  const lines = [`Good morning ${config.USER_NAME}! ${d0.toFormat("cccc d LLL")}:`];
  lines.push(...(today.length ? today.map(fmtEv) : ["Nothing scheduled today."]));
  if (tomorrow[0]) lines.push(`Tomorrow starts ${tomorrow[0].allDay ? "with an all-day item" : `at ${tomorrow[0].start.slice(11, 16)}`}.`);
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Weekly plan
// ---------------------------------------------------------------------------

export type WeeklyPlanResult = {
  weekStart: DateTime;
  plan: WeeklyPlan;
  events: CalEvent[];
};

/** The week to plan: the current one, unless it is nearly over (Fri/Sat), then next week. */
export function planningWeekStart(from: DateTime = now()): DateTime {
  const ws = weekStart(from);
  const daysLeft = 7 - Math.floor(from.startOf("day").diff(ws, "days").days);
  return daysLeft <= 2 ? ws.plus({ days: 7 }) : ws;
}

export async function buildWeeklyPlan(ws: DateTime = planningWeekStart()): Promise<WeeklyPlanResult> {
  const we = ws.plus({ days: 7 });
  const events = await gcal.listEvents(ws.toISO()!, we.toISO()!);
  const analysis = analyzeWeek(events, ws.toISO()!);
  const upcoming = (await gcal.listEvents(we.toISO()!, we.plus({ days: 14 }).toISO()!)).filter(
    (e) => e.category === "school" || /exam|deadline|due|submit|מבחן|הגשה/i.test(e.title),
  );

  const instructions = `Plan ${config.USER_NAME}'s week starting ${ws.toFormat("cccc d LLLL yyyy")}. Write all text fields in ${langName(config.ASSISTANT_LANGUAGE)} (unless a saved preference says otherwise).

Your goal is balance between school and work, not a perfect calendar:
- Point out overloaded days, missing breaks, short nights, conflicts, and days with no time to study.
- Protect study time before exams/deadlines (see "upcoming" below). If there is none blocked, propose study blocks in free slots that suit her preferences.
- Propose only concrete, minimal changes. Move flexible things (study blocks, personal tasks, self-created work tasks); never move lectures, exams, shifts or meetings with other people unless they overlap with something and she must choose.
- Every operation must reference real event_id/calendar_id values from the data below, or create a new event with local times inside this week. Use local ISO datetimes like 2026-09-08T14:00.
- 0–6 proposals, most impactful first. If the week is fine, say so and propose nothing.
- Questions only for things you genuinely cannot see (e.g. an assignment deadline she mentioned before).

# Week analysis
${renderAnalysis(analysis)}

# Upcoming school items in the following two weeks
${upcoming.length ? upcoming.map((e) => `- ${e.start.slice(0, 10)} ${e.title}`).join("\n") : "(none visible)"}`;

  const res = await anthropic.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    system: systemBlocks(),
    messages: [{ role: "user", content: instructions }],
    thinking: { type: "adaptive" },
    output_config: { effort: "high", format: betaZodOutputFormat(WeeklyPlan) },
    ...FALLBACK_PARAMS,
  });
  if (res.stop_reason === "refusal" || !res.parsed_output) {
    throw new Error(`Weekly plan failed: stop_reason=${res.stop_reason}`);
  }
  return { weekStart: ws, plan: res.parsed_output, events };
}

/** Render a proposal's operations as short human lines (used in the WhatsApp message). */
export function describeOperation(op: Operation, byId: Map<string, CalEvent>): string {
  const t = (s: string) => `${DateTime.fromISO(s, { zone: config.TIMEZONE }).toFormat("ccc d LLL HH:mm")}`;
  const title = (id: string) => byId.get(id)?.title ?? id;
  switch (op.type) {
    case "create":
      return `+ ${op.title}: ${t(op.start)}–${op.end.slice(11, 16)}`;
    case "move":
      return `→ move "${title(op.event_id)}" to ${t(op.new_start)}–${op.new_end.slice(11, 16)}`;
    case "update":
      return `✎ edit "${title(op.event_id)}"${op.title ? ` → "${op.title}"` : ""}`;
    case "delete":
      return `✕ remove "${title(op.event_id)}"`;
  }
}

export function renderWeeklyPlanMessage(result: WeeklyPlanResult, labels: number[]): string {
  const { weekStart: ws, plan, events } = result;
  const byId = new Map(events.map((e) => [e.id, e]));
  const lines: string[] = [];
  lines.push(`📅 *Week of ${ws.toFormat("ccc d LLL")}*`);
  lines.push(plan.headline);
  if (plan.observations.length) {
    lines.push("");
    for (const o of plan.observations.slice(0, 5)) lines.push(`• ${o}`);
  }
  if (plan.proposals.length) {
    lines.push("");
    lines.push(`*Suggestions* (reply "apply 1, 3", "apply all" or "skip 2")`);
    plan.proposals.forEach((p, i) => {
      lines.push(`${labels[i]}. *${p.title}*`);
      lines.push(`   ${p.rationale}`);
      for (const op of p.operations) lines.push(`   ${describeOperation(op, byId)}`);
    });
  } else {
    lines.push("");
    lines.push("Nothing to change this week 👍");
  }
  if (plan.questions.length) {
    lines.push("");
    for (const q of plan.questions.slice(0, 2)) lines.push(`❓ ${q}`);
  }
  return lines.join("\n");
}
