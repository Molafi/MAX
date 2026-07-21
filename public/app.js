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

  const SESSION_KEY = "max.apiKey.session.v1";
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
    config: { defaultModel: "claude-opus-4-8", models: DEFAULT_MODELS, allowClientKey: true, hasServerKey: false },
    settings: {
      apiKey: "",
      model: "",
      system: "You are MAX, a helpful, friendly and concise AI assistant. Use Markdown for formatting when helpful.",
      maxTokens: 4096,
      temperature: 1.0,
    },
    conversations: [],
    activeId: null,
    attachments: [], // {id, media_type, dataUrl}
    streaming: false,
    abort: null,
    renameId: null,
  };

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
        // Migrate keys saved by older versions out of persistent localStorage.
        if (typeof s.apiKey === "string" && s.apiKey) {
          safeStorageSet(sessionStorage, SESSION_KEY, s.apiKey);
          delete s.apiKey;
          safeStorageSet(localStorage, LS.settings, JSON.stringify(s));
        }
        Object.assign(state.settings, s);
      }
      state.settings.apiKey = sessionStorage.getItem(SESSION_KEY) || "";
    } catch {}
    state.activeId = localStorage.getItem(LS.active) || null;
  }
  const saveConvos = () => safeStorageSet(localStorage, LS.convos, JSON.stringify(state.conversations), "Conversation history");
  const saveSettings = () => {
    const { apiKey, ...persistentSettings } = state.settings;
    safeStorageSet(localStorage, LS.settings, JSON.stringify(persistentSettings), "Settings");
    if (apiKey) safeStorageSet(sessionStorage, SESSION_KEY, apiKey, "API key");
    else {
      try { sessionStorage.removeItem(SESSION_KEY); } catch {}
    }
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
    let convos = [...state.conversations].sort((a, b) => b.updatedAt - a.updatedAt);
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
    for (const c of convos) {
      const g = groupLabel(c.updatedAt);
      if (g !== lastGroup) { html += `<div class="conv-group-label">${g}</div>`; lastGroup = g; }
      const active = c.id === state.activeId ? " active" : "";
      html += `
        <div class="conv${active}" data-id="${c.id}" role="button" tabindex="0">
          <span class="conv__title">${esc(c.title)}</span>
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

    const avatar = `<div class="msg__avatar">${role_short(m.role)}</div>`;
    const roleName = m.role === "user" ? "You" : "MAX";

    const bubble = document.createElement("div");
    bubble.className = "msg__bubble";
    if (m.role === "assistant") {
      bubble.classList.add("md");
      bubble.innerHTML = renderMarkdown(m.content);
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

    if (m.role === "user") {
      const editBtn = actionBtn("edit", `<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 013 3L7 19l-4 1 1-4z"/>`, "Edit");
      editBtn.addEventListener("click", () => beginEdit(m));
      actions.appendChild(editBtn);
    } else {
      const regenBtn = actionBtn("regen", `<path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/>`, "Regenerate");
      regenBtn.addEventListener("click", () => regenerate(m));
      actions.appendChild(regenBtn);

      if (m.usage) {
        const u = document.createElement("span");
        u.className = "msg__usage";
        u.textContent = `${m.usage.input_tokens ?? "?"} in · ${m.usage.output_tokens ?? "?"} out`;
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
    return {
      row,
      bubble: row.querySelector(".msg__bubble"),
      setText(text, withCursor) {
        this.bubble.innerHTML = renderMarkdown(text) + (withCursor ? '<span class="cursor-blink"></span>' : "");
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

  async function sendMessage(text) {
    if (state.streaming) return;
    text = text.trim();
    const imgs = state.attachments.slice();
    if (!text && imgs.length === 0) return;

    let convo = activeConvo();
    if (!convo) convo = newConversation();

    const userMsg = {
      id: uid(), role: "user", content: text,
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

    await streamAssistant(convo);
  }

  async function streamAssistant(convo) {
    state.streaming = true;
    toggleStreamingUI(true);

    const stream = appendStreamingAssistant();
    let acc = "";
    let usage = null;
    let gotFirst = false;

    state.abort = new AbortController();

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: state.abort.signal,
        body: JSON.stringify({
          model: currentModel(),
          system: state.settings.system || undefined,
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
              stream.setText(acc, true);
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
      stream.setText(acc, false);
      const aiMsg = { id: uid(), role: "assistant", content: acc, usage };
      convo.messages.push(aiMsg);
      touchConvo(convo);
      renderMessages();
      renderConversations();
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
        stream.bubble.classList.remove("md");
        stream.bubble.innerHTML = `<div style="color:#ff6b8a">⚠ ${esc(err.message)}</div>`;
        toast(err.message, "error");
      }
    } finally {
      state.streaming = false;
      state.abort = null;
      toggleStreamingUI(false);
    }
  }

  function stopStreaming() {
    if (state.abort) state.abort.abort();
  }

  async function regenerate(aiMsg) {
    if (state.streaming) return;
    const convo = activeConvo();
    if (!convo) return;
    const idx = convo.messages.findIndex((m) => m.id === aiMsg.id);
    if (idx === -1) return;
    // remove this assistant message (and anything after it)
    convo.messages.splice(idx);
    touchConvo(convo);
    renderMessages();
    await streamAssistant(convo);
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
    $("#send-btn").disabled = !hasText || state.streaming;
  }
  function toggleStreamingUI(on) {
    $("#stop-btn").hidden = !on;
    $("#send-btn").hidden = on;
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
    saveSettings();
    updateModelPill();
    updateKeyStatus();
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
    pop.innerHTML = `
      <button data-a="rename" style="display:flex;gap:8px;width:100%;padding:8px 10px;background:none;border:none;color:var(--text);border-radius:7px;text-align:left">Rename</button>
      <button data-a="delete" style="display:flex;gap:8px;width:100%;padding:8px 10px;background:none;border:none;color:#ff6b8a;border-radius:7px;text-align:left">Delete</button>`;
    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    pop.style.top = `${r.bottom + 6}px`;
    pop.style.left = `${Math.min(r.left, window.innerWidth - 170)}px`;
    pop.querySelectorAll("button").forEach((b) => {
      b.addEventListener("mouseenter", () => (b.style.background = "var(--surface-2)"));
      b.addEventListener("mouseleave", () => (b.style.background = "none"));
    });
    pop.querySelector('[data-a="rename"]').addEventListener("click", () => { pop.remove(); openRename(id); });
    pop.querySelector('[data-a="delete"]').addEventListener("click", () => { pop.remove(); deleteConversation(id); });
    setTimeout(() => {
      const close = (e) => { if (!pop.contains(e.target)) { pop.remove(); document.removeEventListener("click", close); } };
      document.addEventListener("click", close);
    }, 0);
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
    renderConversations();
    renderMessages();
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
      if (e.key === "Escape") { closeSettings(); closeRename(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); $("#search-input").focus(); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); $("#new-chat-btn").click(); }
    });
  }

  /* ============================================================
     Init
     ============================================================ */
  async function init() {
    // theme first (avoid flash)
    applyTheme(localStorage.getItem(LS.theme) || "dark");

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

    updateModelPill();
    updateKeyStatus();
    renderConversations();
    renderMessages();
    updateCharCount();
    updateSendState();

    // first-run nudge if no key at all
    if (!state.config.hasServerKey && !state.settings.apiKey) {
      setTimeout(() => toast("Add your AgentRouter API key in Settings to start chatting.", ""), 700);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
