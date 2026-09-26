# MAX — Premium AI Chat

<p align="center">
  <img src="public/favicon.svg" width="88" alt="MAX logo" />
</p>

**MAX** is a polished, premium chat interface for 40 AI models through two providers:
[CodeCraft API](https://codecraftapi.com) (OpenAI‑compatible: Claude Opus 5, GPT‑5.6, Gemini 3.x,
DeepSeek V4, Qwen, Kimi, GLM, Grok, Seed, Muse…) and [AgentRouter](https://agentrouter.org)
(Anthropic‑compatible). Use either one, or both at once.

It ships as a **zero‑dependency Node server** (no `npm install` needed) plus a fast,
hand‑built vanilla frontend. Your API key stays on the server — the browser never has to
hold it (though you *can* enter your own key in Settings if you prefer).

---

## 🆕 What's new in 2.0

- **Two providers, 40 models.** Pick any model from the top‑bar picker (search, provider tabs,
  capability icons, ⌘/Ctrl+M). MAX converts requests and streams so every feature (tools,
  vision, reasoning, repo editing) works on both. **Refresh model list** pulls new models from the provider.
- **Reasoning effort panel** (Low · Medium · High · xHigh · Max) in the composer. Sent as
  `reasoning_effort` to CodeCraft and as Claude's extended‑thinking budget to AgentRouter.
- **Capability chips** (Reasoning · Vision · Tools · Streaming · JSON) for the selected model;
  click **JSON** to force JSON output.
- **Automatic compatibility fallback.** If a model rejects an optional parameter (effort,
  temperature, stream options, JSON mode), MAX drops that parameter and retries on its own, so you don't get an error.
- **Reads every file type.** Images are resized and converted automatically; **PDF** text is extracted (scanned
  pages are sent as images); **Word/Excel/PowerPoint/OpenDocument**; **ZIP** archives (file list and text
  contents); **videos** (key frames plus duration); notebooks, code, logs, CSV. You can drop files anywhere on the window.
- **Video maker.** Type `/video <idea>` (or use the 🎬 Video tab). MAX writes a 1280×720 canvas
  animation and records it to a **WebM/MP4** you can download. Any canvas code block also gets a 🎬 Video button.
- **Faster GitHub connection.** Lists all your repos (up to 1,000). You can type `owner/name` to
  open any public repo. Includes a branch switcher and a "connected as" status. Data is refreshed on every new chat and
  when you come back to the tab. GitHub ETag caching makes these refreshes nearly free. Files over 1 MB now load, and all
  edits go into **one atomic commit**. GitLab now pages through large trees too.
- **No more lag.** Streaming paints at most once per frame, and syntax highlighting waits until the answer finishes.
  The background animation is lighter, and a **Performance mode** switch turns it off entirely.
- **Safe live previews.** Model‑generated HTML now runs in an isolated sandbox page. It used to be blocked by
  the app's own security policy. If the preview hits an error, **Ask MAX to fix it** sends the error back to the model.

## ✨ Features

**Chat core**
- Streaming responses (word‑by‑word), typing indicator, and a **Stop** button
- Full conversation history sent on every request (the model gets context)
- Enter to send · Shift+Enter for a newline · live character counter

**Conversations**
- New chat, searchable history sidebar, **rename / delete / resume**
- Everything stored locally in your browser (`localStorage`)

**Rich rendering**
- Markdown (bold, lists, tables, quotes, links)
- Syntax‑highlighted code blocks with one‑click **Copy**
- **Live preview panel** — click **▶ Run** on any HTML / SVG / CSS / React / Mermaid code
  block to render it in a sandboxed iframe, go **fullscreen**, open in a new tab, download
  the source, or **Save as PNG** (great for exporting a generated chart or diagram)
- Copy any message, **regenerate** the last answer, **edit** a previous message & re‑run
- Per‑message **token usage** (input / output)

**Polish**
- Premium UI with an animated **“L” logo** and a live motion‑graphics background
- Dark / light theme toggle
- Fully mobile‑responsive
- Image upload (drag‑drop, paste, or picker) sent as base64 for vision models

**Autonomous mode**
- Flip **Auto** on (topbar pill or Settings) and MAX works through a task over
  multiple steps on its own, auto‑continuing until it's done (or you hit **Stop**)
- Configurable step limit; finishes when the model emits its completion marker

**GitHub & GitLab integration**
- **Pick a repository** from a searchable list of your repos (the chip next to the
  composer) so MAX knows which project you're working in — passed to the model as context
- **Read your code:** browse the repo file tree and insert any file into the chat, or type
  `@` to fuzzy‑search files and pull one in
- **Push any conversation** to the selected repo as a Markdown file (create or update)
- **Per‑conversation repo binding** — each chat remembers its own repository
- Works with both **GitHub and GitLab**; tokens are proxied server‑side, never in `localStorage`

**Agentic editing (read → edit → commit → PR)**
- Ask MAX to change code; it proposes full files, you get a **diff preview**, then
  **commit to a new branch and open a PR (GitHub) or MR (GitLab)** — with your approval
- **Context basket** — stage multiple repo files and send them together
- **Summarize the repo** from its file tree (`/summarize` or the palette)

**Accounts & administration**
- **Login page** with secure sessions (scrypt‑hashed passwords, HMAC‑signed httpOnly cookies)
- A **super admin** who can **add users, monitor them** (created / last login / login count / status),
  **enable or disable** accounts, **reset passwords**, and delete users — all from an in‑app panel
- Each user's chats are **isolated per account** in the browser; **logout** and **change‑password** built in
- Disable auth entirely with `AUTH_ENABLED=false` for single‑user local use

**Powers (integrations gallery)**
- A browsable, searchable catalog (All / Official / Community tabs, category sidebar) — open it
  from the sidebar **Powers** button or the command palette
- Two powers **work out of the box**: **Web Fetch** (`/fetch <url>`, no key, SSRF‑guarded) pulls a
  page's text into the chat, and **Web Search** (`/search <query>`, Tavily key) adds top results
- Installed powers add slash commands and are advertised to the model; other entries are honest
  catalog stubs you can wire to their real backends

**More**
- **Persona library** — save reusable system prompts and apply them in one click
- **API profiles** — save key + model combos and switch quickly
- **Voice input** (mic) and **read‑aloud** of replies
- **Slash commands** (`/summarize`, `/files`, `/repo`, `/explain`, `/test`, `/share`, `/clear`)
- **Streaming "thinking"** display when the model exposes reasoning
- **Branch a conversation** from any message; **request log**; **retry** on transient errors
- **Cost guardrail** before autonomous runs; shareable **read‑only HTML export**
- **Token + cost estimate** per conversation, shown live in the top bar
- **Find in conversation** (Ctrl/⌘+F) with match highlighting and next/prev
- **Pin** important chats; **import** exported `.json` chats; **regenerate** the last answer
  with a different model
- **Command palette** (Ctrl/⌘+K) for quick actions
- **Installable PWA** with an offline app shell

**Export**
- Download any conversation as **Markdown** or **JSON** from its ⋯ menu

**Backend**
- Small proxy that keeps your key secret + relays the streaming response
- Per‑IP rate limiting (configurable)
- Model switcher, system prompt, `max_tokens`, and `temperature` controls
- `/api/health` and a **Test AI provider** button for quick diagnostics

---

## 🚀 Run it locally

### 1. Prerequisites
- **Node.js 18 or newer** (Node 20/22 recommended). Check with:
  ```bash
  node -v
  ```
  If you don't have Node, grab it from [nodejs.org](https://nodejs.org).

### 2. Get the code
If you cloned this repo, just `cd` into it:
```bash
cd MAX
```

### 3. Add your API key(s)
Get a key from **[codecraftapi.com](https://codecraftapi.com)** (API Keys) and/or
**[agentrouter.org/console/token](https://agentrouter.org/console/token)**.

Copy the example env file and paste your key(s) in:
```bash
cp .env.example .env
```
```env
CODECRAFT_API_KEY=sk-your-codecraft-key
AGENTROUTER_API_KEY=sk-your-agentrouter-key
```
> Prefer not to use a `.env` file? You can skip this and instead paste your key into
> **Settings → AI providers** inside the app. Keys are stored only in your browser: for the current tab by default, or
> permanently if you turn on "Remember keys on this device".

### 4. Start the server
No dependencies to install. Just run:
```bash
npm start
```
or equivalently:
```bash
node server.js
```

You'll see:
```
┌────────────────────────────────────────────────────┐
│  MAX is running
│  ▶  http://localhost:8787
└────────────────────────────────────────────────────┘
```

### 5. Open it
Visit **http://localhost:8787** in your browser and start chatting. 🎉

---

## ⚙️ Configuration

All settings live in `.env` (see `.env.example`):

| Variable               | Default                     | Description                                             |
|------------------------|-----------------------------|---------------------------------------------------------|
| `CODECRAFT_API_KEY`    | *(empty)*                   | CodeCraft key. Kept server‑side.                        |
| `CODECRAFT_BASE_URL`   | `https://codecraftapi.com/v1` | Server calls `${BASE_URL}/chat/completions`.          |
| `AGENTROUTER_API_KEY`  | *(empty)*                   | AgentRouter key. Kept server‑side.                      |
| `AGENTROUTER_BASE_URL` | `https://agentrouter.org`   | Server calls `${BASE_URL}/v1/messages`.                 |
| `DEFAULT_PROVIDER`     | `codecraft`                 | `codecraft` or `agentrouter`.                           |
| `DEFAULT_MODEL`        | `claude-opus-5`             | Model used when the UI doesn't pick one.                |
| `PORT`                 | `8787`                      | Local port.                                             |
| `ALLOW_CLIENT_KEY`     | `true`                      | Let users supply their own key in Settings.             |
| `RATE_LIMIT_PER_MIN`   | `60`                        | Per‑IP request cap per minute (`0` disables).           |
| `GITHUB_TOKEN`         | *(empty)*                   | Optional server‑side GitHub token (else supply in UI).  |
| `GITHUB_OWNER` / `GITHUB_REPO` / `GITHUB_BRANCH` | *(empty)* / *(empty)* / `main` | Default push target.                   |
| `ALLOW_CLIENT_GITHUB_TOKEN` | `true`                 | Let users supply their own GitHub token in Settings.    |

You can also change the **model, system prompt, temperature, and max tokens** at any time
from the ⚙️ **Settings** panel in the app.

---

## 🧠 How it works

```
                                         ┌──/chat/completions──▶ CodeCraft (OpenAI format, translated)
Browser ──POST /api/chat──▶ server.js ───┤
   ▲                                     └──/v1/messages──────▶ AgentRouter (Anthropic format)
   └──────── Anthropic-style SSE stream ◀── (lib/providers.js converts OpenAI chunks) ──┘
```

- The browser sends the conversation to the local server.
- `server.js` attaches your secret key and forwards the request to AgentRouter's
  Anthropic‑compatible `/v1/messages` endpoint.
- The streaming response is piped straight back to the browser and rendered live.

---

## 🤖 Autonomous mode

Turn on **Auto** (the topbar pill, or Settings → Autonomous mode). Now when you
send a task, MAX plans and executes it over several turns automatically, showing
`Auto · step N/max` while it works. It stops when the task is complete, when it
reaches the step limit, or when you press **Stop**. Adjust the step cap in Settings.

## 🐙 Push chats to GitHub

1. Create a token at **GitHub → Settings → Developer settings → Personal access tokens**
   with the **`repo`** scope (classic) or **Contents: Read and write** (fine‑grained).
2. Open MAX **Settings → GitHub**, paste the token. Click **Test connection**.
3. Click the **repository chip** beside the message box to open a searchable list of
   your repos and pick the one MAX should work in (it becomes the push target and is
   added to the model's context). You can also set owner/repo manually in Settings.
4. Push a conversation via the **GitHub icon** in the topbar, or a conversation's
   **⋯ → Push to GitHub**. It's saved as `‹folder›/‹title›-‹id›.md` (created or updated).

> Your token is sent to the local MAX server only to make the GitHub call; it is
> kept in `sessionStorage` (cleared when you close the tab), never in `localStorage`.

## 🔐 Accounts & the super admin

MAX ships with **login enabled by default**. On first run it creates a super admin:

- Set `SUPERADMIN_USERNAME` / `SUPERADMIN_PASSWORD` in `.env` to choose the credentials, **or**
- leave `SUPERADMIN_PASSWORD` blank and MAX prints a generated password in the server console once.

**Forgot the password (or username)?** Set `SUPERADMIN_USERNAME` and `SUPERADMIN_PASSWORD`
in `.env` and restart — those values are authoritative and are applied on every startup
(the account is created or its password/role reset to match), so you can't get locked out.

Sign in at `/login.html`. As the super admin, open **Manage users** (the people icon by your name in
the sidebar, or ⌘K → "Manage users") to add accounts, watch activity, enable/disable users, and reset
passwords. Users change their own password by clicking their name in the sidebar.

Prefer the old single‑user experience? Set `AUTH_ENABLED=false` and there's no login at all.

> User records and the session secret live in `./data/` (gitignored). Passwords are scrypt‑hashed;
> sessions are HMAC‑signed httpOnly cookies. Run behind HTTPS in production.

## 🛠️ Troubleshooting

- **“No API key configured”** — Set `AGENTROUTER_API_KEY` in `.env` *or* enter a key in Settings.
- **401 / auth error** — Your key is invalid or out of credits. Generate a new one at
  [agentrouter.org/console/token](https://agentrouter.org/console/token).
- **"Could not reach the AI provider" / `fetch failed`** — AgentRouter only accepts
  requests that look like the Claude CLI, so MAX sends
  `User-Agent: claude-cli/2.0.0 (external, cli)` by default. If you changed
  `UPSTREAM_USER_AGENT` or `AGENTROUTER_BASE_URL`, revert them. Also confirm the
  machine running the server has outbound internet access; the exact cause (e.g.
  `ENOTFOUND`, `ECONNREFUSED`) is now printed in the server console.
- **Model not found** — Pick a different model in Settings, or type a valid custom model id.
- **Port already in use** — Change `PORT` in `.env` (e.g. `PORT=3000`).
- **Code blocks / markdown not styled** — Those libraries load from a CDN; make sure you
  have internet access on first load.

---

## 📁 Project structure

```
MAX/
├── server.js          # Zero-dependency Node proxy + static file server
├── lib/
│   ├── providers.js   # OpenAI ⇄ Anthropic request/stream translation + fallbacks
│   └── models.js      # Model catalog (provider, capabilities)
├── package.json
├── .env.example       # Copy to .env and add your key
└── public/
    ├── index.html     # App markup
    ├── styles.css     # Premium theming, animations, responsive layout
    ├── app.js         # Chat logic, streaming, conversation management
    ├── bg.js          # Animated constellation background
    ├── files.js       # Universal file reader (PDF, Office, ZIP, video, images…)
    ├── sandbox.html   # Isolated runner for previews + video recording
    ├── sw.js          # Service worker (offline app shell)
    ├── manifest.webmanifest  # PWA manifest
    └── favicon.svg    # The "L" logo
```

---

## 🔒 Security notes
- Never commit your `.env` — it's already in `.gitignore`.
- The proxy keeps your key off the client when you use the server key.
- Rate limiting is a basic in‑memory guard; put a real reverse proxy in front for production.

---

Built with ❤️ — no frameworks, no build step, just fast web fundamentals.
