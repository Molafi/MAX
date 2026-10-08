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
  let CC_SESSION_KEY = "max.ccKey.session.v1";
  const DONE_MARKER = "[[MAX_DONE]]";

  /* ---------- Fix #1: Standalone Chat Mode - repo 100% OPTIONAL ---------- */
  function updateStandaloneBadge(){
    const hasRepo = !!((state.settings.github && state.settings.github.owner && state.settings.github.repo) || (state.settings.gitlab && state.settings.gitlab.token));
    let badge = document.getElementById("standalone-badge");
    if(!hasRepo){
      if(!badge){
        const c = document.querySelector(".topbar__center");
        if(c){
          badge=document.createElement("span");
          badge.id="standalone-badge";
          badge.textContent="Standalone Chat Mode";
          badge.style.cssText="font-size:11px;padding:3px 8px;border-radius:999px;background:rgba(52,211,153,.15);color:#34d399;border:1px solid rgba(52,211,153,.3);margin-left:8px";
          c.appendChild(badge);
        }
      }
      if(badge) badge.hidden=false;
    } else if(badge) badge.hidden=true;
    const cb=document.getElementById("commit-btn"), pb=document.getElementById("push-btn"), tb=document.getElementById("tree-btn");
    if(cb) cb.disabled=!hasRepo;
    if(pb) pb.disabled=!hasRepo;
    // Never disable composer/model picker when repo=null - standalone chat must work
    const sb=document.getElementById("send-btn"), inp=document.getElementById("input"), mp=document.getElementById("model-pill");
    if(inp) inp.disabled=false;
    if(mp) mp.disabled=false;
    try{ if(typeof updateSendState==="function") updateSendState(); }catch{}
  }
  try{ document.addEventListener("DOMContentLoaded", ()=>{ updateStandaloneBadge(); setTimeout(updateStandaloneBadge,800); }); setInterval(updateStandaloneBadge,1500);}catch{}
  /* ---------- Fix #9: listing timeout helper — never hang spinner >15s ---------- */
  const LISTING_TIMEOUT_MS = 15000;
  function withListingTimeout(promise, ms = LISTING_TIMEOUT_MS, controller) {
    let t;
    const timeout = new Promise((_, rej) => {
      t = setTimeout(() => {
        try { controller?.abort(); } catch {}
        rej(new Error("Listing timed out after " + ms + "ms"));
      }, ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
  }
  function clearListingSpinner() {
    const el = document.getElementById("tree-content");
    if (el && el.querySelector(".spinner")) {
      const sp = el.querySelector(".spinner");
      if (sp) sp.remove();
    }
    const btn = document.getElementById("tree-btn");
    if (btn) btn.disabled = false;
  }
  // Global failsafe: if #tree-content ever shows a spinner for >15s, auto-clear it
  // and show a retry prompt. This works even if the original loadTree() forgets
  // to clear on error/timeout — MAX's autonomous loop keeps running unaffected.
  let _listingTimer = null;
  function armListingFailsafe() {
    clearTimeout(_listingTimer);
    _listingTimer = setTimeout(() => {
      const el = document.getElementById("tree-content");
      if (!el) return;
      const spinning = el.querySelector(".spinner, [class*='spin'], .loading");
      if (!spinning) return;
      clearListingSpinner();
      if (!el.querySelector(".listing-retry")) {
        const retry = document.createElement("div");
        retry.className = "listing-retry";
        retry.style.cssText = "padding:16px;text-align:center;color:var(--text-muted);font-size:13px";
        retry.innerHTML = `<p>Listing failed or timed out.</p><button class="btn btn--primary btn--sm" onclick="window.__maxRetryListing&&window.__maxRetryListing()">[Failed - Retry]</button>`;
        el.appendChild(retry);
      }
      const label = document.getElementById("tree-status");
      if (label) label.textContent = "Listing timed out — click Retry";
    }, LISTING_TIMEOUT_MS);
  }
  function disarmListingFailsafe() { clearTimeout(_listingTimer); clearListingSpinner(); }
  // Hook into tree overlay open/close if present
  document.addEventListener("click", (e) => {
    if (e.target.closest("#tree-btn")) armListingFailsafe();
    if (e.target.closest("#tree-close")) disarmListingFailsafe();
  });
  // Expose for manual retry from retry button or console
  try { window.__maxRetryListing = () => location.reload(); } catch {}

  /* ---------- Skills catalog ---------- */
  const SKILLS_CATALOG = [
    {
      id: "senior-engineer",
      name: "Senior Engineer",
      icon: "👨‍💻",
      category: "Coding",
      description: "Write production-grade code with best practices, error handling, types, and tests.",
      prompt: `You are a senior software engineer with 15+ years of experience. Follow these principles:
- Write clean, production-ready code with proper error handling, types, and edge cases
- Follow SOLID principles, DRY, and separation of concerns
- Include JSDoc/docstrings for public APIs
- Suggest tests when writing new functions
- Prefer composition over inheritance
- Use meaningful variable/function names that serve as documentation
- Handle errors gracefully — never silently swallow them
- Consider performance, security, and maintainability in every decision`,
    },
    {
      id: "code-reviewer",
      name: "Code Reviewer",
      icon: "🔍",
      category: "Coding",
      description: "Review code for bugs, security issues, performance, and best practices.",
      prompt: `You are an expert code reviewer. When reviewing code:
- Look for bugs, logic errors, and edge cases
- Identify security vulnerabilities (injection, XSS, auth issues, secrets in code)
- Check for performance problems (N+1 queries, unnecessary re-renders, memory leaks)
- Suggest improvements to readability and maintainability
- Verify error handling is comprehensive
- Check for proper input validation
- Note missing tests or test coverage gaps
- Rate severity: 🔴 Critical / 🟡 Important / 🟢 Suggestion
- Be specific: quote the problematic line and explain why + how to fix`,
    },
    {
      id: "debugger",
      name: "Debugger",
      icon: "🐛",
      category: "Coding",
      description: "Systematically diagnose and fix bugs with root cause analysis.",
      prompt: `You are an expert debugger. When diagnosing issues:
- Ask clarifying questions about the symptoms, environment, and steps to reproduce
- Form hypotheses ranked by likelihood, then systematically test each
- Read the actual code (use tools) before guessing — never assume
- Trace the data flow from input to the point of failure
- Check for common culprits: off-by-one, null/undefined, race conditions, stale state, wrong types
- When you find the root cause, explain WHY it fails (not just what to change)
- Suggest a fix AND a way to prevent the same class of bug in the future
- If relevant, suggest adding a regression test`,
    },
    {
      id: "architect",
      name: "System Architect",
      icon: "🏗️",
      category: "Coding",
      description: "Design scalable systems with clear architecture decisions and trade-offs.",
      prompt: `You are a system architect. When designing systems:
- Start with requirements: functional, non-functional (scale, latency, availability)
- Propose clear component boundaries with well-defined interfaces
- Explain trade-offs explicitly (consistency vs availability, complexity vs flexibility)
- Consider failure modes and how the system degrades gracefully
- Draw on proven patterns: event sourcing, CQRS, saga, circuit breaker, etc.
- Think about observability: logging, metrics, tracing from day one
- Plan for evolution: how will this change in 6 months? 2 years?
- Keep it as simple as possible — add complexity only when justified by requirements`,
    },
    {
      id: "frontend-expert",
      name: "Frontend Expert",
      icon: "🎨",
      category: "Coding",
      description: "Build beautiful, accessible, performant UIs with modern best practices.",
      prompt: `You are a frontend expert specializing in modern web development:
- Write semantic HTML with proper ARIA attributes for accessibility
- Use CSS best practices: custom properties, logical properties, container queries
- Optimize performance: minimize layout thrashing, lazy-load, use will-change sparingly
- Follow responsive design principles (mobile-first)
- Handle loading, error, and empty states for every UI component
- Use proper animation (prefer CSS transforms, respect prefers-reduced-motion)
- Consider keyboard navigation and screen reader experience
- Write components that are composable and testable`,
    },
    {
      id: "api-designer",
      name: "API Designer",
      icon: "🔌",
      category: "Coding",
      description: "Design clean, consistent, well-documented REST/GraphQL APIs.",
      prompt: `You are an API design expert:
- Follow RESTful conventions: proper HTTP methods, status codes, resource naming
- Design for consistency: naming patterns, pagination, error format, versioning
- Include comprehensive error responses with actionable messages
- Think about rate limiting, authentication, and authorization from the start
- Design for backward compatibility — additive changes only
- Document every endpoint clearly: parameters, responses, examples
- Consider idempotency for mutations
- Use proper validation with clear error messages for invalid input`,
    },
    {
      id: "technical-writer",
      name: "Technical Writer",
      icon: "📝",
      category: "Writing",
      description: "Write clear documentation, READMEs, guides, and technical content.",
      prompt: `You are a technical writer who produces clear, well-structured documentation:
- Lead with the most important information (inverted pyramid)
- Use headers, bullet points, and code blocks for scannability
- Include practical examples for every concept
- Write for your audience's level — don't over-explain or under-explain
- Keep sentences short and direct. Avoid jargon unless defining it
- Include a TL;DR or summary at the top for long documents
- Add "Prerequisites" and "Next steps" sections where appropriate
- Test instructions mentally — would a reader actually be able to follow them?`,
    },
    {
      id: "refactorer",
      name: "Refactoring Expert",
      icon: "♻️",
      category: "Coding",
      description: "Safely refactor code: reduce complexity, improve readability, eliminate duplication.",
      prompt: `You are a refactoring expert:
- Make changes in small, safe steps that each maintain correctness
- Identify code smells: long methods, deep nesting, feature envy, god objects
- Extract reusable functions/modules with clear interfaces
- Reduce cyclomatic complexity — prefer early returns and guard clauses
- Eliminate duplication with the "Rule of Three"
- Improve naming to make code self-documenting
- Preserve existing behavior — refactoring changes structure, not functionality
- Suggest which refactorings to do first (highest value, lowest risk)
- Always read the code first to understand the full context before changing anything`,
    },
    {
      id: "security-auditor",
      name: "Security Auditor",
      icon: "🔒",
      category: "Security",
      description: "Find security vulnerabilities and suggest hardening measures.",
      prompt: `You are a security auditor:
- Check for OWASP Top 10: injection, broken auth, sensitive data exposure, XSS, CSRF
- Look for hardcoded secrets, tokens, or credentials
- Verify input validation and output encoding
- Check authentication and authorization at every endpoint
- Look for insecure dependencies and outdated packages
- Verify proper use of cryptography (no custom crypto, proper key management)
- Check for information leakage in error messages and headers
- Suggest security headers, CSP, and other defense-in-depth measures
- Rate findings by severity and exploitability
- Provide concrete remediation steps, not just observations`,
    },
    {
      id: "test-engineer",
      name: "Test Engineer",
      icon: "🧪",
      category: "Testing",
      description: "Write comprehensive tests: unit, integration, E2E, with good coverage.",
      prompt: `You are a test engineering expert:
- Write tests that are readable, maintainable, and fast
- Follow Arrange-Act-Assert (AAA) pattern
- Test behavior, not implementation details
- Cover happy paths, edge cases, error conditions, and boundary values
- Use descriptive test names that explain what's being tested and expected
- Mock external dependencies but test real integration points
- Aim for high confidence, not just high coverage numbers
- Write tests that fail for the right reasons and pass for the right reasons
- Consider property-based testing for complex logic
- Include both unit tests (isolated) and integration tests (end-to-end flows)`,
    },
    {
      id: "devops",
      name: "DevOps Engineer",
      icon: "🚀",
      category: "Infrastructure",
      description: "CI/CD, Docker, Kubernetes, infrastructure as code, and deployment.",
      prompt: `You are a DevOps engineer:
- Design CI/CD pipelines that are fast, reliable, and secure
- Write Dockerfiles following best practices: multi-stage builds, minimal images, non-root
- Use infrastructure as code (Terraform, Pulumi, CloudFormation)
- Implement proper secret management — never hardcode credentials
- Design for observability: structured logging, metrics, distributed tracing
- Implement blue/green or canary deployments for zero-downtime releases
- Set up proper health checks, readiness probes, and graceful shutdown
- Automate everything that's done more than twice
- Plan for disaster recovery: backups, runbooks, incident response`,
    },
    {
      id: "data-analyst",
      name: "Data Analyst",
      icon: "📊",
      category: "Data",
      description: "Analyze data, write SQL, create visualizations, and derive insights.",
      prompt: `You are a data analyst:
- Write efficient, readable SQL with proper indexing considerations
- Clean and validate data before analysis — never trust raw input
- Use appropriate statistical methods and explain assumptions
- Create clear visualizations that tell a story
- Distinguish correlation from causation
- Provide actionable insights, not just numbers
- Consider data privacy and anonymization requirements
- Document your methodology so others can reproduce the analysis
- Suggest appropriate data structures and storage for the use case`,
    },
    {
      id: "python-expert",
      name: "Python Expert",
      icon: "🐍",
      category: "Coding",
      description: "Write idiomatic Python with type hints, async patterns, and modern best practices.",
      prompt: `You are a Python expert:
- Write idiomatic Python 3.11+ with type hints (use typing module and modern syntax)
- Use async/await for IO-bound work, multiprocessing for CPU-bound
- Follow PEP 8 style, use f-strings, walrus operator where clear
- Prefer dataclasses/Pydantic for structured data, not raw dicts
- Use context managers for resource management
- Write comprehensive docstrings (Google style)
- Know the standard library deeply — avoid unnecessary dependencies
- Use virtual environments, pyproject.toml, and modern tooling (ruff, mypy, pytest)
- Handle exceptions specifically — never bare except`,
    },
    {
      id: "database-expert",
      name: "Database Expert",
      icon: "🗄️",
      category: "Data",
      description: "Design schemas, write optimized queries, manage migrations, and tune performance.",
      prompt: `You are a database expert:
- Design normalized schemas (3NF) then denormalize strategically for performance
- Write efficient queries — explain execution plans and index strategies
- Use proper constraints: foreign keys, unique, check, NOT NULL
- Design migrations that are safe, reversible, and zero-downtime
- Choose the right database for the job (relational vs document vs graph vs time-series)
- Implement proper connection pooling and query parameterization
- Handle transactions correctly — understand isolation levels
- Plan for scaling: read replicas, sharding strategies, caching layers
- Always parameterize queries — never concatenate user input`,
    },
    {
      id: "ux-designer",
      name: "UX/UI Designer",
      icon: "🎯",
      category: "Design",
      description: "Design intuitive interfaces with clear information hierarchy and user flows.",
      prompt: `You are a UX/UI design expert:
- Start with user needs and jobs-to-be-done, not features
- Design clear information hierarchies — most important content first
- Follow established patterns (don't reinvent navigation, forms, modals)
- Ensure every interactive element has clear affordances and feedback
- Design for accessibility from the start (WCAG 2.1 AA minimum)
- Use consistent spacing, typography, and color systems
- Consider empty states, loading states, error states for every screen
- Reduce cognitive load — progressive disclosure, sensible defaults
- Test with real users when possible; use heuristic evaluation otherwise
- Mobile-first responsive design with touch-friendly targets (44px minimum)`,
    },
    {
      id: "product-manager",
      name: "Product Manager",
      icon: "📋",
      category: "Writing",
      description: "Write PRDs, user stories, prioritize features, and think about product strategy.",
      prompt: `You are a product manager:
- Frame everything in terms of user problems and outcomes, not solutions
- Write clear user stories: "As a [user], I want [goal] so that [benefit]"
- Prioritize ruthlessly using frameworks (RICE, ICE, MoSCoW)
- Define clear success metrics and acceptance criteria
- Think about edge cases, error states, and the unhappy path
- Consider technical feasibility and work with engineering constraints
- Break large features into shippable increments (MVP thinking)
- Communicate trade-offs clearly to stakeholders
- Always ask "what problem does this solve?" and "how will we know it worked?"`,
    },
    {
      id: "algorithms",
      name: "Algorithms & Math",
      icon: "🧮",
      category: "Coding",
      description: "Solve algorithmic problems, analyze complexity, and implement data structures.",
      prompt: `You are an algorithms and data structures expert:
- Analyze time and space complexity for every solution (Big O)
- Consider multiple approaches before coding — brute force, then optimize
- Use the right data structure: hash maps for lookup, heaps for top-k, tries for prefix search
- Know classic patterns: two pointers, sliding window, BFS/DFS, DP, divide and conquer
- Implement clean, bug-free code with clear variable names
- Handle edge cases: empty input, single element, duplicates, overflow
- Explain your reasoning step by step
- When relevant, discuss trade-offs between time and space
- Use mathematical reasoning: combinatorics, probability, number theory when applicable`,
    },
    {
      id: "shell-expert",
      name: "Shell & CLI Expert",
      icon: "🖥️",
      category: "Infrastructure",
      description: "Write shell scripts, one-liners, and CLI tools with proper error handling.",
      prompt: `You are a shell scripting expert:
- Write POSIX-compatible scripts when portability matters, bash when it doesn't
- Always use 'set -euo pipefail' at the top of scripts
- Quote all variables: "$var" not $var
- Handle errors explicitly — check return codes, use trap for cleanup
- Use shellcheck-clean code (no common pitfalls)
- Prefer built-in commands over external tools when possible
- Write clear usage/help messages for scripts
- Use functions to organize code in scripts > 50 lines
- Know key tools deeply: find, xargs, awk, sed, jq, grep, sort, uniq
- Consider security: never eval user input, sanitize paths`,
    },
    {
      id: "git-expert",
      name: "Git Expert",
      icon: "📦",
      category: "Coding",
      description: "Advanced Git workflows, history rewriting, conflict resolution, and best practices.",
      prompt: `You are a Git expert:
- Write clear, conventional commit messages (type: subject, body explains why)
- Design branching strategies appropriate for the team (trunk-based, gitflow, etc.)
- Resolve merge conflicts by understanding both sides' intent
- Use interactive rebase to clean up history before merging
- Know when to merge vs rebase vs squash
- Use git bisect to find bug-introducing commits
- Understand reflog for recovery from mistakes
- Set up proper .gitignore and .gitattributes
- Use hooks for pre-commit checks (lint, test, format)
- Handle large files with LFS, secrets with git-crypt or vault`,
    },
    {
      id: "prompt-engineer",
      name: "Prompt Engineer",
      icon: "🪄",
      category: "AI/ML",
      description: "Craft effective prompts, system instructions, and few-shot examples for AI models.",
      prompt: `You are a prompt engineering expert:
- Write clear, specific instructions — ambiguity leads to poor output
- Use structured formats: XML tags, numbered steps, explicit delimiters
- Provide few-shot examples that demonstrate the exact format you want
- Give the model a persona/role when it helps focus the response
- Use chain-of-thought prompting for complex reasoning tasks
- Specify output format explicitly (JSON, markdown, bullet points, etc.)
- Include constraints and edge cases in the prompt
- Test prompts iteratively — start simple, add complexity as needed
- Know model capabilities and limitations — don't ask for what they can't do
- Use system prompts for persistent behavior, user messages for per-request variation`,
    },
    {
      id: "performance",
      name: "Performance Optimizer",
      icon: "⚡",
      category: "Coding",
      description: "Profile, benchmark, and optimize code for speed and memory efficiency.",
      prompt: `You are a performance optimization expert:
- Measure before optimizing — use profilers, not intuition
- Identify the bottleneck first (Amdahl's law: optimize what matters most)
- Know the memory hierarchy: L1/L2/L3 cache, RAM, disk, network (10x at each level)
- Reduce algorithmic complexity before micro-optimizing
- For web: minimize critical rendering path, reduce bundle size, lazy-load
- For backend: connection pooling, query optimization, caching (Redis/CDN)
- Avoid premature optimization — code clarity first, then profile and optimize hot paths
- Know your runtime: event loop (Node), GIL (Python), garbage collection pauses
- Use appropriate data structures for access patterns
- Benchmark with realistic data and load — microbenchmarks lie`,
    },
    {
      id: "accessibility",
      name: "Accessibility Expert",
      icon: "♿",
      category: "Design",
      description: "Ensure WCAG compliance, screen reader support, and inclusive design.",
      prompt: `You are an accessibility (a11y) expert:
- Ensure WCAG 2.1 AA compliance minimum (AAA where practical)
- Use semantic HTML elements (nav, main, article, button — not div-for-everything)
- Add proper ARIA attributes only when semantic HTML isn't sufficient
- Ensure keyboard navigability: focus order, visible focus indicators, no keyboard traps
- Provide text alternatives for all non-text content (alt, aria-label, captions)
- Ensure color contrast ratios meet standards (4.5:1 text, 3:1 UI components)
- Design for screen readers: logical reading order, landmark regions, live regions
- Support reduced motion, high contrast, and zoom preferences
- Test with real assistive technology (VoiceOver, NVDA, JAWS)
- Consider cognitive accessibility: clear language, consistent navigation, error prevention`,
    },
    {
      id: "data-visualizer",
      name: "Data Visualizer",
      icon: "📈",
      category: "Data",
      description: "Turn data & math into runnable charts you can preview and export as an image.",
      prompt: `You are a data visualization expert. When asked to plot, graph, or visualize:
- Produce a SELF-CONTAINED, runnable artifact the user can preview and export — prefer an \`\`\`html code block that draws the chart with inline <canvas> + vanilla JS (or an <svg>), so it runs in a sandboxed iframe with no external data
- Do NOT default to Python/matplotlib unless the user explicitly wants Python — this app previews HTML/SVG/JS in the browser, not Python
- Label axes, add a title, a legend when there are multiple series, and readable tick marks
- Pick the right chart type: line for trends, bar for comparisons, scatter for correlation, pie only for parts-of-a-whole
- Use a clean, high-contrast palette and enough padding that nothing is clipped
- Annotate key points (max/min, the answer the user asked for) directly on the chart
- After the code block, briefly explain what the chart shows and any assumptions about the data`,
    },
    {
      id: "eli5",
      name: "Explain Like I'm 5",
      icon: "🧒",
      category: "Writing",
      description: "Explain any concept in plain, simple language with everyday analogies.",
      prompt: `You are a teacher who makes hard things simple. When explaining:
- Start with a one-sentence plain-language answer, no jargon
- Use a concrete everyday analogy the reader already understands
- Build up in small steps, checking understanding as you go
- Define any unavoidable technical term the moment you use it
- Prefer short sentences and simple words over precise-but-dense phrasing
- Use a small worked example with real numbers or a real scenario
- End with a one-line "in short" recap
- Never condescend — simple does not mean childish`,
    },
    {
      id: "math-tutor",
      name: "Math Tutor",
      icon: "➗",
      category: "Data",
      description: "Solve and teach math step by step, showing every step and checking the answer.",
      prompt: `You are a patient math tutor. When solving problems:
- Restate the problem and identify exactly what is being asked
- Show EVERY step with the reasoning, not just the final answer
- Keep formulas and steps on their own lines so they're easy to follow
- Explain WHY each step is valid (the rule or theorem used)
- Watch for common mistakes (sign errors, order of operations, unit mismatches) and flag them
- Verify the final answer by substituting back or sanity-checking magnitude/units
- When a picture would help (geometry, graphs, vectors), offer a runnable \`\`\`html or \`\`\`svg diagram
- End with a short "how to recognize this type of problem next time" tip`,
    },
  ];

  function activeSkills() {
    return (state.settings.skills || [])
      .map((id) => SKILLS_CATALOG.find((s) => s.id === id))
      .filter(Boolean);
  }

  function skillsSystemNote() {
    const active = activeSkills();
    if (!active.length) return "";
    return "\n\n[Active skills]\n" + active.map((s) => s.prompt).join("\n\n");
  }

  function isSkillActive(id) { return (state.settings.skills || []).includes(id); }
  function toggleSkill(id) {
    if (!state.settings.skills) state.settings.skills = [];
    if (isSkillActive(id)) {
      state.settings.skills = state.settings.skills.filter((s) => s !== id);
    } else {
      state.settings.skills.push(id);
    }
    saveSettings();
    renderSkills();
  }

  function applyScope(uid) {
    if (!uid) return;
    SCOPE = "u_" + uid + ".";
    SESSION_KEY = SCOPE + "max.apiKey.session.v1";
    GH_SESSION_KEY = SCOPE + "max.ghToken.session.v1";
    GL_SESSION_KEY = SCOPE + "max.glToken.session.v1";
    CC_SESSION_KEY = SCOPE + "max.ccKey.session.v1";
    LS.convos = SCOPE + "max.conversations.v1";
    LS.settings = SCOPE + "max.settings.v1";
    LS.active = SCOPE + "max.active.v1";
    // theme stays global across accounts on the same browser
  }

  // Rough per-model pricing (USD per 1M tokens) for the running cost estimate.
  // Matched by longest id prefix, so new model versions inherit a sane estimate.
  const PRICING_HINTS = {
    "claude-opus": { in: 15, out: 75 }, "claude-sonnet": { in: 3, out: 15 }, "claude-fable": { in: 3, out: 15 },
    "claude-mythos": { in: 15, out: 75 }, "gpt-5.5-pro": { in: 15, out: 120 }, "gpt-5": { in: 1.25, out: 10 },
    "gemini-3.1-pro": { in: 2, out: 12 }, "gemini": { in: 0.3, out: 2.5 }, "gemma": { in: 0.05, out: 0.1 },
    "grok": { in: 3, out: 15 }, "deepseek": { in: 0.3, out: 1.2 }, "qwen": { in: 0.8, out: 3 },
    "kimi": { in: 0.6, out: 2.5 }, "glm": { in: 0.6, out: 2.2 }, "seed": { in: 0.3, out: 1.2 }, "muse": { in: 1, out: 4 },
  };
  const priceFor = (model) => {
    const id = String(model || "").toLowerCase();
    let best = null;
    for (const k of Object.keys(PRICING_HINTS)) if (id.startsWith(k) && (!best || k.length > best.length)) best = k;
    return best ? PRICING_HINTS[best] : { in: 3, out: 15 };
  };
  const ALLOWED_IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);

  // Offline fallback only — the real catalog comes from /api/config.
  const ALL_CAPS = { reasoning: true, vision: true, tools: true, streaming: true, json: true };
  const DEFAULT_MODELS = [
    { id: "claude-opus-5", label: "Claude Opus 5", provider: "codecraft", family: "Anthropic", caps: ALL_CAPS },
    { id: "claude-opus-4-8", label: "Claude Opus 4.8", provider: "agentrouter", family: "Anthropic", caps: ALL_CAPS },
  ];
  const DEFAULT_PROVIDERS = [
    { id: "codecraft", label: "CodeCraft API", style: "openai", hasServerKey: false, keyUrl: "https://codecraftapi.com/dashboard" },
    { id: "agentrouter", label: "AgentRouter", style: "anthropic", hasServerKey: false, keyUrl: "https://agentrouter.org/console/token" },
  ];
  const EFFORTS = [
    { id: "low", label: "Low", hint: "Fastest answers" },
    { id: "medium", label: "Medium", hint: "Balanced" },
    { id: "high", label: "High", hint: "Thinks harder" },
    { id: "xhigh", label: "xHigh", hint: "Deep reasoning" },
    { id: "max", label: "Max", hint: "Maximum reasoning budget" },
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
      defaultModel: "claude-opus-5", defaultProvider: "codecraft", models: DEFAULT_MODELS, providers: DEFAULT_PROVIDERS,
      allowClientKey: true, hasServerKey: false,
      github: { hasServerToken: false, allowClientToken: true, owner: "", repo: "", branch: "main" },
      gitlab: { hasServerToken: false, allowClientToken: true },
    },
    settings: {
      apiKey: "",        // AgentRouter key (legacy name)
      ccKey: "",         // CodeCraft API key
      rememberKeys: false, // persist keys in localStorage instead of sessionStorage
      aiProvider: "",    // "codecraft" | "agentrouter" ("" = server default)
      model: "",
      effort: "medium",  // low | medium | high | xhigh | max
      jsonMode: false,
      perfMode: false,   // disable the animated background
      customModels: [],  // [{id, provider}] discovered via "Refresh models"
      video: null,       // video generation preferences (see videoDefaults)
      system: "You are MAX, a helpful, friendly and concise AI assistant. Use Markdown for formatting when helpful.",
      maxTokens: 8192,
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
    pendingEdits: {}, // staged repo edits by path: {content, deleted, isNew, original}
    user: null, // signed-in user (when auth is enabled)
    videoMode: false,  // composer generates videos instead of chatting
    videoKeys: { openrouter: "", google: "", gateway: "" }, // session/remembered secrets
    videoCatalog: { models: [], providers: [], errors: {}, fetchedAt: 0 },
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
      if (!Array.isArray(state.settings.skills)) state.settings.skills = [];
      if (!state.settings.powers || !Array.isArray(state.settings.powers.installed)) state.settings.powers = { installed: [] };
      if (state.settings.provider !== "gitlab") state.settings.provider = "github";
      if (!Array.isArray(state.settings.customModels)) state.settings.customModels = [];
      if (!EFFORTS.some((e) => e.id === state.settings.effort)) state.settings.effort = "medium";
      state.settings.apiKey = secretGet(SESSION_KEY);
      state.settings.ccKey = secretGet(CC_SESSION_KEY);
      state.settings.video = Object.assign(videoDefaults(), state.settings.video || {});
      if (!Array.isArray(state.settings.video.custom)) state.settings.video.custom = [];
      loadVideoKeys();
      state.settings.github.token = secretGet(GH_SESSION_KEY);
      state.settings.gitlab.token = secretGet(GL_SESSION_KEY);
    } catch {}
    state.activeId = localStorage.getItem(LS.active) || null;
  }
  // If storage is full, drop heavy attachment payloads (images/PDF bytes) from
  // older messages — the text stays, and the server copy still has everything.
  function compactForStorage() {
    let freed = 0;
    const convos = [...state.conversations].sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    for (const c of convos) {
      if (c.id === state.activeId) continue;
      for (const m of c.messages || []) {
        for (const a of m.images || []) {
          if (a.dataUrl) { freed += a.dataUrl.length; delete a.dataUrl; a.stripped = true; }
          if (a.images) { freed += JSON.stringify(a.images).length; delete a.images; }
        }
      }
      if (freed > 2_000_000) break;
    }
    return freed;
  }
  const saveConvos = () => {
    let ok = safeStorageSet(localStorage, LS.convos, JSON.stringify(state.conversations));
    if (!ok && compactForStorage()) ok = safeStorageSet(localStorage, LS.convos, JSON.stringify(state.conversations));
    if (!ok) toast("Conversation history could not be saved locally (storage full). It is still synced to the server.", "error");
    // Auto-sync to server in the background (fire and forget)
    syncConvosToServer();
  };

  // Conversations touched since the last server sync. We only upload these
  // rather than re-POSTing every conversation on every change.
  const _dirtyConvos = new Set();
  let _syncDebounce = null;
  function syncConvosToServer() {
    // Anything currently in state that has messages is a candidate; mark the
    // active one (and any explicitly flagged) as dirty.
    if (state.activeId) _dirtyConvos.add(state.activeId);
    clearTimeout(_syncDebounce);
    _syncDebounce = setTimeout(() => {
      const ids = [..._dirtyConvos];
      _dirtyConvos.clear();
      for (const id of ids) {
        const c = state.conversations.find((x) => x.id === id);
        if (!c || !c.messages || !c.messages.length) continue;
        fetch("/api/conversations", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(c),
        }).catch(() => { _dirtyConvos.add(id); }); // re-queue on failure
      }
    }, 3000); // debounce 3s to batch rapid changes
  }

  async function loadConvosFromServer() {
    try {
      const res = await fetch("/api/conversations");
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data.conversations) || !data.conversations.length) return;
      // Merge server conversations that aren't already in localStorage
      const localIds = new Set(state.conversations.map((c) => c.id));
      let added = 0;
      for (const meta of data.conversations) {
        if (localIds.has(meta.id)) continue;
        // Fetch the full conversation
        try {
          const full = await fetch(`/api/conversations/${encodeURIComponent(meta.id)}`);
          if (!full.ok) continue;
          const convo = await full.json();
          if (convo && convo.id && Array.isArray(convo.messages)) {
            state.conversations.push(convo);
            added++;
          }
        } catch {}
      }
      if (added) {
        state.conversations.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        safeStorageSet(localStorage, LS.convos, JSON.stringify(state.conversations));
        renderConversations();
      }
    } catch {} // offline or server down — fine, just use localStorage
  }
  // Secrets (API keys + tokens) live in sessionStorage by default (cleared when
  // the tab closes). With "Remember keys on this device" they go to localStorage.
  function secretGet(key) {
    try { return sessionStorage.getItem(key) || localStorage.getItem("secret." + key) || ""; } catch { return ""; }
  }
  function secretPut(key, val) {
    try {
      if (!val) { sessionStorage.removeItem(key); localStorage.removeItem("secret." + key); return; }
      safeStorageSet(sessionStorage, key, val);
      if (state.settings.rememberKeys) safeStorageSet(localStorage, "secret." + key, val);
      else localStorage.removeItem("secret." + key);
    } catch {}
  }
  const saveSettings = () => {
    // Deep-clone, then strip the secrets before persisting the rest.
    const persistent = JSON.parse(JSON.stringify(state.settings));
    const apiKey = persistent.apiKey; delete persistent.apiKey;
    const ccKey = persistent.ccKey; delete persistent.ccKey;
    const ghToken = persistent.github ? persistent.github.token : "";
    const glToken = persistent.gitlab ? persistent.gitlab.token : "";
    if (persistent.github) delete persistent.github.token;
    if (persistent.gitlab) delete persistent.gitlab.token;
    safeStorageSet(localStorage, LS.settings, JSON.stringify(persistent), "Settings");
    secretPut(SESSION_KEY, apiKey);
    secretPut(CC_SESSION_KEY, ccKey);
    secretPut(GH_SESSION_KEY, ghToken);
    secretPut(GL_SESSION_KEY, glToken);
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
    if (convo && convo.id) _dirtyConvos.add(convo.id);
    // keep most-recent first
    state.conversations.sort((a, b) => b.updatedAt - a.updatedAt);
    saveConvos();
  }

  function autoTitle(convo) {
    if (convo.title !== "New chat") return;
    const firstUser = convo.messages.find((m) => m.role === "user");
    if (firstUser) {
      const t = (firstUser.content || firstUser.images?.[0]?.name || "").trim().replace(/\s+/g, " ").slice(0, 46);
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
  // Languages that can be rendered as a live preview in a sandboxed iframe.
  const PREVIEWABLE = new Set(["html", "svg", "htm", "jsx", "tsx", "react", "mermaid", "css"]);
  function isPreviewable(lang, code) {
    if (PREVIEWABLE.has(lang)) return true;
    // Detect HTML even without a lang tag
    if (!lang && /<(!doctype|html|head|body|div|svg|style|script)/i.test(code.slice(0, 200))) return true;
    return false;
  }

  function enhanceContent(container, opts = {}) {
    $$("pre code", container).forEach((code) => {
      if (code.closest(".code-block")) return;
      if (opts.live) { code.parentElement.classList.add("pre-live"); return; } // highlight once complete
      const pre = code.parentElement;
      const langMatch = [...code.classList].find((c) => c.startsWith("language-"));
      const lang = langMatch ? langMatch.replace("language-", "") : "";
      const rawCode = code.innerText;

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

      const previewable = isPreviewable(lang, rawCode);
      const runBtn = previewable
        ? `${hasCanvas(rawCode) ? `<button class="code-video" type="button" title="Record this animation as a video">🎬 <span>Video</span></button>` : ""}
          <button class="code-run" type="button" title="Run this code in a preview panel">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:currentColor;stroke:none"><polygon points="5,3 19,12 5,21"/></svg>
            <span>Run</span></button>`
        : "";

      head.innerHTML = `<span class="code-block__lang">${esc(lang || "code")}</span>
        <div class="code-block__actions">
          ${runBtn}
          <button class="code-copy" type="button">
            <svg viewBox="0 0 24 24" style="width:14px;height:14px;fill:none;stroke:currentColor;stroke-width:2"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 012-2h10"/></svg>
            <span>Copy</span></button>
        </div>`;
      pre.replaceWith(wrap);
      wrap.appendChild(head);
      wrap.appendChild(pre);

      head.querySelector(".code-copy").addEventListener("click", () => {
        copyText(rawCode);
        const label = head.querySelector(".code-copy span");
        const prev = label.textContent; label.textContent = "Copied!";
        setTimeout(() => (label.textContent = prev), 1400);
      });

      if (previewable) {
        head.querySelector(".code-run").addEventListener("click", () => openPreview(rawCode, lang));
        head.querySelector(".code-video")?.addEventListener("click", () => openPreview(rawCode, lang, { record: true }));
      }
    });
    // open links in new tab safely
    $$("a", container).forEach((a) => { if (a.closest(".vcard")) return; a.target = "_blank"; a.rel = "noopener noreferrer"; });
  }

  /* ============================================================
     Artifacts / Preview panel — sandboxed iframe live preview
     ============================================================ */
  let previewOverlay = null;
  let previewFrame = null;   // the live sandbox iframe
  let previewHandlers = {};  // message type -> handler for the current preview

  // One global listener for messages from the sandbox iframe (opaque origin,
  // so we authenticate by comparing the source window, not the origin).
  window.addEventListener("message", (e) => {
    const d = e.data;
    if (!d || !d.__max || !previewFrame || e.source !== previewFrame.contentWindow) return;
    const h = previewHandlers[d.type];
    if (h) h(d);
  });

  const hasCanvas = (code) => /<canvas[\s>]|createElement\(\s*["']canvas["']\s*\)/i.test(code);

  function openPreview(code, lang, opts = {}) {
    closePreview();
    const html = buildPreviewHtml(code, lang);
    const canRecord = hasCanvas(html);
    const secs = Math.max(2, Math.min(60, opts.seconds || 8));
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay preview-overlay";
    overlay.innerHTML = `
      <div class="preview-panel" role="dialog" aria-modal="true">
        <div class="preview-panel__head">
          <span class="preview-panel__title">${opts.record ? "🎬 Video studio" : "Preview"}</span>
          <div class="preview-panel__actions">
            ${canRecord ? `<label class="video-secs" title="Video length">⏱ <input type="number" id="video-secs" min="2" max="60" value="${secs}">s</label>
            <button class="btn btn--primary btn--sm" id="preview-record" type="button">🎬 Record video</button>` : ""}
            <button class="btn btn--ghost btn--sm" id="preview-reload" type="button" title="Restart the preview">↻</button>
            <button class="btn btn--ghost btn--sm" id="preview-png" type="button">Save PNG</button>
            <button class="btn btn--ghost btn--sm" id="preview-download" type="button">Download .html</button>
            <button class="btn btn--ghost btn--sm" id="preview-newtab" type="button">Open in tab</button>
            <button class="icon-btn" id="preview-fullscreen" type="button" title="Fullscreen" aria-label="Toggle fullscreen">
              <svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round"><path d="M8 3H5a2 2 0 00-2 2v3m18 0V5a2 2 0 00-2-2h-3M3 16v3a2 2 0 002 2h3m8 0h3a2 2 0 002-2v-3"/></svg>
            </button>
            <button class="icon-btn" id="preview-close" aria-label="Close">
              <svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M18 6L6 18M6 6l12 12"/></svg>
            </button>
          </div>
        </div>
        <div class="video-bar" id="video-bar" hidden>
          <div class="video-bar__progress"><span id="video-progress"></span></div>
          <span class="video-bar__label" id="video-label">Preparing…</span>
        </div>
        <div class="preview-panel__body">
          <iframe class="preview-iframe" sandbox="allow-scripts allow-modals" title="Code preview"></iframe>
          <div class="video-result" id="video-result" hidden></div>
        </div>
        <div class="preview-error" id="preview-error" hidden></div>
      </div>`;
    document.body.appendChild(overlay);
    previewOverlay = overlay;
    const iframe = overlay.querySelector(".preview-iframe");
    previewFrame = iframe;
    let pendingRecord = null;
    let videoUrl = null;

    const run = (record) => {
      pendingRecord = record || null;
      previewHandlers.ready = () => iframe.contentWindow.postMessage({ type: "max-render", html, record: pendingRecord }, "*");
      iframe.src = "/sandbox.html?v=" + Date.now().toString(36);
    };
    const bar = overlay.querySelector("#video-bar");
    const label = overlay.querySelector("#video-label");
    const prog = overlay.querySelector("#video-progress");
    const errBox = overlay.querySelector("#preview-error");
    previewHandlers["runtime-error"] = (d) => {
      errBox.hidden = false;
      errBox.innerHTML = `⚠ Runtime error in the preview: <code>${esc(d.message)}</code> <button class="btn btn--ghost btn--sm" type="button">Ask MAX to fix it</button>`;
      errBox.querySelector("button").onclick = () => {
        closePreview();
        const input = $("#input");
        input.value = `The code you generated throws this error when run: "${d.message}". Please fix it and send the complete corrected code.`;
        autoResize(input); updateCharCount(); updateSendState(); input.focus();
      };
    };
    previewHandlers["video-start"] = (d) => { bar.hidden = false; label.textContent = `Recording ${d.seconds}s at ${d.width}×${d.height}…`; };
    previewHandlers["video-progress"] = (d) => { prog.style.width = `${Math.round(d.p * 100)}%`; };
    previewHandlers["video-error"] = (d) => { bar.hidden = false; prog.style.width = "0"; label.textContent = "✗ " + d.message; toast(d.message, "error"); };
    previewHandlers["video-done"] = (d) => {
      prog.style.width = "100%";
      const ext = /mp4/.test(d.mime) ? "mp4" : "webm";
      if (videoUrl) URL.revokeObjectURL(videoUrl);
      videoUrl = URL.createObjectURL(d.blob);
      label.textContent = `✓ Video ready — ${formatSize(d.blob.size)} · ${d.width}×${d.height} · ${ext.toUpperCase()}`;
      const box = overlay.querySelector("#video-result");
      box.hidden = false;
      box.innerHTML = `<video controls autoplay loop playsinline src="${videoUrl}"></video>
        <div class="video-result__actions">
          <a class="btn btn--primary btn--sm" href="${videoUrl}" download="max-video-${Date.now().toString(36)}.${ext}">⬇ Download ${ext.toUpperCase()}</a>
          <button class="btn btn--ghost btn--sm" type="button" id="video-back">Back to live preview</button>
        </div>`;
      box.querySelector("#video-back").onclick = () => { box.hidden = true; };
      toast("Video ready — download it from the preview panel", "success");
    };
    previewHandlers.snapshot = (d) => {
      if (!d.dataUrl) { toast(d.message || "Nothing to snapshot.", "error"); return; }
      const a = document.createElement("a");
      a.href = d.dataUrl; a.download = `preview-${Date.now().toString(36)}.png`;
      document.body.appendChild(a); a.click(); a.remove();
      toast("Saved PNG", "success");
    };

    run(opts.record ? { seconds: secs, fps: 30 } : null);

    overlay.querySelector("#preview-close").addEventListener("click", closePreview);
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) closePreview(); });
    overlay.querySelector("#preview-reload").addEventListener("click", () => { errBox.hidden = true; run(null); });
    overlay.querySelector("#preview-record")?.addEventListener("click", () => {
      const n = Math.max(2, Math.min(60, parseInt(overlay.querySelector("#video-secs").value, 10) || 8));
      overlay.querySelector("#video-result").hidden = true;
      bar.hidden = false; prog.style.width = "0"; label.textContent = "Starting recorder…";
      run({ seconds: n, fps: 30 });
    });
    overlay.querySelector("#preview-download").addEventListener("click", () => {
      download(`preview-${Date.now().toString(36)}.html`, html, "text/html");
      toast("Downloaded", "success");
    });
    overlay.querySelector("#preview-newtab").addEventListener("click", () => {
      // The tab hosts its own sandboxed iframe — the code never runs with MAX's origin.
      const w = window.open("/sandbox.html#host", "_blank");
      if (!w) { toast("Pop-up blocked — allow pop-ups to open previews in a tab.", "error"); return; }
      const onMsg = (e) => {
        if (e.source === w && e.origin === location.origin && e.data?.type === "max-host-ready") {
          w.postMessage({ type: "max-host-render", html }, location.origin);
          window.removeEventListener("message", onMsg);
        }
      };
      window.addEventListener("message", onMsg);
      setTimeout(() => window.removeEventListener("message", onMsg), 15000);
    });
    overlay.querySelector("#preview-fullscreen").addEventListener("click", () => {
      overlay.querySelector(".preview-panel").classList.toggle("preview-panel--full");
    });
    overlay.querySelector("#preview-png").addEventListener("click", () => exportPreviewPng(iframe, code, lang));
  }

  // PNG export: SVG is rasterised locally; anything else asks the sandbox to
  // snapshot its largest <canvas> (the iframe is cross-origin by design).
  function exportPreviewPng(iframe, code, lang) {
    const isSvg = lang === "svg" || code.trim().startsWith("<svg");
    if (isSvg) {
      const img = new Image();
      const url = URL.createObjectURL(new Blob([code], { type: "image/svg+xml;charset=utf-8" }));
      img.onload = () => {
        const w = img.width || 900, h = img.height || 600;
        const canvas = document.createElement("canvas");
        canvas.width = w * 2; canvas.height = h * 2;
        const ctx = canvas.getContext("2d");
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        canvas.toBlob((blob) => {
          if (!blob) { toast("Could not render PNG", "error"); return; }
          const a = document.createElement("a");
          a.href = URL.createObjectURL(blob); a.download = `preview-${Date.now().toString(36)}.png`;
          document.body.appendChild(a); a.click(); a.remove();
          toast("Saved PNG", "success");
        }, "image/png");
      };
      img.onerror = () => { URL.revokeObjectURL(url); toast("Could not render PNG", "error"); };
      img.src = url;
      return;
    }
    try { iframe.contentWindow.postMessage({ type: "max-snapshot" }, "*"); }
    catch { toast("PNG export isn't available for this preview.", "error"); }
  }

  function closePreview() {
    if (previewOverlay) { previewOverlay.remove(); previewOverlay = null; }
    previewFrame = null; previewHandlers = {};
  }

  // Pull the first runnable HTML (with a canvas) out of a reply and record it.
  function extractVideoCode(text) {
    const re = /```([\w-]*)\n([\s\S]*?)```/g;
    let m, best = null;
    while ((m = re.exec(text || ""))) {
      const lang = (m[1] || "").toLowerCase(), code = m[2];
      if ((lang === "html" || lang === "htm" || !lang) && hasCanvas(code)) { best = code; break; }
      if (!best && (lang === "html" || lang === "htm")) best = code;
    }
    return best;
  }
  function autoRenderVideo(aiMsg) {
    const code = extractVideoCode(aiMsg.content);
    if (!code) { toast("MAX didn't return a runnable animation — try again or rephrase.", "error"); return; }
    openPreview(code, "html", { record: true, seconds: aiMsg.video?.seconds || 8 });
  }

  const VIDEO_SYSTEM = (seconds) => `[Video mode] The user wants a VIDEO. MAX renders videos by recording a canvas animation you write, so reply with a very short intro sentence and then ONE complete, self-contained HTML document in a single \`\`\`html code block, and nothing after it. Requirements:
- A single <canvas> of exactly 1280×720 (set canvas.width/height; CSS may scale it to fit the window), black or designed background, no page scrollbars.
- The animation starts immediately on load and is exactly ${seconds} seconds long; drive it with requestAnimationFrame and elapsed time (performance.now()), and hold the final frame after ${seconds}s.
- Cinematic quality: smooth easing, layered motion, gradients, glow (shadowBlur), particles, parallax, kinetic typography — like a professional motion-graphics studio.
- Everything must be drawn procedurally in JavaScript: NO external images, fonts, libraries, audio or network requests, and no user interaction.
- Plain JavaScript only, wrapped in <script> tags, no console errors.`;

  function buildPreviewHtml(code, lang) {
    // SVG → wrap in minimal HTML
    if (lang === "svg" || (!lang && code.trim().startsWith("<svg"))) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;display:grid;place-items:center;min-height:100vh;background:#1a1a2e;}</style></head><body>${code}</body></html>`;
    }
    // Mermaid → inject mermaid.js
    if (lang === "mermaid") {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/npm/mermaid@10/dist/mermaid.min.js"><\/script><style>body{margin:20px;background:#1a1a2e;color:#e0e0e0;font-family:system-ui;}</style></head><body><pre class="mermaid">${esc(code)}</pre><script>mermaid.initialize({startOnLoad:true,theme:'dark'});<\/script></body></html>`;
    }
    // CSS → show with some sample content
    if (lang === "css") {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>${code}</style></head><body><div class="preview"><h1>CSS Preview</h1><p>Your CSS is applied to this page.</p><button>Button</button><a href="#">Link</a><ul><li>Item 1</li><li>Item 2</li></ul></div></body></html>`;
    }
    // JSX/React → wrap with React CDN
    if (["jsx", "tsx", "react"].includes(lang)) {
      return `<!DOCTYPE html><html><head><meta charset="utf-8"><script src="https://cdn.jsdelivr.net/npm/react@18/umd/react.production.min.js"><\/script><script src="https://cdn.jsdelivr.net/npm/react-dom@18/umd/react-dom.production.min.js"><\/script><script src="https://cdn.jsdelivr.net/npm/@babel/standalone/babel.min.js"><\/script><style>body{margin:0;font-family:system-ui;background:#1a1a2e;color:#e0e0e0;padding:20px;}</style></head><body><div id="root"></div><script type="text/babel">${code}\nReactDOM.render(React.createElement(typeof App !== 'undefined' ? App : () => React.createElement('div',null,'Define an App component')), document.getElementById('root'));<\/script></body></html>`;
    }
    // HTML (default) → if it's a full document, use as-is; otherwise wrap
    if (/<(!doctype|html)/i.test(code.slice(0, 100))) return code;
    return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>body{margin:0;font-family:system-ui;}</style></head><body>${code}</body></html>`;
  }

  /* ============================================================
     Rendering — messages
     ============================================================ */
  const messagesEl = () => $("#messages");

  function showWelcome(show) {
    $("#welcome").style.display = show ? "" : "none";
  }

  function renderWelcomeStatus() {
    const el = $("#welcome-status");
    if (!el) return;
    const hasKey = providerReady();
    const repo = activeRepo();
    const hasGh = providerHasToken("github");
    const gh = state.ghStatus;
    const ghDetail = !hasGh ? "Not connected — add a token in Settings"
      : gh?.error ? `⚠ ${gh.error}` : gh?.login ? `Connected as ${gh.login}${gh.repoCount != null ? ` · ${gh.repoCount} repos` : ""}` : "Connecting…";
    const items = [
      { ok: hasKey, label: providerInfo(currentProvider()).label, detail: hasKey ? modelLabel(currentModel(), currentProvider()) : "No key — add in Settings" },
      { ok: hasGh && !gh?.error, label: "GitHub", detail: ghDetail },
      { ok: Boolean(repo), label: "Working repo", detail: repo ? `${repo.fullName} (${repo.branch})` : "None selected" },
      (() => {
        const n = usableVideoModels().length;
        const provs = videoProviders().filter((p) => videoProviderReady(p.id)).map((p) => p.label.replace(/ \(.*\)$/, ""));
        return { ok: n > 0, label: "Video", detail: n ? `${n} models · ${provs.join(", ")}` : "Not connected — add a key in Settings" };
      })(),
    ];
    el.innerHTML = `<div class="status-grid">${items.map((i) => `
      <div class="status-item">
        <span class="status-dot ${i.ok ? "status-dot--ok" : "status-dot--warn"}"></span>
        <span class="status-label">${esc(i.label)}</span>
        <span class="status-detail">${esc(i.detail)}</span>
      </div>`).join("")}</div>`;
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
    ensureVideoTicker();
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
      const tools = m.toolRuns && m.toolRuns.length ? toolRunsHtml(m.toolRuns) : "";
      bubble.innerHTML = m.kind === "video" ? videosHtml(m) : think + tools + renderMarkdown(m.content) + videosHtml(m);
      enhanceContent(bubble);
    } else {
      // user: show images + text (escaped, preserve newlines)
      let inner = "";
      if (m.images && m.images.length) {
        inner += `<div class="attachments attachments--msg">` + m.images.map((a) => attachmentChipHtml(a, false)).join("") + `</div>`;
      }
      if (m.videoRequest) inner += `<div class="vreq-tag">🎬 Video request</div>`;
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
    copyBtn.addEventListener("click", () => {
      copyText(m.kind === "video" ? (m.videos || []).map((v) => v.prompt).join("\n\n") : m.content);
      toast("Copied to clipboard", "success");
    });
    actions.appendChild(copyBtn);
    if (m.kind === "video") return actions; // video cards carry their own actions

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

      // Prefer edits MAX staged via tools; fall back to parsing path= code blocks.
      const edits = (Array.isArray(m.stagedEdits) && m.stagedEdits.length) ? m.stagedEdits : parseEdits(m.content);
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
  // Rendering Markdown for every token is what made long answers lag. Updates
  // are coalesced to at most one paint per animation frame (~16ms, and at most
  // every 60ms for very long texts), and code highlighting is deferred until the
  // answer is complete.
  function appendStreamingAssistant() {
    showWelcome(false);
    $$(".msg--last", messagesEl()).forEach((r) => r.classList.remove("msg--last"));
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
    let pending = null, rafId = 0, toId = 0, lastPaint = 0, thinkOpen = true;
    const cancel = () => {
      if (rafId) cancelAnimationFrame(rafId);
      if (toId) clearTimeout(toId);
      rafId = toId = 0;
    };
    const paint = () => {
      rafId = toId = 0;
      if (!pending) return;
      const { text, withCursor, thinking, toolRuns } = pending;
      pending = null;
      lastPaint = performance.now();
      const prevThink = bubble.querySelector(".thinking-box");
      if (prevThink) thinkOpen = prevThink.open;
      const think = thinking
        ? `<details class="thinking-box"${thinkOpen ? " open" : ""}><summary>Thinking…</summary><div class="thinking-body">${esc(thinking)}</div></details>`
        : "";
      const tools = toolRunsHtml(toolRuns);
      const textHtml = text
        ? renderMarkdown(text)
        : (tools || think ? "" : `<div class="typing"><span></span><span></span><span></span></div>`);
      const cursor = (withCursor && text) ? '<span class="cursor-blink"></span>' : "";
      const stick = nearBottom();
      bubble.innerHTML = think + tools + textHtml + cursor;
      const tb = bubble.querySelector(".thinking-body");
      if (tb && thinkOpen) tb.scrollTop = tb.scrollHeight;
      enhanceContent(bubble, { live: withCursor });
      if (stick) scrollToBottom(true);
    };
    const schedule = (data) => {
      pending = data;
      if (rafId || toId) return;
      const long = (data.text || "").length > 12000;
      const wait = long ? Math.max(0, 60 - (performance.now() - lastPaint)) : 0;
      if (wait) toId = setTimeout(() => { toId = 0; rafId = requestAnimationFrame(paint); }, wait);
      else rafId = requestAnimationFrame(paint);
    };
    return {
      row,
      bubble,
      setText(text, withCursor, thinking) { this.setAgent(text, withCursor, thinking, []); },
      setAgent(text, withCursor, thinking, toolRuns) {
        const data = { text, withCursor, thinking, toolRuns: toolRuns ? toolRuns.map((r) => ({ ...r })) : [] };
        if (!withCursor) { pending = data; cancel(); paint(); return; }
        schedule(data);
      },
      flush() { if (pending) { cancel(); paint(); } },
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
  // Turn one stored attachment into API content blocks for the given provider.
  function attachmentBlocks(a, provStyle) {
    const blocks = [];
    const b64 = (u) => String(u || "").split(",")[1] || "";
    const kind = a.kind || (a.media_type === "application/pdf" ? "pdf" : (a.media_type || "").startsWith("image/") ? "image" : a.fileName ? "binary" : "image");
    const name = a.name || a.fileName || "file";
    if (kind === "image") {
      if (a.dataUrl && ALLOWED_IMAGE_TYPES.has(a.media_type)) {
        blocks.push({ type: "image", source: { type: "base64", media_type: a.media_type, data: b64(a.dataUrl) } });
      } else if (a.stripped) {
        blocks.push({ type: "text", text: `[Image ${name} was attached earlier (no longer stored locally).]` });
      }
      if (a.text) blocks.push({ type: "text", text: `SVG source of ${name}:\n\`\`\`svg\n${a.text}\n\`\`\`` });
      return blocks;
    }
    if (kind === "pdf") {
      const pages = a.meta?.pages ? `, ${a.meta.pages} pages` : "";
      // Claude (Anthropic API) reads PDFs natively — layout, tables and charts.
      if (provStyle === "anthropic" && a.dataUrl) {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(a.dataUrl) } });
      } else if (a.text && a.text.trim().length > 20) {
        blocks.push({ type: "text", text: `Contents of PDF \`${name}\`${pages}:\n\n${a.text}` });
      } else if (a.dataUrl) {
        blocks.push({ type: "document", source: { type: "base64", media_type: "application/pdf", data: b64(a.dataUrl) } });
      }
      for (const im of a.images || []) {
        if (im.dataUrl) blocks.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: b64(im.dataUrl) } });
      }
      if (a.note) blocks.push({ type: "text", text: `[${name}: ${a.note}]` });
      return blocks;
    }
    if (kind === "video") {
      blocks.push({ type: "text", text: `[${a.note || `Video ${name}`}]` });
      for (const im of a.images || []) {
        if (im.dataUrl) blocks.push({ type: "image", source: { type: "base64", media_type: im.media_type, data: b64(im.dataUrl) } });
      }
      return blocks;
    }
    if (a.text) {
      const lang = kind === "text" ? (a.meta?.lang || "") : "";
      const label = kind === "archive" ? "Archive" : kind === "document" ? "Document" : "File";
      blocks.push({ type: "text", text: `${label} \`${name}\`:\n\`\`\`${lang}\n${a.text}\n\`\`\`` });
      return blocks;
    }
    blocks.push({ type: "text", text: `[Attached file: ${name} (${a.media_type || "unknown type"}, ${formatSize(a.size || a.fileSize || 0)}). ${a.note || "Its binary content can't be read as text."}]` });
    return blocks;
  }

  function buildApiMessages(convo) {
    const style = providerInfo(currentProvider()).style;
    const out = [];
    for (const m of convo.messages) {
      if (m.role === "user" && m.images && m.images.length) {
        const content = [];
        for (const a of m.images) content.push(...attachmentBlocks(a, style));
        if (m.content) content.push({ type: "text", text: m.content });
        if (!content.length) content.push({ type: "text", text: "(attachment)" });
        out.push({ role: "user", content });
        continue;
      }
      if (m.role === "assistant" && m.videos?.length) {
        const note = m.videos.map((v) => `[Video generated with ${v.label}: "${String(v.prompt || "").slice(0, 400)}" — ${v.status}${v.error ? ` (${String(v.error).slice(0, 160)})` : ""}]`).join("\n");
        const text = m.kind === "video" ? note : `${m.content || ""}\n\n${note}`.trim();
        out.push({ role: "assistant", content: text });
        continue;
      }
      if (!m.content && m.role === "assistant") continue; // never send empty assistant turns
      out.push({ role: m.role, content: m.content || "(empty)" });
    }
    return out;
  }

  /* ---------- models + providers ---------- */
  function providerInfo(id) {
    const list = state.config.providers || DEFAULT_PROVIDERS;
    return list.find((p) => p.id === id) || list[0] || DEFAULT_PROVIDERS[0];
  }
  function currentProvider() {
    const p = state.settings.aiProvider;
    if (p && (state.config.providers || []).some((x) => x.id === p)) return p;
    return state.config.defaultProvider || "codecraft";
  }
  function currentModel() {
    return state.settings.model || state.config.defaultModel;
  }
  function allModels() {
    const known = new Set(state.config.models.map((m) => `${m.provider}::${m.id}`));
    const extra = (state.settings.customModels || [])
      .filter((m) => m && m.id && !known.has(`${m.provider}::${m.id}`))
      .map((m) => ({ id: m.id, label: m.id, provider: m.provider, family: "Discovered", caps: { ...ALL_CAPS, reasoning: false }, custom: true }));
    return state.config.models.concat(extra);
  }
  function modelInfo(id = currentModel(), provider = currentProvider()) {
    return allModels().find((m) => m.id === id && m.provider === provider)
      || allModels().find((m) => m.id === id)
      || { id, label: id, provider, family: "Custom", caps: { ...ALL_CAPS }, custom: true };
  }
  const modelLabel = (id, provider) => modelInfo(id, provider).label || id;
  function providerKey(provider = currentProvider()) {
    return provider === "codecraft" ? state.settings.ccKey : state.settings.apiKey;
  }
  function providerReady(provider = currentProvider()) {
    return Boolean(providerKey(provider) || providerInfo(provider).hasServerKey);
  }
  function setModel(id, provider) {
    state.settings.model = id;
    state.settings.aiProvider = provider;
    saveSettings();
    updateModelPill();
    updateKeyStatus();
    renderWelcomeStatus();
  }

  // System prompt actually sent — augmented with agent instructions in autonomous mode.
  function effectiveSystem(extra) {
    let sys = state.settings.system || "";
    if (state.settings.jsonMode) sys += `\n\n[JSON mode] Respond with a single valid JSON value only — no prose, no code fences.`;
    const repo = activeRepo();
    if (repo) {
      sys += `\n\n[Working repository] The user has selected the ${repo.provider} repository ${repo.fullName} (branch ${repo.branch || "main"}). When they refer to "the repo", "this project", or "the codebase", assume they mean ${repo.fullName}. The user can switch to a different repository at any time using the repository chip — all tools automatically target whichever repo is currently selected.`;
      sys += `\n\n[Reading the repo] You can read this repository YOURSELF using tools — do not ask the user to paste files. Use \`list_repo_files\` to see the layout, \`search_repo\` to find files by name, and \`read_repo_file\` to read a file's contents. Always inspect the real files before answering questions about the code or proposing changes.`;
      sys += `\n\n[Editing the repo] You can edit this repository like a coding agent using tools: \`write_file\` (create or fully overwrite a file), \`edit_file\` (replace an exact snippet — preferred for small, precise changes), and \`delete_file\`. Always read a file before editing it so your \`old_str\` matches exactly. Make real edits with these tools instead of pasting whole files into the chat.`;
      sys += `\n\n[Committing & pushing] You CAN push to the repository yourself — never tell the user you are unable to push. Edits are first STAGED, then when the user asks you to commit or push, call \`commit_changes\`: by default it pushes directly to the working branch, or pass open_pr:true to push to a new branch and open a pull request. If the user doesn't ask you to push, leave the changes staged so they can review the diff. After editing, briefly summarize what you changed.`;
      sys += `\n\n[Assets & logos] The MAX logo and icons are inline SVG (in the HTML/CSS) plus favicon.svg — these are code, so you CAN restyle, resize, recolor, or completely redraw them with the editing tools, and you can author brand-new SVG graphics from scratch. You can also change which asset files are referenced. The only thing you cannot do is paint raster images (.png/.jpg) pixel-by-pixel — for a new logo, create or edit an SVG instead. Do not refuse logo/branding requests: handle them by editing the SVG/CSS.`;
    }
    if (toolsAvailable()) {
      sys += `\n\n[Tools] You have tools available. Call them when they help (for example to read repository files or fetch a web page) instead of guessing. Keep going until you can fully answer, then give your final answer as normal text.`;
    }
    if (anyVideoReady()) {
      const names = [...new Set(usableVideoModels().filter((m) => !/sora/i.test(m.id)).sort((a, b) => videoNote(b.id).q - videoNote(a.id).q).map((m) => m.label))].slice(0, 8);
      sys += `\n\n[Video generation] You can create REAL AI videos with the \`generate_video\` tool (models include ${names.join(", ")}). When the user asks for a video, clip, animation, ad or shot, call it — don't write code, don't refuse, don't say you can't make videos. Choose the model that fits (e.g. Veo for realism + native sound, Kling for character motion, Seedance/Wan for long takes, fast/lite models for quick drafts) or omit \`model\` to auto-choose, and write a detailed cinematic prompt. If an image is attached and the user wants it animated, the video starts from that image.`;
    } else {
      sys += `\n\n[Video generation] No video model is connected yet. If the user asks for an AI-generated video, tell them to add an OpenRouter or Google Gemini key in Settings → Video generation (or type /motion for a code-drawn motion-graphics animation).`;
    }
    sys += powersSystemNote();
    sys += skillsSystemNote();
    if (state.settings.autonomous) {
      sys += `\n\n[Autonomous mode] Work through the user's request across multiple steps on your own initiative. Make reasonable assumptions instead of asking clarifying questions. After finishing each step you will be prompted to continue. When the ENTIRE task is fully complete, end your final message with the exact marker ${DONE_MARKER} on its own line.`;
    }
    if (extra) sys += `\n\n${extra}`;
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
    let video = null;
    const vm = text.match(/^\/video(?:\s+([\s\S]*))?$/i);
    if (vm) { // real AI video models
      const prompt = (vm[1] || "").trim();
      if (!prompt && !currentVideoImage()) {
        setVideoMode(true);
        const input = $("#input"); input.value = ""; autoResize(input); updateCharCount(); updateSendState(); input.focus();
        toast("🎬 Video mode — describe the video you want, then press Enter");
        return;
      }
      return runVideoRequest(prompt);
    }
    const mm = text.match(/^\/motion(?:\s+([\s\S]*))?$/i);
    if (mm) { // code-drawn motion graphics, recorded in the browser
      const prompt = (mm[1] || "").trim();
      if (!prompt) { $("#input").value = "/motion "; focusInputEnd(); toast("Describe the animation, e.g. /motion 8 second neon logo reveal"); return; }
      const sm = prompt.match(/(\d{1,2})\s*(?:s\b|sec|second)/i);
      video = { seconds: Math.max(2, Math.min(60, sm ? parseInt(sm[1], 10) : 8)) };
      text = `🎞 Motion graphics: ${prompt}`;
    } else if (state.videoMode && !text.startsWith("/")) {
      return runVideoRequest(text);
    } else if (text && handleSlashSend(text)) return;
    if (state.attachments.some((a) => a.pending)) { toast("Still reading your files — one moment…"); return; }
    const imgs = state.attachments.slice();
    const staged = state.basket.slice();
    if (!text && imgs.length === 0 && !staged.length) return;

    let convo = activeConvo();
    if (!convo) convo = newConversation();

    const fullText = (basketPrefix() + text).trim();
    if (staged.length) clearBasket();

    const userMsg = {
      id: uid(), role: "user", content: fullText, video: video || undefined,
      images: imgs.map((a) => ({ ...a })),
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

    // Warm the repo tree in the background so repo tools answer instantly.
    if (activeRepo() && providerHasToken(activeRepo().provider)) getTree().catch(() => {});

    if (video) await streamAssistant(convo, { video, extraSystem: VIDEO_SYSTEM(video.seconds), noTools: true });
    else if (state.settings.autonomous) await runAutonomousLoop(convo);
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
            // Auto-push disabled — MAX only pushes code, not conversations.
            // toast("Autonomous run complete — pushing to your repo…");
            // pushConversation(convo.id);
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

  /* ============================================================
     Agentic tools — MAX reads the repo / web itself, Kiro-style
     ============================================================ */
  // Human-readable metadata for the background "tool activity" cards.
  const TOOL_META = {
    list_repo_files: { icon: "🗂", verb: "Listing repository files" },
    search_repo:     { icon: "🔎", verb: "Searching the repository" },
    read_repo_file:  { icon: "📄", verb: "Reading file" },
    write_file:      { icon: "✍️", verb: "Writing file" },
    edit_file:       { icon: "✏️", verb: "Editing file" },
    delete_file:     { icon: "🗑", verb: "Deleting file" },
    commit_changes:  { icon: "🚀", verb: "Committing & pushing" },
    web_fetch:       { icon: "🌐", verb: "Fetching web page" },
    web_search:      { icon: "🔍", verb: "Searching the web" },
    generate_video:  { icon: "🎬", verb: "Generating a video" },
  };

  // Tool definitions advertised to the model (Anthropic tool schema).
  const TOOL_DEFS = {
    list_repo_files: {
      name: "list_repo_files",
      description: "List file paths in the currently selected repository. Call this first to understand the project layout.",
      input_schema: { type: "object", properties: {
        filter: { type: "string", description: "Optional substring to filter paths (e.g. 'src/' or '.js')." },
      } },
    },
    search_repo: {
      name: "search_repo",
      description: "Find files in the selected repository whose path matches a query string.",
      input_schema: { type: "object", properties: {
        query: { type: "string", description: "Text to match against file paths." },
      }, required: ["query"] },
    },
    read_repo_file: {
      name: "read_repo_file",
      description: "Read the full text contents of a file in the selected repository. Reflects any changes you've already staged this session.",
      input_schema: { type: "object", properties: {
        path: { type: "string", description: "Repository-relative path, e.g. 'src/app.js'." },
      }, required: ["path"] },
    },
    write_file: {
      name: "write_file",
      description: "Create a new file, or completely overwrite an existing one, in the selected repository. Provide the COMPLETE new file contents. The change is staged for the user to review as a diff and commit.",
      input_schema: { type: "object", properties: {
        path: { type: "string", description: "Repository-relative path, e.g. 'src/app.js'." },
        content: { type: "string", description: "The complete new contents of the file." },
      }, required: ["path", "content"] },
    },
    edit_file: {
      name: "edit_file",
      description: "Make a targeted edit to an EXISTING file by replacing an exact snippet. `old_str` must match the current file exactly (including whitespace and indentation) and must be unique unless `replace_all` is true. Prefer this over write_file for small, precise changes. Read the file first so the match is exact.",
      input_schema: { type: "object", properties: {
        path: { type: "string", description: "Repository-relative path." },
        old_str: { type: "string", description: "The exact text to find and replace." },
        new_str: { type: "string", description: "The replacement text." },
        replace_all: { type: "boolean", description: "Replace every occurrence instead of requiring a unique match (default false)." },
      }, required: ["path", "old_str", "new_str"] },
    },
    delete_file: {
      name: "delete_file",
      description: "Delete a file from the selected repository. The deletion is staged for the user to review and commit.",
      input_schema: { type: "object", properties: {
        path: { type: "string", description: "Repository-relative path to delete." },
      }, required: ["path"] },
    },
    commit_changes: {
      name: "commit_changes",
      description: "Commit and PUSH all currently staged file changes to the selected repository. By default it pushes directly to the working branch. Set open_pr:true to instead push to a new branch and open a pull request. Only call this after staging edits with write_file/edit_file/delete_file, and when the user has asked you to commit or push.",
      input_schema: { type: "object", properties: {
        message: { type: "string", description: "A clear commit message summarizing the change." },
        open_pr: { type: "boolean", description: "If true, push to a new branch and open a pull request instead of committing directly to the working branch (default false)." },
        branch: { type: "string", description: "Optional branch name to create when open_pr is true." },
      }, required: ["message"] },
    },
    web_fetch: {
      name: "web_fetch",
      description: "Fetch a web page and return its readable text.",
      input_schema: { type: "object", properties: {
        url: { type: "string", description: "An http(s) URL." },
      }, required: ["url"] },
    },
    web_search: {
      name: "web_search",
      description: "Search the web and return the top results.",
      input_schema: { type: "object", properties: {
        query: { type: "string", description: "The search query." },
      }, required: ["query"] },
    },
  };

  // Which tools are usable right now, given the selected repo + installed powers.
  function availableToolDefs() {
    const defs = [];
    if (activeRepo()) {
      defs.push(TOOL_DEFS.list_repo_files, TOOL_DEFS.search_repo, TOOL_DEFS.read_repo_file,
        TOOL_DEFS.write_file, TOOL_DEFS.edit_file, TOOL_DEFS.delete_file, TOOL_DEFS.commit_changes);
    }
    if (isInstalled("web-fetch") || activeRepo()) defs.push(TOOL_DEFS.web_fetch);
    if (isInstalled("web-search") && getPowerKey("web-search")) defs.push(TOOL_DEFS.web_search);
    if (anyVideoReady()) defs.push(videoToolDef());
    return defs;
  }
  const toolsAvailable = () => availableToolDefs().length > 0;

  // A short, Kiro-style label describing what a tool call is doing.
  function describeToolRun(run) {
    const inp = run.input || {};
    switch (run.name) {
      case "list_repo_files": return inp.filter ? `Listing files matching "${inp.filter}"` : "Listing repository files";
      case "search_repo": return `Searching the repo for "${inp.query || "…"}"`;
      case "read_repo_file": return `Reading ${inp.path || "file"}`;
      case "write_file": return `Writing ${inp.path || "file"}`;
      case "edit_file": return `Editing ${inp.path || "file"}`;
      case "delete_file": return `Deleting ${inp.path || "file"}`;
      case "commit_changes": return inp.open_pr ? "Pushing to a new branch & opening a PR" : "Committing & pushing changes";
      case "web_fetch": return `Fetching ${inp.url || "page"}`;
      case "web_search": return `Searching the web for "${inp.query || "…"}"`;
      case "generate_video": return `Generating a video${inp.model ? ` with ${String(inp.model).split("::").pop()}` : ""}: "${String(inp.prompt || "…").slice(0, 70)}${String(inp.prompt || "").length > 70 ? "…" : ""}"`;
      default: return (TOOL_META[run.name]?.verb) || run.name;
    }
  }

  /* ---------- staged working copy (Kiro-style edits) ---------- */
  const pendingCount = () => Object.keys(state.pendingEdits).length;
  function clearPendingEdits() { state.pendingEdits = {}; renderChangesChip(); }

  // Read a file as it currently stands in the working copy: a staged edit if one
  // exists, otherwise the real repo. Returns { content, exists, deleted, isNew }.
  async function readWorkingFile(path) {
    const pend = state.pendingEdits[path];
    if (pend) {
      if (pend.deleted) return { content: "", exists: false, deleted: true, isNew: false };
      return { content: pend.content, exists: true, deleted: false, isNew: pend.isNew };
    }
    try {
      const data = await providerFetch("file", { path });
      return { content: data.content || "", exists: true, deleted: false, isNew: false };
    } catch (err) {
      // Treat "not found" as a non-existent file; surface real errors.
      if (/not found|404|could not read the file/i.test(err.message || "")) {
        return { content: "", exists: false, deleted: false, isNew: true };
      }
      throw err;
    }
  }

  function stageWrite(path, content, isNew) {
    const prev = state.pendingEdits[path];
    state.pendingEdits[path] = { content, deleted: false, isNew: prev ? prev.isNew : Boolean(isNew) };
    renderChangesChip();
  }
  function stageDelete(path) {
    const prev = state.pendingEdits[path];
    // Deleting a brand-new (uncommitted) staged file just drops the stage.
    if (prev && prev.isNew) { delete state.pendingEdits[path]; renderChangesChip(); return; }
    state.pendingEdits[path] = { content: "", deleted: true, isNew: false };
    renderChangesChip();
  }
  function pendingEditsList() {
    return Object.keys(state.pendingEdits).map((path) => {
      const e = state.pendingEdits[path];
      return { path, content: e.content, deleted: e.deleted, isNew: e.isNew };
    });
  }

  // Execute one tool locally and return a string result for the model.
  async function executeTool(name, input, ctx = {}) {
    input = input || {};
    switch (name) {
      case "list_repo_files": {
        if (!activeRepo()) return "Error: no repository is selected.";
        const files = await getTree();
        let paths = files.map((f) => f.path);
        if (input.filter) { const q = String(input.filter).toLowerCase(); paths = paths.filter((p) => p.toLowerCase().includes(q)); }
        const total = paths.length;
        const shown = paths.slice(0, 600);
        const r = activeRepo();
        return `Repository ${r.fullName} (branch ${r.branch || "main"}) — ${total} file(s)${input.filter ? ` matching "${input.filter}"` : ""}:\n` +
          shown.join("\n") + (total > shown.length ? `\n… (${total - shown.length} more; narrow with a filter)` : "");
      }
      case "search_repo": {
        if (!activeRepo()) return "Error: no repository is selected.";
        const files = await getTree();
        const q = String(input.query || "").toLowerCase();
        if (!q) return "Error: 'query' is required.";
        const matches = files.filter((f) => f.path.toLowerCase().includes(q)).map((f) => f.path).slice(0, 300);
        return matches.length ? `Files matching "${input.query}":\n` + matches.join("\n") : `No file paths match "${input.query}".`;
      }
      case "read_repo_file": {
        if (!activeRepo()) return "Error: no repository is selected.";
        const path = String(input.path || "").trim();
        if (!path) return "Error: 'path' is required.";
        const wf = await readWorkingFile(path);
        if (wf.deleted) return `File ${path} is staged for deletion.`;
        if (!wf.exists) return `File ${path} does not exist in the repository. Use write_file to create it.`;
        let content = wf.content;
        const CAP = 60000;
        let note = "";
        if (content.length > CAP) { content = content.slice(0, CAP); note = `\n… (truncated at ${CAP} characters — read a narrower part if you need more)`; }
        const staged = state.pendingEdits[path] ? " (includes your staged, uncommitted changes)" : "";
        return `File ${path} (${content.length} chars)${staged}:\n\n${content}${note}`;
      }
      case "write_file": {
        if (!activeRepo()) return "Error: no repository is selected.";
        const path = String(input.path || "").trim();
        if (!path) return "Error: 'path' is required.";
        if (typeof input.content !== "string") return "Error: 'content' (the complete file text) is required.";
        let wf;
        try { wf = await readWorkingFile(path); } catch (e) { return "Error reading current file: " + (e?.message || e); }
        stageWrite(path, input.content, !wf.exists);
        return `Staged ${wf.exists ? "an overwrite of" : "a new file"} ${path} (${input.content.length} chars). It will be shown to the user as a diff to review and commit.`;
      }
      case "edit_file": {
        if (!activeRepo()) return "Error: no repository is selected.";
        const path = String(input.path || "").trim();
        if (!path) return "Error: 'path' is required.";
        if (typeof input.old_str !== "string" || typeof input.new_str !== "string") return "Error: 'old_str' and 'new_str' must both be strings.";
        if (input.old_str === "") return "Error: 'old_str' must not be empty. Use write_file to create a file or fully replace its contents.";
        let wf;
        try { wf = await readWorkingFile(path); } catch (e) { return "Error reading file: " + (e?.message || e); }
        if (!wf.exists) return `Error: ${path} does not exist${wf.deleted ? " (it is staged for deletion)" : ""}. Use write_file to create it.`;
        const occurrences = wf.content.split(input.old_str).length - 1;
        if (occurrences === 0) return `Error: old_str was not found in ${path}. It must match the current file EXACTLY, including whitespace and indentation. Read the file again and retry with an exact snippet.`;
        if (occurrences > 1 && !input.replace_all) return `Error: old_str appears ${occurrences} times in ${path}. Add more surrounding context to make it unique, or set replace_all: true.`;
        const newContent = input.replace_all
          ? wf.content.split(input.old_str).join(input.new_str)
          : wf.content.replace(input.old_str, input.new_str);
        if (newContent === wf.content) return `No change: the edit to ${path} would not modify the file.`;
        stageWrite(path, newContent, wf.isNew);
        return `Staged an edit to ${path} (${occurrences === 1 ? "1 replacement" : occurrences + " replacements"}). Review & commit to apply.`;
      }
      case "delete_file": {
        if (!activeRepo()) return "Error: no repository is selected.";
        const path = String(input.path || "").trim();
        if (!path) return "Error: 'path' is required.";
        let wf;
        try { wf = await readWorkingFile(path); } catch (e) { return "Error: " + (e?.message || e); }
        if (!wf.exists && !wf.deleted) return `Error: ${path} does not exist, so there is nothing to delete.`;
        if (wf.deleted) return `${path} is already staged for deletion.`;
        stageDelete(path);
        return `Staged deletion of ${path}. Review & commit to apply.`;
      }
      case "commit_changes": {
        const repo = activeRepo();
        if (!repo) return "Error: no repository is selected.";
        if (!providerHasToken(repo.provider)) return `Error: connect ${repo.provider === "gitlab" ? "GitLab" : "GitHub"} with a write-enabled token in Settings first.`;
        const edits = pendingEditsList();
        if (!edits.length) return "Error: there are no staged changes to commit. Stage edits first with write_file / edit_file / delete_file.";
        const message = String(input.message || "").trim() || `MAX: update ${edits.length} file(s)`;
        try {
          return await runCommit(repo, edits, { message, openPr: input.open_pr === true, branch: input.branch });
        } catch (e) {
          return "Error committing: " + (e?.message || e);
        }
      }
      case "web_fetch": {
        const url = String(input.url || "").trim();
        if (!url) return "Error: 'url' is required.";
        const res = await fetch("/api/powers/fetch", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return `Error fetching page: ${data?.error?.message || `HTTP ${res.status}`}`;
        let text = data.text || "";
        if (text.length > 40000) text = text.slice(0, 40000) + "\n… (truncated)";
        return `Fetched ${data.url}:\n\n${text}`;
      }
      case "web_search": {
        const query = String(input.query || "").trim();
        if (!query) return "Error: 'query' is required.";
        const key = getPowerKey("web-search");
        if (!key) return "Error: Web Search isn't configured (no API key).";
        const res = await fetch("/api/powers/search", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ query, key }) });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return `Error searching: ${data?.error?.message || `HTTP ${res.status}`}`;
        const parts = [];
        if (data.answer) parts.push(`Summary: ${data.answer}`);
        (data.results || []).forEach((r, i) => parts.push(`${i + 1}. ${r.title}\n${r.url}\n${(r.content || "").slice(0, 500)}`));
        return parts.join("\n\n") || "No results.";
      }
      case "generate_video":
        return await runVideoTool(input, ctx);
      default:
        return `Error: unknown tool "${name}".`;
    }
  }

  // Render the live "what MAX is doing" activity cards.
  function toolRunsHtml(runs) {
    if (!runs || !runs.length) return "";
    return `<div class="tool-runs">` + runs.map((r) => {
      const icon = TOOL_META[r.name]?.icon || "🔧";
      const status = r.status || "done";
      const mark = status === "running"
        ? `<span class="tool-run__spin" aria-label="running"></span>`
        : status === "error"
          ? `<span class="tool-run__mark tool-run__mark--err">!</span>`
          : `<span class="tool-run__mark tool-run__mark--ok">✓</span>`;
      const detail = r.result
        ? `<details class="tool-run__detail"><summary>result</summary><pre>${esc(String(r.result).slice(0, 4000))}</pre></details>`
        : "";
      return `<div class="tool-run tool-run--${status}">
        <div class="tool-run__row"><span class="tool-run__ico">${icon}</span><span class="tool-run__label">${esc(describeToolRun(r))}</span>${mark}</div>
        ${detail}</div>`;
    }).join("") + `</div>`;
  }

  /* ============================================================
     Agent turn + tool loop (streaming)
     ============================================================ */
  // Stream a single model response, updating the visible bubble live (text +
  // tool-activity cards). Returns the parsed { text, thinking, toolUses, stopReason, usage }.
  async function runModelTurn(apiMessages, useModel, toolDefs, stream, ctx) {
    const useProvider = ctx.provider || currentProvider();
    const info = modelInfo(useModel, useProvider);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: state.abort.signal,
      body: JSON.stringify({
        provider: useProvider,
        model: useModel,
        system: effectiveSystem(ctx.extraSystem),
        max_tokens: state.settings.maxTokens,
        temperature: state.settings.temperature,
        apiKey: providerKey(useProvider) || undefined,
        effort: info.caps?.reasoning !== false ? state.settings.effort : undefined,
        json: Boolean(state.settings.jsonMode && info.caps?.json !== false && !toolDefs.length) || undefined,
        stream: true,
        messages: apiMessages,
        tools: toolDefs.length ? toolDefs : undefined,
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

    const blocks = {}; // index -> { type, text, id, name, json }
    let stopReason = null;
    let usage = null;
    let curText = "";
    let curThinking = "";

    // Coalesced to one paint per animation frame (see appendStreamingAssistant).
    const rerender = () => stream.setAgent(ctx.priorText + curText, true, (ctx.priorThinking || "") + curThinking, ctx.toolRuns);

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
        case "content_block_start": {
          const cb = evt.content_block || {};
          if (cb.type === "tool_use") {
            blocks[evt.index] = { type: "tool_use", id: cb.id, name: cb.name, json: "" };
            ctx.toolRuns.push({ id: cb.id, name: cb.name, input: null, status: "running", result: null });
            rerender();
          } else if (cb.type === "thinking") {
            blocks[evt.index] = { type: "thinking", thinking: "", signature: "" };
            setStreamLabel("Thinking…");
          } else if (cb.type === "redacted_thinking") {
            blocks[evt.index] = { type: "redacted_thinking", data: cb.data || "" };
          } else {
            blocks[evt.index] = { type: cb.type || "text", text: "" };
          }
          break;
        }
        case "content_block_delta": {
          const b = blocks[evt.index];
          if (evt.delta?.type === "text_delta" && evt.delta.text) {
            if (b) b.text = (b.text || "") + evt.delta.text;
            curText += evt.delta.text; if (curText.length < 20) setStreamLabel("Writing…"); rerender();
          } else if (evt.delta?.type === "thinking_delta" && evt.delta.thinking) {
            if (b && b.type === "thinking") b.thinking += evt.delta.thinking;
            curThinking += evt.delta.thinking; rerender();
          } else if (evt.delta?.type === "signature_delta" && b && b.type === "thinking") {
            b.signature = (b.signature || "") + (evt.delta.signature || "");
          } else if (evt.delta?.type === "input_json_delta" && evt.delta.partial_json != null && b) {
            b.json = (b.json || "") + evt.delta.partial_json;
          }
          break;
        }
        case "content_block_stop": {
          const b = blocks[evt.index];
          if (b && b.type === "tool_use") {
            let input = {};
            try { input = b.json ? JSON.parse(b.json) : {}; } catch { input = {}; }
            b.input = input;
            const run = ctx.toolRuns.find((r) => r.id === b.id);
            if (run) { run.input = input; rerender(); }
          }
          break;
        }
        case "message_delta":
          if (evt.delta?.stop_reason) stopReason = evt.delta.stop_reason;
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
        for (const record of final.records) if (consumeRecord(record)) break;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const parsed = takeSseRecords(buffer);
      buffer = parsed.rest;
      for (const record of parsed.records) {
        if (consumeRecord(record)) { stopped = true; await reader.cancel().catch(() => {}); break; }
      }
    }

    const orderedIdx = Object.keys(blocks).map(Number).sort((a, b) => a - b);
    let text = "";
    const toolUses = [];
    const thinkingBlocks = []; // echoed back on tool loops (Anthropic requires it)
    for (const i of orderedIdx) {
      const b = blocks[i];
      if (b.type === "text") text += b.text || "";
      else if (b.type === "tool_use") toolUses.push({ id: b.id, name: b.name, input: b.input || {} });
      else if (b.type === "thinking" && b.signature) thinkingBlocks.push({ type: "thinking", thinking: b.thinking, signature: b.signature });
      else if (b.type === "redacted_thinking" && b.data) thinkingBlocks.push({ type: "redacted_thinking", data: b.data });
    }
    stream.flush?.();
    return { text, thinking: curThinking, thinkingBlocks, toolUses, stopReason, usage };
  }

  function mergeUsage(a, b) {
    if (!a) return b ? { ...b } : null;
    if (!b) return a;
    return {
      input_tokens: (a.input_tokens || 0) + (b.input_tokens || 0),
      output_tokens: (a.output_tokens || 0) + (b.output_tokens || 0),
    };
  }

  async function streamAssistant(convo, opts = {}) {
    state.streaming = true;
    toggleStreamingUI(true);

    const stream = appendStreamingAssistant();
    const useModel = opts.model || currentModel();
    const useProvider = opts.provider || currentProvider();
    const useInfo = modelInfo(useModel, useProvider);
    const provStyle = providerInfo(useProvider).style;
    const startedAt = Date.now();
    const toolDefs = (opts.noTools || useInfo.caps?.tools === false) ? [] : availableToolDefs();
    const MAX_TOOL_ROUNDS = 16;

    if (!providerReady(useProvider)) {
      stream.bubble.classList.remove("md");
      stream.bubble.innerHTML = `<div class="err-card">⚠ No ${esc(providerInfo(useProvider).label)} API key yet.
        <button class="btn btn--primary btn--sm" type="button" data-open-settings>Add key in Settings</button></div>`;
      stream.bubble.querySelector("[data-open-settings]").addEventListener("click", () => openSettings("providers"));
      state.streaming = false; toggleStreamingUI(false);
      return;
    }
    const hasImages = convo.messages.some((m) => (m.images || []).some((a) => a.kind === "image" || a.kind === "video" || (a.images || []).length));
    if (hasImages && useInfo.caps?.vision === false && !state._visionWarned) {
      state._visionWarned = true;
      toast(`${useInfo.label} may not support images — switch to a vision model (e.g. Claude Opus 5) if it can't see them.`, "");
    }

    // Local working history for this agent turn (tool_use/tool_result blocks are
    // kept here only; the persisted conversation stores just the final text).
    const apiMessages = buildApiMessages(convo);
    const toolRuns = [];    // display + persistence
    const turnVideos = [];  // videos started by generate_video during this turn
    let finalText = "";
    let finalThinking = "";
    let usage = null;

    state.abort = new AbortController();

    try {
      let round = 0;
      for (; round <= MAX_TOOL_ROUNDS; round++) {
        if (state.abort.signal.aborted) break;
        let turn;
        try {
          turn = await runModelTurn(apiMessages, useModel, toolDefs, stream, {
            priorText: finalText ? finalText + "\n\n" : "",
            priorThinking: finalThinking ? finalThinking + "\n\n" : "",
            toolRuns, provider: useProvider, extraSystem: opts.extraSystem,
          });
        } catch (turnErr) {
          // If we already have some text, preserve it and break gracefully
          if (finalText.trim() || toolRuns.length) break;
          throw turnErr; // propagate to outer catch if nothing was produced
        }
        usage = mergeUsage(usage, turn.usage);
        if (turn.thinking) finalThinking = finalThinking ? finalThinking + "\n\n" + turn.thinking : turn.thinking;
        if (turn.text) finalText = finalText ? finalText + "\n\n" + turn.text : turn.text;

        const wantsTools = turn.stopReason === "tool_use" && turn.toolUses.length;
        if (!wantsTools || state.autoStop || state.abort.signal.aborted) break;

        // Record the assistant tool-use turn in the working history…
        const assistantBlocks = [];
        // Claude requires its signed thinking blocks to be echoed back in tool loops.
        if (provStyle === "anthropic" && turn.thinkingBlocks?.length) assistantBlocks.push(...turn.thinkingBlocks);
        if (turn.text) assistantBlocks.push({ type: "text", text: turn.text });
        for (const tu of turn.toolUses) assistantBlocks.push({ type: "tool_use", id: tu.id, name: tu.name, input: tu.input });
        apiMessages.push({ role: "assistant", content: assistantBlocks });

        // …execute each tool and feed the results back.
        const resultBlocks = [];
        for (const tu of turn.toolUses) {
          const run = toolRuns.find((r) => r.id === tu.id) || { id: tu.id, name: tu.name, input: tu.input, status: "running" };
          setStreamLabel(describeToolRun(run));
          let result, ok = true;
          try { result = await executeTool(tu.name, tu.input, { videos: turnVideos, convo }); }
          catch (e) {
            ok = false;
            const msg = e?.message || String(e);
            // Provide actionable error messages so the model can self-correct
            if (/no.*token|connect.*first/i.test(msg)) result = `Error: ${msg} (The user needs to add a token in Settings → GitHub before this can work.)`;
            else if (/not found|404|does not exist/i.test(msg)) result = `Error: ${msg} (The file or path may not exist — check the path and try again.)`;
            else if (/too large|413/i.test(msg)) result = `Error: ${msg} (Try a smaller file or a narrower read.)`;
            else result = `Error: ${msg}`;
          }
          run.status = ok ? "done" : "error";
          run.result = result;
          stream.setAgent(finalText, true, finalThinking, toolRuns);
          resultBlocks.push({ type: "tool_result", tool_use_id: tu.id, content: String(result), ...(ok ? {} : { is_error: true }) });
        }
        setStreamLabel("Thinking…");
        apiMessages.push({ role: "user", content: resultBlocks });
      }

      if (!finalText.trim() && !toolRuns.length) {
        throw new Error("The model returned an empty response. Try another model or prompt.");
      }
      if (!finalText.trim() && toolRuns.length) {
        // The model used tools but produced no final text. This usually means it
        // ran out of output tokens mid-tool-loop, or the last turn was all tool
        // calls with no text follow-up. Ask it for a summary of what it found.
        const lastResults = toolRuns.filter((r) => r.status === "done").slice(-3)
          .map((r) => `${r.name}(${JSON.stringify(r.input || {})}) → ${(r.result || "").slice(0, 500)}`).join("\n");
        const summaryMsg = { role: "user", content: [{ type: "text", text: "You already gathered the information above. Now give your final answer to the user based on what you found. Be concise and helpful." }] };
        apiMessages.push(summaryMsg);
        // One more turn without tools to force a text response.
        const follow = await runModelTurn(apiMessages, useModel, [], stream, {
          priorText: "",
          toolRuns, provider: useProvider, extraSystem: opts.extraSystem,
        });
        if (follow.text) {
          finalText = follow.text;
          usage = mergeUsage(usage, follow.usage);
        } else {
          finalText = "I finished reading the repository but couldn't generate a summary. This usually means the model ran out of output tokens. Try asking a more specific question, or increase Max tokens in Settings.";
        }
      }

      // finalize
      stream.setAgent(finalText, false, finalThinking, toolRuns);
      const pending = pendingEditsList();
      const aiMsg = {
        id: uid(), role: "assistant", content: finalText, usage, model: useModel, provider: useProvider,
        effort: useInfo.caps?.reasoning !== false ? state.settings.effort : undefined,
        video: opts.video || undefined,
        thinking: finalThinking || undefined,
        toolRuns: toolRuns.length ? toolRuns.map((r) => ({
          name: r.name, input: r.input, status: r.status,
          result: typeof r.result === "string" ? r.result.slice(0, 8000) : r.result,
        })) : undefined,
        stagedEdits: pending.length ? pending : undefined,
        videos: turnVideos.length ? turnVideos : undefined,
      };
      convo.messages.push(aiMsg);
      touchConvo(convo);
      renderMessages();
      renderConversations();
      updateUsagePill();
      for (const v of turnVideos) { looseVideos.delete(v.jobId); trackVideo(v.jobId); }
      logRequest({ model: useModel, ok: true, ms: Date.now() - startedAt, tokens: usage?.output_tokens });
      if (opts.video) setTimeout(() => autoRenderVideo(aiMsg), 250);

      // If MAX changed files this turn, nudge the user to review the diff.
      const editedThisTurn = toolRuns.some((r) => ["write_file", "edit_file", "delete_file"].includes(r.name) && r.status === "done");
      if (editedThisTurn && pending.length) {
        const n = pending.length;
        toast(`MAX staged ${n} file change${n > 1 ? "s" : ""} — review to commit`, "success");
        if (!state.settings.autonomous && !state.autoRunning) {
          setTimeout(() => { if (!state.streaming) openDiffModal(pendingEditsList()); }, 350);
        }
      }
    } catch (err) {
      const aborted = err.name === "AbortError" || state.abort?.signal.aborted;
      if (aborted && (finalText || toolRuns.length)) {
        stream.setAgent(finalText, false, finalThinking, toolRuns);
        convo.messages.push({ id: uid(), role: "assistant", content: finalText || "_(stopped)_", usage, stopped: true, toolRuns: toolRuns.length ? toolRuns : undefined, videos: turnVideos.length ? turnVideos : undefined });
        for (const v of turnVideos) { looseVideos.delete(v.jobId); trackVideo(v.jobId); }
        touchConvo(convo);
        renderMessages();
      } else if (aborted) {
        stream.row.remove();
        renderMessages();
      } else {
        const msg = err.message || "";
        // Transient provider/gateway failures (e.g. new-api "panic",
        // 5xx/overloaded/rate-limit, dropped connection). These usually succeed
        // on a second try — retry the same request a couple of times with backoff
        // before doing anything else, as long as nothing has been produced yet.
        const transient = /panic|interface conversion|new-api|overloaded|temporarily|rate.?limit|too many requests|\b429\b|\b50[0-9]\b|bad gateway|gateway tim|unavailable|try again|timed? ?out|took too long|econnreset|reset by peer|eof/i.test(msg);
        const attempt = opts.attempt || 0;
        if (transient && attempt < 2 && !finalText.trim() && !toolRuns.length) {
          stream.row.remove();
          toast(`Provider hiccup — retrying (${attempt + 1}/2)…`, "");
          state.streaming = false; state.abort = null;
          await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
          await streamAssistant(convo, { ...opts, attempt: attempt + 1 });
          return;
        }

        // Some models/gateways don't support tool use and may error (or time out).
        // If we sent tools and got nothing back, retry once as a plain chat so the
        // user still gets an answer instead of a dead end.
        const skipRetry = /api key|unauthorized|forbidden|\b401\b|\b403\b|no_api_key/i.test(msg);
        if (!opts.noTools && toolDefs.length && !finalText.trim() && !toolRuns.length && !skipRetry) {
          stream.row.remove();
          toast("That model had trouble with tools — retrying without them…", "");
          state.streaming = false; state.abort = null;
          await streamAssistant(convo, { ...opts, noTools: true });
          return;
        }
        const isNetwork = err instanceof TypeError || /failed to fetch|networkerror|load failed|connection/i.test(msg);
        const isProviderPanic = /panic|interface conversion|new-api/i.test(msg);
        const friendly = isProviderPanic
          ? "The AI provider's gateway crashed on this request (an internal 'panic' in AgentRouter/new-api — not a MAX bug). This is usually temporary. Press Retry, switch to another model, or check your AgentRouter key/quota if it keeps happening."
          : isNetwork
            ? "Can't reach the MAX server. Make sure it's still running (node server.js) in your terminal, then reload this page and try again."
            : msg;
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

  async function regenerate(aiMsg, modelOverride, providerOverride) {
    if (state.streaming) return;
    const convo = activeConvo();
    if (!convo) return;
    const idx = convo.messages.findIndex((m) => m.id === aiMsg.id);
    if (idx === -1) return;
    // remove this assistant message (and anything after it)
    convo.messages.splice(idx);
    touchConvo(convo);
    renderMessages();
    const opts = modelOverride ? { model: modelOverride, provider: providerOverride } : {};
    const lastUser = [...convo.messages].reverse().find((m) => m.role === "user");
    if (lastUser?.video) Object.assign(opts, { video: lastUser.video, extraSystem: VIDEO_SYSTEM(lastUser.video.seconds), noTools: true });
    await streamAssistant(convo, opts);
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
      allModels().filter((m) => providerReady(m.provider)).map((m) =>
        `<button data-m="${esc(m.id)}" data-p="${esc(m.provider)}" style="display:block;width:100%;padding:8px 10px;background:none;border:none;color:var(--text);border-radius:7px;text-align:left">${esc(m.label || m.id)} <span style="opacity:.5;font-size:11px">${esc(providerInfo(m.provider).label)}</span></button>`).join("");
    document.body.appendChild(pop);
    const r = anchorBtn.getBoundingClientRect();
    pop.style.top = `${Math.min(r.bottom + 6, window.innerHeight - 270)}px`;
    pop.style.left = `${Math.min(r.left, window.innerWidth - 220)}px`;
    pop.querySelectorAll("button[data-m]").forEach((b) => {
      b.addEventListener("mouseenter", () => (b.style.background = "var(--surface-2)"));
      b.addEventListener("mouseleave", () => (b.style.background = "none"));
      b.addEventListener("click", () => { pop.remove(); regenerate(aiMsg, b.dataset.m, b.dataset.p); });
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
    // Streaming status indicator in topbar
    const status = $("#stream-status");
    if (status) {
      status.hidden = !active;
      if (active) {
        state._streamStart = Date.now();
        if (state._streamInterval) clearInterval(state._streamInterval);
        state._streamInterval = setInterval(updateStreamTimer, 1000);
        setStreamLabel("Thinking…");
      } else {
        clearInterval(state._streamInterval);
        state._streamInterval = null;
      }
    }
  }

  function updateStreamTimer() {
    const el = $("#stream-timer");
    if (!el || !state._streamStart) return;
    const sec = Math.round((Date.now() - state._streamStart) / 1000);
    el.textContent = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`;
  }

  function setStreamLabel(text) {
    const el = $("#stream-label");
    if (el) el.textContent = text || "Working…";
  }

  /* ---------- attachments ---------- */
  // Every file type is accepted and read by public/files.js (MaxFiles).
  const KIND_ICON = { pdf: "📕", document: "📝", archive: "📦", video: "🎬", audio: "🎵", text: "📄", binary: "📎", image: "🖼️" };
  function attachmentChipHtml(a, removable) {
    const name = a.name || a.fileName || "file";
    const size = a.size || a.fileSize;
    if ((a.kind === "image" || (!a.kind && (a.media_type || "").startsWith("image/"))) && a.dataUrl) {
      return `<div class="attachment" data-id="${esc(a.id || "")}" title="${esc(name)}">
        <img src="${a.dataUrl}" alt="${esc(name)}" loading="lazy" decoding="async">
        ${removable ? `<button class="attachment__remove" data-remove="${esc(a.id)}" title="Remove" type="button">×</button>` : ""}
      </div>`;
    }
    if (a.pending) {
      return `<div class="attachment attachment--file attachment--pending" data-id="${esc(a.id)}">
        <span class="tool-run__spin"></span><span class="attachment__name">${esc(name)}</span>
        <span class="attachment__meta">${a.progress ? Math.round(a.progress * 100) + "%" : "reading…"}</span></div>`;
    }
    const kind = a.kind || (a.media_type === "application/pdf" ? "pdf" : "binary");
    const bits = [];
    if (size) bits.push(formatSize(size));
    if (a.meta?.pages) bits.push(`${a.meta.pages} pages`);
    if (a.meta?.duration) bits.push(`${Math.round(a.meta.duration)}s · ${(a.images || []).length} frames`);
    if (a.meta?.entries && kind === "archive") bits.push(`${a.meta.entries} files`);
    if (a.text && kind !== "image") bits.push(a.text.length < 1000 ? `${a.text.length} chars` : `${(a.text.length / 1000).toFixed(1)}k chars`);
    const readable = a.text || (a.images || []).length || (kind === "pdf" && a.dataUrl);
    return `<div class="attachment attachment--file${readable ? "" : " attachment--warn"}" data-id="${esc(a.id || "")}" title="${esc(a.note || name)}">
      <span class="attachment__icon">${KIND_ICON[kind] || "📎"}</span>
      <span class="attachment__text"><span class="attachment__name">${esc(name)}</span>
      <span class="attachment__meta">${esc(bits.join(" · ") || kind)}${readable ? "" : " · not readable"}</span></span>
      ${removable ? `<button class="attachment__remove" data-remove="${esc(a.id)}" title="Remove" type="button">×</button>` : ""}
    </div>`;
  }
  function renderAttachments() {
    $("#attachments").innerHTML = state.attachments.map((a) => attachmentChipHtml(a, true)).join("");
    updateSendState();
    if (state.videoMode) renderVideoControls(); // an image can change the auto-chosen model
  }
  function clearAttachments() { state.attachments = []; renderAttachments(); }

  const MAX_ATTACH_BYTES = 50 * 1024 * 1024;
  async function handleFiles(files) {
    const list = [...files];
    if (!list.length) return;
    if (!window.MaxFiles) { toast("File reader failed to load — reload the page.", "error"); return; }
    await Promise.all(list.map(async (file) => {
      if (file.size > MAX_ATTACH_BYTES) { toast(`${file.name} is too large (max 50 MB).`, "error"); return; }
      const placeholder = { id: uid(), name: file.name, size: file.size, pending: true };
      state.attachments.push(placeholder);
      renderAttachments();
      let att;
      try {
        att = await MaxFiles.processFile(file, {
          onProgress: (p) => { placeholder.progress = p; const el = $(`.attachment[data-id="${placeholder.id}"] .attachment__meta`); if (el) el.textContent = Math.round(p * 100) + "%"; },
        });
      } catch (e) {
        att = { id: uid(), kind: "binary", name: file.name, size: file.size, media_type: file.type, note: `Could not read (${e?.message || e}).` };
      }
      const i = state.attachments.indexOf(placeholder);
      if (i === -1) return; // removed while reading
      state.attachments[i] = att;
      renderAttachments();
      if (att.kind === "binary") toast(att.note || `${file.name} attached (binary).`, "");
      else if (att.meta?.scanned) toast(`${file.name}: scanned PDF — pages attached as images for vision.`, "");
    }));
    updateSendState();
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
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
      for (const v of m.videos || []) lines.push(`> 🎬 **Video** (${v.label}, ${v.status}): ${String(v.prompt || "").replace(/\n/g, " ")}`, "");
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
          provider: $("#set-model-custom").value.trim() ? $("#set-model-custom-prov").value : $("#set-model").value.split("::")[0],
          apiKey: (($("#set-model-custom").value.trim() ? $("#set-model-custom-prov").value : $("#set-model").value.split("::")[0]) === "codecraft"
            ? $("#set-cckey").value.trim() : $("#set-apikey").value.trim()) || undefined,
          model: $("#set-model-custom").value.trim() || $("#set-model").value.split("::").slice(1).join("::"),
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
      chip.title = `Working in ${r.fullName} (${r.provider}, ${r.branch || "main"}) — click to switch repos`;
      clear.hidden = false;
      if (filesBtn) filesBtn.hidden = false;
      const bc = $("#branch-chip");
      if (bc) { bc.hidden = false; $("#branch-chip-label").textContent = r.branch || "main"; }
    } else {
      lbl.textContent = "Add repository";
      chip.classList.remove("selected");
      chip.title = "Pick a repository — MAX can then read, edit & push to it";
      clear.hidden = true;
      if (filesBtn) filesBtn.hidden = true;
      const bc = $("#branch-chip");
      if (bc) bc.hidden = true;
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
    // Keep Settings in sync so the fields always reflect the active repo.
    // This means: pick a repo from the chip → Settings auto-updates → no confusion.
    if (provider === "github") {
      state.settings.github.owner = repo.owner;
      state.settings.github.repo = repo.name;
      state.settings.github.branch = bind.branch;
    }
    saveSettings();
    updateRepoChip();
    renderConversations();
    treeCache = null; // invalidate cached file tree
    clearPendingEdits(); // staged edits belong to the previous repo
    toast(`Switched to ${repo.fullName} — MAX can now read, edit & push here`, "success");
  }

  function clearRepo() {
    const c = activeConvo();
    if (c) { delete c.repo; touchConvo(c); }
    state.settings.lastRepo = null;
    saveSettings();
    updateRepoChip();
    treeCache = null;
    clearPendingEdits();
    toast("Repository cleared");
  }

  // Bind the repo configured in Settings (Owner/Repository + token) as MAX's
  // working repo, so the agentic read/edit tools activate. Without this,
  // configuring GitHub in Settings alone would NOT let MAX read the repo — the
  // tools require a selected working repository.
  function bindRepoFromGithubSettings(silent) {
    const g = state.settings.github || {};
    if (!g.owner || !g.repo) return false;
    if (!providerHasToken("github")) return false;
    const bind = {
      provider: "github",
      fullName: `${g.owner}/${g.repo}`,
      owner: g.owner,
      name: g.repo,
      projectId: null,
      branch: g.branch || "main",
    };
    const c = activeConvo();
    if (c) { c.repo = bind; touchConvo(c); }
    state.settings.lastRepo = bind;
    saveSettings();
    updateRepoChip();
    renderConversations();
    treeCache = null;
    if (!silent) toast(`MAX is now working in ${bind.fullName} (${bind.branch})`, "success");
    return true;
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

  const repoListCache = {}; // provider -> { repos, at }
  const repoListInflight = {};
  async function fetchRepos(provider, q) {
    if (!q && repoListInflight[provider]) return repoListInflight[provider];
    const run = (async () => {
      const res = await fetch(`/api/${provider}/repos`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: providerToken(provider) || undefined, q: q || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const repos = data.repos || [];
      if (!q) repoListCache[provider] = { repos, at: Date.now() };
      return repos;
    })();
    if (!q) { repoListInflight[provider] = run; run.finally(() => { delete repoListInflight[provider]; }).catch(() => {}); }
    return run;
  }

  // Connection status for the welcome panel + composer, refreshed on startup,
  // each new chat, after Settings are saved, and when the tab regains focus.
  let ghStatusAt = 0;
  async function refreshGithubStatus(force) {
    if (!providerHasToken("github")) { state.ghStatus = null; renderGhStatus(); return; }
    if (!force && Date.now() - ghStatusAt < 20_000) return;
    ghStatusAt = Date.now();
    try {
      const res = await fetch("/api/github/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: providerToken("github") || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      state.ghStatus = { login: data.login, avatarUrl: data.avatarUrl, repoCount: state.ghStatus?.repoCount ?? null };
      renderGhStatus();
      const repos = await fetchRepos("github").catch(() => null);
      if (repos) { state.ghStatus.repoCount = repos.length; renderGhStatus(); }
    } catch (err) {
      state.ghStatus = { error: (err instanceof TypeError ? "Can't reach the MAX server" : err.message).split("\n")[0].slice(0, 140) };
      renderGhStatus();
    }
  }
  function renderGhStatus() {
    const el = $("#gh-status");
    if (el) {
      const st = state.ghStatus;
      el.hidden = !st;
      if (st) {
        el.className = "gh-status" + (st.error ? " gh-status--err" : "");
        el.innerHTML = st.error ? "⚠ GitHub" : `<span class="gh-status__dot"></span>${esc(st.login || "")}`;
        el.title = st.error ? `GitHub: ${st.error}` : `Connected to GitHub as ${st.login}${st.repoCount != null ? ` · ${st.repoCount} repositories` : ""}`;
      }
    }
    renderWelcomeStatus();
  }

  /* ---------- branch switcher ---------- */
  async function openBranchPicker(anchor) {
    if (popEl && popEl.classList.contains("branch-pop")) { closePop(); return; }
    closePop();
    const r = activeRepo();
    if (!r) return;
    const pop = document.createElement("div");
    pop.className = "repo-pop branch-pop";
    pop.innerHTML = `<div class="repo-pop__head"><div class="repo-pop__title">Branch · ${esc(r.fullName)}</div></div>
      <div class="repo-pop__search"><svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
      <input type="text" placeholder="Filter branches" autocomplete="off" spellcheck="false" /></div>
      <div class="repo-pop__list"><div class="repo-spinner"></div></div>`;
    document.body.appendChild(pop);
    popEl = pop;
    placePop(pop, anchor, "above");
    dismissOnOutside(pop, anchor);
    const listEl = pop.querySelector(".repo-pop__list");
    const input = pop.querySelector("input");
    let branches = [];
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const shown = branches.filter((b) => !q || b.name.toLowerCase().includes(q)).slice(0, 200);
      listEl.innerHTML = shown.map((b) => `<button type="button" class="repo-item${b.name === r.branch ? " active" : ""}" data-b="${esc(b.name)}">
        <span class="repo-item__name">${esc(b.name)}${b.protected ? " 🔒" : ""}</span>${b.name === r.branch ? `<svg class="repo-item__check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>` : ""}</button>`).join("")
        || `<div class="repo-pop__msg">No branches match.</div>`;
      listEl.querySelectorAll("[data-b]").forEach((b) => b.addEventListener("click", () => { closePop(); switchBranch(b.dataset.b); }));
    };
    try {
      const data = await providerFetch("branches", {});
      branches = data.branches || [];
      render();
      input.addEventListener("input", render);
      setTimeout(() => input.focus(), 20);
    } catch (err) {
      listEl.innerHTML = `<div class="repo-pop__msg">✗ ${esc(err.message)}</div>`;
    }
  }
  function switchBranch(name) {
    const r = activeRepo();
    if (!r || r.branch === name) return;
    if (pendingCount() && !confirm("You have staged changes on the current branch. Switch anyway? (They will be discarded.)")) return;
    const bind = { ...r, branch: name };
    const c = activeConvo();
    if (c) { c.repo = bind; touchConvo(c); }
    state.settings.lastRepo = bind;
    if (bind.provider === "github") state.settings.github.branch = name;
    saveSettings();
    treeCache = null; clearPendingEdits(); updateRepoChip();
    toast(`Switched to branch ${name}`, "success");
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
        <div class="repo-pop__title">Switch repository</div>
        <div class="repo-pop__hint">Pick any repo — MAX reads, edits &amp; pushes to it instantly</div>
        <div class="repo-pop__tabs">
          <button class="repo-tab" data-tab="github" type="button">GitHub</button>
          <button class="repo-tab" data-tab="gitlab" type="button">GitLab</button>
          <span class="repo-pop__stamp"></span>
          <button class="icon-btn repo-pop__refresh" id="repo-refresh" type="button" title="Refresh repository list" aria-label="Refresh">
            <svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 11-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>
          </button>
        </div>
      </div>
      <div class="repo-pop__search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" id="repo-search" placeholder="Search your repos, or type owner/name" autocomplete="off" spellcheck="false" />
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
    pop.querySelector("#repo-refresh").addEventListener("click", () => {
      if (providerHasToken(provider)) loadRepoList(listEl, provider, searchEl.value.trim(), true);
    });
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

  function timeAgo(ts) {
    if (!ts) return "";
    const d = (Date.now() - new Date(ts).getTime()) / 1000;
    if (d < 3600) return `${Math.max(1, Math.round(d / 60))}m ago`;
    if (d < 86400) return `${Math.round(d / 3600)}h ago`;
    if (d < 86400 * 30) return `${Math.round(d / 86400)}d ago`;
    return new Date(ts).toLocaleDateString();
  }
  function renderRepoRows(listEl, provider, repos, q) {
    if (!repos.length) {
      listEl.innerHTML = `<div class="repo-pop__msg">${q ? "No matching repositories. Tip: type owner/name to open any public repo." : "No repositories found for this token."}</div>`;
      return;
    }
    const current = selectedRepoLabel();
    const lock = `<svg class="repo-item__ico" viewBox="0 0 24 24"><rect x="4" y="10" width="16" height="10" rx="2"/><path d="M8 10V7a4 4 0 018 0v3"/></svg>`;
    const open = `<svg class="repo-item__ico" viewBox="0 0 24 24"><path d="M3 7h6l2 2h10v9a2 2 0 01-2 2H5a2 2 0 01-2-2z"/></svg>`;
    const check = `<svg class="repo-item__check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>`;
    listEl.innerHTML = repos.slice(0, 400).map((x, i) => `
      <button class="repo-item repo-item--rich${x.fullName === current ? " active" : ""}" type="button" data-i="${i}" title="${esc(x.description || x.fullName)}">
        ${x.private ? lock : open}
        <span class="repo-item__text"><span class="repo-item__name">${esc(x.fullName)}</span>
        <span class="repo-item__meta">${[x.language, x.canPush === false ? "read-only" : "", x.archived ? "archived" : "", timeAgo(x.updatedAt)].filter(Boolean).map(esc).join(" · ")}</span></span>
        ${x.fullName === current ? check : ""}
      </button>`).join("") + (repos.length > 400 ? `<div class="repo-pop__msg">Showing 400 of ${repos.length} — search to narrow.</div>` : "");
    listEl.querySelectorAll(".repo-item").forEach((btn) => {
      btn.addEventListener("click", () => {
        const repo = repos[parseInt(btn.dataset.i, 10)];
        if (repo) { selectRepo(repo, provider); closeRepoPicker(); }
      });
    });
  }
  async function loadRepoList(listEl, provider, q, force) {
    const cached = !q && repoListCache[provider];
    if (cached && !force) renderRepoRows(listEl, provider, cached.repos, q);
    else listEl.innerHTML = `<div class="repo-spinner"></div>`;
    // Always revalidate in the background so new repos appear right away.
    try {
      const repos = await fetchRepos(provider, q);
      if (!listEl.isConnected) return;
      const same = cached && cached.repos.length === repos.length && cached.repos.every((r, i) => r.fullName === repos[i].fullName && r.updatedAt === repos[i].updatedAt);
      if (!same || force || !cached) renderRepoRows(listEl, provider, repos, q);
      const stamp = listEl.closest(".repo-pop")?.querySelector(".repo-pop__stamp");
      if (stamp) stamp.textContent = `${repos.length} repos · updated just now`;
    } catch (err) {
      if (!listEl.isConnected) return;
      if (cached && !force) { toast(err instanceof TypeError ? "Can't reach the MAX server." : err.message, "error"); return; }
      listEl.innerHTML = `<div class="repo-pop__msg">✗ ${esc(err instanceof TypeError ? "Can't reach the MAX server." : err.message)}</div>`;
    }
  }

  /* ---------- file browser + @file mentions ---------- */
  // File tree cache. Short TTL so every chat/turn sees the latest commits; the
  // server uses GitHub ETags, so a refresh that finds no change is nearly free.
  let treeCache = null; // { key, files: [{path,size}], at, sha, truncated }
  let treeInflight = null;
  const TREE_TTL = 30_000;
  const repoKey = (r) => `${r.provider}|${r.fullName}|${r.branch || ""}`;
  async function getTree(force) {
    const r = activeRepo();
    if (!r) return [];
    const key = repoKey(r);
    if (!force && treeCache && treeCache.key === key && Date.now() - treeCache.at < TREE_TTL) return treeCache.files;
    if (treeInflight && treeInflight.key === key) return treeInflight.p;
    const p = providerFetch("tree", {}).then((data) => {
      treeCache = { key, files: data.files || [], at: Date.now(), sha: data.sha || "", truncated: !!data.truncated };
      return treeCache.files;
    }).finally(() => { if (treeInflight && treeInflight.key === key) treeInflight = null; });
    treeInflight = { key, p };
    return p;
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

  /* ---------- file tree panel ---------- */
  function openTreePanel() {
    const r = activeRepo();
    if (!r) { toast("Pick a repository first.", "error"); return; }
    $("#tree-overlay").hidden = false;
    $("#tree-title").textContent = `Files · ${r.fullName}`;
    $("#tree-filter").value = "";
    loadTreePanel();
    setTimeout(() => $("#tree-filter").focus(), 30);
  }
  function closeTreePanel() { $("#tree-overlay").hidden = true; }

  async function loadTreePanel() {
    const content = $("#tree-content");
    content.innerHTML = `<div class="repo-spinner" style="margin:30px auto"></div>`;
    try {
      const files = (await getTree()).filter((f) => !isBinaryPath(f.path));
      renderTree(files, "");
      $("#tree-filter").addEventListener("input", () => renderTree(files, $("#tree-filter").value.trim()));
    } catch (err) {
      content.innerHTML = `<div class="repo-pop__msg">✗ ${esc(err instanceof TypeError ? "Can't reach the MAX server." : err.message)}</div>`;
    }
  }

  function renderTree(files, filter) {
    const content = $("#tree-content");
    const q = filter.toLowerCase();
    const filtered = q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;

    if (!filtered.length) { content.innerHTML = `<div class="repo-pop__msg">${q ? "No files match." : "Empty repository."}</div>`; return; }

    // Build a nested tree structure
    const root = {};
    for (const f of filtered) {
      const parts = f.path.split("/");
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = null; // null = file leaf
    }

    const html = renderTreeNode(root, "", 0);
    content.innerHTML = `<div class="file-tree">${html}</div>`;

    // Wire up folder toggles
    content.querySelectorAll(".tree-folder-toggle").forEach((btn) => {
      btn.addEventListener("click", () => {
        const li = btn.closest(".tree-folder");
        li.classList.toggle("collapsed");
      });
    });

    // Wire up file clicks (insert into chat)
    content.querySelectorAll(".tree-file").forEach((btn) => {
      btn.addEventListener("click", () => {
        const path = btn.dataset.path;
        closeTreePanel();
        insertFileIntoChat(path);
      });
    });
  }

  function renderTreeNode(node, prefix, depth) {
    let html = "";
    const entries = Object.entries(node).sort(([a, va], [b, vb]) => {
      // Directories first, then files
      const aDir = va !== null ? 0 : 1;
      const bDir = vb !== null ? 0 : 1;
      if (aDir !== bDir) return aDir - bDir;
      return a.localeCompare(b);
    });

    for (const [name, value] of entries) {
      const fullPath = prefix ? `${prefix}/${name}` : name;
      if (value === null) {
        // File
        const ext = (name.split(".").pop() || "").toLowerCase();
        const icon = fileIcon(ext);
        html += `<div class="tree-item tree-file" data-path="${esc(fullPath)}" style="padding-left:${12 + depth * 16}px" title="${esc(fullPath)}">
          <span class="tree-icon">${icon}</span><span class="tree-name">${esc(name)}</span>
        </div>`;
      } else {
        // Directory
        html += `<div class="tree-folder" style="padding-left:${depth * 16}px">
          <div class="tree-item tree-folder-toggle" style="padding-left:${12}px">
            <span class="tree-arrow">▸</span><span class="tree-icon">📁</span><span class="tree-name">${esc(name)}</span>
          </div>
          <div class="tree-children">${renderTreeNode(value, fullPath, depth + 1)}</div>
        </div>`;
      }
    }
    return html;
  }

  function fileIcon(ext) {
    const icons = { js: "📜", ts: "📘", jsx: "⚛️", tsx: "⚛️", py: "🐍", rb: "💎", go: "🔵", rs: "🦀", java: "☕", css: "🎨", html: "🌐", json: "📋", md: "📝", yml: "⚙️", yaml: "⚙️", toml: "⚙️", sh: "🖥️", sql: "🗃️", svg: "🖼️" };
    return icons[ext] || "📄";
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
    // Guard: skip full LCS for large files to avoid freezing the browser
    if (a.length > 2000 || b.length > 2000) {
      const out = [];
      for (let i = 0; i < a.length; i++) out.push({ type: "del", text: a[i] });
      for (let j = 0; j < b.length; j++) out.push({ type: "add", text: b[j] });
      return out;
    }
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
      // A deletion diffs the current content against nothing.
      const newContent = e.deleted ? "" : e.content;
      const rows = diffLines(current, newContent);
      const added = rows.filter((r) => r.type === "add").length;
      const removed = rows.filter((r) => r.type === "del").length;
      const tag = e.deleted
        ? ' <span class="diff-del diff-new">deleted file</span>'
        : (current ? "" : ' <span class="diff-new">new file</span>');
      box.querySelector(".diff-file__head").innerHTML =
        `${esc(e.path)} <span class="diff-stat"><span class="diff-add">+${added}</span> <span class="diff-del">−${removed}</span>${tag}</span>`;
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
    // Shape each edit for the commit API: writes carry content, deletions a flag.
    const commitFiles = edits.map((e) => e.deleted ? { path: e.path, deleted: true } : { path: e.path, content: e.content });
    const commitBody = {
      token, branch: repo.branch,
      newBranch: branch, files: commitFiles, message: title,
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
      // These edits are now committed — drop them from the staged working copy.
      for (const e of edits) delete state.pendingEdits[e.path];
      treeCache = null;
      renderChangesChip();
      renderMessages();
      return true;
    } catch (err) {
      toast(err instanceof TypeError ? "Can't reach the MAX server." : err.message, "error");
      return false;
    }
  }

  // Programmatic commit+push used by the commit_changes tool, so MAX can push on
  // its own. Either pushes straight to the working branch, or (openPr) to a new
  // branch and opens a PR/MR. Returns a human/tool-readable summary string.
  async function runCommit(repo, edits, { message, openPr, branch }) {
    const token = providerToken(repo.provider) || undefined;
    const base = repo.branch || "main";
    const sanitize = (b) => String(b || "").trim().replace(/[^A-Za-z0-9._/-]+/g, "-").replace(/^[-/]+|[-/]+$/g, "").slice(0, 200);
    const targetBranch = openPr ? (sanitize(branch) || `max/edit-${Date.now().toString(36).slice(-5)}`) : base;
    const commitFiles = edits.map((e) => e.deleted ? { path: e.path, deleted: true } : { path: e.path, content: e.content });

    const commitBody = { token, branch: base, newBranch: targetBranch, files: commitFiles, message };
    if (repo.provider === "gitlab") commitBody.projectId = repo.projectId ?? repo.fullName;
    else { commitBody.owner = repo.owner; commitBody.repo = repo.name; }

    const cRes = await fetch(`/api/${repo.provider}/commit`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(commitBody),
    });
    const cData = await cRes.json().catch(() => ({}));
    if (!cRes.ok) throw new Error(cData?.error?.message || `Commit failed (HTTP ${cRes.status})`);

    // Drop the edits we just pushed from the staged working copy.
    for (const e of edits) delete state.pendingEdits[e.path];
    renderChangesChip();
    treeCache = null; // the branch moved — re-read the tree next time

    const summary = `Committed ${edits.length} file(s) to ${repo.fullName} on branch "${targetBranch}" — "${message}".`;
    if (!openPr) {
      toast(`MAX pushed ${edits.length} change(s) to ${targetBranch}`, "success");
      return summary + " Pushed directly to the working branch.";
    }

    // Open a PR/MR from the new branch back into the working branch.
    const prPath = repo.provider === "gitlab" ? "mr" : "pr";
    const prBody = { token, head: targetBranch, base, title: message, body: "Proposed by MAX." };
    if (repo.provider === "gitlab") prBody.projectId = repo.projectId ?? repo.fullName;
    else { prBody.owner = repo.owner; prBody.repo = repo.name; }
    const prRes = await fetch(`/api/${repo.provider}/${prPath}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(prBody),
    });
    const prData = await prRes.json().catch(() => ({}));
    if (prRes.ok && prData.url) {
      toastLink(repo.provider === "gitlab" ? "View merge request" : "View pull request", prData.url);
      return `${summary} Opened ${prPath.toUpperCase()}: ${prData.url}`;
    }
    return `${summary} (The commit succeeded, but opening the ${prPath.toUpperCase()} failed: ${prData?.error?.message || "unknown error"}.)`;
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
      const html = (window.marked && window.DOMPurify
        ? DOMPurify.sanitize(marked.parse(m.content || "")) : `<pre>${esc(m.content)}</pre>`) +
        (m.videos || []).map((v) => `<p>🎬 <b>Video</b> — ${esc(v.label)} (${esc(v.status)}): <i>${esc(v.prompt)}</i></p>`).join("");
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

  // The "review changes" chip reflects how many file edits MAX has staged.
  function renderChangesChip() {
    const chip = $("#changes-chip");
    if (!chip) return;
    const n = pendingCount();
    chip.hidden = n === 0;
    const count = $("#changes-count");
    if (count) count.textContent = n;
    chip.title = n ? `Review ${n} staged change${n > 1 ? "s" : ""} and commit` : "";
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
    { cmd: "/video", desc: "Generate an AI video (Veo, Kling, Seedance…) — opens Video mode", run: () => { $("#input").value = ""; setVideoMode(true); focusInputEnd(); } },
    { cmd: "/motion", desc: "Code-drawn motion graphics, recorded to a video (no video key needed)", run: () => { $("#input").value = "/motion "; focusInputEnd(); } },
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
    const prov = p.provider || "agentrouter";
    if (p.model) {
      $("#set-model-custom").value = ""; const sel = $("#set-model"); const v = `${prov}::${p.model}`;
      if ([...sel.options].some((o) => o.value === v)) sel.value = v;
      else { $("#set-model-custom").value = p.model; $("#set-model-custom-prov").value = prov; }
    }
    let key = "";
    try { key = sessionStorage.getItem(profileKeyName(id)) || ""; } catch {}
    if (key) (prov === "codecraft" ? $("#set-cckey") : $("#set-apikey")).value = key;
    toast(`Applied profile "${p.name}"`);
  }
  function saveCurrentProfile() {
    const name = (prompt("Name this profile:", "") || "").trim();
    if (!name) return;
    const id = uid();
    const custom = $("#set-model-custom").value.trim();
    const [selProv, ...selRest] = $("#set-model").value.split("::");
    const provider = custom ? $("#set-model-custom-prov").value : selProv;
    const model = custom || selRest.join("::");
    state.settings.profiles.push({ id, name, model, provider });
    const key = (provider === "codecraft" ? $("#set-cckey") : $("#set-apikey")).value.trim();
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
      { label: state.settings.autonomous ? "Turn OFF Autonomous mode" : "Turn ON Autonomous mode", run: () => $("#auto-toggle").click() },
      { label: "Toggle theme (light/dark)", run: toggleTheme },
      { label: "Import chat (.json)", run: () => $("#import-input").click() },
      { label: "Export current chat (.md)", run: () => { const c = activeConvo(); if (c) exportConversation(c.id, "md"); } },
      { label: "Share current chat (.html)", run: () => { const c = activeConvo(); if (c) shareConversation(c.id); } },
      { label: "View request log", run: openRequestLog },
      { label: "Open Powers (integrations)", run: openPowers },
      { label: state.videoMode ? "Turn OFF Video mode" : "Turn ON Video mode (generate AI videos)", run: () => setVideoMode(!state.videoMode) },
      { label: "Choose video model", run: () => { setVideoMode(true); setTimeout(() => { const b = $('#video-controls [data-vc="model"]'); if (b) openVideoModelPicker(b, {}); }, 30); } },
      { label: "Video generation settings (keys)", run: () => openSettings("video") },
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
     Skills UI
     ============================================================ */
  function openSkills() { $("#skills-overlay").hidden = false; renderSkills(); }
  function closeSkills() { $("#skills-overlay").hidden = true; }

  function renderSkills() {
    const grid = $("#skills-grid");
    if (!grid) return;
    const categories = [...new Set(SKILLS_CATALOG.map((s) => s.category))];
    let html = "";
    for (const cat of categories) {
      const skills = SKILLS_CATALOG.filter((s) => s.category === cat);
      html += `<div class="skills-category"><div class="skills-cat-label">${esc(cat)}</div>`;
      html += skills.map((s) => {
        const active = isSkillActive(s.id);
        return `<div class="skill-card ${active ? "skill-card--active" : ""}">
          <button class="skill-toggle" data-id="${esc(s.id)}" type="button" title="${active ? "Deactivate" : "Activate"} ${esc(s.name)}">
            <span class="skill-icon">${s.icon}</span>
            <div class="skill-info">
              <div class="skill-name">${esc(s.name)}</div>
              <div class="skill-desc">${esc(s.description)}</div>
            </div>
            <span class="skill-check">${active ? "✓" : ""}</span>
          </button>
        </div>`;
      }).join("");
      html += `</div>`;
    }
    // Show active count
    const activeCount = activeSkills().length;
    const badge = activeCount ? `<span class="skills-badge">${activeCount} active</span>` : "";
    grid.innerHTML = badge + html;
    grid.querySelectorAll(".skill-toggle").forEach((btn) => {
      btn.addEventListener("click", () => toggleSkill(btn.dataset.id));
    });
    // Update topbar button badge
    updateSkillsBadge();
  }

  function updateSkillsBadge() {
    const btn = $("#skills-btn");
    if (!btn) return;
    const count = activeSkills().length;
    btn.title = count ? `Skills (${count} active)` : "Skills — toggle Claude's expertise";
    btn.classList.toggle("skills-active", count > 0);
  }

  /* ============================================================
     Keyboard shortcuts help
     ============================================================ */
  function openShortcutsHelp() {
    const mod = navigator.platform.includes("Mac") ? "⌘" : "Ctrl";
    const shortcuts = [
      { keys: `${mod}+K`, desc: "Open command palette" },
      { keys: `${mod}+F`, desc: "Find in conversation" },
      { keys: `${mod}+Shift+O`, desc: "New chat" },
      { keys: `${mod}+?`, desc: "Show this shortcuts help" },
      { keys: "Enter", desc: "Send message" },
      { keys: "Shift+Enter", desc: "New line in message" },
      { keys: "Escape", desc: "Close any open modal or panel" },
      { keys: "/command", desc: "Slash commands (type / in composer)" },
      { keys: "@filename", desc: "Insert a repo file (type @ in composer)" },
    ];
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.innerHTML = `<div class="modal modal--sm" role="dialog" aria-modal="true">
      <div class="modal__head"><h2>Keyboard shortcuts</h2><button class="icon-btn" data-x aria-label="Close"><svg viewBox="0 0 24 24" style="fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round"><path d="M18 6L6 18M6 6l12 12"/></svg></button></div>
      <div class="modal__body" style="gap:4px">
        ${shortcuts.map((s) => `<div style="display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid var(--border)">
          <span style="color:var(--text-dim);font-size:13.5px">${esc(s.desc)}</span>
          <kbd style="font-family:var(--mono);font-size:12px;padding:3px 8px;border-radius:6px;background:var(--surface-2);border:1px solid var(--border-strong);color:var(--text);white-space:nowrap">${esc(s.keys)}</kbd>
        </div>`).join("")}
      </div>
    </div>`;
    document.body.appendChild(overlay);
    overlay.querySelectorAll("[data-x]").forEach((b) => b.addEventListener("click", () => overlay.remove()));
    overlay.addEventListener("mousedown", (e) => { if (e.target === overlay) overlay.remove(); });
    overlay.addEventListener("keydown", (e) => { if (e.key === "Escape") overlay.remove(); });
  }

  /* ============================================================
     Model picker (top bar) · effort panel · capability chips
     ============================================================ */
  const CAP_META = [
    { key: "reasoning", label: "Reasoning", cls: "cap--reasoning", icon: "🧠" },
    { key: "vision", label: "Vision", cls: "cap--vision", icon: "🖼️" },
    { key: "tools", label: "Tools", cls: "cap--tools", icon: "🔧" },
    { key: "streaming", label: "Streaming", cls: "cap--streaming", icon: "⚡" },
    { key: "json", label: "JSON", cls: "cap--json", icon: "{}" },
  ];

  function renderCapChips() {
    const box = $("#cap-chips");
    if (!box) return;
    const info = modelInfo();
    box.innerHTML = CAP_META.filter((c) => info.caps?.[c.key]).map((c) => {
      const on = c.key === "json" ? state.settings.jsonMode : true;
      const title = c.key === "json" ? (on ? "JSON mode ON — click to turn off" : "Click to force JSON output")
        : c.key === "reasoning" ? "Click to change reasoning effort"
        : c.key === "vision" ? "This model can see images — attach or paste one"
        : c.key === "tools" ? "Tool use: MAX can read/edit your repo & browse" : "Streaming responses";
      return `<button type="button" class="cap-chip ${c.cls}${on ? "" : " cap-chip--off"}" data-cap="${c.key}" title="${esc(title)}">
        <span aria-hidden="true">${c.icon}</span>${c.label}</button>`;
    }).join("");
    const pill = $("#effort-pill");
    if (pill) {
      pill.hidden = info.caps?.reasoning === false;
      $("#effort-label").textContent = (EFFORTS.find((e) => e.id === state.settings.effort) || EFFORTS[1]).label;
      pill.dataset.level = state.settings.effort;
    }
  }

  let popEl = null;
  function closePop() { if (popEl) { popEl.remove(); popEl = null; } }
  // Position a popover next to its anchor. Flips to the side with more room and
  // caps its height so it never runs off-screen (e.g. when opened near the bottom).
  function placePop(pop, anchor, where = "below") {
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth, h = pop.offsetHeight;
    pop.style.left = `${Math.max(10, Math.min(r.left + r.width / 2 - w / 2, window.innerWidth - w - 10))}px`;
    const below = window.innerHeight - r.bottom - 18, above = r.top - 18;
    if (where === "below" && h > below && above > below) where = "above";
    else if (where === "above" && h > above && below > above) where = "below";
    pop.style.top = pop.style.bottom = "";
    if (where === "above") pop.style.bottom = `${Math.max(10, window.innerHeight - r.top + 8)}px`;
    else pop.style.top = `${r.bottom + 8}px`;
    const room = Math.max(160, where === "above" ? above : below);
    if (h > room) pop.style.maxHeight = `${room}px`;
  }
  function dismissOnOutside(pop, anchor) {
    setTimeout(() => {
      const onDoc = (e) => {
        if (popEl !== pop) { document.removeEventListener("mousedown", onDoc); return; }
        if (!pop.contains(e.target) && !anchor.contains(e.target)) { closePop(); document.removeEventListener("mousedown", onDoc); }
      };
      document.addEventListener("mousedown", onDoc);
    }, 0);
  }

  function openEffortPanel(anchor) {
    if (popEl && popEl.classList.contains("effort-pop")) { closePop(); return; }
    closePop();
    const pop = document.createElement("div");
    pop.className = "effort-pop";
    pop.setAttribute("role", "listbox");
    const hint = providerInfo(currentProvider()).style === "anthropic"
      ? "Sets Claude's extended-thinking budget."
      : "Sent as reasoning_effort. Models without reasoning ignore it.";
    pop.innerHTML = `<div class="effort-pop__head">Reasoning effort</div>` +
      EFFORTS.map((e) => `<button type="button" class="effort-opt${e.id === state.settings.effort ? " active" : ""}" data-e="${e.id}" role="option" aria-selected="${e.id === state.settings.effort}">
        <span class="effort-opt__label">${e.label}</span><span class="effort-opt__hint">${e.hint}</span>
        ${e.id === state.settings.effort ? `<svg class="effort-opt__check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>` : ""}
      </button>`).join("") +
      `<div class="effort-pop__foot">${esc(hint)}</div>`;
    document.body.appendChild(pop);
    popEl = pop;
    placePop(pop, anchor, "above");
    pop.querySelectorAll(".effort-opt").forEach((b) => b.addEventListener("click", () => {
      state.settings.effort = b.dataset.e; saveSettings(); renderCapChips(); closePop();
      toast(`Reasoning effort: ${(EFFORTS.find((x) => x.id === b.dataset.e) || {}).label}`);
    }));
    dismissOnOutside(pop, anchor);
  }

  function capIcons(m) {
    return CAP_META.filter((c) => m.caps?.[c.key] && c.key !== "streaming")
      .map((c) => `<span class="mp-cap ${c.cls}" title="${c.label}">${c.icon}</span>`).join("");
  }

  function openModelPicker(anchor) {
    if (popEl && popEl.classList.contains("model-pop")) { closePop(); return; }
    closePop();
    const pop = document.createElement("div");
    pop.className = "model-pop";
    const providers = state.config.providers || DEFAULT_PROVIDERS;
    let tab = "all";
    pop.innerHTML = `
      <div class="model-pop__search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" placeholder="Search ${allModels().length} models…" autocomplete="off" spellcheck="false" />
      </div>
      <div class="model-pop__tabs">
        <button type="button" class="mp-tab active" data-t="all">All</button>
        ${providers.map((p) => `<button type="button" class="mp-tab" data-t="${esc(p.id)}">${esc(p.label)}${providerReady(p.id) ? "" : ` <span class="mp-nokey" title="No key yet">•</span>`}</button>`).join("")}
      </div>
      <div class="model-pop__list" role="listbox"></div>
      <div class="model-pop__foot">
        <input type="text" class="mp-custom" placeholder="Custom model id…" spellcheck="false" />
        <select class="mp-custom-prov">${providers.map((p) => `<option value="${esc(p.id)}"${p.id === currentProvider() ? " selected" : ""}>${esc(p.label)}</option>`).join("")}</select>
        <button type="button" class="btn btn--ghost btn--sm mp-custom-use">Use</button>
      </div>`;
    document.body.appendChild(pop);
    popEl = pop;
    const input = pop.querySelector("input");
    const listEl = pop.querySelector(".model-pop__list");
    let active = 0, shown = [];
    const render = () => {
      const q = input.value.trim().toLowerCase();
      shown = allModels().filter((m) => (tab === "all" || m.provider === tab) &&
        (!q || m.label.toLowerCase().includes(q) || m.id.toLowerCase().includes(q) || (m.family || "").toLowerCase().includes(q)));
      const cur = `${currentProvider()}::${currentModel()}`;
      let html = "", lastGroup = "";
      shown.forEach((m, i) => {
        const g = `${providerInfo(m.provider).label}`;
        if (g !== lastGroup) {
          html += `<div class="mp-group">${esc(g)}${providerReady(m.provider) ? "" : ` <button type="button" class="mp-addkey" data-addkey="${esc(m.provider)}">add key</button>`}</div>`;
          lastGroup = g;
        }
        const sel = `${m.provider}::${m.id}` === cur;
        html += `<button type="button" class="mp-item${sel ? " selected" : ""}${i === active ? " active" : ""}" data-i="${i}" role="option" aria-selected="${sel}">
          <span class="mp-item__main"><span class="mp-item__label">${esc(m.label)}${m.recommended ? ` <span class="mp-badge">recommended</span>` : ""}</span>
          <span class="mp-item__id">${esc(m.id)}${m.family ? ` · ${esc(m.family)}` : ""}</span></span>
          <span class="mp-item__caps">${capIcons(m)}</span>
          ${sel ? `<svg class="mp-item__check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>` : ""}
        </button>`;
      });
      listEl.innerHTML = html || `<div class="repo-pop__msg">No models match — type a custom id below.</div>`;
      listEl.querySelectorAll(".mp-item").forEach((b) => b.addEventListener("click", () => choose(shown[+b.dataset.i])));
      listEl.querySelectorAll("[data-addkey]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); closePop(); openSettings("providers"); }));
      listEl.querySelector(".mp-item.selected")?.scrollIntoView({ block: "nearest" });
    };
    const choose = (m) => {
      if (!m) return;
      closePop();
      setModel(m.id, m.provider);
      toast(`${m.label} · ${providerInfo(m.provider).label}${providerReady(m.provider) ? "" : " — add an API key in Settings"}`, providerReady(m.provider) ? "success" : "");
    };
    pop.querySelectorAll(".mp-tab").forEach((t) => t.addEventListener("click", () => {
      tab = t.dataset.t; active = 0;
      pop.querySelectorAll(".mp-tab").forEach((x) => x.classList.toggle("active", x === t));
      render();
    }));
    input.addEventListener("input", () => { active = 0; render(); });
    input.addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        active = Math.max(0, Math.min(shown.length - 1, active + (e.key === "ArrowDown" ? 1 : -1)));
        listEl.querySelectorAll(".mp-item").forEach((b) => b.classList.toggle("active", +b.dataset.i === active));
        listEl.querySelector(".mp-item.active")?.scrollIntoView({ block: "nearest" });
      } else if (e.key === "Enter") { e.preventDefault(); choose(shown[active]); }
      else if (e.key === "Escape") closePop();
    });
    const useCustom = () => {
      const id = pop.querySelector(".mp-custom").value.trim();
      if (!id) return;
      const prov = pop.querySelector(".mp-custom-prov").value;
      closePop(); setModel(id, prov); toast(`Using custom model ${id}`, "success");
    };
    pop.querySelector(".mp-custom-use").addEventListener("click", useCustom);
    pop.querySelector(".mp-custom").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); useCustom(); } });
    render();
    placePop(pop, anchor, "below");
    setTimeout(() => input.focus(), 20);
    dismissOnOutside(pop, anchor);
  }

  async function refreshProviderModels(provider, btn, out) {
    setBtnBusy(btn, true);
    if (out) { out.textContent = "Fetching model list…"; out.style.color = ""; }
    try {
      const keyInput = provider === "codecraft" ? $("#set-cckey") : $("#set-apikey");
      const res = await fetch("/api/models/refresh", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: keyInput?.value.trim() || providerKey(provider) || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      const known = new Set(state.config.models.filter((m) => m.provider === provider).map((m) => m.id));
      const fresh = (data.models || []).filter((id) => !known.has(id));
      state.settings.customModels = (state.settings.customModels || []).filter((m) => m.provider !== provider)
        .concat(fresh.map((id) => ({ id, provider })));
      saveSettings();
      if (out) { out.textContent = `✓ ${data.models.length} models available${fresh.length ? ` — ${fresh.length} new added to the picker` : " — catalog is up to date"}.`; out.style.color = "#34d399"; }
    } catch (err) {
      if (out) { out.textContent = "✗ " + (err instanceof TypeError ? "Can't reach the MAX server." : err.message); out.style.color = "#ff6b8a"; }
    } finally { setBtnBusy(btn, false); }
  }

  async function testProvider(provider, btn, out) {
    setBtnBusy(btn, true);
    out.textContent = "Pinging…"; out.style.color = "";
    try {
      const keyInput = provider === "codecraft" ? $("#set-cckey") : $("#set-apikey");
      const model = provider === currentProvider() ? currentModel()
        : ((state.config.models.find((m) => m.provider === provider && m.recommended) || state.config.models.find((m) => m.provider === provider) || {}).id);
      const res = await fetch("/api/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, model, apiKey: keyInput?.value.trim() || providerKey(provider) || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      out.textContent = "✓ " + (data.message || "OK"); out.style.color = "#34d399";
    } catch (err) {
      out.textContent = "✗ " + (err instanceof TypeError ? "Can't reach the MAX server." : err.message); out.style.color = "#ff6b8a";
    } finally { setBtnBusy(btn, false); }
  }

  /* ---------- welcome suggestions ---------- */
  const SUGGESTIONS = {
    create: [
      ["Write a short story", "about a robot who learns to paint", "Write a short, vivid story about a robot who learns to paint. ~400 words."],
      ["Draft an email", "professional and friendly", "Help me draft a professional, friendly email asking my manager for a project deadline extension."],
      ["Plan my week", "a healthy weekly meal plan", "Create a weekly meal plan for a busy person: balanced, quick recipes, with a shopping list."],
    ],
    explore: [
      ["Explain a concept", "how do transformers work?", "Explain how transformer neural networks work, from attention to training, with a simple analogy."],
      ["Compare options", "HTTP/1.1 vs HTTP/2 vs HTTP/3", "Summarize the key differences between HTTP/1.1, HTTP/2 and HTTP/3 in a table."],
      ["Research a topic", "pros & cons of solar at home", "What are the real pros and cons of home solar panels? Include costs, payback and pitfalls."],
    ],
    code: [
      ["Build a web app", "a to-do app in one HTML file", "Build a beautiful, responsive to-do app as a single HTML file with localStorage. Make it runnable."],
      ["Review my repo", "summarize the selected repository", "/summarize"],
      ["Fix a bug", "debug the code I paste", "Find and fix the bug in this code, and explain the root cause:\n\n"],
    ],
    video: [
      ["Cinematic shot", "drone over misty mountains", "/video Cinematic drone shot gliding over misty mountain peaks at sunrise, golden light breaking through the clouds, slow push forward, epic orchestral swell"],
      ["Vertical ad", "9:16 sneaker commercial", "/video Vertical 9:16 commercial: a glowing white running shoe spins above a wet neon-lit street at night, slow-motion water splash, bold bass hit on the logo"],
      ["Animate a photo", "attach an image first", "/video Bring this photo to life with gentle natural motion and a slow cinematic push-in"],
      ["Motion graphics", "code-drawn logo reveal", "/motion An 8 second neon logo reveal for the word MAX with glowing particles and a light sweep"],
    ],
  };
  function renderSuggestions(cat = "create") {
    const box = $("#suggestions");
    if (!box) return;
    box.innerHTML = (SUGGESTIONS[cat] || SUGGESTIONS.create).map(([title, sub, prompt]) => `
      <button class="suggestion" type="button" data-prompt="${esc(prompt)}">
        <span><b>${esc(title)}</b>${esc(sub)}</span>
      </button>`).join("");
    $$(".welcome-tab").forEach((t) => t.classList.toggle("active", t.dataset.cat === cat));
  }

  /* ============================================================
     AI video generation — real video models
     OpenRouter (Veo 3.1 · Kling 3.0 · Seedance · Wan · Hailuo…), Google Veo 3.1,
     and OpenAI-compatible gateways. Jobs run on the MAX server; the chat shows a
     live card that turns into a player when the video is ready.
     ============================================================ */
  const VIDEO_PROVIDER_IDS = ["openrouter", "google", "gateway"];
  const videoDefaults = () => ({ model: "auto", priority: "balanced", duration: "auto", aspectRatio: "auto", resolution: "auto", audio: true, enhance: true, custom: [] });
  const vKeyName = (p) => `${SCOPE}max.videoKey.${p}.v1`;
  const VIDEO_PRIORITIES = {
    quality: { label: "Best quality", hint: "Flagship models, higher resolution", w: { q: 0.75, c: 0.1, s: 0.15 } },
    balanced: { label: "Balanced", hint: "Great results at a sensible price", w: { q: 0.45, c: 0.35, s: 0.2 } },
    fast: { label: "Fast & cheap", hint: "Quick drafts and previews", w: { q: 0.15, c: 0.45, s: 0.4 } },
  };
  // Curated quality priors + one-line strengths (used by Auto and shown to the chat model).
  const VIDEO_NOTES = [
    [/veo-3\.1-lite/, 0.62, "cheapest Veo, native audio"],
    [/veo-3\.1-fast/, 0.8, "near-flagship Veo quality, fast, native audio"],
    [/veo-3\.1/, 0.96, "best photorealism & physics, native audio and dialogue"],
    [/veo/, 0.78, "realistic video"],
    [/kling.*o1/, 0.86, "strong prompt following and editing"],
    [/kling.*(std|standard)/, 0.76, "good motion at a lower price"],
    [/kling.*3/, 0.92, "excellent character motion, multi-shot, up to 15s"],
    [/kling/, 0.8, "dynamic motion"],
    [/seedance-2\.5/, 0.9, "long cinematic takes (up to 30s), multi-shot"],
    [/seedance-2\.0-(fast|mini)/, 0.66, "quick, cheap drafts"],
    [/seedance-2/, 0.86, "sharp high-res video, smooth multi-shot"],
    [/seedance-1/, 0.72, "video + audio in one pass"],
    [/hailuo-3-max|h3-max/, 0.92, "top-tier physics, 2K"],
    [/hailuo-3/, 0.86, "vivid motion, 2K with audio"],
    [/hailuo/, 0.74, "dynamic action shots, good value"],
    [/wan-3\.0-prime/, 0.88, "long 30s shots, premium quality"],
    [/wan-3/, 0.82, "up to 30s, image & reference inputs"],
    [/wan-2\.7/, 0.74, "flexible image/reference-to-video"],
    [/wan/, 0.66, "budget-friendly"],
    [/sora/, 0.4, "retired by OpenAI (Sept 2026)"],
  ];
  const VSTATUS = {
    preparing: "Preparing…", enhancing: "✨ Enhancing your prompt…", submitting: "Sending to the model…",
    queued: "Queued at the provider…", running: "Generating video…", downloading: "Saving your video…",
    interrupted: "Paused — the MAX server restarted",
  };
  const VIDEO_TERMINAL = new Set(["completed", "failed", "cancelled"]);
  const VIDEO_PLACEHOLDER = "Describe the video — subject, action, camera, mood, style… (attach an image to animate it)";

  function videoNote(id) {
    for (const [re, q, note] of VIDEO_NOTES) if (re.test(String(id).toLowerCase())) return { q, note };
    return { q: 0.6, note: "" };
  }
  function loadVideoKeys() { for (const p of VIDEO_PROVIDER_IDS) state.videoKeys[p] = secretGet(vKeyName(p)); }
  function saveVideoKeys() { for (const p of VIDEO_PROVIDER_IDS) secretPut(vKeyName(p), state.videoKeys[p]); }

  function videoProviders() {
    const c = state.videoCatalog.providers;
    return c && c.length ? c : (state.config.video?.providers || []);
  }
  function videoProviderInfo(id) { return videoProviders().find((p) => p.id === id) || { id, label: id }; }
  function videoKey(provider) {
    const k = state.videoKeys[provider] || "";
    if (k) return k;
    // The gateway defaults to CodeCraft's API, so the CodeCraft chat key is reused.
    if (provider === "gateway" && /codecraftapi\.com/i.test(videoProviderInfo("gateway").base || "")) return state.settings.ccKey || "";
    return "";
  }
  function videoProviderReady(id) {
    const p = videoProviders().find((x) => x.id === id);
    return Boolean(p && (videoKey(id) || p.hasServerKey));
  }
  function videoModels() {
    const list = (state.videoCatalog.models || []).slice();
    for (const c of state.settings.video.custom || []) {
      if (c && c.id && !list.some((m) => m.provider === c.provider && m.id === c.id)) {
        list.push({ provider: c.provider, id: c.id, label: c.id, family: "Custom", description: "", durations: null, resolutions: null, aspectRatios: null, frameImages: null, audio: null, pricing: null, custom: true });
      }
    }
    return list;
  }
  const usableVideoModels = () => videoModels().filter((m) => videoProviderReady(m.provider));
  const anyVideoReady = () => usableVideoModels().length > 0;
  const videoModelKey = (m) => `${m.provider}::${m.id}`;
  function findVideoModel(key) {
    if (!key || key === "auto") return null;
    const [prov, ...rest] = String(key).split("::");
    const id = rest.join("::");
    if (!id) { // bare id (e.g. from the chat model) — match any provider, preferring ready ones
      const hits = videoModels().filter((m) => m.id === prov || m.id.endsWith("/" + prov));
      return hits.find((m) => videoProviderReady(m.provider)) || hits[0] || null;
    }
    return videoModels().find((m) => m.provider === prov && m.id === id) || { provider: prov, id, label: id, family: "Custom", custom: true };
  }

  async function loadVideoCatalog(force) {
    if (state.videoCatalog._p && !force) return state.videoCatalog._p;
    const p = fetch("/api/video/models", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh: Boolean(force), keys: { gateway: videoKey("gateway") || undefined } }),
    }).then((r) => r.json()).then((d) => {
      if (d && d.ok) Object.assign(state.videoCatalog, { models: d.models || [], providers: d.providers || [], errors: d.errors || {}, fetchedAt: Date.now() });
    }).catch(() => {}).finally(() => {
      state.videoCatalog._p = null;
      renderVideoControls();
      renderWelcomeStatus();
    });
    state.videoCatalog._p = p;
    return p;
  }

  /* ---------- capability fitting ---------- */
  function vResRank(r) {
    const s = String(r || "").toLowerCase();
    const m = s.match(/^(\d{3,4})p$/);
    if (m) { const n = +m[1]; return n >= 2160 ? 6 : n >= 1440 ? 5 : n >= 1080 ? 4 : n >= 720 ? 3 : n >= 480 ? 2 : 1; }
    return { "1k": 4, "2k": 5, "4k": 6 }[s] || 0;
  }
  const orient = (a) => { const [w, h] = String(a || "16:9").split(":").map(Number); return Math.sign((w || 16) - (h || 9)); };
  const nearestNum = (list, t) => list.slice().sort((a, b) => Math.abs(a - t) - Math.abs(b - t) || a - b)[0];
  function supportsImage(m) {
    if (!m) return false;
    if (m.provider === "google") return true;
    if (!Array.isArray(m.frameImages)) return null; // unknown
    return m.frameImages.includes("first_frame");
  }
  function autoAspect(att) {
    const w = att?.meta?.width, h = att?.meta?.height;
    if (!w || !h) return "16:9";
    const r = w / h;
    return r > 1.2 ? "16:9" : r < 0.83 ? "9:16" : "1:1";
  }
  function fitVideoParams(m, want = {}) {
    const notes = [];
    const out = {};
    const desiredRes = want.resolution && want.resolution !== "auto" ? want.resolution : (want.priority === "quality" ? "1080p" : "720p");
    if (m.resolutions?.length) {
      const exact = m.resolutions.find((r) => r.toLowerCase() === String(desiredRes).toLowerCase());
      if (exact) out.resolution = exact;
      else {
        const t = vResRank(desiredRes);
        const sorted = m.resolutions.slice().sort((a, b) => vResRank(a) - vResRank(b));
        out.resolution = sorted.filter((r) => vResRank(r) <= t).pop() || sorted[0];
        if (want.resolution && want.resolution !== "auto") notes.push(`${desiredRes} → ${out.resolution}`);
      }
    } else if (want.resolution && want.resolution !== "auto") out.resolution = want.resolution;

    let durations = m.durations && m.durations.length ? m.durations : null;
    const byRes = m.durationsByResolution && out.resolution ? m.durationsByResolution[out.resolution.toLowerCase()] : null;
    if (byRes) durations = byRes;
    const target = Number(want.duration) || (want.priority === "fast" ? 5 : 8);
    if (durations) {
      out.duration = nearestNum(durations, target);
      if (want.duration && Number(want.duration) !== out.duration) notes.push(`${want.duration}s → ${out.duration}s${byRes ? ` (${out.resolution} clips are ${byRes.join("/")}s)` : ""}`);
    } else if (want.duration) out.duration = Number(want.duration);

    const ar = !want.aspectRatio || want.aspectRatio === "auto" ? autoAspect(want.imageAtt) : want.aspectRatio;
    if (m.aspectRatios?.length && !m.aspectRatios.includes(ar)) {
      out.aspectRatio = m.aspectRatios.find((a) => orient(a) === orient(ar)) || m.aspectRatios[0];
      notes.push(`${ar} → ${out.aspectRatio}`);
    } else out.aspectRatio = ar;

    if (m.audioAlways) out.audio = true;
    else if (m.audio === true) out.audio = want.audio !== false;
    else if (m.audio === false) out.silent = true;
    return { ...out, notes };
  }
  function estimateVideoCost(m, fit) {
    const ps = m?.pricing?.perSecond;
    if (!ps || !fit?.duration) return null;
    const r = String(fit.resolution || "").toLowerCase();
    let v;
    if (fit.audio === false) v = ps[`${r}:noaudio`] ?? ps["default:noaudio"];
    if (v == null) v = ps[r] ?? ps.default;
    if (v == null) { const vals = Object.values(ps).filter(Number.isFinite); v = vals.length ? Math.min(...vals) : null; }
    return Number.isFinite(v) ? v * fit.duration : null;
  }
  function speedScore(id) {
    const s = String(id).toLowerCase();
    if (/fast|turbo|flash|lightning|mini/.test(s)) return 1;
    if (/lite|std|standard/.test(s)) return 0.8;
    if (/pro|max|prime|ultra|o1/.test(s)) return 0.35;
    return /veo-3\.1(-generate)?(-preview)?$/.test(s) ? 0.4 : 0.55;
  }
  /** Auto mode: filter by hard requirements, then score quality/cost/speed (weights per priority). */
  function chooseVideoModel(want) {
    const pr = VIDEO_PRIORITIES[want.priority] || VIDEO_PRIORITIES.balanced;
    let cands = usableVideoModels().filter((m) => !/sora/i.test(m.id));
    if (!cands.length) return { model: null, ranked: [] };
    if (want.image) { const i2v = cands.filter((m) => supportsImage(m) !== false); if (i2v.length) cands = i2v; }
    const scored = cands.map((m) => { const fit = fitVideoParams(m, want); return { m, fit, cost: estimateVideoCost(m, fit) }; });
    const costs = scored.map((s) => s.cost).filter(Number.isFinite);
    const lo = costs.length ? Math.min(...costs) : 0, hi = costs.length ? Math.max(...costs) : 0;
    const maxRes = Math.max(1, ...scored.map((s) => Math.max(0, ...(s.m.resolutions || []).map(vResRank))));
    for (const s of scored) s.q = 0.7 * videoNote(s.m.id).q + 0.3 * (s.m.resolutions?.length ? Math.max(...s.m.resolutions.map(vResRank)) / maxRes : 0.6);
    const qlo = Math.min(...scored.map((s) => s.q)), qhi = Math.max(...scored.map((s) => s.q));
    for (const s of scored) {
      const q = qhi > qlo ? (s.q - qlo) / (qhi - qlo) : 1; // normalized like cost, so weights mean what they say
      const c = Number.isFinite(s.cost) ? (hi > lo ? 1 - (s.cost - lo) / (hi - lo) : 1) : 0.45;
      let score = pr.w.q * q + pr.w.c * c + pr.w.s * speedScore(s.m.id);
      if (want.wantsAudio && (s.m.audio === true || s.m.audioAlways)) score += 0.05;
      if (want.wantsAudio && s.m.audio === false) score -= 0.06;
      if (want.duration && s.m.durations?.length) {
        const maxD = Math.max(...s.m.durations);
        if (maxD < want.duration) score -= 0.15 * Math.min(1, ((want.duration - maxD) / want.duration) * 2);
      }
      if (want.image && supportsImage(s.m) === null) score -= 0.05;
      if (s.m.custom) score -= 0.1;
      s.score = score;
    }
    scored.sort((a, b) => b.score - a.score);
    return { model: scored[0].m, fit: scored[0].fit, cost: scored[0].cost, ranked: scored };
  }
  function currentVideoImage() {
    return state.attachments.find((a) => !a.pending && a.kind === "image" && a.dataUrl) || null;
  }
  function videoWant(extra = {}) {
    const vs = state.settings.video;
    const imageAtt = "imageAtt" in extra ? extra.imageAtt : currentVideoImage();
    return {
      priority: vs.priority, duration: vs.duration === "auto" ? null : Number(vs.duration), aspectRatio: vs.aspectRatio,
      resolution: vs.resolution, audio: vs.audio !== false, wantsAudio: vs.audio !== false, imageAtt, image: Boolean(imageAtt), ...extra,
    };
  }
  function resolveVideoSelection(extra = {}) {
    const want = videoWant(extra);
    const vs = state.settings.video;
    if (vs.model && vs.model !== "auto") {
      const m = findVideoModel(vs.model);
      if (m) { const fit = fitVideoParams(m, want); return { auto: false, model: m, fit, cost: estimateVideoCost(m, fit), want }; }
    }
    const pick = chooseVideoModel(want);
    return { auto: true, model: pick.model, fit: pick.fit, cost: pick.cost, ranked: pick.ranked, want };
  }
  function expectedVideoSecs(e) {
    const id = String(e.model || "").toLowerCase();
    let s = /fast|lite|mini|turbo|flash/.test(id) ? 60 : /pro|max|prime|o1/.test(id) ? 150 : /veo-3\.1/.test(id) ? 110 : 90;
    if (vResRank(e.params?.resolution) >= 5) s += 40;
    if ((e.params?.duration || 0) > 8) s += (e.params.duration - 8) * 6;
    return s;
  }

  /* ---------- images for image-to-video ---------- */
  async function toVideoImage(att) {
    if (!att?.dataUrl) return null;
    if (/^data:image\/(png|jpeg);base64,/.test(att.dataUrl) && att.dataUrl.length < 8_000_000) return att.dataUrl;
    const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => rej(new Error("image decode failed")); i.src = att.dataUrl; });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || img.width; c.height = img.naturalHeight || img.height;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.toDataURL("image/jpeg", 0.92);
  }
  // The image the user attached most recently (within the last few turns, before `beforeMsg`).
  function latestUserImage(convo, beforeMsg) {
    if (!convo) return null;
    let msgs = convo.messages;
    if (beforeMsg) { const i = msgs.indexOf(beforeMsg); if (i > 0) msgs = msgs.slice(0, i); }
    let seen = 0;
    for (let i = msgs.length - 1; i >= 0 && seen < 3; i--) {
      const m = msgs[i];
      if (m.role !== "user" || m.auto) continue;
      seen++;
      const img = (m.images || []).find((a) => (a.kind === "image" || (!a.kind && String(a.media_type || "").startsWith("image/"))) && a.dataUrl);
      if (img) return img;
    }
    return null;
  }

  /* ---------- jobs ---------- */
  function newVideoEntry({ model, fit, prompt, originalPrompt, enhancedBy, auto, priority, hasImage }) {
    const params = { duration: fit.duration, resolution: fit.resolution, aspectRatio: fit.aspectRatio, audio: fit.audio, silent: fit.silent || undefined };
    return {
      uid: uid(), jobId: null, status: "preparing", provider: model.provider, providerLabel: videoProviderInfo(model.provider).label,
      model: model.id, label: model.label || model.id, prompt, originalPrompt: originalPrompt || prompt, enhancedBy: enhancedBy || null,
      params, estCost: estimateVideoCost(model, fit), cost: null, auto: Boolean(auto), priority: priority || state.settings.video.priority,
      hasImage: Boolean(hasImage), notes: (fit.notes || []).slice(), error: null, url: null, progress: null, createdAt: Date.now(),
    };
  }
  function applyJob(entry, job) {
    if (!job) return;
    entry.jobId = job.id;
    entry.status = job.status;
    entry.progress = job.progress;
    entry.error = job.error || null;
    entry.url = job.url || null;
    entry.size = job.size || null;
    if (job.cost != null) entry.cost = job.cost;
    if (job.providerLabel) entry.providerLabel = job.providerLabel;
    if (job.params) entry.params = { ...entry.params, ...job.params };
    const extra = (job.notes || []).filter((n) => !(entry.notes || []).includes(n));
    if (extra.length) entry.notes = [...(entry.notes || []), ...extra];
    entry.startedAt = job.startedAt || entry.startedAt;
    entry.finishedAt = job.finishedAt || null;
  }
  async function startVideoJob(convo, entry, imgAtt) {
    entry.status = "submitting";
    updateVideoCard(entry);
    try {
      const image = entry.hasImage && imgAtt ? await toVideoImage(imgAtt) : null;
      const res = await fetch("/api/video/generate", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          provider: entry.provider, model: entry.model, label: entry.label, prompt: entry.prompt,
          duration: entry.params.duration, resolution: entry.params.resolution, aspectRatio: entry.params.aspectRatio,
          audio: entry.params.audio, image: image || undefined, apiKey: videoKey(entry.provider) || undefined,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      applyJob(entry, data.job);
      trackVideo(entry.jobId);
    } catch (err) {
      entry.status = "failed";
      entry.error = err instanceof TypeError ? "Can't reach the MAX server." : err.message;
    }
    if (convo) _dirtyConvos.add(convo.id);
    saveConvos();
    updateVideoCard(entry);
    return entry;
  }

  // Poll the MAX server (cheap, local) for every video that is still being made.
  const videoWatch = new Set();
  const videoResumeTried = new Set();
  const looseVideos = new Map(); // jobId -> entry started by the chat tool whose message isn't saved yet
  let videoPollTimer = null;
  function findVideos(pred) {
    const out = [];
    for (const c of state.conversations) for (const m of c.messages || []) for (const v of m.videos || []) if (pred(v)) out.push({ convo: c, msg: m, entry: v });
    return out;
  }
  function trackVideo(jobId) {
    if (!jobId) return;
    videoWatch.add(jobId);
    clearTimeout(videoPollTimer);
    videoPollTimer = setTimeout(pollVideos, 1500);
  }
  async function pollVideos() {
    if (!videoWatch.size) return;
    const ids = [...videoWatch];
    let data;
    try {
      const r = await fetch("/api/video/jobs/status", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids }) });
      data = await r.json();
    } catch {
      videoPollTimer = setTimeout(pollVideos, 8000);
      return;
    }
    const dirty = new Set();
    for (const id of ids) {
      const job = data?.jobs ? data.jobs[id] : undefined;
      if (job === undefined) continue;
      const hits = findVideos((v) => v.jobId === id);
      if (!hits.length) {
        const loose = looseVideos.get(id);
        if (loose && job) applyJob(loose, job);
        if (!loose || job === null || VIDEO_TERMINAL.has(job?.status)) videoWatch.delete(id);
        continue;
      }
      if (job && job.status === "interrupted" && !videoResumeTried.has(id)) { videoResumeTried.add(id); resumeVideo(hits[0].entry); }
      for (const h of hits) {
        const before = `${h.entry.status}|${h.entry.progress}|${h.entry.url}`;
        const wasDone = h.entry.status === "completed";
        if (job === null) { h.entry.status = "failed"; h.entry.error = "This video job no longer exists on the MAX server."; }
        else applyJob(h.entry, job);
        if (`${h.entry.status}|${h.entry.progress}|${h.entry.url}` !== before) {
          dirty.add(h.convo.id);
          updateVideoCard(h.entry);
          if (!wasDone && h.entry.status === "completed" && h === hits[0]) toast(`🎬 Your video is ready — ${h.entry.label}`, "success");
          if (h.entry.status === "failed" && h === hits[0]) toast(`Video failed: ${String(h.entry.error || "").slice(0, 140)}`, "error");
        }
      }
      if (job === null || VIDEO_TERMINAL.has(job.status)) videoWatch.delete(id);
    }
    if (dirty.size) { dirty.forEach((id) => _dirtyConvos.add(id)); saveConvos(); }
    if (videoWatch.size) videoPollTimer = setTimeout(pollVideos, document.hidden ? 10000 : 3000);
  }
  async function resumeVideo(entry) {
    try {
      const r = await fetch(`/api/video/jobs/${encodeURIComponent(entry.jobId)}/resume`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ apiKey: videoKey(entry.provider) || undefined }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok && d.job) { applyJob(entry, d.job); updateVideoCard(entry); trackVideo(entry.jobId); }
    } catch {}
  }
  function resumeVideoTracking() {
    for (const h of findVideos((v) => !VIDEO_TERMINAL.has(v.status))) {
      if (h.entry.jobId) videoWatch.add(h.entry.jobId);
      else { h.entry.status = "failed"; h.entry.error = "Interrupted before the video was submitted — press Retry."; _dirtyConvos.add(h.convo.id); }
    }
    if (videoWatch.size) { clearTimeout(videoPollTimer); videoPollTimer = setTimeout(pollVideos, 800); }
  }

  /* ---------- prompt enhancer (uses your chat model) ---------- */
  async function enhanceVideoPrompt(idea, model, fit, imgAtt) {
    if (!providerReady()) return null;
    const audio = fit.audio === true || model.audioAlways;
    const ask = `Target video model: ${model.label}${fit.duration ? `, ${fit.duration} seconds` : ""}${fit.aspectRatio ? `, ${fit.aspectRatio}` : ""}, ${audio ? "generates native audio" : "silent video"}.` +
      (imgAtt ? " The video STARTS from the attached image — describe the motion that should happen, keep the subject and style consistent." : "") +
      `\nWrite ONE production-ready prompt: subject and the action beats in order, setting, camera (shot size and movement), lighting, color and mood, visual style${audio ? ", plus sound design and any dialogue in quotes" : ""}. Keep the user's intent and any on-screen text. 60–120 words, present tense, in English (keep dialogue/on-screen text in the user's language). Output only the prompt — no preamble, no markdown.\n\nIdea: ${idea}`;
    const content = [];
    if (imgAtt?.dataUrl && modelInfo().caps?.vision !== false && /^data:image\/(png|jpeg|gif|webp);base64,/.test(imgAtt.dataUrl)) {
      content.push({ type: "image", source: { type: "base64", media_type: imgAtt.dataUrl.slice(5, imgAtt.dataUrl.indexOf(";")), data: imgAtt.dataUrl.split(",")[1] } });
    }
    content.push({ type: "text", text: ask });
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 45000);
    try {
      const res = await fetch("/api/chat", {
        method: "POST", headers: { "Content-Type": "application/json" }, signal: ctrl.signal,
        body: JSON.stringify({
          provider: currentProvider(), model: currentModel(), apiKey: providerKey() || undefined, stream: false, max_tokens: 800,
          system: "You are an award-winning film director and prompt engineer for AI video models.",
          messages: [{ role: "user", content }],
        }),
      });
      if (!res.ok) return null;
      const data = await res.json().catch(() => null);
      const text = (data?.content || []).filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      if (!text || text.length < 15) return null;
      return text.replace(/^(?:video )?prompt\s*:\s*/i, "").replace(/^["“](.*)["”]$/s, "$1").trim().slice(0, 3500);
    } catch { return null; } finally { clearTimeout(t); }
  }

  /* ---------- sending a video request (Video mode, /video) ---------- */
  async function runVideoRequest(text) {
    if (state.attachments.some((a) => a.pending)) { toast("Still reading your files — one moment…"); return; }
    if (!state.videoCatalog.fetchedAt) await loadVideoCatalog();
    if (!anyVideoReady()) {
      toast("Connect a video model first: add an OpenRouter or Google Gemini key in Settings → Video generation. (Tip: /motion makes code-drawn animations without a key.)", "error");
      openSettings("video");
      return;
    }
    const imgAtt = currentVideoImage();
    const prompt = String(text || "").trim() || (imgAtt ? "Bring this image to life with natural, cinematic motion and a slow camera push-in." : "");
    if (!prompt) { $("#input").focus(); return; }
    const sel = resolveVideoSelection({ imageAtt: imgAtt, image: Boolean(imgAtt) });
    if (!sel.model) { toast("No video model is available.", "error"); return; }
    if (!videoProviderReady(sel.model.provider)) {
      toast(`Add a ${videoProviderInfo(sel.model.provider).label} key in Settings to use ${sel.model.label}.`, "error");
      openSettings("video");
      return;
    }
    const useImage = Boolean(imgAtt) && supportsImage(sel.model) !== false;
    if (imgAtt && !useImage) toast(`${sel.model.label} can't start from an image — generating from your text only.`, "");

    let convo = activeConvo();
    if (!convo) convo = newConversation();
    const userMsg = { id: uid(), role: "user", content: prompt, images: state.attachments.map((a) => ({ ...a })), videoRequest: true };
    const entry = newVideoEntry({ model: sel.model, fit: sel.fit, prompt, auto: sel.auto, hasImage: useImage });
    const aiMsg = { id: uid(), role: "assistant", kind: "video", content: "", videos: [entry], model: sel.model.label };
    convo.messages.push(userMsg, aiMsg);
    autoTitle(convo);
    touchConvo(convo);
    clearAttachments();
    const input = $("#input");
    input.value = ""; autoResize(input); updateCharCount(); updateSendState();
    renderMessages();
    renderConversations();

    if (state.settings.video.enhance && providerReady()) {
      entry.status = "enhancing";
      updateVideoCard(entry);
      const better = await enhanceVideoPrompt(prompt, sel.model, sel.fit, useImage ? imgAtt : null);
      if (better) { entry.prompt = better; entry.enhancedBy = modelLabel(currentModel(), currentProvider()); }
    }
    await startVideoJob(convo, entry, useImage ? imgAtt : null);
  }

  async function regenerateVideo(hit, modelKey) {
    const { convo, msg, entry } = hit;
    const img = entry.hasImage ? latestUserImage(convo, msg) : null;
    const want = {
      priority: entry.priority || state.settings.video.priority, duration: entry.params?.duration, aspectRatio: entry.params?.aspectRatio,
      resolution: entry.params?.resolution, audio: entry.params?.audio !== false, wantsAudio: entry.params?.audio !== false, imageAtt: img, image: Boolean(img),
    };
    let model, fit, auto = false;
    if (modelKey === "auto") { const pick = chooseVideoModel(want); model = pick.model; fit = pick.fit; auto = true; }
    else { model = findVideoModel(modelKey || `${entry.provider}::${entry.model}`); fit = model ? fitVideoParams(model, want) : null; }
    if (!model) { toast("No video model is available — add a key in Settings → Video generation.", "error"); return; }
    if (!videoProviderReady(model.provider)) { toast(`Add a ${videoProviderInfo(model.provider).label} key first.`, "error"); openSettings("video"); return; }
    const e2 = newVideoEntry({ model, fit, prompt: entry.prompt, originalPrompt: entry.originalPrompt, enhancedBy: entry.enhancedBy, auto, priority: want.priority, hasImage: Boolean(img) && supportsImage(model) !== false });
    msg.videos.push(e2);
    _dirtyConvos.add(convo.id);
    saveConvos();
    const cards = document.querySelector(`.msg[data-id="${CSS.escape(msg.id)}"] .vcards`);
    if (cards) { cards.insertAdjacentHTML("beforeend", videoCardHtml(e2)); ensureVideoTicker(); } else renderMessages();
    await startVideoJob(convo, e2, img);
  }

  /* ---------- chat tool: the chat model decides to make a video ---------- */
  function videoCapsLine(m) {
    const bits = [];
    if (m.durations?.length) { const lo = Math.min(...m.durations), hi = Math.max(...m.durations); bits.push(lo === hi ? `${lo}s` : `${lo}–${hi}s`); }
    if (m.resolutions?.length) bits.push(m.resolutions.slice().sort((a, b) => vResRank(b) - vResRank(a))[0].replace(/k$/, "K"));
    if (m.audio === true || m.audioAlways) bits.push("🔊");
    if (supportsImage(m)) bits.push("🖼");
    return bits.join(" · ");
  }
  function videoToolDef() {
    const models = usableVideoModels().filter((m) => !/sora/i.test(m.id))
      .sort((a, b) => videoNote(b.id).q - videoNote(a.id).q).slice(0, 16);
    const lines = models.map((m) => {
      const est = estimateVideoCost(m, fitVideoParams(m, { priority: "balanced" }));
      return `- ${videoModelKey(m)} — ${m.label}${videoNote(m.id).note ? `: ${videoNote(m.id).note}` : ""} [${videoCapsLine(m) || "caps unknown"}${est != null ? `, ~$${(est / (fitVideoParams(m, {}).duration || 1)).toFixed(2)}/s` : ""}]`;
    }).join("\n");
    return {
      name: "generate_video",
      description: "Generate a REAL AI video with a video-generation model (text-to-video, or image-to-video from an image the user attached). Use it whenever the user asks to create, make, generate or animate a video, clip, scene, shot, trailer, ad or animation. It returns right away with a job id; the finished video appears in the chat automatically (usually 1–3 minutes). Choose the model that best fits the request, or omit `model` to let MAX auto-choose using the user's priority.\nAvailable models:\n" + lines,
      input_schema: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "Rich, specific shot description in English: subject, action beats in order, setting, camera shot & movement, lighting, mood, style; for audio models also sound/music and any dialogue in quotes." },
          model: { type: "string", description: "Optional model id from the list (provider::id). Omit to auto-choose." },
          priority: { type: "string", enum: ["quality", "balanced", "fast"], description: "Used when auto-choosing. Defaults to the user's setting." },
          duration_seconds: { type: "integer", description: "Desired length in seconds (snapped to what the model supports)." },
          aspect_ratio: { type: "string", description: "16:9 (landscape), 9:16 (vertical / shorts / reels), 1:1 (square)…" },
          resolution: { type: "string", description: "480p, 720p, 1080p or 4k (snapped to what the model supports)." },
          audio: { type: "boolean", description: "Generate sound (models with native audio only). Default true." },
          use_attached_image: { type: "boolean", description: "Start from the image the user attached (image-to-video). Default true when an image was attached." },
        },
        required: ["prompt"],
      },
    };
  }
  async function runVideoTool(input, ctx) {
    if (!state.videoCatalog.fetchedAt) await loadVideoCatalog();
    if (!anyVideoReady()) return "Error: no video model is connected. Tell the user to add an OpenRouter or Google Gemini key in Settings → Video generation.";
    const prompt = String(input.prompt || "").trim();
    if (!prompt) return "Error: 'prompt' is required.";
    const convo = ctx?.convo || activeConvo();
    const vs = state.settings.video;
    const imgAtt = input.use_attached_image === false ? null : latestUserImage(convo);
    const want = videoWant({
      priority: VIDEO_PRIORITIES[input.priority] ? input.priority : vs.priority,
      duration: Number(input.duration_seconds) || (vs.duration === "auto" ? null : Number(vs.duration)),
      aspectRatio: typeof input.aspect_ratio === "string" && /^\d{1,2}:\d{1,2}$/.test(input.aspect_ratio) ? input.aspect_ratio : vs.aspectRatio,
      resolution: typeof input.resolution === "string" && input.resolution ? input.resolution : vs.resolution,
      audio: input.audio !== undefined ? input.audio !== false : vs.audio !== false,
      imageAtt: imgAtt, image: Boolean(imgAtt),
    });
    want.wantsAudio = want.audio;
    let model = input.model ? findVideoModel(String(input.model).trim()) : null;
    let fit, auto = false, note = "";
    if (model && (!videoProviderReady(model.provider) || model.custom)) {
      note = ` (${input.model} isn't available, so MAX auto-chose instead)`;
      model = null;
    }
    if (!model) {
      const pick = chooseVideoModel(want);
      if (!pick.model) return "Error: no usable video model.";
      model = pick.model; fit = pick.fit; auto = true;
    } else fit = fitVideoParams(model, want);
    const useImage = Boolean(imgAtt) && supportsImage(model) !== false;
    const entry = newVideoEntry({ model, fit, prompt, auto, priority: want.priority, hasImage: useImage });
    ctx?.videos?.push(entry);
    await startVideoJob(convo, entry, useImage ? imgAtt : null);
    if (entry.jobId) looseVideos.set(entry.jobId, entry);
    if (entry.status === "failed") return `Error starting the video: ${entry.error}`;
    const p = entry.params;
    const bits = [p.duration && `${p.duration}s`, p.aspectRatio, p.resolution, p.audio ? "with audio" : "", useImage ? "from the attached image" : ""].filter(Boolean).join(", ");
    return `Started video ${entry.jobId} with ${model.label} via ${entry.providerLabel}${auto ? ` (auto-chosen for "${VIDEO_PRIORITIES[want.priority].label}")` : ""}${note} — ${bits}` +
      `${entry.estCost != null ? `, estimated $${entry.estCost.toFixed(2)}` : ""}${entry.notes.length ? `. Adjusted: ${entry.notes.join("; ")}` : ""}. ` +
      `It renders in the chat automatically when ready (~${Math.round(expectedVideoSecs(entry) / 60) || 1} min). Tell the user briefly what you're generating and which model you picked (and why). Do not include links.`;
  }

  /* ---------- video cards ---------- */
  const arCss = (a) => { const [w, h] = String(a || "16:9").split(":").map(Number); return w && h ? `${w} / ${h}` : "16 / 9"; };
  function videoCardHtml(v) {
    const p = v.params || {};
    const pending = !VIDEO_TERMINAL.has(v.status) && v.status !== "interrupted";
    const chips = [p.duration && `${p.duration}s`, p.aspectRatio, p.resolution && String(p.resolution).replace(/k$/, "K"),
      p.audio === true ? "🔊 audio" : p.silent ? "🔇 silent" : "", v.hasImage ? "🖼 from image" : ""].filter(Boolean);
    const cost = v.cost != null ? `$${Number(v.cost).toFixed(2)}` : v.estCost != null ? `~$${Number(v.estCost).toFixed(2)}` : "";
    const portrait = orient(p.aspectRatio) < 0;
    let body;
    if (v.status === "completed" && v.url) {
      body = `<video class="vcard__video" controls playsinline preload="metadata" src="${esc(v.url)}"></video>`;
    } else if (v.status === "failed" || v.status === "cancelled") {
      body = `<div class="vcard__error">⚠ ${esc(v.error || (v.status === "cancelled" ? "Cancelled." : "Generation failed."))}</div>`;
    } else {
      const exp = expectedVideoSecs(v);
      body = `<div class="vcard__stage" style="aspect-ratio:${arCss(p.aspectRatio)}">
        <div class="vcard__shimmer"></div>
        <div class="vcard__center"><div class="vcard__label">${v.status === "interrupted" ? "⏸" : '<span class="tool-run__spin"></span>'} ${esc(VSTATUS[v.status] || "Working…")}</div>
        <div class="vcard__meta"><span class="vcard__time">0:00</span> · usually ~${Math.max(1, Math.round(exp / 60))} min${v.progress != null ? ` · ${Math.round(v.progress)}%` : ""}</div></div>
        <div class="vcard__progress"><span></span></div></div>`;
    }
    const actions = [];
    if (v.status === "completed" && v.url) {
      actions.push(`<a class="vcard__btn vcard__btn--primary" href="${esc(v.url)}?download=1" download>⬇ Download</a>`);
      actions.push(`<button type="button" class="vcard__btn" data-vact="regen">↻ Regenerate</button>`);
      actions.push(`<button type="button" class="vcard__btn" data-vact="other">⇄ Other model</button>`);
      actions.push(`<button type="button" class="vcard__btn" data-vact="remix">✎ Remix</button>`);
    } else if (v.status === "failed" || v.status === "cancelled") {
      actions.push(`<button type="button" class="vcard__btn vcard__btn--primary" data-vact="regen">↻ Retry</button>`);
      actions.push(`<button type="button" class="vcard__btn" data-vact="other">⇄ Other model</button>`);
      actions.push(`<button type="button" class="vcard__btn" data-vact="remix">✎ Edit prompt</button>`);
      if (/key|credit|401|402|403/i.test(v.error || "")) actions.push(`<button type="button" class="vcard__btn" data-vact="setup">⚙ Settings</button>`);
    } else if (v.status === "interrupted") {
      actions.push(`<button type="button" class="vcard__btn vcard__btn--primary" data-vact="resume">▶ Resume</button>`);
    } else if (v.jobId) {
      actions.push(`<button type="button" class="vcard__btn" data-vact="cancel">✕ Cancel</button>`);
    }
    actions.push(`<button type="button" class="vcard__btn" data-vact="copy">⧉ Prompt</button>`);
    const orig = v.enhancedBy && v.originalPrompt && v.originalPrompt !== v.prompt ? `<div class="vcard__orig">Your idea: ${esc(v.originalPrompt)}</div>` : "";
    return `<div class="vcard${pending ? " vcard--pending" : ""}${portrait ? " vcard--portrait" : ""} vcard--${esc(v.status)}" data-vid="${esc(v.uid)}"
      data-since="${Number(v.startedAt || v.createdAt) || Date.now()}" data-expected="${expectedVideoSecs(v)}" data-progress="${v.progress != null ? Math.round(v.progress) : ""}">
      <div class="vcard__head"><span class="vcard__model">🎬 ${esc(v.label)}</span>
        <span class="vcard__prov">${esc(v.providerLabel || v.provider)}${v.auto ? " · auto-chosen" : ""}</span>
        <span class="vcard__chips">${chips.map((c) => `<span class="vcard__chip">${esc(c)}</span>`).join("")}${cost ? `<span class="vcard__chip vcard__cost" title="${v.cost != null ? "Actual cost reported by the provider" : "Estimate from list prices"}">${esc(cost)}</span>` : ""}</span></div>
      ${body}
      <details class="vcard__prompt"><summary>${v.enhancedBy ? `✨ Prompt (enhanced by ${esc(v.enhancedBy)})` : "Prompt"}</summary><div>${esc(v.prompt)}</div>${orig}</details>
      ${v.notes?.length ? `<div class="vcard__notes">ℹ ${esc(v.notes.join(" · "))}</div>` : ""}
      <div class="vcard__actions">${actions.join("")}</div>
    </div>`;
  }
  function videosHtml(m) {
    return m.videos?.length ? `<div class="vcards">${m.videos.map(videoCardHtml).join("")}</div>` : "";
  }
  function updateVideoCard(entry) {
    const el = document.querySelector(`.vcard[data-vid="${CSS.escape(entry.uid)}"]`);
    if (!el) return;
    if (entry.status === "completed" && el.querySelector("video")?.getAttribute("src") === entry.url) return; // keep playback
    const open = el.querySelector(".vcard__prompt")?.open;
    el.outerHTML = videoCardHtml(entry);
    if (open) document.querySelector(`.vcard[data-vid="${CSS.escape(entry.uid)}"] .vcard__prompt`)?.setAttribute("open", "");
    ensureVideoTicker();
  }
  let vTicker = null;
  function tickVideoCards() {
    const els = $$(".vcard--pending");
    if (!els.length) { clearInterval(vTicker); vTicker = null; return; }
    const now = Date.now();
    for (const el of els) {
      const secs = Math.max(0, Math.round((now - (+el.dataset.since || now)) / 1000));
      const t = el.querySelector(".vcard__time");
      if (t) t.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`;
      const bar = el.querySelector(".vcard__progress span");
      const exp = +el.dataset.expected || 90;
      if (bar) bar.style.width = `${el.dataset.progress !== "" ? el.dataset.progress : Math.round(95 * (1 - Math.exp(-secs / exp)))}%`;
    }
  }
  function ensureVideoTicker() {
    if (!vTicker && document.querySelector(".vcard--pending")) { vTicker = setInterval(tickVideoCards, 1000); tickVideoCards(); }
  }
  async function handleVideoCardAction(action, card, btn) {
    const hit = findVideos((v) => v.uid === card.dataset.vid)[0];
    if (!hit) return;
    const e = hit.entry;
    if (action === "copy") { copyText(e.prompt); toast("Prompt copied", "success"); return; }
    if (action === "setup") { openSettings("video"); return; }
    if (action === "remix") {
      setVideoMode(true);
      const input = $("#input");
      input.value = e.originalPrompt || e.prompt;
      autoResize(input); updateCharCount(); updateSendState(); input.focus();
      return;
    }
    if (action === "regen") return regenerateVideo(hit, null);
    if (action === "other") return openVideoModelPicker(btn, { onPick: (key) => regenerateVideo(hit, key), title: "Regenerate with…" });
    if (action === "resume") return resumeVideo(e);
    if (action === "cancel") {
      if (!confirm("Stop waiting for this video? The provider may still charge for it.")) return;
      try {
        const r = await fetch(`/api/video/jobs/${encodeURIComponent(e.jobId)}/cancel`, { method: "POST" });
        const d = await r.json().catch(() => ({}));
        if (d.job) applyJob(e, d.job);
      } catch {}
      videoWatch.delete(e.jobId);
      _dirtyConvos.add(hit.convo.id);
      saveConvos();
      updateVideoCard(e);
    }
  }

  /* ---------- Video mode (composer) ---------- */
  function setVideoMode(on) {
    state.videoMode = Boolean(on);
    if (state.videoMode && !state.videoCatalog.fetchedAt) loadVideoCatalog();
    renderVideoControls();
    updateSendState();
  }
  function renderVideoControls() {
    const box = $("#video-controls");
    if (!box) return;
    const on = Boolean(state.videoMode);
    box.hidden = !on;
    $("#composer")?.classList.toggle("composer--video", on);
    const tog = $("#video-toggle");
    if (tog) { tog.classList.toggle("on", on); tog.setAttribute("aria-pressed", String(on)); }
    const input = $("#input");
    if (input) input.placeholder = on ? VIDEO_PLACEHOLDER : (state._chatPlaceholder || input.placeholder);
    $("#send-btn").title = on ? "Generate video (Enter)" : "Send (Enter)";
    if (!on) return;
    if (!anyVideoReady()) {
      box.innerHTML = `<button type="button" class="vc-pill vc-setup" data-vc="setup">🎬 Connect a video model →</button>
        <span class="vc-hint">${state.videoCatalog.fetchedAt ? "Add an OpenRouter or Google Gemini key" : "Loading video models…"}</span>`;
      return;
    }
    const vs = state.settings.video;
    const sel = resolveVideoSelection();
    const m = sel.model;
    const f = sel.fit || {};
    const name = sel.auto ? `<b>Auto</b>${m ? ` → ${esc(m.label)}` : ""}` : esc(m ? m.label : "Choose model");
    const audioBtn = m && (m.audioAlways || m.audio === true)
      ? `<button type="button" class="vc-pill vc-toggle${f.audio ? " on" : ""}" data-vc="audio" ${m.audioAlways ? "disabled" : ""} title="${m.audioAlways ? "This model always generates audio" : "Generate sound"}">${f.audio ? "🔊" : "🔇"}</button>`
      : `<button type="button" class="vc-pill vc-toggle" data-vc="audio" disabled title="This model makes silent video">🔇</button>`;
    const notes = (f.notes || []).join(" · ");
    box.innerHTML = `
      <button type="button" class="vc-pill vc-model" data-vc="model" title="${esc(sel.auto ? `MAX chooses the best model (${VIDEO_PRIORITIES[vs.priority]?.label || ""})` : `${m?.label} · ${videoProviderInfo(m?.provider).label}`)}">🎬 ${name} <span class="vc-chev">▾</span></button>
      <button type="button" class="vc-pill" data-vc="duration" title="Length">⏱ ${f.duration ? `${f.duration}s` : "auto"}</button>
      <button type="button" class="vc-pill" data-vc="aspect" title="Aspect ratio">${orient(f.aspectRatio) < 0 ? "▯" : orient(f.aspectRatio) > 0 ? "▭" : "□"} ${esc(f.aspectRatio || "auto")}</button>
      <button type="button" class="vc-pill" data-vc="resolution" title="Resolution">${esc(String(f.resolution || "auto").replace(/k$/, "K"))}</button>
      ${audioBtn}
      <button type="button" class="vc-pill vc-toggle${vs.enhance ? " on" : ""}" data-vc="enhance" title="${vs.enhance ? "✨ Enhance ON — your chat model turns short ideas into detailed shot descriptions" : "✨ Enhance OFF — your prompt is sent as-is"}">✨</button>
      ${sel.cost != null ? `<span class="vc-cost" title="Estimated from list prices">~$${sel.cost.toFixed(2)}</span>` : ""}
      ${notes ? `<span class="vc-note" title="${esc(notes)}">ℹ</span>` : ""}`;
  }
  function openOptionPop(anchor, title, options, current, onPick) {
    if (popEl && popEl.dataset.for === title) { closePop(); return; }
    closePop();
    const pop = document.createElement("div");
    pop.className = "effort-pop opt-pop";
    pop.dataset.for = title;
    pop.innerHTML = `<div class="effort-pop__head">${esc(title)}</div>` + options.map((o) => {
      const on = String(o.value) === String(current);
      return `<button type="button" class="effort-opt${on ? " active" : ""}" data-v="${esc(String(o.value))}">
        <span class="effort-opt__label">${esc(o.label)}</span>${o.hint ? `<span class="effort-opt__hint">${esc(o.hint)}</span>` : ""}
        ${on ? `<svg class="effort-opt__check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>` : ""}</button>`;
    }).join("");
    document.body.appendChild(pop);
    popEl = pop;
    placePop(pop, anchor, "above");
    pop.querySelectorAll(".effort-opt").forEach((b) => b.addEventListener("click", () => { closePop(); onPick(b.dataset.v); }));
    dismissOnOutside(pop, anchor);
  }
  function onVideoControl(kind, btn) {
    const vs = state.settings.video;
    const sel = resolveVideoSelection();
    const m = sel.model || {};
    const done = () => { saveSettings(); renderVideoControls(); };
    if (kind === "setup") return openSettings("video");
    if (kind === "model") return openVideoModelPicker(btn, {});
    if (kind === "enhance") { vs.enhance = !vs.enhance; done(); toast(vs.enhance ? "✨ Prompt enhancement on" : "Prompt enhancement off"); return; }
    if (kind === "audio") { vs.audio = !vs.audio; done(); return; }
    if (kind === "duration") {
      const list = m.durationsByResolution?.[String(sel.fit?.resolution || "").toLowerCase()] || m.durations || [4, 5, 6, 8, 10, 12, 15];
      return openOptionPop(btn, "Length", [{ value: "auto", label: "Auto", hint: "Best fit for the model" }, ...list.map((d) => ({ value: d, label: `${d} seconds` }))],
        vs.duration, (v) => { vs.duration = v === "auto" ? "auto" : Number(v); done(); });
    }
    if (kind === "aspect") {
      const all = [["16:9", "Landscape"], ["9:16", "Vertical — Shorts / Reels / TikTok"], ["1:1", "Square"], ["4:3", "Classic"], ["3:4", "Portrait"], ["21:9", "Cinema wide"]];
      const list = m.aspectRatios?.length ? all.filter(([a]) => m.aspectRatios.includes(a)) : all.slice(0, 3);
      return openOptionPop(btn, "Aspect ratio", [{ value: "auto", label: "Auto", hint: "Match the attached image, else 16:9" }, ...list.map(([a, h]) => ({ value: a, label: a, hint: h }))],
        vs.aspectRatio, (v) => { vs.aspectRatio = v; done(); });
    }
    if (kind === "resolution") {
      const all = ["480p", "720p", "1080p", "4k"];
      const list = m.resolutions?.length ? m.resolutions.slice().sort((a, b) => vResRank(a) - vResRank(b)) : all;
      return openOptionPop(btn, "Resolution", [{ value: "auto", label: "Auto", hint: "720p (1080p for Best quality)" }, ...list.map((r) => ({ value: r, label: String(r).replace(/k$/, "K") }))],
        vs.resolution, (v) => { vs.resolution = v; done(); });
    }
  }

  /* ---------- video model picker ---------- */
  function openVideoModelPicker(anchor, { onPick, title } = {}) {
    if (popEl && popEl.classList.contains("vmodel-pop")) { closePop(); return; }
    closePop();
    const pop = document.createElement("div");
    pop.className = "model-pop vmodel-pop";
    let tab = "all";
    const provs = () => videoProviders();
    pop.innerHTML = `
      ${title ? `<div class="vmp-title">${esc(title)}</div>` : ""}
      <div class="model-pop__search">
        <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>
        <input type="text" placeholder="Search video models…" autocomplete="off" spellcheck="false" />
      </div>
      <div class="model-pop__tabs"></div>
      <div class="model-pop__list" role="listbox"></div>
      <div class="model-pop__foot">
        <input type="text" class="mp-custom" placeholder="Custom video model id…" spellcheck="false" />
        <select class="mp-custom-prov"></select>
        <button type="button" class="btn btn--ghost btn--sm mp-custom-use">Use</button>
      </div>`;
    document.body.appendChild(pop);
    popEl = pop;
    const input = pop.querySelector("input");
    const listEl = pop.querySelector(".model-pop__list");
    const pick = (key) => {
      closePop();
      if (onPick) return onPick(key);
      state.settings.video.model = key;
      saveSettings();
      renderVideoControls();
      const m = findVideoModel(key);
      toast(key === "auto" ? `Auto — MAX picks the best model (${VIDEO_PRIORITIES[state.settings.video.priority].label})` : `Video model: ${m?.label || key}`, "success");
    };
    const renderTabs = () => {
      pop.querySelector(".model-pop__tabs").innerHTML = `<button type="button" class="mp-tab${tab === "all" ? " active" : ""}" data-t="all">All</button>` +
        provs().map((p) => `<button type="button" class="mp-tab${tab === p.id ? " active" : ""}" data-t="${esc(p.id)}">${esc(p.label.replace(/ \(.*\)$/, ""))}${videoProviderReady(p.id) ? "" : ' <span class="mp-nokey" title="No key yet">•</span>'}</button>`).join("") +
        `<button type="button" class="icon-btn vmp-refresh" title="Refresh the live model list" aria-label="Refresh">↻</button>`;
      pop.querySelectorAll(".mp-tab").forEach((t) => t.addEventListener("click", () => { tab = t.dataset.t; renderTabs(); render(); }));
      pop.querySelector(".vmp-refresh").addEventListener("click", async (e) => {
        e.currentTarget.classList.add("spinning");
        await loadVideoCatalog(true);
        if (popEl === pop) { renderTabs(); render(); toast(`Video models refreshed — ${videoModels().length} available`); }
      });
      pop.querySelector(".mp-custom-prov").innerHTML = provs().map((p) => `<option value="${esc(p.id)}">${esc(p.label)}</option>`).join("");
    };
    const render = () => {
      const q = input.value.trim().toLowerCase();
      const cur = onPick ? "" : state.settings.video.model;
      const want = videoWant();
      let html = "";
      if (!q && tab === "all") {
        const auto = chooseVideoModel(want);
        html += `<div class="vmp-auto${cur === "auto" ? " selected" : ""}">
          <button type="button" class="mp-item" data-key="auto"><span class="mp-item__main"><span class="mp-item__label">✨ Auto — MAX chooses</span>
          <span class="mp-item__id">${auto.model ? `Right now: ${esc(auto.model.label)} (${esc(videoProviderInfo(auto.model.provider).label)})` : "Add a video key to enable"}</span></span>
          ${cur === "auto" ? `<svg class="mp-item__check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>` : ""}</button>
          <div class="vmp-prio">${Object.entries(VIDEO_PRIORITIES).map(([k, p]) => `<button type="button" class="vmp-prio__b${state.settings.video.priority === k ? " on" : ""}" data-prio="${k}" title="${esc(p.hint)}">${esc(p.label)}</button>`).join("")}</div>
        </div>`;
      }
      const models = videoModels().filter((m) => (tab === "all" || m.provider === tab) &&
        (!q || [m.label, m.id, m.family, videoNote(m.id).note].join(" ").toLowerCase().includes(q)))
        .sort((a, b) => (videoProviderReady(b.provider) - videoProviderReady(a.provider)) ||
          (VIDEO_PROVIDER_IDS.indexOf(a.provider) - VIDEO_PROVIDER_IDS.indexOf(b.provider)) || (videoNote(b.id).q - videoNote(a.id).q));
      let group = "";
      for (const m of models) {
        const g = videoProviderInfo(m.provider).label;
        if (g !== group) {
          group = g;
          const err = state.videoCatalog.errors?.[m.provider];
          html += `<div class="mp-group">${esc(g)}${videoProviderReady(m.provider) ? "" : ` <button type="button" class="mp-addkey" data-addkey="1">add key</button>`}</div>` +
            (err ? `<div class="vmp-err">${esc(err)}</div>` : "");
        }
        const key = videoModelKey(m);
        const fit = fitVideoParams(m, want);
        const est = estimateVideoCost(m, fit);
        const sel = key === cur;
        html += `<button type="button" class="mp-item${sel ? " selected" : ""}${videoProviderReady(m.provider) ? "" : " mp-item--off"}" data-key="${esc(key)}">
          <span class="mp-item__main"><span class="mp-item__label">${esc(m.label)}${m.live === false && m.provider === "openrouter" ? ' <span class="mp-badge mp-badge--dim">offline list</span>' : ""}</span>
          <span class="mp-item__id">${esc(m.id)}${videoNote(m.id).note ? ` · ${esc(videoNote(m.id).note)}` : ""}</span></span>
          <span class="vmp-caps">${esc(videoCapsLine(m))}${est != null ? `<span class="vmp-cost">~$${est.toFixed(2)}</span>` : ""}</span>
          ${sel ? `<svg class="mp-item__check" viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>` : ""}
        </button>`;
      }
      if (!models.length) html += `<div class="repo-pop__msg">${state.videoCatalog.fetchedAt ? "No video models match." : '<div class="repo-spinner"></div>'}</div>`;
      listEl.innerHTML = html;
      listEl.querySelectorAll("[data-key]").forEach((b) => b.addEventListener("click", () => {
        const key = b.dataset.key;
        const m = key === "auto" ? null : findVideoModel(key);
        if (m && !videoProviderReady(m.provider)) { closePop(); toast(`Add a ${videoProviderInfo(m.provider).label} key to use ${m.label}.`); openSettings("video"); return; }
        pick(key);
      }));
      listEl.querySelectorAll("[data-prio]").forEach((b) => b.addEventListener("click", (e) => {
        e.stopPropagation();
        state.settings.video.priority = b.dataset.prio;
        saveSettings(); renderVideoControls(); render();
      }));
      listEl.querySelectorAll("[data-addkey]").forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); closePop(); openSettings("video"); }));
    };
    input.addEventListener("input", render);
    input.addEventListener("keydown", (e) => { if (e.key === "Escape") closePop(); });
    const useCustom = () => {
      const id = pop.querySelector(".mp-custom").value.trim();
      if (!id) return;
      const provider = pop.querySelector(".mp-custom-prov").value;
      const custom = state.settings.video.custom || (state.settings.video.custom = []);
      if (!custom.some((c) => c.provider === provider && c.id === id)) custom.push({ provider, id });
      saveSettings();
      pick(`${provider}::${id}`);
    };
    pop.querySelector(".mp-custom-use").addEventListener("click", useCustom);
    pop.querySelector(".mp-custom").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); useCustom(); } });
    renderTabs();
    render();
    placePop(pop, anchor, anchor.closest(".composer-wrap") ? "above" : "below");
    setTimeout(() => input.focus(), 20);
    dismissOnOutside(pop, anchor);
    if (!state.videoCatalog.fetchedAt) loadVideoCatalog().then(() => { if (popEl === pop) { renderTabs(); render(); } });
  }

  async function testVideoProvider(provider, btn, out) {
    setBtnBusy(btn, true);
    out.textContent = "Checking…"; out.style.color = "";
    try {
      const field = { openrouter: "#set-orkey", google: "#set-gkey", gateway: "#set-gwkey" }[provider];
      const res = await fetch("/api/video/test", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ provider, apiKey: $(field)?.value.trim() || videoKey(provider) || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.error?.message || `HTTP ${res.status}`);
      out.textContent = "✓ " + data.message; out.style.color = "#34d399";
    } catch (err) {
      out.textContent = "✗ " + (err instanceof TypeError ? "Can't reach the MAX server." : err.message); out.style.color = "#ff6b8a";
    } finally { setBtnBusy(btn, false); }
  }

  function applyPerfMode() {
    const on = !!state.settings.perfMode;
    document.documentElement.classList.toggle("perf", on);
    window.MaxBg?.setEnabled(!on);
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
    const info = modelInfo();
    $("#model-pill-name").textContent = info.label || currentModel();
    const prov = $("#model-pill-prov");
    if (prov) prov.textContent = providerInfo(currentProvider()).label.replace(/ API$/, "");
    $("#model-pill").classList.toggle("model-pill--nokey", !providerReady());
    renderCapChips();
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
    const p = currentProvider();
    const label = providerInfo(p).label.replace(/ API$/, "");
    if (providerKey(p) && state.config.allowClientKey) { el.textContent = `${label}: your key`; el.className = "key-status ok"; }
    else if (providerInfo(p).hasServerKey) { el.textContent = `${label}: server key`; el.className = "key-status ok"; }
    else { el.textContent = `No ${label} key`; el.className = "key-status warn"; el.style.cursor = "pointer"; }
    el.title = "AI provider key status — click to manage keys";
  }

  /* ============================================================
     Settings modal
     ============================================================ */
  function openSettings(section) {
    const s = state.settings;
    // populate model select, grouped by provider (value = "provider::id")
    const sel = $("#set-model");
    const providers = state.config.providers || DEFAULT_PROVIDERS;
    sel.innerHTML = providers.map((p) => `<optgroup label="${esc(p.label)}">` +
      allModels().filter((m) => m.provider === p.id).map((m) => `<option value="${esc(p.id + "::" + m.id)}">${esc(m.label)}</option>`).join("") +
      `</optgroup>`).join("");
    const curKey = `${currentProvider()}::${currentModel()}`;
    if ([...sel.options].some((o) => o.value === curKey)) { sel.value = curKey; $("#set-model-custom").value = ""; }
    else { $("#set-model-custom").value = s.model || ""; }
    $("#set-model-custom-prov").value = currentProvider();

    $("#set-apikey").value = s.apiKey || "";
    $("#set-cckey").value = s.ccKey || "";
    $("#set-remember").checked = !!s.rememberKeys;
    $("#set-perf").checked = !!s.perfMode;
    $("#set-orkey").value = state.videoKeys.openrouter || "";
    $("#set-gkey").value = state.videoKeys.google || "";
    $("#set-gwkey").value = state.videoKeys.gateway || "";
    $("#set-vpriority").value = s.video.priority;
    $("#set-venhance").checked = s.video.enhance !== false;
    ["#or-test-result", "#g-test-result", "#gw-test-result"].forEach((id) => { $(id).textContent = ""; });
    const vp = (id) => videoProviders().find((p) => p.id === id);
    const serverNote = (id) => (vp(id)?.hasServerKey ? " A server key is configured — leave blank to use it." : "");
    $("#orkey-help").innerHTML = `Get one at <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer">openrouter.ai/keys</a>.${serverNote("openrouter")}`;
    $("#gkey-help").innerHTML = `Get one at <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener noreferrer">aistudio.google.com/apikey</a> (Veo needs a paid-tier key).${serverNote("google")}`;
    const gw = vp("gateway");
    $("#gwkey-field").style.display = gw ? "" : "none";
    if (gw) {
      $("#gw-label").textContent = gw.label;
      $("#gw-help").textContent = `Base URL: ${gw.base}. MAX lists the gateway's models and uses any video models it offers.${gw.hasServerKey ? " A server key is configured." : ""}`;
    }
    $("#cc-test-result").textContent = ""; $("#ar-test-result").textContent = "";
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
    const ar = providerInfo("agentrouter"), cc = providerInfo("codecraft");
    $("#apikey-field").style.display = state.config.allowClientKey ? "" : "none";
    $("#cckey-field").style.display = state.config.allowClientKey ? "" : "none";
    $("#apikey-help").innerHTML = ar.hasServerKey
      ? "A server key is configured. Leave blank to use it, or enter your own to override."
      : `Get a key at <a href="${esc(ar.keyUrl)}" target="_blank" rel="noopener noreferrer">agentrouter.org</a>.`;
    $("#cckey-help").innerHTML = cc.hasServerKey
      ? "A server key is configured. Leave blank to use it, or paste your own to override."
      : `Get a key at <a href="${esc(cc.keyUrl)}" target="_blank" rel="noopener noreferrer">codecraftapi.com</a> → API Keys.`;
    $("#settings-note").textContent = "";
    $("#settings-overlay").hidden = false;
    if (section === "video") setTimeout(() => {
      $("#video-section")?.scrollIntoView({ block: "start" });
      (state.videoKeys.openrouter ? $("#set-gkey") : $("#set-orkey")).focus();
    }, 40);
    if (section === "providers") setTimeout(() => { $("#providers-section")?.scrollIntoView({ block: "start" }); (s.ccKey || cc.hasServerKey ? $("#set-apikey") : $("#set-cckey")).focus(); }, 40);
  }
  function closeSettings() { $("#settings-overlay").hidden = true; }

  function saveSettingsFromModal() {
    const custom = $("#set-model-custom").value.trim();
    state.settings.rememberKeys = $("#set-remember").checked;
    state.settings.apiKey = $("#set-apikey").value.trim();
    state.settings.ccKey = $("#set-cckey").value.trim();
    if (custom) { state.settings.model = custom; state.settings.aiProvider = $("#set-model-custom-prov").value; }
    else {
      const [prov, ...rest] = $("#set-model").value.split("::");
      state.settings.aiProvider = prov; state.settings.model = rest.join("::");
    }
    state.settings.perfMode = $("#set-perf").checked;
    applyPerfMode();
    const gwBefore = videoKey("gateway");
    state.videoKeys = { openrouter: $("#set-orkey").value.trim(), google: $("#set-gkey").value.trim(), gateway: $("#set-gwkey").value.trim() };
    state.settings.video.priority = $("#set-vpriority").value;
    state.settings.video.enhance = $("#set-venhance").checked;
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
    saveVideoKeys();
    if (videoKey("gateway") !== gwBefore) loadVideoCatalog(true); else renderVideoControls();
    updateModelPill();
    updateKeyStatus();
    updateAutoPill();
    renderWelcomeStatus();
    refreshGithubStatus();

    // Make the GitHub repo configured here MAX's working repo, so it can read
    // and edit it right away (otherwise the tools stay off until you pick a repo
    // from the chip). This is the key link between "I added the token" and
    // "MAX can now read/edit the repo".
    if (state.settings.github.owner && state.settings.github.repo && providerHasToken("github")) {
      const desired = `${state.settings.github.owner}/${state.settings.github.repo}`;
      const cur = activeRepo();
      if (!cur || cur.provider !== "github" || cur.fullName !== desired) {
        bindRepoFromGithubSettings(false); // visible toast — the working repo changed
      } else if (cur.branch !== (state.settings.github.branch || "main")) {
        bindRepoFromGithubSettings(true);  // silent branch update
      }
    }

    if (providerReady()) $$(".toast--nudge").forEach((t) => t.remove());
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
    // Also delete from server
    fetch(`/api/conversations/${encodeURIComponent(id)}`, { method: "DELETE" }).catch(() => {});
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
    clearPendingEdits(); // don't carry staged edits across conversations/repos
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
    // paste images / files
    input.addEventListener("paste", (e) => {
      const items = [...(e.clipboardData?.items || [])];
      const files = items.filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean);
      if (files.length) { e.preventDefault(); handleFiles(files); }
    });

    $("#stop-btn").addEventListener("click", stopStreaming);

    // attachments
    $("#attach-btn").addEventListener("click", () => $("#file-input").click());
    $("#file-input").addEventListener("change", (e) => { handleFiles(e.target.files); e.target.value = ""; });
    $("#attachments").addEventListener("click", (e) => {
      const id = e.target.closest("[data-remove]")?.dataset.remove;
      if (id) { state.attachments = state.attachments.filter((a) => a.id !== id); renderAttachments(); }
    });
    // drag & drop anywhere in the window
    let dragDepth = 0;
    const isFileDrag = (e) => [...(e.dataTransfer?.types || [])].includes("Files");
    window.addEventListener("dragenter", (e) => { if (!isFileDrag(e)) return; e.preventDefault(); dragDepth++; document.body.classList.add("drag-over"); });
    window.addEventListener("dragover", (e) => { if (isFileDrag(e)) e.preventDefault(); });
    window.addEventListener("dragleave", () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove("drag-over"); });
    window.addEventListener("drop", (e) => {
      if (!isFileDrag(e)) return;
      e.preventDefault(); dragDepth = 0; document.body.classList.remove("drag-over");
      if (e.dataTransfer?.files?.length) handleFiles(e.dataTransfer.files);
    });

    // new chat
    $("#new-chat-btn").addEventListener("click", () => {
      if (state.streaming) return;
      // reuse an existing empty "New chat" if present at top
      const existingEmpty = state.conversations.find((c) => c.messages.length === 0);
      if (existingEmpty) { selectConversation(existingEmpty.id); }
      else { newConversation(); renderConversations(); renderMessages(); }
      updateModelPill();
      // Every new chat starts from a fresh view of your repos/connection.
      treeCache = null;
      refreshGithubStatus(true);
      if (activeRepo()) getTree(true).catch(() => {});
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
    $("#search-input").addEventListener("input", () => {
      clearTimeout(state._searchDebounce);
      state._searchDebounce = setTimeout(renderConversations, 200);
    });

    // suggestions + welcome categories
    $("#welcome-tabs")?.addEventListener("click", (e) => {
      const t = e.target.closest(".welcome-tab");
      if (t) renderSuggestions(t.dataset.cat);
    });
    $("#suggestions").addEventListener("click", (e) => {
      const btn = e.target.closest(".suggestion");
      if (!btn) return;
      const prompt = btn.dataset.prompt;
      if (prompt === "/summarize") { input.value = ""; summarizeRepo(); return; }
      if (prompt.startsWith("/video ")) {
        setVideoMode(true);
        input.value = prompt.slice(7); autoResize(input); updateCharCount(); updateSendState(); input.focus();
        if (/this photo|this image/i.test(prompt) && !currentVideoImage()) { toast("Attach a photo first (📎), then press Enter"); $("#file-input").click(); }
        return;
      }
      input.value = prompt; autoResize(input); updateCharCount(); updateSendState(); input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
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

    // model picker, effort panel, capability chips
    $("#model-pill").addEventListener("click", (e) => openModelPicker(e.currentTarget));
    $("#key-status").addEventListener("click", () => openSettings("providers"));
    $("#effort-pill").addEventListener("click", (e) => openEffortPanel(e.currentTarget));
    $("#cap-chips").addEventListener("click", (e) => {
      const chip = e.target.closest("[data-cap]");
      if (!chip) return;
      const cap = chip.dataset.cap;
      if (cap === "json") {
        state.settings.jsonMode = !state.settings.jsonMode; saveSettings(); renderCapChips();
        toast(state.settings.jsonMode ? "JSON mode ON — replies will be pure JSON" : "JSON mode off");
      } else if (cap === "reasoning") openEffortPanel($("#effort-pill").hidden ? chip : $("#effort-pill"));
      else if (cap === "vision") $("#file-input").click();
      else if (cap === "tools") { if (!activeRepo()) openRepoPicker($("#repo-chip")); else toast("Tools are on — MAX can read, edit & push this repo, and fetch web pages."); }
    });
    $("#branch-chip").addEventListener("click", (e) => openBranchPicker(e.currentTarget));
    // 🎬 Video mode, its option pills, and the video cards in the chat
    $("#video-toggle").addEventListener("click", () => {
      setVideoMode(!state.videoMode);
      toast(state.videoMode ? "🎬 Video mode on — your message becomes a video" : "Video mode off");
      $("#input").focus();
    });
    $("#video-controls").addEventListener("click", (e) => {
      const b = e.target.closest("[data-vc]");
      if (b && !b.disabled) onVideoControl(b.dataset.vc, b);
    });
    $("#messages").addEventListener("click", (e) => {
      const b = e.target.closest("[data-vact]");
      const card = b && b.closest(".vcard");
      if (card) { e.preventDefault(); handleVideoCardAction(b.dataset.vact, card, b); }
    });
    $$("[data-reveal]").forEach((b) => b.addEventListener("click", () => {
      const el = document.getElementById(b.dataset.reveal);
      if (el) el.type = el.type === "password" ? "text" : "password";
    }));
    $("#or-test").addEventListener("click", (e) => testVideoProvider("openrouter", e.currentTarget, $("#or-test-result")));
    $("#g-test").addEventListener("click", (e) => testVideoProvider("google", e.currentTarget, $("#g-test-result")));
    $("#gw-test").addEventListener("click", (e) => testVideoProvider("gateway", e.currentTarget, $("#gw-test-result")));
    document.addEventListener("visibilitychange", () => { if (!document.hidden && videoWatch.size) { clearTimeout(videoPollTimer); pollVideos(); } });
    $("#gh-status").addEventListener("click", () => { if (state.ghStatus?.error) openSettings(); else refreshGithubStatus(true).then(() => toast("GitHub connection refreshed", "success")); });
    $("#reveal-cckey").addEventListener("click", () => { const el = $("#set-cckey"); el.type = el.type === "password" ? "text" : "password"; });
    $("#cc-test").addEventListener("click", (e) => testProvider("codecraft", e.currentTarget, $("#cc-test-result")));
    $("#ar-test").addEventListener("click", (e) => testProvider("agentrouter", e.currentTarget, $("#ar-test-result")));
    $("#cc-models").addEventListener("click", (e) => refreshProviderModels("codecraft", e.currentTarget, $("#cc-test-result")));
    $("#ar-models").addEventListener("click", (e) => refreshProviderModels("agentrouter", e.currentTarget, $("#ar-test-result")));
    // Coming back to the tab → re-check GitHub (repos/branches may have changed).
    window.addEventListener("focus", () => { refreshGithubStatus(); if (treeCache) treeCache.at = 0; });

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
    $("#set-perf").addEventListener("change", (e) => { state.settings.perfMode = e.target.checked; applyPerfMode(); });
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

    // topbar: repository picker
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

    // file tree panel
    $("#tree-btn").addEventListener("click", openTreePanel);
    $("#tree-close").addEventListener("click", closeTreePanel);
    $("#tree-overlay").addEventListener("click", (e) => { if (e.target.id === "tree-overlay") closeTreePanel(); });

    // skills modal
    $("#skills-btn").addEventListener("click", openSkills);
    $("#skills-close").addEventListener("click", closeSkills);
    $("#skills-overlay").addEventListener("click", (e) => { if (e.target.id === "skills-overlay") closeSkills(); });
    $("#powers-search-input").addEventListener("input", renderPowers);
    $$(".powers-tab").forEach((t) => t.addEventListener("click", () => {
      powersScope = t.dataset.scope;
      $$(".powers-tab").forEach((x) => x.classList.toggle("active", x === t));
      renderPowers();
    }));

    // voice input + context basket + profiles
    $("#mic-btn").addEventListener("click", toggleVoice);
    $("#basket-chip").addEventListener("click", clearBasket);
    $("#changes-chip").addEventListener("click", () => { if (pendingCount()) openDiffModal(pendingEditsList()); });
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
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "m") { e.preventDefault(); openModelPicker($("#model-pill")); }
      if (e.key === "Escape") { closePop(); closeSettings(); closeRename(); closeRepoPicker(); closeFilesPicker(); closeMention(); closeSlash(); closePalette(); closePowers(); closeAdmin(); closeTreePanel(); closeSkills(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") { e.preventDefault(); openPalette(); }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") { e.preventDefault(); toggleFindBar(true); }
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); $("#new-chat-btn").click(); }
      if (e.key === "/" && !e.ctrlKey && !e.metaKey && document.activeElement === document.body) { e.preventDefault(); openShortcutsHelp(); }
      if ((e.metaKey || e.ctrlKey) && e.key === "?") { e.preventDefault(); openShortcutsHelp(); }
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

    // Merge any server-persisted conversations not in localStorage (e.g. after browser clear)
    await loadConvosFromServer();

    // fetch server config
    try {
      const res = await fetch("/api/config");
      if (res.ok) {
        const config = await res.json();
        state.config = {
          ...state.config,
          ...config,
          models: Array.isArray(config.models) && config.models.length ? config.models : DEFAULT_MODELS,
          providers: Array.isArray(config.providers) && config.providers.length ? config.providers : DEFAULT_PROVIDERS,
        };
      }
    } catch {
      toast("Could not reach the MAX server.", "error");
    }

    // Older versions stored only a model id (AgentRouter). Infer its provider.
    if (state.settings.model && !state.settings.aiProvider) {
      const hit = state.config.models.find((m) => m.id === state.settings.model);
      state.settings.aiProvider = hit ? hit.provider : "agentrouter";
      saveSettings();
    }
    applyPerfMode();

    state.videoCatalog.providers = state.config.video?.providers || [];
    state._chatPlaceholder = $("#input").placeholder;
    bindEvents();
    renderSuggestions("create");
    loadVideoCatalog();

    // sidebar default state on mobile
    if (window.innerWidth <= 820) setSidebarHidden(true);

    // ensure there is an active conversation reference (but don't force-create)
    if (state.activeId && !activeConvo()) state.activeId = state.conversations[0]?.id || null;

    // If GitHub is configured in Settings but no working repo is bound yet,
    // adopt it automatically so the read/edit tools are available on first use.
    if (!activeRepo()) bindRepoFromGithubSettings(true);

    renderAccount();
    updateModelPill();
    updateKeyStatus();
    updateAutoPill();
    updateRepoChip();
    renderWelcomeStatus();
    updateSkillsBadge();
    try {
      renderConversations();
      renderMessages();
    } catch (e) {
      console.error("Corrupted conversation state, resetting:", e);
      state.conversations = [];
      state.activeId = null;
      safeStorageSet(localStorage, LS.convos, "[]");
      renderConversations();
      renderMessages();
      toast("Chat history was corrupted and has been reset.", "error");
    }
    updateCharCount();
    updateSendState();
    updateUsagePill();
    renderBasket();
    renderChangesChip();

    // Register the service worker for installability + offline shell.
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/sw.js").catch(() => {});
    }

    refreshGithubStatus(true);
    resumeVideoTracking(); // videos still generating from earlier sessions
    ensureVideoTicker();

    // first-run nudge if the selected provider has no key
    if (!providerReady()) {
      setTimeout(() => { if (!providerReady()) toast(`Add your ${providerInfo(currentProvider()).label} key in Settings → AI providers to start chatting.`, "nudge"); }, 700);
    }
  }

  document.addEventListener("DOMContentLoaded", init);
})();
