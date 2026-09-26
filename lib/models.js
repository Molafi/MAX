/**
 * MAX — model catalog.
 *
 * Each model is tied to a provider. `caps` are capability hints used by the UI
 * (badges, "vision" warnings, whether to send tools). They are best-effort: MAX
 * still adapts at runtime if a provider rejects a parameter.
 *
 *   r = reasoning · v = vision · t = tools · s = streaming · j = JSON mode
 */
const ALL = "rvtsj";

function m(id, label, caps = ALL, extra = {}) {
  return {
    id, label,
    caps: {
      reasoning: caps.includes("r"), vision: caps.includes("v"), tools: caps.includes("t"),
      streaming: caps.includes("s"), json: caps.includes("j"),
    },
    ...extra,
  };
}

// CodeCraft API (https://codecraftapi.com) — one OpenAI-compatible endpoint.
const CODECRAFT = [
  m("claude-opus-5", "Claude Opus 5", ALL, { family: "Anthropic", recommended: true }),
  m("claude-opus-5.5", "Claude Opus 5.5", ALL, { family: "Anthropic" }),
  m("claude-sonnet-5", "Claude Sonnet 5", ALL, { family: "Anthropic" }),
  m("claude-mythos-preview", "Claude Mythos Preview", ALL, { family: "Anthropic" }),
  m("claude-fable-5.1", "Claude Fable 5.1", ALL, { family: "Anthropic" }),
  m("claude-fable-5", "Claude Fable 5", ALL, { family: "Anthropic" }),
  m("claude-opus-4.8", "Claude Opus 4.8", ALL, { family: "Anthropic" }),
  m("claude-opus-4.7", "Claude Opus 4.7", ALL, { family: "Anthropic" }),
  m("claude-opus-4.6", "Claude Opus 4.6", ALL, { family: "Anthropic" }),
  m("gpt-5.6-sol", "GPT-5.6 Sol", ALL, { family: "OpenAI" }),
  m("gpt-5.6-terra", "GPT-5.6 Terra", ALL, { family: "OpenAI" }),
  m("gpt-5.6-luna", "GPT-5.6 Luna", ALL, { family: "OpenAI" }),
  m("gpt-5.5-pro", "GPT-5.5 Pro", ALL, { family: "OpenAI" }),
  m("gpt-5.5", "GPT-5.5", ALL, { family: "OpenAI" }),
  m("gemini-3.1-pro", "Gemini 3.1 Pro", ALL, { family: "Google" }),
  m("gemini-3.7-flash", "Gemini 3.7 Flash", ALL, { family: "Google" }),
  m("gemini-3.6-flash", "Gemini 3.6 Flash", ALL, { family: "Google" }),
  m("gemma-2-2b", "Gemma 2 2B", "sj", { family: "Google" }),
  m("grok-4.6", "Grok 4.6", ALL, { family: "xAI" }),
  m("grok-4.5", "Grok 4.5", ALL, { family: "xAI" }),
  m("deepseek-v4-pro-max", "DeepSeek-V4-Pro-Max", "rtsj", { family: "DeepSeek" }),
  m("deepseek-v4-pro-0813", "DeepSeek-V4-Pro-0813", "rtsj", { family: "DeepSeek" }),
  m("deepseek-v4-flash-0731", "DeepSeek-V4-Flash-0731", "rtsj", { family: "DeepSeek" }),
  m("qwen3.8-max", "Qwen3.8 Max", ALL, { family: "Qwen" }),
  m("qwen3.7-max", "Qwen3.7 Max", ALL, { family: "Qwen" }),
  m("qwen3.8-27b", "Qwen3.8-27B", "rtsj", { family: "Qwen" }),
  m("kimi-k3", "Kimi K3", ALL, { family: "Moonshot" }),
  m("kimi-k2.6", "Kimi K2.6", "rtsj", { family: "Moonshot" }),
  m("glm-5.3", "GLM-5.3", "rtsj", { family: "Zhipu" }),
  m("glm-5.2", "GLM-5.2", "rtsj", { family: "Zhipu" }),
  m("seed-2.1-pro", "Seed 2.1 Pro", ALL, { family: "ByteDance" }),
  m("seed-2.1-turbo", "Seed 2.1 Turbo", ALL, { family: "ByteDance" }),
  m("muse-spark-1.1", "Muse Spark 1.1", ALL, { family: "Meta" }),
];

// AgentRouter (https://agentrouter.org) — Anthropic-compatible gateway.
const AGENTROUTER = [
  m("claude-opus-4-8", "Claude Opus 4.8", ALL, { family: "Anthropic", recommended: true }),
  m("claude-opus-4-7", "Claude Opus 4.7", ALL, { family: "Anthropic" }),
  m("claude-opus-4-6", "Claude Opus 4.6", ALL, { family: "Anthropic" }),
  m("gpt-5.6-sol", "GPT-5.6 Sol", ALL, { family: "OpenAI" }),
  m("gpt-5.5", "GPT-5.5", ALL, { family: "OpenAI" }),
  m("kimi-k3", "Kimi K3", ALL, { family: "Moonshot" }),
  m("glm-5.2", "GLM-5.2", "rtsj", { family: "Zhipu" }),
];

export function buildCatalog() {
  return [
    ...CODECRAFT.map((x) => ({ ...x, provider: "codecraft" })),
    ...AGENTROUTER.map((x) => ({ ...x, provider: "agentrouter" })),
  ];
}

// Rough USD per 1M tokens, for the running cost estimate only.
export const PRICING_HINTS = {
  "claude-opus": { in: 15, out: 75 }, "claude-sonnet": { in: 3, out: 15 }, "claude-fable": { in: 3, out: 15 },
  "claude-mythos": { in: 15, out: 75 }, "gpt-5.5-pro": { in: 15, out: 120 }, "gpt-5": { in: 1.25, out: 10 },
  "gemini-3.1-pro": { in: 2, out: 12 }, "gemini": { in: 0.3, out: 2.5 }, "gemma": { in: 0.05, out: 0.1 },
  "grok": { in: 3, out: 15 }, "deepseek": { in: 0.3, out: 1.2 }, "qwen": { in: 0.8, out: 3 },
  "kimi": { in: 0.6, out: 2.5 }, "glm": { in: 0.6, out: 2.2 }, "seed": { in: 0.3, out: 1.2 }, "muse": { in: 1, out: 4 },
};
