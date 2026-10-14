// /api/chat: standalone chat (no repository at all) + image validation.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startMock, json, serverEnv, bootServer } from "./helpers.js";

let upstream, app;

before(async () => {
  // A fake OpenAI-compatible provider standing in for CodeCraft.
  upstream = await startMock((req, res, body) => {
    if (body?.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { role: "assistant", content: "Hello from " } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id: "c1", choices: [{ index: 0, delta: { content: "standalone" }, finish_reason: "stop" }] })}\n\n`);
      res.end("data: [DONE]\n\n");
      return;
    }
    json(res, 200, {
      id: "c1", object: "chat.completion",
      choices: [{ index: 0, message: { role: "assistant", content: `echo:${body.messages.at(-1).content}` }, finish_reason: "stop" }],
      usage: { prompt_tokens: 3, completion_tokens: 2 },
    });
  });
  serverEnv({ CODECRAFT_BASE_URL: `${upstream.url}/v1`, DEFAULT_PROVIDER: "codecraft", DEFAULT_MODEL: "test-model" });
  app = await bootServer();
});

after(async () => {
  await app?.close();
  await upstream?.close();
});

test("standalone chat works with NO repo / owner / token fields", async () => {
  const r = await app.post("/api/chat", {
    provider: "codecraft", apiKey: "sk-test", model: "test-model", stream: false,
    messages: [{ role: "user", content: "hi" }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.content[0].text, "echo:hi");
  const sent = upstream.calls.at(-1).body;
  assert.equal(sent.max_tokens ?? sent.max_completion_tokens, 4096, "default max_tokens is 4096");
  assert.equal(upstream.calls.at(-1).headers.authorization, "Bearer sk-test");
});

test("standalone chat streams (SSE translated to Anthropic events)", async () => {
  const res = await fetch(app.base + "/api/chat", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "codecraft", apiKey: "sk-test", model: "test-model", messages: [{ role: "user", content: "hi" }] }),
  });
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.match(text, /text_delta/);
  assert.match(text, /Hello from /);
  assert.match(text, /standalone/);
  assert.match(text, /message_stop/);
});

test("missing API key → 401 no_api_key (never a repo error)", async () => {
  const r = await app.post("/api/chat", { provider: "codecraft", messages: [{ role: "user", content: "hi" }] });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.type, "no_api_key");
  assert.doesNotMatch(r.json.error.message, /repo|owner/i);
});

test("image over 2 MB is rejected with 413 image_too_large", async () => {
  const big = Buffer.alloc(app.mod.MAX_IMAGE_BYTES + 1024, 1).toString("base64");
  const r = await app.post("/api/chat", {
    provider: "codecraft", apiKey: "sk-test", stream: false,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/png", data: big } }, { type: "text", text: "what is this" }] }],
  });
  assert.equal(r.status, 413);
  assert.equal(r.json.error.type, "image_too_large");
});

test("unsupported image type is rejected with 415", async () => {
  const r = await app.post("/api/chat", {
    provider: "codecraft", apiKey: "sk-test", stream: false,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/bmp", data: "AAAA" } }] }],
  });
  assert.equal(r.status, 415);
  assert.equal(r.json.error.type, "unsupported_image");
});

test("small allowed image passes validation and reaches the provider", async () => {
  const small = Buffer.alloc(2048, 7).toString("base64");
  const r = await app.post("/api/chat", {
    provider: "codecraft", apiKey: "sk-test", stream: false,
    messages: [{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/jpeg", data: small } }, { type: "text", text: "describe" }] }],
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
});

test("findInvalidImage unit checks", () => {
  const { findInvalidImage, MAX_IMAGE_BYTES } = app.mod;
  assert.equal(findInvalidImage([{ role: "user", content: "text only" }]), null);
  const ok = Buffer.alloc(MAX_IMAGE_BYTES - 10).toString("base64");
  assert.equal(findInvalidImage([{ role: "user", content: [{ type: "image", source: { type: "base64", media_type: "image/webp", data: ok } }] }]), null);
});
