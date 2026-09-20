/**
 * Minimal structured JSON logger.
 *
 * Every line is a single JSON object so logs are machine-consumable (SPEC
 * section 24). Values whose key looks secret-bearing are redacted before
 * serialisation — a defence in depth so an accidental
 * `log.info("x", { backendAuthSecret })` cannot leak.
 */
import type { LogLevel } from "./config.js";

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEY = /(secret|token|password|passwd|authorization|cookie|api[_-]?key|private[_-]?key|signature)/i;
const REDACTED = "[redacted]";

export interface LogFields {
  [key: string]: unknown;
}

export interface Logger {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  child(bindings: LogFields): Logger;
}

/** Deep-redact secret-looking keys. Depth-bounded to avoid pathological input. */
function redact(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[depth-limit]";
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEY.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}

export function createLogger(
  level: LogLevel = "info",
  bindings: LogFields = {},
): Logger {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(lvl: LogLevel, message: string, fields?: LogFields): void {
    if (LEVELS[lvl] < threshold) return;
    const line = {
      ts: new Date().toISOString(),
      level: lvl,
      msg: message,
      ...(redact(bindings) as LogFields),
      ...(fields ? (redact(fields) as LogFields) : {}),
    };
    const target = lvl === "error" ? process.stderr : process.stdout;
    target.write(JSON.stringify(line) + "\n");
  }

  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
    child: (extra) => createLogger(level, { ...bindings, ...extra }),
  };
}
