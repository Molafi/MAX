/* ============================================================
   MAX — frontend application logic
   ============================================================ */
(() => {
  "use strict";

  /* ---------- tiny helpers ---------- */
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  // Storage keys are namespaced per signed-in user (so multiple accounts on one
  // browser stay isolated). applyScope() sets the prefix once we know the user.
  let SCOPE = "";
  let SESSION_KEY = "max.apiKey.session.v1";
  let GH_SESSION_KEY = "max.ghToken.session.v1";
  let GL_SESSION_KEY = "max.glToken.session.v1";
  const DONE_MARKER = "[[MAX_DONE]]";

  function applyScope(uid) {
    if (!uid) return;
    SCOPE = "u_" + uid + ".";
    SESSION_KEY = SCOPE + "max.apiKey.session.v1";
    GH_SESSION_KEY = SCOPE + "max.ghToken.session.v1";
    GL_SESSION_KEY = SCOPE + "max.glToken.session.v1";
    LS.convos = SCOPE + "max.conversations.v1";
    LS.settings = SCOPE + "max.settings.v1";
    LS.active = SCOPE + "max.active.v1";
    // theme stays global across accounts on the same browser
  }

  // Rough per-model pricing (USD per 1M tokens) for the running cost estimate.
  const PRICING = {
    "claude-opus-4-8": { in: 15, out: 75 },
    "claude-opus-4-7": { in: 15, out: 75 },
    "claude-opus-4-6": { in: 15, out: 75 },
    "glm-5.2": { in: 0.6, out: 2.2 },
    "gpt-5.5": { in: 5, out: 15 },
  };
  const priceFor = (model) => PRICING[model] || { in: 5, out: 15 };
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

  const DEFAULT_MODELS = [
    { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8 — recommended" },
    { id: "glm-5.2", label: "GLM 5.2" },
    { id: "gpt-5.5", label: "GPT-5.5" },
  ];

  const LS = {
    convos: "max.conversations.v1",
    settings: "max.settings.v1",
    theme: "max.theme.v1",
    active: "max.active.v1",
  };

  /* ---------- state ---------- */
  const state = {
    config: {
      defaultModel: "claude-opus-4-8", models: DEFAULT_MODELS, allowClientKey: true, hasServerKey: false,
      github: { hasServerToken: false, allowClientToken: true, owner: "", repo: "", branch: "main" },
      gitlab: { hasServerToken: false, allowClientToken: true },
    },
    settings: {
      apiKey: "",
      model: "",
      system: "You are MAX, a helpful, friendly and concise AI assistant. Use Markdown for formatting when helpful.",
      maxTokens: 4096,
      temperature: 1.0,
      autonomous: false,
      autoMaxSteps: 6,
      autoPush: false,
      provider: "github", // "github" | "gitlab"
      github: { token: "", owner: "", repo: "", branch: "main", pathPrefix: "max-chats" },
      gitlab: { token: "", branch: "main" },
      personas: [],
      lastRepo: null,
      confirmAutonomous: true,
      profiles: [],
      powers: { installed: [] },
    },
    conversations: [],
    activeId: null,
    attachments: [], // {id, media_type, dataUrl}
    streaming: false,
    abort: null,
    renameId: null,
    autoStop: false,
    autoRunning: false,
    basket: [], // staged repo files: {path, content}
    user: null, // signed-in user (when auth is enabled)
  };

  const githubDefaults = () => ({ token: "", owner: "", repo: "", branch: "main", pathPrefix: "max-chats" });

  /* ---------- persistence ---------- */
  function safeStorageSet(storage, key, value, label) {
    try {
      storage.setItem(key, value);
      return true;
    } catch {
      if (label) toast(`${label} could not be saved. Browser storage may be full.`, "error");
      return false;
    }
  }

  function loadState() {
    try {
      const conversations = JSON.parse(localStorage.getItem(LS.convos));
      state.conversations = Array.isArray(conversations) ? conversations : [];
    } catch { state.conversations = []; }
    try {
      const s = JSON.parse(localStorage.getItem(LS.settings));
      if (s && typeof s === "object") {
        // Migrate secrets saved by older versions out of persistent localStorage.
        if (typeof s.apiKey === "string" && s.apiKey) {
          safeStorageSet(sessionStorage, SESSION_KEY, s.apiKey);
          delete s.apiKey;
          safeStorageSet(localStorage, LS.settings, JSON.stringify(s));
        }
        if (s.github && typeof s.github.token === "string" && s.github.token) {
          safeStorageSet(sessionStorage, GH_SESSION_KEY, s.github.token);
          delete s.github.token;
          safeStorageSet(localStorage, LS.settings, JSON.stringify(s));
        }
        if (s.gitlab && typeof s.gitlab.token === "string" && s.gitlab.token) {
          safeStorageSet(sessionStorage, GL_SESSION_KEY, s.gitlab.token);
          delete s.gitlab.token;
          safeStorageSet(localStorage, LS.settings, JSON.stringify(s));
        }
        Object.assign(state.settings, s);
      }
      // Always keep provider objects well-formed (older saves may lack them).
      state.settings.github = Object.assign(githubDefaults(), state.settings.github || {});
      state.settings.gitlab = Object.assign({ token: "", branch: "main" }, state.settings.gitlab || {});
      if (!Array.isArray(state.settings.personas)) state.settings.personas = [];
      if (!state.settings.powers || !Array.isArray(state.settings.powers.installed)) state.settings.powers = { installed: [] };
      if (state.settings.provider !== "gitlab") state.settings.provider = "github";
      state.settings.apiKey = sessionStorage.getItem(SESSION_KEY) || "";
      state.settings.github.token = sessionStorage.getItem(GH_SESSION_KEY) || "";
      state.settings.gitlab.token = sessionStorage.getItem(GL_SESSION_KEY) || "";
    } catch {}
    state.activeId = localStorage.getItem(LS.active) || null;
  }
  const saveConvos = () => safeStorageSet(localStorage, LS.convos, JSON.stringify(state.conversations), "Conversation history");
  const saveSettings = () => {
    // Deep-clone, then strip the two session-only secrets before persisting.
    const persistent = JSON.parse(JSON.stringify(state.settings));
    const apiKey = persistent.apiKey; delete persistent.apiKey;
    const ghToken = persistent.github ? persistent.github.token : "";
    const glToken = persistent.gitlab ? persistent.gitlab.token : "";
    if (persistent.github) delete persistent.github.token;
    if (persistent.gitlab) delete persistent.gitlab.token;
    safeStorageSet(localStorage, LS.settings, JSON.stringify(persistent), "Settings");

    const putSession = (key, val) => {
      if (val) safeStorageSet(sessionStorage, key, val);
      else { try { sessionStorage.removeItem(key); } catch {} }
    };
    putSession(SESSION_KEY, apiKey);
    putSession(GH_SESSION_KEY, ghToken);
    putSession(GL_SESSION_KEY, glToken);
  };
  const saveActive = () => state.activeId
    ? safeStorageSet(localStorage, LS.active, state.activeId)
    : localStorage.removeItem(LS.active);

  /* ---------- conversation model ---------- */
  const activeConvo = () => state.conversations.find((c) => c.id === state.activeId) || null;

  function newConversation(makeActive = true) {
    const convo = { id: uid(), title: "New chat", messages: [], createdAt: Date.now(), updatedAt: Date.now() };
    state.conversations.unshift(convo);
    if (makeActive) { state.activeId = convo.id; saveActive(); }
    saveConvos();
    return convo;
  }

  function touchConvo(convo) {
    convo.updatedAt = Date.now();
    // keep most-recent first
    state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    saveConvos();
  }

  function autoTitle(convo) {
    if (convo.title !== "New chat") return;
    const firstUser = convo.messages.find((m) => m.role === "user");
    if (firstUser) {
      const t = firstUser.content.trim().replace(/\s+/g, " ").slice(0, 46);
      convo.title = t || "New chat";
    }
  }

  /* ============================================================
     Rendering — sidebar conversation list
     ============================================================ */
  function groupLabel(ts) {
    const now = new Date();
    const d = new Date(ts);
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const day = 86400000;
    if (ts >= startOfToday) return "Today";
    if (ts >= startOfToday - day) return "Yesterday";
    if (ts >= startOfToday - 7 * day) return "Previous 7 days";
    if (ts >= startOfToday - 30 * day) return "Previous 30 days";
    return "Older";
  }

  function renderConversations() {
    const list = $("#conversation-list");
    const q = $("#search-input").value.trim().toLowerCase();
    let convos = [...state.conversations].sort((a, b) =>
      (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || b.updatedAt - a.updatedAt);
    if (q) {
      convos = convos.filter((c) =>
        c.title.toLowerCase().includes(q) ||
        c.messages.some((m) => (m.content || "").toLowerCase().includes(q))
      );
    }

    if (convos.length === 0) {
      list.innerHTML = `<p class="empty-hint">${q ? "No matches." : "No conversations yet.\nStart a new chat!"}</p>`;
      return;
    }

    let html = "";
    let lastGroup = "";
    const anyPinned = convos.some((c) => c.pinned) && !q;
    let pinnedHeaderDone = false;
    for (const c of convos) {
      let g;
      if (anyPinned && c.pinned) { g = "Pinned"; }
      else { g = groupLabel(c.updatedAt); }
      if (g !== lastGroup) { html += `<div class="conv-group-label">${g}</div>`; lastGroup = g; }
      const active = c.id === state.activeId ? " active" : "";
      const pin = c.pinned ? `<svg class="conv__pin" viewBox="0 0 24 24"><path d="M12 2l2.4 7.4H22l-6 4.6 2.3 7.4-6.3-4.6L5.7 21 8 14 2 9.4h7.6z"/></svg>` : "";
      const repoTag = c.repo && c.repo.fullName ? `<span class="conv__repo" title="${esc(c.repo.fullName)}">${esc(c.repo.name || c.repo.fullName)}</span>` : "";
      html += `
        <div class="conv${active}" data-id="${c.id}" role="button" tabindex="0">
          ${pin}
          <span class="conv__title">${esc(c.title)}</span>
          ${repoTag}
          <button class="conv__menu" data-menu="${c.id}" title="Options" aria-label="Conversation options">
            <svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>
          </button>
        </div>`;
    }
    list.innerHTML = html;
  }

  /* ============================================================
     Markdown + code rendering
     ============================================================ */
  let markedReady = false;
  function setupMarked() {
    if (markedReady || !window.marked) return;
    marked.setOptions({ breaks: true, gfm: true });
    markedReady = true;
  }

  function renderMarkdown(text) {
    setupMarked();
    const plain = `<p>${esc(text || "").replace(/\n/g, "<br>")}</p>`;
    // Never render generated HTML without a sanitizer. If either CDN library is
    // unavailable, degrade safely to escaped plain text.
    if (!window.marked || !window.DOMPurify) return plain;
    try {
      return DOMPurify.sanitize(marked.parse(text || ""), {
        USE_PROFILES: { html: true },
      });
    } catch {
      return plain;
    }
  }

  // Enhance rendered markdown: wrap code blocks with header + copy, run highlight.
  function enhanceContent(container) {
    $$("pre code", container).forEach((code) => {
      if (code.closest(".code-block")) return;
      const pre = code.parentElement;
      const langMatch = [...code.classList].find((c) => c.startsWith("language-"));
      const lang = langMatch ? langMatch.replace("language-", "") : "";

      if (window.hljs) {
        try {
          if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code);
          else hljs.highlightElement(code);
        } catch {}
      }

      const wrap = document.createElement("div");
      wrap.className = "code-block";
      const head = document.createElement("div");
      head.className = "code-block__head";
      head.innerHTML = `<span class="code-block__lang">${esc(lang || "code")}</span>
        <button class="code-copy" type="button">
          <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>
          <span>Copy</span></button>`;
      pre.replaceWith(wrap);
      wrap.appendChild(head);
      wrap.appendChild(pre);

      head.querySelector(".code-copy").addEventListener("click", () => {
        copyText(code.innerText);
        const label = head.querySelector(".code-copy span");
        const prev = label.textContent; label.textContent = "Copied!";
        setTimeout(() => (label.textContent = prev), 1400);
      });
    });
    // open links in new tab safely
    $$("a", container).forEach((a) => { a.target = "_blank"; a.rel = "noopener noreferrer"; });
  }

  /* ============================================================
     Rendering — messages
     ============================================================ */
  const messagesEl = () => $("#messages");

  function showWelcome(show) {
    $("#welcome").style.display = show ? "" : "none";
  }

  function renderMessages() {
    const convo = activeConvo();
    const box = messagesEl();
    box.innerHTML = "";
    if (!convo || convo.messages.length === 0) {
      showWelcome(true);
      return;
    }
    showWelcome(false);
    convo.messages.forEach((m, i) => box.appendChild(renderMessage(m, i === convo.messages.length - 1)));
    scrollToBottom(true);
  }

  function avatarFor(role) {
    return role === "user" ? "You" : "M";
  }

  function renderMessage(m, isLast) {
    const row = document.createElement("div");
    row.className = `msg msg--${m.role}` + (isLast ? " msg--last" : "");
    row.dataset.id = m.id;

    if (m.auto) row.classList.add("msg--auto");
    const avatar = `<div class="msg__avatar">${m.auto ? "↻" : role_short(m.role)}</div>`;
    const roleName = m.auto ? "Auto-continue" : (m.role === "user" ? "You" : "MAX");

    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
    if (m.role === "assistant") {
      bubble.classList.add("md");
      const think = m.thinking
        ? `<details class="thinking-box"><summary>Thinking…</summary><div class="thinking-body">${esc(m.thinking)}</div></details>`
        : "";
      bubble.innerHTML = think + renderMarkdown(m.content);
      enhanceContent(bubble);
    } else {
      // user: show images + text (escaped, preserve newlines)
      let inner = "";
      if (m.images && m.images.length) {
        inner += `<div class="attachments" style="margin-bottom:8px">` +
          m.images.map((im) => `<div class="attachment"><img src="${im.dataUrl}" alt="attachment"></div>`).join("") +
          `</div>`;
      }
      inner += `<div>${esc(m.content).replace(/\n/g, "<br>")}</div>`;
      bubble.innerHTML = inner;
    }

    const body = document.createElement("div");
    body.className = "msg__body";
    body.innerHTML = `<div class="msg__role">${roleName}</div>`;
    body.appendChild(bubble);
    body.appendChild(buildActions(m));

    row.innerHTML = avatar;
    row.appendChild(body);
    return row;
  }

  function role_short(role) { return role === "user" ? "U" : "M"; }

  function buildActions(m) {
    const actions = document.createElement("div");
    actions.className = "msg__actions";

    const copyBtn = actionBtn("copy", `<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/>`, "Copy");
    copyBtn.addEventListener("click", () => { copyText(m.content); toast("Copied to clipboard", "success"); });
    actions.appendChild(copyBtn);

    const branchBtn = actionBtn("branch", `<circle cx="6" cy="6" r="2.5"/><circle cx="6" cy="18" r="2.5"/><circle cx="18" cy="8" r="2.5"/><path d="M6 8.5v7M6 15c0-5 4-6 9.5-6.6"/>`, "Branch");
    branchBtn.title = "Fork a new conversation from this point";
    branchBtn.addEventListener("click", () => branchFrom(m));
    actions.appendChild(branchBtn);

    if (m.role === "user") {
      const editBtn = actionBtn("edit", `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>`, "Edit");
      editBtn.addEventListener("click", () => beginEdit(m));
      actions.appendChild(editBtn);
    } else {
      const regenBtn = actionBtn("regen", `<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>`, "Regenerate");
      regenBtn.addEventListener("click", () => regenerate(m));
      actions.appendChild(regenBtn);

      const modelBtn = actionBtn("model", `<path d="M6 9l6 6 6-6"/>`, "Model");
      modelBtn.title = "Regenerate with a different model";
      modelBtn.addEventListener("click", (e) => regenModelMenu(m, e.currentTarget));
      actions.appendChild(modelBtn);

      const speakBtn = actionBtn("speak", `<path d="M11 5L6 9H2v6h4l5 4V5z"/><path d="M15.5 8.5a5 5 0 010 7"/>`, "Speak");
      speakBtn.addEventListener("click", () => speak(m.content));
      actions.appendChild(speakBtn);

      const edits = parseEdits(m.content);
      if (edits.length && activeRepo()) {
        const reviewBtn = actionBtn("review", `<path d="M20 6L9 17l-5-5"/>`, `Review ${edits.length} change${edits.length > 1 ? "s" : ""}`);
        reviewBtn.classList.add("msg-action--accent");
        reviewBtn.addEventListener("click", () => openDiffModal(edits));
        actions.appendChild(reviewBtn);
      }

      if (m.usage) {
        const u = document.createElement("span");
        u.className = "msg__usage";
        const modelTag = m.model ? `${m.model} · ` : "";
        u.textContent = `${modelTag}${m.usage.input_tokens ?? "?"} in · ${m.usage.output_tokens ?? "?"} out`;
        actions.appendChild(u);
      }
    }
    return actions;
  }

  function actionBtn(kind, svgInner, label) {
    const b = document.createElement("button");
    b.className = "msg-action";
    b.type = "button";
    b.innerHTML = `<svg viewBox="0 0 24 24">${svgInner}</svg><span>${label}</span>`;
    return b;
  }

  /* ---------- streaming assistant bubble handle ---------- */
  function appendStreamingAssistant() {
    showWelcome(false);
    const row = document.createElement("div");
    row.className = "msg msg--assistant msg--last";
    row.innerHTML = `<div class="msg__avatar">M</div>
      <div class="msg__body">
        <div class="msg__role">MAX</div>
        <div class="msg__bubble md"><div class="typing"><span></span><span></span><span></span></div></div>
      </div>`;
    messagesEl().appendChild(row);
    scrollToBottom(true);
    const bubble = row.querySelector(".msg__bubble");
    return {
      row,
      bubble,
      setText(text, withCursor, thinking) {
        const think = thinking
          ? `<details class="thinking-box" open><summary>Thinking…</summary><div class="thinking-body">${esc(thinking)}</div></details>`
          : "";
        this.bubble.innerHTML = think + renderMarkdown(text) + (withCursor ? '<span class="cursor-blink"></span>' : "");
        enhanceContent(this.bubble);
      },
    };
  }

  /* ---------- robust SSE framing ---------- */
  function takeSseRecords(input, flush = false) {
    const records = [];
    let rest = input;
    let boundary;

    while ((boundary = /\r?\n\r?\n/.exec(rest))) {
      const block = rest.slice(0, boundary.index);
      rest = rest.slice(boundary.index + boundary[0].length);
      const record = parseSseRecord(block);
      if (record) records.push(record);
    }

    if (flush && rest.trim()) {
      const record = parseSseRecord(rest);
      if (record) records.push(record);
      rest = "";
    }
    return { records, rest };
  }

  function parseSseRecord(block) {
    let event = "message";
    const data = [];
    for (const line of block.split(/\r?\n/)) {
      if (!line || line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? "" : line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") event = value;
      if (field === "data") data.push(value);
    }
    return data.length ? { event, data: data.join("\n") } : null;
  }

  /* ============================================================
     Sending / streaming
     ============================================================ */
  function buildApiMessages(convo) {
    return convo.messages.map((m) => {
      if (m.role === "user" && m.images && m.images.length) {
        const content = [];
        for (const im of m.images) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: im.media_type, data: im.dataUrl.split(",")[1] },
          });
        }
        if (m.content) content.push({ type: "text", text: m.content });
        return { role: "user", content };
      }
      return { role: m.role, content: m.content };
    });
  }

  function currentModel() {
    return state.settings.model || state.config.defaultModel;
  }

  // System prompt actually sent — augmented with agent instructions in autonomous mode.
  function effectiveSystem() {
    let sys = state.settings.system || "";
    const repo = activeRepo();
    if (repo) {
      sys += `\n\n[Working repository] The user has selected the ${repo.provider} repository ${repo.fullName} (branch ${repo.branch || "main"}). When they refer to "the repo", "this project", or "the codebase", assume they mean ${repo.fullName}.`;
      sys += `\n\n[Editing files] When you want to change or create files, output each file as a fenced code block whose opening fence includes a path attribute, exactly like:\n\`\`\`js path=src/example.js\n<the COMPLETE new contents of the file>\n\`\`\`\nAlways include the full file content (not a diff), one block per file. MAX shows the user a diff and lets them commit these to a branch and open a pull request. Only use this format for real file changes.`;
    }
    sys += powersSystemNote();
    if (state.settings.autonomous) {
      sys += `\n\n[Autonomous mode] Work through the user's request across multiple steps on your own initiative. Make reasonable assumptions instead of asking clarifying questions. After finishing each step you will be prompted to continue. When the ENTIRE task is fully complete, end your final message with the exact marker ${DONE_MARKER} on its own line.`;
    }
    return sys.trim() || undefined;
  }

  // Intercept slash commands typed with an argument (e.g. "/fetch https://…").
  function handleSlashSend(text) {
    const m = text.match(/^\/(\w+)(?:\s+([\s\S]+))?$/);
    if (!m) return false;
    const cmd = "/" + m[1].toLowerCase();
    const arg = (m[2] || "").trim();
    if (cmd === "/fetch") { $("#input").value = ""; updateCharCount(); updateSendState(); runFetchCommand(arg); return true; }
    if (cmd === "/search") { $("#input").value = ""; updateCharCount(); updateSendState(); runSearchCommand(arg); return true; }
    const all = SLASH.concat(powerSlashCommands());
    const found = all.find((s) => s.cmd === cmd);
    if (found && !arg) { $("#input").value = ""; updateCharCount(); updateSendState(); found.run(); return true; }
    return false;
  }

  async function sendMessage(text) {
    if (state.streaming) return;
    text = text.trim();
    if (text && handleSlashSend(text)) return;
    const imgs = state.attachments.slice();
    const staged = state.basket.slice();
    if (!text && imgs.length === 0 && !staged.length) return;

    let convo = activeConvo();
    if (!convo) convo = newConversation();

    const fullText = (basketPrefix() + text).trim();
    if (staged.length) clearBasket();

    const userMsg = {
      id: uid(), role: "user", content: fullText,
      images: imgs.map((a) => ({ media_type: a.media_type, dataUrl: a.dataUrl })),
    };
    convo.messages.push(userMsg);
    autoTitle(convo);
    touchConvo(convo);

    // reset composer
    clearAttachments();
    const input = $("#input");
    input.value = ""; autoResize(input); updateCharCount(); updateSendState();

    renderMessages();
    renderConversations();

    if (state.settings.autonomous) await runAutonomousLoop(convo);
    else await streamAssistant(convo);
  }

  /* ---------- autonomous multi-step loop ---------- */
  function clampSteps(n) { return Math.max(2, Math.min(15, parseInt(n, 10) || 6)); }

  async function runAutonomousLoop(convo) {
    const max = clampSteps(state.settings.autoMaxSteps);
    // Cost guardrail: warn before a potentially expensive multi-step run.
    if (state.settings.confirmAutonomous !== false) {
      const p = priceFor(currentModel());
      const estMax = ((state.settings.maxTokens / 1e6) * p.out * max).toFixed(2);
      if (!confirm(`Autonomous mode will run up to ${max} steps on its own and may use significant tokens (rough worst case ~$${estMax}). Continue?`)) {
        toast("Autonomous run cancelled");
        return;
      }
    }
    state.autoStop = false;
    state.autoRunning = true;
    updateAutoPill();

    try {
      for (let step = 1; step <= max; step++) {
        setAutoPillStep(step, max);
        await streamAssistant(convo);

        const last = convo.messages[convo.messages.length - 1];
        // Stop the loop on: user stop, an error/aborted turn, or the done marker.
        if (state.autoStop) break;
        if (!last || last.role !== "assistant" || last.stopped) break;

        if (last.content.includes(DONE_MARKER)) {
          last.content = last.content.replace(/\s*\[\[MAX_DONE\]\]\s*/g, "").trim();
          saveConvos();
          renderMessages();
          if (state.settings.autoPush && activeRepo()) {
            toast("Autonomous run complete — pushing to your repo…");
            pushConversation(convo.id);
          }
          break;
        }
        if (step < max) {
          convo.messages.push({
            id: uid(), role: "user", auto: true,
            content: `Continue. If the task is fully complete, end your reply with ${DONE_MARKER}.`,
          });
          touchConvo(convo);
          renderMessages();
        }
      }
    } finally {
      state.autoRunning = false;
      updateAutoPill();
      toggleStreamingUI(false); // restore composer after the last step
    }
  }

  async function streamAssistant(convo, opts = {}) {
    state.streaming = true;
    toggleStreamingUI(true);

    const stream = appendStreamingAssistant();
    let acc = "";
    let thinking = "";
    let usage = null;
    let gotFirst = false;
    const useModel = opts.model || currentModel();
    const startedAt = Date.now();

    state.abort = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: state.abort.signal,
        body: JSON.stringify({
          model: useModel,
          system: effectiveSystem(),
          max_tokens: state.settings.maxTokens,
          temperature: state.settings.temperature,
          apiKey: state.settings.apiKey || undefined,
          stream: true,
          messages: buildApiMessages(convo),
        }),
      });

      if (!res.ok || !res.body) {
        let msg = `Request failed (HTTP ${res.status})`;
        try { const j = await res.json(); msg = j?.error?.message || msg; } catch {}
        throw new Error(msg);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let stopped = false;

      const consumeRecord = (record) => {
        if (!record?.data) return false;
        if (record.data.trim() === "[DONE]") return true;

        let evt;
        try { evt = JSON.parse(record.data); } catch { return false; }
        if (record.event === "error" || evt.type === "error") {
          throw new Error(evt.error?.message || evt.message || "Stream error");
        }

        switch (evt.type) {
          case "message_start":
            if (evt.message?.usage) usage = { ...evt.message.usage };
            break;
          case "content_block_delta":
            if (evt.delta?.type === "text_delta" && evt.delta.text) {
              gotFirst = true;
              acc += evt.delta.text;
              stream.setText(acc, true, thinking);
              scrollToBottomIfNear();
            } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
              thinking += evt.delta.thinking;
              stream.setText(acc, true, thinking);
              scrollToBottomIfNear();
            }
            break;
          case "message_delta":
            if (evt.usage) usage = { ...(usage || {}), ...evt.usage };
            break;
          case "message_stop":
            return true;
          default:
            break;
        }
        return false;
      };

      while (!stopped) {
        const { done, value } = await reader.read();
        if (done) {
          buffer += decoder.decode();
          const final = takeSseRecords(buffer, true);
          for (const record of final.records) {
            if (consumeRecord(record)) break;
          }
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const parsed = takeSseRecords(buffer);
        buffer = parsed.rest;
        for (const record of parsed.records) {
          if (consumeRecord(record)) {
            stopped = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }

      if (!gotFirst || !acc.trim()) {
        throw new Error("The model returned an empty response. Try another model or prompt.");
      }

      // finalize
      stream.setText(acc, false, thinking);
      const aiMsg = { id: uid(), role: "assistant", content: acc, usage, model: useModel, thinking: thinking || undefined };
      convo.messages.push(aiMsg);
      touchConvo(convo);
      renderMessages();
      renderConversations();
      updateUsagePill();
      logRequest({ model: useModel, ok: true, ms: Date.now() - startedAt, tokens: usage?.output_tokens });
    } catch (err) {
      const aborted = err.name === "AbortError" || state.abort?.signal.aborted;
      if (aborted && acc) {
        // keep whatever we streamed so far
        stream.setText(acc, false);
        convo.messages.push({ id: uid(), role: "assistant", content: acc, usage, stopped: true });
        touchConvo(convo);
        renderMessages();
      } else if (aborted) {
        stream.row.remove();
        renderMessages();
      } else {
        const isNetwork = err instanceof TypeError || /failed to fetch|networkerror|load failed|connection/i.test(err.message || "");
        const friendly = isNetwork
          ? "Can't reach the MAX server. Make sure it's still running (node server.js) in your terminal, then reload this page and try again."
          : err.message;
        logRequest({ model: useModel, ok: false, status: "error", ms: Date.now() - startedAt });
        stream.bubble.classList.remove("md");
        stream.bubble.innerHTML = `<div style="color:#ff6b8a">⚠ ${esc(friendly)}</div>`;
        const retry = document.createElement("button");
        retry.className = "btn btn--ghost"; retry.style.marginTop = "10px"; retry.textContent = "Retry";
        retry.addEventListener("click", () => { stream.row.remove(); streamAssistant(convo, opts); });
        stream.bubble.appendChild(retry);
        toast(friendly, "error");
      }
    } finally {
      state.streaming = false;
      state.abort = null;
      toggleStreamingUI(false);
    }
  }

  function stopStreaming() {
    state.autoStop = true; // also halts the autonomous loop between steps
    if (state.abort) state.abort.abort();
  }

  /* ---------- autonomous pill UI ---------- */
  function updateAutoPill() {
    const pill = $("#auto-toggle");
    const label = $("#auto-pill-label");
    if (!pill) return;
    const on = !!state.settings.autonomous;
    pill.classList.toggle("on", on);
    pill.classList.toggle("running", state.autoRunning);
    pill.setAttribute("aria-pressed", String(on));
    if (!state.autoRunning) label.textContent = on ? "Auto: On" : "Auto: Off";
  }
  function setAutoPillStep(step, max) {
    const label = $("#auto-pill-label");
    if (label) label.textContent = `Auto · ${step}/${max}`;
    $("#auto-toggle")?.classList.add("running");
  }

  async function regenerate(aiMsg, modelOverride) {
    if (state.streaming) return;
    const convo = activeConvo();
    if (!convo) return;
    const idx = convo.messages.findIndex((m) => m.id === aiMsg.id);
    if (idx === -1) return;
    // remove this assistant message (and anything after it)
    convo.messages.splice(idx);
    touchConvo(convo);
    renderMessages();
    await streamAssistant(convo, modelOverride ? { model: modelOverride } : {});
  }

  // Small menu to regenerate the last answer with a different model.
  function regenModelMenu(aiMsg, anchorBtn) {
    $$(".conv-pop").forEach((p) => p.remove());
    const pop = document.createElement("div");
    pop.className = "conv-pop";
    Object.assign(pop.style, {
      position: "fixed", zIndex: 60, background: "var(--surface-solid)",
      border: "1px solid var(--border-strong)", borderRadius: "10px",
      boxShadow: "var(--shadow)", padding: "5px", minWidth: "200px", fontSize: "13.5px", maxHeight: "260px", overflowY: "auto",
    });
    pop.innerHTML = `<div style="padding:6px 10px;color:var(--text-faint);font-size:11px;text-transform:uppercase;letter-spacing:.5px">Regenerate with</div>` +
      state.config.models.map((m) =>
        `<button data-m="${esc(m.id)}" style="display:block;width:100%;padding:8px 10px;background:none;border:none;color:var(--text);border-radius:7px;text-align:left">${esc(m.label || m.id)}</button>`).join("");
    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 270)}px`;
    pop.style.left = `${Math.min(r.left, window.innerWidth - 220)}px`;
    pop.querySelectorAll("button[data-m]").forEach((b) => {
      b.addEventListener("mouseenter", () => (b.style.background = "var(--surface-2)"));
      b.addEventListener("mouseleave", () => (b.style.background = "none"));
      b.addEventListener("click", () => { pop.remove(); regenerate(aiMsg, b.dataset.m); });
    });
    setTimeout(() => {
      const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("click", close); } };
      document.addEventListener("click", close);
    }, 0);
  }

  function beginEdit(userMsg) {
    if (state.streaming) return;
    const row = $(`.msg[data-id="${userMsg.id}"]`);
    if (!row) return;
    const bubble = row.querySelector(".msg__bubble");
    const box = document.createElement("div");
    box.className = "edit-box";
    box.innerHTML = `<textarea>${esc(userMsg.content)}</textarea>
      <div class="edit-box__actions">
        <button class="btn btn--ghost" data-act="cancel">Cancel</button>
        <button class="btn btn--primary" data-act="save">Save &amp; submit</button>
      </div>`;
    bubble.replaceWith(box);
    const ta = box.querySelector("textarea");
    ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length);
    box.querySelector('[data-act="cancel"]').addEventListener("click", () => renderMessages());
    box.querySelector('[data-act="save"]').addEventListener("click", async () => {
      const newText = ta.value.trim();
      if (!newText) return;
      const convo = activeConvo();
      const idx = convo.messages.findIndex((m) => m.id === userMsg.id);
      if (idx === -1) return;
      convo.messages[idx].content = newText;
      convo.messages.splice(idx + 1); // drop subsequent messages
      autoTitle(convo);
      touchConvo(convo);
      renderMessages();
      await streamAssistant(convo);
    });
  }

  /* ============================================================
     Composer helpers
     ============================================================ */
  function autoResize(ta) {
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  }
  function updateCharCount() {
    $("#char-count").textContent = $("#input").value.length;
  }
  function updateSendState() {
    const hasText = $("#input").value.trim().length > 0 || state.attachments.length > 0;
    $("#send-btn").disabled = !hasText || state.streaming || state.autoRunning;
  }
  function toggleStreamingUI(on) {
    const active = on || state.autoRunning;
    $("#stop-btn").hidden = !active;
    $("#send-btn").hidden = active;
    updateSendState();
  }

  /* ---------- attachments ---------- */
  function renderAttachments() {
    const box = $("#attachments");
    box.innerHTML = state.attachments.map((a) =>
      `<div class="attachment" data-id="${a.id}">
        <img src="${a.dataUrl}" alt="attachment">
        <button class="attachment__remove" data-remove="${a.id}" title="Remove">×</button>
      </div>`).join("");
    updateSendState();
  }
  function clearAttachments() { state.attachments = []; renderAttachments(); }

  function handleFiles(files) {
    for (const file of files) {
      if (!ALLOWED_IMAGE_TYPES.has(file.type)) {
        toast("Use a JPEG, PNG, GIF, or WebP image.", "error");
        continue;
      }
      if (file.size > 5 * 1024 * 1024) { toast("Image too large (max 5MB)", "error"); continue; }
      const reader = new FileReader();
      reader.onload = () => {
        state.attachments.push({ id: uid(), media_type: file.type, dataUrl: reader.result });
        renderAttachments();
      };
      reader.readAsDataURL(file);
    }
  }

  /* ============================================================
     Scrolling
     ============================================================ */
  function nearBottom() {
    const el = $("#chat");
    return el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  }
  function scrollToBottom(force) {
    const el = $("#chat");
    if (force || nearBottom()) el.scrollTop = el.scrollHeight;
  }
  function scrollToBottomIfNear() { if (nearBottom()) scrollToBottom(true); }

  function updateScrollBtn() {
    $("#scroll-bottom").classList.toggle("show", !nearBottom());
  }

  /* ============================================================
     Clipboard + toasts
     ============================================================ */
  async function copyText(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
    }
  }

  function toast(message, kind = "") {
    const host = $("#toast-host");
    const el = document.createElement("div");
    el.className = "toast" + (kind ? ` toast--${kind}` : "");
    el.textContent = message;
    host.appendChild(el);
    setTimeout(() => {
      el.classList.add("hide");
      setTimeout(() => el.remove(), 260);
    }, 3200);
  }

  /* ============================================================
     Export + GitHub
     ============================================================ */
  function slugify(s) {
    return String(s || "chat").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "chat";
  }

  function conversationToMarkdown(convo) {
    const when = new Date(convo.updatedAt || Date.now()).toISOString();
    const lines = [
      `# ${convo.title || "Conversation"}`,
      "",
      `> Exported from MAX on ${when}`,
      `> Model: ${currentModel()}`,
      "",
      "---",
      "",
    ];
    for (const m of convo.messages) {
      if (m.role !== "user" && m.role !== "assistant") continue;
      const who = m.auto ? "Auto-continue" : (m.role === "user" ? "You" : "MAX");
      lines.push(`## ${who}`, "");
      if (m.images && m.images.length) lines.push(`_(${m.images.length} image attachment${m.images.length > 1 ? "s" : ""})_`, "");
      lines.push((m.content || "").trim(), "");
    }
    return lines.join("\n").trim() + "\n";
  }

  function download(filename, text, mime = "text/plain") {
    const blob = new Blob([text], { type: mime + ";charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function exportConversation(id, format) {
    const convo = state.conversations.find((c) => c.id === id) || activeConvo();
    if (!convo || !convo.messages.length) { toast("Nothing to export yet.", "error"); return; }
    const base = `${slugify(convo.title)}-${convo.id}`;
    if (format === "json") download(`${base}.json`, JSON.stringify(convo, null, 2), "application/json");
    else download(`${base}.md`, conversationToMarkdown(convo), "text/markdown");
    toast(`Exported as ${format === "json" ? "JSON" : "Markdown"}`, "success");
  }

  async function pushConversationToGitHub(id) { return pushConversation(id); }

  // Provider-aware push: sends the chat as a Markdown file to the selected repo.
  async function pushConversation(id) {
    const convo = state.conversations.find((c) => c.id === id) || activeConvo();
    if (!convo || !convo.messages.length) { toast("Nothing to push yet.", "error"); return; }
    const repo = convo.repo && convo.repo.fullName ? convo.repo : activeRepo();
    if (!repo || !repo.fullName) {
      toast("Pick a repository first (the chip beside the message box).", "error");
      openRepoPicker($("#repo-chip"));
      return false;
    }
    if (!providerHasToken(repo.provider)) {
      toast(`Connect ${repo.provider === "gitlab" ? "GitLab" : "GitHub"} first in Settings.`, "error");
      openSettings();
      return false;
    }
    const prefix = (state.settings.github.pathPrefix || "max-chats").replace(/^\/+|\/+$/g, "");
    const path = `${prefix ? prefix + "/" : ""}${slugify(convo.title)}-${convo.id}.md`;
    const body = {
      token: providerToken(repo.provider) || undefined,
      branch: repo.branch || undefined,
      path,
      message: `${convo.title || "Chat"} — via MAX`,
      content: conversationToMarkdown(convo),
    };
    if (repo.provider === "gitlab") body.projectId = repo.projectId ?? repo.fullName;
    else { body.owner = repo.owner; body.repo = repo.name; }

    toast(`Pushing to ${repo.fullName}…`);
    try {
      const res = await fetch(`/api/${repo.provider}/push`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `Push failed (HTTP ${res.status})`);
      toast(data.message || "Pushed ✓", "success");
      if (data.htmlUrl) toastLink("View file", data.htmlUrl);
      return true;
    } catch (err) {
      toast(err instanceof TypeError ? "Can't reach the MAX server (is it running?)." : err.message, "error");
      return false;
    }
  }

  async function testGithubConnection(btn) {
    const g = readGithubFields();
    setBtnBusy(btn, true);
    const out = $("#gh-test-result");
    out.textContent = "Checking…"; out.style.color = "";
    try {
      const res = await fetch("/api/github/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: g.token || undefined, owner: g.owner, repo: g.repo, branch: g.branch }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      out.textContent = "✓ " + (data.message || "Connected.");
      out.style.color = data.canPush ? "#34d399" : "#fbbf24";
    } catch (err) {
      out.textContent = "✗ " + (err instanceof TypeError ? "Can't reach the MAX server." : err.message);
      out.style.color = "#ff6b8a";
    } finally {
      setBtnBusy(btn, false);
    }
  }

  async function testAiConnection(btn) {
    const g = $("#gh-test-result");
    setBtnBusy(btn, true);
    g.textContent = "Pinging the AI provider…"; g.style.color = "";
    try {
      const res = await fetch("/api/test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          apiKey: ($("#set-apikey").value.trim()) || state.settings.apiKey || undefined,
          model: $("#set-model-custom").value.trim() || $("#set-model").value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      g.textContent = "✓ " + (data.message || "AI provider reachable.");
      g.style.color = "#34d399";
    } catch (err) {
      g.textContent = "✗ " + (err instanceof TypeError ? "Can't reach the MAX server." : err.message);
      g.style.color = "#ff6b8a";
    } finally {
      setBtnBusy(btn, false);
    }
  }

  async function testGitlabConnection(btn) {
    setBtnBusy(btn, true);
    const out = $("#gl-test-result");
    out.textContent = "Checking…"; out.style.color = "";
    try {
      const res = await fetch("/api/gitlab/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: $("#set-gltoken").value.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      out.textContent = "✓ " + (data.message || "Connected.");
      out.style.color = "#34d399";
    } catch (err) {
      out.textContent = "✗ " + (err instanceof TypeError ? "Can't reach the MAX server." : err.message);
      out.style.color = "#ff6b8a";
    } finally { setBtnBusy(btn, false); }
  }

  function readGithubFields() {
    return {
      token: $("#set-ghtoken").value.trim(),
      owner: $("#set-ghowner").value.trim(),
      repo: $("#set-ghrepo").value.trim(),
      branch: $("#set-ghbranch").value.trim() || "main",
    };
  }

  function setBtnBusy(btn, busy) {
    if (!btn) return;
    btn.disabled = busy;
    btn.style.opacity = busy ? ".6" : "";
  }

  function toastLink(text, url) {
    const host = $("#toast-host");
    const el = document.createElement("div");
    el.className = "toast toast--success";
    const a = document.createElement("a");
    a.href = url; a.target = "_blank"; a.rel = "noopener noreferrer";
    a.textContent = text; a.style.color = "var(--accent-2)"; a.style.textDecoration = "underline";
    el.appendChild(a);
    host.appendChild(el);
    setTimeout(() => { el.classList.add("hide"); setTimeout(() => el.remove(), 260); }, 6000);
  }

  /* ============================================================
     Repository picker + file reading (GitHub & GitLab)
     ============================================================ */
  function providerToken(provider) {
    return provider === "gitlab" ? state.settings.gitlab.token : state.settings.github.token;
  }
  function providerHasToken(provider) {
    if (provider === "gitlab") return Boolean(state.settings.gitlab.token || state.config.gitlab?.hasServerToken);
    return Boolean(state.settings.github.token || state.config.github?.hasServerToken);
  }

  // The repo MAX is working in: bound to the active conversation, else the last one used.
  function activeRepo() {
    const c = activeConvo();
    if (c && c.repo && c.repo.fullName) return c.repo;
    return state.settings.lastRepo && state.settings.lastRepo.fullName ? state.settings.lastRepo : null;
  }
  function selectedRepoLabel() {
    const r = activeRepo();
    return r ? r.fullName : "";
  }

  function updateRepoChip() {
    const r = activeRepo();
    const chip = $("#repo-chip");
    const lbl = $("#repo-chip-label");
    const clear = $("#repo-chip-clear");
    const filesBtn = $("#files-btn");
    if (!chip) return;
    if (r) {
      lbl.textContent = r.fullName;
      chip.classList.add("selected");
      chip.title = `MAX is working in ${r.fullName} (${r.provider}, branch ${r.branch || "main"})`;
      clear.hidden = false;
      if (filesBtn) filesBtn.hidden = false;
    } else {
      lbl.textContent = "Add repository";
      chip.classList.remove("selected");
      chip.title = "Choose a repository for MAX to work in";
      clear.hidden = true;
      if (filesBtn) filesBtn.hidden = true;
    }
  }

  function selectRepo(repo, provider) {
    const bind = {
      provider,
      fullName: repo.fullName,
      owner: repo.owner || "",
      name: repo.name || "",
      projectId: repo.id ?? null,
      branch: repo.defaultBranch || "main",
    };
    let c = activeConvo();
    if (!c) { c = newConversation(); }
    c.repo = bind;
    touchConvo(c);
    state.settings.lastRepo = bind;
    if (provider === "github") {
      state.settings.github.owner = repo.owner;
      state.settings.github.repo = repo.name;
      state.settings.github.branch = bind.branch;
    }
    saveSettings();
    updateRepoChip();
    renderConversations();
    treeCache = null; // invalidate cached file tree
    toast(`MAX is now working in ${repo.fullName}`, "success");
  }

  function clearRepo() {
    const c = activeConvo();
    if (c) { delete c.repo; touchConvo(c); }
    state.settings.lastRepo = null;
    saveSettings();
    updateRepoChip();
    treeCache = null;
    toast("Repository cleared");
  }

  async function providerFetch(path, extra) {
    const r = activeRepo();
    const body = { token: providerToken(r.provider) || undefined, branch: r.branch, ...extra };
    if (r.provider === "gitlab") body.projectId = r.projectId ?? r.fullName;
    else { body.owner = r.owner; body.repo = r.name; }
    const res = await fetch(`/api/${r.provider}/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data;
  }

  async function fetchRepos(provider, q) {
    const res = await fetch(`/api/${provider}/repos`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: providerToken(provider) || undefined, q: q || undefined }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
    return data.repos || [];
  }

  let repoPickerEl = null;
  function closeRepoPicker() { if (repoPickerEl) { repoPickerEl.remove(); repoPickerEl = null; } }

  function openRepoPicker(anchorBtn) {
    closeRepoPicker();
    let provider = state.settings.provider || "github";
    const pop = document.createElement("div");
    pop.className = "repo-pop";
    pop.setAttribute("role", "dialog");
    pop.innerHTML = `
      <div class="repo-pop__head">
        <div class="repo-pop__title">Add repository</div>
        <div class="repo-pop__tabs">
          <button class="repo-tab" data-tab="github" type="button">GitHub</button>
          <button class="repo-tab" data-tab="gitlab" type="button">GitLab</button>
        </div>
      </div>
      <div class="repo-pop__search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" id="repo-search" placeholder="Search" autocomplete="off" spellcheck="false" />
      </div>
      <div class="repo-pop__list" id="repo-list"></div>
      <div class="repo-pop__foot">
        <button class="repo-pop__manage" id="repo-manage" type="button">
          <svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/></svg>
          Manage source control connection
        </button>
      </div>`;
    document.body.appendChild(pop);
    repoPickerEl = pop;

    const r = anchorBtn.getBoundingClientRect();
    pop.style.left = `${Math.max(12, Math.min(r.left, window.innerWidth - pop.offsetWidth - 12))}px`;
    pop.style.bottom = `${Math.max(12, window.innerHeight - r.top + 8)}px`;

    const listEl = pop.querySelector("#repo-list");
    const searchEl = pop.querySelector("#repo-search");
    let debounce;

    const activateTab = (p) => {
      provider = p;
      state.settings.provider = p; saveSettings();
      pop.querySelectorAll(".repo-tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === p));
      searchEl.value = "";
      if (!providerHasToken(p)) {
        searchEl.disabled = true;
        listEl.innerHTML = `<div class="repo-pop__msg">Connect ${p === "gitlab" ? "GitLab" : "GitHub"} first — add a token in Settings.</div>`;
      } else {
        searchEl.disabled = false;
        loadRepoList(listEl, provider, "");
        setTimeout(() => searchEl.focus(), 20);
      }
    };

    pop.querySelectorAll(".repo-tab").forEach((t) => t.addEventListener("click", () => activateTab(t.dataset.tab)));
    pop.querySelector("#repo-manage").addEventListener("click", () => { closeRepoPicker(); openSettings(); });
    searchEl.addEventListener("input", () => {
      clearTimeout(debounce);
      debounce = setTimeout(() => loadRepoList(listEl, provider, searchEl.value.trim()), 250);
    });
    activateTab(provider);

    setTimeout(() => {
      const onDoc = (e) => {
        if (repoPickerEl && !repoPickerEl.contains(e.target) && !anchorBtn.contains(e.target)) {
          closeRepoPicker(); document.removeEventListener("mousedown", onDoc);
        }
      };
      document.addEventListener("mousedown", onDoc);
    }, 0);
  }

  async function loadRepoList(listEl, provider, q) {
    listEl.innerHTML = `<div class="repo-spinner"></div>`;
    try {
      const repos = await fetchRepos(provider, q);
      if (!repos.length) {
        listEl.innerHTML = `<div class="repo-pop__msg">${q ? "No matching repositories." : "No repositories found for this token."}</div>`;
        return;
      }
      const current = selectedRepoLabel();
      const lock = `<svg class="repo-item__ico" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>`;
      const open = `<svg class="repo-item__ico" viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>`;
      const check = `<svg class="repo-item__check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>`;
      listEl.innerHTML = repos.map((x, i) => `
        <button class="repo-item${x.fullName === current ? " active" : ""}" type="button" data-i="${i}">
          ${x.private ? lock : open}
          <span class="repo-item__name">${esc(x.fullName)}</span>
          ${x.fullName === current ? check : ""}
        </button>`).join("");
      listEl.querySelectorAll(".repo-item").forEach((btn) => {
        btn.addEventListener("click", () => {
          const repo = repos[parseInt(btn.dataset.i, 10)];
          if (repo) { selectRepo(repo, provider); closeRepoPicker(); }
        });
      });
    } catch (err) {
      listEl.innerHTML = `<div class="repo-pop__msg">✗ ${esc(err instanceof TypeError ? "Can't reach the MAX server." : err.message)}</div>`;
    }
  }

  /* ---------- file browser + @file mentions ---------- */
  let treeCache = null; // { fullName, files: [{path,size}] }

  async function getTree() {
    const r = activeRepo();
    if (!r) return [];
    if (treeCache && treeCache.fullName === r.fullName) return treeCache.files;
    const data = await providerFetch("tree", {});
    treeCache = { fullName: r.fullName, files: data.files || [] };
    return treeCache.files;
  }

  async function insertFileIntoChat(path) {
    const r = activeRepo();
    if (!r) return;
    toast(`Loading ${path}…`);
    try {
      const data = await providerFetch("file", { path });
      const input = $("#input");
      const lang = (path.split(".").pop() || "").toLowerCase();
      const block = `\n\nFile \`${path}\` from ${r.fullName}:\n\`\`\`${lang}\n${data.content}\n\`\`\`\n`;
      input.value = (input.value + block).trimStart();
      autoResize(input); updateCharCount(); updateSendState(); input.focus();
      toast(`Inserted ${path} (${Math.round((data.size || data.content.length) / 1024) || 1} KB)`, "success");
    } catch (err) {
      toast(err instanceof TypeError ? "Can't reach the MAX server." : err.message, "error");
    }
  }

  let filesPickerEl = null;
  function closeFilesPicker() { if (filesPickerEl) { filesPickerEl.remove(); filesPickerEl = null; } }

  async function openFilesPicker(anchorBtn) {
    closeFilesPicker();
    const r = activeRepo();
    if (!r) { toast("Pick a repository first.", "error"); return; }
    const pop = document.createElement("div");
    pop.className = "repo-pop";
    pop.innerHTML = `
      <div class="repo-pop__head"><div class="repo-pop__title">Files · ${esc(r.fullName)}</div></div>
      <div class="repo-pop__search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" id="file-search" placeholder="Filter files" autocomplete="off" spellcheck="false" />
      </div>
      <div class="repo-pop__list" id="file-list"><div class="repo-spinner"></div></div>`;
    document.body.appendChild(pop);
    filesPickerEl = pop;
    const rect = anchorBtn.getBoundingClientRect();
    pop.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - pop.offsetWidth - 12))}px`;
    pop.style.bottom = `${Math.max(12, window.innerHeight - rect.top + 8)}px`;

    const listEl = pop.querySelector("#file-list");
    const searchEl = pop.querySelector("#file-search");
    let files = [];
    const render = (q) => {
      const ql = q.toLowerCase();
      const shown = (ql ? files.filter((f) => f.path.toLowerCase().includes(ql)) : files).slice(0, 300);
      if (!shown.length) { listEl.innerHTML = `<div class="repo-pop__msg">No files.</div>`; return; }
      const fileIco = `<svg class="repo-item__ico" viewBox="0 0 24 24"><path d="M14 3v5h5"/><path d="M6 2h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z"/></svg>`;
      listEl.innerHTML = shown.map((f, i) => `
        <div class="file-row">
          <button class="repo-item file-insert" type="button" data-i="${i}" title="Insert ${esc(f.path)} into the message">
            ${fileIco}<span class="repo-item__name">${esc(f.path)}</span>
          </button>
          <button class="file-add" type="button" data-add="${i}" title="Add to context basket" aria-label="Add to context">+</button>
        </div>`).join("");
      listEl.querySelectorAll(".file-insert").forEach((btn) => btn.addEventListener("click", () => {
        insertFileIntoChat(shown[parseInt(btn.dataset.i, 10)].path); closeFilesPicker();
      }));
      listEl.querySelectorAll(".file-add").forEach((btn) => btn.addEventListener("click", (e) => {
        e.stopPropagation(); addToBasket(shown[parseInt(btn.dataset.add, 10)].path);
      }));
    };
    try {
      files = (await getTree()).filter((f) => !isBinaryPath(f.path));
      render("");
      searchEl.addEventListener("input", () => render(searchEl.value.trim()));
      setTimeout(() => searchEl.focus(), 20);
    } catch (err) {
      listEl.innerHTML = `<div class="repo-pop__msg">✗ ${esc(err instanceof TypeError ? "Can't reach the MAX server." : err.message)}</div>`;
    }
    setTimeout(() => {
      const onDoc = (e) => { if (filesPickerEl && !filesPickerEl.contains(e.target) && !anchorBtn.contains(e.target)) { closeFilesPicker(); document.removeEventListener("mousedown", onDoc); } };
      document.addEventListener("mousedown", onDoc);
    }, 0);
  }

  /* ---------- @file mention autocomplete ---------- */
  let mentionEl = null;
  let mentionMatches = [];
  let mentionActive = 0;
  let mentionStart = -1;

  function closeMention() { if (mentionEl) { mentionEl.remove(); mentionEl = null; } mentionStart = -1; }
  function moveMention(dir) {
    if (!mentionEl) return;
    const items = [...mentionEl.querySelectorAll(".repo-item")];
    if (!items.length) return;
    items[mentionActive]?.classList.remove("active");
    mentionActive = (mentionActive + dir + items.length) % items.length;
    items[mentionActive]?.classList.add("active");
    items[mentionActive]?.scrollIntoView({ block: "nearest" });
  }

  async function maybeMention(input) {
    const repo = activeRepo();
    const pos = input.selectionStart;
    const before = input.value.slice(0, pos);
    const m = before.match(/(?:^|\s)@([\w./-]*)$/);
    if (!repo || !m) { closeMention(); return; }
    mentionStart = pos - m[1].length - 1; // index of '@'
    const query = m[1].toLowerCase();
    let files = [];
    try { files = await getTree(); } catch { closeMention(); return; }
    mentionMatches = files.filter((f) => !isBinaryPath(f.path) && f.path.toLowerCase().includes(query)).slice(0, 30);
    if (!mentionMatches.length) { closeMention(); return; }
    renderMention(input);
  }

  function renderMention(input) {
    if (!mentionEl) {
      mentionEl = document.createElement("div");
      mentionEl.className = "repo-pop mention-pop";
      document.body.appendChild(mentionEl);
      const rect = $(".composer").getBoundingClientRect();
      mentionEl.style.left = `${rect.left}px`;
      mentionEl.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      mentionEl.style.width = `${Math.min(rect.width, 420)}px`;
    }
    mentionActive = 0;
    const fileIco = `<svg class="repo-item__ico" viewBox="0 0 24 24"><path d="M14 3v5h5"/><path d="M6 2h9l5 5v13a1 1 0 01-1 1H6a1 1 0 01-1-1V3a1 1 0 011-1z"/></svg>`;
    mentionEl.innerHTML = `<div class="repo-pop__list">` + mentionMatches.map((f, i) =>
      `<button class="repo-item${i === 0 ? " active" : ""}" type="button" data-i="${i}">${fileIco}<span class="repo-item__name">${esc(f.path)}</span></button>`).join("") + `</div>`;
    mentionEl.querySelectorAll(".repo-item").forEach((btn) => btn.addEventListener("click", () => {
      const file = mentionMatches[parseInt(btn.dataset.i, 10)];
      // remove the "@query" token, then insert the file content
      if (mentionStart >= 0) {
        input.value = input.value.slice(0, mentionStart) + input.value.slice(input.selectionStart);
        autoResize(input); updateCharCount();
      }
      closeMention();
      insertFileIntoChat(file.path);
    }));
  }

  /* ============================================================
     Edit → commit → PR/MR
     ============================================================ */
  // Parse ```lang path=foo/bar.js  fenced blocks into proposed file edits.
  function parseEdits(content) {
    const edits = [];
    const re = /```[^\n]*?\bpath\s*=\s*"?([^\s"`]+)"?[^\n]*\n([\s\S]*?)```/g;
    let m;
    while ((m = re.exec(content))) {
      const path = m[1].trim().replace(/^\/+/, "");
      if (path) edits.push({ path, content: m[2].replace(/\n$/, "") });
    }
    return edits;
  }

  // Minimal LCS-based line diff → array of {type:'ctx'|'add'|'del', text}.
  function diffLines(oldStr, newStr) {
    const a = (oldStr || "").split("\n");
    const b = (newStr || "").split("\n");
    const n = a.length, mm = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Int32Array(mm + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = mm - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0;
    while (i < n && j < mm) {
      if (a[i] === b[j]) { out.push({ type: "ctx", text: a[i] }); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push({ type: "del", text: a[i] }); i++; }
      else { out.push({ type: "add", text: b[j] }); j++; }
    }
    while (i < n) { out.push({ type: "del", text: a[i++] }); }
    while (j < mm) { out.push({ type: "add", text: b[j++] }); }
    return out;
  }

  async function openDiffModal(edits) {
    const repo = activeRepo();
    if (!repo) { toast("Pick a repository first.", "error"); return; }
    if (!providerHasToken(repo.provider)) { toast(`Connect ${repo.provider} in Settings.`, "error"); openSettings(); return; }

    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `
      <div class="modal modal--wide" role="dialog" aria-modal="true">
        <div class="modal__head">
          <h2>Review changes · ${esc(repo.fullName)}</h2>
          <button class="icon-btn" data-x aria-label="Close"><svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M18 6L6 18M6 6l12 12"/></svg></button>
        </div>
        <div class="modal__body" id="diff-body"><div class="repo-spinner"></div></div>
        <div class="modal__foot">
          <input type="text" id="commit-branch" placeholder="branch (e.g. max/edit)" style="flex:1;min-width:120px" />
          <input type="text" id="commit-title" placeholder="PR title" style="flex:1;min-width:120px" />
          <button class="btn btn--ghost" data-x>Cancel</button>
          <button class="btn btn--primary" id="commit-go">Commit &amp; open ${repo.provider === "gitlab" ? "MR" : "PR"}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = () => overlay.remove();
    overlay.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", close));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) close(); });
    $("#commit-branch", overlay).value = `max/edit-${Date.now().toString(36).slice(-5)}`;
    $("#commit-title", overlay).value = edits.length === 1 ? `Update ${edits[0].path}` : `Update ${edits.length} files`;

    const body = $("#diff-body", overlay);
    body.innerHTML = "";
    for (const e of edits) {
      const box = document.createElement("div");
      box.className = "diff-file";
      box.innerHTML = `<div class="diff-file__head">${esc(e.path)}</div><div class="diff-file__body">Loading…</div>`;
      body.appendChild(box);
      let current = "";
      try { const data = await providerFetch("file", { path: e.path }); current = data.content || ""; }
      catch { current = ""; /* new file */ }
      const rows = diffLines(current, e.content);
      const added = rows.filter((r) => r.type === "add").length;
      const removed = rows.filter((r) => r.type === "del").length;
      box.querySelector(".diff-file__head").innerHTML =
        `${esc(e.path)} <span class="diff-stat"><span class="diff-add">+${added}</span> <span class="diff-del">−${removed}</span>${current ? "" : ' <span class="diff-new">new file</span>'}</span>`;
      box.querySelector(".diff-file__body").innerHTML =
        `<pre class="diff">${rows.map((r) =>
          `<span class="diff-line diff-${r.type}">${r.type === "add" ? "+" : r.type === "del" ? "−" : " "} ${esc(r.text)}</span>`).join("\n")}</pre>`;
    }

    $("#commit-go", overlay).addEventListener("click", async () => {
      const branch = $("#commit-branch", overlay).value.trim() || `max/edit-${Date.now().toString(36).slice(-5)}`;
      const title = $("#commit-title", overlay).value.trim() || "MAX changes";
      const btn = $("#commit-go", overlay); setBtnBusy(btn, true); btn.textContent = "Committing…";
      const ok = await commitAndOpenRequest(repo, edits, branch, title);
      setBtnBusy(btn, false);
      if (ok) close();
      else btn.textContent = `Commit & open ${repo.provider === "gitlab" ? "MR" : "PR"}`;
    });
  }

  async function commitAndOpenRequest(repo, edits, branch, title) {
    const token = providerToken(repo.provider) || undefined;
    const commitBody = {
      token, branch: repo.branch,
      newBranch: branch, files: edits, message: title,
    };
    if (repo.provider === "gitlab") commitBody.projectId = repo.projectId ?? repo.fullName;
    else { commitBody.owner = repo.owner; commitBody.repo = repo.name; }
    try {
      const cRes = await fetch(`/api/${repo.provider}/commit`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commitBody),
      });
      const cData = await cRes.json().catch(() => ({}));
      if (!cRes.ok) throw new Error(cData?.error?.message || `Commit failed (HTTP ${cRes.status})`);
      toast(cData.message || "Committed", "success");

      const prBody = { token, head: branch, base: repo.branch, title, body: "Proposed by MAX." };
      if (repo.provider === "gitlab") prBody.projectId = repo.projectId ?? repo.fullName;
      else { prBody.owner = repo.owner; prBody.repo = repo.name; }
      const prRes = await fetch(`/api/${repo.provider}/${repo.provider === "gitlab" ? "mr" : "pr"}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prBody),
      });
      const prData = await prRes.json().catch(() => ({}));
      if (!prRes.ok) throw new Error(prData?.error?.message || `Could not open request (HTTP ${prRes.status})`);
      toast(prData.message || "Opened request", "success");
      if (prData.url) toastLink(repo.provider === "gitlab" ? "View merge request" : "View pull request", prData.url);
      return true;
    } catch (err) {
      toast(err instanceof TypeError ? "Can't reach the MAX server." : err.message, "error");
      return false;
    }
  }

  /* ============================================================
     Read-aloud (speech synthesis)
     ============================================================ */
  let speaking = false;
  function speak(text) {
    if (!("speechSynthesis" in window)) { toast("Speech is not supported in this browser.", "error"); return; }
    if (speaking) { speechSynthesis.cancel(); speaking = false; return; }
    const u = new SpeechSynthesisUtterance(String(text || "").replace(/```[\s\S]*?```/g, " (code block) ").slice(0, 6000));
    u.onend = () => (speaking = false);
    speaking = true;
    speechSynthesis.speak(u);
  }

  /* ============================================================
     Shareable read-only HTML export
     ============================================================ */
  function conversationToHtml(convo) {
    const rows = convo.messages.filter((m) => m.role === "user" || m.role === "assistant").map((m) => {
      const who = m.auto ? "Auto" : (m.role === "user" ? "You" : "MAX");
      const html = window.marked && window.DOMPurify
        ? DOMPurify.sanitize(marked.parse(m.content || "")) : `<pre>${esc(m.content)}</pre>`;
      return `<div class="m ${m.role}"><div class="r">${who}</div><div class="c">${html}</div></div>`;
    }).join("\n");
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(convo.title || "MAX chat")}</title>
<style>body{font-family:system-ui,sans-serif;max-width:820px;margin:0 auto;padding:24px;background:#0b0b14;color:#ecedf5;line-height:1.6}
h1{font-weight:800}.m{margin:18px 0;padding:14px 16px;border-radius:12px;border:1px solid #ffffff18}
.m.user{background:#7c5cff22}.m.assistant{background:#ffffff08}.r{font-weight:700;font-size:12px;opacity:.7;margin-bottom:6px}
pre{overflow:auto;background:#0d1117;padding:12px;border-radius:8px}code{font-family:ui-monospace,monospace}
a{color:#22d3ee}</style></head>
<body><h1>${esc(convo.title || "MAX chat")}</h1><p style="opacity:.6">Exported from MAX · ${new Date().toLocaleString()}</p>${rows}</body></html>`;
  }
  function shareConversation(id) {
    const convo = state.conversations.find((c) => c.id === id) || activeConvo();
    if (!convo || !convo.messages.length) { toast("Nothing to share yet.", "error"); return; }
    download(`${slugify(convo.title)}-${convo.id}.html`, conversationToHtml(convo), "text/html");
    toast("Exported a shareable HTML file", "success");
  }

  /* ============================================================
     Request log
     ============================================================ */
  const requestLog = [];
  function logRequest(entry) {
    requestLog.unshift({ time: Date.now(), ...entry });
    if (requestLog.length > 50) requestLog.pop();
  }
  function openRequestLog() {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    const rows = requestLog.length ? requestLog.map((e) => {
      const when = new Date(e.time).toLocaleTimeString();
      const status = e.ok ? `<span style="color:#34d399">ok</span>` : `<span style="color:#ff6b8a">${esc(e.status || "err")}</span>`;
      return `<tr><td>${when}</td><td>${esc(e.model || "")}</td><td>${status}</td><td>${e.ms ? e.ms + "ms" : ""}</td><td>${e.tokens != null ? e.tokens : ""}</td></tr>`;
    }).join("") : `<tr><td colspan="5" style="text-align:center;opacity:.6;padding:20px">No requests yet.</td></tr>`;
    overlay.innerHTML = `<div class="modal" role="dialog" aria-modal="true">
      <div class="modal__head"><h2>Request log</h2><button class="icon-btn" data-x aria-label="Close"><svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>
      <div class="modal__body"><table class="log-table"><thead><tr><th>Time</th><th>Model</th><th>Status</th><th>Latency</th><th>Out tok</th></tr></thead><tbody>${rows}</tbody></table></div></div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", () => overlay.remove()));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
  }

  /* ============================================================
     Powers (integrations gallery)
     ============================================================ */
  let powersCatalog = null;         // { categories, powers }
  const powerKeyName = (id) => `${SCOPE}max.powerKey.${id}.v1`;
  const isInstalled = (id) => state.settings.powers.installed.includes(id);
  const powerById = (id) => (powersCatalog?.powers || []).find((p) => p.id === id);
  const getPowerKey = (id) => { try { return sessionStorage.getItem(powerKeyName(id)) || ""; } catch { return ""; } };
  function setPowerKey(id, key) {
    try { if (key) sessionStorage.setItem(powerKeyName(id), key); else sessionStorage.removeItem(powerKeyName(id)); } catch {}
  }

  async function loadPowers() {
    if (powersCatalog) return powersCatalog;
    try {
      const res = await fetch("/api/powers");
      powersCatalog = res.ok ? await res.json() : { categories: [], powers: [] };
    } catch { powersCatalog = { categories: [], powers: [] }; }
    return powersCatalog;
  }

  function installedPowers() {
    return (powersCatalog?.powers || []).filter((p) => isInstalled(p.id));
  }

  // Slash commands contributed by installed, available powers.
  function powerSlashCommands() {
    const cmds = [];
    if (isInstalled("web-fetch")) cmds.push({ cmd: "/fetch", desc: "Fetch a web page into the chat", run: () => runFetchCommand() });
    if (isInstalled("web-search")) cmds.push({ cmd: "/search", desc: "Search the web and add results", run: () => runSearchCommand() });
    return cmds;
  }

  // Capability note injected into the system prompt for installed powers.
  function powersSystemNote() {
    const active = installedPowers().filter((p) => p.status === "available");
    if (!active.length) return "";
    const lines = active.map((p) => `- ${p.name}: ${p.blurb}`);
    return `\n\n[Enabled powers] The user has enabled these MAX capabilities:\n${lines.join("\n")}`;
  }

  async function togglePower(id) {
    const p = powerById(id);
    if (!p) return;
    if (isInstalled(id)) {
      state.settings.powers.installed = state.settings.powers.installed.filter((x) => x !== id);
      setPowerKey(id, "");
      saveSettings(); renderPowers(); toast(`Removed ${p.name}`);
      return;
    }
    if (p.status !== "available") {
      // Catalog-only entry: point the user to its real setup.
      if (p.url) window.open(p.url, "_blank", "noopener");
      toast(`${p.name} is a catalog entry — opens its site for setup.`, "");
      return;
    }
    if (p.requiresKey && !getPowerKey(id)) {
      const key = (prompt(`${p.name}\n\n${p.keyHelp || "Enter the API key for this power:"}`, "") || "").trim();
      if (!key) return;
      setPowerKey(id, key);
    }
    state.settings.powers.installed.push(id);
    saveSettings(); renderPowers(); toast(`Installed ${p.name} ✓`, "success");
  }

  let powersScope = "all";
  let powersCat = "All";
  function openPowers() {
    $("#powers-overlay").hidden = false;
    loadPowers().then(() => { renderPowerCats(); renderPowers(); });
  }
  function closePowers() { $("#powers-overlay").hidden = true; }

  function renderPowerCats() {
    const box = $("#powers-cats");
    const cats = ["All", ...(powersCatalog?.categories || [])];
    box.innerHTML = cats.map((c) =>
      `<button class="powers-cat${c === powersCat ? " active" : ""}" data-cat="${esc(c)}" type="button">${esc(c)}</button>`).join("");
    box.querySelectorAll(".powers-cat").forEach((b) => b.addEventListener("click", () => { powersCat = b.dataset.cat; renderPowerCats(); renderPowers(); }));
  }

  function renderPowers() {
    const grid = $("#powers-grid");
    if (!grid) return;
    const q = $("#powers-search-input").value.trim().toLowerCase();
    let list = (powersCatalog?.powers || []).slice();
    if (powersScope === "official") list = list.filter((p) => p.official);
    else if (powersScope === "community") list = list.filter((p) => !p.official);
    else if (powersScope === "installed") list = list.filter((p) => isInstalled(p.id));
    if (powersCat !== "All") list = list.filter((p) => p.category === powersCat);
    if (q) list = list.filter((p) => (p.name + " " + p.provider + " " + p.blurb).toLowerCase().includes(q));

    if (!list.length) { grid.innerHTML = `<p class="empty-hint">No powers match.</p>`; return; }
    grid.innerHTML = list.map((p) => {
      const installed = isInstalled(p.id);
      const badge = p.requiresKey ? `<span class="power-badge">Requires API key</span>` : "";
      const avail = p.status === "available" ? `<span class="power-avail" title="Works in MAX now">● works now</span>` : "";
      const initial = esc((p.name[0] || "P").toUpperCase());
      return `
        <div class="power-card">
          <div class="power-card__top">
            <div class="power-ico">${initial}</div>
            <div class="power-meta">
              <div class="power-name">${esc(p.name)}</div>
              <div class="power-provider">${esc(p.provider)}</div>
            </div>
          </div>
          <p class="power-blurb">${esc(p.blurb)}</p>
          <div class="power-tags">${avail} ${badge}</div>
          <div class="power-actions">
            <button class="btn ${installed ? "btn--ghost" : "btn--primary"} power-install" data-id="${esc(p.id)}" type="button">${installed ? "Remove" : (p.status === "available" ? "Install" : "Get it")}</button>
            ${p.url ? `<a class="btn btn--ghost" href="${esc(p.url)}" target="_blank" rel="noopener">Details ↗</a>` : ""}
          </div>
        </div>`;
    }).join("");
    grid.querySelectorAll(".power-install").forEach((b) => b.addEventListener("click", () => togglePower(b.dataset.id)));
  }

  /* ---------- working powers: fetch + search ---------- */
  async function runFetchCommand(urlArg) {
    const url = (urlArg || prompt("Fetch which URL?", "https://") || "").trim();
    if (!url || url === "https://") return;
    toast("Fetching page…");
    try {
      const res = await fetch("/api/powers/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const input = $("#input");
      input.value = (input.value + `\n\nWeb page ${data.url}:\n"""\n${data.text}\n"""\n`).trimStart();
      autoResize(input); updateCharCount(); updateSendState(); input.focus();
      toast("Page added to the message", "success");
    } catch (err) { toast(err instanceof TypeError ? "Can't reach the MAX server." : err.message, "error"); }
  }

  async function runSearchCommand(queryArg) {
    const query = (queryArg || prompt("Search the web for:", "") || "").trim();
    if (!query) return;
    if (!getPowerKey("web-search")) { toast("Add a Web Search API key in Powers first.", "error"); openPowers(); return; }
    toast("Searching…");
    try {
      const res = await fetch("/api/powers/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, key: getPowerKey("web-search") }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const block = [`Web search results for "${query}":`, data.answer ? `\nSummary: ${data.answer}` : "",
        ...data.results.map((r, i) => `\n${i + 1}. ${r.title}\n${r.url}\n${(r.content || "").slice(0, 400)}`)].join("\n");
      const input = $("#input");
      input.value = (input.value + `\n\n${block}\n`).trimStart();
      autoResize(input); updateCharCount(); updateSendState(); input.focus();
      toast(`Added ${data.results.length} results`, "success");
    } catch (err) { toast(err instanceof TypeError ? "Can't reach the MAX server." : err.message, "error"); }
  }

  /* ============================================================
     Account + admin (user management)
     ============================================================ */
  function renderAccount() {
    const box = $("#account");
    if (!box) return;
    if (!state.user) { box.hidden = true; return; }
    box.hidden = false;
    $("#account-avatar").textContent = (state.user.username[0] || "U").toUpperCase();
    $("#account-name").textContent = state.user.username;
    $("#account-role").textContent = state.user.role === "superadmin" ? "Super admin" : "User";
    $("#admin-btn").hidden = state.user.role !== "superadmin";
    if (state.user.mustChangePassword) {
      setTimeout(() => toast("Please change your temporary password (Account → change password).", ""), 900);
    }
  }

  async function logout() {
    try { await fetch("/api/auth/logout", { method: "POST" }); } catch {}
    location.replace("/login.html");
  }

  async function changeOwnPassword() {
    const current = prompt("Current password:");
    if (current == null) return;
    const next = prompt("New password (min 6 chars):");
    if (!next) return;
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ current, next }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || "Could not change password.");
      toast("Password changed", "success");
    } catch (err) { toast(err.message, "error"); }
  }

  function fmtDate(ts) { return ts ? new Date(ts).toLocaleString() : "—"; }

  async function openAdmin() {
    $("#admin-overlay").hidden = false;
    await renderAdminUsers();
  }
  function closeAdmin() { $("#admin-overlay").hidden = true; }

  async function renderAdminUsers() {
    const tb = $("#admin-tbody");
    tb.innerHTML = `<tr><td colspan="7"><div class="repo-spinner"></div></td></tr>`;
    try {
      const res = await fetch("/api/admin/users");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const me = state.user?.id;
      tb.innerHTML = data.users.map((u) => {
        const isSelf = u.id === me;
        const status = u.disabled
          ? `<span class="badge-off">Disabled</span>`
          : `<span class="badge-on">Active</span>`;
        const roleTag = u.role === "superadmin" ? `<span class="role-super">super admin</span>` : "user";
        const actions = [
          !isSelf ? `<button class="mini-btn" data-act="${u.disabled ? "enable" : "disable"}" data-id="${esc(u.id)}">${u.disabled ? "Enable" : "Disable"}</button>` : "",
          `<button class="mini-btn" data-act="reset" data-id="${esc(u.id)}">Reset pw</button>`,
          !isSelf ? `<button class="mini-btn mini-btn--danger" data-act="delete" data-id="${esc(u.id)}">Delete</button>` : "",
        ].join("");
        return `<tr>
          <td><b>${esc(u.username)}</b>${isSelf ? ' <span class="you-tag">you</span>' : ""}</td>
          <td>${roleTag}</td>
          <td>${status}</td>
          <td>${fmtDate(u.createdAt)}</td>
          <td>${fmtDate(u.lastLoginAt)}</td>
          <td>${u.loginCount || 0}</td>
          <td class="admin-actions">${actions}</td>
        </tr>`;
      }).join("");
      tb.querySelectorAll("button[data-act]").forEach((b) => b.addEventListener("click", () => adminAction(b.dataset.act, b.dataset.id)));
    } catch (err) {
      tb.innerHTML = `<tr><td colspan="7" style="color:#ff6b8a;padding:16px">✗ ${esc(err.message)}</td></tr>`;
    }
  }

  async function adminAction(action, id) {
    try {
      let opts = { method: "POST", headers: { "Content-Type": "application/json" } };
      let url = `/api/admin/users/${encodeURIComponent(id)}/${action}`;
      if (action === "reset") {
        const pw = prompt("New temporary password (min 6 chars):");
        if (!pw) return;
        opts.body = JSON.stringify({ password: pw });
      } else if (action === "delete") {
        if (!confirm("Delete this user? This cannot be undone.")) return;
        url = `/api/admin/users/${encodeURIComponent(id)}`;
        opts = { method: "DELETE" };
      }
      const res = await fetch(url, opts);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      toast(action === "reset" ? "Password reset ✓" : action === "delete" ? "User deleted" : `User ${action}d`, "success");
      renderAdminUsers();
    } catch (err) { toast(err.message, "error"); }
  }

  async function adminAddUser() {
    const username = $("#admin-new-user").value.trim();
    const password = $("#admin-new-pass").value;
    const role = $("#admin-new-role").value;
    if (!username || !password) { toast("Enter a username and temp password.", "error"); return; }
    try {
      const res = await fetch("/api/admin/users", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password, role }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      $("#admin-new-user").value = ""; $("#admin-new-pass").value = "";
      toast(`Added ${username}`, "success");
      renderAdminUsers();
    } catch (err) { toast(err.message, "error"); }
  }

  /* ============================================================
     Voice input (Web Speech API)
     ============================================================ */
  let recognition = null;
  function toggleVoice() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { toast("Voice input isn't supported in this browser.", "error"); return; }
    if (recognition) { recognition.stop(); return; }
    recognition = new SR();
    recognition.lang = navigator.language || "en-US";
    recognition.interimResults = true;
    recognition.continuous = false;
    const input = $("#input");
    const btn = $("#mic-btn");
    btn?.classList.add("recording");
    let base = input.value ? input.value + " " : "";
    recognition.onresult = (e) => {
      let txt = "";
      for (let i = 0; i < e.results.length; i++) txt += e.results[i][0].transcript;
      input.value = base + txt;
      autoResize(input); updateCharCount(); updateSendState();
    };
    recognition.onerror = () => toast("Voice input error.", "error");
    recognition.onend = () => { recognition = null; btn?.classList.remove("recording"); input.focus(); };
    recognition.start();
  }

  /* ============================================================
     Context basket (stage multiple repo files)
     ============================================================ */
  async function addToBasket(path) {
    if (state.basket.some((f) => f.path === path)) { toast("Already staged.", ""); return; }
    try {
      const data = await providerFetch("file", { path });
      state.basket.push({ path, content: data.content || "" });
      renderBasket();
      toast(`Staged ${path}`, "success");
    } catch (err) { toast(err instanceof TypeError ? "Can't reach the MAX server." : err.message, "error"); }
  }
  function clearBasket() { state.basket = []; renderBasket(); }
  function renderBasket() {
    const chip = $("#basket-chip");
    if (!chip) return;
    chip.hidden = state.basket.length === 0;
    $("#basket-count").textContent = state.basket.length;
  }
  function basketPrefix() {
    if (!state.basket.length) return "";
    const repo = activeRepo();
    const blocks = state.basket.map((f) => {
      const lang = (f.path.split(".").pop() || "").toLowerCase();
      return `File \`${f.path}\`${repo ? ` from ${repo.fullName}` : ""}:\n\`\`\`${lang}\n${f.content}\n\`\`\``;
    });
    return `Context files:\n\n${blocks.join("\n\n")}\n\n`;
  }

  /* ============================================================
     Repo map / summarize
     ============================================================ */
  const BINARY_RE = /\.(png|jpe?g|gif|webp|ico|bmp|svg|pdf|zip|gz|tar|rar|7z|mp[34]|mov|avi|mkv|wav|ogg|woff2?|ttf|otf|eot|exe|dll|so|dylib|class|jar|wasm|bin|lock|min\.js|min\.css)$/i;
  const isBinaryPath = (p) => BINARY_RE.test(p);

  async function summarizeRepo() {
    const repo = activeRepo();
    if (!repo) { toast("Pick a repository first.", "error"); return; }
    toast("Reading repository tree…");
    try {
      const files = (await getTree()).filter((f) => !isBinaryPath(f.path));
      const map = files.slice(0, 300).map((f) => f.path).join("\n");
      const input = $("#input");
      input.value = `Here is the file tree of ${repo.fullName} (branch ${repo.branch}):\n\n\`\`\`\n${map}\n\`\`\`\n\nSummarize what this project is, its main components, and how it's organized. Point out where key logic likely lives.`;
      autoResize(input); updateCharCount(); updateSendState(); input.focus();
      toast(`Loaded ${files.length} paths — press Enter to summarize`, "success");
    } catch (err) { toast(err instanceof TypeError ? "Can't reach the MAX server." : err.message, "error"); }
  }

  /* ============================================================
     Slash commands
     ============================================================ */
  const SLASH = [
    { cmd: "/summarize", desc: "Summarize the selected repository", run: () => { $("#input").value = ""; summarizeRepo(); } },
    { cmd: "/files", desc: "Browse repository files", run: () => { $("#input").value = ""; if (activeRepo()) openFilesPicker($("#files-btn")); else toast("Pick a repository first.", "error"); } },
    { cmd: "/repo", desc: "Pick a repository", run: () => { $("#input").value = ""; openRepoPicker($("#repo-chip")); } },
    { cmd: "/explain", desc: "Explain the pasted code", run: () => { $("#input").value = "Explain the following code clearly:\n\n"; focusInputEnd(); } },
    { cmd: "/test", desc: "Write tests for the pasted code", run: () => { $("#input").value = "Write thorough unit tests for the following code:\n\n"; focusInputEnd(); } },
    { cmd: "/share", desc: "Export this chat as shareable HTML", run: () => { $("#input").value = ""; const c = activeConvo(); if (c) shareConversation(c.id); } },
    { cmd: "/clear", desc: "Clear the current conversation", run: () => { $("#input").value = ""; const c = activeConvo(); if (c) { c.messages = []; c.title = "New chat"; touchConvo(c); renderMessages(); renderConversations(); } } },
  ];
  function focusInputEnd() { const i = $("#input"); autoResize(i); updateCharCount(); updateSendState(); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }

  let slashEl = null;
  function closeSlash() { if (slashEl) { slashEl.remove(); slashEl = null; } }
  function maybeSlash(input) {
    const v = input.value;
    if (!/^\/[a-z]*$/i.test(v.trim()) || v.includes("\n")) { closeSlash(); return; }
    const q = v.trim().toLowerCase();
    const matches = SLASH.concat(powerSlashCommands()).filter((s) => s.cmd.startsWith(q));
    if (!matches.length) { closeSlash(); return; }
    if (!slashEl) {
      slashEl = document.createElement("div");
      slashEl.className = "repo-pop mention-pop";
      document.body.appendChild(slashEl);
      const rect = $(".composer").getBoundingClientRect();
      slashEl.style.left = `${rect.left}px`;
      slashEl.style.bottom = `${window.innerHeight - rect.top + 8}px`;
      slashEl.style.width = `${Math.min(rect.width, 460)}px`;
    }
    slashEl.innerHTML = `<div class="repo-pop__list">` + matches.map((s, i) =>
      `<button class="repo-item${i === 0 ? " active" : ""}" type="button" data-i="${i}"><span class="repo-item__name"><b>${esc(s.cmd)}</b> — ${esc(s.desc)}</span></button>`).join("") + `</div>`;
    slashEl.querySelectorAll(".repo-item").forEach((btn) => btn.addEventListener("click", () => {
      const s = matches[parseInt(btn.dataset.i, 10)]; closeSlash(); s.run();
    }));
  }

  /* ============================================================
     API profiles
     ============================================================ */
  const profileKeyName = (id) => `${SCOPE}max.profileKey.${id}.v1`;
  function renderProfiles() {
    const box = $("#profile-list");
    if (!box) return;
    const items = state.settings.profiles || [];
    if (!items.length) { box.innerHTML = `<p class="field__help">No profiles yet. Save your current key + model as a profile to switch quickly.</p>`; return; }
    box.innerHTML = items.map((p) => `
      <div class="persona-row">
        <button class="persona-apply" type="button" data-id="${esc(p.id)}">${esc(p.name)} <span style="opacity:.6">· ${esc(p.model || "")}</span></button>
        <button class="persona-del" type="button" data-del="${esc(p.id)}" aria-label="Delete profile">
          <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>`).join("");
    box.querySelectorAll(".persona-apply").forEach((b) => b.addEventListener("click", () => applyProfile(b.dataset.id)));
    box.querySelectorAll(".persona-del").forEach((b) => b.addEventListener("click", () => {
      state.settings.profiles = state.settings.profiles.filter((x) => x.id !== b.dataset.del);
      try { sessionStorage.removeItem(profileKeyName(b.dataset.del)); } catch {}
      saveSettings(); renderProfiles();
    }));
  }
  function applyProfile(id) {
    const p = state.settings.profiles.find((x) => x.id === id);
    if (!p) return;
    if (p.model) { $("#set-model-custom").value = ""; const sel = $("#set-model"); if ([...sel.options].some((o) => o.value === p.model)) sel.value = p.model; else $("#set-model-custom").value = p.model; }
    let key = "";
    try { key = sessionStorage.getItem(profileKeyName(id)) || ""; } catch {}
    if (key) $("#set-apikey").value = key;
    toast(`Applied profile "${p.name}"`);
  }
  function saveCurrentProfile() {
    const name = (prompt("Name this profile:", "") || "").trim();
    if (!name) return;
    const id = uid();
    const model = $("#set-model-custom").value.trim() || $("#set-model").value;
    state.settings.profiles.push({ id, name, model });
    const key = $("#set-apikey").value.trim();
    if (key) { try { sessionStorage.setItem(profileKeyName(id), key); } catch {} }
    saveSettings(); renderProfiles();
    toast(`Saved profile "${name}"`, "success");
  }

  /* ============================================================
     Import conversations (from exported .json)
     ============================================================ */
  function importFromFile(file) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result));
        const list = Array.isArray(parsed) ? parsed : [parsed];
        let added = 0;
        for (const raw of list) {
          if (!raw || !Array.isArray(raw.messages)) continue;
          const convo = {
            id: uid(),
            title: raw.title || "Imported chat",
            messages: raw.messages.filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
              .map((m) => ({ id: uid(), role: m.role, content: m.content, images: m.images || [], usage: m.usage, model: m.model, auto: m.auto })),
            createdAt: raw.createdAt || Date.now(),
            updatedAt: Date.now(),
            repo: raw.repo || undefined,
          };
          if (convo.messages.length) { state.conversations.unshift(convo); added++; }
        }
        if (!added) { toast("No valid conversations found in that file.", "error"); return; }
        saveConvos();
        renderConversations();
        toast(`Imported ${added} conversation${added > 1 ? "s" : ""}`, "success");
      } catch {
        toast("Could not parse that file as JSON.", "error");
      }
    };
    reader.readAsText(file);
  }

  /* ============================================================
     Persona library (reusable system prompts)
     ============================================================ */
  function renderPersonas() {
    const box = $("#persona-list");
    if (!box) return;
    const items = state.settings.personas || [];
    if (!items.length) { box.innerHTML = `<p class="field__help">No saved personas yet. Write a system prompt above and save it.</p>`; return; }
    box.innerHTML = items.map((p) => `
      <div class="persona-row">
        <button class="persona-apply" type="button" data-id="${esc(p.id)}" title="Use this persona">${esc(p.name)}</button>
        <button class="persona-del" type="button" data-del="${esc(p.id)}" title="Delete" aria-label="Delete persona">
          <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M18 6L6 18M6 6l12 12"/></svg>
        </button>
      </div>`).join("");
    box.querySelectorAll(".persona-apply").forEach((b) => b.addEventListener("click", () => {
      const p = state.settings.personas.find((x) => x.id === b.dataset.id);
      if (p) { $("#set-system").value = p.system; toast(`Applied "${p.name}"`); }
    }));
    box.querySelectorAll(".persona-del").forEach((b) => b.addEventListener("click", () => {
      state.settings.personas = state.settings.personas.filter((x) => x.id !== b.dataset.del);
      saveSettings(); renderPersonas();
    }));
  }
  function saveCurrentPersona() {
    const system = $("#set-system").value.trim();
    if (!system) { toast("Write a system prompt first.", "error"); return; }
    const name = (prompt("Name this persona:", "") || "").trim();
    if (!name) return;
    state.settings.personas.push({ id: uid(), name, system });
    saveSettings();
    renderPersonas();
    toast(`Saved persona "${name}"`, "success");
  }

  /* ============================================================
     In-conversation search
     ============================================================ */
  let findMatches = [];
  let findIndex = 0;
  function toggleFindBar(show) {
    const bar = $("#find-bar");
    if (!bar) return;
    const doShow = show ?? bar.hidden;
    bar.hidden = !doShow;
    if (doShow) { $("#find-input").focus(); $("#find-input").select(); }
    else { clearFindHighlights(); }
  }
  function clearFindHighlights() {
    $$(".msg.find-hit").forEach((el) => el.classList.remove("find-hit", "find-current"));
    findMatches = [];
  }
  function runFind() {
    clearFindHighlights();
    const q = $("#find-input").value.trim().toLowerCase();
    const convo = activeConvo();
    if (!q || !convo) { $("#find-count").textContent = ""; return; }
    convo.messages.forEach((m) => {
      if ((m.content || "").toLowerCase().includes(q)) {
        const el = $(`.msg[data-id="${m.id}"]`);
        if (el) { el.classList.add("find-hit"); findMatches.push(el); }
      }
    });
    findIndex = 0;
    $("#find-count").textContent = findMatches.length ? `1/${findMatches.length}` : "0";
    if (findMatches.length) focusFind(0);
  }
  function focusFind(i) {
    if (!findMatches.length) return;
    findMatches.forEach((el) => el.classList.remove("find-current"));
    findIndex = (i + findMatches.length) % findMatches.length;
    const el = findMatches[findIndex];
    el.classList.add("find-current");
    el.scrollIntoView({ block: "center", behavior: "smooth" });
    $("#find-count").textContent = `${findIndex + 1}/${findMatches.length}`;
  }

  /* ============================================================
     Command palette (Cmd/Ctrl+K)
     ============================================================ */
  let paletteEl = null;
  function closePalette() { if (paletteEl) { paletteEl.remove(); paletteEl = null; } }
  function paletteActions() {
    return [
      { label: "New chat", run: () => $("#new-chat-btn").click() },
      { label: "Search conversations", run: () => { setSidebarHidden(false); $("#search-input").focus(); } },
      { label: "Find in this conversation", run: () => toggleFindBar(true) },
      { label: "Pick a repository", run: () => openRepoPicker($("#repo-chip")) },
      { label: "Browse repository files", run: () => { if (activeRepo()) openFilesPicker($("#files-btn")); else toast("Pick a repository first.", "error"); } },
      { label: "Summarize the repository", run: summarizeRepo },
      { label: "Push conversation to repo", run: () => { const c = activeConvo(); if (c) pushConversation(c.id); } },
      { label: state.settings.autonomous ? "Turn OFF Autonomous mode" : "Turn ON Autonomous mode", run: () => $("#auto-toggle").click() },
      { label: "Toggle theme (light/dark)", run: toggleTheme },
      { label: "Import chat (.json)", run: () => $("#import-input").click() },
      { label: "Export current chat (.md)", run: () => { const c = activeConvo(); if (c) exportConversation(c.id, "md"); } },
      { label: "Share current chat (.html)", run: () => { const c = activeConvo(); if (c) shareConversation(c.id); } },
      { label: "View request log", run: openRequestLog },
      { label: "Open Powers (integrations)", run: openPowers },
      { label: "Open Settings", run: openSettings },
      ...(state.user ? [{ label: "Change my password", run: changeOwnPassword }] : []),
      ...(state.user?.role === "superadmin" ? [{ label: "Manage users (admin)", run: openAdmin }] : []),
      ...(state.user ? [{ label: "Sign out", run: logout }] : []),
    ];
  }
  function openPalette() {
    closePalette();
    const actions = paletteActions();
    const el = document.createElement("div");
    el.className = "modal-overlay palette-overlay";
    el.innerHTML = `
      <div class="palette" role="dialog" aria-modal="true">
        <input type="text" id="palette-input" placeholder="Type a command…" autocomplete="off" spellcheck="false" />
        <div class="palette-list" id="palette-list"></div>
      </div>`;
    document.body.appendChild(el);
    paletteEl = el;
    const input = el.querySelector("#palette-input");
    const listEl = el.querySelector("#palette-list");
    let active = 0;
    let filtered = actions;
    const render = () => {
      listEl.innerHTML = filtered.map((a, i) =>
        `<button class="palette-item${i === active ? " active" : ""}" type="button" data-i="${i}">${esc(a.label)}</button>`).join("")
        || `<div class="repo-pop__msg">No commands</div>`;
      listEl.querySelectorAll(".palette-item").forEach((b) => b.addEventListener("click", () => {
        const a = filtered[parseInt(b.dataset.i, 10)]; closePalette(); a && a.run();
      }));
    };
    const filter = () => {
      const q = input.value.trim().toLowerCase();
      filtered = q ? actions.filter((a) => a.label.toLowerCase().includes(q)) : actions;
      active = 0; render();
    };
    input.addEventListener("input", filter);
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); render(); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
      else if (e.key === "Enter") { e.preventDefault(); const a = filtered[active]; closePalette(); a && a.run(); }
    });
    el.addEventListener("mousedown", (e) => { if (e.target === el) closePalette(); });
    render();
    setTimeout(() => input.focus(), 20);
  }

  /* ============================================================
     Theme
     ============================================================ */
  function applyTheme(theme) {
    document.documentElement.setAttribute("data-theme", theme);
    try {
      localStorage.setItem(LS.theme, theme);
    } catch {}
    const hl = $("#hljs-theme");
    hl.href = theme === "light"
      ? "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github.min.css"
      : "https://cdn.jsdelivr.net/gh/highlightjs/cdn-release@11.9.0/build/styles/github-dark.min.css";
  }
  function toggleTheme() {
    const cur = document.documentElement.getAttribute("data-theme");
    applyTheme(cur === "light" ? "dark" : "light");
  }

  /* ============================================================
     Model pill + key status
     ============================================================ */
  function updateModelPill() {
    $("#model-pill-name").textContent = currentModel();
  }

  // Running token + cost total for the active conversation.
  function updateUsagePill() {
    const pill = $("#usage-pill");
    if (!pill) return;
    const convo = activeConvo();
    let inTok = 0, outTok = 0;
    if (convo) for (const m of convo.messages) {
      if (m.usage) { inTok += m.usage.input_tokens || 0; outTok += m.usage.output_tokens || 0; }
    }
    if (!inTok && !outTok) { pill.hidden = true; return; }
    const p = priceFor(currentModel());
    const cost = (inTok / 1e6) * p.in + (outTok / 1e6) * p.out;
    const tokens = inTok + outTok;
    const tokLabel = tokens >= 1000 ? `${(tokens / 1000).toFixed(1)}k` : String(tokens);
    pill.hidden = false;
    pill.textContent = `${tokLabel} tok · ~$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
    pill.title = `${inTok.toLocaleString()} input + ${outTok.toLocaleString()} output tokens · estimated $${cost.toFixed(4)} at current model pricing`;
  }
  function updateKeyStatus() {
    const el = $("#key-status");
    const hasClient = state.settings.apiKey && state.config.allowClientKey;
    if (hasClient) { el.textContent = "Key: your key"; el.className = "key-status ok"; }
    else if (state.config.hasServerKey) { el.textContent = "Key: server"; el.className = "key-status ok"; }
    else { el.textContent = "No API key"; el.className = "key-status warn"; }
  }

  /* ============================================================
     Settings modal
     ============================================================ */
  function openSettings() {
    const s = state.settings;
    // populate model select
    const sel = $("#set-model");
    sel.innerHTML = state.config.models.map((m) => `<option value="${esc(m.id)}">${esc(m.label)}</option>`).join("");
    const known = state.config.models.some((m) => m.id === (s.model || state.config.defaultModel));
    if (known) { sel.value = s.model || state.config.defaultModel; $("#set-model-custom").value = ""; }
    else { $("#set-model-custom").value = s.model || ""; }

    $("#set-apikey").value = s.apiKey || "";
    $("#set-system").value = s.system || "";
    $("#set-maxtokens").value = s.maxTokens;
    $("#set-temp").value = s.temperature;
    $("#temp-val").textContent = Number(s.temperature).toFixed(2);

    // Autonomous
    $("#set-autonomous").checked = !!s.autonomous;
    $("#set-autosteps").value = clampSteps(s.autoMaxSteps);
    $("#autosteps-val").textContent = clampSteps(s.autoMaxSteps);
    $("#set-autopush").checked = !!s.autoPush;
    $("#set-confirm-auto").checked = s.confirmAutonomous !== false;

    // GitLab + personas + profiles
    $("#set-gltoken").value = s.gitlab?.token || "";
    $("#gl-test-result").textContent = "";
    renderPersonas();
    renderProfiles();

    // GitHub (fall back to server-provided defaults as placeholders/values)
    const g = s.github || githubDefaults();
    const gc = state.config.github || {};
    $("#set-ghtoken").value = g.token || "";
    $("#set-ghowner").value = g.owner || gc.owner || "";
    $("#set-ghrepo").value = g.repo || gc.repo || "";
    $("#set-ghbranch").value = g.branch || gc.branch || "main";
    $("#set-ghpath").value = g.pathPrefix || "max-chats";
    const ghField = $("#ghtoken-field");
    if (gc.allowClientToken === false) {
      ghField.style.display = "none";
    } else {
      ghField.style.display = "";
      $("#ghtoken-help").innerHTML = gc.hasServerToken
        ? "A server token is configured. Leave blank to use it, or paste your own to override."
        : "Needs the <b>repo</b> scope (or Contents: write on a fine-grained token) to push.";
    }
    $("#gh-test-result").textContent = "";

    // api key help / visibility
    const field = $("#apikey-field");
    if (!state.config.allowClientKey) {
      field.style.display = "none";
    } else {
      field.style.display = "";
      $("#apikey-help").textContent = state.config.hasServerKey
        ? "A server key is configured. Leave blank to use it, or enter your own to override."
        : "No server key configured — enter your AgentRouter key (from agentrouter.org/console/token).";
    }
    $("#settings-note").textContent = "";
    $("#settings-overlay").hidden = false;
  }
  function closeSettings() { $("#settings-overlay").hidden = true; }

  function saveSettingsFromModal() {
    const custom = $("#set-model-custom").value.trim();
    state.settings.apiKey = $("#set-apikey").value.trim();
    state.settings.model = custom || $("#set-model").value;
    state.settings.system = $("#set-system").value;
    state.settings.maxTokens = Math.max(256, Math.min(64000, parseInt($("#set-maxtokens").value, 10) || 4096));
    state.settings.temperature = parseFloat($("#set-temp").value);

    state.settings.autonomous = $("#set-autonomous").checked;
    state.settings.autoMaxSteps = clampSteps($("#set-autosteps").value);
    state.settings.autoPush = $("#set-autopush").checked;
    state.settings.confirmAutonomous = $("#set-confirm-auto").checked;
    state.settings.gitlab = {
      token: $("#set-gltoken").value.trim(),
      branch: state.settings.gitlab?.branch || "main",
    };

    state.settings.github = {
      token: $("#set-ghtoken").value.trim(),
      owner: $("#set-ghowner").value.trim(),
      repo: $("#set-ghrepo").value.trim(),
      branch: $("#set-ghbranch").value.trim() || "main",
      pathPrefix: ($("#set-ghpath").value.trim() || "max-chats").replace(/^\/+|\/+$/g, ""),
    };

    saveSettings();
    updateModelPill();
    updateKeyStatus();
    updateAutoPill();
    toast("Settings saved", "success");
    closeSettings();
  }

  /* ============================================================
     Rename dialog
     ============================================================ */
  function openRename(id) {
    const c = state.conversations.find((x) => x.id === id);
    if (!c) return;
    state.renameId = id;
    $("#rename-input").value = c.title;
    $("#rename-overlay").hidden = false;
    setTimeout(() => { $("#rename-input").focus(); $("#rename-input").select(); }, 30);
  }
  function closeRename() { $("#rename-overlay").hidden = true; state.renameId = null; }
  function saveRename() {
    const c = state.conversations.find((x) => x.id === state.renameId);
    if (c) {
      const t = $("#rename-input").value.trim();
      c.title = t || c.title;
      saveConvos();
      renderConversations();
    }
    closeRename();
  }

  /* ---------- conversation context menu (simple) ---------- */
  function convMenu(id, anchorBtn) {
    // remove any existing popover
    $$(".conv-pop").forEach((p) => p.remove());
    const pop = document.createElement("div");
    pop.className = "conv-pop";
    Object.assign(pop.style, {
      position: "fixed", zIndex: 60, background: "var(--surface-solid)",
      border: "1px solid var(--border-strong)", borderRadius: "10px",
      boxShadow: "var(--shadow)", padding: "5px", minWidth: "150px", fontSize: "14px",
    });
    const item = (a, label, color) =>
      `<button data-a="${a}" style="display:flex;gap:8px;width:100%;padding:8px 10px;background:none;border:none;color:${color || "var(--text)"};border-radius:7px;text-align:left">${label}</button>`;
    const convo = state.conversations.find((c) => c.id === id);
    pop.innerHTML =
      item("pin", convo?.pinned ? "Unpin" : "Pin") +
      item("rename", "Rename") +
      item("push", "Push to repo") +
      item("export-md", "Export .md") +
      item("export-json", "Export .json") +
      item("share", "Share .html") +
      item("delete", "Delete", "#ff6b8a");
    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 260)}px`;
    pop.style.left = `${Math.min(r.left, window.innerWidth - 170)}px`;
    pop.querySelectorAll("button").forEach((b) => {
      b.addEventListener("mouseenter", () => (b.style.background = "var(--surface-2)"));
      b.addEventListener("mouseleave", () => (b.style.background = "none"));
    });
    pop.querySelector('[data-a="pin"]').addEventListener("click", () => { pop.remove(); togglePin(id); });
    pop.querySelector('[data-a="rename"]').addEventListener("click", () => { pop.remove(); openRename(id); });
    pop.querySelector('[data-a="push"]').addEventListener("click", () => { pop.remove(); pushConversation(id); });
    pop.querySelector('[data-a="export-md"]').addEventListener("click", () => { pop.remove(); exportConversation(id, "md"); });
    pop.querySelector('[data-a="export-json"]').addEventListener("click", () => { pop.remove(); exportConversation(id, "json"); });
    pop.querySelector('[data-a="share"]').addEventListener("click", () => { pop.remove(); shareConversation(id); });
    pop.querySelector('[data-a="delete"]').addEventListener("click", () => { pop.remove(); deleteConversation(id); });
    setTimeout(() => {
      const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("click", close); } };
      document.addEventListener("click", close);
    }, 0);
  }

  // Fork a new conversation containing everything up to and including message m.
  function branchFrom(m) {
    if (state.streaming) return;
    const convo = activeConvo();
    if (!convo) return;
    const idx = convo.messages.findIndex((x) => x.id === m.id);
    if (idx === -1) return;
    const fork = {
      id: uid(),
      title: (convo.title || "Chat") + " (branch)",
      messages: convo.messages.slice(0, idx + 1).map((x) => ({ ...x, id: uid() })),
      createdAt: Date.now(), updatedAt: Date.now(),
      repo: convo.repo ? { ...convo.repo } : undefined,
    };
    state.conversations.unshift(fork);
    state.activeId = fork.id;
    saveActive(); saveConvos();
    renderConversations(); renderMessages(); updateRepoChip(); updateUsagePill();
    toast("Branched into a new conversation", "success");
  }

  function togglePin(id) {
    const c = state.conversations.find((x) => x.id === id);
    if (!c) return;
    c.pinned = !c.pinned;
    saveConvos();
    renderConversations();
    toast(c.pinned ? "Pinned" : "Unpinned");
  }

  function deleteConversation(id) {
    const idx = state.conversations.findIndex((c) => c.id === id);
    if (idx === -1) return;
    state.conversations.splice(idx, 1);
    if (state.activeId === id) {
      state.activeId = state.conversations[0]?.id || null;
      saveActive();
    }
    saveConvos();
    renderConversations();
    renderMessages();
    updateModelPill();
    toast("Conversation deleted");
  }

  function setSidebarHidden(hidden) {
    $("#app").classList.toggle("sidebar-hidden", hidden);
    $("#menu-btn").setAttribute("aria-expanded", String(!hidden));
    $("#sidebar").setAttribute("aria-hidden", String(hidden));
  }

  function selectConversation(id) {
    if (state.streaming) return;
    state.activeId = id;
    saveActive();
    treeCache = null; // repo may differ per conversation
    renderConversations();
    renderMessages();
    updateRepoChip();
    updateUsagePill();
    if (window.innerWidth <= 820) setSidebarHidden(true);
  }

  /* ============================================================
     Wiring / events
     ============================================================ */
  function bindEvents() {
    const input = $("#input");
    const composer = $("#composer");

    composer.addEventListener("submit", (e) => { e.preventDefault(); sendMessage(input.value); });

    input.addEventListener("input", () => { autoResize(input); updateCharCount(); updateSendState(); });
    input.addEventListener("keydown", (e) => {
      if (mentionEl || slashEl) return; // let the autocomplete handlers own the keys
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        if (!state.streaming) sendMessage(input.value);
      }
    });
    // paste images
    input.addEventListener("paste", (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const imgs = items.filter((it) => it.type.startsWith("image/")).map((it) => it.getAsFile()).filter(Boolean);
      if (imgs.length) { e.preventDefault(); handleFiles(imgs); }
    });

    $("#stop-btn").addEventListener("click", stopStreaming);

    // attachments
    $("#attach-btn").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });
    $("#attachments").addEventListener("click", (e) => {
      const id = e.target.closest("[data-remove]")?.dataset.remove;
      if (id) { state.attachments = state.attachments.filter((a) => a.id !== id); renderAttachments(); }
    });
    // drag & drop onto composer
    const wrap = $(".composer-wrap");
    ["dragover", "dragenter"].forEach((ev) => wrap.addEventListener(ev, (e) => { e.preventDefault(); }));
    wrap.addEventListener("drop", (e) => { e.preventDefault(); if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files); });

    // new chat
    $("#new-chat-btn").addEventListener("click", () => {
      if (state.streaming) return;
      // reuse an existing empty "New chat" if present at top
      const existingEmpty = state.conversations.find((c) => c.messages.length === 0);
      if (existingEmpty) { selectConversation(existingEmpty.id); }
      else { newConversation(); renderConversations(); renderMessages(); }
      updateModelPill();
      input.focus();
    });

    // conversation list interactions
    $("#conversation-list").addEventListener("click", (e) => {
      const menuBtn = e.target.closest("[data-menu]");
      if (menuBtn) { e.stopPropagation(); convMenu(menuBtn.dataset.menu, menuBtn); return; }
      const conv = e.target.closest(".conv");
      if (conv) selectConversation(conv.dataset.id);
    });
    $("#conversation-list").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { const conv = e.target.closest(".conv"); if (conv) selectConversation(conv.dataset.id); }
    });
    $("#search-input").addEventListener("input", renderConversations);

    // suggestions
    $("#suggestions").addEventListener("click", (e) => {
      const btn = e.target.closest(".suggestion");
      if (btn) { input.value = btn.dataset.prompt; autoResize(input); updateCharCount(); updateSendState(); input.focus(); }
    });

    // sidebar toggles
    $("#collapse-btn").addEventListener("click", () => setSidebarHidden(true));
    $("#menu-btn").addEventListener("click", () => setSidebarHidden(!$("#app").classList.contains("sidebar-hidden")));
    $("#main").addEventListener("click", (e) => {
      if (window.innerWidth <= 820 && e.target === $("#main") && !$("#app").classList.contains("sidebar-hidden")) {
        setSidebarHidden(true);
      }
    });

    // theme
    $("#theme-btn").addEventListener("click", toggleTheme);

    // model pill -> open settings
    $("#model-pill").addEventListener("click", openSettings);

    // settings modal
    $("#settings-btn").addEventListener("click", openSettings);
    $("#settings-close").addEventListener("click", closeSettings);
    $("#settings-save").addEventListener("click", saveSettingsFromModal);
    $("#settings-overlay").addEventListener("click", (e) => { if (e.target.id === "settings-overlay") closeSettings(); });
    $("#set-temp").addEventListener("input", (e) => ($("#temp-val").textContent = Number(e.target.value).toFixed(2)));
    $("#reveal-key").addEventListener("click", () => {
      const el = $("#set-apikey"); el.type = el.type === "password" ? "text" : "password";
    });
    $("#set-model").addEventListener("change", () => { $("#set-model-custom").value = ""; });
    $("#set-autosteps").addEventListener("input", (e) => ($("#autosteps-val").textContent = e.target.value));
    $("#reveal-ghtoken").addEventListener("click", () => {
      const el = $("#set-ghtoken"); el.type = el.type === "password" ? "text" : "password";
    });
    $("#gh-test").addEventListener("click", (e) => testGithubConnection(e.currentTarget));
    $("#ai-test").addEventListener("click", (e) => testAiConnection(e.currentTarget));

    // topbar: quick Autonomous toggle
    $("#auto-toggle").addEventListener("click", () => {
      if (state.autoRunning) return;
      state.settings.autonomous = !state.settings.autonomous;
      saveSettings();
      updateAutoPill();
      toast(state.settings.autonomous ? "Autonomous mode ON" : "Autonomous mode off", state.settings.autonomous ? "success" : "");
    });

    // topbar: push current chat to GitHub
    $("#push-btn").addEventListener("click", () => {
      const c = activeConvo();
      if (!c) { toast("Open a conversation first.", "error"); return; }
      pushConversationToGitHub(c.id);
    });

    // composer: repository picker
    $("#repo-chip").addEventListener("click", (e) => {
      if (e.target.closest("#repo-chip-clear")) return; // handled below
      if (repoPickerEl) closeRepoPicker();
      else openRepoPicker($("#repo-chip"));
    });
    $("#repo-chip-clear").addEventListener("click", (e) => { e.stopPropagation(); clearRepo(); });
    $("#files-btn").addEventListener("click", () => {
      if (filesPickerEl) closeFilesPicker(); else openFilesPicker($("#files-btn"));
    });
    // @file mention + slash-command autocomplete
    input.addEventListener("input", () => { maybeMention(input); maybeSlash(input); });
    input.addEventListener("keydown", (e) => {
      if (mentionEl) {
        if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); moveMention(e.key === "ArrowDown" ? 1 : -1); }
        else if (e.key === "Enter" && !e.shiftKey) { const a = mentionEl.querySelector(".repo-item.active"); if (a) { e.preventDefault(); a.click(); } }
        else if (e.key === "Escape") { closeMention(); }
      } else if (slashEl) {
        const items = [...slashEl.querySelectorAll(".repo-item")];
        let idx = items.findIndex((x) => x.classList.contains("active"));
        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
          e.preventDefault();
          items[idx]?.classList.remove("active");
          idx = (idx + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
          items[idx]?.classList.add("active");
        } else if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); (items[idx] || items[0])?.click(); }
        else if (e.key === "Escape") { closeSlash(); }
      }
    });

    // account + admin
    $("#logout-btn").addEventListener("click", logout);
    $("#account-name").addEventListener("click", changeOwnPassword);
    $("#admin-btn").addEventListener("click", openAdmin);
    $("#admin-close").addEventListener("click", closeAdmin);
    $("#admin-overlay").addEventListener("click", (e) => { if (e.target.id === "admin-overlay") closeAdmin(); });
    $("#admin-add-btn").addEventListener("click", adminAddUser);

    // powers modal
    $("#powers-btn").addEventListener("click", openPowers);
    $("#powers-close").addEventListener("click", closePowers);
    $("#powers-overlay").addEventListener("click", (e) => { if (e.target.id === "powers-overlay") closePowers(); });
    $("#powers-search-input").addEventListener("input", renderPowers);
    $$(".powers-tab").forEach((t) => t.addEventListener("click", () => {
      powersScope = t.dataset.scope;
      $$(".powers-tab").forEach((x) => x.classList.toggle("active", x === t));
      renderPowers();
    }));

    // voice input + context basket + profiles
    $("#mic-btn").addEventListener("click", toggleVoice);
    $("#basket-chip").addEventListener("click", clearBasket);
    $("#profile-save").addEventListener("click", saveCurrentProfile);
    $("#clear-current").addEventListener("click", () => {
      const c = activeConvo(); if (c) { c.messages = []; c.title = "New chat"; touchConvo(c); renderMessages(); renderConversations(); }
      closeSettings(); toast("Chat cleared");
    });
    $("#delete-all").addEventListener("click", () => {
      if (!confirm("Delete ALL conversations? This cannot be undone.")) return;
      state.conversations = []; state.activeId = null; saveConvos(); saveActive();
      renderConversations(); renderMessages(); closeSettings(); toast("All conversations deleted");
    });

    // rename modal
    $("#rename-save").addEventListener("click", saveRename);
    $("#rename-cancel").addEventListener("click", closeRename);
    $("#rename-overlay").addEventListener("click", (e) => { if (e.target.id === "rename-overlay") closeRename(); });
    $("#rename-input").addEventListener("keydown", (e) => { if (e.key === "Enter") saveRename(); if (e.key === "Escape") closeRename(); });

    // scroll
    $("#chat").addEventListener("scroll", updateScrollBtn);
    $("#scroll-bottom").addEventListener("click", () => scrollToBottom(true));

    // global keys
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") { closeSettings(); closeRename(); closeRepoPicker(); closeFilesPicker(); closeMention(); closeSlash(); closePalette(); closePowers(); closeAdmin(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); toggleFindBar(true); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); $("#new-chat-btn").click(); }
    });

    // find bar
    $("#find-input").addEventListener("input", runFind);
    $("#find-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); focusFind(findIndex + (e.shiftKey ? -1 : 1)); }
      if (e.key === "Escape") toggleFindBar(false);
    });
    $("#find-next").addEventListener("click", () => focusFind(findIndex + 1));
    $("#find-prev").addEventListener("click", () => focusFind(findIndex - 1));
    $("#find-close").addEventListener("click", () => toggleFindBar(false));
    $("#find-btn").addEventListener("click", () => toggleFindBar());

    // import
    $("#import-input").addEventListener("change", (e) => { importFromFile(e.target.files[0]); e.target.value = ""; });

    // personas + autoPush + gitlab reveal
    $("#persona-save").addEventListener("click", saveCurrentPersona);
    $("#reveal-gltoken").addEventListener("click", () => {
      const el = $("#set-gltoken"); el.type = el.type === "password" ? "text" : "password";
    });
    $("#gl-test").addEventListener("click", (e) => testGitlabConnection(e.currentTarget));
  }

  /* ============================================================
     Init
     ============================================================ */
  async function init() {
    // theme first (avoid flash)
    applyTheme(localStorage.getItem(LS.theme) || "dark");

    // ---- Auth gate: if auth is enabled and we're not signed in, go to login ----
    let authEnabled = true;
    try {
      const h = await fetch("/api/health");
      if (h.ok) authEnabled = (await h.json()).authEnabled !== false;
    } catch { authEnabled = false; } // server unreachable — let the app surface the error later
    if (authEnabled) {
      try {
        const r = await fetch("/api/auth/me");
        if (r.ok) { state.user = (await r.json()).user; applyScope(state.user.id); }
        else { location.replace("/login.html"); return; }
      } catch { location.replace("/login.html"); return; }
    }

    loadState();

    // fetch server config
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const config = await res.json();
        state.config = {
          ...state.config,
          ...config,
          models: Array.isArray(config.models) && config.models.length ? config.models : DEFAULT_MODELS,
        };
      }
    } catch {
      toast("Could not reach the MAX server.", "error");
    }

    bindEvents();

    // sidebar default state on mobile
    if (window.innerWidth <= 820) setSidebarHidden(true);

    // ensure there is an active conversation reference (but don't force-create)
    if (state.activeId && !activeConvo()) state.activeId = state.conversations[0]?.id || null;

    renderAccount();
    updateModelPill();
    updateKeyStatus();
    updateAutoPill();
    updateRepoChip();
    renderConversations();
    renderMessages();
    updateCharCount();
    updateSendState();
    updateUsagePill();
    renderBasket();

    // Register the service worker for installability + offline shell.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    // first-run nudge if no key at all
    if (!state.config.hasServerKey && !state.settings.apiKey) {
      setTimeout(() => toast("Add your AgentRouter API key in Settings to start chatting.", ""), 700);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
