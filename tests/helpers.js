// Shared test helpers (node --test, zero dependencies).
import http from "node:http";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Start a throwaway HTTP server; `handler(req, res, body)` gets the parsed JSON body. */
export async function startMock(handler) {
  const calls = [];
  const srv = http.createServer(async (req, res) => {
    let raw = "";
    for await (const c of req) raw += c;
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch { body = raw; }
    calls.push({ method: req.method, url: req.url, body, headers: req.headers });
    try { await handler(req, res, body, calls); }
    catch (err) { res.writeHead(500); res.end(String(err)); }
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address();
  return { url: `http://127.0.0.1:${port}`, calls, close: () => new Promise((r) => srv.close(r)) };
}

export const json = (res, status, obj, headers = {}) => {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(obj));
};

/** Isolated env for importing server.js: temp data dir, no auth, quiet logs. */
export function serverEnv(extra = {}) {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "max-test-"));
  Object.assign(process.env, {
    MAX_DATA_DIR: dataDir,
    AUTH_ENABLED: "false",
    LOG_STDOUT: "false",
    RATE_LIMIT_PER_MIN: "0",
    CODECRAFT_API_KEY: "",
    AGENTROUTER_API_KEY: "",
    GITHUB_TOKEN: "",
    ...extra,
  });
  return dataDir;
}

/** Import server.js (which does NOT listen on import) and bind it to a free port. */
export async function bootServer() {
  const mod = await import("../server.js");
  const addr = await mod.startServer({ port: 0, host: "127.0.0.1", banner: false });
  const base = `http://127.0.0.1:${addr.port}`;
  const post = async (p, body) => {
    const r = await fetch(base + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  return { mod, base, post, close: () => new Promise((r) => { mod.server.closeAllConnections?.(); mod.server.close(r); }) };
}
