// Endpoint-level checks: SSRF guard, /api/verify, revocation surviving restarts,
// structured log file and graceful shutdown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const freePort = () => new Promise((resolve) => {
  const s = net.createServer().listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

// Run `node server.js` as a real process (exercises the main-module path + signals).
async function runServer(env) {
  const port = await freePort();
  const child = spawn(process.execPath, ["server.js"], {
    cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", RATE_LIMIT_PER_MIN: "0", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(base + "/api/health")).ok) break; } catch {}
    await new Promise((r) => setTimeout(r, 50));
  }
  const stop = (signal = "SIGTERM") => new Promise((resolve) => {
    if (child.exitCode !== null) return resolve(child.exitCode);
    child.once("exit", (code, sig) => resolve(code ?? sig));
    child.kill(signal);
  });
  return { base, child, stop, output: () => out };
}

const post = async (base, p, body, headers = {}) => {
  const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  return { status: r.status, headers: r.headers, json: await r.json().catch(() => null) };
};

test("`node server` (no extension) still starts and listens", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "max-srv-"));
  const port = await freePort();
  const child = spawn(process.execPath, ["server"], { cwd: ROOT, env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MAX_DATA_DIR: dir, AUTH_ENABLED: "false", LOG_STDOUT: "false" }, stdio: "ignore" });
  try {
    let ok = false;
    for (let i = 0; i < 100 && !ok; i++) {
      try { ok = (await fetch(`http://127.0.0.1:${port}/api/health`)).ok; } catch { await new Promise((r) => setTimeout(r, 50)); }
    }
    assert.ok(ok, "server must listen when started as `node server`");
  } finally { child.kill("SIGTERM"); }
});

test("SSRF: private / loopback / metadata targets are blocked", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "max-srv-"));
  const s = await runServer({ MAX_DATA_DIR: dir, AUTH_ENABLED: "false" });
  try {
    for (const url of ["http://127.0.0.1:1/", "http://169.254.169.254/latest/meta-data/", "http://[::1]/", "http://10.0.0.5/", "http://localhost/", "http://0x7f000001/"]) {
      const r = await post(s.base, "/api/powers/fetch", { url });
      assert.ok([400, 403].includes(r.status), `${url} → ${r.status} ${JSON.stringify(r.json)}`);
    }
    const bad = await post(s.base, "/api/powers/fetch", { url: "file:///etc/passwd" });
    assert.equal(bad.status, 400);
  } finally { await s.stop(); }
});

test("/api/verify reports syntax errors without executing code", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "max-srv-"));
  const s = await runServer({ MAX_DATA_DIR: dir, AUTH_ENABLED: "false" });
  try {
    const r = await post(s.base, "/api/verify", { files: [
      { path: "ok.js", content: "module.exports = 1;" },
      { path: "esm.js", content: "export const a = 1;" },
      { path: "broken.js", content: "function (" },
      { path: "data.json", content: "{bad json}" },
      { path: "side-effect.js", content: `require("fs").writeFileSync(${JSON.stringify(path.join(dir, "pwned"))}, "x")` },
    ] });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, false);
    const by = Object.fromEntries(r.json.results.map((x) => [x.path, x]));
    assert.equal(by["ok.js"].ok, true);
    assert.equal(by["esm.js"].ok, true);
    assert.equal(by["broken.js"].ok, false);
    assert.equal(by["data.json"].ok, false);
    assert.equal(by["side-effect.js"].ok, true);
    assert.equal(existsSync(path.join(dir, "pwned")), false, "verify must never execute code");
  } finally { await s.stop(); }
});

test("logout revocation survives a restart; logs are JSON; SIGTERM exits cleanly", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "max-srv-"));
  const env = { MAX_DATA_DIR: dir, AUTH_ENABLED: "true", SUPERADMIN_USERNAME: "admin", SUPERADMIN_PASSWORD: "test-pass-123", SESSION_SECRET: "fixed-secret-for-test" };
  let s = await runServer(env);
  let cookie;
  try {
    const login = await post(s.base, "/api/auth/login", { username: "admin", password: "test-pass-123" });
    assert.equal(login.status, 200, JSON.stringify(login.json));
    cookie = String(login.headers.get("set-cookie")).split(";")[0];
    assert.equal((await fetch(s.base + "/api/auth/me", { headers: { cookie } })).status, 200);
    assert.equal((await post(s.base, "/api/auth/logout", {}, { cookie })).status, 200);
    assert.equal((await fetch(s.base + "/api/auth/me", { headers: { cookie } })).status, 401);
  } finally {
    const code = await s.stop("SIGTERM");
    assert.equal(code, 0, "graceful shutdown exits 0");
  }
  assert.ok(existsSync(path.join(dir, "revoked.json")), "revocations persisted to data/revoked.json");

  s = await runServer(env); // restart with the same data dir + secret
  try {
    const me = await fetch(s.base + "/api/auth/me", { headers: { cookie } });
    assert.equal(me.status, 401, "a revoked session must stay revoked after restart");
  } finally { await s.stop(); }

  const lines = readFileSync(path.join(dir, "app.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(lines.some((l) => l.msg === "server.listening"));
  assert.ok(lines.some((l) => l.msg === "server.shutdown" && l.signal === "SIGTERM"));
  assert.ok(lines.every((l) => l.ts && l.level && l.msg), "every line has ts/level/msg");
  assert.ok(!readFileSync(path.join(dir, "app.log"), "utf8").includes("test-pass-123"), "no secrets in logs");
});
