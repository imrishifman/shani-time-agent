import type { Content, Part, Schema } from "@google/genai";
import { DateTime } from "luxon";
import { config } from "../config.js";
import * as gcal from "../calendar/google.js";
import { analyzeWeek, renderAnalysis } from "../calendar/analyze.js";
import type { CalEvent } from "../calendar/types.js";
import { addMessage, recentMessages } from "../db.js";
import { log } from "../logger.js";
import { fmtDateLong, now, parse, weekStart } from "../time.js";
import { getClient, MODEL, thinkingFor } from "./client.js";
import { dynamicContext, langName, STABLE_SYSTEM } from "./prompts.js";
import { WeeklyPlan, type Operation } from "./schemas.js";
import { chatTools, toolsByName } from "./tools.js";
import { toVertexSchemaObject } from "./schema-convert.js";

const MAX_TOOL_ITERATIONS = 12;

function systemInstruction(): string {
  return `${STABLE_SYSTEM}\n\n${dynamicContext()}`;
}

const fmtEv = (e: CalEvent) =>
  `- ${e.allDay ? "all-day" : `${e.start.slice(11, 16)}–${e.end.slice(11, 16)}`} ${e.title} [${e.category}]${e.location ? ` @ ${e.location}` : ""}`;

/** One-shot generation with no tools. Returns trimmed text, or empty string. */
async function generateText(prompt: string, effort: "low" | "high"): Promise<string> {
  const res = await (await getClient()).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: prompt }] }],
    config: {
      systemInstruction: systemInstruction(),
      thinkingConfig: thinkingFor(effort),
      maxOutputTokens: 4000,
    },
  });
  return (res.text ?? "").trim();
}

// ---------------------------------------------------------------------------
// Chat: inbound WhatsApp message -> reply, with a tool loop
// ---------------------------------------------------------------------------

/**
 * Handle one inbound message. Stores the inbound text; the caller sends the reply
 * (and thereby stores it) via sendToUser().
 */
export async function chat(userText: string): Promise<string> {
  addMessage("in", userText);

  const since = DateTime.utc().minus({ hours: 24 }).toISO()!;
  const history = recentMessages(30, since);
  const contents: Content[] = [];
  for (const m of history) {
    // A Gemini conversation has to start with a user turn.
    if (!contents.length && m.direction === "out") continue;
    contents.push({ role: m.direction === "in" ? "user" : "model", parts: [{ text: m.body }] });
  }
  if (!contents.length || contents[contents.length - 1].role !== "user") {
    contents.push({ role: "user", parts: [{ text: userText }] });
  }

  const declarations = chatTools.map((t) => t.declaration);

  for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
    const res = await (await getClient()).models.generateContent({
      model: MODEL,
      contents,
      config: {
        systemInstruction: systemInstruction(),
        tools: [{ functionDeclarations: declarations }],
        thinkingConfig: thinkingFor("low"),
        maxOutputTokens: 4000,
      },
    });

    const calls = res.functionCalls ?? [];
    if (!calls.length) {
      const text = (res.text ?? "").trim();
      if (text) return text;
      log.warn("Empty reply from model", { finishReason: res.candidates?.[0]?.finishReason });
      return "I got a bit lost there. Could you say that again in a different way?";
    }

    // Echo the model's turn back verbatim. It carries the thought signatures that
    // Gemini needs in order to continue its own reasoning across tool calls.
    const modelTurn = res.candidates?.[0]?.content;
    contents.push(modelTurn?.parts?.length ? modelTurn : { role: "model", parts: calls.map((c) => ({ functionCall: c })) });

    const responseParts: Part[] = [];
    for (const call of calls) {
      const tool = call.name ? toolsByName.get(call.name) : undefined;
      const result = tool
        ? await tool.run((call.args ?? {}) as Record<string, unknown>)
        : `Unknown tool: ${call.name}`;
      log.debug(`tool ${call.name} -> ${result.slice(0, 120)}`);
      responseParts.push({
        functionResponse: {
          ...(call.id ? { id: call.id } : {}),
          name: call.name,
          response: { result },
        },
      });
    }
    contents.push({ role: "user", parts: responseParts });
  }

  log.warn(`Tool loop hit ${MAX_TOOL_ITERATIONS} iterations without a final answer`);
  return "That turned into more steps than I expected. Could you narrow it down a bit?";
}

// ---------------------------------------------------------------------------
// Daily brief
// ---------------------------------------------------------------------------

export type BriefResult = { text: string; source: "model" | "fallback"; error?: string };

/**
 * Builds the morning brief. Reports its source, because the fallback is deliberately
 * indistinguishable to a reader and would otherwise hide a broken model call.
 */
export async function buildDailyBrief(day: DateTime = now()): Promise<BriefResult> {
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

  const instructions = `Write ${config.USER_NAME}'s morning brief for today in ${langName(config.ASSISTANT_LANGUAGE)}, unless a saved preference says otherwise.
Structure, all in plain WhatsApp text (bold with *asterisks*, no headers):
1. A one-line greeting that addresses her by name and names the weekday, for example "Good morning Shani, it's Tuesday." Never greet the day itself.
2. Today's events in order: "HH:MM–HH:MM *Title*" plus location if present, each on its own line.
3. One or two useful notes: a long gap and what it is good for (study if a school deadline or exam is coming, otherwise rest), a conflict, a very early or late item, or a missing lunch break. Skip this if there is nothing worth saying.
4. If there are pending weekly-plan proposals (see context), one line reminding her she can reply "apply N".
5. Last line: when tomorrow starts, or that tomorrow is free.
Under 900 characters. No filler, no motivational quotes. Output only the message text.

${data}`;

  let error: string | undefined;
  try {
    const text = await generateText(instructions, "low");
    if (text) return { text, source: "model" };
    error = "model returned empty text";
    log.warn("Empty brief from model; using fallback");
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
    log.error("Brief generation failed; using fallback", err);
  }
  // Deterministic fallback so the brief never silently disappears.
  const lines = [`Good morning ${config.USER_NAME}! ${d0.toFormat("cccc d LLL")}:`];
  lines.push(...(today.length ? today.map(fmtEv) : ["Nothing scheduled today."]));
  if (tomorrow[0]) lines.push(`Tomorrow starts ${tomorrow[0].allDay ? "with an all-day item" : `at ${tomorrow[0].start.slice(11, 16)}`}.`);
  return { text: lines.join("\n"), source: "fallback", error };
}

// ---------------------------------------------------------------------------
// Weekly plan
// ---------------------------------------------------------------------------

export type WeeklyPlanResult = { weekStart: DateTime; plan: WeeklyPlan; events: CalEvent[] };

/** The week to plan: the current one, unless it is nearly over, then next week. */
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

  const instructions = `Plan ${config.USER_NAME}'s week starting ${ws.toFormat("cccc d LLLL yyyy")}. Write all text fields in ${langName(config.ASSISTANT_LANGUAGE)}, unless a saved preference says otherwise.

Your goal is balance between school and work, not a perfect calendar:
- Point out overloaded days, missing breaks, short nights, conflicts, and days with no time to study.
- Protect study time before exams and deadlines (see "upcoming" below). If none is blocked out, propose study blocks in free slots that suit her preferences.
- Propose only concrete, minimal changes. Move flexible things (study blocks, personal tasks, self-created work tasks). Never move lectures, exams, shifts or meetings with other people unless they overlap and she must choose.
- Every operation must reference real event_id and calendar_id values from the data below, or create a new event with local times inside this week. Use local ISO datetimes like 2026-09-08T14:00.
- 0 to 6 proposals, most impactful first. If the week is fine, say so and propose nothing.
- Ask questions only about things you genuinely cannot see.

# Week analysis
${renderAnalysis(analysis)}

# Upcoming school items in the following two weeks
${upcoming.length ? upcoming.map((e) => `- ${e.start.slice(0, 10)} ${e.title}`).join("\n") : "(none visible)"}`;

  const res = await (await getClient()).models.generateContent({
    model: MODEL,
    contents: [{ role: "user", parts: [{ text: instructions }] }],
    config: {
      systemInstruction: systemInstruction(),
      thinkingConfig: thinkingFor("high"),
      responseMimeType: "application/json",
      responseSchema: toVertexSchemaObject(WeeklyPlan, "output") as Schema,
      maxOutputTokens: 16000,
    },
  });

  const raw = (res.text ?? "").trim();
  if (!raw) throw new Error(`Weekly plan returned no content (finishReason=${res.candidates?.[0]?.finishReason})`);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Weekly plan was not valid JSON: ${raw.slice(0, 200)}`);
  }
  const validated = WeeklyPlan.safeParse(parsed);
  if (!validated.success) {
    throw new Error(`Weekly plan did not match the schema: ${validated.error.issues.map((i) => i.path.join(".") + " " + i.message).join("; ")}`);
  }
  return { weekStart: ws, plan: validated.data, events };
}

/** Render a proposal's operations as short human lines for the WhatsApp message. */
export function describeOperation(op: Operation, byId: Map<string, CalEvent>): string {
  const t = (s: string) => DateTime.fromISO(s, { zone: config.TIMEZONE }).toFormat("ccc d LLL HH:mm");
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
