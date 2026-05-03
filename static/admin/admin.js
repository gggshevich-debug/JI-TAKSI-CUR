(function () {
  const LS = "ji_admin_jwt";
  let token = localStorage.getItem(LS);
  let map = null;
  let layerDrivers = null;
  let layerClients = null;
  let layerRoutes = null;
  let heatLayer = null;
  const markers = new Map();
  let socket = null;
  const onlineDrivers = new Set();
  const onlineClients = new Set();
  let didInitialMapFit = false;
  let mapPrefsApplied = false;
  let dashTimer = null;
  let chartTrips = null;
  let chartVer = null;
  let chart7d = null;
  let chartCompleted7d = null;
  let chartRev7d = null;
  let chartRefusals = null;
  let chartReg7d = null;
  /** object URL для превью в #doc-modal; освобождать при закрытии. */
  let docPreviewBlobUrl = null;
  /** async () => void — вызов после подтверждения удаления в модалке. */
  let deleteConfirmAction = null;
  let routeRefreshTimer = null;
  const PREFS_KEY = "ji_admin_prefs";

  function getPrefs() {
    try {
      return JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    } catch (e) {
      return {};
    }
  }
  function setPrefs(p) {
    localStorage.setItem(PREFS_KEY, JSON.stringify(p));
  }
  function applyPrefsToUI() {
    const p = getPrefs();
    if ($("#set-dark-mode")) $("#set-dark-mode").checked = !!p.darkMode;
    if ($("#set-auto-dash")) $("#set-auto-dash").checked = !!p.autoDash;
    if ($("#set-dash-interval")) $("#set-dash-interval").value = String(p.dashInterval || 30);
    if ($("#set-def-heat")) $("#set-def-heat").checked = !!p.defaultHeatmap;
    if ($("#set-def-routes")) $("#set-def-routes").checked = !!p.defaultRoutes;
    if ($("#set-compact")) $("#set-compact").checked = !!p.compactTables;
    if ($("#set-toast")) $("#set-toast").checked = !!p.mapToast;
    if ($("#set-sound")) $("#set-sound").checked = !!p.soundTrip;
    if ($("#set-heat-rainbow")) $("#set-heat-rainbow").checked = p.heatmapRainbow !== false;
    if ($("#set-heat-radius")) $("#set-heat-radius").value = String(p.heatmapRadius || 56);
    if ($("#set-heat-blur")) $("#set-heat-blur").value = String(p.heatmapBlur || 32);
    document.body.classList.toggle("compact-tables", !!p.compactTables);
    document.body.classList.toggle("dark-mode", !!p.darkMode);
  }

  /** Те же тайлы и центр, что у клиента/водителя (static/js/map.js — APP_CONFIG.map). */
  const ADMIN_MAP = {
    defaultView: [41.641219, 48.441872],
    defaultZoom: 15,
    defaultMaxZoom: 20,
    tileLayer:
      "https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png",
    tileLayerOptions: {
      attribution: "&copy; OpenStreetMap &copy; CARTO",
      subdomains: "abcd",
      maxZoom: 20,
    },
  };

  const ADMIN_ICONS = {
    taxi: {
      iconUrl: "/static/images/marker-icon-taxi.svg",
      iconSize: [36, 36],
      iconAnchor: [18, 18],
      popupAnchor: [0, -28],
    },
    client: {
      iconUrl: "/static/images/marker-icon-A.svg",
      iconSize: [40, 40],
      iconAnchor: [16, 32],
      popupAnchor: [0, -32],
    },
  };

  const $ = (sel) => document.querySelector(sel);

  function esc(s) {
    if (s == null) return "";
    return String(s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escAttr(s) {
    if (s == null) return "";
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  }

  /** Иконка + кратко экран/язык в карточках списков. */
  function adminDeviceIconsCell(rec) {
    if (!rec) return "";
    const plat = String(rec.device_platform || "").toLowerCase().trim();
    const scr = rec.device_screen ? String(rec.device_screen).trim() : "";
    const lang = rec.device_lang ? String(rec.device_lang).trim() : "";
    if (!plat && !scr && !lang) return "";
    let br = "fa-solid";
    let ic = "fa-mobile-screen";
    let titlePlat = plat || "устройство";
    if (plat === "ios") {
      br = "fa-brands";
      ic = "fa-apple";
      titlePlat = "iOS";
    } else if (plat === "android") {
      br = "fa-brands";
      ic = "fa-android";
      titlePlat = "Android";
    } else if (plat === "web") {
      ic = "fa-globe";
      titlePlat = "Web";
    }
    const title = [titlePlat, scr && "Экран: " + scr, lang && "Язык: " + lang].filter(Boolean).join(" · ");
    return (
      '<span class="m-item admin-dev-ico-cell" title="' +
      escAttr(title) +
      '"><i class="' +
      br +
      " " +
      ic +
      '" aria-hidden="true"></i>' +
      (scr ? '<span class="admin-dev-sc">' + esc(scr) + "</span>" : "") +
      (lang ? ' <i class="fa-solid fa-language" aria-hidden="true" title="' + escAttr(lang) + '"></i>' : "") +
      "</span>"
    );
  }

  function formatAdminDeviceStrip(one) {
    if (!one) return "";
    const p = String(one.device_platform || "").toLowerCase();
    const lab = p === "ios" ? "iOS" : p === "android" ? "Android" : p === "web" ? "Web" : p ? p : "—";
    const scr = one.device_screen || "—";
    const lang = one.device_lang || "—";
    if (lab === "—" && scr === "—" && lang === "—") return "";
    return "Устройство: " + lab + " · Экран: " + scr + " · Язык: " + lang;
  }

  function formatAcceptRate(v) {
    if (v == null || v === "") return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return "—";
    // acceptance_rate хранится как 0..1
    const pct = Math.max(0, Math.min(1, n)) * 100;
    return pct.toFixed(pct >= 10 ? 1 : 2) + "%";
  }

  function formatMoneyAzN(v) {
    if (v == null || v === "") return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return String(v);
    return n.toFixed(2) + " ₼";
  }

  function formatAdminTripKm(v) {
    if (v == null || v === "") return "—";
    const n = Number(v);
    if (!Number.isFinite(n)) return esc(String(v));
    const abs = Math.abs(n);
    const dec = abs >= 100 ? 1 : abs >= 10 ? 2 : 3;
    return esc(n.toFixed(dec));
  }

  function tripMetaRow(label, valueHtml, opts) {
    const o = opts || {};
    const cls = o.className ? " " + o.className : "";
    return (
      '<div class="trip-meta-row' +
      cls +
      '">' +
      '<div class="trip-meta-k">' +
      esc(label) +
      "</div>" +
      '<div class="trip-meta-v">' +
      valueHtml +
      "</div></div>"
    );
  }

  function tripMetaPerson(kind, name, id) {
    const title = kind === "driver" ? "Водитель" : "Клиент";
    const nm = esc((name || "").trim() || "—");
    const idTxt = id != null && String(id).trim() !== "" ? esc(String(id)) : "—";
    return (
      '<div class="trip-meta-person trip-meta-person--' +
      esc(kind) +
      '">' +
      '<div class="trip-meta-person-title">' +
      esc(title) +
      "</div>" +
      '<div class="trip-meta-person-name">' +
      nm +
      "</div>" +
      '<div class="trip-meta-person-id muted mono">ID ' +
      idTxt +
      "</div></div>"
    );
  }

  const REFUSAL_REASON_LABELS = {
    client_cancel_while_searching: "Клиент отменил поиск",
    driver_release_awaiting_client: "Водитель отменил ожидание клиента",
    driver_cancelled: "Водитель отменил поездку",
    client_cancelled: "Клиент отменил поездку",
  };

  const REFUSAL_TYPE_LABELS = {
    radio: "",
    custom: "Комментарий",
    system: "Система",
  };

  function formatAdminRefusalLine(raw) {
    if (raw == null || raw === "") return "";
    const s = String(raw).trim();
    if (!s) return "";
    // Ожидаемый формат из БД/сервера: "radio: client_cancel_while_searching" или просто reason_text
    const m = s.match(/^\s*([a-z_]+)\s*:\s*(.+?)\s*$/i);
    if (!m) {
      return s;
    }
    const code = String(m[2] || "").trim();
    const rLabel = REFUSAL_REASON_LABELS[code] || code;
    // В карточке поездки уже есть "Отмена:", тут оставляем только понятный текст причины.
    return rLabel;
  }

  /** ISO / Postgres timestamp → «12.04.2026 03:04:04» (локальное время браузера при разборе Date). */
  function formatAdminDatetime(raw) {
    if (raw == null || raw === "") return "—";
    const s = String(raw).trim();
    if (s === "—") return "—";
    const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2}):(\d{2})/);
    if (m) return m[3] + "." + m[2] + "." + m[1] + " " + m[4] + ":" + m[5] + ":" + m[6];
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) {
      const pad = (n) => String(n).padStart(2, "0");
      return (
        pad(d.getDate()) +
        "." +
        pad(d.getMonth() + 1) +
        "." +
        d.getFullYear() +
        " " +
        pad(d.getHours()) +
        ":" +
        pad(d.getMinutes()) +
        ":" +
        pad(d.getSeconds())
      );
    }
    return s;
  }

  /** Для выводов: «22.04 20:19:58» (день.месяц + время, локаль браузера). */
  function formatWithdrawalShort(raw) {
    if (raw == null || raw === "") return "—";
    const d = new Date(String(raw).trim());
    if (Number.isNaN(d.getTime())) return formatAdminDatetime(raw);
    const pad = (n) => String(n).padStart(2, "0");
    return (
      pad(d.getDate()) +
      "." +
      pad(d.getMonth() + 1) +
      " " +
      pad(d.getHours()) +
      ":" +
      pad(d.getMinutes()) +
      ":" +
      pad(d.getSeconds())
    );
  }

  function ruPluralAbs(n, one, few, many) {
    const nAbs = Math.floor(Math.abs(Number(n)) || 0);
    const n10 = nAbs % 10;
    const n100 = nAbs % 100;
    if (n100 >= 11 && n100 <= 14) return many;
    if (n10 === 1) return one;
    if (n10 >= 2 && n10 <= 4) return few;
    return many;
  }

  /**
   * Текст «последнее в сети» для карточек админки.
   * Онлайн — отдельная строка; иначе «Был/а в сети: …» с днями/часами/мин. (мин. с точкой, часы с точкой после слова, как в ТЗ).
   */
  function formatLastSeenLabel(rawIso, isOnline) {
    if (isOnline) {
      return { text: "Сейчас в сети", cls: "admin-last-seen--live" };
    }
    if (rawIso == null || rawIso === "") {
      return { text: "Был/а в сети: нет данных", cls: "admin-last-seen--na" };
    }
    const t = new Date(rawIso).getTime();
    if (Number.isNaN(t)) {
      return { text: "Был/а в сети: нет данных", cls: "admin-last-seen--na" };
    }
    const diffMs = Date.now() - t;
    if (diffMs < 0 || diffMs < 45000) {
      return { text: "Был/а в сети: только что", cls: "admin-last-seen--recent" };
    }
    const sec = Math.floor(diffMs / 1000);
    const days = Math.floor(sec / 86400);
    const rem = sec % 86400;
    const hours = Math.floor(rem / 3600);
    const mins = Math.floor((rem % 3600) / 60);
    const parts = [];
    if (days > 0) {
      parts.push(days + " " + ruPluralAbs(days, "день", "дня", "дней"));
    }
    if (hours > 0) {
      parts.push(hours + " " + ruPluralAbs(hours, "час", "часа", "часов") + ".");
    }
    if (mins > 0) {
      parts.push(mins + " мин.");
    }
    if (parts.length === 0) {
      return { text: "Был/а в сети: только что", cls: "admin-last-seen--recent" };
    }
    return { text: "Был/а в сети: " + parts.join(" ") + " назад", cls: "admin-last-seen--ago" };
  }

  function lastSeenRowHtml(lastSeenAt, isOnline) {
    const ls = formatLastSeenLabel(lastSeenAt, isOnline);
    return (
      '<div class="admin-last-seen-row ' +
      ls.cls +
      '" title="Последняя активность по Socket (подключение и сообщения приложения)">' +
      '<i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i><span>' +
      esc(ls.text) +
      "</span></div>"
    );
  }

  function unwrapQuotedJsonString(s) {
    let t = s.trim().replace(/^\uFEFF/, "");
    for (let i = 0; i < 3 && t.length >= 2; i++) {
      const q = t[0];
      if ((q === '"' || q === "'") && t[t.length - 1] === q) {
        try {
          const parsed = JSON.parse(t);
          if (typeof parsed === "string") {
            t = parsed.trim();
            continue;
          }
        } catch (e) {
          t = t.slice(1, -1).trim();
          continue;
        }
      }
      break;
    }
    return t;
  }

  function extractBase64Payload(s) {
    if (s == null) return "";
    let t = unwrapQuotedJsonString(String(s));
    const low = t.toLowerCase();
    const mark = ";base64,";
    const idx = low.lastIndexOf(mark);
    if (idx >= 0) t = t.slice(idx + mark.length);
    return normalizeBase64Payload(t);
  }

  function base64ToUint8Array(b64) {
    const b = normalizeBase64Payload(String(b64 || ""));
    if (!b) return new Uint8Array(0);
    const padLen = (4 - (b.length % 4)) % 4;
    const padded = b + (padLen ? "=".repeat(padLen) : "");
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function sniffMimeFromBytes(u8) {
    if (!u8 || u8.length < 2) return "image/png";
    const u = (i) => u8[i];
    if (u8.length >= 2 && u(0) === 0xff && u(1) === 0xd8) return "image/jpeg";
    if (u8.length >= 4 && u(0) === 0x89 && u(1) === 0x50 && u(2) === 0x4e && u(3) === 0x47) return "image/png";
    if (u8.length >= 3 && u(0) === 0x47 && u(1) === 0x49 && u(2) === 0x46) return "image/gif";
    if (
      u8.length >= 12 &&
      u(0) === 0x52 &&
      u(1) === 0x49 &&
      u(2) === 0x46 &&
      u(3) === 0x46 &&
      u(8) === 0x57 &&
      u(9) === 0x45 &&
      u(10) === 0x42 &&
      u(11) === 0x50
    ) {
      return "image/webp";
    }
    if (u8.length >= 12 && u(4) === 0x66 && u(5) === 0x74 && u(6) === 0x79 && u(7) === 0x70) {
      const br4 = String.fromCharCode(u(8), u(9), u(10), u(11));
      if (/^(heic|heix|hevc|hevx|mif1|msf1)/i.test(br4)) return "image/heic";
      if (/^avif|^avis/i.test(br4)) return "image/avif";
      if (/^webp/i.test(br4)) return "image/webp";
    }
    return "image/png";
  }

  function sniffImageMimeFromBase64(b64In) {
    const payload = extractBase64Payload(b64In);
    if (payload.length < 8) return "image/png";
    const padLen = (4 - (payload.length % 4)) % 4;
    const padded = payload + (padLen ? "=".repeat(padLen) : "");
    try {
      const needB64 = 48;
      const slice = padded.slice(0, Math.min(padded.length, needB64));
      const bin = atob(slice);
      const n = Math.min(bin.length, 64);
      const u8 = new Uint8Array(n);
      for (let i = 0; i < n; i++) u8[i] = bin.charCodeAt(i);
      return sniffMimeFromBytes(u8);
    } catch (e) {
      return "image/png";
    }
  }

  /** Убирает невидимые символы и всё, что не входит в алфавит base64. */
  function normalizeBase64Payload(s) {
    return String(s)
      .replace(/\s/g, "")
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .replace(/[^A-Za-z0-9+/=_-]/g, "")
      .replace(/-/g, "+")
      .replace(/_/g, "/");
  }

  /** Мин. длина «голого» base64 без префикса data: — иначе номера ПТС/ВУ после strip символов ошибочно становятся «картинкой». */
  const MIN_BARE_BASE64_CHARS = 80;

  /**
   * Типичный номер техпаспорта / ВУ (как при регистрации), без префикса data: — не base64.
   */
  function looksLikeTechOrLicenseNumber(s) {
    const t = String(s || "").trim();
    if (!t) return false;
    return /^[A-Z]{2}\s*№?\s*\d{6}$/i.test(t);
  }

  /**
   * URL, data:image с непустым payload или «голый» base64 (в т.ч. URL-safe).
   * Поддержка data:image/...;charset=...;base64, и «ломаных» строк из БД.
   */
  function toImageSrc(raw) {
    if (raw == null) return "";
    let s = unwrapQuotedJsonString(String(raw));
    if (!s) return "";
    if (looksLikeTechOrLicenseNumber(s)) return "";
    if (/^https?:\/\//i.test(s)) return s;
    // «Голый» JPEG-base64 начинается с "/9j/" — не считать это путём вида /static/...
    if (s.startsWith("/")) {
      const peek = normalizeBase64Payload(s);
      const isBareJpegBase64 =
        peek.startsWith("/9j/") && peek.length >= MIN_BARE_BASE64_CHARS;
      if (!isBareJpegBase64) return s;
    }

    const lower = s.toLowerCase();
    const b64Mark = ";base64,";
    const idx = lower.lastIndexOf(b64Mark);
    if (idx >= 0 && lower.startsWith("data:image/")) {
      let payload = s.slice(idx + b64Mark.length);
      payload = normalizeBase64Payload(payload);
      if (payload.length < 8) return "";
      const meta = s.slice(0, idx);
      const mimeM = meta.match(/data:(image\/[a-z0-9+.-]+)/i);
      const declared = mimeM ? mimeM[1].toLowerCase() : null;
      const sniffed = sniffImageMimeFromBase64(payload);
      const mime = sniffed !== "image/png" ? sniffed : declared || "image/png";
      return "data:" + mime + ";base64," + payload;
    }

    const dataM = s.match(/^data:image\/([a-z0-9+.-]+);base64,(.*)$/i);
    if (dataM) {
      let payload = normalizeBase64Payload(dataM[2] || "");
      if (payload.length < 8) return "";
      return "data:image/" + String(dataM[1]).toLowerCase() + ";base64," + payload;
    }

    let b = normalizeBase64Payload(s);
    if (b.length < MIN_BARE_BASE64_CHARS) return "";
    if (!/^[A-Za-z0-9+/=]+$/.test(b)) return "";
    const mime = sniffImageMimeFromBase64(b);
    return "data:" + mime + ";base64," + b;
  }

  function imgDataUrl(raw) {
    return toImageSrc(raw);
  }

  const DOC_LABELS = {
    tech_pass: "ПТС (номер)",
    license: "Водительское удостоверение",
    car: "Фото автомобиля",
    license_ph: "Фото ВУ",
    tech_ph: "Фото ПТС",
    face: "Фото лица",
  };

  function looksLikeImgUrl(u) {
    if (!u || typeof u !== "string") return false;
    if (/^data:image\//i.test(u)) return true;
    return /\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i.test(u);
  }

  function shouldShowAsImage(val) {
    if (val == null || val === "") return false;
    const v = unwrapQuotedJsonString(String(val));
    if (!v) return false;
    if (toImageSrc(v)) return true;
    if (/^https?:\/\//i.test(v) && /\.(jpe?g|png|gif|webp|bmp)(\?|#|$)/i.test(v)) return true;
    return false;
  }

  function closeDocModal() {
    if (docPreviewBlobUrl) {
      try {
        URL.revokeObjectURL(docPreviewBlobUrl);
      } catch (e) {}
      docPreviewBlobUrl = null;
    }
    const m = $("#doc-modal");
    if (m) m.classList.add("hidden");
  }

  function closeAdminEditModal() {
    const m = $("#admin-edit-modal");
    if (m) m.classList.add("hidden");
    const ds = $("#admin-edit-device-strip");
    if (ds) ds.textContent = "";
  }

  function closeDeleteConfirmModal() {
    deleteConfirmAction = null;
    const m = $("#delete-confirm-modal");
    if (m) m.classList.add("hidden");
  }

  function openDeleteConfirmModal(title, message, onConfirm) {
    const ht = $("#delete-confirm-title");
    const tx = $("#delete-confirm-text");
    const m = $("#delete-confirm-modal");
    if (!ht || !tx || !m) return;
    ht.textContent = title || "Подтверждение";
    tx.innerHTML = message || "";
    deleteConfirmAction = typeof onConfirm === "function" ? onConfirm : null;
    m.classList.remove("hidden");
  }

  function fillNumInput(sel, val) {
    const el = typeof sel === "string" ? $(sel) : sel;
    if (!el) return;
    const n = Number(val);
    el.value = val != null && val !== "" && Number.isFinite(n) ? String(val) : "";
  }

  function normVerification(v) {
    const x = (v || "pending").toString().toLowerCase().trim();
    if (x === "verified") return "verified";
    if (x === "refused") return "refused";
    return "pending";
  }

  async function openAdminEditDriver(driverId) {
    const one = await api("/admin/drivers/" + driverId);
    const tid = $("#admin-edit-type");
    const iid = $("#admin-edit-id");
    const title = $("#admin-edit-title");
    if (!tid || !iid || !title) return;
    tid.value = "driver";
    iid.value = String(driverId);
    title.innerHTML = "Водитель <b>ID:</b> " + esc(String(driverId));
    const dst = $("#admin-edit-device-strip");
    if (dst) dst.textContent = formatAdminDeviceStrip(one);
    $("#edit-d-name").value = one.name || "";
    $("#edit-d-surname").value = one.surname || "";
    $("#edit-d-phone").value = one.phone || "";
    $("#edit-d-email").value = one.email || "";
    $("#edit-d-car-name").value = one.car_name || "";
    $("#edit-d-car-number").value = one.car_number || "";
    $("#edit-d-car-year").value = one.car_year != null && one.car_year !== "" ? String(one.car_year) : "";
    $("#edit-d-car-category").value = one.car_category || "";
    fillNumInput("#edit-d-balance", one.balance);
    fillNumInput("#edit-d-rating", one.rating);
    fillNumInput("#edit-d-price-km", one.price_per_km);
    fillNumInput("#edit-d-rating-coef", one.rating_coefficient);
    fillNumInput("#edit-d-accept-rate", one.acceptance_rate);
    const ev = $("#edit-d-verification");
    const es = $("#edit-d-status");
    if (ev) ev.value = normVerification(one.verification);
    if (es) es.value = String(one.status || "offline").toLowerCase();
    const eb = $("#edit-d-is-banned");
    const ed = $("#edit-d-admin-disabled");
    if (eb) eb.checked = !!one.is_banned;
    if (ed) ed.checked = !!one.admin_disabled;
    const etp = $("#edit-d-tech-passport");
    const edl = $("#edit-d-driver-license");
    if (etp) etp.value = one.car_tech_passport || "";
    if (edl) edl.value = one.driver_license || "";
    $("#edit-d-lat").value = one.last_lat != null ? String(one.last_lat) : "";
    $("#edit-d-lon").value = one.last_lon != null ? String(one.last_lon) : "";
    const epw = $("#edit-d-password");
    if (epw) epw.value = "";
    $("#admin-edit-client-fields").classList.add("hidden");
    $("#admin-edit-driver-fields").classList.remove("hidden");
    $("#admin-edit-modal").classList.remove("hidden");
  }

  async function openAdminEditClient(clientId) {
    const one = await api("/admin/clients/" + clientId);
    const tid = $("#admin-edit-type");
    const iid = $("#admin-edit-id");
    const title = $("#admin-edit-title");
    if (!tid || !iid || !title) return;
    tid.value = "client";
    iid.value = String(clientId);
    title.innerHTML = "Клиент <b>ID:</b> " + esc(String(clientId));
    const dstc = $("#admin-edit-device-strip");
    if (dstc) dstc.textContent = formatAdminDeviceStrip(one);
    $("#edit-c-name").value = one.name || "";
    $("#edit-c-surname").value = one.surname || "";
    $("#edit-c-phone").value = one.phone || "";
    $("#edit-c-email").value = one.email || "";
    fillNumInput("#edit-c-balance", one.balance);
    fillNumInput("#edit-c-rating", one.rating);
    $("#edit-c-lat").value = one.last_lat != null ? String(one.last_lat) : "";
    $("#edit-c-lon").value = one.last_lon != null ? String(one.last_lon) : "";
    const cb = $("#edit-c-is-banned");
    const cd = $("#edit-c-admin-disabled");
    if (cb) cb.checked = !!one.is_banned;
    if (cd) cd.checked = !!one.admin_disabled;
    const cpw = $("#edit-c-password");
    if (cpw) cpw.value = "";
    const cph = $("#edit-c-photo");
    if (cph) cph.value = "";
    $("#admin-edit-driver-fields").classList.add("hidden");
    $("#admin-edit-client-fields").classList.remove("hidden");
    $("#admin-edit-modal").classList.remove("hidden");
  }

  async function submitAdminEdit() {
    const type = ($("#admin-edit-type") && $("#admin-edit-type").value) || "";
    const id = ($("#admin-edit-id") && $("#admin-edit-id").value) || "";
    if (!type || !id) return;
    try {
      if (type === "client") {
        const body = {
          name: $("#edit-c-name").value.trim(),
          surname: $("#edit-c-surname").value.trim(),
          phone: $("#edit-c-phone").value.trim(),
          email: $("#edit-c-email").value.trim(),
        };
        if (!body.phone) {
          alert("Укажите телефон.");
          return;
        }
        if (!body.name || !body.surname) {
          alert("Укажите имя и фамилию.");
          return;
        }
        const addOptFloat = (key, sel) => {
          const t = $(sel).value.trim();
          if (t === "") return;
          const n = parseFloat(t.replace(",", "."));
          if (!Number.isFinite(n)) {
            throw new Error("Некорректное число: " + key);
          }
          body[key] = n;
        };
        addOptFloat("balance", "#edit-c-balance");
        addOptFloat("rating", "#edit-c-rating");
        const latc = $("#edit-c-lat").value.trim();
        if (latc !== "") {
          const la = parseFloat(latc.replace(",", "."));
          if (!Number.isFinite(la)) throw new Error("Некорректная широта");
          body.last_lat = la;
        }
        const lonc = $("#edit-c-lon").value.trim();
        if (lonc !== "") {
          const lo = parseFloat(lonc.replace(",", "."));
          if (!Number.isFinite(lo)) throw new Error("Некорректная долгота");
          body.last_lon = lo;
        }
        body.is_banned = !!$("#edit-c-is-banned").checked;
        body.admin_disabled = !!$("#edit-c-admin-disabled").checked;
        const cpw = $("#edit-c-password").value;
        if (cpw) body.password = cpw;
        const cphoto = $("#edit-c-photo").value.trim();
        if (cphoto) body.photo = cphoto;
        await api("/admin/clients/" + id, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        closeAdminEditModal();
        await loadClients();
      } else if (type === "driver") {
        const body = {
          name: $("#edit-d-name").value.trim(),
          surname: $("#edit-d-surname").value.trim(),
          phone: $("#edit-d-phone").value.trim(),
          email: $("#edit-d-email").value.trim(),
          car_name: $("#edit-d-car-name").value.trim(),
          car_number: $("#edit-d-car-number").value.trim(),
          car_category: $("#edit-d-car-category").value.trim(),
        };
        if (!body.phone) {
          alert("Укажите телефон.");
          return;
        }
        if (!body.name || !body.surname) {
          alert("Укажите имя и фамилию.");
          return;
        }
        if (!body.car_number) {
          alert("Укажите гос. номер автомобиля.");
          return;
        }
        const y = $("#edit-d-car-year").value.trim();
        if (y) {
          const n = parseInt(y, 10);
          if (!Number.isNaN(n)) body.car_year = n;
        }
        const addOptFloatD = (key, sel) => {
          const t = $(sel).value.trim();
          if (t === "") return;
          const n = parseFloat(t.replace(",", "."));
          if (!Number.isFinite(n)) {
            throw new Error("Некорректное число: " + key);
          }
          body[key] = n;
        };
        addOptFloatD("balance", "#edit-d-balance");
        addOptFloatD("rating", "#edit-d-rating");
        addOptFloatD("price_per_km", "#edit-d-price-km");
        addOptFloatD("rating_coefficient", "#edit-d-rating-coef");
        addOptFloatD("acceptance_rate", "#edit-d-accept-rate");
        body.verification = $("#edit-d-verification").value;
        body.status = $("#edit-d-status").value;
        body.is_banned = !!$("#edit-d-is-banned").checked;
        body.admin_disabled = !!$("#edit-d-admin-disabled").checked;
        body.car_tech_passport = $("#edit-d-tech-passport").value.trim();
        body.driver_license = $("#edit-d-driver-license").value.trim();
        const latd = $("#edit-d-lat").value.trim();
        if (latd !== "") {
          const la = parseFloat(latd.replace(",", "."));
          if (!Number.isFinite(la)) throw new Error("Некорректная широта");
          body.last_lat = la;
        }
        const lond = $("#edit-d-lon").value.trim();
        if (lond !== "") {
          const lo = parseFloat(lond.replace(",", "."));
          if (!Number.isFinite(lo)) throw new Error("Некорректная долгота");
          body.last_lon = lo;
        }
        const dpw = $("#edit-d-password").value;
        if (dpw) body.password = dpw;
        await api("/admin/drivers/" + id, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        closeAdminEditModal();
        await loadDrivers();
      }
    } catch (e) {
      alert(e.message || String(e));
    }
  }

  function showDocModal(title, value) {
    const inner = $("#doc-modal-inner");
    const ht = $("#doc-modal-title");
    if (!inner || !ht) return;
    if (docPreviewBlobUrl) {
      try {
        URL.revokeObjectURL(docPreviewBlobUrl);
      } catch (e) {}
      docPreviewBlobUrl = null;
    }
    ht.textContent = title || "Документ";
    const v = unwrapQuotedJsonString(value == null ? "" : String(value));
    if (!v) {
      inner.innerHTML = '<p class="muted">Нет данных</p>';
    } else if (shouldShowAsImage(v)) {
      const src = toImageSrc(unwrapQuotedJsonString(v));
      if (!src) {
        inner.innerHTML =
          '<p class="muted">Некорректные или пустые данные изображения.</p><pre class="mono doc-text">' +
          esc(v.slice(0, 400)) +
          (v.length > 400 ? "…" : "") +
          "</pre>";
      } else {
        let displayUrl = src;
        let linkHref = src;
        if (/^data:image\//i.test(src)) {
          try {
            const comma = src.indexOf(",");
            const b64part = src.slice(comma + 1);
            const bytes = base64ToUint8Array(b64part);
            if (bytes.length) {
              const mime = sniffMimeFromBytes(bytes);
              const blob = new Blob([bytes], { type: mime });
              docPreviewBlobUrl = URL.createObjectURL(blob);
              displayUrl = docPreviewBlobUrl;
              linkHref = src;
            }
          } catch (e) {
            displayUrl = src;
            linkHref = src;
          }
        }
        const safe = escAttr(displayUrl);
        const safeLink = escAttr(linkHref);
        inner.innerHTML =
          '<a href="' +
          safeLink +
          '" target="_blank" rel="noopener noreferrer"><img class="doc-preview-img" src="' +
          safe +
          '" alt="" loading="lazy" /></a>';
      }
    } else if (/^https?:\/\//i.test(v) || v.startsWith("/")) {
      const safe = esc(v);
      inner.innerHTML =
        '<p><a href="' +
        safe +
        '" target="_blank" rel="noopener noreferrer">Открыть ссылку</a></p>' +
        '<img class="doc-preview-img" src="' +
        safe +
        '" alt="" onerror="this.style.display=\'none\'" />';
    } else {
      inner.innerHTML = '<pre class="mono doc-text">' + esc(v) + "</pre>";
    }
    const m = $("#doc-modal");
    if (m) m.classList.remove("hidden");
  }

  function trunc(s, n) {
    const t = (s == null ? "" : String(s)).trim();
    return t.length <= n ? t : t.slice(0, n) + "…";
  }

  async function api(path, opts = {}) {
    const headers = Object.assign(
      { "Content-Type": "application/json" },
      opts.headers || {}
    );
    if (token) headers.Authorization = "Bearer " + token;
    const fetchInit = Object.assign({}, opts, { headers });
    if (
      (!opts.method || String(opts.method).toUpperCase() === "GET") &&
      String(path).includes("/admin/project-settings")
    ) {
      fetchInit.cache = "no-store";
    }
    const r = await fetch(path, fetchInit);
    if (r.status === 401) {
      logout();
      throw new Error("401");
    }
    if (!r.ok) {
      const t = await r.text();
      throw new Error(t || r.statusText);
    }
    const ct = r.headers.get("content-type") || "";
    if (ct.includes("application/json")) return r.json();
    return r.text();
  }

  function logout() {
    token = null;
    localStorage.removeItem(LS);
    if (socket) {
      socket.disconnect();
      socket = null;
    }
    $("#app").classList.add("hidden");
    $("#login-screen").classList.remove("hidden");
  }

  function setSocketBadge(on) {
    const el = $("#socket-status");
    el.className = "badge " + (on ? "badge-on" : "badge-off");
    el.innerHTML =
      '<i class="fa-solid fa-plug"></i> Socket ' + (on ? "online" : "offline");
  }

  function driverPopup(d) {
    const trip = d.active_trip;
    const tripLine = trip
      ? `<div><span class="k">Поездка</span> <b>ID:</b> ${esc(trip.trip_id)} (${esc(trip.status)})</div>`
      : "";
    return (
      `<div class="admin-popup-head admin-popup-head--driver"><i class="fa-solid fa-taxi"></i> Водитель</div>` +
      `<div class="admin-popup-body">` +
      `<div><span class="k">ID</span> ${esc(d.user_id)}</div>` +
      `<div><span class="k">Имя</span> ${esc(d.name)}</div>` +
      `<div><span class="k">Рейтинг</span> ${esc(d.rating)}</div>` +
      `<div><span class="k">Статус</span> ${esc(d.status || "—")}</div>` +
      tripLine +
      `</div>`
    );
  }

  function clientPopup(d) {
    const trip = d.active_trip;
    const tripLine = trip
      ? `<div><span class="k">Заказ</span> <b>ID:</b> ${esc(trip.trip_id)} (${esc(trip.status)})</div>`
      : `<div><span class="k">Заказ</span> нет</div>`;
    return (
      `<div class="admin-popup-head admin-popup-head--client"><i class="fa-solid fa-user"></i> Клиент</div>` +
      `<div class="admin-popup-body">` +
      `<div><span class="k">ID</span> ${esc(d.user_id)}</div>` +
      `<div><span class="k">Имя</span> ${esc(d.name)}</div>` +
      tripLine +
      `</div>`
    );
  }

  function ensureMap() {
    if (map) return;
    const el = document.getElementById("map-inner");
    if (!el) return;
    map = L.map(el, {
      zoomControl: false,
      attributionControl: false,
    }).setView(ADMIN_MAP.defaultView, ADMIN_MAP.defaultZoom);
    L.tileLayer(ADMIN_MAP.tileLayer, ADMIN_MAP.tileLayerOptions).addTo(map);
    L.control.zoom({ position: "bottomright" }).addTo(map);
    layerDrivers = L.layerGroup().addTo(map);
    layerClients = L.layerGroup().addTo(map);
    layerRoutes = L.layerGroup().addTo(map);
  }

  function fitMapToMarkers() {
    if (!map || markers.size === 0) return;
    const bounds = L.latLngBounds([]);
    markers.forEach((m) => {
      bounds.extend(m.getLatLng());
    });
    if (bounds.isValid()) {
      map.fitBounds(bounds, { padding: [48, 48], maxZoom: 16 });
    }
  }

  function heatmapGradientByPrefs() {
    const p = getPrefs();
    if (p.heatmapRainbow === false) {
      return {
        0.12: "rgba(0, 174, 80, 0.45)",
        0.35: "rgba(0, 174, 80, 0.7)",
        0.55: "rgba(0, 150, 65, 0.85)",
        0.8: "rgba(0, 110, 50, 0.94)",
        1: "rgba(0, 70, 35, 0.97)",
      };
    }
    return {
      0: "rgba(59, 130, 246, 0.38)",
      0.12: "rgba(6, 182, 212, 0.52)",
      0.28: "rgba(16, 185, 129, 0.65)",
      0.42: "rgba(234, 179, 8, 0.78)",
      0.55: "rgba(249, 115, 22, 0.84)",
      0.68: "rgba(239, 68, 68, 0.88)",
      0.82: "rgba(192, 38, 211, 0.92)",
      1: "rgba(88, 28, 135, 0.96)",
    };
  }

  function syncHeatmapLayer() {
    if (!map || typeof L.heatLayer !== "function") return;
    const on = $("#tog-heatmap") && $("#tog-heatmap").checked;
    if (heatLayer) {
      try {
        map.removeLayer(heatLayer);
      } catch (e) {}
      heatLayer = null;
    }
    if (!on) return;
    const pts = [];
    markers.forEach((m) => {
      const ll = m.getLatLng();
      if (ll) pts.push([ll.lat, ll.lng, 1.0]);
    });
    if (pts.length === 0) return;
    const p = getPrefs();
    const radius = Math.max(28, Math.min(96, parseInt(String(p.heatmapRadius || 56), 10) || 56));
    const blur = Math.max(12, Math.min(64, parseInt(String(p.heatmapBlur || 32), 10) || 32));
    heatLayer = L.heatLayer(pts, {
      radius,
      blur,
      maxZoom: 12,
      minOpacity: 0.28,
      max: 1.12,
      gradient: heatmapGradientByPrefs(),
    });
    heatLayer.addTo(map);
  }

  function markerKey(kind, id) {
    return kind + ":" + id;
  }

  function applyMarkerVisibility() {
    const showD = $("#tog-drivers").checked;
    const showC = $("#tog-clients").checked;
    const onlyOnline = $("#filt-online").checked;
    const onlyBusy = $("#filt-busy").checked;
    markers.forEach((m, key) => {
      const isDriver = key.startsWith("driver:");
      const id = key.split(":")[1];
      let visible = isDriver ? showD : showC;
      if (visible && onlyOnline) {
        visible = isDriver ? onlineDrivers.has(id) : onlineClients.has(id);
      }
      if (visible && onlyBusy && isDriver) {
        const st = m._jiStatus || "";
        visible = st === "busy";
      }
      const layer = isDriver ? layerDrivers : layerClients;
      if (visible) {
        if (!layer.hasLayer(m)) m.addTo(layer);
      } else {
        layer.removeLayer(m);
      }
    });
  }

  function upsertMarker(payload) {
    ensureMap();
    const kind = payload.user_type;
    const id = String(payload.user_id);
    const key = markerKey(kind, id);
    const lat = Number(payload.lat);
    const lng = Number(payload.lng);
    if (Number.isNaN(lat) || Number.isNaN(lng)) return;

    let m = markers.get(key);
    const isDriver = kind === "driver";
    const icon = L.icon(isDriver ? ADMIN_ICONS.taxi : ADMIN_ICONS.client);
    if (!m) {
      m = L.marker([lat, lng], { icon: icon });
      markers.set(key, m);
    } else {
      m.setLatLng([lat, lng]);
      m.setIcon(icon);
    }
    m._jiStatus = payload.status || m._jiStatus;
    const html = isDriver ? driverPopup(payload) : clientPopup(payload);
    m.bindPopup(html, {
      className: "admin-leaflet-popup",
      maxWidth: 280,
    });

    applyMarkerVisibility();
    syncHeatmapLayer();
  }

  function updateDriverStatusOnly(payload) {
    const id = String(payload.driver_id);
    const key = markerKey("driver", id);
    const m = markers.get(key);
    if (m) {
      m._jiStatus = payload.status;
      applyMarkerVisibility();
    }
  }

  async function refreshOnlineSets() {
    try {
      const o = await api("/admin/online-users");
      onlineDrivers.clear();
      onlineClients.clear();
      (o.driver_ids_online || []).forEach((x) => onlineDrivers.add(String(x)));
      (o.client_ids_online || []).forEach((x) => onlineClients.add(String(x)));
    } catch (e) {
      console.warn(e);
    }
  }

  async function loadPositionsSnapshot() {
    await refreshOnlineSets();
    const snap = await api("/admin/positions");
    (snap.drivers || []).forEach((row) => {
      upsertMarker({
        user_type: "driver",
        user_id: row.driver_id,
        lat: row.last_lat,
        lng: row.last_lon,
        name: (row.name || "") + " " + (row.surname || ""),
        rating: row.rating,
        status: row.status,
        active_trip: null,
      });
    });
    (snap.clients || []).forEach((row) => {
      upsertMarker({
        user_type: "client",
        user_id: row.client_id,
        lat: row.last_lat,
        lng: row.last_lon,
        name: (row.name || "") + " " + (row.surname || ""),
        rating: row.rating,
        active_trip: null,
      });
    });
    applyMarkerVisibility();
    syncHeatmapLayer();
  }

  function kvRow(label, value) {
    return (
      '<div class="dash-kv-row"><span class="dash-kv-label">' +
      esc(label) +
      '</span><span class="dash-kv-value">' +
      esc(value) +
      "</span></div>"
    );
  }

  function scheduleRouteRefresh() {
    if (!$("#tog-routes") || !$("#tog-routes").checked) return;
    clearTimeout(routeRefreshTimer);
    routeRefreshTimer = setTimeout(() => {
      routeRefreshTimer = null;
      refreshRouteLines().catch(console.error);
    }, 450);
  }

  async function refreshRouteLines() {
    if (!map || !layerRoutes) return;
    layerRoutes.clearLayers();
    if (!$("#tog-routes").checked) return;
    const [activeRes, recentRes] = await Promise.all([
      api("/admin/trips?status=active&limit=80"),
      api("/admin/trips?status=map_recent&limit=120"),
    ]);
    const recentItems = recentRes.items || [];
    const activeItems = activeRes.items || [];
    const drawSegment = (t, style) => {
      const a = t.start_lat != null && t.start_lon != null;
      const b = t.end_lat != null && t.end_lon != null;
      if (a && b) {
        L.polyline(
          [
            [Number(t.start_lat), Number(t.start_lon)],
            [Number(t.end_lat), Number(t.end_lon)],
          ],
          Object.assign(
            { lineCap: "round", lineJoin: "round" },
            style
          )
        ).addTo(layerRoutes);
      } else if (a) {
        L.circleMarker([Number(t.start_lat), Number(t.start_lon)], {
          radius: style.weight >= 4 ? 6 : 5,
          color: style.color,
          fillColor: style.color,
          fillOpacity: style.opacity * 0.75,
        }).addTo(layerRoutes);
      }
    };
    // Сначала «недавние» завершённые/отменённые (темнее, под текущими линиями).
    recentItems.forEach((t) => {
      drawSegment(t, {
        color: "#1b4332",
        weight: 3,
        opacity: 0.42,
        dashArray: "6 10",
      });
    });
    // Активные поездки — ярче и поверх.
    activeItems.forEach((t) => {
      drawSegment(t, {
        color: "#00ae50",
        weight: 4,
        opacity: 0.72,
      });
    });
  }

  async function loadDashboard() {
    const s = await api("/admin/stats");
    const cards = $("#stat-cards");
    cards.innerHTML = "";
    const mainStats = [
      {
        icon: "fa-users",
        label: "Пользователей",
        sub: "клиенты + водители",
        value: s.total_users,
      },
      {
        icon: "fa-wifi",
        label: "В сети (Socket)",
        sub: "клиенты и водители",
        value: s.online_users_socket,
      },
      {
        icon: "fa-car",
        label: "Водителей в сети",
        sub: "активное подключение",
        value: s.drivers_online_socket,
      },
      {
        icon: "fa-users",
        label: "Клиентов в сети",
        sub: "активное подключение",
        value: s.clients_online_socket != null ? s.clients_online_socket : (s.socket && s.socket.client_ids_online && s.socket.client_ids_online.length) || 0,
      },
      {
        icon: "fa-road",
        label: "Активных поездок",
        sub: "pending … busy",
        value: s.active_trips,
      },
      {
        icon: "fa-circle-check",
        label: "Всего завершено",
        sub: "за всё время",
        value: s.completed_trips,
      },
      {
        icon: "fa-ban",
        label: "Отменено всего",
        sub: "cancelled",
        value: s.trips_cancelled,
      },
      {
        icon: "fa-user-lock",
        label: "Ограничения",
        sub: "клиенты + водители (бан/стоп)",
        value: (Number(s.clients_restricted) || 0) + (Number(s.drivers_restricted) || 0),
      },
    ];
    mainStats.forEach((it) => {
      const div = document.createElement("div");
      div.className = "dash-stat-tile";
      div.innerHTML =
        '<div class="dash-stat-icon"><i class="fa-solid ' +
        esc(it.icon) +
        '"></i></div>' +
        '<div class="dash-stat-text">' +
        '<div class="dash-stat-label">' +
        esc(it.label) +
        "</div>" +
        '<div class="dash-stat-sub muted">' +
        esc(it.sub) +
        "</div>" +
        "</div>" +
        '<div class="dash-stat-value">' +
        esc(it.value) +
        "</div>";
      cards.appendChild(div);
    });

    const now = new Date();
    $("#dash-updated").textContent =
      "Обновлено: " +
      now.toLocaleString("ru-RU", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      });

    $("#dash-today").innerHTML =
      kvRow("Новых поездок (создано)", s.trips_created_today) +
      kvRow("Завершено сегодня", s.trips_completed_today) +
      kvRow("Отмен сегодня", s.trips_cancelled_today);

    const dTot = Math.max(1, s.drivers_total || 1);
    const av = s.drivers_status_available || 0;
    const bz = s.drivers_status_busy || 0;
    const off = s.drivers_status_offline || 0;
    const pct = (n) => Math.round((100 * n) / dTot) + "%";
    $("#dash-drivers-bar").innerHTML =
      '<div class="bar-stack" title="Распределение по полю status в БД">' +
      '<span class="bar-seg bar-av" style="width:' +
      pct(av) +
      '">' +
      (av ? esc(av) : "") +
      "</span>" +
      '<span class="bar-seg bar-bz" style="width:' +
      pct(bz) +
      '">' +
      (bz ? esc(bz) : "") +
      "</span>" +
      '<span class="bar-seg bar-off" style="width:' +
      pct(off) +
      '">' +
      (off ? esc(off) : "") +
      "</span>" +
      "</div>" +
      '<div class="bar-legend">' +
      "<span><i class=\"bar-dot bar-av\"></i> Свободен (" +
      esc(av) +
      ")</span>" +
      "<span><i class=\"bar-dot bar-bz\"></i> Занят (" +
      esc(bz) +
      ")</span>" +
      "<span><i class=\"bar-dot bar-off\"></i> Оффлайн (" +
      esc(off) +
      ")</span>" +
      "</div>";

    $("#dash-live").innerHTML =
      kvRow("Водителей (socket)", s.drivers_online_socket) +
      kvRow(
        "Клиентов (socket)",
        s.clients_online_socket != null
          ? s.clients_online_socket
          : (s.socket && s.socket.client_ids_online && s.socket.client_ids_online.length) || 0
      ) +
      kvRow("Админов в панели", s.admins_online_socket || 0);

    $("#dash-trips-meta").innerHTML =
      kvRow("В очереди / offered", (s.trips_pending || 0) + " / " + (s.trips_offered || 0)) +
      kvRow("Accepted (ожидают подтверждения)", s.trips_accepted || 0) +
      kvRow("Поездок за 7 дней (создано)", s.trips_created_7d || 0) +
      kvRow("Завершено за 7 дней", s.trips_completed_7d || 0) +
      kvRow("В статусе busy (в пути)", s.trips_busy || 0) +
      kvRow("Водителей в статусе available+busy (БД)", s.drivers_active_status) +
      kvRow("Водителей с ограничениями", s.drivers_restricted) +
      kvRow("Водителей в бане / только деактив.", (s.drivers_banned || 0) + " / " + (s.drivers_deactivated_only || 0)) +
      kvRow("Клиентов с ограничениями / в бане", (s.clients_restricted || 0) + " / " + (s.clients_banned || 0)) +
      kvRow("Отказов сегодня (refusals)", s.refusals_today || 0) +
      kvRow("Средняя длина завершённой поездки, км", (s.avg_km_completed || 0).toFixed(2)) +
      kvRow("Новых водителей сегодня", s.drivers_registered_today || 0) +
      kvRow("Средний рейтинг водителей", s.avg_driver_rating) +
      kvRow("Средний рейтинг клиентов", s.avg_client_rating) +
      kvRow("Клиентов в базе", s.clients_total) +
      kvRow("Водителей в базе", s.drivers_total);

    const dv = $("#dash-verif");
    if (dv) {
      dv.innerHTML =
        kvRow("Ожидают проверки (pending)", s.drivers_verif_pending || 0) +
        kvRow("Подтверждены (verified)", s.drivers_verif_verified || 0) +
        kvRow("Отклонены (refused)", s.drivers_verif_refused || 0);
    }
    const dr = $("#dash-revenue");
    if (dr) {
      dr.innerHTML =
        kvRow("Всего (completed)", (s.revenue_completed_total || 0).toFixed(2)) +
        kvRow("Сегодня (completed)", (s.revenue_completed_today || 0).toFixed(2));
    }

    const ad = $("#analytics-dump");
    if (ad) ad.textContent = JSON.stringify(s, null, 2);
  }

  function renderTable(el, headers, rows) {
    let h = "<thead><tr>";
    headers.forEach((x) => (h += "<th>" + esc(x) + "</th>"));
    h += "</tr></thead><tbody>";
    rows.forEach((cells) => {
      h += "<tr>";
      cells.forEach((c) => (h += "<td>" + c + "</td>"));
      h += "</tr>";
    });
    h += "</tbody>";
    el.innerHTML = h;
  }

  async function loadDrivers() {
    await refreshOnlineSets();
    const q = $("#drivers-q").value.trim();
    const vf = ($("#drivers-ver-filter") && $("#drivers-ver-filter").value) || "";
    const sb = ($("#drivers-sort-by") && $("#drivers-sort-by").value) || "driver_id";
    const sd = ($("#drivers-sort-dir") && $("#drivers-sort-dir").value) || "desc";
    const params = new URLSearchParams({
      limit: "150",
      sort_by: sb,
      sort_dir: sd,
    });
    if (q) params.set("q", q);
    if (vf) params.set("verification", vf);
    const data = await api("/admin/drivers?" + params.toString());
    const grid = $("#drivers-grid");
    if (!grid) return;
    const items = data.items || [];
    grid.innerHTML = items
      .map((d) => {
        const vid = esc(d.driver_id);
        const drvOnline = onlineDrivers.has(String(d.driver_id));
        const v = normVerification(d.verification);
        const carInfo = [d.car_name, d.car_number, d.car_year]
          .filter((x) => x != null && x !== "")
          .join(" · ");
        const opts = (vals, cur) =>
          vals
            .map(
              (opt) =>
                '<option value="' +
                esc(opt) +
                '"' +
                (String(cur).toLowerCase() === opt ? " selected" : "") +
                ">" +
                esc(opt) +
                "</option>"
            )
            .join("");
        const avSrc = toImageSrc(d.face_photo);
        const avatarBlock = avSrc
          ? '<img class="driver-card-avatar" src="' +
            escAttr(avSrc) +
            '" alt="" loading="lazy" />'
          : '<div class="driver-card-avatar driver-card-avatar--ph" aria-hidden="true"><i class="fa-solid fa-user"></i></div>';
        return (
          '<article class="driver-card" data-driver-id="' +
          vid +
          '">' +
          '<div class="driver-card-head">' +
          avatarBlock +
          '<div class="driver-card-head-text"><div class="driver-card-name">' +
          esc(((d.name || "") + " " + (d.surname || "")).trim()) +
          '</div><div class="driver-card-id">Водитель <b>ID:</b> ' +
          vid +
          "</div></div>" +
          '<span class="admin-online-dot ' +
          (drvOnline ? "admin-online-dot--on" : "admin-online-dot--off") +
          '" title="' +
          escAttr(drvOnline ? "В сети (Socket)" : "Не в сети") +
          '"></span></div>' +
          '<div class="driver-badges">' +
          '<span class="badge-v badge-v-' +
          esc(v) +
          '">' +
          esc(v) +
          "</span>" +
          '<span class="badge-st">' +
          esc(d.status || "—") +
          "</span>" +
          (d.is_banned
            ? '<span class="badge-v badge-v-refused">ban</span>'
            : "") +
          (d.admin_disabled
            ? '<span class="badge-v badge-v-pending">disabled</span>'
            : "") +
          "</div>" +
          lastSeenRowHtml(d.last_seen_at, drvOnline) +
          '<div class="driver-meta entity-meta-compact">' +
          '<span class="m-item" title="Телефон"><i class="fa-solid fa-phone" aria-hidden="true"></i>' +
          esc(d.phone || "—") +
          "</span>" +
          '<span class="m-item" title="Авто"><i class="fa-solid fa-car" aria-hidden="true"></i>' +
          esc(carInfo || "—") +
          "</span>" +
          '<span class="m-item" title="Рейтинг · баланс · accept"><i class="fa-solid fa-star" aria-hidden="true"></i>' +
          esc(d.rating) +
          '<span class="m-dot">·</span><i class="fa-solid fa-wallet" aria-hidden="true"></i>' +
          esc(formatMoneyAzN(d.balance)) +
          '<span class="m-dot">·</span><i class="fa-solid fa-check-double" aria-hidden="true"></i>' +
          esc(formatAcceptRate(d.acceptance_rate)) +
          "</span>" +
          '<span class="m-item" title="Регистрация"><i class="fa-solid fa-calendar-plus" aria-hidden="true"></i>' +
          esc(formatAdminDatetime(d.created_at)) +
          "</span>" +
          adminDeviceIconsCell(d) +
          "</div>" +
          '<div class="driver-docs">' +
          [
            ["tech_pass", "fa-file-lines", "ПТС (номер)", "ПТС"],
            ["license", "fa-id-card", "Водит. удостоверение", "ВУ"],
            ["car", "fa-car", "Фото авто", "Авто"],
            ["license_ph", "fa-image", "Фото ВУ", "ВУ·ф"],
            ["tech_ph", "fa-file-image", "Фото ПТС", "ПТС·ф"],
            ["face", "fa-user", "Фото лица", "Лицо"],
          ]
            .map(
              ([k, ic, t, short]) =>
                '<button type="button" class="doc-ic" title="' +
                esc(t) +
                '" data-act="doc" data-kind="' +
                esc(k) +
                '" data-id="' +
                vid +
                '"><i class="fa-solid ' +
                esc(ic) +
                '"></i><span class="doc-ic-txt">' +
                esc(short) +
                "</span></button>"
            )
            .join("") +
          "</div>" +
          '<div class="driver-controls">' +
          "<label>Верификация</label>" +
          '<select class="js-ver" data-id="' +
          vid +
          '">' +
          opts(["pending", "verified", "refused"], v) +
          "</select>" +
          "<label>Статус в сети</label>" +
          '<select class="js-st" data-id="' +
          vid +
          '">' +
          opts(["offline", "available", "busy"], d.status || "offline") +
          "</select>" +
          '<div class="admin-toggles">' +
          '<label class="admin-toggle admin-toggle--ban" title="Блокировка (бан)">' +
          '<input type="checkbox" class="js-drv-ban" data-id="' +
          vid +
          '"' +
          (d.is_banned ? " checked" : "") +
          " />" +
          '<span class="admin-toggle-ui"></span>' +
          '<span class="admin-toggle-txt">Бан</span></label>' +
          '<label class="admin-toggle admin-toggle--dis" title="Деактивация админом (Стоп)">' +
          '<input type="checkbox" class="js-drv-dis" data-id="' +
          vid +
          '"' +
          (d.admin_disabled ? " checked" : "") +
          " />" +
          '<span class="admin-toggle-ui"></span>' +
          '<span class="admin-toggle-txt">Стоп</span></label>' +
          "</div>" +
          '<div class="row-actions icon-row">' +
          '<button type="button" class="icon-btn primary" data-act="view" data-id="' +
          vid +
          '" title="Данные JSON"><i class="fa-solid fa-code"></i><span class="icon-btn-txt">JSON</span></button>' +
          '<button type="button" class="icon-btn" data-act="edit" data-id="' +
          vid +
          '" title="Изменить данные"><i class="fa-solid fa-pen"></i><span class="icon-btn-txt">Правка</span></button>' +
          '<button type="button" class="icon-btn danger" data-act="deluser" data-id="' +
          vid +
          '" title="Удалить учётную запись"><i class="fa-solid fa-trash"></i><span class="icon-btn-txt">Удалить</span></button>' +
          "</div></div></article>"
        );
      })
      .join("");

    grid.querySelectorAll("select.js-ver, select.js-st").forEach((sel) => {
      sel.dataset.prev = sel.value;
    });

    grid.onchange = async (ev) => {
      const sel = ev.target;
      if (!sel || !sel.classList) return;
      const id = sel.getAttribute("data-id");
      if (!id) return;
      try {
        if (sel.classList.contains("js-ver")) {
          await api("/admin/drivers/" + id, {
            method: "PATCH",
            body: JSON.stringify({ verification: sel.value }),
          });
        } else if (sel.classList.contains("js-st")) {
          await api("/admin/drivers/" + id, {
            method: "PATCH",
            body: JSON.stringify({ status: sel.value }),
          });
        } else if (sel.classList.contains("js-drv-ban")) {
          await api("/admin/drivers/" + id, {
            method: "PATCH",
            body: JSON.stringify({ is_banned: !!sel.checked }),
          });
        } else if (sel.classList.contains("js-drv-dis")) {
          await api("/admin/drivers/" + id, {
            method: "PATCH",
            body: JSON.stringify({ admin_disabled: !!sel.checked }),
          });
        } else {
          return;
        }
        await loadDrivers();
      } catch (e) {
        alert(e.message || String(e));
        await loadDrivers();
      }
    };

    grid.onclick = async (ev) => {
      const btn = ev.target.closest("button[data-act]");
      if (!btn) return;
      const id = btn.getAttribute("data-id");
      const act = btn.getAttribute("data-act");
      try {
        if (act === "doc") {
          const kind = btn.getAttribute("data-kind");
          const one = await api("/admin/drivers/" + id);
          const map = {
            tech_pass: one.car_tech_passport,
            license: one.driver_license,
            car: one.car_front_photo,
            license_ph: one.driver_license_photo,
            tech_ph: one.car_tech_photo,
            face: one.face_photo,
          };
          showDocModal(DOC_LABELS[kind] || kind, map[kind]);
        } else if (act === "view") {
          const one = await api("/admin/drivers/" + id);
          $("#modal-content").textContent = JSON.stringify(one, null, 2);
          $("#modal").classList.remove("hidden");
        } else if (act === "edit") {
          await openAdminEditDriver(id);
        } else if (act === "deluser") {
          openDeleteConfirmModal(
            "Удалить водителя?",
            "Будет удалена учётная запись водителя <b>ID:</b> " +
              esc(String(id)) +
              " безвозвратно. Поездки останутся в системе, но без привязки к этому водителю.",
            async () => {
              await api("/admin/drivers/" + id, { method: "DELETE" });
              await loadDrivers();
            }
          );
        }
      } catch (e) {
        alert(e.message || String(e));
      }
    };
  }

  async function loadClients() {
    await refreshOnlineSets();
    const q = $("#clients-q").value.trim();
    const sb = ($("#clients-sort-by") && $("#clients-sort-by").value) || "client_id";
    const sd = ($("#clients-sort-dir") && $("#clients-sort-dir").value) || "desc";
    const params = new URLSearchParams({ limit: "150", sort_by: sb, sort_dir: sd });
    if (q) params.set("q", q);
    const data = await api("/admin/clients?" + params.toString());
    const grid = $("#clients-grid");
    if (!grid) return;
    grid.innerHTML = (data.items || [])
      .map((c) => {
        const cid = esc(c.client_id);
        const cliOnline = onlineClients.has(String(c.client_id));
        const hasPhoto = !!(c.photo && String(c.photo).trim());
        const cav = toImageSrc(c.photo);
        const cavatarBlock = cav
          ? '<img class="driver-card-avatar" src="' +
            escAttr(cav) +
            '" alt="" loading="lazy" />'
          : '<div class="driver-card-avatar driver-card-avatar--ph" aria-hidden="true"><i class="fa-solid fa-user"></i></div>';
        return (
          '<article class="driver-card client-card" data-client-id="' +
          cid +
          '">' +
          '<div class="driver-card-head">' +
          cavatarBlock +
          '<div class="driver-card-head-text"><div class="driver-card-name">' +
          esc(((c.name || "") + " " + (c.surname || "")).trim()) +
          '</div><div class="driver-card-id">Клиент <b>ID:</b> ' +
          cid +
          "</div></div>" +
          '<span class="admin-online-dot ' +
          (cliOnline ? "admin-online-dot--on" : "admin-online-dot--off") +
          '" title="' +
          escAttr(cliOnline ? "В сети (Socket)" : "Не в сети") +
          '"></span></div>'+
          '<div class="driver-badges">' +
          (c.is_banned ? '<span class="badge-v badge-v-refused">ban</span>' : "") +
          (c.admin_disabled
            ? '<span class="badge-v badge-v-pending">off</span>'
            : "") +
          '<span class="badge-st">' +
          esc(c.trips_count || 0) +
          " поездок</span></div>" +
          lastSeenRowHtml(c.last_seen_at, cliOnline) +
          '<div class="driver-meta entity-meta-compact">' +
          '<span class="m-item" title="Телефон"><i class="fa-solid fa-phone" aria-hidden="true"></i>' +
          esc(c.phone || "—") +
          "</span>" +
          '<span class="m-item" title="Рейтинг · баланс"><i class="fa-solid fa-star" aria-hidden="true"></i>' +
          esc(c.rating) +
          '<span class="m-dot">·</span><i class="fa-solid fa-wallet" aria-hidden="true"></i>' +
          esc(formatMoneyAzN(c.balance)) +
          "</span>" +
          '<span class="m-item" title="Регистрация"><i class="fa-solid fa-calendar-plus" aria-hidden="true"></i>' +
          esc(formatAdminDatetime(c.created_at)) +
          "</span>" +
          adminDeviceIconsCell(c) +
          "</div>" +
          (hasPhoto
            ? '<div class="driver-docs">' +
              '<button type="button" class="doc-ic" title="Фото" data-cact="photo" data-cid="' +
              cid +
              '"><i class="fa-solid fa-image"></i></button>' +
              "</div>"
            : "") +
          '<div class="driver-controls">' +
          '<div class="admin-toggles">' +
          '<label class="admin-toggle admin-toggle--ban" title="Блокировка (бан)">' +
          '<input type="checkbox" class="js-cli-ban" data-cid="' +
          cid +
          '"' +
          (c.is_banned ? " checked" : "") +
          " />" +
          '<span class="admin-toggle-ui"></span>' +
          '<span class="admin-toggle-txt">Бан</span></label>' +
          '<label class="admin-toggle admin-toggle--dis" title="Деактивация админом (Стоп)">' +
          '<input type="checkbox" class="js-cli-dis" data-cid="' +
          cid +
          '"' +
          (c.admin_disabled ? " checked" : "") +
          " />" +
          '<span class="admin-toggle-ui"></span>' +
          '<span class="admin-toggle-txt">Стоп</span></label>' +
          "</div>" +
          '<div class="row-actions icon-row">' +
          '<button type="button" class="icon-btn primary" data-cact="json" data-cid="' +
          cid +
          '" title="JSON"><i class="fa-solid fa-code"></i><span class="icon-btn-txt">JSON</span></button>' +
          '<button type="button" class="icon-btn" data-cact="edit" data-cid="' +
          cid +
          '" title="Изменить данные"><i class="fa-solid fa-pen"></i><span class="icon-btn-txt">Правка</span></button>' +
          '<button type="button" class="icon-btn danger" data-cact="deluser" data-cid="' +
          cid +
          '" title="Удалить учётную запись"><i class="fa-solid fa-trash"></i><span class="icon-btn-txt">Удалить</span></button>' +
          "</div></div></article>"
        );
      })
      .join("");

    grid.onchange = async (ev) => {
      const t = ev.target;
      if (!t || !t.classList) return;
      const id = t.getAttribute("data-cid");
      if (!id) return;
      try {
        if (t.classList.contains("js-cli-ban")) {
          await api("/admin/clients/" + id, {
            method: "PATCH",
            body: JSON.stringify({ is_banned: !!t.checked }),
          });
        } else if (t.classList.contains("js-cli-dis")) {
          await api("/admin/clients/" + id, {
            method: "PATCH",
            body: JSON.stringify({ admin_disabled: !!t.checked }),
          });
        } else {
          return;
        }
        await loadClients();
      } catch (e) {
        alert(e.message || String(e));
        await loadClients();
      }
    };

    grid.onclick = async (ev) => {
      const btn = ev.target.closest("button[data-cact]");
      if (!btn) return;
      const id = btn.getAttribute("data-cid");
      const act = btn.getAttribute("data-cact");
      try {
        if (act === "photo") {
          const one = await api("/admin/clients/" + id);
          showDocModal("Фото клиента", one.photo);
        } else if (act === "json") {
          const one = await api("/admin/clients/" + id);
          $("#modal-content").textContent = JSON.stringify(one, null, 2);
          $("#modal").classList.remove("hidden");
        } else if (act === "edit") {
          await openAdminEditClient(id);
        } else if (act === "deluser") {
          openDeleteConfirmModal(
            "Удалить клиента?",
            "Будет удалена учётная запись клиента <b>ID:</b> " +
              esc(String(id)) +
              " безвозвратно. Также удалятся все его поездки и связанные записи (отказы по поездкам и т.п.).",
            async () => {
              await api("/admin/clients/" + id, { method: "DELETE" });
              await loadClients();
            }
          );
        }
      } catch (e) {
        alert(e.message || String(e));
      }
    };
  }

  async function loadTrips() {
    const q = $("#trips-q").value.trim();
    const st = $("#trips-status").value;
    const df = $("#trips-from").value;
    const dt = $("#trips-to").value;
    const sb = ($("#trips-sort-by") && $("#trips-sort-by").value) || "created_at";
    const sd = ($("#trips-sort-dir") && $("#trips-sort-dir").value) || "desc";
    const params = new URLSearchParams({
      limit: "120",
      sort_by: sb,
      sort_dir: sd,
    });
    if (q) params.set("q", q);
    if (st) params.set("status", st);
    if (df) params.set("date_from", df + "T00:00:00");
    if (dt) params.set("date_to", dt + "T23:59:59");
    const data = await api("/admin/trips?" + params.toString());
    const grid = $("#trips-grid");
    if (!grid) return;
    grid.innerHTML = (data.items || [])
      .map((t) => {
        const tid = esc(t.trip_id);
        const cname = ((t.client_first_name || "") + " " + (t.client_last_name || "")).trim();
        const dname = ((t.driver_first_name || "") + " " + (t.driver_last_name || "")).trim();
        const priceHtml = esc(formatMoneyAzN(t.price));
        const kmHtml = formatAdminTripKm(t.distance_km);
        const revHtml = esc(t.revision != null && t.revision !== "" ? t.revision : "—");
        const metaPanel =
          '<div class="trip-meta-panel">' +
          '<div class="trip-meta-participants">' +
          tripMetaPerson("client", cname, t.client_id) +
          tripMetaPerson("driver", dname, t.driver_id) +
          "</div>" +
          tripMetaRow("Цена", priceHtml) +
          tripMetaRow("Дистанция", kmHtml + ' <span class="muted">км</span>') +
          tripMetaRow("Revision", revHtml) +
          tripMetaRow("Создана", esc(formatAdminDatetime(t.created_at))) +
          (t.accepted_at
            ? tripMetaRow("Принята", esc(formatAdminDatetime(t.accepted_at)))
            : "") +
          (t.completed_at
            ? tripMetaRow("Завершена", esc(formatAdminDatetime(t.completed_at)))
            : "") +
          "</div>";
        return (
          '<article class="trip-card" data-trip-id="' +
          tid +
          '">' +
          '<div class="trip-card-top">' +
          '<span class="trip-id"><b>ID:</b> ' +
          tid +
          "</span>" +
          '<span class="badge-st">' +
          esc(t.status) +
          "</span></div>" +
          metaPanel +
          '<div class="trip-addr trip-addr-row"><i class="fa-solid fa-circle-dot t-addr-i-from" aria-hidden="true"></i><span><b>От</b> ' +
          esc(trunc(t.start_address || "", 80)) +
          "</span></div>" +
          '<div class="trip-addr trip-addr-row"><i class="fa-solid fa-location-dot t-addr-i-to" aria-hidden="true"></i><span><b>До</b> ' +
          esc(trunc(t.end_address || "", 80)) +
          "</span></div>" +
          (function () {
            const st = String(t.status || "").toLowerCase();
            const ref = t.admin_last_refusal_line;
            if (st === "cancelled" && ref)
              return (
                '<div class="trip-outcome trip-outcome--cancel"><i class="fa-solid fa-ban" aria-hidden="true"></i> <b>Отмена:</b> ' +
                esc(formatAdminRefusalLine(ref)) +
                "</div>"
              );
            if (st === "completed")
              return (
                '<div class="trip-outcome trip-outcome--ok"><i class="fa-solid fa-circle-check" aria-hidden="true"></i> <b>Итог:</b> Поездка успешно завершена</div>'
              );
            return "";
          })() +
          '<div class="row-actions icon-row" style="margin-top:0.6rem">' +
          '<button type="button" class="icon-btn primary" data-tact="json" data-tid="' +
          tid +
          '" title="JSON"><i class="fa-solid fa-code"></i><span class="icon-btn-txt">JSON</span></button>' +
          '<button type="button" class="icon-btn danger" data-tact="del" data-tid="' +
          tid +
          '" title="Удалить поездку"><i class="fa-solid fa-trash"></i><span class="icon-btn-txt">Удалить</span></button>' +
          "</div></article>"
        );
      })
      .join("");

    grid.onclick = async (ev) => {
      const btn = ev.target.closest("button[data-tact]");
      if (!btn) return;
      const tact = btn.getAttribute("data-tact");
      const id = btn.getAttribute("data-tid");
      try {
        if (tact === "json") {
          const one = await api("/admin/trips/" + id);
          $("#modal-content").textContent = JSON.stringify(one, null, 2);
          $("#modal").classList.remove("hidden");
        } else if (tact === "del") {
          openDeleteConfirmModal(
            "Удалить поездку?",
            "Поездка <b>ID:</b> " +
              esc(String(id)) +
              " будет удалена безвозвратно вместе со связанными служебными записями (отказы и т.п.).",
            async () => {
              await api("/admin/trips/" + id, { method: "DELETE" });
              await loadTrips();
              refreshRouteLines().catch(() => {});
            }
          );
        }
      } catch (e) {
        alert(e.message || String(e));
      }
    };
  }

  async function loadWithdrawals() {
    const grid = $("#withdrawals-grid");
    if (!grid) return;
    const st = ($("#wd-status-filter") && $("#wd-status-filter").value) || "";
    const params = new URLSearchParams({ limit: "200" });
    if (st) params.set("status", st);
    const data = await api("/admin/withdrawals?" + params.toString());
    const items = data.items || [];
    const stLabel = {
      pending: "В очереди",
      processing: "В обработке",
      completed: "Выполнено",
      rejected: "Отклонено",
    };
    grid.innerHTML = items
      .map((w) => {
        const id = esc(String(w.id));
        const dnm = [w.driver_surname, w.driver_name].filter(Boolean).join(" ").trim();
        const bin6 = String(w.card_bin6 || "").replace(/\D/g, "");
        const last4 = String(w.card_last4 || "").replace(/\D/g, "");
        const pan =
          bin6.length >= 4
            ? bin6.slice(0, 4) + " •••• •••• " + last4
            : "•••• " + last4;
        const tl = (w.timeline || [])
          .map((e) => {
            const stKey = String(e.status || "");
            const stHuman = esc(stLabel[stKey] || stKey);
            const cmt = e.comment
              ? '<p class="wd-step-msg">' + esc(String(e.comment)) + "</p>"
              : "";
            return (
              '<li class="wd-step">' +
              '<time class="wd-step-time">' +
              esc(formatWithdrawalShort(e.at)) +
              "</time>" +
              '<div class="wd-step-main"><span class="wd-step-st">' +
              stHuman +
              "</span>" +
              cmt +
              "</div></li>"
            );
          })
          .join("");
        return (
          '<article class="wd-card" data-wid="' +
          id +
          '">' +
          '<div class="wd-card-head">' +
          '<span class="wd-id">#' +
          id +
          "</span>" +
          '<span class="wd-pill">' +
          esc(stLabel[w.status] || w.status) +
          "</span></div>" +
          '<div class="wd-amount">' +
          esc(formatMoneyAzN(w.amount)) +
          ' <span class="wd-cur">₼</span></div>' +
          '<p class="wd-pan" translate="no">' +
          esc(pan) +
          "</p>" +
          '<p class="wd-driver"><span class="wd-driver-id">ID ' +
          esc(String(w.driver_id)) +
          "</span> · " +
          esc(dnm || "—") +
          " · " +
          esc(w.driver_phone || "") +
          "</p>" +
          '<p class="wd-created muted">Создана: ' +
          esc(formatWithdrawalShort(w.created_at)) +
          "</p>" +
          '<ul class="wd-steps">' +
          (tl || '<li class="wd-step muted">Нет записей</li>') +
          "</ul>" +
          '<div class="wd-actions">' +
          '<label class="wd-lbl"><span>Статус</span>' +
          '<select class="drivers-select wd-sel" data-wid="' +
          id +
          '">' +
          ["pending", "processing", "completed", "rejected"]
            .map(
              (s) =>
                '<option value="' +
                esc(s) +
                '"' +
                (String(w.status) === s ? " selected" : "") +
                ">" +
                esc(stLabel[s] || s) +
                "</option>"
            )
            .join("") +
          "</select></label>" +
          '<label class="wd-lbl"><span>Комментарий</span>' +
          '<textarea class="drivers-search wd-ta" rows="2" data-wid="' +
          id +
          '" placeholder="Пусто — возьмётся текст из настроек (Тарифы → тексты вывода)"></textarea></label>' +
          '<button type="button" class="btn-primary wd-save" data-wid="' +
          id +
          '">Сохранить</button>' +
          '<button type="button" class="btn-danger wd-delete" data-wid="' +
          id +
          '" title="Удалить заявку"><i class="fa-solid fa-trash" aria-hidden="true"></i> Удалить</button>' +
          "</div></article>"
        );
      })
      .join("");
    grid.onclick = async (ev) => {
      const delBtn = ev.target.closest("button.wd-delete");
      if (delBtn) {
        const wid = delBtn.getAttribute("data-wid");
        if (!wid) return;
        const w = items.find((x) => String(x.id) === String(wid));
        const amtTxt = w != null ? formatMoneyAzN(w.amount) : "?";
        const refunded = !!(w && w.balance_refunded);
        const note = refunded
          ? "По этой заявке возврат на баланс уже выполнялся (например, при отклонении). При удалении баланс водителя не изменится."
          : "Сумма списания по заявке будет возвращена на баланс водителя.";
        openDeleteConfirmModal(
          "Удалить заявку на вывод?",
          "<p>Заявка <b>#" +
            esc(wid) +
            "</b>, сумма <b>" +
            esc(amtTxt) +
            " ₼</b> будет удалена из списка.</p><p class=\"muted\">" +
            esc(note) +
            "</p>",
          async () => {
            await api("/admin/withdrawals/" + encodeURIComponent(wid), { method: "DELETE" });
            await loadWithdrawals();
          }
        );
        return;
      }
      const b = ev.target.closest("button.wd-save");
      if (!b) return;
      const wid = b.getAttribute("data-wid");
      const card = b.closest(".wd-card");
      if (!card || !wid) return;
      const sel = card.querySelector("select.wd-sel");
      const ta = card.querySelector("textarea.wd-ta");
      try {
        await api("/admin/withdrawals/" + encodeURIComponent(wid), {
          method: "PATCH",
          body: JSON.stringify({
            status: sel ? sel.value : "pending",
            comment: ta ? ta.value : "",
          }),
        });
        await loadWithdrawals();
      } catch (e) {
        alert(e.message || String(e));
      }
    };
  }

  function projNumToInput(v, decimals) {
    if (v === undefined || v === null || v === "") return "";
    const n = Number(v);
    if (!Number.isFinite(n)) return "";
    if (decimals == null) return String(n);
    return String(Number(n.toFixed(decimals)));
  }

  async function loadProjectSettings() {
    try {
      const p = await api("/admin/project-settings?_=" + Date.now());
      const a = $("#proj-price-per-km");
      const b = $("#proj-trip-base");
      const t = $("#proj-dispatch-timeout");
      const w = $("#proj-dispatch-wave-size");
      const pm = $("#proj-pricing-per-min");
      const mn = $("#proj-pricing-min-price");
      const lk = $("#proj-pricing-long-km");
      const lf = $("#proj-pricing-long-floor");
      const lpc = $("#proj-pricing-long-post-cap");
      const lmw = $("#proj-pricing-long-max-wave");
      const nbd = $("#proj-pricing-nearby-km");
      const refh = $("#proj-pricing-ref-high");
      const refl = $("#proj-pricing-ref-low");
      const rsk = $("#proj-pricing-ref-short-max-km");
      const rsp = $("#proj-pricing-ref-short-pkm");
      const dw = $("#proj-dispatch-dist-w");
      const tj = $("#proj-pricing-km-tiers-json");
      if (a) a.value = projNumToInput(p.price_per_km, 4);
      if (b) b.value = projNumToInput(p.trip_base_fee, 4);
      if (t) t.value = projNumToInput(p.dispatch_wave_timeout_sec, 0);
      if (w) w.value = projNumToInput(p.dispatch_wave_size, 0);
      if (pm) pm.value = projNumToInput(p.pricing_per_minute_azn, 4);
      if (mn) mn.value = projNumToInput(p.pricing_min_price_azn, 2);
      if (lk) lk.value = projNumToInput(p.pricing_long_trip_km_threshold, 2);
      if (lf) lf.value = projNumToInput(p.pricing_long_trip_floor_per_km, 4);
      if (lpc) lpc.value = projNumToInput(p.pricing_long_trip_post_cap_mult, 4);
      if (lmw) lmw.value = projNumToInput(p.pricing_long_trip_max_wave_mult, 4);
      if (nbd) nbd.value = projNumToInput(p.pricing_quote_nearby_driver_km, 2);
      if (refh) refh.value = projNumToInput(p.pricing_market_ref_high_mult, 4);
      if (refl) refl.value = projNumToInput(p.pricing_market_ref_low_mult, 4);
      if (rsk) rsk.value = projNumToInput(p.pricing_market_ref_short_max_km, 2);
      if (rsp) rsp.value = projNumToInput(p.pricing_market_ref_pkm_short, 4);
      if (dw) dw.value = projNumToInput(p.dispatch_priority_dist_weight, 4);
      const og = $("#proj-dispatch-offer-gap");
      const w1s = $("#proj-dispatch-wave1-share");
      const w2s = $("#proj-dispatch-wave2-share");
      const t2s = $("#proj-dispatch-tier2-sur");
      const t3e = $("#proj-dispatch-tier3-extra");
      const dpen = $("#proj-dispatch-decline-pen");
      const rfs = $("#proj-dispatch-react-fast");
      const rss = $("#proj-dispatch-react-slow");
      const rfb = $("#proj-dispatch-react-fast-b");
      const rslp = $("#proj-dispatch-react-slow-p");
      const fkm = $("#proj-dispatch-far-km");
      const fbn = $("#proj-dispatch-far-bonus");
      const ldp = $("#proj-dispatch-load-pen");
      const drw = $("#proj-dispatch-rw");
      const daw = $("#proj-dispatch-aw");
      const idl = $("#proj-dispatch-idle-long");
      if (og) og.value = projNumToInput(p.dispatch_min_offer_gap_sec, 0);
      if (w1s) w1s.value = projNumToInput(p.dispatch_wave1_share, 3);
      if (w2s) w2s.value = projNumToInput(p.dispatch_wave2_share, 3);
      if (t2s) t2s.value = projNumToInput(p.dispatch_tier2_price_surge, 4);
      if (t3e) t3e.value = projNumToInput(p.dispatch_tier3_extra_price_surge, 4);
      if (dpen) dpen.value = projNumToInput(p.dispatch_decline_penalty_per_streak, 4);
      if (rfs) rfs.value = projNumToInput(p.dispatch_react_fast_sec, 1);
      if (rss) rss.value = projNumToInput(p.dispatch_react_slow_sec, 1);
      if (rfb) rfb.value = projNumToInput(p.dispatch_react_fast_bonus, 4);
      if (rslp) rslp.value = projNumToInput(p.dispatch_react_slow_penalty, 4);
      if (fkm) fkm.value = projNumToInput(p.dispatch_far_km_threshold, 2);
      if (fbn) fbn.value = projNumToInput(p.dispatch_far_priority_bonus, 4);
      if (ldp) ldp.value = projNumToInput(p.dispatch_load_penalty_per_trip, 4);
      if (drw) drw.value = projNumToInput(p.dispatch_priority_rating_weight, 3);
      if (daw) daw.value = projNumToInput(p.dispatch_priority_accept_sq_weight, 3);
      if (idl) idl.value = projNumToInput(p.dispatch_idle_long_sec, 0);
      const dds = $("#proj-dispatch-decline-scale");
      const tcap = $("#proj-dispatch-time-surge-cap");
      const tt15 = $("#proj-dispatch-time-t15");
      const tt30 = $("#proj-dispatch-time-t30");
      const tt45 = $("#proj-dispatch-time-t45");
      const tp15 = $("#proj-dispatch-time-p15");
      const tp30 = $("#proj-dispatch-time-p30");
      const tp45 = $("#proj-dispatch-time-p45");
      const sa = $("#proj-dispatch-solo-acc");
      const srt = $("#proj-dispatch-solo-rt");
      const ngk = $("#proj-dispatch-near-good-km");
      const nga = $("#proj-dispatch-near-good-acc");
      const ngr = $("#proj-dispatch-near-good-rt");
      const wmk = $("#proj-dispatch-wave-max-km");
      const trc = $("#proj-dispatch-trip-repeat-cd");
      const dwa = $("#proj-dispatch-distw-auto");
      const dwl = $("#proj-dispatch-distw-low-n");
      const dwh = $("#proj-dispatch-distw-high-n");
      const dws = $("#proj-dispatch-distw-sparse");
      const dwd = $("#proj-dispatch-distw-dense");
      const sdr = $("#proj-dispatch-score-dist-ref");
      const slr = $("#proj-dispatch-score-load-ref");
      const isw = $("#proj-dispatch-idle-score-w");
      const sbm = $("#proj-dispatch-stab-bonus");
      const sbv = $("#proj-dispatch-stab-var");
      const chs = $("#proj-dispatch-client-hint-sec");
      const cbp = $("#proj-dispatch-client-boost-pct");
      const cbm = $("#proj-dispatch-client-boost-mult");
      const w1m = $("#proj-dispatch-wave1-min");
      if (dds) dds.value = projNumToInput(p.dispatch_decline_penalty_scale, 4);
      if (tcap) tcap.value = projNumToInput(p.dispatch_time_surge_total_cap, 4);
      if (tt15) tt15.value = projNumToInput(p.dispatch_time_surge_at_15, 0);
      if (tt30) tt30.value = projNumToInput(p.dispatch_time_surge_at_30, 0);
      if (tt45) tt45.value = projNumToInput(p.dispatch_time_surge_at_45, 0);
      if (tp15) tp15.value = projNumToInput(p.dispatch_time_surge_pct_15, 4);
      if (tp30) tp30.value = projNumToInput(p.dispatch_time_surge_pct_30, 4);
      if (tp45) tp45.value = projNumToInput(p.dispatch_time_surge_pct_45, 4);
      if (sa) sa.value = projNumToInput(p.dispatch_solo_min_accept, 3);
      if (srt) srt.value = projNumToInput(p.dispatch_solo_min_rating, 2);
      if (ngk) ngk.value = projNumToInput(p.dispatch_near_good_km, 2);
      if (nga) nga.value = projNumToInput(p.dispatch_near_good_min_accept, 3);
      if (ngr) ngr.value = projNumToInput(p.dispatch_near_good_min_rating, 2);
      if (wmk) wmk.value = projNumToInput(p.dispatch_wave_max_pick_km, 2);
      if (trc) trc.value = projNumToInput(p.dispatch_trip_repeat_cooldown_sec, 0);
      if (dwa) dwa.value = projNumToInput(p.dispatch_distw_auto, 2);
      if (dwl) dwl.value = projNumToInput(p.dispatch_distw_density_low_n, 0);
      if (dwh) dwh.value = projNumToInput(p.dispatch_distw_density_high_n, 0);
      if (dws) dws.value = projNumToInput(p.dispatch_distw_sparse, 4);
      if (dwd) dwd.value = projNumToInput(p.dispatch_distw_dense, 4);
      if (sdr) sdr.value = projNumToInput(p.dispatch_score_dist_ref_km, 2);
      if (slr) slr.value = projNumToInput(p.dispatch_score_load_ref_trips, 2);
      if (isw) isw.value = projNumToInput(p.dispatch_idle_score_weight, 3);
      if (sbm) sbm.value = projNumToInput(p.dispatch_stability_bonus_max, 4);
      if (sbv) sbv.value = projNumToInput(p.dispatch_stability_var_threshold, 4);
      if (chs) chs.value = projNumToInput(p.dispatch_client_slow_hint_sec, 0);
      if (cbp) cbp.value = projNumToInput(p.dispatch_client_boost_pct, 4);
      if (cbm) cbm.value = projNumToInput(p.dispatch_client_boost_price_mult, 4);
      if (w1m) w1m.value = projNumToInput(p.dispatch_wave1_min_size, 0);
      if (tj) {
        const raw = p.pricing_km_tiers_json;
        if (raw && String(raw).trim()) {
          try {
            tj.value = JSON.stringify(JSON.parse(String(raw)), null, 2);
          } catch (_) {
            tj.value = String(raw);
          }
        } else tj.value = "";
      }
      const wdp = $("#proj-wd-msg-pending");
      const wdpr = $("#proj-wd-msg-processing");
      const wdc = $("#proj-wd-msg-completed");
      const wdr = $("#proj-wd-msg-rejected");
      if (wdp) wdp.value = p.withdrawal_timeline_pending || "";
      if (wdpr) wdpr.value = p.withdrawal_timeline_processing || "";
      if (wdc) wdc.value = p.withdrawal_timeline_completed || "";
      if (wdr) wdr.value = p.withdrawal_timeline_rejected || "";
    } catch (e) {
      console.error(e);
    }
  }

  async function loadLogs() {
    const data = await api("/admin/logs?limit=80");
    const rows = (data.items || []).map((l) => [
      esc(formatAdminDatetime(new Date((l.ts || 0) * 1000).toISOString())),
      esc(l.action),
      esc(l.detail),
    ]);
    renderTable($("#table-logs"), ["Время", "Действие", "Детали"], rows);
  }

  async function loadPushTemplates() {
    const root = $("#push-templates-list");
    if (!root) return;
    root.innerHTML = '<p class="muted">Загрузка…</p>';
    try {
      const data = await api("/admin/push-templates");
      const items = data.items || [];
      if (!items.length) {
        root.innerHTML =
          '<p class="muted">Шаблоны не найдены. Перезапустите сервер, чтобы применилась миграция таблицы.</p>';
        return;
      }
      root.innerHTML = items
        .map((it) => {
          const keyRaw = String(it.event_key || "");
          const key = escAttr(keyRaw);
          const hint =
            it.placeholder_help == null
              ? ""
              : String(it.placeholder_help).replace(/\r\n/g, "\n").trim();
          const hintHtml = hint
            ? esc(hint)
            : '<span class="muted">Нет встроенной справки (обновите сервер). Подстановки в фигурных скобках, как в Python format.</span>';
          return (
            '<article class="card-panel" style="margin-bottom:1rem;padding:1rem">' +
            '<h4 class="settings-h" style="margin-top:0"><code class="mono">' +
            esc(keyRaw) +
            "</code></h4>" +
            '<p class="muted" style="margin:0.25rem 0 0.75rem;font-size:0.9rem">Плейсхолдеры: ' +
            hintHtml +
            "</p>" +
            '<label class="set-row"><span>Заголовок</span><input type="text" class="drivers-search push-tpl-title" style="max-width:100%" data-push-key="' +
            key +
            '" value="' +
            escAttr(it.title_template) +
            '" /></label>' +
            '<label class="set-row"><span>Текст</span><textarea class="drivers-search push-tpl-body" rows="3" style="max-width:100%;min-height:3.5rem" data-push-key="' +
            key +
            '">' +
            esc(it.body_template) +
            "</textarea></label>" +
            '<label class="set-row"><span>Подзаголовок</span><input type="text" class="drivers-search push-tpl-subtitle" style="max-width:100%" maxlength="500" data-push-key="' +
            key +
            '" value="' +
            escAttr(it.subtitle_template != null ? String(it.subtitle_template) : "") +
            '" placeholder="Необязательно; поддержка зависит от ОС/браузера" /></label>' +
            '<button type="button" class="btn-secondary btn-push-tpl-save" data-push-key="' +
            key +
            '"><i class="fa-solid fa-floppy-disk"></i> Сохранить</button>' +
            "</article>"
          );
        })
        .join("");
      root.querySelectorAll(".btn-push-tpl-save").forEach((btn) => {
        btn.addEventListener("click", async () => {
          const k = btn.getAttribute("data-push-key");
          if (!k) return;
          const titleEl = root.querySelector('.push-tpl-title[data-push-key="' + k + '"]');
          const bodyEl = root.querySelector('.push-tpl-body[data-push-key="' + k + '"]');
          const subEl = root.querySelector('.push-tpl-subtitle[data-push-key="' + k + '"]');
          if (!titleEl || !bodyEl) return;
          try {
            await api("/admin/push-templates/" + encodeURIComponent(k), {
              method: "PATCH",
              body: JSON.stringify({
                title_template: titleEl.value,
                body_template: bodyEl.value,
                subtitle_template: subEl ? subEl.value : "",
              }),
            });
            alert("Шаблон «" + k + "» сохранён.");
          } catch (e) {
            alert(e.message || String(e));
          }
        });
      });
    } catch (e) {
      root.innerHTML = '<p class="error-text">' + esc(e.message || String(e)) + "</p>";
    }
  }

  function stopDashTimer() {
    if (dashTimer) {
      clearInterval(dashTimer);
      dashTimer = null;
    }
  }

  function startDashTimer() {
    stopDashTimer();
    const p = getPrefs();
    if (!p.autoDash) return;
    const sec = Math.max(10, parseInt(String(p.dashInterval || 30), 10) || 30);
    dashTimer = setInterval(() => {
      const cur =
        (location.hash || "#/dashboard").replace(/^#\/?/, "").split("/")[0] ||
        "dashboard";
      if (cur === "dashboard") loadDashboard().catch(() => {});
    }, sec * 1000);
  }

  async function loadAnalytics() {
    const [an, st] = await Promise.all([api("/admin/analytics"), api("/admin/stats")]);
    const dump = $("#analytics-dump");
    if (dump) dump.textContent = JSON.stringify({ analytics: an, stats: st }, null, 2);

    if (typeof Chart === "undefined") return;

    const byDay = {};
    (an.trips_created_by_day || []).forEach((x) => {
      const dk = x.date;
      const key =
        typeof dk === "string"
          ? dk.slice(0, 10)
          : dk && dk.toString
            ? dk.toString().slice(0, 10)
            : "";
      if (key) byDay[key] = x.count;
    });
    const labels7 = [];
    const keys7 = [];
    const data7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setHours(12, 0, 0, 0);
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10);
      keys7.push(key);
      labels7.push(
        d.toLocaleDateString("ru-RU", { weekday: "short", day: "numeric", month: "short" })
      );
      data7.push(byDay[key] || 0);
    }
    function series7(rows, dateKey, valKey) {
      const m = {};
      (rows || []).forEach((x) => {
        const dk = String(x[dateKey] || "").slice(0, 10);
        if (dk) m[dk] = Number(x[valKey]) || 0;
      });
      return keys7.map((k) => m[k] || 0);
    }

    const tripLabels = Object.keys(an.trips_by_status || {});
    const tripData = tripLabels.map((k) => (an.trips_by_status || {})[k]);

    const verObj = an.drivers_by_verification || {};
    const verLabels = Object.keys(verObj);
    const verData = verLabels.map((k) => verObj[k]);

    const commonOpts = {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 12, font: { size: 11 } } } },
    };

    [chartCompleted7d, chartRev7d, chartRefusals, chartReg7d].forEach((ch) => {
      if (ch) {
        try {
          ch.destroy();
        } catch (e) {}
      }
    });
    chartCompleted7d = null;
    chartRev7d = null;
    chartRefusals = null;
    chartReg7d = null;

    const strip = $("#analytics-strip");
    if (strip) {
      const refSum = (an.refusals_by_reason_30d || []).reduce((a, r) => a + (Number(r.count) || 0), 0);
      const fmtDevRows = (rows) => {
        if (!rows || !rows.length) return "—";
        return rows
          .slice(0, 10)
          .map((x) => esc(String(x.key)) + ": " + (Number(x.count) || 0))
          .join(" · ");
      };
      strip.innerHTML =
        '<div class="analytics-strip-grid">' +
        kvRow("Пользователей всего", st.total_users) +
        kvRow("Активных поездок", st.active_trips) +
        kvRow("Завершено / отменено (всего)", (an.trips_completed_total || 0) + " / " + (an.trips_cancelled_total || 0)) +
        kvRow("Доля отмен", (an.cancellation_share_pct || 0) + "%") +
        kvRow("Выручка completed (всего)", (st.revenue_completed_total || 0).toFixed(2)) +
        kvRow("Средняя длина завершённой, км", (st.avg_km_completed || 0).toFixed(2)) +
        kvRow("Отказов (топ-причин, 30 дн.)", refSum) +
        kvRow("Клиенты: платформа (все записи)", fmtDevRows(an.clients_device_platform)) +
        kvRow("Водители: платформа", fmtDevRows(an.drivers_device_platform)) +
        kvRow("Клиенты: топ размеров экрана", fmtDevRows(an.clients_device_screen)) +
        kvRow("Водители: топ размеров экрана", fmtDevRows(an.drivers_device_screen)) +
        "</div>";
    }

    if (chartTrips) chartTrips.destroy();
    chartTrips = null;
    const el1 = document.getElementById("chart-trips-status");
    if (el1) {
      const tl = tripLabels.length ? tripLabels : ["—"];
      const td = tripLabels.length ? tripData : [1];
      chartTrips = new Chart(el1, {
        type: "doughnut",
        data: {
          labels: tl,
          datasets: [
            {
              data: td,
              backgroundColor: [
                "#00ae50",
                "#0ea5e9",
                "#f59e0b",
                "#8b5cf6",
                "#64748b",
                "#ef4444",
                "#14b8a6",
              ],
            },
          ],
        },
        options: commonOpts,
      });
    }

    if (chartVer) chartVer.destroy();
    chartVer = null;
    const el2 = document.getElementById("chart-verif");
    if (el2) {
      const vl = verLabels.length ? verLabels : ["—"];
      const vd = verLabels.length ? verData : [1];
      chartVer = new Chart(el2, {
        type: "pie",
        data: {
          labels: vl,
          datasets: [
            {
              data: vd,
              backgroundColor: ["#fbbf24", "#00ae50", "#ef4444", "#94a3b8"],
            },
          ],
        },
        options: commonOpts,
      });
    }

    if (chart7d) chart7d.destroy();
    const el3 = document.getElementById("chart-trips-7d");
    if (el3) {
      chart7d = new Chart(el3, {
        type: "bar",
        data: {
          labels: labels7,
          datasets: [
            {
              label: "Поездок",
              data: data7,
              backgroundColor: "rgba(0, 174, 80, 0.55)",
              borderRadius: 8,
              borderSkipped: false,
            },
          ],
        },
        options: Object.assign({}, commonOpts, {
          scales: {
            y: { beginAtZero: true, ticks: { stepSize: 1 } },
            x: { grid: { display: false } },
          },
        }),
      });
    }

    const elC = document.getElementById("chart-completed-7d");
    if (elC) {
      const dC = series7(an.trips_completed_by_day, "date", "count");
      chartCompleted7d = new Chart(elC, {
        type: "bar",
        data: {
          labels: labels7,
          datasets: [
            {
              label: "Завершено",
              data: dC,
              backgroundColor: "rgba(14, 165, 233, 0.55)",
              borderRadius: 8,
            },
          ],
        },
        options: Object.assign({}, commonOpts, {
          scales: {
            y: { beginAtZero: true, ticks: { stepSize: 1 } },
            x: { grid: { display: false } },
          },
        }),
      });
    }

    const elR = document.getElementById("chart-rev-7d");
    if (elR) {
      const dR = series7(an.revenue_completed_by_day, "date", "revenue");
      chartRev7d = new Chart(elR, {
        type: "bar",
        data: {
          labels: labels7,
          datasets: [
            {
              label: "Выручка",
              data: dR,
              backgroundColor: "rgba(234, 179, 8, 0.65)",
              borderRadius: 8,
            },
          ],
        },
        options: Object.assign({}, commonOpts, {
          scales: {
            y: { beginAtZero: true },
            x: { grid: { display: false } },
          },
        }),
      });
    }

    const elRf = document.getElementById("chart-refusals");
    if (elRf) {
      const rr = an.refusals_by_reason_30d || [];
      const rl = rr.length ? rr.map((x) => String(x.reason_type).slice(0, 28)) : ["—"];
      const rd = rr.length ? rr.map((x) => x.count) : [0];
      chartRefusals = new Chart(elRf, {
        type: "bar",
        data: {
          labels: rl,
          datasets: [
            {
              label: "Шт.",
              data: rd,
              backgroundColor: "rgba(239, 68, 68, 0.55)",
              borderRadius: 6,
            },
          ],
        },
        options: Object.assign({}, commonOpts, {
          indexAxis: "y",
          scales: {
            x: { beginAtZero: true, ticks: { stepSize: 1 } },
            y: { grid: { display: false } },
          },
        }),
      });
    }

    const elRg = document.getElementById("chart-reg-7d");
    if (elRg) {
      chartReg7d = new Chart(elRg, {
        type: "bar",
        data: {
          labels: labels7,
          datasets: [
            {
              label: "Новые клиенты",
              data: series7(an.new_clients_by_day, "date", "count"),
              backgroundColor: "rgba(99, 102, 241, 0.55)",
              borderRadius: 8,
            },
            {
              label: "Новые водители",
              data: series7(an.new_drivers_by_day, "date", "count"),
              backgroundColor: "rgba(16, 185, 129, 0.55)",
              borderRadius: 8,
            },
          ],
        },
        options: Object.assign({}, commonOpts, {
          scales: {
            y: { beginAtZero: true, ticks: { stepSize: 1 } },
            x: { grid: { display: false } },
          },
        }),
      });
    }
  }

  function closeMobileNav() {
    const sb = $("#sidebar");
    const bd = $("#sidebar-backdrop");
    if (sb) sb.classList.remove("open");
    if (bd) bd.classList.remove("visible");
  }
  function openMobileNav() {
    const sb = $("#sidebar");
    const bd = $("#sidebar-backdrop");
    if (sb) sb.classList.add("open");
    if (bd) bd.classList.add("visible");
  }

  function showView(name) {
    document.querySelectorAll(".view").forEach((v) => v.classList.add("hidden"));
    document.querySelectorAll(".nav a").forEach((a) => a.classList.remove("active"));
    const titles = {
      dashboard: "Dashboard",
      map: "Карта",
      drivers: "Drivers",
      clients: "Clients",
      trips: "Trips",
      transactions: "Транзакция",
      analytics: "Analytics",
      push: "Push-уведомления",
      settings: "Settings",
    };
    $("#page-title").textContent = titles[name] || name;
    const el = $("#view-" + name);
    if (el) el.classList.remove("hidden");
    const link = document.querySelector('.nav a[data-route="' + name + '"]');
    if (link) link.classList.add("active");
  }

  async function routeTo(name) {
    closeMobileNav();
    showView(name);
    try {
      stopDashTimer();
      if (name === "dashboard") {
        await loadDashboard();
        startDashTimer();
      }
      if (name === "map") {
        ensureMap();
        if (!mapPrefsApplied) {
          const p = getPrefs();
          if ($("#tog-heatmap") && p.defaultHeatmap) $("#tog-heatmap").checked = true;
          if ($("#tog-routes") && p.defaultRoutes) $("#tog-routes").checked = true;
          mapPrefsApplied = true;
        }
        setTimeout(() => {
          if (map) map.invalidateSize();
        }, 250);
        await loadPositionsSnapshot();
        await refreshRouteLines();
        syncHeatmapLayer();
        if (!didInitialMapFit && markers.size > 0) {
          fitMapToMarkers();
          didInitialMapFit = true;
        }
      }
      if (name === "drivers") await loadDrivers();
      if (name === "clients") await loadClients();
      if (name === "trips") await loadTrips();
      if (name === "transactions") await loadWithdrawals();
      if (name === "analytics") await loadAnalytics();
      if (name === "push") await loadPushTemplates();
      if (name === "settings") {
        await loadProjectSettings();
        applyPrefsToUI();
        await loadLogs();
      }
    } catch (e) {
      console.error(e);
    }
  }

  function connectSocket() {
    if (socket) socket.disconnect();
    socket = io(window.location.origin, {
      path: "/socket.io",
      transports: ["websocket", "polling"],
      auth: { token: token },
    });
    socket.on("connect", () => {
      setSocketBadge(true);
      const cur =
        (location.hash || "#/dashboard").replace(/^#\/?/, "").split("/")[0] ||
        "dashboard";
      if (cur === "dashboard") loadDashboard().catch(() => {});
    });
    socket.on("disconnect", () => setSocketBadge(false));
    socket.on("admin_event", (msg) => {
      if (!msg || typeof msg !== "object") return;
      if (msg.type === "admin_user_position") upsertMarker(msg);
      if (msg.type === "admin_driver_status") updateDriverStatusOnly(msg);
      if (msg.type === "admin_trip_created") {
        const p = getPrefs();
        if (p.soundTrip && typeof Audio !== "undefined") {
          try {
            const a = new Audio(
              "data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA"
            );
            a.volume = 0.15;
            a.play().catch(() => {});
          } catch (e) {}
        }
        if (!$("#tog-routes").checked) return;
        scheduleRouteRefresh();
      }
      if (msg.type === "admin_driver_status" && $("#tog-routes") && $("#tog-routes").checked) {
        scheduleRouteRefresh();
      }
    });
  }

  function bindNav() {
    window.addEventListener("hashchange", () => {
      const h = (location.hash || "#/dashboard").slice(2) || "dashboard";
      routeTo(h.split("/")[0] || "dashboard");
    });
    document.querySelectorAll(".nav a[data-route]").forEach((a) => {
      a.addEventListener("click", () => {
        closeMobileNav();
        setTimeout(() => {
          const h = (location.hash || "#/dashboard").slice(2) || "dashboard";
          routeTo(h.split("/")[0] || "dashboard");
        }, 0);
      });
    });
  }

  $("#login-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    $("#login-error").textContent = "";
    try {
      const body = {
        username: $("#login-user").value.trim(),
        password: $("#login-pass").value,
      };
      const r = await fetch("/admin/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) {
        $("#login-error").textContent = "Неверный логин или пароль";
        return;
      }
      const data = await r.json();
      token = data.access_token;
      localStorage.setItem(LS, token);
      $("#login-screen").classList.add("hidden");
      $("#app").classList.remove("hidden");
      applyPrefsToUI();
      connectSocket();
      const h = (location.hash || "#/dashboard").replace("#/", "") || "dashboard";
      routeTo(h.split("/")[0]);
    } catch (e) {
      $("#login-error").textContent = String(e.message || e);
    }
  });

  $("#btn-logout").addEventListener("click", logout);

  [
    "tog-drivers",
    "tog-clients",
    "tog-routes",
    "tog-heatmap",
    "filt-online",
    "filt-busy",
  ].forEach((id) => {
    const el = $("#" + id);
    if (el)
      el.addEventListener("change", () => {
        applyMarkerVisibility();
        if (id === "tog-routes") refreshRouteLines();
        if (id === "tog-heatmap") syncHeatmapLayer();
      });
  });

  $("#btn-refresh-map").addEventListener("click", () => {
    loadPositionsSnapshot();
    refreshRouteLines();
  });

  const btnFit = $("#btn-map-fit");
  if (btnFit) btnFit.addEventListener("click", () => fitMapToMarkers());

  const btnDash = $("#btn-dash-refresh");
  if (btnDash) btnDash.addEventListener("click", () => loadDashboard());

  $("#map-search").addEventListener("input", () => {
    const q = $("#map-search").value.trim();
    if (!q) {
      markers.forEach((m) => m.setOpacity(1));
      return;
    }
    markers.forEach((m, key) => {
      const hit = key.includes(":" + q) || key.endsWith(":" + q);
      m.setOpacity(hit ? 1 : 0.2);
    });
  });

  $("#btn-drivers-load").addEventListener("click", () => loadDrivers());
  $("#btn-clients-load").addEventListener("click", () => loadClients());
  $("#btn-trips-load").addEventListener("click", () => loadTrips());

  $("#modal").addEventListener("click", (ev) => {
    if (ev.target.getAttribute("data-close")) $("#modal").classList.add("hidden");
  });
  const docModal = $("#doc-modal");
  if (docModal) {
    docModal.addEventListener("click", (ev) => {
      if (ev.target.getAttribute("data-doc-close")) closeDocModal();
    });
  }

  const editModal = $("#admin-edit-modal");
  if (editModal) {
    editModal.addEventListener("click", (ev) => {
      if (ev.target.getAttribute("data-edit-close")) closeAdminEditModal();
    });
  }
  const btnEditSave = $("#btn-admin-edit-save");
  if (btnEditSave) btnEditSave.addEventListener("click", () => submitAdminEdit().catch(console.error));

  const delModal = $("#delete-confirm-modal");
  if (delModal) {
    delModal.addEventListener("click", (ev) => {
      if (ev.target.getAttribute("data-del-close")) closeDeleteConfirmModal();
    });
  }
  const btnDelConf = $("#btn-delete-confirm");
  if (btnDelConf) {
    btnDelConf.addEventListener("click", () => {
      const fn = deleteConfirmAction;
      closeDeleteConfirmModal();
      if (fn) Promise.resolve(fn()).catch((e) => alert(e.message || String(e)));
    });
  }

  bindNav();

  window.addEventListener("resize", () => {
    if (window.innerWidth > 900) closeMobileNav();
  });

  const burger = $("#nav-burger");
  if (burger) {
    burger.addEventListener("click", () => {
      const sb = $("#sidebar");
      if (sb && sb.classList.contains("open")) closeMobileNav();
      else openMobileNav();
    });
  }
  const sbd = $("#sidebar-backdrop");
  if (sbd) sbd.addEventListener("click", closeMobileNav);

  const btnPushReload = $("#btn-push-templates-reload");
  if (btnPushReload) {
    btnPushReload.addEventListener("click", () => loadPushTemplates().catch(console.error));
  }
  const btnPushTest = $("#btn-push-test-send");
  if (btnPushTest) {
    btnPushTest.addEventListener("click", async () => {
      const out = $("#push-test-result");
      const uid = parseInt(($("#push-test-user-id") && $("#push-test-user-id").value) || "0", 10);
      const ut = ($("#push-test-user-type") && $("#push-test-user-type").value) || "driver";
      if (!uid || uid < 1) {
        if (out) {
          out.innerHTML =
            '<div class="push-res push-res--warn"><i class="fa-solid fa-triangle-exclamation"></i><div class="push-res-body"><div class="push-res-title">Неверный ID</div><div class="push-res-desc">Укажите корректный ID пользователя.</div></div></div>';
        }
        return;
      }
      try {
        if (out) {
          out.innerHTML =
            '<div class="push-res push-res--pending"><i class="fa-solid fa-spinner fa-spin"></i><div class="push-res-body"><div class="push-res-title">Отправляем…</div><div class="push-res-desc">Ждём ответ сервера.</div></div></div>';
        }
        const res = await api("/admin/push/test", {
          method: "POST",
          body: JSON.stringify({
            user_type: ut,
            user_id: uid,
            title: ($("#push-test-title") && $("#push-test-title").value) || "Тест",
            body: ($("#push-test-body") && $("#push-test-body").value) || "",
            subtitle: ($("#push-test-subtitle") && $("#push-test-subtitle").value) || "",
            url: ($("#push-test-url") && $("#push-test-url").value) || "/",
          }),
        });
        if (out) {
          const n = res.delivered_to_subscriptions != null ? res.delivered_to_subscriptions : 0;
          const s =
            res.subscriptions_in_db != null
              ? res.subscriptions_in_db
              : "—";
          const subsNum = typeof s === "number" ? s : parseInt(String(s), 10);
          let tone = "warn";
          let icon = "fa-triangle-exclamation";
          let title = "Результат отправки";
          let desc =
            "Если подписок 0 — зайдите в PWA под этим ID на этом же сайте и включите уведомления. Если подписок >0, а успехов 0 — проверьте VAPID и исходящий HTTPS с сервера к push‑провайдеру.";
          if (Number.isFinite(subsNum) && subsNum <= 0) {
            tone = "warn";
            icon = "fa-user-slash";
            title = "Нет подписок";
            desc = "Подписок нет. Откройте PWA под этим пользователем и включите уведомления, затем повторите тест.";
          } else if (n > 0) {
            tone = "ok";
            icon = "fa-circle-check";
            title = "Отправлено";
            desc =
              "Есть успешные ответы от push‑провайдера. Если уведомление не всплыло — проверьте режимы «Не беспокоить»/фокус и настройки уведомлений приложения.";
          } else {
            tone = "bad";
            icon = "fa-circle-xmark";
            title = "Не доставлено";
            desc =
              "Подписки есть, но успешных отправок нет. Проверьте VAPID и исходящий HTTPS с сервера к push‑провайдеру (и логи сервера).";
          }
          out.innerHTML =
            '<div class="push-res push-res--' +
            tone +
            '"><i class="fa-solid ' +
            icon +
            '"></i><div class="push-res-body"><div class="push-res-title">' +
            esc(title) +
            '</div><div class="push-res-kv">' +
            '<span class="push-pill"><i class="fa-solid fa-database"></i> Подписок: <b>' +
            esc(s) +
            '</b></span>' +
            '<span class="push-pill"><i class="fa-solid fa-paper-plane"></i> Успешно: <b>' +
            esc(n) +
            '</b></span>' +
            '<span class="push-pill"><i class="fa-solid fa-id-badge"></i> ' +
            esc(ut) +
            ' <b>ID:</b> ' +
            esc(uid) +
            "</span></div><div class=\"push-res-desc\">" +
            esc(desc) +
            "</div></div></div>";
        }
      } catch (e) {
        if (out) {
          out.innerHTML =
            '<div class="push-res push-res--bad"><i class="fa-solid fa-bug"></i><div class="push-res-body"><div class="push-res-title">Ошибка</div><div class="push-res-desc mono">' +
            esc(String(e && (e.message || e))) +
            "</div></div></div>";
        }
      }
    });
  }

  const btnProjSave = $("#btn-proj-settings-save");
  if (btnProjSave) {
    btnProjSave.addEventListener("click", async () => {
      try {
        const rawKm = ($("#proj-price-per-km") && $("#proj-price-per-km").value) || "";
        const rawBase = ($("#proj-trip-base") && $("#proj-trip-base").value) || "";
        const rawT = ($("#proj-dispatch-timeout") && $("#proj-dispatch-timeout").value) || "";
        const rawW = ($("#proj-dispatch-wave-size") && $("#proj-dispatch-wave-size").value) || "";
        const rawPm = ($("#proj-pricing-per-min") && $("#proj-pricing-per-min").value) || "";
        const rawMn = ($("#proj-pricing-min-price") && $("#proj-pricing-min-price").value) || "";
        const rawLk = ($("#proj-pricing-long-km") && $("#proj-pricing-long-km").value) || "";
        const rawLf = ($("#proj-pricing-long-floor") && $("#proj-pricing-long-floor").value) || "";
        const rawLpc = ($("#proj-pricing-long-post-cap") && $("#proj-pricing-long-post-cap").value) || "";
        const rawLmw = ($("#proj-pricing-long-max-wave") && $("#proj-pricing-long-max-wave").value) || "";
        const rawNbd = ($("#proj-pricing-nearby-km") && $("#proj-pricing-nearby-km").value) || "";
        const rawRefh = ($("#proj-pricing-ref-high") && $("#proj-pricing-ref-high").value) || "";
        const rawRefl = ($("#proj-pricing-ref-low") && $("#proj-pricing-ref-low").value) || "";
        const rawRsk = ($("#proj-pricing-ref-short-max-km") && $("#proj-pricing-ref-short-max-km").value) || "";
        const rawRsp = ($("#proj-pricing-ref-short-pkm") && $("#proj-pricing-ref-short-pkm").value) || "";
        const rawDw = ($("#proj-dispatch-dist-w") && $("#proj-dispatch-dist-w").value) || "";
        const rawTiers = ($("#proj-pricing-km-tiers-json") && $("#proj-pricing-km-tiers-json").value) || "";
        const body = {};
        if (rawKm.trim() !== "") {
          const v = parseFloat(rawKm.replace(",", "."));
          if (!Number.isNaN(v)) body.price_per_km = v;
        }
        if (rawBase.trim() !== "") {
          const v = parseFloat(rawBase.replace(",", "."));
          if (!Number.isNaN(v)) body.trip_base_fee = v;
        }
        if (rawT.trim() !== "") {
          const v = parseInt(rawT, 10);
          if (!Number.isNaN(v)) body.dispatch_wave_timeout_sec = v;
        }
        if (rawW.trim() !== "") {
          const v = parseInt(rawW, 10);
          if (!Number.isNaN(v)) body.dispatch_wave_size = v;
        }
        if (rawPm.trim() !== "") {
          const v = parseFloat(rawPm.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_per_minute_azn = v;
        }
        if (rawMn.trim() !== "") {
          const v = parseFloat(rawMn.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_min_price_azn = v;
        }
        if (rawLk.trim() !== "") {
          const v = parseFloat(rawLk.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_long_trip_km_threshold = v;
        }
        if (rawLf.trim() !== "") {
          const v = parseFloat(rawLf.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_long_trip_floor_per_km = v;
        }
        if (rawLpc.trim() !== "") {
          const v = parseFloat(rawLpc.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_long_trip_post_cap_mult = v;
        }
        if (rawLmw.trim() !== "") {
          const v = parseFloat(rawLmw.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_long_trip_max_wave_mult = v;
        }
        if (rawNbd.trim() !== "") {
          const v = parseFloat(rawNbd.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_quote_nearby_driver_km = v;
        }
        if (rawRefh.trim() !== "") {
          const v = parseFloat(rawRefh.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_market_ref_high_mult = v;
        }
        if (rawRefl.trim() !== "") {
          const v = parseFloat(rawRefl.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_market_ref_low_mult = v;
        }
        if (rawRsk.trim() !== "") {
          const v = parseFloat(rawRsk.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_market_ref_short_max_km = v;
        }
        if (rawRsp.trim() !== "") {
          const v = parseFloat(rawRsp.replace(",", "."));
          if (!Number.isNaN(v)) body.pricing_market_ref_pkm_short = v;
        }
        if (rawDw.trim() !== "") {
          const v = parseFloat(rawDw.replace(",", "."));
          if (!Number.isNaN(v)) body.dispatch_priority_dist_weight = v;
        }
        const numBody = (id, key) => {
          const el = $(id);
          const raw = (el && el.value) || "";
          if (raw.trim() === "") return;
          const v = parseFloat(String(raw).replace(",", "."));
          if (!Number.isNaN(v)) body[key] = v;
        };
        numBody("#proj-dispatch-offer-gap", "dispatch_min_offer_gap_sec");
        numBody("#proj-dispatch-wave1-share", "dispatch_wave1_share");
        numBody("#proj-dispatch-wave2-share", "dispatch_wave2_share");
        numBody("#proj-dispatch-tier2-sur", "dispatch_tier2_price_surge");
        numBody("#proj-dispatch-tier3-extra", "dispatch_tier3_extra_price_surge");
        numBody("#proj-dispatch-decline-pen", "dispatch_decline_penalty_per_streak");
        numBody("#proj-dispatch-react-fast", "dispatch_react_fast_sec");
        numBody("#proj-dispatch-react-slow", "dispatch_react_slow_sec");
        numBody("#proj-dispatch-react-fast-b", "dispatch_react_fast_bonus");
        numBody("#proj-dispatch-react-slow-p", "dispatch_react_slow_penalty");
        numBody("#proj-dispatch-far-km", "dispatch_far_km_threshold");
        numBody("#proj-dispatch-far-bonus", "dispatch_far_priority_bonus");
        numBody("#proj-dispatch-load-pen", "dispatch_load_penalty_per_trip");
        numBody("#proj-dispatch-rw", "dispatch_priority_rating_weight");
        numBody("#proj-dispatch-aw", "dispatch_priority_accept_sq_weight");
        numBody("#proj-dispatch-idle-long", "dispatch_idle_long_sec");
        numBody("#proj-dispatch-decline-scale", "dispatch_decline_penalty_scale");
        numBody("#proj-dispatch-time-surge-cap", "dispatch_time_surge_total_cap");
        numBody("#proj-dispatch-time-t15", "dispatch_time_surge_at_15");
        numBody("#proj-dispatch-time-t30", "dispatch_time_surge_at_30");
        numBody("#proj-dispatch-time-t45", "dispatch_time_surge_at_45");
        numBody("#proj-dispatch-time-p15", "dispatch_time_surge_pct_15");
        numBody("#proj-dispatch-time-p30", "dispatch_time_surge_pct_30");
        numBody("#proj-dispatch-time-p45", "dispatch_time_surge_pct_45");
        numBody("#proj-dispatch-solo-acc", "dispatch_solo_min_accept");
        numBody("#proj-dispatch-solo-rt", "dispatch_solo_min_rating");
        numBody("#proj-dispatch-near-good-km", "dispatch_near_good_km");
        numBody("#proj-dispatch-near-good-acc", "dispatch_near_good_min_accept");
        numBody("#proj-dispatch-near-good-rt", "dispatch_near_good_min_rating");
        numBody("#proj-dispatch-wave-max-km", "dispatch_wave_max_pick_km");
        numBody("#proj-dispatch-trip-repeat-cd", "dispatch_trip_repeat_cooldown_sec");
        numBody("#proj-dispatch-distw-auto", "dispatch_distw_auto");
        numBody("#proj-dispatch-distw-low-n", "dispatch_distw_density_low_n");
        numBody("#proj-dispatch-distw-high-n", "dispatch_distw_density_high_n");
        numBody("#proj-dispatch-distw-sparse", "dispatch_distw_sparse");
        numBody("#proj-dispatch-distw-dense", "dispatch_distw_dense");
        numBody("#proj-dispatch-score-dist-ref", "dispatch_score_dist_ref_km");
        numBody("#proj-dispatch-score-load-ref", "dispatch_score_load_ref_trips");
        numBody("#proj-dispatch-idle-score-w", "dispatch_idle_score_weight");
        numBody("#proj-dispatch-stab-bonus", "dispatch_stability_bonus_max");
        numBody("#proj-dispatch-stab-var", "dispatch_stability_var_threshold");
        numBody("#proj-dispatch-client-hint-sec", "dispatch_client_slow_hint_sec");
        numBody("#proj-dispatch-client-boost-pct", "dispatch_client_boost_pct");
        numBody("#proj-dispatch-client-boost-mult", "dispatch_client_boost_price_mult");
        numBody("#proj-dispatch-wave1-min", "dispatch_wave1_min_size");
        if (rawTiers.trim() !== "") {
          try {
            JSON.parse(rawTiers);
            body.pricing_km_tiers_json = rawTiers.trim();
          } catch (_) {
            alert("JSON ступеней км невалиден. Проверьте формат.");
            return;
          }
        }
        if (!Object.keys(body).length) {
          alert("Укажите хотя бы одно поле для сохранения.");
          return;
        }
        await api("/admin/project-settings", {
          method: "PATCH",
          body: JSON.stringify(body),
        });
        await loadProjectSettings();
        alert("Настройки проекта сохранены.");
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  }

  const btnWdMsgsSave = $("#btn-withdrawal-msgs-save");
  if (btnWdMsgsSave) {
    btnWdMsgsSave.addEventListener("click", async () => {
      try {
        const pending = ($("#proj-wd-msg-pending") && $("#proj-wd-msg-pending").value) || "";
        const processing = ($("#proj-wd-msg-processing") && $("#proj-wd-msg-processing").value) || "";
        const completed = ($("#proj-wd-msg-completed") && $("#proj-wd-msg-completed").value) || "";
        const rejected = ($("#proj-wd-msg-rejected") && $("#proj-wd-msg-rejected").value) || "";
        if (!pending.trim() || !processing.trim() || !completed.trim() || !rejected.trim()) {
          alert("Заполните все четыре текста (не пустые строки).");
          return;
        }
        await api("/admin/project-settings/withdrawal-messages", {
          method: "PATCH",
          body: JSON.stringify({
            withdrawal_timeline_pending: pending.trim(),
            withdrawal_timeline_processing: processing.trim(),
            withdrawal_timeline_completed: completed.trim(),
            withdrawal_timeline_rejected: rejected.trim(),
          }),
        });
        await loadProjectSettings();
        alert("Тексты вывода сохранены.");
      } catch (e) {
        alert(e.message || String(e));
      }
    });
  }

  const btnSetSave = $("#btn-settings-save");
  if (btnSetSave) {
    btnSetSave.addEventListener("click", () => {
      setPrefs({
        darkMode: $("#set-dark-mode") ? $("#set-dark-mode").checked : false,
        autoDash: $("#set-auto-dash").checked,
        dashInterval: parseInt($("#set-dash-interval").value, 10) || 30,
        defaultHeatmap: $("#set-def-heat").checked,
        defaultRoutes: $("#set-def-routes").checked,
        compactTables: $("#set-compact").checked,
        mapToast: $("#set-toast").checked,
        soundTrip: $("#set-sound").checked,
        heatmapRainbow: $("#set-heat-rainbow") ? $("#set-heat-rainbow").checked : true,
        heatmapRadius: parseInt($("#set-heat-radius") && $("#set-heat-radius").value, 10) || 56,
        heatmapBlur: parseInt($("#set-heat-blur") && $("#set-heat-blur").value, 10) || 32,
      });
      applyPrefsToUI();
      startDashTimer();
      if (map) syncHeatmapLayer();
      alert("Настройки сохранены в браузере.");
    });
  }

  ["drivers-ver-filter", "drivers-sort-by", "drivers-sort-dir"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => loadDrivers().catch(console.error));
  });
  let driversSearchTimer;
  const dq = $("#drivers-q");
  if (dq) {
    dq.addEventListener("input", () => {
      clearTimeout(driversSearchTimer);
      driversSearchTimer = setTimeout(() => loadDrivers().catch(console.error), 400);
    });
  }
  let clientsSearchTimer;
  const cq = $("#clients-q");
  if (cq) {
    cq.addEventListener("input", () => {
      clearTimeout(clientsSearchTimer);
      clientsSearchTimer = setTimeout(() => loadClients().catch(console.error), 400);
    });
  }
  ["clients-sort-by", "clients-sort-dir"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => loadClients().catch(console.error));
  });
  ["trips-sort-by", "trips-sort-dir"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener("change", () => loadTrips().catch(console.error));
  });
  const wdf = $("#wd-status-filter");
  if (wdf) wdf.addEventListener("change", () => loadWithdrawals().catch(console.error));
  const btnWd = $("#btn-withdrawals-load");
  if (btnWd) btnWd.addEventListener("click", () => loadWithdrawals().catch(console.error));

  if (token) {
    $("#login-screen").classList.add("hidden");
    $("#app").classList.remove("hidden");
    applyPrefsToUI();
    connectSocket();
    const h = (location.hash || "#/dashboard").replace("#/", "") || "dashboard";
    routeTo(h.split("/")[0]);
  }
})();
