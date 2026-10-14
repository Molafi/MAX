/**
 * MAX — syntax verification for staged edits (zero dependencies).
 *
 * verifyFiles([{ path, content }]) checks each file WITHOUT executing it:
 *   • .js / .mjs / .cjs → `node --check` (ES module first if it looks like one)
 *   • .json             → JSON.parse (JSON-with-comments files are skipped)
 *   • anything else     → skipped (no checker)
 * Resolves { ok, results: [{ path, ok, skipped?, checker?, error?, reason? }] }.
 */
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const JS_FILE = /\.(m?js|cjs)$/i;
const JSON_FILE = /\.json$/i;
// Config files that officially allow comments / trailing commas.
const JSONC_FILE = /(^|\/)(tsconfig|jsconfig)(\.[\w-]+)*\.json$|(^|\/)\.vscode\/|(^|\/)\.eslintrc\.json$|(^|\/)devcontainer\.json$|(^|\/)\.devcontainer\//i;
const ESM_HINT = /^\s*(import\s*[\w{*'"]|export\s)|\bimport\.meta\b/m;

function nodeCheck(nodePath, file, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(nodePath, ["--check", file], { stdio: ["ignore", "ignore", "pipe"], env: { PATH: process.env.PATH || "" } });
    } catch (err) {
      resolve({ ok: false, error: err.message });
      return;
    }
    let stderr = "";
    const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch {} resolve({ ok: false, error: "Syntax check timed out." }); }, timeoutMs);
    child.stderr.on("data", (d) => { if (stderr.length < 16_000) stderr += d; });
    child.on("error", (e) => { clearTimeout(timer); resolve({ ok: false, error: e.message }); });
    child.on("close", (code) => { clearTimeout(timer); resolve(code === 0 ? { ok: true } : { ok: false, error: stderr }); });
  });
}

/** Turn node's stderr into a short, repo-relative message. */
export function cleanCheckError(stderr, tmpFile, repoPath) {
  let s = String(stderr || "").split(tmpFile).join(repoPath);
  s = s.split(/\r?\n/)
    .filter((l) => !/^\s+at\s/.test(l) && !/^Node\.js v\d/.test(l))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return s.length > 900 ? s.slice(0, 900) + "…" : s || "Syntax error.";
}

export async function verifyFiles(files, { timeoutMs = 10_000, concurrency = 4, nodePath = process.execPath } = {}) {
  const list = Array.isArray(files) ? files : [];
  const results = new Array(list.length);
  let dir = null;
  const tmpDir = async () => dir || (dir = await mkdtemp(path.join(os.tmpdir(), "max-verify-")));

  async function verifyOne(f, idx) {
    const p = String(f?.path || "");
    if (f?.deleted) return { path: p, ok: true, skipped: true, reason: "deleted" };
    const content = typeof f?.content === "string" ? f.content : "";
    if (JSON_FILE.test(p)) {
      if (JSONC_FILE.test(p)) return { path: p, ok: true, skipped: true, reason: "JSON with comments is not checked" };
      try { JSON.parse(content); return { path: p, ok: true, checker: "json" }; }
      catch (e) { return { path: p, ok: false, checker: "json", error: `Invalid JSON: ${e.message}` }; }
    }
    if (JS_FILE.test(p)) {
      const d = await tmpDir();
      const ext = path.extname(p).toLowerCase();
      const order = ext === ".mjs" ? [".mjs"] : ext === ".cjs" ? [".cjs"] : (ESM_HINT.test(content) ? [".mjs", ".cjs"] : [".cjs", ".mjs"]);
      let first = null;
      for (const e of order) {
        const tmp = path.join(d, `f${idx}${e}`);
        await writeFile(tmp, content);
        const r = await nodeCheck(nodePath, tmp, timeoutMs);
        if (r.ok) return { path: p, ok: true, checker: "node --check" };
        if (!first) first = { ...r, tmp };
      }
      const msg = cleanCheckError(first.error, first.tmp, p);
      // React/JSX inside .js can't be parsed by node — don't report it as broken.
      if (/Unexpected token '<'/.test(msg) && /<\/?[A-Za-z][\w.]*[\s/>]/.test(content)) {
        return { path: p, ok: true, skipped: true, reason: "contains JSX (not checked)" };
      }
      return { path: p, ok: false, checker: "node --check", error: msg };
    }
    return { path: p, ok: true, skipped: true, reason: "no checker for this file type" };
  }

  let next = 0;
  async function worker() {
    while (next < list.length) {
      const idx = next++;
      try { results[idx] = await verifyOne(list[idx], idx); }
      catch (err) { results[idx] = { path: String(list[idx]?.path || ""), ok: false, error: err?.message || String(err) }; }
    }
  }
  try {
    await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, worker));
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
  return { ok: results.every((r) => r && r.ok), results };
}
