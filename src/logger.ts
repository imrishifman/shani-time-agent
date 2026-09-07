import { config } from "./config.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const threshold = levels[config.LOG_LEVEL];

function emit(level: Level, msg: string, meta?: unknown) {
  if (levels[level] < threshold) return;
  const line = `${new Date().toISOString()} [${level.toUpperCase()}] ${msg}`;
  const out = level === "error" || level === "warn" ? console.error : console.log;
  if (meta !== undefined) out(line, meta instanceof Error ? meta.stack ?? meta.message : meta);
  else out(line);
}

export const log = {
  debug: (m: string, meta?: unknown) => emit("debug", m, meta),
  info: (m: string, meta?: unknown) => emit("info", m, meta),
  warn: (m: string, meta?: unknown) => emit("warn", m, meta),
  error: (m: string, meta?: unknown) => emit("error", m, meta),
};
