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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import crypto from "node:crypto";

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
  auth: {
    enabled: (process.env.AUTH_ENABLED || "true").toLowerCase() !== "false",
    superUser: process.env.SUPERADMIN_USERNAME || "admin",
    superPass: process.env.SUPERADMIN_PASSWORD || "",
    sessionTtlHours: parseInt(process.env.SESSION_TTL_HOURS || "168", 10), // 7 days
    cookieName: "max_session",
  },
};

// Cap on how much of a repo file we return to the browser (protects memory + context).
const MAX_FILE_BYTES = parseInt(process.env.MAX_FILE_BYTES || "524288", 10); // 512 KB
const MAX_TREE_ENTRIES = 4000;
const MAX_FETCH_BYTES = 2 * 1024 * 1024; // 2 MB cap on fetched web pages

// Powers catalog. `status: "available"` powers work in MAX right now; the rest are
// catalog entries you can wire up to their real backends (they open Details/links).
const POWERS = [
  { id: "web-fetch", name: "Web Fetch", provider: "MAX", category: "Web", official: true, requiresKey: false, status: "available",
    blurb: "Fetch a web page and drop its readable text into the chat. Use /fetch <url>.", commands: ["/fetch"] },
  { id: "web-search", name: "Web Search", provider: "Tavily / Brave", category: "Web", official: true, requiresKey: true, status: "available",
    blurb: "Search the web and add the top results as context. Use /search <query>.", commands: ["/search"],
    keyHelp: "Paste a Tavily API key (tavily.com) — free tier available.", provider_id: "tavily" },
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

  // No env password: only bootstrap once, with a generated password.
  if (store.users.some((u) => u.role === "superadmin")) return;
  const password = crypto.randomBytes(9).toString("base64url");
  const { salt, hash } = hashPassword(password);
  store.users.push({
    id: crypto.randomUUID(), username, role: "superadmin", salt, hash,
    disabled: false, createdAt: Date.now(), lastLoginAt: null, lastSeenAt: null, loginCount: 0,
    mustChangePassword: true,
  });
  saveUsers();
  BOOTSTRAP_NOTICE = `Super admin created → username: ${username}  password: ${password}\n│  (set SUPERADMIN_USERNAME / SUPERADMIN_PASSWORD in .env to control these; change after first login)`;
}
let BOOTSTRAP_NOTICE = "";

/* ---------- session tokens (stateless, HMAC-signed) ---------- */
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
  res.setHeader("Set-Cookie", `${CONFIG.auth.cookieName}=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}
function clearSessionCookie(res) {
  res.setHeader("Set-Cookie", `${CONFIG.auth.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
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
    authEnabled: CONFIG.auth.enabled,
  });
}

/* ------------------------------------------------------------------ */
/*  Auth + admin endpoints                                             */
/* ------------------------------------------------------------------ */
const loginAttempts = new Map(); // ip -> { count, resetAt }
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

  const upstreamHeaders = {
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
  };
  const upstreamBody = JSON.stringify(body);
  const maxRetries = 2;

  let upstream;
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        upstream = await fetch(upstreamUrl, {
          method: "POST", headers: upstreamHeaders, body: upstreamBody, signal: controller.signal,
        });
      } catch (err) {
        if (controller.signal.aborted && !timedOut) { clearTimeout(timeout); res.off("close", abortOnDisconnect); return; }
        if (!timedOut && attempt < maxRetries) { await delay(400 * 2 ** attempt); continue; }
        throw err;
      }
      // Transient upstream failures: back off and retry with a fresh request.
      if (!upstream.ok && RETRYABLE_STATUS.has(upstream.status) && attempt < maxRetries && !timedOut) {
        try { await upstream.text(); } catch {}
        await delay(500 * 2 ** attempt);
        continue;
      }
      break;
    }
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

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

// Sanitize + validate a set of {path, content} file edits for committing.
function normalizeFiles(files) {
  if (!Array.isArray(files) || !files.length) return null;
  const out = [];
  for (const f of files) {
    if (!f || typeof f.path !== "string" || typeof f.content !== "string") return null;
    const p = sanitizeRepoPath(f.path);
    if (!p) return null;
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
/*  Edit → commit → PR/MR (GitHub + GitLab)                            */
/* ------------------------------------------------------------------ */
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
  const newBranch = safeBranchName(payload.newBranch || defaultBranchName());
  const message = String(payload.message || `MAX edit: ${files.map((f) => f.path).join(", ")}`).slice(0, 500);
  const repoRoot = `/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}`;

  try {
    // Resolve base branch head SHA.
    const ref = await githubApi(gh.token, "GET", `${repoRoot}/git/ref/heads/${encodeURIComponent(base)}`);
    if (!ref.ok) return ghError(res, ref, `Could not find base branch "${base}".`);
    const baseSha = ref.json?.object?.sha;

    // Create the working branch if it doesn't already exist.
    if (newBranch !== base) {
      const exists = await githubApi(gh.token, "GET", `${repoRoot}/git/ref/heads/${encodeURIComponent(newBranch)}`);
      if (!exists.ok) {
        const create = await githubApi(gh.token, "POST", `${repoRoot}/git/refs`, { ref: `refs/heads/${newBranch}`, sha: baseSha });
        if (!create.ok) return ghError(res, create, "Could not create the working branch.");
      }
    }

    // Commit each file to the working branch.
    const committed = [];
    for (const f of files) {
      const enc = f.path.split("/").map(encodeURIComponent).join("/");
      const cbase = `${repoRoot}/contents/${enc}`;
      let sha;
      const ex = await githubApi(gh.token, "GET", `${cbase}?ref=${encodeURIComponent(newBranch)}`);
      if (ex.ok && ex.json && !Array.isArray(ex.json)) sha = ex.json.sha;
      const put = await githubApi(gh.token, "PUT", cbase, {
        message, branch: newBranch, content: Buffer.from(f.content, "utf8").toString("base64"), ...(sha ? { sha } : {}),
      });
      if (!put.ok) return ghError(res, put, `Failed to write ${f.path}.`);
      committed.push({ path: f.path, updated: Boolean(sha) });
    }
    return sendJson(res, 200, { ok: true, provider: "github", branch: newBranch, base, files: committed,
      message: `Committed ${committed.length} file(s) to ${gh.owner}/${gh.repo}@${newBranch}.` });
  } catch (err) {
    return sendJson(res, 502, { error: { type: "network", message: `Could not reach GitHub (${err?.cause?.code || err?.message}).` } });
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
    // Decide create vs update for each file by checking existence on the base branch.
    const actions = [];
    for (const f of files) {
      const head = await gitlabApi(gl.token, "GET", `${proj}/repository/files/${encodeURIComponent(f.path)}?ref=${encodeURIComponent(base)}`);
      actions.push({ action: head.ok ? "update" : "create", file_path: f.path, content: f.content });
    }
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
    const r = await fetch(url.href, { redirect: "follow", headers: { "User-Agent": "MAX-chat web-fetch", Accept: "text/html,text/plain,application/json,*/*" }, signal: controller.signal });
    const type = r.headers.get("content-type") || "";
    if (!r.ok) return sendJson(res, r.status, { error: { type: mapStatusType(r.status), status: r.status, message: `Fetch failed (HTTP ${r.status}).` } });
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
  console.log(`│  Server API key : ${CONFIG.apiKey ? "loaded ✓" : "NOT set (use Settings in the UI, or .env)"}`);
  console.log(`│  Upstream       : ${CONFIG.baseUrl}/v1/messages`);
  console.log(`│  Default model  : ${CONFIG.defaultModel}`);
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
