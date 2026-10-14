// GitHub push reliability + tree pagination against a mock GitHub API.
import { test, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { startMock, json, serverEnv, bootServer } from "./helpers.js";

let gh, app;
const state = { putFailures: 0, shaReads: 0, refExists: true, refCreated: false, fileCount: 2500, mainHead: "base-sha", commits: 0, patchLost: 0, existingContent: null };

before(async () => {
  gh = await startMock((req, res, body) => {
    const u = new URL(req.url, "http://x");
    const p = u.pathname;
    if (p === "/repos/o/r/git/ref/heads/main") return json(res, 200, { object: { sha: state.mainHead } });
    if (p.startsWith("/repos/o/r/git/commits/") && req.method === "GET") return json(res, 200, { sha: p.split("/").pop(), tree: { sha: `tree-of-${p.split("/").pop()}` } });
    if (p === "/repos/o/r/git/trees" && req.method === "POST") return json(res, 201, { sha: "new-tree" });
    if (p === "/repos/o/r/git/commits" && req.method === "POST") { state.commits++; return json(res, 201, { sha: `commit-${state.commits}`, html_url: `https://gh/commit-${state.commits}` }); }
    if (p === "/repos/o/r/git/refs/heads/main" && req.method === "PATCH") {
      state.mainHead = body.sha; // the update LANDS…
      if (state.patchLost > 0) { state.patchLost--; return json(res, 502, { message: "Bad gateway" }); } // …but the reply is lost
      return json(res, 200, { object: { sha: body.sha } });
    }
    if (p === "/repos/o/r/git/ref/heads/feature") {
      return state.refExists || state.refCreated ? json(res, 200, { object: { sha: "feat-sha" } }) : json(res, 404, { message: "Not Found" });
    }
    if (p === "/repos/o/r" && req.method === "GET") return json(res, 200, { default_branch: "main", full_name: "o/r" });
    if (p === "/repos/o/r/git/refs" && req.method === "POST") { state.refCreated = true; return json(res, 201, { ref: body.ref }); }
    if (p.startsWith("/repos/o/r/contents/") && req.method === "GET") {
      state.shaReads++;
      return json(res, 200, { sha: `sha-${state.shaReads}`, type: "file", ...(state.existingContent != null ? { content: Buffer.from(state.existingContent).toString("base64"), encoding: "base64" } : {}) });
    }
    if (p.startsWith("/repos/o/r/contents/") && req.method === "PUT") {
      if (state.putFailures > 0) { state.putFailures--; return json(res, 409, { message: "is at sha-x but expected sha-y" }); }
      return json(res, 200, { content: { html_url: "https://gh/x" }, commit: { sha: "c0ffee", html_url: "https://gh/c" }, usedSha: body.sha });
    }
    if (p.startsWith("/repos/o/r/git/trees/")) {
      const tree = Array.from({ length: state.fileCount }, (_, i) => ({ type: "blob", path: `src/f${i}.js`, size: 10 }));
      tree.push({ type: "tree", path: "src" });
      return json(res, 200, { sha: "tree-sha", truncated: false, tree });
    }
    return json(res, 404, { message: `unmocked ${req.method} ${p}` });
  });
  serverEnv({ GITHUB_API_BASE: gh.url });
  app = await bootServer();
});
after(async () => { await app?.close(); await gh?.close(); });
beforeEach(() => { Object.assign(state, { putFailures: 0, shaReads: 0, refExists: true, refCreated: false, mainHead: "base-sha", commits: 0, patchLost: 0, existingContent: null }); });

const push = (extra = {}) => app.post("/api/github/push", { token: "t", owner: "o", repo: "r", branch: "feature", path: "notes/a.md", content: "hello", ...extra });

test("push succeeds first time and re-reads the sha", async () => {
  const r = await push();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.attempts, 1);
  assert.equal(state.shaReads, 1);
});

test("push retries a 409 with a FRESH sha each attempt", async () => {
  state.putFailures = 1;
  const t0 = Date.now();
  const r = await push();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.attempts, 2);
  assert.equal(state.shaReads, 2, "sha must be re-fetched before every PUT");
  const puts = gh.calls.filter((c) => c.method === "PUT");
  assert.equal(puts.at(-1).body.sha, "sha-2");
  assert.ok(Date.now() - t0 >= 900, "waits ~1s before the first retry");
});

test("push gives a clear JSON error after the retries are exhausted", async () => {
  state.putFailures = 10;
  const r = await push();
  assert.equal(r.status, 409);
  assert.match(r.json.error.message, /after 4 attempts/, "clear message for the toast");
  assert.match(r.json.error.message, /expected sha-y/, "keeps GitHub's own detail");
  assert.equal(state.shaReads, 4, "1 try + 3 retries");
  const status = await (await fetch(app.base + "/api/github/status")).json();
  assert.equal(status.lastWrite.ok, false);
  assert.equal(status.lastWrite.kind, "push");
});

test("push creates a missing branch from the default branch", async () => {
  state.refExists = false;
  const r = await push();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.branchCreated, true);
  const made = gh.calls.find((c) => c.method === "POST" && c.url === "/repos/o/r/git/refs");
  assert.deepEqual(made.body, { ref: "refs/heads/feature", sha: "base-sha" });
});

test("push of identical content is a no-op (no duplicate commit)", async () => {
  state.existingContent = "hello";
  const before = gh.calls.length;
  const r = await push();
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.unchanged, true);
  assert.equal(gh.calls.slice(before).filter((c) => c.method === "PUT").length, 0, "no PUT for identical content");
});

test("commit: a ref update that landed but lost its reply is NOT committed twice", async () => {
  state.patchLost = 1;
  const r = await app.post("/api/github/commit", { token: "t", owner: "o", repo: "r", branch: "main", newBranch: "main", files: [{ path: "a.js", content: "x" }] });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(state.commits, 1, "exactly one commit object created");
  assert.equal(r.json.commitSha, "commit-1");
  assert.equal(state.mainHead, "commit-1");
});

test("tree is paginated (1000 per page) and reports nextOffset", async () => {
  const p1 = await app.post("/api/github/tree", { token: "t", owner: "o", repo: "r", branch: "main" });
  assert.equal(p1.status, 200);
  assert.equal(p1.json.files.length, 1000);
  assert.equal(p1.json.total, 2500);
  assert.equal(p1.json.nextOffset, 1000);
  const p3 = await app.post("/api/github/tree", { token: "t", owner: "o", repo: "r", branch: "main", offset: 2000 });
  assert.equal(p3.json.files.length, 500);
  assert.equal(p3.json.nextOffset, null);
  assert.equal(p3.json.files[0].path, "src/f2000.js");
});

test("pageFiles caps and clamps", () => {
  const all = Array.from({ length: 5000 }, (_, i) => ({ path: `f${i}` }));
  const r = app.mod.pageFiles(all, { offset: -5, limit: 99999 }, false);
  assert.equal(r.offset, 0);
  assert.equal(r.files.length, 4000);
  assert.equal(r.truncated, true);
});
