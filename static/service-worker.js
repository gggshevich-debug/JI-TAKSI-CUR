/**
 * Service Worker (регистрация: /sw.js, scope /).
 *
 * Стратегии:
 * - /api/* (GET)    → сеть; при ошибке — JSON { offline: true } (503), кеш не пишем
 * - /socket.io*     → Network First
 * - /admin*         → Network First
 * - /static/*.js|.css → Stale-While-Revalidate
 * - остальной /static/* → Cache First (+ фоновое обновление)
 * - HTML-навигация  → Network First → кеш «/» → /static/offline.html
 *
 * При деплое: увеличьте CACHE_VERSION — старые кеши удалятся в activate.
 */
const CACHE_VERSION = "20260417";
const CACHE_NAMES = {
  precache: `ji-precache-${CACHE_VERSION}`,
  static: `ji-static-${CACHE_VERSION}`,
  swr: `ji-swr-${CACHE_VERSION}`,
};

const PRECACHE_URLS = [
  "/",
  "/static/offline.html",
  "/static/manifest.json",
  "/static/css/main.css",
  "/static/js/tripEnums.js",
  "/static/js/trip-rating-shared.js",
  "/static/js/trip-offline-cache.js",
  "/static/js/map.js",
  "/static/js/services.js",
  "/static/js/services-adapter.js",
  "/static/js/taxi.js",
  "/static/js/controllers.js",
  "/static/js/pwa.js",
  "/static/js/main.js",
  "/static/js/registration-client.js",
  "/static/js/registration-taxi.js",
  "/static/js/login.js",
  "/static/js/leaflet.rotatedMarker.js",
  "/static/images/logo.png",
  "/static/images/pwa-icons/pwa-icon-192.png",
  "/static/images/pwa-icons/pwa-icon-512.png",
];

function isSocketPath(pathname) {
  return pathname.startsWith("/socket.io");
}

function isAdminPath(pathname) {
  return pathname.startsWith("/admin");
}

function isApiPath(pathname) {
  return pathname.startsWith("/api/");
}

function isStaticJsOrCss(pathname) {
  if (!pathname.startsWith("/static/")) return false;
  return pathname.endsWith(".js") || pathname.endsWith(".css");
}

/** Админка: не кешировать в SWR — иначе после деплоя долго жить старый admin.js без новых полей тарифов. */
function isAdminPanelStatic(pathname) {
  return pathname.startsWith("/static/admin/");
}

function isStaticAsset(pathname) {
  return pathname.startsWith("/static/");
}

function sameOrigin(url) {
  try {
    return new URL(url).origin === self.location.origin;
  } catch {
    return false;
  }
}

/** Network First: сеть → при ошибке optional fallback из кеша. */
async function networkFirst(request, { cacheName = null } = {}) {
  try {
    const res = await fetch(request);
    return res;
  } catch (err) {
    if (cacheName) {
      const cache = await caches.open(cacheName);
      const hit = await cache.match(request);
      if (hit) return hit;
    }
    throw err;
  }
}

/** GET /api/*: при сетевой ошибке — JSON вместо «падения» страницы. */
async function apiNetworkFirstStructured(request) {
  try {
    return await fetch(request);
  } catch {
    const body = JSON.stringify({
      offline: true,
      network: false,
      success: false,
      message: "Нет сети. Запрос не выполнен (Service Worker).",
    });
    return new Response(body, {
      status: 503,
      statusText: "Service Unavailable",
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }
}

self.addEventListener("message", (event) => {
  const d = event.data;
  if (d === "SKIP_WAITING" || (d && d.type === "SKIP_WAITING")) {
    self.skipWaiting();
  }
});

/** Cache First: кеш → сеть; при успехе сети — обновить кеш. */
async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const fetchAndStore = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  if (cached) {
    fetchAndStore.catch(() => {});
    return cached;
  }
  const net = await fetchAndStore;
  if (net) return net;
  return Response.error();
}

/** Stale-While-Revalidate: сразу кеш, параллельно сеть обновляет кеш. */
async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((res) => {
      if (res.ok) cache.put(request, res.clone()).catch(() => {});
      return res;
    })
    .catch(() => null);

  if (cached) {
    networkPromise.catch(() => {});
    return cached;
  }
  const net = await networkPromise;
  if (net) return net;
  return Response.error();
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(CACHE_NAMES.precache);
      await Promise.all(
        PRECACHE_URLS.map((url) => cache.add(url).catch(() => {}))
      );
    })()
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keep = new Set(Object.values(CACHE_NAMES));
      const keys = await caches.keys();
      await Promise.all(
        keys.map((k) => {
          if (k.startsWith("ji-") && !keep.has(k)) return caches.delete(k);
          if (k === "taksi-cache-v1" || (k.startsWith("static-") && !keep.has(k)))
            return caches.delete(k);
          return Promise.resolve();
        })
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (!sameOrigin(req.url)) return;

  const path = url.pathname;

  if (isApiPath(path)) {
    event.respondWith(apiNetworkFirstStructured(req));
    return;
  }
  if (isSocketPath(path) || isAdminPath(path)) {
    event.respondWith(networkFirst(req));
    return;
  }

  if (isAdminPanelStatic(path)) {
    event.respondWith(fetch(req));
    return;
  }

  if (req.mode === "navigate" || req.headers.get("Accept")?.includes("text/html")) {
    event.respondWith(
      (async () => {
        try {
          const net = await fetch(req);
          if (net.ok) {
            const c = await caches.open(CACHE_NAMES.precache);
            c.put(new Request("/"), net.clone()).catch(() => {});
          }
          return net;
        } catch {
          const precache = await caches.open(CACHE_NAMES.precache);
          const shell = await precache.match("/");
          if (shell) return shell;
          return (await caches.match("/static/offline.html")) || Response.error();
        }
      })()
    );
    return;
  }

  if (isStaticJsOrCss(path)) {
    event.respondWith(staleWhileRevalidate(req, CACHE_NAMES.swr));
    return;
  }

  if (isStaticAsset(path)) {
    event.respondWith(cacheFirst(req, CACHE_NAMES.static));
    return;
  }

  event.respondWith(
    (async () => {
      try {
        return await fetch(req);
      } catch {
        return (await caches.match(req)) || Response.error();
      }
    })()
  );
});

/** Push: tag группирует уведомления (одинаковый tag заменяет предыдущее). */
self.addEventListener("push", (event) => {
  let data = { title: "JI Taksi", body: "", tag: "ji-general", url: "/" };
  if (event.data) {
    try {
      data = { ...data, ...event.data.json() };
    } catch {
      data.body = event.data.text() || "";
    }
  }
  const title = data.title || "JI Taksi";
  const tripId =
    data.trip_id != null && data.trip_id !== ""
      ? String(data.trip_id)
      : null;
  const tag =
    tripId != null ? `ji-trip-${tripId}` : data.tag || "ji-general";
  const options = {
    body: data.body || "",
    icon: "/static/images/pwa-icons/pwa-icon-192.png",
    badge: "/static/images/logo.png",
    tag,
    data: { url: data.url || "/", tag, trip_id: tripId },
    vibrate: data.vibrate || [80],
    lang: data.lang || "ru",
  };
  if (data.subtitle != null && String(data.subtitle).trim()) {
    options.subtitle = String(data.subtitle).trim();
  }
  if (data.renotify === true) options.renotify = true;
  event.waitUntil(
    (async () => {
      try {
        await self.registration.showNotification(title, options);
      } catch (e) {
        // Часть браузеров не знает поле subtitle — повтор без него.
        if ("subtitle" in options) {
          try {
            delete options.subtitle;
            await self.registration.showNotification(title, options);
          } catch (e2) {
            console.warn("[sw] showNotification", e2);
          }
        } else {
          console.warn("[sw] showNotification", e);
        }
      }
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const raw = event.notification.data?.url || "/";
  const full = new URL(raw, self.location.origin).href;
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if (c.url && "focus" in c) {
          return c.focus().then(() => {
            if ("navigate" in c && typeof c.navigate === "function") {
              try {
                return c.navigate(full);
              } catch {
                /* Safari */
              }
            }
          });
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(full);
    })
  );
});
