# Shani's time-management agent

A small always-on service that watches Shani's Google Calendar and talks to her over WhatsApp:

| What | When | How |
|---|---|---|
| **Weekly plan** | Saturday 19:00 (configurable) | Scans next week, analyses school vs. work load, conflicts, missing breaks, short nights, and study time before exams. Sends numbered suggestions she can accept with "apply 1, 3". |
| **Daily brief** | 07:30 every day | Today's events in order, useful gaps, conflicts, what tomorrow starts with. |
| **Move-on reminders** | 10 min before every event (configurable per event) | "⏰ *Algebra* starts in 10 min · 📍 Room 3. Time to wrap up *Work shift* and move on." |
| **Chat** | Whenever she writes | Ask about the schedule, add/move/delete events, apply or skip proposals, teach it preferences ("I study best in the mornings", "remind me 20 minutes before"). |

Built with the Claude API (tool use + structured outputs), Google Calendar API, Twilio WhatsApp, Node 24, and SQLite for state. Everything runs in Shani's timezone (`Asia/Jerusalem` by default, week starts on Sunday).

## Architecture

```
WhatsApp (Twilio)  ──webhook──▶  Express server  ──▶  Claude agent (tools) ──▶ Google Calendar
        ▲                              │
        └────── replies / briefs ──────┘        cron: daily brief · weekly plan · reminders every minute
                                              SQLite: preferences, chat history, proposals, outbox, reminder dedup
```

```
src/
  index.ts            boots server + scheduler
  server.ts           /webhooks/whatsapp, /auth/google, /health
  cli.ts              local ops: auth, events, brief, weekly, chat, reminders …
  config.ts           env parsing (zod)
  db.ts               SQLite (node:sqlite) schema + helpers
  time.ts             timezone helpers (luxon)
  calendar/
    google.ts         OAuth + list/create/update/delete
    classify.ts       school / work / personal / other
    analyze.ts        deterministic week analysis + free-slot search
  agent/
    prompts.ts        cached system prompt + dynamic context
    tools.ts          calendar/preference/proposal tools (betaZodTool)
    schemas.ts        WeeklyPlan structured-output schema
    agent.ts          chat(), buildDailyBrief(), buildWeeklyPlan()
    apply.ts          executes proposal operations
  jobs/
    reminders.ts      pure computeDueReminders() + minute tick
    daily-brief.ts, weekly-plan.ts, scheduler.ts
  whatsapp/
    provider.ts, twilio.ts, console.ts, outbox.ts (24h-window handling)
```

## Setup

### 1. Prerequisites
- Node 22.13+ (uses the built-in `node:sqlite`)
- An Anthropic API key
- A Google Cloud project with the **Google Calendar API** enabled and an OAuth client of type **Web application**
- A Twilio account with the WhatsApp sandbox (to start) or an approved WhatsApp sender (for production)
- A public HTTPS URL for the server (ngrok for local testing, or Railway / Fly.io / a VPS)

### 2. Install
```bash
npm install
cp .env.example .env
```
Fill in `.env`. The important ones:

- `USER_WHATSAPP_NUMBER` — Shani's number in E.164 (`+9725…`). The agent only talks to this number.
- `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` — from the Google Cloud OAuth client. Add `<PUBLIC_URL>/auth/google/callback` as an authorised redirect URI. While the app is in "Testing" mode in Google Cloud, add Shani's Google account as a test user.
- `SCHOOL_CALENDAR_IDS` / `WORK_CALENDAR_IDS` — optional. If she keeps separate calendars for school and work, listing their IDs makes classification exact. Otherwise keyword rules (English + Hebrew) and preferences she teaches the agent are used.
- `TWILIO_*` — account SID, auth token, and the WhatsApp sender (`whatsapp:+14155238886` for the sandbox).
- `PUBLIC_URL` — the public URL of this server.

### 3. Connect Google Calendar (once)
```bash
npm run cli -- auth
```
Open the printed URL **in a browser where Shani is signed in to Google**, approve access. Tokens are saved in the SQLite database and refreshed automatically.

### 4. Connect WhatsApp
- Twilio Console → Messaging → Try it out → **Send a WhatsApp message**: have Shani send the sandbox "join …" code from her phone.
- Sandbox settings → "When a message comes in": `https://<PUBLIC_URL>/webhooks/whatsapp` (POST). It must match `PUBLIC_URL` exactly (no trailing slash), because Twilio signatures are validated against that URL.

**24-hour window.** WhatsApp only allows free-form messages within 24 h of her last message. If a scheduled brief/plan hits that limit, the app queues it and, if `TWILIO_TEMPLATE_CONTENT_SID` is set, sends an approved template (e.g. "Good morning {{1}}, your daily brief is ready — reply to see it"); the queued message is delivered as soon as she replies. Reminders are time-sensitive and are dropped instead of queued. In practice, because she gets a brief every morning and reminders all day, replying once a day keeps the window open. For production, register a WhatsApp Business sender and a template in Twilio.

### 5. Run
```bash
npm run dev          # local, auto-reload
# or
npm run build && npm start
```
Health check: `GET /health` → `{"ok":true,"googleConnected":true,...}`.

### Docker
```bash
docker build -t shani-agent .
docker run -d --env-file .env -p 3000:3000 -v shani-data:/app/data shani-agent
```

## Local testing without WhatsApp
Set `WHATSAPP_PROVIDER=console` and messages print to the terminal:
```bash
npm run cli -- events 7          # what the agent sees
npm run cli -- analyze           # deterministic week analysis
npm run cli -- brief             # generate today's brief (not sent)
npm run cli -- weekly            # generate the weekly plan + raw JSON (not sent)
npm run cli -- chat "what do I have tomorrow?"
npm run cli -- chat "move my study block to Tuesday 4pm"
npm run cli -- reminders         # which reminders would fire right now
npm test                         # unit tests for analysis / reminders / chunking
```

## How the pieces work

**Classification.** Each event becomes `school`, `work`, `personal`, or `other`: explicit calendar IDs win; then a per-event override she taught the agent; then learned keywords (`keywords:school = "Reichman, Dr. Levi"`); then built-in English/Hebrew keywords.

**Weekly plan.** Code computes the facts (hours per category per day, back-to-back streaks, lunch breaks, free blocks, conflicts, short nights). Claude turns that into a short structured plan: observations, up to 6 proposals, each with concrete operations (`create` / `move` / `update` / `delete`) that reference real event IDs. Proposals are stored as *pending* and nothing changes in the calendar until she says "apply …". Old pending proposals expire when a new plan is generated.

**Chat.** Each inbound message runs the agent with the last 24 h of conversation and tools for reading/editing the calendar, finding free slots, saving preferences, and applying proposals. Deletions require an explicit confirmation turn. Messages from any other phone number are ignored, and Twilio signatures are verified.

**Reminders.** Every minute the app checks events starting within the lead time (default 10 min, `reminder_lead_minutes` preference, or a per-event override via chat: "remind me 30 minutes before the exam"). One message per start time, naming what to wrap up. Quiet hours and "snooze reminders until …" are honoured.

**Preferences** live in SQLite and are injected into every prompt, so "I work Sun–Tue 9–17" or "answer me in Hebrew" sticks.

## Configuration reference
See `.env.example`. Cron expressions are evaluated in `TIMEZONE`. Set `LOG_LEVEL=debug` for verbose logs.

## Scripts
| Command | Purpose |
|---|---|
| `npm run dev` | run with auto-reload |
| `npm run build` / `npm start` | compile to `dist/` and run |
| `npm run cli -- <cmd>` | operations CLI (see above) |
| `npm test` | unit tests |
| `npm run typecheck` | TypeScript check |
