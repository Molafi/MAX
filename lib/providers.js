/**
 * MAX — AI provider layer.
 *
 * The frontend always speaks the Anthropic Messages wire format (request body +
 * SSE events). This module lets MAX talk to two kinds of upstream:
 *
 *   - "anthropic" style (AgentRouter)   → POST {base}/v1/messages, passthrough
 *   - "openai"    style (CodeCraft API) → POST {base}/chat/completions, translated
 *
 * For OpenAI-style providers we translate the request (messages, tools, images,
 * documents, tool results, reasoning effort) and convert the streamed
 * chat.completion.chunk events back into Anthropic SSE events, so the browser
 * code path is identical regardless of provider.
 *
 * Zero dependencies.
 */

/* ------------------------------------------------------------------ */
/*  Reasoning effort                                                   */
/* ------------------------------------------------------------------ */
export const EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"];

// Anthropic extended-thinking budgets per effort level.
const THINKING_BUDGET = { low: 1024, medium: 4096, high: 12000, xhigh: 24000, max: 48000 };
// OpenAI-style reasoning_effort values. "max" has no OpenAI equivalent → xhigh.
const OPENAI_EFFORT = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "xhigh" };

export function normalizeEffort(v) {
  const s = String(v || "").toLowerCase().trim();
  return EFFORT_LEVELS.includes(s) ? s : "";
}

/* ------------------------------------------------------------------ */
/*  Request building                                                   */
/* ------------------------------------------------------------------ */

/** Anthropic body: add extended thinking for Claude models when effort is set. */
export function buildAnthropicBody(base, { effort, model }) {
  const body = { ...base };
  const lvl = normalizeEffort(effort);
  if (lvl && /claude/i.test(model)) {
    let budget = THINKING_BUDGET[lvl];
    // max_tokens must exceed the thinking budget; leave room for the answer.
    const cap = 64000;
    body.max_tokens = Math.min(cap, Math.max(body.max_tokens || 8192, budget + 4096));
    if (budget >= body.max_tokens) budget = Math.max(1024, body.max_tokens - 2048);
    body.thinking = { type: "enabled", budget_tokens: budget };
    delete body.temperature; // thinking requires the default temperature
  }
  return body;
}

function dataUrl(mediaType, data) {
  return `data:${mediaType};base64,${data}`;
}

function blocksToText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map((b) => (b && b.type === "text" ? b.text : "")).filter(Boolean).join("\n");
}

/** Convert Anthropic messages[] (+ system) to OpenAI chat messages[]. */
export function toOpenAIMessages(messages, system) {
  const out = [];
  if (system) out.push({ role: "system", content: typeof system === "string" ? system : blocksToText(system) });

  for (const m of messages) {
    if (typeof m.content === "string") { out.push({ role: m.role, content: m.content }); continue; }
    const blocks = Array.isArray(m.content) ? m.content : [];

    if (m.role === "assistant") {
      let text = "";
      const toolCalls = [];
      for (const b of blocks) {
        if (b.type === "text") text += (text ? "\n" : "") + b.text;
        else if (b.type === "tool_use") {
          toolCalls.push({ id: b.id, type: "function", function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } });
        }
        // thinking / redacted_thinking blocks are Anthropic-only → dropped
      }
      const msg = { role: "assistant", content: text || (toolCalls.length ? null : "") };
      if (toolCalls.length) msg.tool_calls = toolCalls;
      out.push(msg);
      continue;
    }

    // user: tool results become role:"tool" messages (must directly follow the
    // assistant tool_calls turn), everything else becomes one user message.
    const parts = [];
    for (const b of blocks) {
      if (b.type === "tool_result") {
        const content = typeof b.content === "string" ? b.content : blocksToText(b.content);
        out.push({ role: "tool", tool_call_id: b.tool_use_id, content: (b.is_error ? "Error: " : "") + (content || "") });
      } else if (b.type === "text") {
        parts.push({ type: "text", text: b.text });
      } else if (b.type === "image" && b.source?.type === "base64") {
        parts.push({ type: "image_url", image_url: { url: dataUrl(b.source.media_type, b.source.data) } });
      } else if (b.type === "document" && b.source?.type === "base64") {
        parts.push({ type: "file", file: { filename: b.title || "document.pdf", file_data: dataUrl(b.source.media_type, b.source.data) } });
      }
    }
    if (parts.length) {
      const allText = parts.every((p) => p.type === "text");
      out.push({ role: "user", content: allText ? parts.map((p) => p.text).join("\n\n") : parts });
    }
  }
  return out;
}

export function toOpenAITools(tools) {
  if (!Array.isArray(tools) || !tools.length) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: { name: t.name, description: t.description || "", parameters: t.input_schema || { type: "object", properties: {} } },
  }));
}

function toOpenAIToolChoice(tc) {
  if (!tc || typeof tc !== "object") return undefined;
  if (tc.type === "auto") return "auto";
  if (tc.type === "any") return "required";
  if (tc.type === "none") return "none";
  if (tc.type === "tool" && tc.name) return { type: "function", function: { name: tc.name } };
  return undefined;
}

/** Build an OpenAI chat.completions body from our (Anthropic-shaped) body. */
export function buildOpenAIBody(base, { effort, json }) {
  const body = {
    model: base.model,
    messages: toOpenAIMessages(base.messages, base.system),
    max_tokens: base.max_tokens,
    stream: base.stream !== false,
  };
  if (body.stream) body.stream_options = { include_usage: true };
  if (base.temperature !== undefined) body.temperature = base.temperature;
  const tools = toOpenAITools(base.tools);
  if (tools) {
    body.tools = tools;
    const tc = toOpenAIToolChoice(base.tool_choice);
    if (tc) body.tool_choice = tc;
  }
  const lvl = normalizeEffort(effort);
  if (lvl) body.reasoning_effort = OPENAI_EFFORT[lvl];
  if (json) body.response_format = { type: "json_object" };
  return body;
}

/* ------------------------------------------------------------------ */
/*  Compatibility downgrades                                           */
/* ------------------------------------------------------------------ */
/**
 * Given a 400/422 error message from the upstream, return a modified body that
 * drops/renames the parameter the provider complained about — or null if we
 * don't know how to fix it. Lets one UI work across 30+ models whose gateways
 * accept slightly different parameter sets.
 */
export function downgradeBody(body, style, errText, triedGeneric) {
  const t = String(errText || "").toLowerCase();
  const b = { ...body };
  let changed = false;
  const drop = (k) => { if (k in b) { delete b[k]; changed = true; } };

  if (/reasoning|effort|thinking|budget/.test(t)) { drop("reasoning_effort"); drop("thinking"); }
  if (/stream_options|include_usage/.test(t)) drop("stream_options");
  if (/response_format|json_object|json mode/.test(t)) drop("response_format");
  if (/temperature/.test(t)) drop("temperature");
  if (/max_completion_tokens/.test(t) && "max_tokens" in b) {
    b.max_completion_tokens = b.max_tokens; delete b.max_tokens; changed = true;
  } else if (/max_tokens/.test(t) && /(too large|exceed|maximum|at most|less than|<=)/.test(t) && b.max_tokens > 4096) {
    b.max_tokens = Math.max(4096, Math.floor(b.max_tokens / 2)); changed = true;
  }
  if (/tool_choice/.test(t)) drop("tool_choice");
  if (changed) return { body: b, generic: false };

  // Unknown complaint: strip every optional knob once as a last resort.
  if (!triedGeneric) {
    for (const k of ["reasoning_effort", "thinking", "stream_options", "response_format", "temperature", "tool_choice"]) drop(k);
    if (changed) return { body: b, generic: true };
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Stream translation: OpenAI chunks → Anthropic SSE events            */
/* ------------------------------------------------------------------ */
const FINISH_MAP = { stop: "end_turn", length: "max_tokens", tool_calls: "tool_use", function_call: "tool_use", content_filter: "refusal" };

export function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/**
 * Stateful translator. Feed it raw bytes/strings from the OpenAI SSE stream via
 * push(); it returns Anthropic-format SSE text to forward to the browser.
 * Call end() once the upstream finishes.
 */
export function createOpenAIStreamTranslator(model) {
  let buf = "";
  let started = false;
  let index = -1;
  let open = null; // { kind: "text"|"thinking"|"tool", key }
  const toolIdx = new Map(); // openai tool_call index -> our block index
  let stopReason = null;
  let usage = { input_tokens: 0, output_tokens: 0 };
  let sawTool = false;
  let finished = false;

  const start = () => {
    if (started) return "";
    started = true;
    return sse("message_start", {
      type: "message_start",
      message: { id: `msg_${Date.now().toString(36)}`, type: "message", role: "assistant", model, content: [], usage: { input_tokens: 0, output_tokens: 0 } },
    });
  };
  const deferredStops = []; // tool blocks are closed at the very end (args may interleave)
  const closeOpen = () => {
    if (!open) return "";
    if (open.kind === "tool") { deferredStops.push(open.index); open = null; return ""; }
    const s = sse("content_block_stop", { type: "content_block_stop", index: open.index });
    open = null;
    return s;
  };
  const openBlock = (kind, content_block) => {
    let s = closeOpen();
    index += 1;
    open = { kind, index };
    s += sse("content_block_start", { type: "content_block_start", index, content_block });
    return s;
  };

  const handleChunk = (json) => {
    let s = start();
    if (json.error) {
      s += sse("error", { type: "error", error: { type: "api_error", message: json.error.message || String(json.error) } });
      return s;
    }
    if (json.usage) {
      usage = {
        input_tokens: json.usage.prompt_tokens ?? json.usage.input_tokens ?? usage.input_tokens,
        output_tokens: json.usage.completion_tokens ?? json.usage.output_tokens ?? usage.output_tokens,
      };
    }
    const choice = Array.isArray(json.choices) ? json.choices[0] : null;
    if (!choice) return s;
    const d = choice.delta || choice.message || {};

    const reasoning = d.reasoning_content ?? d.reasoning ?? d.thinking;
    if (typeof reasoning === "string" && reasoning) {
      if (!open || open.kind !== "thinking") s += openBlock("thinking", { type: "thinking", thinking: "" });
      s += sse("content_block_delta", { type: "content_block_delta", index: open.index, delta: { type: "thinking_delta", thinking: reasoning } });
    }
    if (typeof d.content === "string" && d.content) {
      if (!open || open.kind !== "text") s += openBlock("text", { type: "text", text: "" });
      s += sse("content_block_delta", { type: "content_block_delta", index: open.index, delta: { type: "text_delta", text: d.content } });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const tc of d.tool_calls) {
        const k = tc.index ?? 0;
        if (!toolIdx.has(k)) {
          sawTool = true;
          const id = tc.id || `toolu_${Date.now().toString(36)}_${k}`;
          s += openBlock("tool", { type: "tool_use", id, name: tc.function?.name || "", input: {} });
          toolIdx.set(k, open.index);
        }
        const args = tc.function?.arguments;
        if (typeof args === "string" && args) {
          s += sse("content_block_delta", { type: "content_block_delta", index: toolIdx.get(k), delta: { type: "input_json_delta", partial_json: args } });
        }
      }
    }
    if (choice.finish_reason) stopReason = FINISH_MAP[choice.finish_reason] || "end_turn";
    return s;
  };

  return {
    push(chunk) {
      buf += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      let out = "";
      let m;
      while ((m = /\r?\n\r?\n/.exec(buf))) {
        const record = buf.slice(0, m.index);
        buf = buf.slice(m.index + m[0].length);
        out += this._record(record);
      }
      return out;
    },
    _record(record) {
      const data = record.split(/\r?\n/).filter((l) => l.startsWith("data:")).map((l) => l.slice(5).trimStart()).join("\n");
      if (!data) return "";
      if (data.trim() === "[DONE]") return "";
      try { return handleChunk(JSON.parse(data)); } catch { return ""; }
    },
    end() {
      if (finished) return "";
      finished = true;
      let out = buf.trim() ? this._record(buf) : "";
      buf = "";
      out += start();
      out += closeOpen();
      for (const i of deferredStops) out += sse("content_block_stop", { type: "content_block_stop", index: i });
      deferredStops.length = 0;
      if (!stopReason) stopReason = sawTool ? "tool_use" : "end_turn";
      if (sawTool && stopReason === "end_turn") stopReason = "tool_use";
      out += sse("message_delta", { type: "message_delta", delta: { stop_reason: stopReason, stop_sequence: null }, usage });
      out += sse("message_stop", { type: "message_stop" });
      return out;
    },
  };
}

/** Translate a full (non-streaming) OpenAI completion into Anthropic SSE text. */
export function openAICompletionToSse(json, model) {
  const t = createOpenAIStreamTranslator(model);
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const fake = {
    usage: json?.usage,
    choices: [{
      delta: {
        reasoning_content: msg.reasoning_content || msg.reasoning,
        content: msg.content,
        tool_calls: (msg.tool_calls || []).map((tc, i) => ({ index: i, id: tc.id, function: tc.function })),
      },
      finish_reason: choice.finish_reason,
    }],
  };
  return t.push(`data: ${JSON.stringify(fake)}\n\n`) + t.end();
}

/** Translate a full OpenAI completion into an Anthropic Messages JSON response. */
export function openAICompletionToAnthropic(json, model) {
  const choice = json?.choices?.[0] || {};
  const msg = choice.message || {};
  const content = [];
  if (msg.content) content.push({ type: "text", text: msg.content });
  for (const tc of msg.tool_calls || []) {
    let input = {};
    try { input = JSON.parse(tc.function?.arguments || "{}"); } catch {}
    content.push({ type: "tool_use", id: tc.id, name: tc.function?.name, input });
  }
  return {
    id: json?.id, type: "message", role: "assistant", model, content,
    stop_reason: FINISH_MAP[choice.finish_reason] || "end_turn",
    usage: { input_tokens: json?.usage?.prompt_tokens || 0, output_tokens: json?.usage?.completion_tokens || 0 },
  };
}
