/* ============================================================
   MAX — login page logic
   Kept in a separate file (not inline) so it runs under the app's
   strict Content-Security-Policy (script-src 'self'). An inline
   <script> would be blocked, which would silently break sign-in.
   ============================================================ */
(function () {
  "use strict";
  const form = document.getElementById("login-form");
  const errEl = document.getElementById("login-error");
  const btn = document.getElementById("login-btn");
  if (!form) return;

  // If already signed in, go straight to the app.
  fetch("/api/auth/me").then((r) => { if (r.ok) location.replace("/"); }).catch(() => {});

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errEl.textContent = "";
    btn.disabled = true; btn.textContent = "Signing in…";
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: document.getElementById("username").value.trim(),
          password: document.getElementById("password").value,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error((data && data.error && data.error.message) || "Sign in failed.");
      location.replace("/");
    } catch (err) {
      errEl.textContent = err.message;
      btn.disabled = false; btn.textContent = "Sign in";
    }
  });
})();
