import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { config } from "./config.js";

mkdirSync(dirname(config.DATABASE_PATH), { recursive: true });
export const db = new DatabaseSync(config.DATABASE_PATH);
db.exec("PRAGMA journal_mode = WAL;");

db.exec(`
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS preferences (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  direction TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind TEXT NOT NULL DEFAULT 'chat',
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE TABLE IF NOT EXISTS reminders_sent (
  event_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (event_id, kind)
);
CREATE TABLE IF NOT EXISTS proposals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  week_start TEXT NOT NULL,
  label INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  rationale TEXT NOT NULL,
  operations TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','applied','rejected','failed')),
  result TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  resolved_at TEXT
);
CREATE TABLE IF NOT EXISTS outbox (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  body TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'chat',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','sent','failed')),
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  sent_at TEXT
);
`);

// ---------- kv ----------
export function kvGet<T = unknown>(key: string): T | undefined {
  const row = db.prepare("SELECT value FROM kv WHERE key = ?").get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : undefined;
}
export function kvSet(key: string, value: unknown) {
  db.prepare(
    "INSERT INTO kv (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, JSON.stringify(value));
}
export function kvDelete(key: string) {
  db.prepare("DELETE FROM kv WHERE key = ?").run(key);
}

// ---------- preferences ----------
export type Preference = { key: string; value: string; updated_at: string };
export function listPreferences(): Preference[] {
  return db.prepare("SELECT key, value, updated_at FROM preferences ORDER BY key").all() as Preference[];
}
export function getPreference(key: string): string | undefined {
  const row = db.prepare("SELECT value FROM preferences WHERE key = ?").get(key) as { value: string } | undefined;
  return row?.value;
}
export function setPreference(key: string, value: string) {
  db.prepare(
    "INSERT INTO preferences (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
  ).run(key, value);
}
export function deletePreference(key: string) {
  db.prepare("DELETE FROM preferences WHERE key = ?").run(key);
}

// ---------- messages ----------
export type StoredMessage = { id: number; direction: "in" | "out"; kind: string; body: string; created_at: string };
export function addMessage(direction: "in" | "out", body: string, kind = "chat") {
  db.prepare("INSERT INTO messages (direction, kind, body) VALUES (?, ?, ?)").run(direction, kind, body);
}
export function recentMessages(limit: number, sinceIso: string): StoredMessage[] {
  const rows = db
    .prepare("SELECT id, direction, kind, body, created_at FROM messages WHERE created_at >= ? ORDER BY id DESC LIMIT ?")
    .all(sinceIso, limit) as StoredMessage[];
  return rows.reverse();
}

// ---------- reminders ----------
export function reminderAlreadySent(eventId: string, kind: string): boolean {
  return !!db.prepare("SELECT 1 FROM reminders_sent WHERE event_id = ? AND kind = ?").get(eventId, kind);
}
export function markReminderSent(eventId: string, kind: string) {
  db.prepare("INSERT OR IGNORE INTO reminders_sent (event_id, kind) VALUES (?, ?)").run(eventId, kind);
}
export function pruneReminders(olderThanIso: string) {
  db.prepare("DELETE FROM reminders_sent WHERE sent_at < ?").run(olderThanIso);
}

// ---------- proposals ----------
export type ProposalRow = {
  id: number;
  week_start: string;
  label: number;
  title: string;
  rationale: string;
  operations: string;
  status: "pending" | "applied" | "rejected" | "failed";
  result: string | null;
  created_at: string;
};
export function insertProposal(weekStart: string, label: number, title: string, rationale: string, operations: unknown): number {
  const r = db
    .prepare("INSERT INTO proposals (week_start, label, title, rationale, operations) VALUES (?, ?, ?, ?, ?)")
    .run(weekStart, label, title, rationale, JSON.stringify(operations));
  return Number(r.lastInsertRowid);
}
export function pendingProposals(): ProposalRow[] {
  return db.prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY id").all() as ProposalRow[];
}
export function getProposal(id: number): ProposalRow | undefined {
  return db.prepare("SELECT * FROM proposals WHERE id = ?").get(id) as ProposalRow | undefined;
}
export function resolveProposal(id: number, status: ProposalRow["status"], result?: string) {
  db.prepare(
    "UPDATE proposals SET status = ?, result = ?, resolved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?",
  ).run(status, result ?? null, id);
}
export function expirePendingProposals(beforeWeekStart: string) {
  db.prepare("UPDATE proposals SET status = 'rejected', result = 'expired' WHERE status = 'pending' AND week_start < ?").run(
    beforeWeekStart,
  );
}

// ---------- outbox ----------
export type OutboxRow = { id: number; body: string; kind: string; status: string; created_at: string };
export function enqueueOutbox(body: string, kind: string): number {
  const r = db.prepare("INSERT INTO outbox (body, kind) VALUES (?, ?)").run(body, kind);
  return Number(r.lastInsertRowid);
}
export function pendingOutbox(): OutboxRow[] {
  return db.prepare("SELECT id, body, kind, status, created_at FROM outbox WHERE status = 'pending' ORDER BY id").all() as OutboxRow[];
}
export function markOutbox(id: number, status: "sent" | "failed", error?: string) {
  db.prepare("UPDATE outbox SET status = ?, error = ?, sent_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(
    status,
    error ?? null,
    id,
  );
}
