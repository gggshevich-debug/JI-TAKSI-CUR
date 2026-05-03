/**
 * Локальный снимок активной поездки для мягкого UX без сети (localStorage).
 * Не заменяет сервер — только подсказка UI и последние известные координаты.
 */
(function () {
  const KEY = "ji_offline_trip_snapshot_v1";
  const MAX_AGE_MS = 1000 * 60 * 60 * 48;

  function save(snapshot) {
    if (!snapshot || snapshot.trip_id == null) return;
    try {
      const payload = {
        ...snapshot,
        savedAt: Date.now(),
      };
      localStorage.setItem(KEY, JSON.stringify(payload));
    } catch (e) {
      console.warn("[JITripOfflineCache] save", e);
    }
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const o = JSON.parse(raw);
      if (!o || o.savedAt == null) return null;
      if (Date.now() - o.savedAt > MAX_AGE_MS) {
        clear();
        return null;
      }
      return o;
    } catch {
      return null;
    }
  }

  function clear() {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  window.JITripOfflineCache = { save, load, clear };
})();
