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
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, appendFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";
import {
  buildAnthropicBody, buildOpenAIBody, downgradeBody, createOpenAIStreamTranslator,
  openAICompletionToSse, openAICompletionToAnthropic, normalizeEffort, sse,
} from "./lib/providers.js";
import { buildCatalog } from "./lib/models.js";
import { createVideoService } from "./lib/video.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
const DATA_DIR = path.join(__dirname, "data");

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

// AI providers. Both can be active at once; the UI picks one per request.
//   codecraft   → OpenAI-compatible  ({base}/chat/completions, Bearer key)
//   agentrouter → Anthropic-compatible ({base}/v1/messages)
const PROVIDERS = {
  codecraft: {
    id: "codecraft", label: "CodeCraft API", style: "openai",
    key: process.env.CODECRAFT_API_KEY || "",
    baseUrl: (process.env.CODECRAFT_BASE_URL || "https://codecraftapi.com/v1").replace(/\/+$/, ""),
    keyUrl: "https://codecraftapi.com/dashboard",
  },
  agentrouter: {
    id: "agentrouter", label: "AgentRouter", style: "anthropic",
    key: process.env.AGENTROUTER_API_KEY || "",
    baseUrl: (process.env.AGENTROUTER_BASE_URL || "https://agentrouter.org").replace(/\/+$/, ""),
    keyUrl: "https://agentrouter.org/console/token",
  },
};
const providerEndpoint = (p) => (p.style === "openai" ? `${p.baseUrl}/chat/completions` : `${p.baseUrl}/v1/messages`);

const CONFIG = {
  host: process.env.HOST || "127.0.0.1",
  port: parseInt(process.env.PORT || "8787", 10),
  // Legacy single-provider fields (AgentRouter) kept for compatibility.
  apiKey: PROVIDERS.agentrouter.key,
  baseUrl: PROVIDERS.agentrouter.baseUrl,
  defaultProvider: PROVIDERS[process.env.DEFAULT_PROVIDER] ? process.env.DEFAULT_PROVIDER
    : (PROVIDERS.agentrouter.key && !PROVIDERS.codecraft.key ? "agentrouter" : "codecraft"),
  defaultModel: process.env.DEFAULT_MODEL || "",
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
  auth: {
    // Login is OFF by default so the app opens directly. Set AUTH_ENABLED=true
    // in .env to require sign-in (a super admin is then created automatically).
    enabled: (process.env.AUTH_ENABLED || "false").toLowerCase() === "true",
    superUser: process.env.SUPERADMIN_USERNAME || "admin",
    superPass: process.env.SUPERADMIN_PASSWORD || "",
    // Known default password used to bootstrap the very first super admin when
    // SUPERADMIN_PASSWORD is left blank. It is applied ONLY on first creation
    // (never authoritatively re-applied), so you can sign in immediately and then
    // change it — your new password will stick across restarts.
    superDefaultPass: process.env.SUPERADMIN_DEFAULT_PASSWORD || "admin",
    sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS || "168", 10), // 7 days
    cookieName: "max_session",
  },
};

// Cap on how much of a repo file we return to the browser (protects memory + context).
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || "524288", 10); // 512 KB
const MAX_TREE_ENTRIES = 4000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2 MB cap on fetched web pages
const MAX_LIST_FILES = 1000;

/* ------------------------------------------------------------------ */
/*  Structured JSON logger + graceful shutdown                         */
/* ------------------------------------------------------------------ */
function log(level, msg, meta = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...meta });
  try { console.log(line); } catch {}
  try {
    ensureDataDir();
    appendFileSync(path.join(DATA_DIR, "app.log"), line + "\n");
  } catch {}
}

/* ------------------------------------------------------------------ */
/*  SSRF protection: block private IP ranges after DNS lookup          */
/* ------------------------------------------------------------------ */
function isPrivateIP(ip) {
  if (!net.isIP(ip)) return false;
  if (net.isIPv4(ip)) {
    const p = ip.split(".").map(Number);
    if (p[0] === 127) return true;
    if (p[0] === 10) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;
  } else {
    if (ip === "::1") return true;
    if (ip.startsWith("fc") || ip.startsWith("fd")) return true;
    if (ip.startsWith("fe80:")) return true;
    if (ip === "::") return true;
  }
  return false;
}
async function assertSafeUrl(urlStr) {
  let u;
  try { u = new URL(urlStr); } catch { throw new Error("Invalid URL"); }
  if (!["http:", "https:"].includes(u.protocol)) throw new Error("Only http/https allowed");
  const host = u.hostname;
  if (host === "localhost" || host === "metadata.google.internal") throw new Error("Blocked host");
  // DNS lookup and check all resolved IPs
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const a of addrs) if (isPrivateIP(a.address)) throw new Error("Blocked private IP: " + a.address);
  } catch (e) {
    if (String(e.message).includes("Blocked")) throw e;
    // If DNS fails, block if hostname is literal private IP
    if (isPrivateIP(host)) throw new Error("Blocked private IP");
  }
}

// Powers catalog. `status: "available"` powers work in MAX right now; the rest are
// catalog entries you can wire up to their real backends (they open Details/links).
const POWERS = [
  { id: "web-fetch", name: "Web Fetch", provider: "MAX", category: "Web", official: true, requiresKey: false, status: "available",
    blurb: "Fetch a web page and drop its readable text into the chat. Use /fetch <url>.", commands: ["/fetch"] },
  { id: "web-search", name: "Web Search", provider: "Tavily / Brave", category: "Web", official: true, requiresKey: true, status: "available",
    blurb: "Search the web and add the top results as context. Use /search <query>.", commands: ["/search"],
    keyHelp: "Paste a Tavily API key (tavily.com) — free tier available.", provider_id: "tavily" },
  { id: "code-runner", name: "Code Runner", provider: "MAX", category: "DevOps", official: true, requiresKey: false, status: "available",
    blurb: "Run HTML/SVG/React/Mermaid code blocks live in a sandboxed preview. Click ▶ Run on any code block." },
  { id: "json-viewer", name: "JSON Formatter", provider: "MAX", category: "Other", official: true, requiresKey: false, status: "available",
    blurb: "Paste JSON and get it prettified, validated, and syntax-highlighted instantly." },
  { id: "regex-tester", name: "Regex Tester", provider: "MAX", category: "Other", official: true, requiresKey: false, status: "available",
    blurb: "Test regex patterns with live match highlighting. Use /regex in the composer." },
  { id: "diff-viewer", name: "Diff Viewer", provider: "MAX", category: "Other", official: true, requiresKey: false, status: "available",
    blurb: "Compare two text blocks side-by-side with highlighted differences." },
  { id: "mermaid", name: "Mermaid Diagrams", provider: "MAX", category: "Design", official: true, requiresKey: false, status: "available",
    blurb: "Render flowcharts, sequence diagrams, and more from Mermaid syntax — click Run on any mermaid code block." },
  { id: "markdown-preview", name: "Markdown Preview", provider: "MAX", category: "Other", official: true, requiresKey: false, status: "available",
    blurb: "Live-render Markdown as formatted HTML with code highlighting." },
  { id: "color-tools", name: "Color Tools", provider: "MAX", category: "Design", official: true, requiresKey: false, status: "available",
    blurb: "Convert colors between hex/rgb/hsl, generate palettes, and preview them." },
  { id: "base64", name: "Base64 Encode/Decode", provider: "MAX", category: "Other", official: true, requiresKey: false, status: "available",
    blurb: "Encode text to base64 or decode base64 back to text." },
  { id: "timestamp", name: "Timestamp Converter", provider: "MAX", category: "Other", official: true, requiresKey: false, status: "available",
    blurb: "Convert between Unix timestamps, ISO dates, and human-readable formats." },
  { id: "jwt-decode", name: "JWT Decoder", provider: "MAX", category: "Security", official: true, requiresKey: false, status: "available",
    blurb: "Decode JWT tokens to inspect header, payload, and expiration without needing online tools." },
  { id: "context7", name: "Context7 Docs", provider: "Context7", category: "AI/ML", official: true, requiresKey: false, status: "catalog",
    blurb: "Up-to-date library documentation for codegen.", url: "https://context7.com" },
  { id: "exa", name: "Exa Web Search & Research", provider: "Exa", category: "Web", official: true, requiresKey: true, status: "catalog",
    blurb: "Neural web search and research.", url: "https://exa.ai" },
  { id: "figma", name: "Design to Code with Figma", provider: "Figma", category: "Design", official: true, requiresKey: false, status: "catalog",
    blurb: "Turn Figma designs into code.", url: "https://figma.com" },
  { id: "postman", name: "API Testing with Postman", provider: "Postman", category: "DevOps", official: true, requiresKey: false, status: "catalog",
    blurb: "Design, test and document APIs.", url: "https://postman.com" },
  { id: "supabase", name: "Build a backend with Supabase", provider: "Supabase", category: "Database", official: true, requiresKey: false, status: "catalog",
    blurb: "Postgres, auth, storage and edge functions.", url: "https://supabase.com" },
  { id: "neon", name: "Build a database with Neon", provider: "Neon", category: "Database", official: true, requiresKey: false, status: "catalog",
    blurb: "Serverless Postgres.", url: "https://neon.tech" },
  { id: "mongodb", name: "MongoDB", provider: "MongoDB Inc.", category: "Database", official: true, requiresKey: false, status: "catalog",
    blurb: "Document database.", url: "https://mongodb.com" },
  { id: "terraform", name: "Deploy infrastructure with Terraform", provider: "HashiCorp", category: "DevOps", official: true, requiresKey: false, status: "catalog",
    blurb: "Infrastructure as code.", url: "https://terraform.io" },
  { id: "stripe", name: "Stripe Payments", provider: "Stripe", category: "Payments", official: true, requiresKey: true, status: "catalog",
    blurb: "Payments, subscriptions and billing.", url: "https://stripe.com" },
  { id: "datadog", name: "Datadog Observability", provider: "Datadog", category: "Observability", official: true, requiresKey: true, status: "catalog",
    blurb: "Metrics, traces and logs.", url: "https://datadoghq.com" },
  { id: "elevenlabs", name: "ElevenLabs", provider: "ElevenLabs", category: "AI/ML", official: true, requiresKey: true, status: "catalog",
    blurb: "High-quality text to speech.", url: "https://elevenlabs.io" },
  { id: "aikido", name: "Scan code with Aikido Security", provider: "Aikido Security", category: "Security", official: true, requiresKey: true, status: "catalog",
    blurb: "Scan code and dependencies for issues.", url: "https://aikido.dev" },
  { id: "brightdata", name: "Web scraping with Bright Data", provider: "Bright Data", category: "Web", official: false, requiresKey: true, status: "catalog",
    blurb: "Scrape sites at scale.", url: "https://brightdata.com" },
  { id: "zapier", name: "Zapier", provider: "Zapier", category: "Other", official: true, requiresKey: false, status: "catalog",
    blurb: "Automate across 6000+ apps.", url: "https://zapier.com" },
];
const POWER_CATEGORIES = ["AWS", "Security", "Database", "Observability", "Payments", "Design", "DevOps", "AI/ML", "Web", "Other"];

const START_TIME = Date.now();

// Full model catalog (CodeCraft + AgentRouter). Users can still type a custom id.
const MODELS = buildCatalog();
if (!CONFIG.defaultModel) {
  CONFIG.defaultModel = CONFIG.defaultProvider === "agentrouter" ? "claude-opus-4-8" : "claude-opus-5";
}

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
// Periodic cleanup so the map can't grow unbounded from unique IPs.
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
    // HTML and the service worker must always be revalidated so updates ship
    // immediately; other static assets can be cached and revalidated cheaply
    // with an ETag (browsers send If-None-Match → we can 304).
    const revalidateOnly = ext === ".html" || filePath.endsWith("sw.js");
    const etag = `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}"`;
    if (!revalidateOnly && req.headers["if-none-match"] === etag) {
      res.writeHead(304, { ETag: etag, "Cache-Control": "public, max-age=0, must-revalidate" });
      res.end();
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "Cache-Control": revalidateOnly ? "no-cache" : "public, max-age=0, must-revalidate",
      ...(revalidateOnly ? {} : { ETag: etag }),
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
function applySecurityHeaders(res, pathname = "") {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(self), geolocation=()");

  // The preview/video sandbox runs untrusted, model-generated code. It is only
  // ever loaded inside <iframe sandbox="allow-scripts"> (opaque origin: no
  // cookies, no access to the app), so it gets its own permissive policy.
  if (pathname === "/sandbox.html") {
    res.setHeader("X-Frame-Options", "SAMEORIGIN");
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'; " +
        "script-src 'unsafe-inline' 'unsafe-eval' https: blob: data:; style-src 'unsafe-inline' https:; " +
        "img-src https: data: blob:; font-src https: data:; media-src https: data: blob:; connect-src https:; worker-src blob:"
    );
    return;
  }
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'; " +
      "script-src 'self' https://cdn.jsdelivr.net; " +
      "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " +
      "font-src 'self' https://fonts.gstatic.com; img-src 'self' data: blob: https://avatars.githubusercontent.com; " +
      "media-src 'self' blob: data:; frame-src 'self'; worker-src 'self' blob:; connect-src 'self' https://cdn.jsdelivr.net"
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
/*  Auth: user store (JSON), scrypt hashing, HMAC session cookies      */
/* ------------------------------------------------------------------ */
const USERS_FILE = path.join(DATA_DIR, "users.json");
const SECRET_FILE = path.join(DATA_DIR, ".session_secret");
const b64url = (buf) => Buffer.from(buf).toString("base64url");

function ensureDataDir() {
  try { if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true }); } catch {}
}

// Persistent HMAC secret so sessions survive restarts.
let SESSION_SECRET = "";
function loadSessionSecret() {
  if (process.env.SESSION_SECRET) { SESSION_SECRET = process.env.SESSION_SECRET; return; }
  ensureDataDir();
  try {
    if (existsSync(SECRET_FILE)) { SESSION_SECRET = readFileSync(SECRET_FILE, "utf8").trim(); }
    if (!SESSION_SECRET) {
      SESSION_SECRET = crypto.randomBytes(48).toString("hex");
      writeFileSync(SECRET_FILE, SESSION_SECRET, { mode: 0o600 });
    }
  } catch {
    SESSION_SECRET = crypto.randomBytes(48).toString("hex"); // in-memory fallback
  }
}

let usersCache = null;
function loadUsers() {
  if (usersCache) return usersCache;
  ensureDataDir();
  try {
    if (existsSync(USERS_FILE)) usersCache = JSON.parse(readFileSync(USERS_FILE, "utf8"));
  } catch {}
  if (!usersCache || !Array.isArray(usersCache.users)) usersCache = { users: [] };
  return usersCache;
}
function saveUsers() {
  ensureDataDir();
  try { writeFileSync(USERS_FILE, JSON.stringify(usersCache, null, 2), { mode: 0o600 }); }
  catch (err) { console.error("[MAX] Could not save users:", err.message); }
}

function hashPassword(password, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(String(password), salt, 64).toString("hex");
  return { salt, hash };
}
function verifyPassword(password, salt, hash) {
  try {
    const test = crypto.scryptSync(String(password), salt, 64);
    const known = Buffer.from(hash, "hex");
    return test.length === known.length && crypto.timingSafeEqual(test, known);
  } catch { return false; }
}

function publicUser(u) {
  if (!u) return null;
  return {
    id: u.id, username: u.username, role: u.role, disabled: !!u.disabled,
    createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null, lastSeenAt: u.lastSeenAt || null,
    loginCount: u.loginCount || 0, mustChangePassword: !!u.mustChangePassword,
  };
}
const findUser = (id) => loadUsers().users.find((u) => u.id === id);
const findByName = (name) => loadUsers().users.find((u) => u.username.toLowerCase() === String(name).toLowerCase());

function createUser({ username, password, role = "user" }) {
  const store = loadUsers();
  username = String(username || "").trim();
  if (!/^[A-Za-z0-9._-]{2,32}$/.test(username)) throw new Error("Username must be 2–32 chars (letters, numbers, . _ -).");
  if (findByName(username)) throw new Error("That username already exists.");
  if (String(password || "").length < 6) throw new Error("Password must be at least 6 characters.");
  const { salt, hash } = hashPassword(password);
  const user = {
    id: crypto.randomUUID(), username, role: role === "superadmin" ? "superadmin" : "user",
    salt, hash, disabled: false, createdAt: Date.now(), lastLoginAt: null, lastSeenAt: null, loginCount: 0,
  };
  store.users.push(user);
  saveUsers();
  return user;
}

// Ensure a super admin exists.
//
// If SUPERADMIN_USERNAME/SUPERADMIN_PASSWORD are set in the environment, they are
// AUTHORITATIVE: on every startup MAX creates that account, or resets its password,
// role and enabled-state to match. This means you can always fix a forgotten
// username/password just by editing .env and restarting — you can't get locked out.
//
// If no SUPERADMIN_PASSWORD is set and there is no super admin yet, MAX generates a
// random password once and prints it to the console.
function ensureSuperAdmin() {
  if (!CONFIG.auth.enabled) return;
  const store = loadUsers();
  const username = (CONFIG.auth.superUser || "admin").trim();

  if (CONFIG.auth.superPass) {
    const { salt, hash } = hashPassword(CONFIG.auth.superPass);
    let u = findByName(username);
    if (u) {
      u.username = username; // normalise casing to match .env
      u.role = "superadmin";
      u.disabled = false;
      u.salt = salt; u.hash = hash;
      u.mustChangePassword = false;
      saveUsers();
      BOOTSTRAP_NOTICE = `Super admin "${username}" synced from .env (username + password applied).`;
    } else {
      store.users.push({
        id: crypto.randomUUID(), username, role: "superadmin", salt, hash,
        disabled: false, createdAt: Date.now(), lastLoginAt: null, lastSeenAt: null, loginCount: 0,
      });
      saveUsers();
      BOOTSTRAP_NOTICE = `Super admin "${username}" created from .env credentials.`;
    }
    return;
  }

  // No env password: only bootstrap once, with a KNOWN default password so you
  // can always sign in on a fresh install without hunting through the console.
  // This is applied once only, and you're asked to change it after first login —
  // whatever you change it to then persists across restarts.
  if (store.users.some((u) => u.role === "superadmin")) return;
  const password = CONFIG.auth.superDefaultPass || "admin";
  const { salt, hash } = hashPassword(password);
  store.users.push({
    id: crypto.randomUUID(), username, role: "superadmin", salt, hash,
    disabled: false, createdAt: Date.now(), lastLoginAt: null, lastSeenAt: null, loginCount: 0,
    mustChangePassword: true,
  });
  saveUsers();
  BOOTSTRAP_NOTICE = `Super admin ready → username: ${username}  password: ${password}\n│  (default login — change it after signing in; set SUPERADMIN_USERNAME / SUPERADMIN_PASSWORD in .env to override)`;
}
let BOOTSTRAP_NOTICE = "";

/* ---------- session tokens (stateless, HMAC-signed) ---------- */
// Persistent revocation map: key = payloadHash, value = exp timestamp.
const REVOKED_FILE = path.join(DATA_DIR, "revoked.json");
const _revokedTokens = new Map();
function loadRevokedTokens() {
  try {
    if (existsSync(REVOKED_FILE)) {
      const arr = JSON.parse(readFileSync(REVOKED_FILE, "utf8"));
      if (Array.isArray(arr)) for (const [h, exp] of arr) if (exp > Date.now()) _revokedTokens.set(h, exp);
    }
  } catch {}
}
function persistRevokedTokens() {
  try {
    ensureDataDir();
    writeFileSync(REVOKED_FILE, JSON.stringify([..._revokedTokens.entries()]), { mode: 0o600 });
  } catch {}
}
loadRevokedTokens();
// Periodically clean expired entries every 10 minutes and persist.
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [hash, exp] of _revokedTokens) if (now > exp) { _revokedTokens.delete(hash); changed = true; }
  if (changed) persistRevokedTokens();
}, 10 * 60_000).unref();

function _revokeToken(token) {
  if (!token || token.indexOf(".") === -1) return;
  const [payload] = token.split(".");
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    const exp = data.exp || Date.now() + CONFIG.auth.sessionTtlHours * 3600_000;
    const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
    _revokedTokens.set(payloadHash, exp);
  } catch {}
}

function _isTokenRevoked(payload) {
  const payloadHash = crypto.createHash("sha256").update(payload).digest("hex");
  return _revokedTokens.has(payloadHash);
}

function signSession(uid) {
  const payload = b64url(JSON.stringify({ uid, exp: Date.now() + CONFIG.auth.sessionTtlHours * 3600_000 }));
  const sig = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
function verifySessionToken(token) {
  if (!token || token.indexOf(".") === -1) return null;
  const [payload, sig] = token.split(".");
  const expected = crypto.createHmac("sha256", SESSION_SECRET).update(payload).digest("base64url");
  const a = Buffer.from(sig || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  if (_isTokenRevoked(payload)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (!data.exp || Date.now() > data.exp) return null;
    return data.uid;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i === -1) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}
function setSessionCookie(res, token) {
  const maxAge = CONFIG.auth.sessionTtlHours * 3600;
  const secure = CONFIG.trustProxy ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${CONFIG.auth.cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`);
}
function clearSessionCookie(res) {
  const secure = CONFIG.trustProxy ? "; Secure" : "";
  res.setHeader("Set-Cookie", `${CONFIG.auth.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${secure}`);
}

// Resolve the authenticated (non-disabled) user for a request, or null.
function authUser(req) {
  if (!CONFIG.auth.enabled) return null;
  const token = parseCookies(req)[CONFIG.auth.cookieName];
  const uid = verifySessionToken(token);
  if (!uid) return null;
  const u = findUser(uid);
  if (!u || u.disabled) return null;
  return u;
}
function touchSeen(u) {
  if (!u) return;
  const now = Date.now();
  if (!u.lastSeenAt || now - u.lastSeenAt > 60_000) { u.lastSeenAt = now; saveUsers(); }
}

/* ------------------------------------------------------------------ */
/*  /api/conversations — server-side persistence (survives browser clear) */
/* ------------------------------------------------------------------ */
const CONVOS_DIR = path.join(DATA_DIR, "conversations");
function ensureConvosDir() {
  try { if (!existsSync(CONVOS_DIR)) mkdirSync(CONVOS_DIR, { recursive: true }); } catch {}
}

function handleConversationsList(req, res) {
  ensureConvosDir();
  const user = authUser(req);
  const prefix = user ? `${user.id}_` : "";
  try {
    const files = readdirSync(CONVOS_DIR).filter((f) => f.endsWith(".json") && f.startsWith(prefix));
    const convos = [];
    for (const f of files) {
      try {
        const raw = readFileSync(path.join(CONVOS_DIR, f), "utf8");
        const c = JSON.parse(raw);
        // Return lightweight metadata (no full message bodies)
        convos.push({ id: c.id, title: c.title, createdAt: c.createdAt, updatedAt: c.updatedAt, messageCount: (c.messages || []).length, repo: c.repo || null });
      } catch {}
    }
    convos.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
    return sendJson(res, 200, { conversations: convos });
  } catch (err) {
    return sendJson(res, 500, { error: { type: "server", message: "Could not list conversations." } });
  }
}

function handleConversationGet(req, res, id) {
  ensureConvosDir();
  const user = authUser(req);
  const prefix = user ? `${user.id}_` : "";
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!safeId) return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid conversation ID." } });
  const file = path.join(CONVOS_DIR, `${prefix}${safeId}.json`);
  try {
    if (!existsSync(file)) return sendJson(res, 404, { error: { type: "not_found", message: "Conversation not found." } });
    const raw = readFileSync(file, "utf8");
    return sendJson(res, 200, JSON.parse(raw));
  } catch {
    return sendJson(res, 500, { error: { type: "server", message: "Could not read conversation." } });
  }
}

async function handleConversationSave(req, res) {
  ensureConvosDir();
  let payload;
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid JSON." } });
  }
  if (!payload || !payload.id || !Array.isArray(payload.messages)) {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Conversation must have 'id' and 'messages' array." } });
  }
  const user = authUser(req);
  const prefix = user ? `${user.id}_` : "";
  const safeId = String(payload.id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  if (!safeId) return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid conversation ID." } });
  const file = path.join(CONVOS_DIR, `${prefix}${safeId}.json`);
  try {
    // Limit size: max 12MB per conversation (attachments included)
    const json = JSON.stringify(payload);
    if (Buffer.byteLength(json, "utf8") > 12 * 1024 * 1024) {
      return sendJson(res, 413, { error: { type: "too_large", message: "Conversation is too large (max 12MB)." } });
    }
    writeFileSync(file, json, "utf8");
    return sendJson(res, 200, { ok: true, id: safeId });
  } catch (err) {
    return sendJson(res, 500, { error: { type: "server", message: "Could not save conversation." } });
  }
}

function handleConversationDelete(req, res, id) {
  ensureConvosDir();
  const user = authUser(req);
  const prefix = user ? `${user.id}_` : "";
  const safeId = String(id).replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 80);
  const file = path.join(CONVOS_DIR, `${prefix}${safeId}.json`);
  try {
    if (existsSync(file)) unlinkSync(file);
    return sendJson(res, 200, { ok: true });
  } catch {
    return sendJson(res, 500, { error: { type: "server", message: "Could not delete conversation." } });
  }
}

/* ------------------------------------------------------------------ */
/*  /api/config                                                        */
/* ------------------------------------------------------------------ */
function handleConfig(req, res) {
  sendJson(res, 200, {
    defaultModel: CONFIG.defaultModel,
    defaultProvider: CONFIG.defaultProvider,
    models: MODELS,
    providers: Object.values(PROVIDERS).map((p) => ({
      id: p.id, label: p.label, style: p.style, hasServerKey: Boolean(p.key), keyUrl: p.keyUrl,
    })),
    allowClientKey: CONFIG.allowClientKey,
    hasServerKey: Object.values(PROVIDERS).some((p) => p.key),
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
    video: video.publicConfig(),
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    uptimeSeconds: Math.round((Date.now() - START_TIME) / 1000),
    node: process.version,
    hasServerKey: Object.values(PROVIDERS).some((p) => p.key),
    providers: Object.fromEntries(Object.values(PROVIDERS).map((p) => [p.id, { hasServerKey: Boolean(p.key) }])),
    github: { hasServerToken: Boolean(CONFIG.github.token) },
    authEnabled: CONFIG.auth.enabled,
  });
}

/* ------------------------------------------------------------------ */
/*  Auth + admin endpoints                                             */
/* ------------------------------------------------------------------ */
const loginAttempts = new Map(); // ip -> { count, resetAt }
// periodic cleanup so this map can't grow unbounded from unique IPs
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of loginAttempts) if (now > b.resetAt) loginAttempts.delete(ip);
}, 5 * 60_000).unref?.();
function loginThrottled(ip) {
  const now = Date.now();
  let b = loginAttempts.get(ip);
  if (!b || now > b.resetAt) { b = { count: 0, resetAt: now + 15 * 60_000 }; loginAttempts.set(ip, b); }
  b.count += 1;
  return b.count > 20; // max 20 attempts / 15 min / IP
}

async function handleLogin(req, res) {
  if (loginThrottled(clientIp(req))) {
    return sendJson(res, 429, { error: { type: "rate_limit", message: "Too many attempts. Try again later." } });
  }
  let payload = {};
  try { payload = JSON.parse((await readBody(req, 64 * 1024)) || "{}"); } catch {}
  const user = findByName(payload.username);
  // Constant-ish work whether or not the user exists.
  const ok = user && !user.disabled && verifyPassword(payload.password, user.salt, user.hash);
  if (!ok) return sendJson(res, 401, { error: { type: "auth", message: "Invalid username or password." } });
  user.lastLoginAt = Date.now();
  user.lastSeenAt = Date.now();
  user.loginCount = (user.loginCount || 0) + 1;
  saveUsers();
  setSessionCookie(res, signSession(user.id));
  sendJson(res, 200, { ok: true, user: publicUser(user) });
}

function handleLogout(req, res) {
  // Revoke the session token server-side so it cannot be replayed.
  const token = parseCookies(req)[CONFIG.auth.cookieName];
  if (token) _revokeToken(token);
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

function handleMe(req, res) {
  const u = authUser(req);
  if (!u) return sendJson(res, 401, { error: { type: "auth", message: "Not signed in." } });
  touchSeen(u);
  sendJson(res, 200, { user: publicUser(u) });
}

// Any signed-in user may change their OWN password.
async function handleChangePassword(req, res) {
  const u = authUser(req);
  if (!u) return sendJson(res, 401, { error: { type: "auth", message: "Not signed in." } });
  let payload = {};
  try { payload = JSON.parse((await readBody(req, 64 * 1024)) || "{}"); } catch {}
  if (!verifyPassword(payload.current, u.salt, u.hash)) {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Current password is incorrect." } });
  }
  if (String(payload.next || "").length < 6) {
    return sendJson(res, 400, { error: { type: "bad_request", message: "New password must be at least 6 characters." } });
  }
  const { salt, hash } = hashPassword(payload.next);
  u.salt = salt; u.hash = hash; u.mustChangePassword = false;
  saveUsers();
  sendJson(res, 200, { ok: true });
}

function requireAdmin(req, res) {
  const u = authUser(req);
  if (!u) { sendJson(res, 401, { error: { type: "auth", message: "Not signed in." } }); return null; }
  if (u.role !== "superadmin") { sendJson(res, 403, { error: { type: "forbidden", message: "Super admin only." } }); return null; }
  return u;
}

function handleAdminList(req, res) {
  const admin = requireAdmin(req, res); if (!admin) return;
  sendJson(res, 200, { ok: true, users: loadUsers().users.map(publicUser) });
}

async function handleAdminCreate(req, res) {
  const admin = requireAdmin(req, res); if (!admin) return;
  let payload = {};
  try { payload = JSON.parse((await readBody(req, 64 * 1024)) || "{}"); } catch {}
  try {
    const u = createUser({ username: payload.username, password: payload.password, role: payload.role });
    sendJson(res, 200, { ok: true, user: publicUser(u) });
  } catch (err) {
    sendJson(res, 400, { error: { type: "bad_request", message: err.message } });
  }
}

// enable/disable/reset-password/delete on a target user
async function handleAdminUpdate(req, res, id, action) {
  const admin = requireAdmin(req, res); if (!admin) return;
  const target = findUser(id);
  if (!target) return sendJson(res, 404, { error: { type: "not_found", message: "User not found." } });

  if (action === "disable" || action === "enable") {
    if (target.id === admin.id) return sendJson(res, 400, { error: { type: "bad_request", message: "You can't disable your own account." } });
    target.disabled = action === "disable";
    saveUsers();
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }
  if (action === "reset") {
    let payload = {};
    try { payload = JSON.parse((await readBody(req, 64 * 1024)) || "{}"); } catch {}
    const next = String(payload.password || "");
    if (next.length < 6) return sendJson(res, 400, { error: { type: "bad_request", message: "Password must be at least 6 characters." } });
    const { salt, hash } = hashPassword(next);
    target.salt = salt; target.hash = hash; target.mustChangePassword = true;
    saveUsers();
    return sendJson(res, 200, { ok: true, user: publicUser(target) });
  }
  if (action === "delete") {
    if (target.id === admin.id) return sendJson(res, 400, { error: { type: "bad_request", message: "You can't delete your own account." } });
    if (target.role === "superadmin" && loadUsers().users.filter((u) => u.role === "superadmin").length <= 1) {
      return sendJson(res, 400, { error: { type: "bad_request", message: "Can't delete the last super admin." } });
    }
    usersCache.users = usersCache.users.filter((u) => u.id !== id);
    saveUsers();
    return sendJson(res, 200, { ok: true });
  }
  sendJson(res, 400, { error: { type: "bad_request", message: "Unknown action." } });
}

/* ------------------------------------------------------------------ */
/*  /api/chat  — streaming proxy (CodeCraft/OpenAI + AgentRouter/Anthropic) */
/* ------------------------------------------------------------------ */
function resolveProvider(payload) {
  const id = String(payload?.provider || CONFIG.defaultProvider).toLowerCase();
  const prov = PROVIDERS[id] || PROVIDERS[CONFIG.defaultProvider];
  const clientKey = CONFIG.allowClientKey ? String(payload?.apiKey || "").trim() : "";
  return { prov, apiKey: clientKey || prov.key };
}

function upstreamHeaders(prov, apiKey, stream) {
  if (prov.style === "openai") {
    return {
      "Content-Type": "application/json",
      Accept: stream ? "text/event-stream" : "application/json",
      Authorization: `Bearer ${apiKey}`,
      "User-Agent": "MAX-chat/2.0",
    };
  }
  return {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    // AgentRouter accepts either header style; send both for compatibility.
    "x-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
    "anthropic-version": "2023-06-01",
    "anthropic-beta": "claude-code-20250219",
    // REQUIRED by AgentRouter — must match the Claude CLI wire image.
    "User-Agent": CONFIG.upstreamUserAgent,
    "x-app": "cli",
  };
}

/**
 * POST to the provider with retries for transient failures and automatic
 * parameter downgrades when a model/gateway rejects an optional parameter
 * (reasoning effort, stream_options, temperature, response_format …).
 * Returns { upstream, body, notes } or throws.
 */
async function callUpstream(prov, apiKey, body, signal, state) {
  const url = providerEndpoint(prov);
  const headers = upstreamHeaders(prov, apiKey, body.stream);
  let transientLeft = 2;
  let downgradesLeft = 4;
  let triedGeneric = false;
  const notes = [];
  for (let attempt = 0; ; attempt++) {
    let upstream;
    try {
      upstream = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
    } catch (err) {
      if (signal.aborted) throw err;
      if (transientLeft-- > 0) { await delay(400 * 2 ** attempt); continue; }
      throw err;
    }
    if (upstream.ok) return { upstream, body, notes };

    if (RETRYABLE_STATUS.has(upstream.status) && transientLeft-- > 0 && !state.timedOut) {
      try { await upstream.text(); } catch {}
      await delay(500 * 2 ** attempt);
      continue;
    }
    if ((upstream.status === 400 || upstream.status === 422) && downgradesLeft-- > 0) {
      const text = await upstream.text().catch(() => "");
      const next = downgradeBody(body, prov.style, text, triedGeneric);
      if (next) {
        if (next.generic) triedGeneric = true;
        const changed = Object.keys({ ...body, ...next.body }).filter((k) => JSON.stringify(body[k]) !== JSON.stringify(next.body[k]));
        notes.push(`HTTP ${upstream.status} → adjusted ${changed.join(", ")}`);
        body = next.body;
        continue;
      }
      // Could not fix it: hand back a Response-like object carrying the text.
      return { upstream: { ok: false, status: upstream.status, text: async () => text, headers: upstream.headers }, body, notes };
    }
    return { upstream, body, notes };
  }
}

/** Anthropic JSON message → SSE (for gateways that ignore stream:true). */
function anthropicJsonToSse(json) {
  let s = sse("message_start", { type: "message_start", message: { ...json, content: [], usage: { input_tokens: json?.usage?.input_tokens || 0, output_tokens: 0 } } });
  (json?.content || []).forEach((b, i) => {
    if (b.type === "text") {
      s += sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "text", text: "" } });
      s += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "text_delta", text: b.text || "" } });
    } else if (b.type === "tool_use") {
      s += sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "tool_use", id: b.id, name: b.name, input: {} } });
      s += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "input_json_delta", partial_json: JSON.stringify(b.input || {}) } });
    } else if (b.type === "thinking") {
      s += sse("content_block_start", { type: "content_block_start", index: i, content_block: { type: "thinking", thinking: "" } });
      s += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "thinking_delta", thinking: b.thinking || "" } });
      if (b.signature) s += sse("content_block_delta", { type: "content_block_delta", index: i, delta: { type: "signature_delta", signature: b.signature } });
    } else return;
    s += sse("content_block_stop", { type: "content_block_stop", index: i });
  });
  s += sse("message_delta", { type: "message_delta", delta: { stop_reason: json?.stop_reason || "end_turn" }, usage: json?.usage || {} });
  s += sse("message_stop", { type: "message_stop" });
  return s;
}

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

  const { prov, apiKey } = resolveProvider(payload);
  if (!apiKey) {
    return sendJson(res, 401, {
      error: {
        type: "no_api_key",
        message: `No ${prov.label} key configured. Add ${prov.id === "codecraft" ? "CODECRAFT_API_KEY" : "AGENTROUTER_API_KEY"} to .env, or paste your key in Settings → AI providers.`,
      },
    });
  }

  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : CONFIG.defaultModel;
  const messages = Array.isArray(payload.messages) ? payload.messages : [];
  if (!model || model.length > 120) {
    return sendJson(res, 400, { error: { type: "bad_request", message: "A valid model ID is required." } });
  }
  if (!messages.length || !messages.every(isValidMessage)) {
    return sendJson(res, 400, {
      error: { type: "bad_request", message: "messages must be a non-empty array of valid user/assistant messages." },
    });
  }

  // Canonical (Anthropic-shaped) body; translated per provider below.
  const base = {
    model,
    max_tokens: clampInt(payload.max_tokens, 1, 64000, 8192),
    messages,
    stream: payload.stream !== false,
  };
  if (payload.system) base.system = payload.system;
  if (payload.temperature !== undefined && payload.temperature !== null) {
    base.temperature = clampFloat(payload.temperature, 0, 1, 1);
  }
  const tools = sanitizeTools(payload.tools);
  if (tools) {
    base.tools = tools;
    if (payload.tool_choice && typeof payload.tool_choice === "object") base.tool_choice = payload.tool_choice;
  }
  const effort = normalizeEffort(payload.effort);
  const json = payload.json === true;
  const body = prov.style === "openai"
    ? buildOpenAIBody(base, { effort, json })
    : buildAnthropicBody(base, { effort, model });

  // Abort only when the response connection closes early.
  const controller = new AbortController();
  const st = { timedOut: false };
  // INACTIVITY timeout, re-armed on every streamed chunk (long answers are fine).
  const idleMs = Math.max(1_000, CONFIG.upstreamTimeoutMs);
  let timeout = null;
  const armTimeout = () => {
    if (timeout) clearTimeout(timeout);
    timeout = setTimeout(() => { st.timedOut = true; controller.abort(); }, idleMs);
  };
  armTimeout();
  const abortOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
  res.once("close", abortOnDisconnect);
  const cleanup = () => { clearTimeout(timeout); res.off("close", abortOnDisconnect); };

  const upstreamUrl = providerEndpoint(prov);
  let result;
  try {
    result = await callUpstream(prov, apiKey, body, controller.signal, st);
  } catch (err) {
    cleanup();
    if (controller.signal.aborted && !st.timedOut) return; // client left
    const cause = err?.cause?.code || err?.cause?.message || err?.code || err?.message || "unknown error";
    console.error(`[MAX] Upstream fetch failed (${upstreamUrl}):`, cause);
    return sendJson(res, st.timedOut ? 504 : 502, {
      error: {
        type: st.timedOut ? "timeout" : "network",
        message: st.timedOut
          ? `${prov.label} took too long to respond. Please try again.`
          : `Could not reach ${prov.label} at ${upstreamUrl} (${cause}). Check your internet connection and the provider base URL.`,
      },
    });
  }
  const { upstream, notes } = result;
  if (notes.length) console.log(`[MAX] ${prov.id}/${model}: compatibility fallback (${notes.join("; ")})`);

  if (!upstream.ok) {
    cleanup();
    let detail = "";
    try { detail = await upstream.text(); } catch {}
    let parsed = null;
    try { parsed = JSON.parse(detail); } catch {}
    let message = parsed?.error?.message || parsed?.message || (typeof parsed?.error === "string" ? parsed.error : "") ||
      detail || `Upstream returned HTTP ${upstream.status}`;
    if (upstream.status === 401 || upstream.status === 403) {
      message = `${prov.label} rejected the API key (${upstream.status}): ${message}`;
    } else if (upstream.status === 404 && /model/i.test(message)) {
      message = `${prov.label} doesn't recognise the model "${model}": ${message}`;
    }
    return sendJson(res, upstream.status, {
      error: { type: mapStatusType(upstream.status), status: upstream.status, message: String(message).slice(0, 2000), provider: prov.id },
    });
  }

  const ctype = String(upstream.headers?.get?.("content-type") || "");
  const isSse = /event-stream/i.test(ctype);

  // Non-streaming request.
  if (!result.body.stream) {
    try {
      const text = await upstream.text();
      let out = text;
      if (prov.style === "openai") {
        try { out = JSON.stringify(openAICompletionToAnthropic(JSON.parse(text), model)); } catch {}
      }
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
      res.end(out);
    } finally { cleanup(); }
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache, no-transform",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
    "X-Max-Provider": prov.id,
  });
  // Heartbeat comments keep proxies from closing the connection during long
  // silent "thinking" phases (ignored by the browser's SSE parser).
  const heartbeat = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15_000);

  // Gateway ignored stream:true and returned a JSON body → synthesize events.
  if (!isSse) {
    try {
      const text = await upstream.text();
      const parsed = JSON.parse(text);
      res.write(prov.style === "openai" ? openAICompletionToSse(parsed, model) : anthropicJsonToSse(parsed));
    } catch (err) {
      res.write(sse("error", { type: "error", error: { message: "Unexpected response from provider: " + (err?.message || "parse error") } }));
    } finally {
      clearInterval(heartbeat); cleanup();
      if (!res.writableEnded) res.end();
    }
    return;
  }

  const translator = prov.style === "openai" ? createOpenAIStreamTranslator(model) : null;
  try {
    const reader = upstream.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (res.writableEnded || res.destroyed) break;
      armTimeout();
      if (translator) {
        const out = translator.push(value);
        if (out) res.write(out);
      } else {
        res.write(Buffer.from(value));
      }
    }
    if (translator && !res.writableEnded && !res.destroyed) res.write(translator.end());
  } catch (err) {
    if (st.timedOut && !res.writableEnded && !res.destroyed) {
      try { res.write(sse("error", { type: "error", error: { message: `${prov.label} went silent for too long (timeout).` } })); } catch {}
    } else if (!controller.signal.aborted && !res.writableEnded && !res.destroyed) {
      try { res.write(sse("error", { type: "error", error: { message: err?.message || "stream error" } })); } catch {}
    }
  } finally {
    clearInterval(heartbeat);
    cleanup();
    if (!res.writableEnded) { try { res.end(); } catch {} }
  }
}

/** Refresh the model list straight from a provider's /models endpoint. */
async function handleModelsRefresh(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req, 64 * 1024)) || "{}"); } catch {}
  const { prov, apiKey } = resolveProvider(payload);
  if (!apiKey) return sendJson(res, 401, { error: { type: "no_api_key", message: `Add a ${prov.label} key first.` } });
  const url = prov.style === "openai" ? `${prov.baseUrl}/models` : `${prov.baseUrl}/v1/models`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15_000);
  try {
    const r = await fetch(url, { headers: upstreamHeaders(prov, apiKey, false), signal: controller.signal });
    const text = await r.text().catch(() => "");
    let json = null; try { json = JSON.parse(text); } catch {}
    if (!r.ok) return sendJson(res, r.status, { error: { type: mapStatusType(r.status), message: json?.error?.message || `HTTP ${r.status}` } });
    const list = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
    const ids = list.map((x) => (typeof x === "string" ? x : x?.id)).filter((x) => typeof x === "string" && x.length < 120);
    return sendJson(res, 200, { ok: true, provider: prov.id, models: ids });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach ${prov.label} (${err?.cause?.code || err?.message}).` } });
  } finally { clearTimeout(timer); }
}

const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

function isValidMessage(message) {
  if (!message || !["user", "assistant"].includes(message.role)) return false;
  if (typeof message.content === "string") return message.content.length > 0;
  if (!Array.isArray(message.content) || !message.content.length) return false;
  return message.content.every((block) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === "text") return typeof block.text === "string";
    // Agentic tool-use blocks (assistant) and their results (user).
    if (block.type === "tool_use") {
      return typeof block.id === "string" && typeof block.name === "string" &&
        block.input !== undefined && block.input !== null;
    }
    if (block.type === "tool_result") {
      return typeof block.tool_use_id === "string";
    }
    // Extended-thinking blocks must be echoed back verbatim during tool loops.
    if (block.type === "thinking") return typeof block.thinking === "string";
    if (block.type === "redacted_thinking") return typeof block.data === "string";
    // Document blocks (e.g. PDF sent as base64)
    if (block.type === "document") {
      return block.source?.type === "base64" &&
        typeof block.source.media_type === "string" &&
        typeof block.source.data === "string" && block.source.data.length > 0;
    }
    return block.type === "image" && block.source?.type === "base64" &&
      ALLOWED_IMAGE_TYPES.has(block.source.media_type) && typeof block.source.data === "string" &&
      block.source.data.length > 0;
  });
}

// Validate + trim a tools array coming from the browser. Only the fields the
// Anthropic Messages API expects are forwarded; anything malformed is dropped.
function sanitizeTools(tools) {
  if (!Array.isArray(tools) || !tools.length) return null;
  const out = [];
  for (const t of tools.slice(0, 32)) {
    if (!t || typeof t.name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(t.name)) continue;
    const schema = t.input_schema && typeof t.input_schema === "object"
      ? t.input_schema : { type: "object", properties: {} };
    const tool = { name: t.name, input_schema: schema };
    if (typeof t.description === "string") tool.description = t.description.slice(0, 4000);
    out.push(tool);
  }
  return out.length ? out : null;
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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Sanitize + validate a set of file edits for committing. Each entry is either
// a write { path, content } or a deletion { path, deleted:true }.
function normalizeFiles(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const out = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string") return null;
    const p = sanitizeRepoPath(f.path);
    if (!p) return null;
    if (f.deleted === true) { out.push({ path: p, deleted: true }); continue; }
    if (typeof f.content !== "string") return null;
    if (Buffer.byteLength(f.content, "utf8") > MAX_FILE_BYTES) return null;
    out.push({ path: p, content: f.content });
  }
  return out.length ? out : null;
}
function defaultBranchName() {
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}`;
  return `max/edit-${stamp}`;
}
function safeBranchName(name) {
  const s = String(name || "").trim().replace(/[^A-Za-z0-9._/-]/g, "-").replace(/^[-/]+|[-/]+$/g, "").slice(0, 120);
  return s || defaultBranchName();
}

/* ------------------------------------------------------------------ */
/*  /api/test — cheap connectivity/key check against the AI provider   */
/* ------------------------------------------------------------------ */
async function handleTest(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const { prov, apiKey } = resolveProvider(payload);
  if (!apiKey) {
    return sendJson(res, 401, { error: { type: "no_api_key", message: `No ${prov.label} key configured.` } });
  }
  const model = typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : CONFIG.defaultModel;
  const base = { model, max_tokens: 16, messages: [{ role: "user", content: "ping" }], stream: false };
  const body = prov.style === "openai" ? buildOpenAIBody(base, {}) : base;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  const started = Date.now();
  try {
    const { upstream: r } = await callUpstream(prov, apiKey, body, controller.signal, { timedOut: false });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      let msg = `HTTP ${r.status}`;
      try { const j = JSON.parse(text); msg = j?.error?.message || j?.message || msg; } catch {}
      return sendJson(res, r.status, { error: { type: mapStatusType(r.status), status: r.status, message: `${prov.label}: ${msg}` } });
    }
    return sendJson(res, 200, {
      ok: true, provider: prov.id, model, ms: Date.now() - started,
      message: `${prov.label} OK — ${model} answered in ${Date.now() - started} ms.`,
    });
  } catch (err) {
    const cause = err?.cause?.code || err?.cause?.message || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach ${prov.label} (${cause}).` } });
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

async function githubApi(token, method, apiPath, body, opts = {}) {
  const url = apiPath.startsWith("http") ? apiPath : `${CONFIG.github.apiBase}${apiPath}`;
  const accept = opts.accept || "application/vnd.github+json";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || 25_000);
  const cacheable = method === "GET" && !opts.noCache;
  const key = cacheable ? ghCacheKey(token, url, accept) : null;
  const cached = key ? GH_ETAG_CACHE.get(key) : null;
  try {
    const r = await fetch(url, {
      method,
      headers: {
        Accept: accept,
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "MAX-chat",
        ...(cached?.etag ? { "If-None-Match": cached.etag } : {}),
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    if (r.status === 304 && cached) {
      // refresh LRU position
      GH_ETAG_CACHE.delete(key); GH_ETAG_CACHE.set(key, cached);
      // A 304 carries no Link/pagination headers — merge the cached ones back in.
      const headers = new Headers(cached.headers || {});
      for (const [k, v] of r.headers) headers.set(k, v);
      return { status: cached.status, ok: true, json: cached.json, text: cached.text, headers, cached: true };
    }
    const text = await r.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    const etag = r.headers.get("etag");
    if (key && r.ok && etag && text.length < 8 * 1024 * 1024) {
      GH_ETAG_CACHE.set(key, { etag, status: r.status, text, json, headers: Object.fromEntries(r.headers) });
      if (GH_ETAG_CACHE.size > GH_ETAG_MAX) GH_ETAG_CACHE.delete(GH_ETAG_CACHE.keys().next().value);
    }
    return { status: r.status, ok: r.ok, json, text, headers: r.headers };
  } finally {
    clearTimeout(timer);
  }
}

function ghError(res, resp, fallback) {
  let message = resp?.json?.message || resp?.text || fallback || "GitHub request failed";
  const status = resp?.status || 502;
  const remaining = resp?.headers?.get?.("x-ratelimit-remaining");
  if ((status === 403 || status === 429) && (remaining === "0" || /rate limit/i.test(message))) {
    const reset = Number(resp?.headers?.get?.("x-ratelimit-reset")) * 1000;
    const mins = reset ? Math.max(1, Math.round((reset - Date.now()) / 60000)) : null;
    message = `GitHub API rate limit reached${mins ? ` — it resets in about ${mins} minute${mins > 1 ? "s" : ""}` : ""}. ` +
      "MAX caches responses to minimise calls; using a personal access token raises the limit to 5,000 requests/hour.";
    return sendJson(res, 429, { error: { type: "rate_limit", status: 429, message } });
  }
  // GitHub returns this generic 403 when a fine-grained token is missing the
  // right permission or the repo isn't in its allowed list. Give real guidance.
  if (/resource not accessible by (personal access token|integration)/i.test(message) ||
      (status === 403 && /not accessible/i.test(message))) {
    message =
      "GitHub blocked this token (\"Resource not accessible by personal access token\"). " +
      "Your token is missing repository access. Fix it by creating a token that can read the repo:\n" +
      "• Classic token: enable the \"repo\" scope.\n" +
      "• Fine-grained token: under \"Repository access\" select this repository, and grant " +
      "\"Contents: Read and write\" (plus \"Pull requests: Read and write\" if you want PRs).\n" +
      "Then paste the new token in Settings → GitHub and try again.";
  } else if (status === 401) {
    message = "GitHub rejected the token (401). It may be invalid or expired — generate a new one and paste it in Settings → GitHub.";
  } else if (status === 404 && !resp?.json?.message) {
    message = fallback || "Not found on GitHub (check the repository name and that your token can see it).";
  }
  return sendJson(res, status, {
    error: { type: mapStatusType(status), status, message },
  });
}

async function handleGithubTest(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided." } });

  try {
    const who = await githubApi(gh.token, "GET", "/user");
    if (!who.ok) return ghError(res, who, "Token rejected by GitHub.");
    const login = who.json?.login;
    const scopes = who.headers?.get?.("x-oauth-scopes") || "";
    const rateRemaining = who.headers?.get?.("x-ratelimit-remaining");
    const base = { ok: true, login, name: who.json?.name || "", avatarUrl: who.json?.avatar_url || "", scopes, rateRemaining };
    // Owner/repo are optional: without them we just validate the token.
    if (!gh.owner || !gh.repo) {
      return sendJson(res, 200, { ...base, message: `Connected to GitHub as ${login}. Pick a repository with the repo chip.` });
    }
    const repo = await githubApi(gh.token, "GET", ghRepoRoot(gh));
    if (!repo.ok) return ghError(res, repo, `Repository ${gh.owner}/${gh.repo} not found or not accessible with this token.`);
    const canPush = repo.json?.permissions?.push !== false;
    return sendJson(res, 200, {
      ...base,
      repo: repo.json?.full_name,
      defaultBranch: repo.json?.default_branch,
      canPush,
      message: canPush
        ? `Connected as ${login}. Ready to read & push to ${repo.json?.full_name}.`
        : `Connected as ${login}, but this token can only READ ${repo.json?.full_name} (no push permission).`,
    });
  } catch (err) {
    return ghNetErr(res, err);
  }
}

async function handleGithubRepos(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided. Add one in Settings." } });

  const q = String(payload.q || "").trim().toLowerCase();
  const MAX_PAGES = 10; // up to 1,000 repositories
  const pageUrl = (p) => `/user/repos?per_page=100&page=${p}&sort=pushed&direction=desc&affiliation=owner,collaborator,organization_member`;

  try {
    const first = await githubApi(gh.token, "GET", pageUrl(1));
    if (!first.ok) return ghError(res, first, "Could not list repositories.");
    let list = Array.isArray(first.json) ? first.json.slice() : [];
    // Use the Link header to fetch the remaining pages in parallel.
    const link = first.headers?.get?.("link") || "";
    const last = Number((link.match(/[?&]page=(\d+)[^>]*>;\s*rel="last"/) || [])[1] || 1);
    const pages = Math.min(MAX_PAGES, last);
    if (pages > 1) {
      const rest = await Promise.all(
        Array.from({ length: pages - 1 }, (_, i) => githubApi(gh.token, "GET", pageUrl(i + 2)).catch(() => null)));
      for (const r of rest) if (r?.ok && Array.isArray(r.json)) list = list.concat(r.json);
    }
    let repos = list.map(mapGhRepo);
    const seen = new Set(repos.map((r) => r.fullName.toLowerCase()));

    if (q) {
      repos = repos.filter((x) => x.fullName.toLowerCase().includes(q) || (x.description || "").toLowerCase().includes(q));
      // "owner/repo" typed directly → look it up (works for any public repo too).
      const direct = q.replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/+$/, "");
      if (/^[\w.-]+\/[\w.-]+$/.test(direct) && !seen.has(direct)) {
        const r = await githubApi(gh.token, "GET", `/repos/${direct.split("/").map(encodeURIComponent).join("/")}`);
        if (r.ok && r.json?.full_name) repos.unshift(mapGhRepo(r.json));
      }
    }
    return sendJson(res, 200, { ok: true, repos, total: list.length, truncated: last > MAX_PAGES, fetchedAt: Date.now() });
  } catch (err) {
    return ghNetErr(res, err);
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

// Conditional-request cache for GitHub GETs. GitHub answers If-None-Match with
// 304 Not Modified (which does NOT count against the rate limit), so we can
// re-check repos/trees/files on every chat and still always be fresh + fast.
const GH_ETAG_CACHE = new Map(); // key -> { etag, status, text, json, headers }

const GH_ETAG_MAX = 400;

function ghCacheKey(token, url, accept) {
  return crypto.createHash("sha256").update(`${token}\n${accept}\n${url}`).digest("hex");
}

const ghNetErr = (res, err) => sendJson(res, 502, {
  error: { type: "network", message: `Could not reach GitHub (${err?.cause?.code || err?.name === "AbortError" && "timeout" || err?.message || "unknown error"}).` },
});

const ghRepoRoot = (gh) => `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`;

function mapGhRepo(x) {
  return {
    fullName: x.full_name,
    owner: x.owner?.login || "",
    name: x.name,
    private: Boolean(x.private),
    defaultBranch: x.default_branch || "main",
    description: x.description || "",
    updatedAt: x.pushed_at || x.updated_at || null,
    language: x.language || "",
    fork: Boolean(x.fork),
    archived: Boolean(x.archived),
    canPush: x.permissions ? x.permissions.push !== false : true,
  };
}

async function handleGithubBranches(req, res) {
  let payload = {};
  try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided." } });
  if (!gh.owner || !gh.repo) return sendJson(res, 400, { error: { type: "bad_request", message: "Owner and repository are required." } });
  try {
    let branches = [];
    for (let page = 1; page <= 3; page++) {
      const r = await githubApi(gh.token, "GET", `${ghRepoRoot(gh)}/branches?per_page=100&page=${page}`);
      if (!r.ok) { if (page === 1) return ghError(res, r, "Could not list branches."); break; }
      const list = Array.isArray(r.json) ? r.json : [];
      branches = branches.concat(list.map((b) => ({ name: b.name, protected: Boolean(b.protected), sha: b.commit?.sha || "" })));
      if (list.length < 100) break;
    }
    return sendJson(res, 200, { ok: true, branches });
  } catch (err) {
    return ghNetErr(res, err);
  }
}

function looksBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
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
    const r = await githubApi(gh.token, "GET", `${ghRepoRoot(gh)}/git/trees/${encodeURIComponent(gh.branch)}?recursive=1`);
    if (r.status === 409) return sendJson(res, 200, { ok: true, branch: gh.branch, sha: "", files: [], empty: true });
    if (!r.ok) return ghError(res, r, `Could not read the repository tree for branch "${gh.branch}".`);
    const files = (r.json?.tree || [])
      .filter((t) => t.type === "blob")
      .slice(0, MAX_TREE_ENTRIES)
      .map((t) => ({ path: t.path, size: t.size || 0 }));
    return sendJson(res, 200, {
      ok: true, branch: gh.branch, sha: r.json?.sha || "", truncated: Boolean(r.json?.truncated) || (r.json?.tree || []).length > MAX_TREE_ENTRIES,
      files, cached: Boolean(r.cached),
    });
  } catch (err) {
    return ghNetErr(res, err);
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
  const url = `${ghRepoRoot(gh)}/contents/${enc}?ref=${encodeURIComponent(gh.branch)}`;
  try {
    const r = await githubApi(gh.token, "GET", url);
    if (!r.ok) return ghError(res, r, `Could not read ${filePath} (not found on branch "${gh.branch}").`);
    if (Array.isArray(r.json)) return sendJson(res, 400, { error: { type: "bad_request", message: "That path is a directory, not a file." } });
    const size = r.json?.size || 0;
    if (size > MAX_FILE_BYTES) return sendJson(res, 413, { error: { type: "too_large", message: `File is too large to load (${Math.round(size / 1024)} KB, limit ${Math.round(MAX_FILE_BYTES / 1024)} KB).` } });
    let buf;
    if (r.json?.encoding === "base64" && typeof r.json?.content === "string" && (r.json.content || size === 0)) {
      buf = Buffer.from(r.json.content, "base64");
    } else {
      // Files > 1 MB come back with encoding "none" — fetch the raw bytes instead.
      const raw = await githubApi(gh.token, "GET", url, null, { accept: "application/vnd.github.raw" });
      if (!raw.ok) return ghError(res, raw, "Could not read the file.");
      buf = Buffer.from(raw.text || "", "utf8");
    }
    if (looksBinary(buf)) {
      return sendJson(res, 415, { error: { type: "unsupported", message: `${filePath} is a binary file (${Math.round(size / 1024)} KB) and can't be loaded as text.` } });
    }
    return sendJson(res, 200, { ok: true, path: filePath, size, sha: r.json?.sha || "", content: buf.toString("utf8") });
  } catch (err) {
    return ghNetErr(res, err);
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
    return { status: r.status, ok: r.ok, json, text, headers: r.headers };
  } finally {
    clearTimeout(timer);
  }
}

// Follow GitLab's x-next-page header across pages.

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
    const r = await gitlabAll(gl.token,
      `/projects?membership=true&simple=true&order_by=last_activity_at${q ? `&search=${encodeURIComponent(q)}` : ""}`, 5);
    if (r.error) return glError(res, r.error, "Could not list projects.");
    const repos = r.items.map((p) => ({
      id: p.id,
      fullName: p.path_with_namespace,
      owner: p.namespace?.full_path || p.namespace?.path || "",
      name: p.path,
      private: p.visibility !== "public",
      defaultBranch: p.default_branch || "main",
      description: p.description || "",
      updatedAt: p.last_activity_at || null,
    }));
    return sendJson(res, 200, { ok: true, repos, truncated: r.more, fetchedAt: Date.now() });
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
    const r = await gitlabAll(gl.token,
      `/projects/${glProjectPath(gl.projectId)}/repository/tree?recursive=true&ref=${encodeURIComponent(gl.branch)}`,
      Math.ceil(MAX_TREE_ENTRIES / 100));
    if (r.error) {
      if (r.error.status === 404) return sendJson(res, 200, { ok: true, branch: gl.branch, files: [], empty: true });
      return glError(res, r.error, "Could not read the repository tree.");
    }
    const files = r.items
      .filter((t) => t.type === "blob")
      .slice(0, MAX_TREE_ENTRIES)
      .map((t) => ({ path: t.path, size: 0 }));
    return sendJson(res, 200, { ok: true, branch: gl.branch, files, truncated: r.more });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitLab (${err?.cause?.code || err?.message}).` } });
  }
}

async function gitlabAll(token, apiPath, maxPages) {
  let out = [];
  let page = 1;
  for (let i = 0; i < maxPages && page; i++) {
    const sep = apiPath.includes("?") ? "&" : "?";
    const r = await gitlabApi(token, "GET", `${apiPath}${sep}per_page=100&page=${page}`);
    if (!r.ok) { if (i === 0) return { error: r }; break; }
    if (Array.isArray(r.json)) out = out.concat(r.json);
    page = Number(r.headers?.get?.("x-next-page")) || 0;
  }
  return { items: out, more: Boolean(page) };
}

async function handleGitlabBranches(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const gl = resolveGitlab(payload);
  if (!gl.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitLab token provided." } });
  if (!gl.projectId) return sendJson(res, 400, { error: { type: "bad_request", message: "A project is required." } });
  try {
    const r = await gitlabAll(gl.token, `/projects/${glProjectPath(gl.projectId)}/repository/branches`, 3);
    if (r.error) return glError(res, r.error, "Could not list branches.");
    return sendJson(res, 200, { ok: true, branches: r.items.map((b) => ({ name: b.name, protected: Boolean(b.protected), sha: b.commit?.id || "" })) });
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
/*  Edit → commit → PR/MR (GitHub + GitLab)                            */
/* ------------------------------------------------------------------ */
// One atomic commit for any number of files via the Git Data API
// (blobs → tree → commit → ref) — much faster than one commit per file.
async function handleGithubCommit(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid JSON body." } });
  }
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided." } });
  if (!gh.owner || !gh.repo) return sendJson(res, 400, { error: { type: "bad_request", message: "Owner and repository are required." } });
  const files = normalizeFiles(payload.files);
  if (!files) return sendJson(res, 400, { error: { type: "bad_request", message: "files must be a non-empty array of { path, content } within the size limit." } });

  const base = gh.branch;
  const target = safeBranchName(payload.newBranch || defaultBranchName());
  const message = String(payload.message || `MAX edit: ${files.map((f) => f.path).join(", ")}`).slice(0, 500);
  const root = ghRepoRoot(gh);
  const refPath = (b) => `${root}/git/ref/heads/${b.split("/").map(encodeURIComponent).join("/")}`;

  try {
    const baseRef = await githubApi(gh.token, "GET", refPath(base), null, { noCache: true });
    if (!baseRef.ok) return ghError(res, baseRef, `Could not find base branch "${base}".`);
    let parentSha = baseRef.json?.object?.sha;
    let targetExists = target === base;
    if (target !== base) {
      const t = await githubApi(gh.token, "GET", refPath(target), null, { noCache: true });
      if (t.ok) { targetExists = true; parentSha = t.json?.object?.sha || parentSha; }
    }

    const parent = await githubApi(gh.token, "GET", `${root}/git/commits/${parentSha}`);
    if (!parent.ok) return ghError(res, parent, "Could not read the branch head commit.");
    const baseTree = parent.json?.tree?.sha;

    // Existing paths (for safe deletions + preserving executable modes).
    const modes = new Map();
    let treeTruncated = false;
    const tree = await githubApi(gh.token, "GET", `${root}/git/trees/${baseTree}?recursive=1`);
    if (tree.ok) {
      treeTruncated = Boolean(tree.json?.truncated);
      for (const t of tree.json?.tree || []) if (t.type === "blob") modes.set(t.path, t.mode);
    }

    const entries = [];
    const committed = [];
    for (const f of files) {
      if (f.deleted) {
        if (!modes.has(f.path) && !treeTruncated) { committed.push({ path: f.path, deleted: true, skipped: true }); continue; }
        entries.push({ path: f.path, mode: modes.get(f.path) || "100644", type: "blob", sha: null });
        committed.push({ path: f.path, deleted: true });
      } else {
        entries.push({ path: f.path, mode: modes.get(f.path) || "100644", type: "blob", content: f.content });
        committed.push({ path: f.path, updated: modes.has(f.path) });
      }
    }
    if (!entries.length) return sendJson(res, 400, { error: { type: "bad_request", message: "Nothing to commit (the files to delete don't exist)." } });

    const newTree = await githubApi(gh.token, "POST", `${root}/git/trees`, { base_tree: baseTree, tree: entries });
    if (!newTree.ok) return ghError(res, newTree, "Could not create the commit tree.");
    const commit = await githubApi(gh.token, "POST", `${root}/git/commits`, { message, tree: newTree.json.sha, parents: [parentSha] });
    if (!commit.ok) return ghError(res, commit, "Could not create the commit.");

    const upd = targetExists
      ? await githubApi(gh.token, "PATCH", `${root}/git/refs/heads/${target.split("/").map(encodeURIComponent).join("/")}`, { sha: commit.json.sha, force: false })
      : await githubApi(gh.token, "POST", `${root}/git/refs`, { ref: `refs/heads/${target}`, sha: commit.json.sha });
    if (!upd.ok) return ghError(res, upd, targetExists ? `Could not push to "${target}" (the branch may have moved — try again).` : "Could not create the working branch.");

    return sendJson(res, 200, {
      ok: true, provider: "github", branch: target, base, files: committed,
      commitSha: commit.json.sha, commitUrl: commit.json.html_url || `https://github.com/${gh.owner}/${gh.repo}/commit/${commit.json.sha}`,
      message: `Committed ${committed.filter((c) => !c.skipped).length} file(s) to ${gh.owner}/${gh.repo}@${target} in one commit.`,
    });
  } catch (err) {
    return ghNetErr(res, err);
  }
}

async function handleGithubPr(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid JSON body." } });
  }
  const gh = resolveGithub(payload);
  if (!gh.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitHub token provided." } });
  if (!gh.owner || !gh.repo) return sendJson(res, 400, { error: { type: "bad_request", message: "Owner and repository are required." } });
  const head = safeBranchName(payload.head);
  const baseBranch = String(payload.base || gh.branch || "main").trim();
  const title = String(payload.title || `MAX changes`).slice(0, 250);
  const bodyText = String(payload.body || "Opened by MAX.").slice(0, 8000);
  try {
    const pr = await githubApi(gh.token, "POST", `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/pulls`,
      { title, head, base: baseBranch, body: bodyText });
    if (!pr.ok) return ghError(res, pr, "Could not open the pull request.");
    return sendJson(res, 200, { ok: true, url: pr.json?.html_url, number: pr.json?.number, message: `Opened PR #${pr.json?.number}.` });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitHub (${err?.cause?.code || err?.message}).` } });
  }
}

async function handleGitlabCommit(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid JSON body." } });
  }
  const gl = resolveGitlab(payload);
  if (!gl.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitLab token provided." } });
  if (!gl.projectId) return sendJson(res, 400, { error: { type: "bad_request", message: "A project is required." } });
  const files = normalizeFiles(payload.files);
  if (!files) return sendJson(res, 400, { error: { type: "bad_request", message: "files must be a non-empty array of { path, content } within the size limit." } });

  const base = gl.branch;
  const newBranch = safeBranchName(payload.newBranch || defaultBranchName());
  const message = String(payload.message || `MAX edit: ${files.map((f) => f.path).join(", ")}`).slice(0, 500);
  const proj = `/projects/${glProjectPath(gl.projectId)}`;

  try {
    // Decide create/update/delete for each file by checking existence on the base branch.
    const actions = [];
    for (const f of files) {
      const head = await gitlabApi(gl.token, "GET", `${proj}/repository/files/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(base)}`);
      if (f.deleted) {
        if (head.ok) actions.push({ action: "delete", file_path: f.path }); // skip if it doesn't exist
        continue;
      }
      actions.push({ action: head.ok ? "update" : "create", file_path: f.path, content: f.content });
    }
    if (!actions.length) return sendJson(res, 400, { error: { type: "bad_request", message: "Nothing to commit (files may not exist on the base branch)." } });
    const commit = await gitlabApi(gl.token, "POST", `${proj}/repository/commits`, {
      branch: newBranch, start_branch: base, commit_message: message, actions,
    });
    if (!commit.ok) return glError(res, commit, "Commit failed.");
    return sendJson(res, 200, { ok: true, provider: "gitlab", branch: newBranch, base,
      files: files.map((f) => ({ path: f.path })), message: `Committed ${files.length} file(s) to ${gl.projectId}@${newBranch}.` });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitLab (${err?.cause?.code || err?.message}).` } });
  }
}

async function handleGitlabMr(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {
    return sendJson(res, 400, { error: { type: "bad_request", message: "Invalid JSON body." } });
  }
  const gl = resolveGitlab(payload);
  if (!gl.token) return sendJson(res, 401, { error: { type: "no_token", message: "No GitLab token provided." } });
  if (!gl.projectId) return sendJson(res, 400, { error: { type: "bad_request", message: "A project is required." } });
  const source = safeBranchName(payload.head || payload.source_branch);
  const target = String(payload.base || payload.target_branch || gl.branch || "main").trim();
  const title = String(payload.title || "MAX changes").slice(0, 250);
  const description = String(payload.body || "Opened by MAX.").slice(0, 8000);
  try {
    const mr = await gitlabApi(gl.token, "POST", `/projects/${glProjectPath(gl.projectId)}/merge_requests`,
      { source_branch: source, target_branch: target, title, description });
    if (!mr.ok) return glError(res, mr, "Could not open the merge request.");
    return sendJson(res, 200, { ok: true, url: mr.json?.web_url, iid: mr.json?.iid, message: `Opened MR !${mr.json?.iid}.` });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitLab (${err?.cause?.code || err?.message}).` } });
  }
}

/* ------------------------------------------------------------------ */
/*  Powers (integrations gallery)                                      */
/* ------------------------------------------------------------------ */
function handlePowers(req, res) {
  sendJson(res, 200, { ok: true, categories: POWER_CATEGORIES, powers: POWERS });
}

// Basic SSRF guard: only http/https, block obvious localhost/private/metadata hosts.
function isBlockedHost(hostname) {
  const h = String(hostname || "").toLowerCase().replace(/^\[|\]$/g, "");
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".internal") || h.endsWith(".local")) return true;
  if (h === "::1" || h === "0.0.0.0") return true;
  if (h === "169.254.169.254" || h.startsWith("169.254.")) return true; // cloud metadata + link-local
  // IPv4 private ranges
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const [a, b] = [parseInt(m[1], 10), parseInt(m[2], 10)];
    if (a === 10 || a === 127) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
  }
  if (h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true; // IPv6 private
  return false;
}

// Strip HTML to readable-ish text.
function htmlToText(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<\/(p|div|section|article|li|h[1-6]|tr|br)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

async function handlePowerFetch(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  let url;
  try { url = new URL(String(payload.url || "").trim()); } catch { return sendJson(res, 400, { error: { type: "bad_request", message: "Provide a valid URL." } }); }
  if (url.protocol !== "http:" && url.protocol !== "https:") return sendJson(res, 400, { error: { type: "bad_request", message: "Only http/https URLs are allowed." } });
  if (isBlockedHost(url.hostname)) return sendJson(res, 403, { error: { type: "blocked", message: "That host is not allowed (local/private addresses are blocked)." } });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    const fetchOpts = { redirect: "manual", headers: { "User-Agent": "MAX-chat web-fetch", Accept: "text/html,text/plain,application/json,*/*" }, signal: controller.signal };
    let r = await fetch(url.href, fetchOpts);
    // Follow redirects manually, validating each hop against blocked hosts (max 5 redirects).
    let redirectsLeft = 5;
    while (redirectsLeft > 0 && [301, 302, 303, 307, 308].includes(r.status)) {
      const location = r.headers.get("location");
      if (!location) break;
      let nextUrl;
      try { nextUrl = new URL(location, url.href); } catch { break; }
      if (nextUrl.protocol !== "http:" && nextUrl.protocol !== "https:") {
        return sendJson(res, 403, { error: { type: "blocked", message: "Redirect to a disallowed protocol." } });
      }
      if (isBlockedHost(nextUrl.hostname)) {
        return sendJson(res, 403, { error: { type: "blocked", message: "Redirect to a blocked host is not allowed." } });
      }
      r = await fetch(nextUrl.href, fetchOpts);
      redirectsLeft--;
    }
    const type = r.headers.get("content-type") || "";
    if (!r.ok && ![301, 302, 303, 307, 308].includes(r.status)) return sendJson(res, r.status, { error: { type: mapStatusType(r.status), status: r.status, message: `Fetch failed (HTTP ${r.status}).` } });
    if ([301, 302, 303, 307, 308].includes(r.status)) return sendJson(res, 502, { error: { type: "network", message: "Too many redirects." } });
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) return sendJson(res, 413, { error: { type: "too_large", message: "Page is too large to fetch." } });
    let text = buf.toString("utf8");
    if (/text\/html/i.test(type)) text = htmlToText(text);
    if (text.length > 100_000) text = text.slice(0, 100_000) + "\n… (truncated)";
    return sendJson(res, 200, { ok: true, url: url.href, contentType: type, text });
  } catch (err) {
    const cause = err?.cause?.code || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not fetch that page (${cause}).` } });
  } finally {
    clearTimeout(timer);
  }
}

async function handlePowerSearch(req, res) {
  let payload = {}; try { payload = JSON.parse((await readBody(req)) || "{}"); } catch {}
  const query = String(payload.query || "").trim();
  const key = String(payload.key || "").trim();
  const provider = String(payload.provider || "tavily").trim();
  if (!query) return sendJson(res, 400, { error: { type: "bad_request", message: "Provide a search query." } });
  if (!key) return sendJson(res, 401, { error: { type: "no_token", message: "This power needs an API key. Add it in Powers." } });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20_000);
  try {
    // Tavily-compatible search (default). Other providers can be added similarly.
    const base = process.env.TAVILY_API_BASE || "https://api.tavily.com";
    const r = await fetch(`${base.replace(/\/+$/, "")}/search`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ api_key: key, query, max_results: clampInt(payload.max, 1, 10, 5), include_answer: true }),
      signal: controller.signal,
    });
    const text = await r.text().catch(() => "");
    let json = null; try { json = text ? JSON.parse(text) : null; } catch {}
    if (!r.ok) {
      const msg = json?.error || json?.message || `Search failed (HTTP ${r.status}).`;
      return sendJson(res, r.status, { error: { type: mapStatusType(r.status), status: r.status, message: typeof msg === "string" ? msg : "Search failed." } });
    }
    const results = (json?.results || []).map((x) => ({ title: x.title, url: x.url, content: x.content }));
    return sendJson(res, 200, { ok: true, provider, query, answer: json?.answer || "", results });
  } catch (err) {
    const cause = err?.cause?.code || err?.message || "unknown error";
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach the search provider (${cause}).` } });
  } finally {
    clearTimeout(timer);
  }
}

/* ------------------------------------------------------------------ */
/*  AI video generation (lib/video.js)                                 */
/* ------------------------------------------------------------------ */
const GATEWAY_BASE = (process.env.VIDEO_GATEWAY_BASE_URL || PROVIDERS.codecraft.baseUrl).replace(/\/+$/, "");
const GATEWAY_IS_CODECRAFT = GATEWAY_BASE === PROVIDERS.codecraft.baseUrl;
const video = createVideoService({
  dataDir: DATA_DIR,
  allowClientKey: CONFIG.allowClientKey,
  sendJson,
  readBody,
  rateLimit: (req) => checkRateLimit(clientIp(req)),
  openrouter: { key: process.env.OPENROUTER_API_KEY || "", base: process.env.OPENROUTER_BASE_URL },
  google: { key: process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY || "", base: process.env.GEMINI_BASE_URL },
  gateway: {
    base: GATEWAY_BASE,
    key: process.env.VIDEO_GATEWAY_API_KEY || (GATEWAY_IS_CODECRAFT ? PROVIDERS.codecraft.key : ""),
    label: process.env.VIDEO_GATEWAY_LABEL || (GATEWAY_IS_CODECRAFT ? "CodeCraft API (video)" : "OpenAI-compatible gateway"),
    keyUrl: GATEWAY_IS_CODECRAFT ? PROVIDERS.codecraft.keyUrl : "",
  },
});

/* ------------------------------------------------------------------ */
/*  Router                                                             */
/* ------------------------------------------------------------------ */
const server = http.createServer(async (req, res) => {
  // A client disconnecting mid-stream makes the socket emit an 'error' event
  // (ECONNRESET/EPIPE). Without listeners these become uncaught exceptions that
  // crash the whole server, making every later request fail with "Failed to fetch".
  res.on("error", (err) => console.warn("[MAX] response stream error:", err?.code || err?.message));
  req.on("error", (err) => console.warn("[MAX] request stream error:", err?.code || err?.message));

  const { pathname } = new URL(req.url, "http://x");
  applySecurityHeaders(res, pathname);

  try {
    // ---- Auth routes (always open) ----
    if (pathname === "/api/health" && req.method === "GET") {
      return handleHealth(req, res);
    }
    if (pathname === "/api/auth/login" && req.method === "POST") {
      return await handleLogin(req, res);
    }
    if (pathname === "/api/auth/logout" && req.method === "POST") {
      return handleLogout(req, res);
    }
    if (pathname === "/api/auth/me" && req.method === "GET") {
      return handleMe(req, res);
    }
    if (pathname === "/api/auth/password" && req.method === "POST") {
      return await handleChangePassword(req, res);
    }

    // ---- Gate every other /api/* behind a valid session ----
    if (CONFIG.auth.enabled && pathname.startsWith("/api/") && !authUser(req)) {
      return sendJson(res, 401, { error: { type: "auth", message: "Sign in required." } });
    }

    // ---- Admin (super admin only) ----
    if (pathname === "/api/admin/users" && req.method === "GET") {
      return handleAdminList(req, res);
    }
    if (pathname === "/api/admin/users" && req.method === "POST") {
      return await handleAdminCreate(req, res);
    }
    let am;
    if ((am = pathname.match(/^\/api\/admin\/users\/([^/]+)\/(disable|enable|reset)$/)) && req.method === "POST") {
      return await handleAdminUpdate(req, res, decodeURIComponent(am[1]), am[2]);
    }
    if ((am = pathname.match(/^\/api\/admin\/users\/([^/]+)$/)) && req.method === "DELETE") {
      return await handleAdminUpdate(req, res, decodeURIComponent(am[1]), "delete");
    }

    if (pathname === "/api/config" && req.method === "GET") {
      return handleConfig(req, res);
    }
    // ---- Conversation persistence ----
    if (pathname === "/api/conversations" && req.method === "GET") {
      return handleConversationsList(req, res);
    }
    if (pathname === "/api/conversations" && req.method === "POST") {
      return await handleConversationSave(req, res);
    }
    let cm;
    if ((cm = pathname.match(/^\/api\/conversations\/([^/]+)$/)) && req.method === "GET") {
      return handleConversationGet(req, res, decodeURIComponent(cm[1]));
    }
    if ((cm = pathname.match(/^\/api\/conversations\/([^/]+)$/)) && req.method === "DELETE") {
      return handleConversationDelete(req, res, decodeURIComponent(cm[1]));
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
    if (pathname === "/api/github/branches" && req.method === "POST") {
      return await handleGithubBranches(req, res);
    }
    if (pathname === "/api/gitlab/branches" && req.method === "POST") {
      return await handleGitlabBranches(req, res);
    }
    if (pathname === "/api/models/refresh" && req.method === "POST") {
      return await handleModelsRefresh(req, res);
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
    if (pathname === "/api/github/commit" && req.method === "POST") {
      return await handleGithubCommit(req, res);
    }
    if (pathname === "/api/github/pr" && req.method === "POST") {
      return await handleGithubPr(req, res);
    }
    if (pathname === "/api/gitlab/commit" && req.method === "POST") {
      return await handleGitlabCommit(req, res);
    }
    if (pathname === "/api/gitlab/mr" && req.method === "POST") {
      return await handleGitlabMr(req, res);
    }
    if (pathname.startsWith("/api/video/")) {
      if (await video.route(req, res, pathname, authUser(req)?.id || "")) return;
    }
    if (pathname === "/api/powers" && req.method === "GET") {
      return handlePowers(req, res);
    }
    if (pathname === "/api/powers/fetch" && req.method === "POST") {
      return await handlePowerFetch(req, res);
    }
    if (pathname === "/api/powers/search" && req.method === "POST") {
      return await handlePowerSearch(req, res);
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

// Graceful shutdown: close active connections cleanly on SIGTERM/SIGINT.
function gracefulShutdown(signal) {
  console.log(`\n[MAX] ${signal} received — shutting down gracefully…`);
  server.close(() => {
    console.log("[MAX] All connections closed. Goodbye.");
    process.exit(0);
  });
  // Force-kill after 10s if connections don't drain
  setTimeout(() => { console.log("[MAX] Forcing exit."); process.exit(1); }, 10_000).unref?.();
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// Initialise auth before accepting traffic.
if (CONFIG.auth.enabled) {
  loadSessionSecret();
  ensureSuperAdmin();
}

server.listen(CONFIG.port, CONFIG.host, () => {
  const line = "─".repeat(52);
  console.log(`\n┌${line}┐`);
  console.log(`│  MAX is running`);
  console.log(`│  ▶  http://${CONFIG.host}:${CONFIG.port}`);
  console.log(`│`);
  for (const p of Object.values(PROVIDERS)) {
    console.log(`│  ${p.label.padEnd(15)}: ${p.key ? "key loaded ✓" : "no server key (paste in Settings)"} → ${providerEndpoint(p)}`);
  }
  console.log(`│  Default model  : ${CONFIG.defaultModel} (${CONFIG.defaultProvider})`);
  console.log(`│  Video          : ${video.summary()}`);
  console.log(`│  Rate limit     : ${CONFIG.rateLimitPerMin || "off"} req/min per IP`);
  console.log(`│  Timeout        : ${CONFIG.upstreamTimeoutMs} ms`);
  console.log(`│  GitHub token   : ${CONFIG.github.token ? "loaded ✓" : "not set (add in Settings, or .env)"}`);
  console.log(`│  Auth           : ${CONFIG.auth.enabled ? "ENABLED (login required)" : "disabled"}`);
  if (BOOTSTRAP_NOTICE) {
    console.log(`│`);
    for (const l of BOOTSTRAP_NOTICE.split("\n")) console.log(`│  ${l}`);
  }
  console.log(`└${line}┘\n`);
});
