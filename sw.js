const CACHE_NAME = "iptv-hub-v23";
const APP_SHELL = [
  "./",
  "./index.html",
  "./css/styles.css",
  "./js/config.js",
  "./js/m3u-parser.js",
  "./js/xmltv-parser.js",
  "./js/xmltv-loader.js",
  "./js/epg.js",
  "./js/player.js",
  "./js/app.js",
  "./js/sports.js",
  "./manifest.webmanifest"
];

self.addEventListener("install", event => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(APP_SHELL.map(url => new Request(url, { cache: "reload" })))
    )
  );
});

self.addEventListener("activate", event => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(
        keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
      )
    )
  );
});

self.addEventListener("message", event => {
  if (event.data?.type === "SKIP_WAITING") self.skipWaiting();
});

self.addEventListener("fetch", event => {
  const request = event.request;

  // Media URLs can be extensionless or redirect. Never intercept external/media traffic.
  if (new URL(request.url).origin !== self.location.origin ||
      request.destination === "video" || request.destination === "audio" ||
      request.headers.has("range")) return;

  // Do not cache live IPTV/EPG requests by default.
  if (request.url.includes(".m3u") ||
      request.url.includes(".m3u8") ||
      request.url.includes(".xml") ||
      request.url.includes(".xml.gz")) {
    return;
  }

  event.respondWith(
    caches.match(request).then(cached => cached || fetch(request))
  );
});
