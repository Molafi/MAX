# MAX — Premium AI Chat

<p align="center">
  <img src="public/favicon.svg" width="88" alt="MAX logo" />
</p>

**MAX** is a polished, premium chat interface for talking to AI models through
[AgentRouter](https://agentrouter.org) (an Anthropic‑compatible gateway that gives you
access to Claude, GPT, DeepSeek, GLM and more behind one key).

It ships as a **zero‑dependency Node server** (no `npm install` needed) plus a fast,
hand‑built vanilla frontend. Your API key stays on the server — the browser never has to
hold it (though you *can* enter your own key in Settings if you prefer).

---

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

### 3. Add your API key
Get a key from **https://agentrouter.org/console/token** (it looks like `sk-...`).

Copy the example env file and paste your key in:
```bash
cp .env.example .env
```
Then open `.env` and set:
```env
AGENTROUTER_API_KEY=sk-your-real-key-here
```
> Prefer not to use a `.env` file? You can skip this and instead paste your key into
> **Settings** inside the app — it will be stored only in your browser.

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
| `AGENTROUTER_API_KEY`  | *(empty)*                   | Your AgentRouter key. Kept server‑side.                 |
| `AGENTROUTER_BASE_URL` | `https://agentrouter.org`   | Upstream base. Server calls `${BASE_URL}/v1/messages`.  |
| `DEFAULT_MODEL`        | `claude-sonnet-4-6`         | Model used when the UI doesn't pick one.                |
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
Browser (public/)  ──POST /api/chat──▶  server.js  ──/v1/messages──▶  AgentRouter
      ▲                                    │                              │
      └────────── SSE stream ◀─────────────┴──────── SSE stream ◀─────────┘
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
├── package.json
├── .env.example       # Copy to .env and add your key
└── public/
    ├── index.html     # App markup
    ├── styles.css     # Premium theming, animations, responsive layout
    ├── app.js         # Chat logic, streaming, conversation management
    ├── bg.js          # Animated constellation background
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
