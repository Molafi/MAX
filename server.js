/**
 * MAX — premium AI chat, zero-dependency Node server.
 *
 * Responsibilities:
 *   1. Serve the static frontend from ./public
 *   2. Expose GET  /api/config  -> non-secret runtime config for the UI
 *   3. Expose POST /api/chat    -> streaming proxy to AgentRouter's
 *      Anthropic-compatible /v1/messages endpoint (keeps the key server-side)
 *
 * No external dependencies: uses only Node built-ins (http, fs, path, url).
 * Requires Node >= 18 for the global `fetch` + web streams.
 */

import http from "node:http";
import { readFile, stat } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");

/* ------------------------------------------------------------------ */
/*  Minimal .env loader (no dotenv dependency)                         */
/* ------------------------------------------------------------------ */
function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!existsSync(envPath)) return;
  try {
    const raw = readFileSync(envPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let val = trimmed.slice(eq + 1).trim();
      // strip surrounding quotes
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = val;
    }
  } catch (err) {
    console.warn("[MAX] Could not read .env:", err.message);
  }
}
loadEnv();

const CONFIG = {
  port: parseInt(process.env.PORT || "8787", 10),
  apiKey: process.env.AGENTROUTER_API_KEY || "",
  baseUrl: (process.env.AGENTROUTER_BASE_URL || "https://agentrouter.org").replace(/\/+$/, ""),
  defaultModel: process.env.DEFAULT_MODEL || "claude-sonnet-4-6",
  allowClientKey: (process.env.ALLOW_CLIENT_KEY || "true").toLowerCase() !== "false",
  rateLimitPerMin: parseInt(process.env.RATE_LIMIT_PER_MIN || "60", 10),
};

// Curated model list shown in the UI. Users can also type a custom model.
const MODELS = [
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — balanced (recommended)" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6 — most capable" },
  { id: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 — fastest" },
  { id: "claude-sonnet-4-5-20250929", label: "Claude Sonnet 4.5" },
  { id: "gpt-5.5", label: "GPT-5.5 (OpenAI)" },
  { id: "deepseek-v3", label: "DeepSeek V3" },
  { id: "glm-5.1", label: "GLM 5.1" },
];

/* ------------------------------------------------------------------ */
/*  Tiny in-memory per-IP rate limiter                                 */
/* ------------------------------------------------------------------ */
const rateBuckets = new Map(); // ip -> { count, resetAt }
function checkRateLimit(ip) {
  if (!CONFIG.rateLimitPerMin || CONFIG.rateLimitPerMin <= 0) return true;
  const now = Date.now();
  let bucket = rateBuckets.get(ip);
  if (!bucket || now > bucket.resetAt) {
    bucket = { count: 0, resetAt: now + 60_000 };
    rateBuckets.set(ip, bucket);
  }
  bucket.count += 1;
  return bucket.count <= CONFIG.rateLimitPerMin;
}
// periodic cleanup
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of rateBuckets) if (now > b.resetAt) rateBuckets.delete(ip);
}, 120_000).unref?.();

/* ------------------------------------------------------------------ */
/*  Static file serving                                                */
/* ------------------------------------------------------------------ */
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
  ".map": "application/json",
};

async function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, "http://x").pathname);
  if (urlPath === "/") urlPath = "/index.html";

  // Prevent path traversal
  const safePath = path
    .normalize(urlPath)
    .replace(/^(\.\.[/\\])+/, "")
    .replace(/^[/\\]+/, "");
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (info.isDirectory()) throw new Error("is dir");
    const data = await readFile(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": "no-cache",
    });
    res.end(data);
  } catch {
    // SPA-style fallback to index.html for unknown non-asset routes
    if (!path.extname(safePath)) {
      try {
        const data = await readFile(path.join(PUBLIC_DIR, "index.html"));
        res.writeHead(200, { "Content-Type": MIME[".html"] });
        res.end(data);
        return;
      } catch {}
    }
    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("404 Not Found");
  }
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limitBytes = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error("Payload too large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

/* ------------------------------------------------------------------ */
/*  /api/config                                                        */
/* ------------------------------------------------------------------ */
function handleConfig(req, res) {
  sendJson(res, 200, {
    defaultModel: CONFIG.defaultModel,
    models: MODELS,
    allowClientKey: CONFIG.allowClientKey,
    hasServerKey: Boolean(CONFIG.apiKey),
  });
}

/* ------------------------------------------------------------------ */
/*  /api/chat  — streaming proxy to AgentRouter /v1/messages           */
/* ------------------------------------------------------------------ */
async function handleChat(req, res) {
  const ip = clientIp(req);
  if (!checkRateLimit(ip)) {
    return sendJson(res, 429, {
      error: { type: "rate_limit", message: "Too many requests. Please slow down and try again shortly." },
    });
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw || "{}");
  } catch (err) {
    return sendJson(res, 400, {
      error: { type: "bad_request", message: "Invalid JSON body: " + err.message },
    });
  }

  // Resolve the API key: client-supplied (if allowed) takes precedence.
  const clientKey = CONFIG.allowClientKey ? String(payload.apiKey || "").trim() : "";
  const apiKey = clientKey || CONFIG.apiKey;

  if (!apiKey) {
    return sendJson(res, 401, {
      error: {
        type: "no_api_key",
        message:
          "No API key configured. Add AGENTROUTER_API_KEY to your .env file, or enter a key in Settings.",
      },
    });
  }

  // Build the Anthropic Messages request body.
  const body = {
    model: payload.model || CONFIG.defaultModel,
    max_tokens: clampInt(payload.max_tokens, 1, 64000, 4096),
    messages: Array.isArray(payload.messages) ? payload.messages : [],
    stream: payload.stream !== false,
  };
  if (payload.system) body.system = payload.system;
  if (payload.temperature !== undefined && payload.temperature !== null) {
    body.temperature = clampFloat(payload.temperature, 0, 1, 1);
  }

  const upstreamUrl = `${CONFIG.baseUrl}/v1/messages`;

  // Abort upstream if the client disconnects.
  const controller = new AbortController();
  req.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await fetch(upstreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: body.stream ? "text/event-stream" : "application/json",
        // AgentRouter accepts either header style; send both for compatibility.
        "x-api-key": apiKey,
        Authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true",
        "User-Agent": "MAX/1.0 (+https://agentrouter.org)",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) return; // client left
    return sendJson(res, 502, {
      error: {
        type: "network",
        message: "Could not reach the AI provider. Check your connection or AGENTROUTER_BASE_URL. (" + err.message + ")",
      },
    });
  }

  // Non-OK upstream: relay the error as JSON.
  if (!upstream.ok) {
    let detail = "";
    try {
      detail = await upstream.text();
    } catch {}
    let parsed;
    try {
      parsed = JSON.parse(detail);
    } catch {
      parsed = null;
    }
    const message =
      parsed?.error?.message ||
      parsed?.message ||
      detail ||
      `Upstream returned HTTP ${upstream.status}`;
    return sendJson(res, upstream.status, {
      error: { type: mapStatusType(upstream.status), status: upstream.status, message },
    });
  }

  // Non-streaming path: relay JSON directly.
  if (!body.stream) {
    const text = await upstream.text();
    res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
    res.end(text);
    return;
  }

  // Streaming path: pipe the SSE stream straight through to the browser.
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // value is a Uint8Array chunk of the SSE stream
      res.write(Buffer.from(value));
    }
  } catch (err) {
    if (!controller.signal.aborted) {
      // best-effort error event to the client stream
      res.write(
        `event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`
      );
    }
  } finally {
    res.end();
  }
}

function clampInt(v, min, max, dflt) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function clampFloat(v, min, max, dflt) {
  const n = parseFloat(v);
  if (Number.isNaN(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}
function mapStatusType(status) {
  if (status === 401 || status === 403) return "auth";
  if (status === 429) return "rate_limit";
  if (status >= 500) return "server";
  return "request";
}

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");

  try {
    if (pathname === "/api/config" && req.method === "GET") {
      return handleConfig(req, res);
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      return await handleChat(req, res);
    }
    if (pathname.startsWith("/api/")) {
      return sendJson(res, 404, { error: { type: "not_found", message: "Unknown API route" } });
    }
    return await serveStatic(req, res);
  } catch (err) {
    console.error("[MAX] Unhandled error:", err);
    if (!res.headersSent) {
      sendJson(res, 500, { error: { type: "server", message: "Internal server error" } });
    } else {
      try { res.end(); } catch {}
    }
  }
});

server.listen(CONFIG.port, () => {
  const line = "─".repeat(52);
  console.log(`\n┌${line}┐`);
  console.log(`│  MAX is running`);
  console.log(`│  ▶  http://localhost:${CONFIG.port}`);
  console.log(`│`);
  console.log(`│  Server API key : ${CONFIG.apiKey ? "loaded ✓" : "NOT set (use Settings in the UI, or .env)"}`);
  console.log(`│  Upstream       : ${CONFIG.baseUrl}/v1/messages`);
  console.log(`│  Default model  : ${CONFIG.defaultModel}`);
  console.log(`│  Rate limit     : ${CONFIG.rateLimitPerMin || "off"} req/min per IP`);
  console.log(`└${line}┘\n`);
});
