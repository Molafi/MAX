/**
 * MAX — tiny structured JSON logger (zero dependencies).
 *
 *   const log = createLogger({ dir: "data" });
 *   log("info", "github.commit.ok", { repo: "o/r", attempts: 2 });
 *
 * Every entry is one JSON line `{ ts, level, msg, ...meta }` written to stdout/
 * stderr and appended to <dir>/app.log (rotated to app.log.1 past maxBytes).
 * Secret-looking keys (token, key, password, cookie, authorization…) are redacted.
 */
import { createWriteStream, mkdirSync, statSync, renameSync, existsSync } from "node:fs";
import path from "node:path";

export const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SECRET_KEY = /(token|secret|password|passwd|api[-_]?key|apikey|authorization|cookie|session)/i;
const RESERVED = new Set(["ts", "level", "msg"]);

/** Deep-copy `value` with secrets redacted, errors flattened and long strings clipped. */
export function redact(value, depth = 0) {
  if (depth > 5) return "[…]";
  if (value instanceof Error) {
    const out = { name: value.name, message: value.message };
    if (value.code) out.code = value.code;
    if (value.status) out.status = value.status;
    if (value.cause?.code) out.cause = value.cause.code;
    return out;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SECRET_KEY.test(k) && v !== undefined && v !== null && typeof v !== "boolean" ? "[redacted]" : redact(v, depth + 1);
    }
    return out;
  }
  if (typeof value === "string" && value.length > 2000) return value.slice(0, 2000) + "…";
  return value;
}

export function createLogger({
  dir = "",
  file = "app.log",
  maxBytes = 5 * 1024 * 1024,
  level = process.env.LOG_LEVEL || "info",
  stdout = true,
  sink = console,
} = {}) {
  const min = LEVELS[String(level).toLowerCase()] ?? LEVELS.info;
  const filePath = dir ? path.join(dir, file) : "";
  let stream = null;
  let bytes = 0;
  let broken = false;

  const open = () => {
    if (!filePath || broken || stream) return stream;
    try {
      mkdirSync(dir, { recursive: true });
      bytes = existsSync(filePath) ? statSync(filePath).size : 0;
      stream = createWriteStream(filePath, { flags: "a", mode: 0o600 });
      stream.on("error", () => { broken = true; stream = null; });
    } catch {
      broken = true;
      stream = null;
    }
    return stream;
  };

  const rotate = () => {
    const old = stream;
    stream = null;
    try { old?.end(); } catch {}
    try { renameSync(filePath, `${filePath}.1`); } catch {}
    bytes = 0;
  };

  function log(lvl, msg, meta) {
    const name = LEVELS[lvl] ? lvl : "info";
    if (LEVELS[name] < min) return null;
    const entry = { ts: new Date().toISOString(), level: name, msg: String(msg) };
    if (meta !== undefined && meta !== null) {
      const clean = redact(typeof meta === "object" && !(meta instanceof Error) ? meta : { detail: meta });
      for (const [k, v] of Object.entries(clean)) entry[RESERVED.has(k) ? `meta_${k}` : k] = v;
    }
    let line;
    try { line = JSON.stringify(entry); } catch { line = JSON.stringify({ ts: entry.ts, level: name, msg: entry.msg }); }
    if (stdout) {
      try { (name === "error" || name === "warn" ? sink.error : sink.log).call(sink, line); } catch {}
    }
    if (filePath && open()) {
      const size = Buffer.byteLength(line) + 1;
      if (bytes + size > maxBytes && bytes > 0) { rotate(); open(); }
      if (stream) { stream.write(line + "\n"); bytes += size; }
    }
    return entry;
  }

  for (const l of Object.keys(LEVELS)) log[l] = (msg, meta) => log(l, msg, meta);
  log.path = filePath;
  /** Flush and close the file stream (call on shutdown). */
  log.close = () => new Promise((resolve) => {
    const s = stream;
    stream = null;
    if (!s) return resolve();
    s.end(resolve);
  });
  return log;
}
