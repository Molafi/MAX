# MAX Project Audit Report

## Summary

A comprehensive audit of the MAX Premium AI Chat application was conducted. The project is a zero-dependency Node.js server (~1900 lines) with a vanilla JavaScript frontend (~4300 lines). The audit identified **6 security vulnerabilities** (2 critical, 4 moderate), **4 bugs**, **3 performance issues**, and several areas for improvement.

**Critical issues have been fixed** in commits `7b4aaf6` and `60e798e`.

---

## Findings by Priority

### CRITICAL - Security Vulnerabilities (Fixed)

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 1 | **Path traversal in conversation GET endpoint** | server.js:540 | FIXED |
| 2 | **SSRF bypass via open redirect** | server.js:1670 | FIXED |

**Path Traversal (CVE-class)**: The `handleConversationGet` function accepted an unsanitized `id` parameter directly into `path.join(CONVOS_DIR, prefix + id + '.json')`. An attacker could read arbitrary `.json` files on disk with payloads like `../../.env` (though the `.json` extension limits impact). The save and delete handlers already had sanitization -- this was an oversight.

**SSRF via Redirect**: The web fetch power (`/api/powers/fetch`) checked `isBlockedHost()` only on the initial URL, then used `redirect: "follow"`. A malicious server could return a 302 redirect to `http://169.254.169.254/latest/meta-data/` (cloud metadata) or `http://127.0.0.1:PORT/api/admin/users` and the request would follow blindly.

### HIGH - Security Issues (Fixed)

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 3 | **Session cookies missing Secure flag** | server.js:488 | FIXED |
| 4 | **Session tokens cannot be revoked on logout** | server.js:664 | FIXED |
| 5 | **Permissions-Policy blocks voice input** | server.js:276 | FIXED |
| 6 | **User-generated content committed to git** | max-chats/ | FIXED |

### MEDIUM - Security Observations (Not Fixed - Documented)

| # | Issue | Notes |
|---|-------|-------|
| 7 | **No CSRF protection** | POST endpoints lack Origin/Referer validation. SameSite=Lax cookies mitigate cross-site POSTs but same-origin iframes or XSS could exploit this. |
| 8 | **File-based user store race condition** | Concurrent requests to saveUsers() can cause lost writes. Low risk for typical single-admin usage but problematic under load. |
| 9 | **Rate limiter easily bypassed** | In-memory Map clears on restart; IPv6 and proxy headers could allow circumvention. |
| 10 | **No password complexity enforcement** | Only minimum length (6 chars) is checked. No requirements for mixed case, digits, or special characters. |
| 11 | **Login attempts only throttled by IP** | An attacker with many IPs (botnet) is unthrottled. Consider per-account lockout. |

### BUGS (Fixed)

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 12 | **Streaming timer interval leak** | app.js toggleStreamingUI | FIXED |
| 13 | **LCS diff freezes browser on large files** | app.js diffLines | FIXED |
| 14 | **Corrupted localStorage crashes init** | app.js init() | FIXED |

### PERFORMANCE Issues (Partially Fixed)

| # | Issue | Location | Status |
|---|-------|----------|--------|
| 15 | **Sidebar search scans all messages on every keystroke** | app.js renderConversations | FIXED (debounced) |
| 16 | **All conversations loaded into memory at startup** | app.js loadState | Not fixed |
| 17 | **Full conversation list re-rendered on every touch** | app.js renderConversations | Not fixed |

---

## Architecture & Design Observations

### Positive Aspects
- Clean, readable code with good inline documentation
- Proper use of streaming (SSE piping with inactivity timeout)
- Good security headers (CSP, X-Frame-Options, HSTS-ready, X-Content-Type-Options)
- Proper HTML escaping via `esc()` function throughout the frontend
- Session tokens use timing-safe comparison
- Password hashing uses scrypt with random salts
- File uploads validated by type and size
- Graceful error handling on client disconnect during streaming
- The `uncaughtException` handler keeps the server alive

### Areas for Improvement (Recommendations)

#### Code Organization
1. **Monolithic files are difficult to maintain**: server.js (1900 lines) and app.js (4300 lines) each contain all logic. Consider splitting into modules (e.g., `routes/auth.js`, `routes/github.js`, `lib/rateLimit.js`).
2. **No separation of concerns on the frontend**: All state, rendering, networking, and business logic live in one IIFE. A minimal module system (even just ES modules with a bundler) would help.

#### Testing
3. **Zero test coverage**: The project has no tests at all. At minimum, add tests for:
   - `isValidMessage()` input validation
   - `sanitizeRepoPath()` path traversal prevention
   - `isBlockedHost()` SSRF guard
   - `hashPassword()` / `verifyPassword()` correctness
   - Session token sign/verify round-trip

#### Operational
4. **No logging to file**: All logs go to stdout. Consider structured logging with timestamps for production debugging.
5. **No graceful shutdown**: The server doesn't handle SIGTERM/SIGINT to close active connections cleanly before exiting.
6. **No health check for dependencies**: `/api/health` only reports uptime, not whether the upstream AI provider is reachable.
7. **In-memory state lost on restart**: Rate limit buckets, login attempt counters, and revoked tokens all reset on server restart.

#### Frontend UX
8. **CDN dependency for rendering**: Markdown (marked.js), syntax highlighting (highlight.js), and sanitization (DOMPurify) all load from cdn.jsdelivr.net. If the CDN is down or blocked, the entire rendering degrades to plain escaped text with no graceful indicator to the user.
9. **No loading indicator on initial page load**: The app shows nothing while fetching `/api/auth/me` and `/api/config`.
10. **localStorage quota not handled**: Large conversation histories could exceed the ~5-10MB browser quota with no user-facing warning beyond a generic toast.

#### Security Hardening (Beyond Fixes Applied)
11. **Add rate limiting to all API endpoints**: Currently only `/api/chat` is rate-limited. Admin endpoints, GitHub push, and conversation APIs are unprotected.
12. **Add Content-Length validation**: The `readBody` function has a 25MB limit, but this is very generous for most endpoints. Consider per-route limits.
13. **Implement CORS headers**: The server doesn't set CORS headers, which is fine for same-origin but makes the API unusable from other origins intentionally. Document this.
14. **Consider adding request IDs**: For debugging, add a unique request ID to each response and log it with errors.

---

## Changes Applied

### Commit `7b4aaf6` - Security & Critical Bug Fixes
- Path traversal fix in `handleConversationGet`
- SSRF redirect bypass fix (manual redirect following with host validation)
- Secure cookie flag when TRUST_PROXY is enabled
- Permissions-Policy allows microphone for self
- max-chats/ added to .gitignore
- Session token revocation on logout (in-memory deny list)

### Commit `60e798e` - Frontend Bug Fixes
- Streaming timer interval leak prevention
- LCS diff performance guard for files over 2000 lines
- Search input debouncing (200ms)
- Init function robustness with corrupted state recovery

---

## Risk Assessment

| Risk Level | Before Fixes | After Fixes |
|------------|-------------|-------------|
| Critical (RCE/Data Access) | 2 | 0 |
| High (Auth Bypass/SSRF) | 4 | 0 |
| Medium (Logic/Race) | 5 | 5 |
| Low (UX/Performance) | 6 | 3 |

The application is now significantly more secure for its intended use case (single-user or small-team local deployment). For internet-facing production deployment, the remaining medium-risk items (CSRF, race conditions, rate limiting gaps) should be addressed.
