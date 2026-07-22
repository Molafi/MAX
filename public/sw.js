/* MAX service worker — installable app shell + offline static cache.
   Deliberately conservative: only GET, same-origin, non-API requests are cached.
   API calls (including the streaming /api/chat) always go straight to the network. */
const CACHE = "max-shell-v1";
const SHELL = ["/", "/index.html", "/styles.css", "/app.js", "/bg.js", "/favicon.svg", "/manifest.webmanifest"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return; // never intercept POSTs (chat/github/etc.)

  let url;
  try { url = new URL(req.url); } catch { return; }

  if (url.origin !== self.location.origin) return; // let CDN requests pass through
  if (url.pathname.startsWith("/api/")) return;    // never cache API responses

  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res && res.status === 200 && res.type === "basic") {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached || caches.match("/index.html"));
      return cached || network;
    })
  );
});
