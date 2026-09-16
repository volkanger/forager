// Minimal service worker for the chat PWA: enough to make /chat installable and
// to open offline. It never touches the API — /v1/*, /api/* and /admin/* always
// go to the network, so no chat reply or usage figure is ever served from cache.
const CACHE = "forager-shell-v1";
const SHELL = ["/chat", "/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-180.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // fonts etc. keep the browser's own cache
  if (/^\/(v1|api|admin|health)\b/.test(url.pathname)) return;

  // The chat page: network first so a deploy shows up immediately, cache only as
  // a fallback. Other pages (/, /dashboard) are left alone so they can't end up
  // stored as the chat shell.
  if (request.mode === "navigate") {
    if (!/^\/chat(\.html)?\/?$/.test(url.pathname)) return;
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/chat", copy));
          return response;
        })
        .catch(() => caches.match("/chat").then((hit) => hit || Response.error())),
    );
    return;
  }

  // Static assets: cache first, fill the cache on the way past.
  event.respondWith(
    caches.match(request).then((hit) =>
      hit ||
      fetch(request).then((response) => {
        if (response.ok && response.type === "basic") {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      }),
    ),
  );
});
