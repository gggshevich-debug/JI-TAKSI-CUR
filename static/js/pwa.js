/**
 * PWA: SW (/sw.js), Web Push, установка, офлайн-бар, реконнект push.
 * Push / Notification — только после явного действия пользователя.
 * Вызов subscribePush: см. taxi.js (переход в «Свободен») и map.js (заказ такси).
 */
(function () {
  const SW_URL = "/sw.js";

  let deferredInstallPrompt = null;

  function _jiShowPwaInstallBtn(btn) {
    if (!btn) return;
    btn.hidden = false;
    btn.style.display = "flex";
  }

  function _jiHidePwaInstallBtn(btn) {
    if (!btn) return;
    btn.hidden = true;
    btn.style.display = "none";
  }

  /**
   * beforeinstallprompt часто уходит ДО DOMContentLoaded.
   * Слушатель должен быть зарегистрирован сразу при загрузке pwa.js.
   */
  window.addEventListener("beforeinstallprompt", (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    const btn = document.getElementById("pwa-install-app-btn");
    if (btn && !isStandaloneDisplayMode()) {
      _jiShowPwaInstallBtn(btn);
    }
  });

  window.addEventListener("appinstalled", () => {
    deferredInstallPrompt = null;
    _jiHidePwaInstallBtn(document.getElementById("pwa-install-app-btn"));
  });

  function urlBase64ToUint8Array(base64String) {
    const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
    const raw = atob(base64);
    const out = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
    return out;
  }

  /** iOS: Web Push только в установленной на Home Screen PWA (≈16.4+). В Safari-вкладке недоступен. */
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  }

  function isStandaloneDisplayMode() {
    return (
      window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true
    );
  }

  function isPushLikelySupported() {
    if (!("PushManager" in window)) return false;
    if (isIOS() && !isStandaloneDisplayMode()) return false;
    return true;
  }

  function showSwUpdateBanner(reg) {
    let el = document.getElementById("pwa-sw-update-bar");
    if (!el) {
      el = document.createElement("div");
      el.id = "pwa-sw-update-bar";
      el.setAttribute("role", "status");
      el.style.cssText =
        "position:fixed;bottom:12px;left:50%;transform:translateX(-50%);z-index:100002;" +
        "max-width:min(420px,92vw);padding:10px 14px;border-radius:10px;" +
        "background:#1a1a1a;color:#fff;font:14px/1.35 system-ui,sans-serif;" +
        "box-shadow:0 4px 20px rgba(0,0,0,.25);display:flex;gap:10px;align-items:center;flex-wrap:wrap;";
      document.body.appendChild(el);
    }
    el.innerHTML = "";
    const t = document.createElement("span");
    t.textContent = "Доступна новая версия приложения.";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Обновить";
    btn.style.cssText =
      "margin-left:auto;padding:6px 12px;border-radius:8px;border:none;" +
      "background:#22bc33;color:#fff;font-weight:600;cursor:pointer;";
    btn.addEventListener("click", () => {
      const w = reg.waiting;
      if (w) w.postMessage({ type: "SKIP_WAITING" });
      window.location.reload();
    });
    el.appendChild(t);
    el.appendChild(btn);
    el.hidden = false;
  }

  async function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) return null;
    try {
      const reg = await navigator.serviceWorker.register(SW_URL, { scope: "/" });
      reg.addEventListener("updatefound", () => {
        const nw = reg.installing;
        if (!nw) return;
        nw.addEventListener("statechange", () => {
          if (nw.state === "installed" && navigator.serviceWorker.controller) {
            console.log("[PWA] Доступна новая версия — можно обновить.");
            showSwUpdateBanner(reg);
          }
        });
      });
      return reg;
    } catch (e) {
      console.warn("[PWA] Service Worker:", e);
      return null;
    }
  }

  async function getVapidPublicKey() {
    const r = await fetch("/api/push/vapid-public-key", { credentials: "include" });
    if (!r.ok) throw new Error("VAPID");
    return r.json();
  }

  async function subscribePush(registration) {
    if (!("Notification" in window)) return { ok: false, reason: "no_notification_api" };
    if (!isPushLikelySupported()) {
      return { ok: false, reason: "ios_need_home_screen_or_unsupported" };
    }
    const cfg = await getVapidPublicKey();
    if (!cfg.enabled || !cfg.publicKey) return { ok: false, reason: "server_disabled" };

    const perm = await Notification.requestPermission();
    if (perm !== "granted") return { ok: false, reason: "permission", permission: perm };

    const reg = registration || (await navigator.serviceWorker.ready);
    const sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
    });

    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) {
      const t = await res.text();
      throw new Error(t || res.statusText);
    }
    return { ok: true, subscription: sub };
  }

  async function unsubscribePush(subscription) {
    const ep =
      subscription && typeof subscription.toJSON === "function"
        ? subscription.toJSON().endpoint
        : null;
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ep ? { endpoint: ep } : {}),
    });
    if (subscription && typeof subscription.unsubscribe === "function") {
      await subscription.unsubscribe();
    }
  }

  /**
   * Проверка подписки после смены SW / восстановления сети: если есть permission + подписка,
   * повторно отправляем на сервер (user_id только из сессии на бэкенде).
   */
  async function syncPushSubscriptionWithServer() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window)) return;
    if (Notification.permission !== "granted") return;
    const cfg = await getVapidPublicKey().catch(() => ({ enabled: false }));
    if (!cfg.enabled || !cfg.publicKey) return;

    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      try {
        sub = await reg.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(cfg.publicKey),
        });
      } catch (e) {
        console.warn("[PWA] syncPush resubscribe:", e);
        return;
      }
    }
    const res = await fetch("/api/push/subscribe", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(sub.toJSON()),
    });
    if (!res.ok) console.warn("[PWA] syncPush server:", await res.text());
  }

  function setupOfflineBar() {
    let bar = document.getElementById("pwa-offline-bar");
    if (!bar) {
      bar = document.createElement("div");
      bar.id = "pwa-offline-bar";
      bar.className = "pwa-offline-bar";
      bar.setAttribute("role", "status");
      document.body.appendChild(bar);
    }
    bar.textContent =
      "Нет сети. Показаны последние сохранённые данные поездки; после восстановления связи состояние обновится.";
    function apply() {
      if (!navigator.onLine) {
        bar.hidden = false;
        bar.classList.add("visible");
      } else {
        bar.classList.remove("visible");
        bar.hidden = true;
      }
    }
    window.addEventListener("online", () => {
      apply();
      syncPushSubscriptionWithServer().catch(() => {});
      try {
        window.taxiServices?._maybeResyncTrip?.();
      } catch (_) {
        /* ignore */
      }
    });
    window.addEventListener("offline", apply);
    apply();
  }

  function setupInstallUi() {
    const btn = document.getElementById("pwa-install-app-btn");
    if (!btn) return;

    if (isStandaloneDisplayMode()) {
      _jiHidePwaInstallBtn(btn);
      return;
    }
    if (deferredInstallPrompt) {
      _jiShowPwaInstallBtn(btn);
    }

    btn.addEventListener("click", async () => {
      if (!deferredInstallPrompt) {
        const ua = navigator.userAgent || "";
        const isAndroid = /Android/i.test(ua);
        const msg = isAndroid
          ? "Окно установки недоступно. Откройте меню Chrome (⋮) → «Установить приложение» или «Добавить на главный экран»."
          : "Установка через эту кнопку недоступна. Используйте меню браузера, чтобы добавить сайт на главный экран.";
        try {
          if (typeof window.showAppToast === "function") {
            window.showAppToast(msg, "info", 6500);
          } else {
            window.alert(msg);
          }
        } catch (_) {
          console.warn("[PWA]", msg);
        }
        return;
      }
      try {
        deferredInstallPrompt.prompt();
        await deferredInstallPrompt.userChoice.catch(() => {});
      } catch (err) {
        console.warn("[PWA] install prompt:", err);
        try {
          const m =
            "Не удалось открыть установку. Меню Chrome (⋮) → «Установить приложение».";
          if (typeof window.showAppToast === "function") {
            window.showAppToast(m, "warn", 6500);
          } else {
            window.alert(m);
          }
        } catch (_) {
          /* ignore */
        }
      } finally {
        deferredInstallPrompt = null;
        _jiHidePwaInstallBtn(btn);
      }
    });
  }

  /** Явный вызов из кнопки, если браузер не прислал beforeinstallprompt. */
  async function promptInstall() {
    if (!deferredInstallPrompt) return { ok: false, reason: "no_deferred_prompt" };
    deferredInstallPrompt.prompt();
    const r = await deferredInstallPrompt.userChoice.catch(() => ({ outcome: "dismissed" }));
    deferredInstallPrompt = null;
    return { ok: r && r.outcome === "accepted" };
  }

  navigator.serviceWorker?.addEventListener?.("controllerchange", () => {
    syncPushSubscriptionWithServer().catch(() => {});
    const bar = document.getElementById("pwa-sw-update-bar");
    if (bar) bar.hidden = true;
  });

  function setupBatteryLowHint() {
    const bat = navigator.getBattery;
    if (typeof bat !== "function") return;
    bat
      .call(navigator)
      .then((b) => {
        const apply = () => {
          const low = typeof b.level === "number" && b.level <= 0.2 && !b.charging;
          document.documentElement.dataset.jiBatteryLow = low ? "1" : "";
        };
        apply();
        b.addEventListener("levelchange", apply);
        b.addEventListener("chargingchange", apply);
      })
      .catch(() => {});
  }

  window.JIAppNet = {
    isOnline() {
      return typeof navigator === "undefined" ? true : navigator.onLine;
    },
    tripMutationBlockedMessage:
      "Нет сети. Смена состояния поездки и подтверждение недоступны; доступен просмотр последнего состояния.",
  };

  window.JIPWA = {
    registerServiceWorker,
    getVapidPublicKey,
    subscribePush,
    unsubscribePush,
    syncPushSubscriptionWithServer,
    promptInstall,
    isIOS,
    isStandaloneDisplayMode,
    isPushLikelySupported,
  };

  registerServiceWorker().then((reg) => {
    if (reg) {
      console.log("[PWA] SW:", SW_URL);
      syncPushSubscriptionWithServer().catch(() => {});
    }
  });

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", () => {
      setupOfflineBar();
      setupInstallUi();
      setupBatteryLowHint();
    });
  } else {
    setupOfflineBar();
    setupInstallUi();
    setupBatteryLowHint();
  }
})();
