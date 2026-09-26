/**
 * MAX — AI video generation service.
 *
 * Providers
 *   openrouter  POST {base}/videos → poll {polling_url} → GET {base}/videos/{id}/content
 *               One key for Veo 3.1, Kling 3.0, Seedance 2.x, Wan, Hailuo… The live model
 *               list (with durations/resolutions/aspect ratios/pricing) comes from
 *               GET {base}/videos/models, so MAX can choose a model that fits the request.
 *   google      Gemini API Veo 3.1: POST {base}/models/{model}:predictLongRunning →
 *               GET {base}/{operation} → download the returned file URI.
 *   gateway     Any OpenAI-style Videos API (POST {base}/videos, GET {base}/videos/{id},
 *               GET {base}/videos/{id}/content) — e.g. CodeCraft if it enables video models.
 *
 * Jobs run on the server: submit → poll → download to data/videos/<id>.<ext>. A video keeps
 * generating even if the browser tab is closed, and it stays playable after the provider's
 * download URL expires. API keys are held in memory only, never written to disk.
 *
 * Zero dependencies.
 */
import path from "node:path";
import crypto from "node:crypto";
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, renameSync, unlinkSync,
  statSync, openSync, readSync, closeSync, createReadStream, createWriteStream,
} from "node:fs";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const MAX_VIDEO_BYTES = 600 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_JOB_MS = 45 * 60_000;
const MAX_ACTIVE_PER_OWNER = 4;
const MAX_PROMPT_CHARS = 4000;
const CATALOG_TTL_MS = 10 * 60_000;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);
const ID_RE = /^vid_[a-z0-9]{8,40}$/;
const MODEL_RE = /^[A-Za-z0-9._\-/:@]{1,200}$/;
const VIDEO_ID_HINT = /veo|sora|kling|seedance|wan-?\d|hailuo|minimax|video|runway|gen-?4|ray-?\d|luma|pixverse|vidu|ltx|hunyuan|mochi|pika|omni/i;

/* ------------------------------------------------------------------ */
/*  Static catalogs                                                    */
/* ------------------------------------------------------------------ */
// Gemini API Veo models (list prices per second, audio included).
const GOOGLE_MODELS = [
  {
    id: "veo-3.1-generate-preview", label: "Veo 3.1", family: "Google",
    durations: [4, 6, 8], durationsByResolution: { "1080p": [8], "4k": [8] },
    resolutions: ["720p", "1080p", "4k"], aspectRatios: ["16:9", "9:16"], frameImages: ["first_frame", "last_frame"],
    audio: true, audioAlways: true, pricing: { perSecond: { "720p": 0.4, "1080p": 0.4, "4k": 0.6 } },
    description: "Google's flagship video model — cinematic realism with native audio and dialogue.",
  },
  {
    id: "veo-3.1-fast-generate-preview", label: "Veo 3.1 Fast", family: "Google",
    durations: [4, 6, 8], durationsByResolution: { "1080p": [8], "4k": [8] },
    resolutions: ["720p", "1080p", "4k"], aspectRatios: ["16:9", "9:16"], frameImages: ["first_frame", "last_frame"],
    audio: true, audioAlways: true, pricing: { perSecond: { "720p": 0.1, "1080p": 0.12 } },
    description: "Near-Veo quality, much faster and cheaper. Native audio.",
  },
  {
    id: "veo-3.1-lite-generate-preview", label: "Veo 3.1 Lite", family: "Google",
    durations: [4, 6, 8], durationsByResolution: { "1080p": [8] },
    resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16"], frameImages: ["first_frame", "last_frame"],
    audio: true, audioAlways: true, pricing: { perSecond: { "720p": 0.05, "1080p": 0.08 } },
    description: "Lowest-cost Veo for drafts and high volume. Native audio, no 4K.",
  },
];

// Used only if OpenRouter's live /videos/models list can't be fetched.
const OPENROUTER_FALLBACK = [
  ["google/veo-3.1", "Veo 3.1", "Google", { durations: [4, 6, 8], resolutions: ["720p", "1080p"], aspectRatios: ["16:9", "9:16", "1:1"], audio: true, pricing: { perSecond: { default: 0.5, "1080p": 0.75 } } }],
  ["google/veo-3.1-fast", "Veo 3.1 Fast", "Google"],
  ["google/veo-3.1-lite", "Veo 3.1 Lite", "Google"],
  ["kwaivgi/kling-v3.0-pro", "Kling 3.0 Pro", "Kuaishou"],
  ["kwaivgi/kling-v3.0-std", "Kling 3.0 Standard", "Kuaishou"],
  ["kwaivgi/kling-video-o1", "Kling O1", "Kuaishou"],
  ["bytedance/seedance-2.5", "Seedance 2.5", "ByteDance"],
  ["bytedance/seedance-2.0", "Seedance 2.0", "ByteDance"],
  ["bytedance/seedance-2.0-fast", "Seedance 2.0 Fast", "ByteDance"],
  ["minimax/hailuo-3", "Hailuo 3", "MiniMax"],
  ["minimax/hailuo-2.3", "Hailuo 2.3", "MiniMax"],
  ["alibaba/wan-2.7", "Wan 2.7", "Alibaba"],
];

/* ------------------------------------------------------------------ */
/*  Small helpers                                                      */
/* ------------------------------------------------------------------ */
const numList = (v) => (Array.isArray(v) ? v.map(Number).filter((n) => Number.isFinite(n) && n > 0) : null);
const strList = (v) => (Array.isArray(v) ? v.filter((s) => typeof s === "string" && s.length < 40) : null);

export function resRank(r) {
  const s = String(r || "").toLowerCase();
  const m = s.match(/^(\d{3,4})p$/);
  if (m) {
    const n = +m[1];
    return n >= 2160 ? 6 : n >= 1440 ? 5 : n >= 1080 ? 4 : n >= 720 ? 3 : n >= 480 ? 2 : 1;
  }
  if (s === "1k") return 4;
  if (s === "2k") return 5;
  if (s === "4k") return 6;
  return 0;
}

function parsePricing(skus) {
  if (!skus || typeof skus !== "object") return null;
  const perSecond = {};
  const other = {};
  for (const [k, v] of Object.entries(skus)) {
    const n = Number(v);
    if (!Number.isFinite(n)) continue;
    if (/second/i.test(k)) {
      const res = (k.match(/(\d{3,4}p|[1248]k)\b/i) || [])[1];
      const key = (res ? res.toLowerCase() : "default") + (/no-?audio|without-?audio|silent/i.test(k) ? ":noaudio" : "");
      perSecond[key] = key in perSecond ? Math.min(perSecond[key], n) : n;
    } else {
      other[k] = n;
    }
  }
  if (!Object.keys(perSecond).length && !Object.keys(other).length) return null;
  return { perSecond, other };
}

function splitDataUrl(u) {
  const m = /^data:(image\/(?:png|jpeg|jpg|webp));base64,([A-Za-z0-9+/=\s]+)$/.exec(String(u || ""));
  if (!m) return null;
  return { mimeType: m[1] === "image/jpg" ? "image/jpeg" : m[1], data: m[2].replace(/\s+/g, "") };
}

function sameOrigin(url, base) {
  try { return new URL(url).origin === new URL(base).origin; } catch { return false; }
}

function sniffVideo(head) {
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    return head.toString("latin1", 8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  }
  if (head.length >= 4 && head[0] === 0x1a && head[1] === 0x45 && head[2] === 0xdf && head[3] === 0xa3) return "video/webm";
  return null;
}

async function http(method, url, headers, body, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { method, headers, body, signal: ctrl.signal });
    const text = await r.text().catch(() => "");
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch {}
    return { ok: r.ok, status: r.status, json, text, headers: r.headers };
  } catch (err) {
    const cause = err?.name === "AbortError" ? "timed out" : (err?.cause?.code || err?.cause?.message || err?.message || "network error");
    const e = new Error(`network: ${cause}`);
    e.network = true;
    throw e;
  } finally {
    clearTimeout(t);
  }
}

function errText(resp, fallback) {
  const j = resp?.json;
  const m = j?.error?.message || (typeof j?.error === "string" ? j.error : "") || j?.message || j?.detail ||
    (resp?.text && !/^\s*</.test(resp.text) ? resp.text.slice(0, 400) : "") || fallback || `HTTP ${resp?.status}`;
  return String(m).replace(/\s+/g, " ").trim().slice(0, 800);
}

function friendly(provider, resp, model) {
  const label = provider.label;
  const msg = errText(resp, "request failed");
  const s = resp?.status;
  if (s === 401 || s === 403) return `${label} rejected the API key (${s}): ${msg}`;
  if (s === 402) return `Not enough credits on your ${label} account (402): ${msg}`;
  if (s === 429) return `${label} is rate-limiting requests (429) — wait a moment and try again. ${msg}`;
  if (s === 404) return `${label} couldn't find "${model}" (404): ${msg}`;
  return `${label} error (${s}): ${msg}`;
}

/** Pick a replacement for a parameter the provider rejected, using any "supported: …" list in the error. */
function adjustParams(params, message) {
  const text = String(message || "");
  const fields = [
    ["duration", /duration|seconds/i, (t) => /^\d{1,2}$/.test(t), (list, cur) => list.map(Number).sort((a, b) => Math.abs(a - cur) - Math.abs(b - cur) || a - b)[0]],
    ["resolution", /resolution|\bsize\b/i, (t) => /^\d{3,4}p$|^[1248]k$/i.test(t), (list, cur) => list.sort((a, b) => Math.abs(resRank(a) - resRank(cur)) - Math.abs(resRank(b) - resRank(cur)))[0]],
    ["aspectRatio", /aspect/i, (t) => /^\d{1,2}:\d{1,2}$/.test(t), (list, cur) => {
      const [w, h] = String(cur).split(":").map(Number);
      const orient = (a) => { const [x, y] = a.split(":").map(Number); return Math.sign(x - y); };
      return list.find((a) => orient(a) === Math.sign(w - h)) || list[0];
    }],
    ["audio", /audio/i, null, null],
    ["seed", /\bseed\b/i, null, null],
  ];
  for (const [key, re, valid, pick] of fields) {
    if (!(key in params) || params[key] === undefined || !re.test(text)) continue;
    if (valid) {
      // e.g. "Unsupported duration 8. Supported durations: [5, 10]" → [5, 10]
      const at = text.search(re);
      const seg = text.slice(at, at + 300);
      const k = seg.search(/\b(?:supported|allowed|valid|one of|must be|expected|options?|available)\b/i);
      const tokens = k < 0 ? [] : [...new Set((seg.slice(k, k + 200).match(/[\w.:]+/g) || [])
        .map((t) => t.replace(/[.:]+$/, ""))
        .filter(valid)
        .filter((t) => String(t) !== String(params[key])))];
      if (tokens.length) {
        const next = pick(tokens, params[key]);
        if (next !== undefined && String(next) !== String(params[key])) {
          const old = params[key];
          params[key] = key === "duration" ? Number(next) : next;
          return `${key} ${old} → ${params[key]} (not supported by the model)`;
        }
      }
    }
    const old = params[key];
    delete params[key];
    return `dropped ${key}=${old} (not supported by the model)`;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/*  Service factory                                                    */
/* ------------------------------------------------------------------ */
export function createVideoService(opts) {
  const { dataDir, allowClientKey, sendJson, readBody, rateLimit, log = console } = opts;
  const dir = path.join(dataDir, "videos");
  const jobs = new Map();

  const PROVIDERS = {
    openrouter: {
      id: "openrouter", label: "OpenRouter", keyUrl: "https://openrouter.ai/keys",
      base: String(opts.openrouter?.base || "https://openrouter.ai/api/v1").replace(/\/+$/, ""),
      key: opts.openrouter?.key || "",
      blurb: "One key for Veo 3.1, Kling 3.0, Seedance, Wan, Hailuo and more.",
    },
    google: {
      id: "google", label: "Google Gemini (Veo)", keyUrl: "https://aistudio.google.com/apikey",
      base: String(opts.google?.base || "https://generativelanguage.googleapis.com/v1beta").replace(/\/+$/, ""),
      key: opts.google?.key || "",
      blurb: "Veo 3.1, Veo 3.1 Fast and Veo 3.1 Lite straight from Google AI Studio.",
    },
    gateway: {
      id: "gateway", label: opts.gateway?.label || "OpenAI-compatible gateway", keyUrl: opts.gateway?.keyUrl || "",
      base: String(opts.gateway?.base || "").replace(/\/+$/, ""),
      key: opts.gateway?.key || "",
      blurb: "Any gateway that implements the OpenAI Videos API (/v1/videos).",
    },
  };
  const APP_URL = opts.appUrl || "https://github.com/Molafi/MAX";

  const ensureDir = () => { try { if (!existsSync(dir)) mkdirSync(dir, { recursive: true }); } catch {} };
  const jobFile = (id) => path.join(dir, `${id}.json`);
  const resolveKey = (provider, clientKey) => {
    const k = allowClientKey ? String(clientKey || "").trim() : "";
    return k || PROVIDERS[provider]?.key || "";
  };

  /* ---------------- persistence ---------------- */
  function persist(job) {
    job.updatedAt = Date.now();
    ensureDir();
    const rec = {};
    for (const [k, v] of Object.entries(job)) if (!k.startsWith("_")) rec[k] = v;
    try { writeFileSync(jobFile(job.id), JSON.stringify(rec), { mode: 0o600 }); }
    catch (err) { log.error?.("[MAX] video: could not save job", job.id, err.message); }
  }

  function publicJob(j) {
    return {
      id: j.id, provider: j.provider, providerLabel: PROVIDERS[j.provider]?.label || j.provider,
      model: j.model, label: j.label || j.model, prompt: j.prompt, params: j.params, hasImage: Boolean(j.hasImage),
      status: j.status, progress: j.progress ?? null, error: j.error || null, notes: j.notes || [], cost: j.cost ?? null,
      createdAt: j.createdAt, updatedAt: j.updatedAt, startedAt: j.startedAt || null, finishedAt: j.finishedAt || null,
      url: j.file ? `/api/video/file/${j.id}` : null, size: j.file?.size || null, mime: j.file?.mime || null,
    };
  }

  function loadJobs() {
    ensureDir();
    let names = [];
    try { names = readdirSync(dir); } catch { return; }
    for (const n of names) {
      if (n.endsWith(".part")) { try { unlinkSync(path.join(dir, n)); } catch {} continue; }
      if (!/^vid_[a-z0-9]+\.json$/.test(n)) continue;
      try {
        const j = JSON.parse(readFileSync(path.join(dir, n), "utf8"));
        if (!j || !ID_RE.test(j.id) || !PROVIDERS[j.provider]) continue;
        jobs.set(j.id, j);
        if (!TERMINAL.has(j.status) && j.status !== "interrupted") {
          if (j.remote && PROVIDERS[j.provider].key) {
            j._key = PROVIDERS[j.provider].key;
            j.status = "queued";
            persist(j);
            schedulePoll(j, 1500);
          } else {
            j.status = "interrupted";
            j.error = "The MAX server restarted while this video was generating. Reopen the chat to resume it.";
            persist(j);
          }
        }
      } catch {}
    }
  }

  /* ---------------- provider adapters ---------------- */
  const ADAPTERS = {
    openrouter: {
      headers(key) {
        return { Authorization: `Bearer ${key}`, "Content-Type": "application/json", Accept: "application/json", "HTTP-Referer": APP_URL, "X-Title": "MAX" };
      },
      async submit(job, params, key) {
        const P = PROVIDERS.openrouter;
        const body = { model: job.model, prompt: job.prompt };
        if (params.duration) body.duration = params.duration;
        if (params.resolution) body.resolution = params.resolution;
        if (params.aspectRatio) body.aspect_ratio = params.aspectRatio;
        if (typeof params.audio === "boolean") body.generate_audio = params.audio;
        if (Number.isInteger(params.seed)) body.seed = params.seed;
        const frames = [];
        if (job._image) frames.push({ type: "image_url", image_url: { url: job._image }, frame_type: "first_frame" });
        if (job._lastFrame) frames.push({ type: "image_url", image_url: { url: job._lastFrame }, frame_type: "last_frame" });
        if (frames.length) body.frame_images = frames;
        const r = await http("POST", `${P.base}/videos`, this.headers(key), JSON.stringify(body), 60_000);
        if (!r.ok || !r.json?.id) return { ok: false, resp: r };
        const id = String(r.json.id);
        const pollingUrl = r.json.polling_url && sameOrigin(r.json.polling_url, P.base)
          ? r.json.polling_url : `${P.base}/videos/${encodeURIComponent(id)}`;
        return { ok: true, remote: { id, pollingUrl } };
      },
      async poll(job, key) {
        const P = PROVIDERS.openrouter;
        const r = await http("GET", job.remote.pollingUrl, this.headers(key));
        if (!r.ok) return { httpError: r };
        const st = String(r.json?.status || "").toLowerCase();
        if (st === "completed") {
          const u = (r.json.unsigned_urls || []).find((x) => typeof x === "string" && sameOrigin(x, P.base));
          return {
            state: "done", cost: typeof r.json.usage?.cost === "number" ? r.json.usage.cost : null,
            download: { url: u || `${P.base}/videos/${encodeURIComponent(job.remote.id)}/content?index=0`, headers: { Authorization: `Bearer ${key}`, "HTTP-Referer": APP_URL } },
          };
        }
        if (["failed", "cancelled", "canceled", "expired"].includes(st)) {
          return { state: "failed", error: r.json?.error ? String(r.json.error).slice(0, 800) : `The job ${st}.` };
        }
        return { state: st === "in_progress" ? "running" : "queued" };
      },
    },

    google: {
      headers(key) { return { "x-goog-api-key": key, "Content-Type": "application/json" }; },
      async submit(job, params, key) {
        const P = PROVIDERS.google;
        const model = job.model.replace(/^models\//, "");
        const instance = { prompt: job.prompt };
        const img = job._image && splitDataUrl(job._image);
        if (img) instance.image = { bytesBase64Encoded: img.data, mimeType: img.mimeType };
        const last = job._lastFrame && splitDataUrl(job._lastFrame);
        if (last) instance.lastFrame = { bytesBase64Encoded: last.data, mimeType: last.mimeType };
        const parameters = {};
        if (params.aspectRatio) parameters.aspectRatio = params.aspectRatio;
        if (params.resolution) parameters.resolution = String(params.resolution).toLowerCase();
        if (params.duration) parameters.durationSeconds = params.duration;
        if (job.negativePrompt) parameters.negativePrompt = job.negativePrompt;
        const body = { instances: [instance] };
        if (Object.keys(parameters).length) body.parameters = parameters;
        const r = await http("POST", `${P.base}/models/${encodeURIComponent(model)}:predictLongRunning`, this.headers(key), JSON.stringify(body), 60_000);
        if (!r.ok || !r.json?.name) return { ok: false, resp: r };
        return { ok: true, remote: { id: String(r.json.name), operation: String(r.json.name) } };
      },
      async poll(job, key) {
        const P = PROVIDERS.google;
        const op = job.remote.operation;
        if (!/^[\w.\-/]+$/.test(op)) return { state: "failed", error: "Unexpected operation name from Google." };
        const r = await http("GET", `${P.base}/${op}`, { "x-goog-api-key": key });
        if (!r.ok) return { httpError: r };
        const o = r.json || {};
        if (!o.done) return { state: "running" };
        if (o.error) return { state: "failed", error: `Veo: ${o.error.message || JSON.stringify(o.error).slice(0, 300)}` };
        const resp = o.response?.generateVideoResponse || o.response || {};
        const samples = resp.generatedSamples || resp.generatedVideos || resp.videos || [];
        const v = samples[0]?.video || samples[0] || null;
        if (v?.uri) {
          // Google's docs: append the key to the file URI (never sent to other hosts).
          const url = sameOrigin(v.uri, P.base) ? `${v.uri}${v.uri.includes("?") ? "&" : "?"}key=${encodeURIComponent(key)}` : v.uri;
          return { state: "done", download: { url, headers: {} } };
        }
        const bytes = v?.encodedVideo || v?.bytesBase64Encoded || v?.videoBytes;
        if (bytes) return { state: "done", download: { bytes, mime: v.encoding || v.mimeType || "video/mp4" } };
        if (resp.raiMediaFilteredCount) {
          const why = (resp.raiMediaFilteredReasons || []).join(" ").slice(0, 500);
          return { state: "failed", error: `Google's safety filters blocked this video. ${why || "Try rephrasing the prompt."}` };
        }
        return { state: "failed", error: "Veo finished but returned no video." };
      },
    },

    gateway: {
      headers(key, json = true) {
        return { Authorization: `Bearer ${key}`, Accept: "application/json", ...(json ? { "Content-Type": "application/json" } : {}) };
      },
      size(params) {
        const tall = { "720p": "720x1280", "1080p": "1080x1920", "480p": "480x854" };
        const wide = { "720p": "1280x720", "1080p": "1920x1080", "480p": "854x480" };
        const sq = { "720p": "720x720", "1080p": "1080x1080", "480p": "480x480" };
        const r = String(params.resolution || "720p").toLowerCase();
        const a = params.aspectRatio || "16:9";
        const [w, h] = a.split(":").map(Number);
        const table = w === h ? sq : w < h ? tall : wide;
        return table[r] || table["720p"];
      },
      async submit(job, params, key) {
        const P = PROVIDERS.gateway;
        if (!P.base) return { ok: false, resp: { status: 400, json: { error: { message: "No gateway base URL configured (VIDEO_GATEWAY_BASE_URL)." } } } };
        const body = { model: job.model, prompt: job.prompt };
        if (params.duration) body.seconds = String(params.duration);
        if (params.resolution || params.aspectRatio) body.size = this.size(params);
        if (job._image) body.input_reference = { image_url: job._image };
        let r = await http("POST", `${P.base}/videos`, this.headers(key), JSON.stringify(body), 60_000);
        // The OpenAI spec uses multipart/form-data — fall back to it if JSON isn't accepted.
        if (r.status === 415 || (r.status === 400 && /multipart|form-?data|content-type/i.test(errText(r)))) {
          const fd = new FormData();
          fd.set("model", job.model);
          fd.set("prompt", job.prompt);
          if (body.seconds) fd.set("seconds", body.seconds);
          if (body.size) fd.set("size", body.size);
          const img = job._image && splitDataUrl(job._image);
          if (img) fd.set("input_reference", new Blob([Buffer.from(img.data, "base64")], { type: img.mimeType }), `reference.${img.mimeType.split("/")[1]}`);
          r = await http("POST", `${P.base}/videos`, this.headers(key, false), fd, 60_000);
        }
        const id = r.json?.id || r.json?.data?.id || r.json?.task_id;
        if (!r.ok || !id) return { ok: false, resp: r };
        return { ok: true, remote: { id: String(id) } };
      },
      async poll(job, key) {
        const P = PROVIDERS.gateway;
        const r = await http("GET", `${P.base}/videos/${encodeURIComponent(job.remote.id)}`, this.headers(key, false));
        if (!r.ok) return { httpError: r };
        const o = r.json?.data && !r.json.status ? r.json.data : (r.json || {});
        const st = String(o.status || "").toLowerCase();
        const progress = Number.isFinite(Number(o.progress)) ? Math.max(0, Math.min(100, Number(o.progress))) : null;
        if (["completed", "succeeded", "success", "done"].includes(st)) {
          return { state: "done", download: { url: `${P.base}/videos/${encodeURIComponent(job.remote.id)}/content`, headers: { Authorization: `Bearer ${key}` } } };
        }
        if (["failed", "error", "cancelled", "canceled", "expired"].includes(st)) {
          const e = o.error?.message || (typeof o.error === "string" ? o.error : "") || `The job ${st}.`;
          return { state: "failed", error: String(e).slice(0, 800) };
        }
        return { state: ["in_progress", "processing", "running", "generating"].includes(st) ? "running" : "queued", progress };
      },
    },
  };

  /* ---------------- job lifecycle ---------------- */
  const pollDelay = (job) => {
    const age = Date.now() - (job.startedAt || job.createdAt);
    return age < 60_000 ? 5_000 : age < 180_000 ? 8_000 : 12_000;
  };

  function finish(job, status, error) {
    if (job._timer) { clearTimeout(job._timer); job._timer = null; }
    job.status = status;
    if (error) job.error = String(error).slice(0, 1000);
    job.finishedAt = Date.now();
    delete job._key; delete job._image; delete job._lastFrame;
    persist(job);
  }

  function schedulePoll(job, ms) {
    if (job._timer) clearTimeout(job._timer);
    job._timer = setTimeout(() => { job._timer = null; pollOnce(job).catch((e) => finish(job, "failed", e.message)); }, ms);
    job._timer.unref?.();
  }

  async function runJob(job) {
    const adapter = ADAPTERS[job.provider];
    const P = PROVIDERS[job.provider];
    const params = { ...job.params };
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        if (job.status === "cancelled") return;
        const r = await adapter.submit(job, params, job._key);
        if (r.ok) {
          job.remote = r.remote;
          job.params = params;
          job.status = "queued";
          job.startedAt = Date.now();
          delete job._image; delete job._lastFrame; // no longer needed once submitted
          persist(job);
          schedulePoll(job, 4_000);
          return;
        }
        const note = (r.resp?.status === 400 || r.resp?.status === 422) ? adjustParams(params, errText(r.resp)) : null;
        if (!note) return finish(job, "failed", friendly(P, r.resp, job.model));
        job.notes = [...(job.notes || []), note];
        log.log?.(`[MAX] video ${job.id}: ${P.id}/${job.model} ${note}`);
      }
      finish(job, "failed", `${P.label} kept rejecting the request parameters.`);
    } catch (err) {
      finish(job, "failed", err.network ? `Could not reach ${P.label} (${err.message.replace(/^network: /, "")}).` : err.message);
    }
  }

  async function pollOnce(job) {
    if (TERMINAL.has(job.status) || job.status === "interrupted") return;
    if (Date.now() - job.createdAt > MAX_JOB_MS) return finish(job, "failed", "Timed out — the provider took more than 45 minutes.");
    const P = PROVIDERS[job.provider];
    let r;
    try {
      r = await ADAPTERS[job.provider].poll(job, job._key);
    } catch (err) {
      job._pollErrors = (job._pollErrors || 0) + 1;
      if (job._pollErrors > 10) return finish(job, "failed", `Lost contact with ${P.label} (${err.message}).`);
      return schedulePoll(job, Math.min(30_000, 4_000 * job._pollErrors));
    }
    if (r.httpError) {
      const s = r.httpError.status;
      if (s === 401 || s === 403 || s === 404) return finish(job, "failed", friendly(P, r.httpError, job.model));
      job._pollErrors = (job._pollErrors || 0) + 1;
      if (job._pollErrors > 10) return finish(job, "failed", friendly(P, r.httpError, job.model));
      return schedulePoll(job, Math.min(30_000, 4_000 * job._pollErrors));
    }
    job._pollErrors = 0;
    if (r.state === "failed") return finish(job, "failed", r.error);
    if (r.state === "done") {
      job.status = "downloading";
      if (r.cost != null) job.cost = r.cost;
      persist(job);
      for (let attempt = 1; ; attempt++) {
        try {
          await downloadVideo(job, r.download);
          job.progress = 100;
          return finish(job, "completed");
        } catch (err) {
          if (attempt >= 3 || err.fatal) return finish(job, "failed", `The video was generated but downloading it failed: ${err.message}`);
          await new Promise((res) => setTimeout(res, 2_000 * attempt));
        }
      }
    }
    const changed = job.status !== r.state || (r.progress != null && r.progress !== job.progress);
    job.status = r.state;
    if (r.progress != null) job.progress = r.progress;
    if (changed) persist(job);
    schedulePoll(job, pollDelay(job));
  }

  async function downloadVideo(job, dl) {
    ensureDir();
    const tmp = path.join(dir, `${job.id}.part`);
    let mime = null;
    try {
      if (dl.bytes) {
        const buf = Buffer.from(String(dl.bytes), "base64");
        if (buf.length > MAX_VIDEO_BYTES) throw Object.assign(new Error("video is larger than 600 MB"), { fatal: true });
        writeFileSync(tmp, buf);
        mime = dl.mime || null;
      } else {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 10 * 60_000);
        try {
          const r = await fetch(dl.url, { headers: dl.headers || {}, redirect: "follow", signal: ctrl.signal });
          if (!r.ok) {
            const text = await r.text().catch(() => "");
            let json = null; try { json = JSON.parse(text); } catch {}
            throw Object.assign(new Error(`HTTP ${r.status} ${errText({ json, text, status: r.status })}`), { fatal: r.status === 401 || r.status === 403 || r.status === 404 });
          }
          const ct = String(r.headers.get("content-type") || "").toLowerCase();
          if (/json|text\/|html|xml/.test(ct)) {
            const text = await r.text().catch(() => "");
            throw new Error(`expected a video but got ${ct.split(";")[0]}: ${text.slice(0, 200)}`);
          }
          if (Number(r.headers.get("content-length")) > MAX_VIDEO_BYTES) throw Object.assign(new Error("video is larger than 600 MB"), { fatal: true });
          let n = 0;
          const guard = new Transform({
            transform(chunk, _enc, cb) {
              n += chunk.length;
              if (n > MAX_VIDEO_BYTES) cb(Object.assign(new Error("video is larger than 600 MB"), { fatal: true }));
              else cb(null, chunk);
            },
          });
          await pipeline(Readable.fromWeb(r.body), guard, createWriteStream(tmp, { mode: 0o600 }));
          if (ct.startsWith("video/")) mime = ct.split(";")[0].trim();
        } finally {
          clearTimeout(t);
        }
      }
      const head = Buffer.alloc(16);
      const fd = openSync(tmp, "r");
      const got = readSync(fd, head, 0, 16, 0);
      closeSync(fd);
      const sniffed = sniffVideo(head.subarray(0, got));
      if (!sniffed && (head[0] === 0x7b || head[0] === 0x3c)) throw new Error("the provider returned an error page instead of a video");
      mime = sniffed || mime || "video/mp4";
      const ext = { "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov" }[mime] || "mp4";
      const name = `${job.id}.${ext}`;
      renameSync(tmp, path.join(dir, name));
      job.file = { name, size: statSync(path.join(dir, name)).size, mime };
    } finally {
      try { if (existsSync(tmp)) unlinkSync(tmp); } catch {}
    }
  }

  /* ---------------- catalogs ---------------- */
  let orCache = null; // { at, models, error }
  async function openRouterModels(force) {
    if (!force && orCache && Date.now() - orCache.at < CATALOG_TTL_MS) return orCache;
    const P = PROVIDERS.openrouter;
    try {
      const r = await http("GET", `${P.base}/videos/models`, { Accept: "application/json", "HTTP-Referer": APP_URL, "X-Title": "MAX" }, undefined, 15_000);
      if (!r.ok || !Array.isArray(r.json?.data)) throw new Error(errText(r, "unexpected response"));
      const models = r.json.data
        .filter((x) => x && typeof x.id === "string" && MODEL_RE.test(x.id))
        .filter((x) => x.upscale_factor == null && !/upscal/i.test(x.id))
        .map((x) => {
          const name = String(x.name || x.id);
          const [fam, ...rest] = name.split(": ");
          return {
            provider: "openrouter", id: x.id, label: (rest.length ? rest.join(": ") : name).slice(0, 80),
            family: rest.length ? fam.slice(0, 40) : (x.id.split("/")[0] || ""),
            description: String(x.description || "").replace(/\s+/g, " ").slice(0, 280),
            durations: numList(x.supported_durations), resolutions: strList(x.supported_resolutions),
            aspectRatios: strList(x.supported_aspect_ratios), sizes: strList(x.supported_sizes),
            frameImages: strList(x.supported_frame_images),
            audio: x.generate_audio === true ? true : x.generate_audio === false ? false : null,
            seed: x.seed === true, pricing: parsePricing(x.pricing_skus), created: Number(x.created) || 0, live: true,
          };
        });
      orCache = { at: Date.now(), models, error: null };
    } catch (err) {
      const models = OPENROUTER_FALLBACK.map(([id, label, family, caps = {}]) => ({
        provider: "openrouter", id, label, family, description: "", durations: null, resolutions: null, aspectRatios: null,
        sizes: null, frameImages: null, audio: null, seed: false, pricing: null, live: false, ...caps,
      }));
      orCache = { at: Date.now() - CATALOG_TTL_MS + 60_000, models, error: `Live model list unavailable (${err.message}) — showing a built-in list.` };
    }
    return orCache;
  }

  const gwCache = new Map(); // key-hash -> { at, models, error }
  async function gatewayModels(key, force) {
    const P = PROVIDERS.gateway;
    if (!P.base || !key) return { models: [], error: null };
    const h = crypto.createHash("sha256").update(key).digest("hex").slice(0, 16);
    const c = gwCache.get(h);
    if (!force && c && Date.now() - c.at < CATALOG_TTL_MS) return c;
    let out;
    try {
      const r = await http("GET", `${P.base}/models`, { Authorization: `Bearer ${key}`, Accept: "application/json" }, undefined, 15_000);
      if (!r.ok) throw new Error(errText(r));
      const list = Array.isArray(r.json?.data) ? r.json.data : Array.isArray(r.json) ? r.json : [];
      const ids = list.map((x) => (typeof x === "string" ? x : x?.id)).filter((id) => typeof id === "string" && MODEL_RE.test(id));
      const vids = list.filter((x) => x && typeof x === "object" && (x.type === "video" || (x.output_modalities || x.architecture?.output_modalities || []).includes?.("video")))
        .map((x) => x.id);
      const chosen = [...new Set([...vids, ...ids.filter((id) => VIDEO_ID_HINT.test(id))])];
      out = {
        at: Date.now(), error: chosen.length ? null : "This gateway doesn't list any video models.",
        models: chosen.map((id) => ({ provider: "gateway", id, label: id, family: "Gateway", description: "", durations: null, resolutions: null, aspectRatios: null, frameImages: null, audio: null, pricing: null, live: true })),
      };
    } catch (err) {
      out = { at: Date.now(), models: [], error: `Could not list gateway models (${err.message}).` };
    }
    gwCache.set(h, out);
    return out;
  }

  /* ---------------- public config ---------------- */
  function publicProviders() {
    return Object.values(PROVIDERS)
      .filter((p) => p.id !== "gateway" || p.base)
      .map((p) => ({ id: p.id, label: p.label, hasServerKey: Boolean(p.key), keyUrl: p.keyUrl, blurb: p.blurb, ...(p.id === "gateway" ? { base: p.base } : {}) }));
  }

  /* ---------------- HTTP handlers ---------------- */
  const parse = async (req, limit) => { try { return JSON.parse((await readBody(req, limit)) || "{}"); } catch { return null; } };
  const bad = (res, message, status = 400, type = "bad_request") => sendJson(res, status, { error: { type, message } });
  const owned = (id, owner) => { const j = ID_RE.test(String(id)) ? jobs.get(id) : null; return j && j.owner === owner ? j : null; };

  async function handleModels(req, res) {
    const p = (await parse(req, 64 * 1024)) || {};
    const keys = p.keys || {};
    const [or, gw] = await Promise.all([
      openRouterModels(p.refresh === true),
      gatewayModels(resolveKey("gateway", keys.gateway), p.refresh === true),
    ]);
    const models = [...GOOGLE_MODELS.map((m) => ({ ...m, provider: "google", live: false })), ...or.models, ...gw.models];
    sendJson(res, 200, {
      ok: true, providers: publicProviders(), models, fetchedAt: Date.now(),
      errors: { ...(or.error ? { openrouter: or.error } : {}), ...(gw.error ? { gateway: gw.error } : {}) },
    });
  }

  async function handleGenerate(req, res, owner) {
    if (rateLimit && !rateLimit(req)) return bad(res, "Too many requests. Please slow down.", 429, "rate_limit");
    const p = await parse(req, 40 * 1024 * 1024);
    if (!p) return bad(res, "Invalid JSON body.");
    const provider = String(p.provider || "");
    const P = PROVIDERS[provider];
    if (!P || (provider === "gateway" && !P.base)) return bad(res, "Unknown video provider.");
    const key = resolveKey(provider, p.apiKey);
    if (!key) return bad(res, `No ${P.label} API key. Add it in Settings → Video generation.`, 401, "no_api_key");
    const model = String(p.model || "").trim();
    if (!MODEL_RE.test(model)) return bad(res, "A valid video model id is required.");
    const prompt = String(p.prompt || "").trim();
    if (!prompt) return bad(res, "Describe the video you want (prompt is empty).");
    if (prompt.length > MAX_PROMPT_CHARS) return bad(res, `Prompt is too long (max ${MAX_PROMPT_CHARS} characters).`);

    const params = {};
    const d = parseInt(p.duration, 10);
    if (Number.isFinite(d) && d >= 1 && d <= 60) params.duration = d;
    if (typeof p.resolution === "string" && /^\d{3,4}p$|^[1248][kK]$/.test(p.resolution)) params.resolution = p.resolution;
    if (typeof p.aspectRatio === "string" && /^\d{1,2}:\d{1,2}$/.test(p.aspectRatio)) params.aspectRatio = p.aspectRatio;
    if (typeof p.audio === "boolean" && provider !== "google") params.audio = p.audio;
    if (Number.isInteger(p.seed) && p.seed >= 0) params.seed = p.seed;

    // Server-side safety net for Veo's rules (1080p/4K clips must be 8 seconds; Lite has no 4K).
    if (provider === "google") {
      const gm = GOOGLE_MODELS.find((m) => m.id === model.replace(/^models\//, ""));
      if (gm) {
        if (params.resolution && !gm.resolutions.includes(params.resolution.toLowerCase())) params.resolution = "1080p";
        const allowed = gm.durationsByResolution[String(params.resolution || "").toLowerCase()] || gm.durations;
        if (params.duration && !allowed.includes(params.duration)) {
          params.duration = allowed.reduce((a, b) => (Math.abs(b - params.duration) < Math.abs(a - params.duration) ? b : a));
        }
        if (params.aspectRatio && !gm.aspectRatios.includes(params.aspectRatio)) params.aspectRatio = "16:9";
      }
    }

    let image = null, lastFrame = null;
    for (const [field, set] of [["image", (v) => (image = v)], ["lastFrame", (v) => (lastFrame = v)]]) {
      if (!p[field]) continue;
      const img = splitDataUrl(p[field]);
      if (!img) return bad(res, `${field} must be a PNG, JPEG or WebP data URL.`);
      if (img.data.length * 0.75 > MAX_IMAGE_BYTES) return bad(res, `${field} is too large (max 15 MB).`);
      set(`data:${img.mimeType};base64,${img.data}`);
    }

    const active = [...jobs.values()].filter((j) => j.owner === owner && !TERMINAL.has(j.status) && j.status !== "interrupted").length;
    if (active >= MAX_ACTIVE_PER_OWNER) {
      return bad(res, `You already have ${active} videos generating — wait for one to finish first.`, 429, "rate_limit");
    }

    const job = {
      id: `vid_${Date.now().toString(36)}${crypto.randomBytes(6).toString("hex")}`,
      owner, provider, model, label: String(p.label || model).slice(0, 80), prompt,
      negativePrompt: typeof p.negativePrompt === "string" ? p.negativePrompt.slice(0, 1000) : undefined,
      params, hasImage: Boolean(image), status: "submitting", progress: null, notes: [], cost: null,
      createdAt: Date.now(), updatedAt: Date.now(),
      _key: key, _image: image, _lastFrame: lastFrame,
    };
    jobs.set(job.id, job);
    persist(job);
    runJob(job).catch((e) => finish(job, "failed", e.message));
    sendJson(res, 200, { ok: true, job: publicJob(job) });
  }

  async function handleStatus(req, res, owner) {
    const p = (await parse(req, 64 * 1024)) || {};
    const ids = Array.isArray(p.ids) ? p.ids.slice(0, 100) : [];
    const out = {};
    for (const id of ids) { const j = owned(id, owner); out[id] = j ? publicJob(j) : null; }
    sendJson(res, 200, { ok: true, jobs: out });
  }

  async function handleAction(req, res, owner, id, action) {
    const j = owned(id, owner);
    if (!j) return bad(res, "Video job not found.", 404, "not_found");
    if (action === "get") return sendJson(res, 200, { ok: true, job: publicJob(j) });
    if (action === "cancel") {
      if (!TERMINAL.has(j.status)) finish(j, "cancelled", "Cancelled — MAX stopped waiting for this video.");
      return sendJson(res, 200, { ok: true, job: publicJob(j) });
    }
    if (action === "resume") {
      if (j.status !== "interrupted") return sendJson(res, 200, { ok: true, job: publicJob(j) });
      const p = (await parse(req, 64 * 1024)) || {};
      const key = resolveKey(j.provider, p.apiKey);
      if (!key) return bad(res, `No ${PROVIDERS[j.provider].label} key available to resume this video.`, 401, "no_api_key");
      if (!j.remote) { finish(j, "failed", "The server restarted before the job was submitted — please regenerate."); return sendJson(res, 200, { ok: true, job: publicJob(j) }); }
      j._key = key; j.status = "queued"; j.error = null; persist(j); schedulePoll(j, 500);
      return sendJson(res, 200, { ok: true, job: publicJob(j) });
    }
    if (action === "delete") {
      if (!TERMINAL.has(j.status)) finish(j, "cancelled");
      if (j.file) { try { unlinkSync(path.join(dir, j.file.name)); } catch {} }
      try { unlinkSync(jobFile(j.id)); } catch {}
      jobs.delete(j.id);
      return sendJson(res, 200, { ok: true });
    }
    return bad(res, "Unknown action.");
  }

  function handleFile(req, res, owner, id) {
    const j = owned(id, owner);
    if (!j || !j.file) return bad(res, "Video not found.", 404, "not_found");
    const file = path.join(dir, j.file.name);
    let size;
    try { size = statSync(file).size; } catch { return bad(res, "Video file is missing on the server.", 404, "not_found"); }
    const slug = String(j.label || "video").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "video";
    const headers = {
      "Content-Type": j.file.mime || "video/mp4", "Accept-Ranges": "bytes", "Cache-Control": "private, max-age=86400",
    };
    if (new URL(req.url, "http://x").searchParams.get("download")) {
      headers["Content-Disposition"] = `attachment; filename="max-${slug}-${j.id.slice(4, 12)}.${j.file.name.split(".").pop()}"`;
    }
    const range = String(req.headers.range || "");
    if (range) {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      let start, end;
      if (m && m[1] === "" && m[2] !== "") { start = Math.max(0, size - parseInt(m[2], 10)); end = size - 1; }
      else if (m && m[1] !== "") { start = parseInt(m[1], 10); end = m[2] ? Math.min(parseInt(m[2], 10), size - 1) : size - 1; }
      if (start === undefined || start >= size || start > end) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` });
        return res.end();
      }
      res.writeHead(206, { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": end - start + 1 });
      if (req.method === "HEAD") return res.end();
      return createReadStream(file, { start, end }).on("error", () => res.destroy()).pipe(res);
    }
    res.writeHead(200, { ...headers, "Content-Length": size });
    if (req.method === "HEAD") return res.end();
    createReadStream(file).on("error", () => res.destroy()).pipe(res);
  }

  async function handleTest(req, res) {
    const p = (await parse(req, 64 * 1024)) || {};
    const P = PROVIDERS[String(p.provider || "")];
    if (!P) return bad(res, "Unknown video provider.");
    const key = resolveKey(P.id, p.apiKey);
    if (!key) return bad(res, `No ${P.label} key configured.`, 401, "no_api_key");
    try {
      if (P.id === "openrouter") {
        const r = await http("GET", `${P.base}/key`, { Authorization: `Bearer ${key}`, Accept: "application/json" });
        if (!r.ok) return sendJson(res, r.status, { error: { type: "auth", message: friendly(P, r) } });
        const d = r.json?.data || {};
        const bits = [];
        if (typeof d.usage === "number") bits.push(`used $${d.usage.toFixed(2)}`);
        if (typeof d.limit === "number") bits.push(`limit $${d.limit.toFixed(2)}`);
        const cat = await openRouterModels(false);
        return sendJson(res, 200, { ok: true, message: `OpenRouter key OK${bits.length ? ` (${bits.join(", ")})` : ""} — ${cat.models.length} video models available.` });
      }
      if (P.id === "google") {
        const r = await http("GET", `${P.base}/models?pageSize=1000`, { "x-goog-api-key": key, Accept: "application/json" });
        if (!r.ok) return sendJson(res, r.status, { error: { type: "auth", message: friendly(P, r) } });
        const veo = (r.json?.models || []).map((m) => String(m.name || "").replace(/^models\//, "")).filter((n) => /^veo/i.test(n));
        return sendJson(res, 200, {
          ok: true, veoModels: veo,
          message: veo.length ? `Gemini key OK — Veo models on this key: ${veo.join(", ")}.` : "Gemini key OK, but no Veo models are listed for it (Veo needs a paid-tier key in a supported region).",
        });
      }
      const gw = await gatewayModels(key, true);
      if (gw.error && !gw.models.length) return sendJson(res, 400, { error: { type: "request", message: gw.error } });
      return sendJson(res, 200, { ok: true, message: `Gateway OK — ${gw.models.length} video model(s): ${gw.models.slice(0, 8).map((m) => m.id).join(", ")}.` });
    } catch (err) {
      return sendJson(res, 502, { error: { type: "network", message: `Could not reach ${P.label} (${err.message.replace(/^network: /, "")}).` } });
    }
  }

  /** Route /api/video/* requests. Returns true when handled. */
  async function route(req, res, pathname, owner) {
    if (!pathname.startsWith("/api/video/")) return false;
    const m = req.method;
    let x;
    if (pathname === "/api/video/models" && m === "POST") { await handleModels(req, res); return true; }
    if (pathname === "/api/video/generate" && m === "POST") { await handleGenerate(req, res, owner); return true; }
    if (pathname === "/api/video/jobs/status" && m === "POST") { await handleStatus(req, res, owner); return true; }
    if (pathname === "/api/video/test" && m === "POST") { await handleTest(req, res); return true; }
    if ((x = pathname.match(/^\/api\/video\/jobs\/([^/]+)$/))) {
      if (m === "GET") { await handleAction(req, res, owner, x[1], "get"); return true; }
      if (m === "DELETE") { await handleAction(req, res, owner, x[1], "delete"); return true; }
    }
    if ((x = pathname.match(/^\/api\/video\/jobs\/([^/]+)\/(cancel|resume)$/)) && m === "POST") {
      await handleAction(req, res, owner, x[1], x[2]); return true;
    }
    if ((x = pathname.match(/^\/api\/video\/file\/([^/]+)$/)) && (m === "GET" || m === "HEAD")) {
      handleFile(req, res, owner, x[1]); return true;
    }
    return false;
  }

  loadJobs();

  return {
    route,
    publicConfig: () => ({ providers: publicProviders() }),
    summary: () => publicProviders().map((p) => `${p.label}: ${p.hasServerKey ? "key loaded ✓" : "no server key"}`).join(" · "),
    _internal: { jobs, adjustParams, parsePricing },
  };
}
