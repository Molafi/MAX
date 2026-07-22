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
  host: process.env.HOST || "127.0.0.1",
  port: parseInt(process.env.PORT || "8787", 10),
  apiKey: process.env.AGENTROUTER_API_KEY || "",
  baseUrl: (process.env.AGENTROUTER_BASE_URL || "https://agentrouter.org").replace(/\/+$/, ""),
  defaultModel: process.env.DEFAULT_MODEL || "claude-opus-4-8",
  allowClientKey: (process.env.ALLOW_CLIENT_KEY || "true").toLowerCase() !== "false",
  rateLimitPerMin: parseInt(process.env.RATE_LIMIT_PER_MIN || "60", 10),
  upstreamTimeoutMs: parseInt(process.env.UPSTREAM_TIMEOUT_MS || "120000", 10),
  trustProxy: (process.env.TRUST_PROXY || "false").toLowerCase() === "true",
  // AgentRouter is a drop-in Claude Code gateway: it only accepts traffic that
  // looks like the Claude CLI. A matching User-Agent is REQUIRED or requests are
  // rejected/dropped ("fetch failed" or 401). Override only if your gateway differs.
  upstreamUserAgent: process.env.UPSTREAM_USER_AGENT || "claude-cli/2.0.0 (external, cli)",
  github: {
    token: process.env.GITHUB_TOKEN || "",
    owner: process.env.GITHUB_OWNER || "",
    repo: process.env.GITHUB_REPO || "",
    branch: process.env.GITHUB_BRANCH || "main",
    apiBase: (process.env.GITHUB_API_BASE || "https://api.github.com").replace(/\/+$/, ""),
    allowClientToken: (process.env.ALLOW_CLIENT_GITHUB_TOKEN || "true").toLowerCase() !== "false",
  },
  gitlab: {
    token: process.env.GITLAB_TOKEN || "",
    apiBase: (process.env.GITLAB_API_BASE || "https://gitlab.com/api/v4").replace(/\/+$/, ""),
    allowClientToken: (process.env.ALLOW_CLIENT_GITLAB_TOKEN || "true").toLowerCase() !== "false",
  },
};

// Cap on how much of a repo file we return to the browser (protects memory + context).
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || "524288", 10); // 512 KB
const MAX_TREE_ENTRIES = 4000;

const START_TIME = Date.now();

// Models allowed by the AgentRouter token configuration shown by the user.
// Users can still enter a custom model ID in the UI if their token permits it.
const MODELS = [
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8 — recommended" },
  { id: "glm-5.2", label: "GLM 5.2" },
  { id: "gpt-5.5", label: "GPT-5.5" },
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
  ".webmanifest": "application/manifest+json; charset=utf-8",
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
function applySecurityHeaders(res) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; " +
      "script-src 'self' https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob:; connect-src 'self'"
  );
}

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
  if (CONFIG.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.length) return xff.split(",")[0].trim();
  }
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
    github: {
      hasServerToken: Boolean(CONFIG.github.token),
      allowClientToken: CONFIG.github.allowClientToken,
      owner: CONFIG.github.owner,
      repo: CONFIG.github.repo,
      branch: CONFIG.github.branch,
    },
    gitlab: {
      hasServerToken: Boolean(CONFIG.gitlab.token),
      allowClientToken: CONFIG.gitlab.allowClientToken,
    },
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
    node: process.version,
    hasServerKey: Boolean(CONFIG.apiKey),
    github: { hasServerToken: Boolean(CONFIG.github.token) },
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

  // Build and validate the Anthropic Messages request body.
  const model = typeof payload.model === "string" ? payload.model.trim() : CONFIG.defaultModel;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!model || model.length > 120) {
    return sendJson(res, 400, {
      error: { type: "bad_request", message: "A valid model ID is required." },
    });
  }
  if (!messages.length || !messages.every(isValidMessage)) {
    return sendJson(res, 400, {
      error: { type: "bad_request", message: "messages must be a non-empty array of valid user/assistant messages." },
    });
  }

  const body = {
    model,
    max_tokens: clampInt(payload.max_tokens, 1, 64000, 4096),
    messages,
    stream: payload.stream !== false,
  };
  if (payload.system) body.system = payload.system;
  if (payload.temperature !== undefined && payload.temperature !== null) {
    body.temperature = clampFloat(payload.temperature, 0, 1, 1);
  }

  const upstreamUrl = `${CONFIG.baseUrl}/v1/messages`;

  // Abort only when the response connection closes early, not when the request
  // body finishes. The request `close` event can fire before fetch starts.
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, Math.max(1_000, CONFIG.upstreamTimeoutMs));
  const abortOnDisconnect = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", abortOnDisconnect);

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
        "anthropic-beta": "claude-code-20250219",
        // REQUIRED by AgentRouter — must match the Claude CLI wire image.
        "User-Agent": CONFIG.upstreamUserAgent,
        "x-app": "cli",
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timeout);
    res.off("close", abortOnDisconnect);
    if (controller.signal.aborted && !timedOut) return; // client left
    const cause = err?.cause?.code || err?.cause?.message || err?.code || err?.message || "unknown error";
    console.error(`[MAX] Upstream fetch failed (${upstreamUrl}):`, cause);
    return sendJson(res, timedOut ? 504 : 502, {
      error: {
        type: timedOut ? "timeout" : "network",
        message: timedOut
          ? "The AI provider took too long to respond. Please try again."
          : `Could not reach the AI provider at ${upstreamUrl} (${cause}). Check your internet connection and AGENTROUTER_BASE_URL.`,
      },
    });
  }

  // Non-OK upstream: relay the error as JSON.
  if (!upstream.ok) {
    clearTimeout(timeout);
    res.off("close", abortOnDisconnect);
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
    try {
      const text = await upstream.text();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(text);
    } finally {
      clearTimeout(timeout);
      res.off("close", abortOnDisconnect);
    }
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
      if (res.writableEnded || res.destroyed) break; // client went away
      // value is a Uint8Array chunk of the SSE stream
      res.write(Buffer.from(value));
    }
  } catch (err) {
    if (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
      // best-effort error event to the client stream
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message: err?.message || "stream error" })}\n\n`);
      } catch {}
    }
  } finally {
    clearTimeout(timeout);
    res.off("close", abortOnDisconnect);
    if (!res.writableEnded) { try { res.end(); } catch {} }
  }
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isValidMessage(message) {
  if (!message || !["user", "assistant"].includes(message.role)) return false;
  if (typeof message.content === "string") return message.content.length > 0;
  if (!Array.isArray(message.content) || !message.content.length) return false;
  return message.content.every((block) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === "text") return typeof block.text === "string";
    return block.type === "image" && block.source?.type === "base64" &&
      ALLOWED_IMAGE_TYPES.has(block.source.media_type) && typeof block.source.data === "string" &&
      block.source.data.length > 0;
  });
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
/*  /api/test — cheap connectivity/key check against the AI provider   */
/* ------------------------------------------------------------------ */
async function handleTest(req, res) {
  let payload = {};
  try {
    payload = JSON.parse((await readBody(req)) || "{}");
  } catch {}
  const clientKey = CONFIG.allowClientKey ? String(payload.apiKey || "").trim() : "";
  const apiKey = clientKey || CONFIG.apiKey;
  if (!apiKey) {
    return sendJson(res, 401, { error: { type: "no_api_key", message: "No API key configured." } });
  }
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : CONFIG.defaultModel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const r = await fetch(`${CONFIG.baseUrl}/v1/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        Authorization: `Bearer ${apiKey}`,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "claude-code-20250219",
        "User-Agent": CONFIG.upstreamUserAgent,
        "x-app": "cli",
      },
      body: JSON.stringify({ model, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
      signal: controller.signal,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = JSON.parse(text); msg = j?.error?.message || j?.message || msg; } catch {}
      return sendJson(res, r.status, { error: { type: mapStatusType(r.status), status: r.status, message: msg } });
    }
    return sendJson(res, 200, { ok: true, model, message: "Connection OK — the provider accepted the request." });
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach the AI provider (${cause}).` } });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  GitHub integration (proxied so the token can stay server-side)     */
/* ------------------------------------------------------------------ */
function resolveGithub(payload) {
  const clientToken = CONFIG.github.allowClientToken ? String(payload.token || "").trim() : "";
  return {
    token: clientToken || CONFIG.github.token,
    owner: String(payload.owner || CONFIG.github.owner || "").trim(),
    repo: String(payload.repo || CONFIG.github.repo || "").trim(),
    branch: String(payload.branch || CONFIG.github.branch || "main").trim() || "main",
  };
}

async function githubApi(token, method, apiPath, body) {
  const url = `${CONFIG.github.apiBase}${apiPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MAX-chat",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await r.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, ok: r.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function ghError(res, resp, fallback) {
  const message = resp?.json?.message || resp?.text || fallback || "GitHub request failed";
  return sendJson(res, resp?.status || 502, {
    error: { type: mapStatusType(resp?.status || 502), status: resp?.status, message },
  });
}

async function handleGithubTest(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided." } });
  if (!gh.owner || !gh.repo) return sendJson(res, 400, { error: { type: "bad_request", message: "Owner and repository are required." } });

  try {
    const who = await githubApi(gh.token, "GET", "/user");
    if (!who.ok) return ghError(res, who, "Token rejected by GitHub.");
    const repo = await githubApi(gh.token, "GET", `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`);
    if (!repo.ok) return ghError(res, repo, "Repository not found or not accessible.");
    const canPush = repo.json?.permissions?.push !== false;
    return sendJson(res, 200, {
      ok: true,
      login: who.json?.login,
      repo: repo.json?.full_name,
      defaultBranch: repo.json?.default_branch,
      canPush,
      message: canPush
        ? `Connected as ${who.json?.login}. Ready to push to ${repo.json?.full_name}.`
        : `Connected as ${who.json?.login}, but this token cannot push to ${repo.json?.full_name}.`,
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitHub (${cause}).` } });
  }
}

async function handleGithubRepos(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided. Add one in Settings." } });

  const q = String(payload.q || "").trim().toLowerCase();
  const perPage = clampInt(payload.perPage, 1, 100, 100);
  const page = clampInt(payload.page, 1, 100, 1);

  try {
    const r = await githubApi(
      gh.token,
      "GET",
      `/user/repos?per_page=${perPage}&page=${page}&sort=updated&affiliation=owner,collaborator,organization_member`
    );
    if (!r.ok) return ghError(res, r, "Could not list repositories.");
    const list = Array.isArray(r.json) ? r.json : [];
    let repos = list.map((x) => ({
      fullName: x.full_name,
      owner: x.owner?.login || "",
      name: x.name,
      private: Boolean(x.private),
      defaultBranch: x.default_branch || "main",
      description: x.description || "",
      updatedAt: x.updated_at || null,
      canPush: x.permissions ? x.permissions.push !== false : true,
    }));
    if (q) repos = repos.filter((x) => x.fullName.toLowerCase().includes(q) || (x.description || "").toLowerCase().includes(q));
    return sendJson(res, 200, { ok: true, repos, page, hasMore: list.length === perPage });
  } catch (err) {
    const cause = err?.cause?.code || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitHub (${cause}).` } });
  }
}

async function handleGithubPush(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid JSON body." } });
  }
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided. Add one in Settings." } });
  if (!gh.owner || !gh.repo) return sendJson(res, 400, { error: { type: "bad_request", message: "GitHub owner and repository are required." } });

  const content = typeof payload.content === "string" ? payload.content : "";
  if (!content) return sendJson(res, 400, { error: { type: "bad_request", message: "Nothing to push (empty content)." } });

  // Sanitize the target path: no leading slash, no traversal.
  let filePath = String(payload.path || "").trim().replace(/^\/+/, "");
  filePath = filePath.split("/").filter((seg) => seg && seg !== "." && seg !== "..").join("/");
  if (!filePath) return sendJson(res, 400, { error: { type: "bad_request", message: "A valid file path is required." } });

  const message = String(payload.message || `Add ${filePath} via MAX`).slice(0, 500);
  const encodedPath = filePath.split("/").map(encodeURIComponent).join("/");
  const base = `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/${encodedPath}`;

  try {
    // Look up existing file to obtain its sha (needed to update in place).
    let sha;
    const existing = await githubApi(gh.token, "GET", `${base}?ref=${encodeURIComponent(gh.branch)}`);
    if (existing.ok && existing.json && !Array.isArray(existing.json)) sha = existing.json.sha;
    else if (existing.status !== 404) {
      // 404 is fine (new file); anything else that isn't ok is a real error.
      if (!existing.ok) return ghError(res, existing, "Could not read the target path.");
    }

    const put = await githubApi(gh.token, "PUT", base, {
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      branch: gh.branch,
      ...(sha ? { sha } : {}),
    });
    if (!put.ok) return ghError(res, put, "Push failed.");

    return sendJson(res, 200, {
      ok: true,
      path: filePath,
      updated: Boolean(sha),
      htmlUrl: put.json?.content?.html_url,
      commitUrl: put.json?.commit?.html_url,
      commitSha: put.json?.commit?.sha,
      message: `${sha ? "Updated" : "Created"} ${filePath} on ${gh.owner}/${gh.repo}@${gh.branch}.`,
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitHub (${cause}).` } });
  }
}

function sanitizeRepoPath(p) {
  return String(p || "").trim().replace(/^\/+/, "").split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..").join("/");
}

async function handleGithubTree(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided." } });
  if (!gh.owner || !gh.repo) return sendJson(res, 400, { error: { type: "bad_request", message: "Owner and repository are required." } });

  try {
    const r = await githubApi(gh.token, "GET",
      `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/git/trees/${encodeURIComponent(gh.branch)}?recursive=1`);
    if (!r.ok) return ghError(res, r, "Could not read the repository tree.");
    const files = (r.json?.tree || [])
      .filter((t) => t.type === "blob")
      .slice(0, MAX_TREE_ENTRIES)
      .map((t) => ({ path: t.path, size: t.size || 0 }));
    return sendJson(res, 200, { ok: true, branch: gh.branch, truncated: Boolean(r.json?.truncated), files });
  } catch (err) {
    const cause = err?.cause?.code || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitHub (${cause}).` } });
  }
}

async function handleGithubFile(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided." } });
  if (!gh.owner || !gh.repo) return sendJson(res, 400, { error: { type: "bad_request", message: "Owner and repository are required." } });
  const filePath = sanitizeRepoPath(payload.path);
  if (!filePath) return sendJson(res, 400, { error: { type: "bad_request", message: "A file path is required." } });

  const enc = filePath.split("/").map(encodeURIComponent).join("/");
  try {
    const r = await githubApi(gh.token, "GET",
      `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/contents/${enc}?ref=${encodeURIComponent(gh.branch)}`);
    if (!r.ok) return ghError(res, r, "Could not read the file.");
    if (Array.isArray(r.json)) return sendJson(res, 400, { error: { type: "bad_request", message: "That path is a directory, not a file." } });
    const size = r.json?.size || 0;
    if (size > MAX_FILE_BYTES) return sendJson(res, 413, { error: { type: "too_large", message: `File is too large to load (${Math.round(size / 1024)} KB, limit ${Math.round(MAX_FILE_BYTES / 1024)} KB).` } });
    if (r.json?.encoding !== "base64" || typeof r.json?.content !== "string") {
      return sendJson(res, 415, { error: { type: "unsupported", message: "This file type can't be loaded as text." } });
    }
    const text = Buffer.from(r.json.content, "base64").toString("utf8");
    return sendJson(res, 200, { ok: true, path: filePath, size, content: text });
  } catch (err) {
    const cause = err?.cause?.code || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitHub (${cause}).` } });
  }
}

/* ------------------------------------------------------------------ */
/*  GitLab integration                                                 */
/* ------------------------------------------------------------------ */
function resolveGitlab(payload) {
  const clientToken = CONFIG.gitlab.allowClientToken ? String(payload.token || "").trim() : "";
  return {
    token: clientToken || CONFIG.gitlab.token,
    projectId: String(payload.projectId ?? payload.fullName ?? "").trim(),
    branch: String(payload.branch || "main").trim() || "main",
  };
}

async function gitlabApi(token, method, apiPath, body) {
  const url = `${CONFIG.gitlab.apiBase}${apiPath}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const r = await fetch(url, {
      method,
      headers: {
        "PRIVATE-TOKEN": token,
        Accept: "application/json",
        "User-Agent": "MAX-chat",
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    const text = await r.text().catch(() => "");
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    return { status: r.status, ok: r.ok, json, text };
  } finally {
    clearTimeout(timer);
  }
}

function glError(res, resp, fallback) {
  const message = resp?.json?.message || resp?.json?.error || resp?.text || fallback || "GitLab request failed";
  return sendJson(res, resp?.status || 502, { error: { type: mapStatusType(resp?.status || 502), status: resp?.status, message: typeof message === "string" ? message : fallback } });
}
const glProjectPath = (id) => encodeURIComponent(id);

async function handleGitlabTest(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gl = resolveGitlab(payload);
  if (!gl.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitLab token provided." } });
  try {
    const who = await gitlabApi(gl.token, "GET", "/user");
    if (!who.ok) return glError(res, who, "Token rejected by GitLab.");
    return sendJson(res, 200, { ok: true, login: who.json?.username, message: `Connected to GitLab as ${who.json?.username}.` });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitLab (${err?.cause?.code || err?.message}).` } });
  }
}

async function handleGitlabRepos(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gl = resolveGitlab(payload);
  if (!gl.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitLab token provided." } });
  const q = String(payload.q || "").trim();
  try {
    const r = await gitlabApi(gl.token, "GET",
      `/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at${q ? `&search=${encodeURIComponent(q)}` : ""}`);
    if (!r.ok) return glError(res, r, "Could not list projects.");
    const repos = (Array.isArray(r.json) ? r.json : []).map((p) => ({
      id: p.id,
      fullName: p.path_with_namespace,
      owner: p.namespace?.full_path || p.namespace?.path || "",
      name: p.path,
      private: p.visibility !== "public",
      defaultBranch: p.default_branch || "main",
      description: p.description || "",
    }));
    return sendJson(res, 200, { ok: true, repos });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitLab (${err?.cause?.code || err?.message}).` } });
  }
}

async function handleGitlabTree(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gl = resolveGitlab(payload);
  if (!gl.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitLab token provided." } });
  if (!gl.projectId) return sendJson(res, 400, { error: { type: "bad_request", message: "A project is required." } });
  try {
    const r = await gitlabApi(gl.token, "GET",
      `/projects/${glProjectPath(gl.projectId)}/repository/tree?recursive=true&per_page=100&ref=${encodeURIComponent(gl.branch)}`);
    if (!r.ok) return glError(res, r, "Could not read the repository tree.");
    const files = (Array.isArray(r.json) ? r.json : [])
      .filter((t) => t.type === "blob")
      .slice(0, MAX_TREE_ENTRIES)
      .map((t) => ({ path: t.path, size: 0 }));
    return sendJson(res, 200, { ok: true, branch: gl.branch, files });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitLab (${err?.cause?.code || err?.message}).` } });
  }
}

async function handleGitlabFile(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gl = resolveGitlab(payload);
  if (!gl.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitLab token provided." } });
  if (!gl.projectId) return sendJson(res, 400, { error: { type: "bad_request", message: "A project is required." } });
  const filePath = sanitizeRepoPath(payload.path);
  if (!filePath) return sendJson(res, 400, { error: { type: "bad_request", message: "A file path is required." } });
  try {
    const r = await gitlabApi(gl.token, "GET",
      `/projects/${glProjectPath(gl.projectId)}/repository/files/${encodeURIComponent(filePath)}?ref=${encodeURIComponent(gl.branch)}`);
    if (!r.ok) return glError(res, r, "Could not read the file.");
    const size = r.json?.size || 0;
    if (size > MAX_FILE_BYTES) return sendJson(res, 413, { error: { type: "too_large", message: `File is too large to load (limit ${Math.round(MAX_FILE_BYTES / 1024)} KB).` } });
    const text = Buffer.from(r.json?.content || "", "base64").toString("utf8");
    return sendJson(res, 200, { ok: true, path: filePath, size, content: text });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitLab (${err?.cause?.code || err?.message}).` } });
  }
}

async function handleGitlabPush(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid JSON body." } });
  }
  const gl = resolveGitlab(payload);
  if (!gl.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitLab token provided." } });
  if (!gl.projectId) return sendJson(res, 400, { error: { type: "bad_request", message: "A project is required." } });
  const content = typeof payload.content === "string" ? payload.content : "";
  if (!content) return sendJson(res, 400, { error: { type: "bad_request", message: "Nothing to push (empty content)." } });
  const filePath = sanitizeRepoPath(payload.path);
  if (!filePath) return sendJson(res, 400, { error: { type: "bad_request", message: "A valid file path is required." } });
  const message = String(payload.message || `Add ${filePath} via MAX`).slice(0, 500);
  const fileApi = `/projects/${glProjectPath(gl.projectId)}/repository/files/${encodeURIComponent(filePath)}`;

  try {
    // Does the file already exist on this branch?
    const head = await gitlabApi(gl.token, "GET", `${fileApi}?ref=${encodeURIComponent(gl.branch)}`);
    const exists = head.ok;
    const body = { branch: gl.branch, content, commit_message: message, encoding: "text" };
    const write = await gitlabApi(gl.token, exists ? "PUT" : "POST", fileApi, body);
    if (!write.ok) return glError(res, write, "Push failed.");
    return sendJson(res, 200, {
      ok: true, path: filePath, updated: exists,
      message: `${exists ? "Updated" : "Created"} ${filePath} on ${gl.projectId}@${gl.branch}.`,
    });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitLab (${err?.cause?.code || err?.message}).` } });
  }
}

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  // A client disconnecting mid-stream makes the socket emit an 'error' event
  // (ECONNRESET/EPIPE). Without listeners these become uncaught exceptions that
  // crash the whole server, making every later request fail with "Failed to fetch".
  res.on("error", (err) => console.warn("[MAX] response stream error:", err?.code || err?.message));
  req.on("error", (err) => console.warn("[MAX] request stream error:", err?.code || err?.message));

  applySecurityHeaders(res);
  const { pathname } = new URL(req.url, "http://x");

  try {
    if (pathname === "/api/config" && req.method === "GET") {
      return handleConfig(req, res);
    }
    if (pathname === "/api/health" && req.method === "GET") {
      return handleHealth(req, res);
    }
    if (pathname === "/api/chat" && req.method === "POST") {
      return await handleChat(req, res);
    }
    if (pathname === "/api/test" && req.method === "POST") {
      return await handleTest(req, res);
    }
    if (pathname === "/api/github/test" && req.method === "POST") {
      return await handleGithubTest(req, res);
    }
    if (pathname === "/api/github/repos" && req.method === "POST") {
      return await handleGithubRepos(req, res);
    }
    if (pathname === "/api/github/push" && req.method === "POST") {
      return await handleGithubPush(req, res);
    }
    if (pathname === "/api/github/tree" && req.method === "POST") {
      return await handleGithubTree(req, res);
    }
    if (pathname === "/api/github/file" && req.method === "POST") {
      return await handleGithubFile(req, res);
    }
    if (pathname === "/api/gitlab/test" && req.method === "POST") {
      return await handleGitlabTest(req, res);
    }
    if (pathname === "/api/gitlab/repos" && req.method === "POST") {
      return await handleGitlabRepos(req, res);
    }
    if (pathname === "/api/gitlab/tree" && req.method === "POST") {
      return await handleGitlabTree(req, res);
    }
    if (pathname === "/api/gitlab/file" && req.method === "POST") {
      return await handleGitlabFile(req, res);
    }
    if (pathname === "/api/gitlab/push" && req.method === "POST") {
      return await handleGitlabPush(req, res);
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

// Malformed HTTP from a client should not take the server down.
server.on("clientError", (err, socket) => {
  if (socket.writable && !socket.destroyed) {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  }
});

// Last-resort safety net: log and keep serving instead of crashing.
process.on("uncaughtException", (err) => {
  console.error("[MAX] uncaughtException (kept alive):", err);
});
process.on("unhandledRejection", (reason) => {
  console.error("[MAX] unhandledRejection (kept alive):", reason);
});

server.listen(CONFIG.port, CONFIG.host, () => {
  const line = "─".repeat(52);
  console.log(`\n┌${line}┐`);
  console.log(`│  MAX is running`);
  console.log(`│  ▶  http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`│`);
  console.log(`│  Server API key : ${CONFIG.apiKey ? "loaded ✓" : "NOT set (use Settings in the UI, or .env)"}`);
  console.log(`│  Upstream       : ${CONFIG.baseUrl}/v1/messages`);
  console.log(`│  Default model  : ${CONFIG.defaultModel}`);
  console.log(`│  Rate limit     : ${CONFIG.rateLimitPerMin || "off"} req/min per IP`);
  console.log(`│  Timeout        : ${CONFIG.upstreamTimeoutMs} ms`);
  console.log(`│  GitHub token   : ${CONFIG.github.token ? "loaded ✓" : "not set (add in Settings, or .env)"}`);
  console.log(`└${line}┘\n`);
});
