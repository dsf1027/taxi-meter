// Offline support: the app shell is network-first (so updates show up) and falls back to the cache.
const CACHE = "taxi-meter-v2";
const SHELL = [
  "./", "index.html", "style.css", "app.js", "meter.js", "sim.js", "lcd.js", "horse.js",
  "manifest.webmanifest", "icons/icon.svg", "icons/icon-192.png", "icons/icon-512.png", "icons/icon-180.png",
];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (e) => {
  const req = e.request;
  if (req.method !== "GET" || new URL(req.url).origin !== location.origin) return;
  e.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok && res.status === 200) caches.open(CACHE).then((c) => c.put(req, res.clone()));
        return res;
      })
      .catch(() =>
        caches.match(req).then((hit) => {
          if (hit) return hit;
          // Only page loads may fall back to the app shell; other requests must fail honestly.
          return req.mode === "navigate" ? caches.match("index.html") : Response.error();
        })
      )
  );
});
