// Unit tests for lib/netguard.js, lib/retry.js, lib/logger.js, lib/verify.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { isPrivateAddress, assertPublicUrl, BlockedUrlError } from "../lib/netguard.js";
import { retryWithBackoff, isRetryableStatus } from "../lib/retry.js";
import { createLogger, redact } from "../lib/logger.js";
import { verifyFiles } from "../lib/verify.js";

test("isPrivateAddress covers the required ranges", () => {
  for (const ip of ["127.0.0.1", "127.255.0.9", "10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "169.254.169.254", "0.0.0.0", "100.64.0.1", "::1", "::", "fc00::1", "fd12:3456::1", "fe80::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2002:0a00:0001::1"]) {
    assert.equal(isPrivateAddress(ip), true, ip);
  }
  for (const ip of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "172.15.0.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) {
    assert.equal(isPrivateAddress(ip), false, ip);
  }
});

test("assertPublicUrl resolves DNS and blocks hosts that point to private IPs", async () => {
  const fakeLookup = (answers) => async () => answers.map((address) => ({ address, family: address.includes(":") ? 6 : 4 }));
  await assert.rejects(assertPublicUrl("http://evil.example/", { lookup: fakeLookup(["93.184.216.34", "10.0.0.7"]) }), BlockedUrlError);
  await assert.rejects(assertPublicUrl("http://rebind.example/", { lookup: fakeLookup(["::1"]) }), BlockedUrlError);
  await assert.rejects(assertPublicUrl("gopher://x/"), (e) => e.code === "EPROTOCOL");
  await assert.rejects(assertPublicUrl("http://printer.local/"), BlockedUrlError);
  const ok = await assertPublicUrl("https://example.com/x", { lookup: fakeLookup(["93.184.216.34"]) });
  assert.deepEqual(ok.addresses, ["93.184.216.34"]);
});

test("retryWithBackoff waits 1s → 2s → 4s and gives up after 3 retries", async () => {
  const waits = [];
  let calls = 0;
  await assert.rejects(retryWithBackoff(async () => { calls++; throw new Error("nope"); }, {
    retries: 3, baseMs: 1000, factor: 2, maxMs: 4000, sleep: async (ms) => { waits.push(ms); },
  }), (e) => e.attempts === 4);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  const v = await retryWithBackoff(async (n) => { if (n < 2) throw new Error("x"); return "ok"; }, { sleep: async () => {} });
  assert.equal(v, "ok");
  assert.deepEqual([409, 422, 429, 500, 503, 404, 401].map(isRetryableStatus), [true, true, true, true, true, false, false]);
});

test("logger writes JSON lines with redacted secrets", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "max-log-"));
  const log = createLogger({ dir, stdout: false });
  log.info("github.push", { repo: "o/r", token: "ghp_secret", nested: { apiKey: "sk-123", ok: true } });
  log("error", "boom", new Error("bad"));
  await log.close();
  const lines = readFileSync(path.join(dir, "app.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 2);
  assert.equal(lines[0].msg, "github.push");
  assert.equal(lines[0].token, "[redacted]");
  assert.equal(lines[0].nested.apiKey, "[redacted]");
  assert.equal(lines[1].level, "error");
  assert.equal(lines[1].detail.message, "bad");
  assert.ok(lines[0].ts);
  assert.equal(redact({ password: "x" }).password, "[redacted]");
});

test("verifyFiles: JS (CJS + ESM), JSON, skips other types", async () => {
  const r = await verifyFiles([
    { path: "a.cjs", content: "module.exports = 1" },
    { path: "b.mjs", content: "export default 1" },
    { path: "c.js", content: "const = 2" },
    { path: "d.json", content: '{"a":1}' },
    { path: "tsconfig.json", content: "{ // comments allowed\n}" },
    { path: "README.md", content: "# hi" },
    { path: "gone.js", deleted: true },
  ]);
  const by = Object.fromEntries(r.results.map((x) => [x.path, x]));
  assert.equal(r.ok, false);
  assert.equal(by["a.cjs"].ok, true);
  assert.equal(by["b.mjs"].ok, true);
  assert.equal(by["c.js"].ok, false);
  assert.match(by["c.js"].error, /c\.js/);
  assert.equal(by["d.json"].ok, true);
  assert.equal(by["tsconfig.json"].skipped, true);
  assert.equal(by["README.md"].skipped, true);
  assert.equal(by["gone.js"].skipped, true);
});
