function profileImageSrc(b64, fallback = '/static/images/modal-taxi-car-photo.png') {
    if (!b64) return fallback;
    const s = String(b64);
    if (s.startsWith('http') || s.startsWith('data:')) return s;
    let mime = 'image/png';
    if (s.startsWith('/9j')) mime = 'image/jpeg';
    else if (s.startsWith('iVBOR')) mime = 'image/png';
    else if (s.startsWith('RklGR') || s.startsWith('UklGR')) mime = 'image/webp';
    return `data:${mime};base64,${s}`;
}

function profileAvatarSrc(b64) {
    return profileImageSrc(b64, '/static/images/user-profile-avatar.png');
}
window.profileAvatarSrc = profileAvatarSrc;

function phoneLocalFromStored(full) {
    if (!full || typeof full !== 'string') return '';
    return full.replace(/^\+994\s*/i, '').trim();
}

/** ₼: целые без «.00», копейки только если есть дробная часть (не округляем). */
function formatMoneyAzFlexible(raw) {
    if (raw == null || raw === '') return '0';
    const str = String(raw).trim().replace(',', '.');
    if (!str) return '0';
    if (!/^-?\d*\.?\d*$/.test(str)) {
        const n = Number(str);
        if (!Number.isFinite(n)) return '0';
        return formatMoneyAzFlexible(String(n));
    }
    if (str === '-' || str === '.' || str === '-.') return '0';
    const neg = str.startsWith('-');
    const u = neg ? str.slice(1) : str;
    const [intRaw, fracRaw = ''] = u.split('.');
    const intPart = (intRaw || '0').replace(/^0+(?=\d)/, '') || '0';
    if (fracRaw === '') return (neg ? '-' : '') + intPart;
    const fracTrim = fracRaw.replace(/0+$/, '');
    if (fracTrim === '') return (neg ? '-' : '') + intPart;
    return (neg ? '-' : '') + intPart + '.' + fracTrim;
}

/** Баланс на экране: группы по 3 + узкий пробел, дробная часть как в formatMoneyAzFlexible. */
function formatMoneyAzDisplay(raw) {
    const flex = formatMoneyAzFlexible(raw);
    const neg = flex.startsWith('-');
    const body = neg ? flex.slice(1) : flex;
    const parts = body.split('.');
    const intRaw = parts[0] || '0';
    const frac = parts.length > 1 ? parts.slice(1).join('.') : undefined;
    const intDigits = String(intRaw).replace(/\D/g, '') || '0';
    const intNorm = intDigits.replace(/^0+(?=\d)/, '') || '0';
    const grouped = intNorm.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
    const num = frac !== undefined ? `${grouped}.${frac}` : grouped;
    return neg ? '-' + num : num;
}

function sanitizeMoneyInput(raw) {
    let s = String(raw || '').replace(',', '.');
    s = s.replace(/[^\d.]/g, '');
    const firstDot = s.indexOf('.');
    if (firstDot >= 0) {
        s = s.slice(0, firstDot + 1) + s.slice(firstDot + 1).replace(/\./g, '');
    }
    if (s.startsWith('.')) s = '0' + s;
    const m = s.match(/^(\d*)(\.)?(\d{0,2})?/);
    if (!m) return '';
    const intp = m[1] || '';
    const dot = m[2] || '';
    const frac = m[3] != null ? m[3] : '';
    if (!intp && !dot) return '';
    if (dot) {
        if (!intp && frac === '') return '0.';
        return (intp || '0') + '.' + frac;
    }
    return intp.replace(/^0+(?=\d)/, '') || (intp.includes('0') ? '0' : '');
}

function parseMoneyInputToNumber(s) {
    const t = stripMoneyDisplay(String(s || '')).trim();
    if (!t) return NaN;
    if (t.endsWith('.')) return NaN;
    const n = parseFloat(t);
    return Number.isFinite(n) ? n : NaN;
}

/** Убрать разделители тысяч и пробелы перед sanitize/parse. */
function stripMoneyDisplay(raw) {
    return String(raw || '')
        .replace(/\u202f/g, '')
        .replace(/\u00a0/g, ' ')
        .replace(/\s/g, '')
        .replace(',', '.');
}

function formatMoneyIntegerGrouped(intDigitsOnly) {
    const d = String(intDigitsOnly || '').replace(/\D/g, '');
    if (!d) return '';
    const norm = d.replace(/^0+(?=\d)/, '') || '0';
    return norm.replace(/\B(?=(\d{3})+(?!\d))/g, '\u202f');
}

/** Группы по 3 в целой части; до 2 знаков после точки (как sanitizeMoneyInput). */
function formatMoneyInputGrouped(sanitized) {
    if (!sanitized) return '';
    if (sanitized.endsWith('.')) {
        const head = sanitized.slice(0, -1);
        const g = formatMoneyIntegerGrouped(head);
        return (g === '' ? '0' : g) + '.';
    }
    const dot = sanitized.indexOf('.');
    if (dot < 0) return formatMoneyIntegerGrouped(sanitized) || '';
    const head = sanitized.slice(0, dot);
    const tail = sanitized.slice(dot + 1).slice(0, 2);
    const g = formatMoneyIntegerGrouped(head);
    return (g === '' ? '0' : g) + '.' + tail;
}

/** DD.MM HH:mm:ss (локальное время устройства). */
function formatPayoutAtShort(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return String(iso).replace('T', ' ').slice(0, 16);
    const day = String(d.getDate()).padStart(2, '0');
    const mon = String(d.getMonth() + 1).padStart(2, '0');
    const h = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    const s = String(d.getSeconds()).padStart(2, '0');
    return `${day}.${mon} ${h}:${mi}:${s}`;
}

/** Отправка метаданных устройства (экран, iOS/Android/Web, язык) для аналитики в админке. */
async function jiReportDeviceMeta() {
    try {
        const ut = localStorage.getItem('userType');
        if (ut !== 'client' && ut !== 'driver') return;
        const w = window.screen && window.screen.width ? window.screen.width : 0;
        const h = window.screen && window.screen.height ? window.screen.height : 0;
        const screen = w && h ? `${w}x${h}` : '';
        const ua = navigator.userAgent || '';
        let platform = 'web';
        if (/iPhone|iPad|iPod/i.test(ua)) platform = 'ios';
        else if (/Android/i.test(ua)) platform = 'android';
        const lang = (navigator.language || navigator.userLanguage || '').slice(0, 48);
        await fetch('/api/me/device', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ screen, platform, lang }),
        });
    } catch (_) {
        /* ignore */
    }
}
window.jiReportDeviceMeta = jiReportDeviceMeta;

async function readInputFileAsBase64(inputEl) {
    if (!inputEl || !inputEl.files || !inputEl.files[0]) return undefined;
    const file = inputEl.files[0];
    return new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => {
            const res = String(fr.result || '');
            const i = res.indexOf('base64,');
            resolve(i >= 0 ? res.slice(i + 7) : res);
        };
        fr.onerror = () => reject(new Error('read'));
        fr.readAsDataURL(file);
    });
}

class ProfileManager {
    constructor() {
        this.profileScreen = document.getElementById('profile-screen');
        this.profileStatus = document.getElementById('profileStatus');
        this.mainScreen = document.getElementById('main-screen');
        this.profileTemplate = document.getElementById('profile-template');
        this.tripsTemplate = document.getElementById('trips-template');
        this.registrationTemplate = document.getElementById('registration-required-template');
        /** @type {ReturnType<typeof setTimeout>|null} */
        this._peerRevealTimer = null;
        this._lastProfileTrips = null;
    }

    async loadProfileData() {
        try {
            const response = await fetch('/api/me', {
                credentials: 'include',
                method: 'post',
                headers: {'Content-Type': 'application/json'}});
            const data = await response.json();

            if (data.success) {
                localStorage.setItem("userType", data.user_type);
                localStorage.setItem("userID", data.user.id);
                if (typeof applySettingsRoadCamsRowVisibility === 'function') {
                    applySettingsRoadCamsRowVisibility();
                }
                this.displayProfile(data.user, data.user_type);
                void jiReportDeviceMeta();
                if (window.taxiServices?.restoreActiveOrderIfAny) {
                    window.taxiServices.restoreActiveOrderIfAny().catch(() => {});
                }
            }

            else {
                document.body.classList.remove('ji-settings-show-road-cams');
                this.displayRegistrationRequired();
            }
        
        } catch (error) {
            console.error('Ошибка загрузки профиля:', error);
            document.body.classList.remove('ji-settings-show-road-cams');
            this.displayRegistrationRequired();
        }
    }

    displayProfile(clientData, user_type) {
        const verState = user_type === 'driver' ? (clientData.verification || 'pending') : 'verified';
        const verification_status =
            verState === "pending" ? '<i class="fas fa-spinner fa-spin"></i> Yoxlanılır'
                : verState === "verified" ? '<i class="fas fa-check-circle" style></i> Təsdiqləndi'
                : verState === "refused" ? '<i class="fa-solid fa-circle-xmark"></i> Rədd edildi'
                : '<i class="fas fa-question-circle"></i> Naməlum';

        const rcoef = Number(clientData.ratio ?? clientData.rating_coefficient ?? 1);
        const ratioNum = Number.isFinite(rcoef) ? rcoef : 1;
        const ratio_display = `+${ratioNum.toFixed(2)}x`;
        const acc = Number(clientData.acceptance_rate ?? 0.75);
        const acceptance_pct = `${(Number.isFinite(acc) ? acc * 100 : 75).toFixed(0)}%`;
        let join_date = '—';
        if (clientData.joined_at) {
            const jd = new Date(clientData.joined_at);
            if (!Number.isNaN(jd.getTime())) join_date = this.formatDateAZ(clientData.joined_at);
        }
        const em = (clientData.email && String(clientData.email).trim()) || '';
        // Аватар в шаблон не подставляем (длинный base64/data URL ломает разбор HTML); выставим после вставки DOM.
        const profile_header_photo_display = 'none';
        const profile_header_icon_display = 'block';
        const profile_header_photo_src = '';

        const templateContent = this.profileTemplate.innerHTML;
        const filledTemplate = this.fillTemplate(templateContent, {
            name: clientData.name || 'Имя',
            surname: clientData.surname || 'Фамилия',
            phone: clientData.phone || 'Телефон не указан',
            rating: clientData.rating != null ? Number(clientData.rating).toFixed(1) : '0.0',
            balance: clientData.balance != null ? formatMoneyAzDisplay(clientData.balance) : '0',
            car_name: clientData.car_name,
            car_year: clientData.car_year,
            car_number: clientData.car_number,
            total_rides: clientData.total_rides || 0,
            total_distance: clientData.total_distance || 0,
            join_date,
            ratio: ratioNum.toFixed(2),
            ratio_display,
            acceptance_pct,
            status: clientData.status,
            verification_status: verification_status,
            accaunt_verified: verState,
            verification_class: verState,
            driver_online_status_available: clientData.status === "available" ? "available" : "",
            driver_online_status_offline: clientData.status === "offline" ? "offline" : "",
            car_front_photo: profileImageSrc(clientData.car_front_photo),
            avatar: profileAvatarSrc(clientData.avatar),
            driverDisplayStatus: user_type === "driver" ? "block" : "none",
            clientDisplayStatus: user_type === "client" ? "block" : "none",
            car_category: clientData.car_category,
            client_email: em || '—',
            client_email_display: user_type === 'client' && em ? 'block' : 'none',
            profile_header_photo_src,
            profile_header_photo_display,
            profile_header_icon_display,
        });

        // Если зашел таксист то показываем кнопку уведомлений и сразу синхронизируем класс с /api/me
        if (user_type === 'driver') {
            const tnb = document.getElementById('taxi-notification-button');
            if (tnb) tnb.style.display = 'flex';
            if (window.taxiApp?.updateTaxiStatusUI) {
                window.taxiApp.updateTaxiStatusUI(clientData.status || 'offline');
            }
        }

        this.profileScreen.innerHTML = filledTemplate;
        const balAmtEl = this.profileScreen.querySelector(".balance-amount-value");
        if (balAmtEl && clientData.balance != null && clientData.balance !== "") {
            const rb = Number(clientData.balance);
            if (Number.isFinite(rb)) {
                balAmtEl.dataset.rawBalance = rb.toFixed(2);
            }
        } else if (balAmtEl) {
            delete balAmtEl.dataset.rawBalance;
        }
        this._syncProfileHeaderAvatar(clientData, user_type);

        this.currentUserType = user_type;
        this._initProfileEditUI(user_type);
        this._initBalanceWithdrawUI(user_type);
        if (user_type === 'driver') {
            this.refreshDriverPayoutHistory().catch(() => {});
        }

        if (user_type === 'client' || user_type === 'driver') {
            if (this.pendingTrips) {
                this.addTripsToProfile(this.pendingTrips);
                this.pendingTrips = null;
            }
        }
    }

    _initBalanceWithdrawUI(user_type) {
        const root = this.profileScreen;
        if (!root || user_type !== 'driver') return;
        const wrap = root.querySelector('.profile-balance');
        if (!wrap) return;
        const btn = root.querySelector('#balans-conclusion');
        const panel = root.querySelector('#balance-withdraw');
        const closeBtn = root.querySelector('#balance-withdraw-close');
        const cardInp = root.querySelector('#balance-withdraw-card');
        const amountInp = root.querySelector('#balance-withdraw-amount');
        const submitBtn = root.querySelector('#balance-withdraw-submit');
        const submitDefault = submitBtn?.querySelector('.balance-withdraw-submit-default');
        const submitBusy = submitBtn?.querySelector('.balance-withdraw-submit-busy');
        const bankEl = root.querySelector('#balance-withdraw-bank');
        const cardErr = root.querySelector('#balance-withdraw-card-err');
        const amountErr = root.querySelector('#balance-withdraw-amount-err');
        const cardField = cardInp?.closest('.balance-withdraw-field');
        const amountField = amountInp?.closest('.balance-withdraw-field');
        if (!btn || !panel || !cardInp || !amountInp || !submitBtn) return;

        const setOpen = (open) => {
            wrap.classList.toggle('is-withdraw-open', !!open);
            panel.setAttribute('aria-hidden', open ? 'false' : 'true');
            if (open) {
                setTimeout(() => {
                    try {
                        cardInp.focus();
                    } catch (_) {
                        /* ignore */
                    }
                }, 120);
            }
        };

        btn.addEventListener('click', () => {
            const open = wrap.classList.contains('is-withdraw-open');
            setOpen(!open);
        });
        if (closeBtn) {
            closeBtn.addEventListener('click', () => setOpen(false));
        }

        const normalizeCard = (s) => String(s || '').replace(/[^\d]/g, '');
        const formatCard = (digits) =>
            digits.replace(/(\d{4})(?=\d)/g, '$1 ').trim();

        // AZ BIN list: первые 6 цифр (4+2 из шаблона "4268 63** ****")
        const AZ_BINS = [
            { bank: "ACCESSBANK CJSC", visa: ["426863", "428652"], mc: ["537462"] },
            { bank: "AFB BANK OJSC", visa: ["488940"], mc: [] },
            { bank: "AZERPOST LLC", visa: [], mc: ["537609"] },
            { bank: "AZER-TURK BANK OJSC", visa: [], mc: ["521367"] },
            { bank: "BANK OF BAKU OJSC", visa: ["420382", "470448"], mc: ["520987", "531599"] },
            { bank: "BANK RESPUBLIKA OJSC", visa: ["424448", "424450", "424451"], mc: ["523522", "524748", "535741", "541735", "547453"] },
            { bank: "EXPRESSBANK OSC", visa: ["472494"], mc: ["550578"] },
            { bank: "INTERNATIONAL BANK OF AZERBAIJAN", visa: ["410511", "412720", "412721", "461386"], mc: ["516751", "527575", "531018", "549027", "552209", "558390"] },
            { bank: "KAPITAL BANK JSB", visa: ["416973", "416974", "416975", "417358"], mc: ["510307", "523915", "540408"] },
            { bank: "OPEN JOINT STOCK SOCIETY \"MUGANBANK\"", visa: [], mc: ["534191"] },
            { bank: "PASHA BANK OJSC", visa: ["418249", "444994", "486022"], mc: ["540269"] },
            { bank: "PREMIUM BANK OJSC", visa: ["419255", "419256", "419257"], mc: [] },
            { bank: "RABITABANK JSB", visa: ["418980"], mc: ["526163", "535464"] },
            { bank: "UNIBANK COMMERCIAL BANK", visa: ["409809", "409858", "440553"], mc: ["522953", "524375"] },
            { bank: "XALQ BANK OJSC", visa: ["419841"], mc: ["516974"] },
            { bank: "YELO BANK OPEN JOINT-STOCK COMPANY", visa: ["417386", "472499"], mc: [] },
        ];
        const binToInfo = new Map();
        for (const b of AZ_BINS) {
            for (const x of b.visa) binToInfo.set(x, { bank: b.bank, scheme: "VISA" });
            for (const x of b.mc) binToInfo.set(x, { bank: b.bank, scheme: "Mastercard" });
        }
        const isAzCardByBin = (digits) => {
            if (!digits || digits.length < 6) return { ok: false, pending: true };
            const info = binToInfo.get(digits.slice(0, 6));
            if (!info) return { ok: false, pending: false };
            return { ok: true, pending: false, info };
        };

        const setFieldState = (fieldEl, ok, msgEl, msg) => {
            if (msgEl) msgEl.textContent = msg || "";
            if (!fieldEl) return;
            fieldEl.classList.toggle("is-error", !ok && !!msg);
            fieldEl.classList.toggle("is-ok", !!ok);
        };

        const escHtml = (s) =>
            String(s ?? "")
                .replace(/&/g, "&amp;")
                .replace(/</g, "&lt;")
                .replace(/>/g, "&gt;")
                .replace(/"/g, "&quot;");

        const schemeBrandIcon = (scheme) => {
            const s = String(scheme || "").toLowerCase();
            if (s.includes("visa")) {
                return '<i class="fa-brands fa-cc-visa balance-withdraw-bank-scheme-ico" aria-hidden="true"></i>';
            }
            if (s.includes("master")) {
                return '<i class="fa-brands fa-cc-mastercard balance-withdraw-bank-scheme-ico" aria-hidden="true"></i>';
            }
            return "";
        };

        const setSubmitLoading = (loading) => {
            if (!submitBtn) return;
            if (submitDefault) submitDefault.hidden = !!loading;
            if (submitBusy) submitBusy.hidden = !loading;
            submitBtn.classList.toggle("is-loading", !!loading);
        };

        cardInp.addEventListener('input', () => {
            const d = normalizeCard(cardInp.value).slice(0, 16);
            cardInp.value = formatCard(d);
            const r = isAzCardByBin(d);
            if (bankEl) {
                if (r.ok && r.info) {
                    const brand = schemeBrandIcon(r.info.scheme);
                    bankEl.innerHTML =
                        '<div class="balance-withdraw-bank-row">' +
                        '<span class="balance-withdraw-bank-left">' +
                        '<i class="fa-solid fa-building-columns balance-withdraw-bank-ico" aria-hidden="true"></i> ' +
                        '<span class="balance-withdraw-bank-name">' +
                        escHtml(r.info.bank) +
                        "</span></span>" +
                        (brand ? '<span class="balance-withdraw-bank-right">' + brand + "</span>" : "") +
                        "</div>";
                } else {
                    bankEl.textContent = "";
                }
            }
            if (r.pending) {
                setFieldState(cardField, false, cardErr, "");
            } else if (!r.ok) {
                setFieldState(cardField, false, cardErr, "Yalnız Azərbaycan bank kartları qəbul olunur.");
            } else {
                setFieldState(cardField, true, cardErr, "");
            }
        });

        const parseBalance = () => {
            const el =
                root.querySelector('.balance-amount-value') ||
                root.querySelector('.balance-amount');
            if (!el) return 0;
            const rawAttr = el.getAttribute("data-raw-balance");
            if (rawAttr != null && String(rawAttr).trim() !== "") {
                const nb = parseFloat(String(rawAttr).trim().replace(",", "."));
                if (Number.isFinite(nb)) return nb;
            }
            const raw = String(el.textContent || '')
                .replace(/\u00a0/g, ' ')
                .replace(/\u202f/g, '')
                .replace(/\s/g, '')
                .replace(/[^\d.,-]/g, '')
                .replace(',', '.');
            const n = parseFloat(raw);
            return Number.isFinite(n) ? n : 0;
        };

        const syncAmountFormatted = () => {
            const stripped = stripMoneyDisplay(amountInp.value);
            const next = sanitizeMoneyInput(stripped);
            const display = formatMoneyInputGrouped(next);
            if (amountInp.value !== display) amountInp.value = display;
            const bal = parseBalance();
            if (!next) {
                setFieldState(amountField, false, amountErr, "");
                return;
            }
            if (next.endsWith('.')) {
                setFieldState(amountField, false, amountErr, "");
                return;
            }
            const a = parseMoneyInputToNumber(next);
            if (!Number.isFinite(a) || a <= 0) {
                setFieldState(amountField, false, amountErr, "Məbləği düzgün daxil edin.");
                return;
            }
            if (a > bal + 1e-6) {
                setFieldState(amountField, false, amountErr, "Balans kifayət deyil.");
                return;
            }
            setFieldState(amountField, true, amountErr, "");
        };

        amountInp.addEventListener('focus', () => {
            const plain = sanitizeMoneyInput(stripMoneyDisplay(amountInp.value));
            amountInp.value = plain;
        });

        amountInp.addEventListener('blur', () => {
            const stripped = stripMoneyDisplay(amountInp.value);
            const s = sanitizeMoneyInput(stripped);
            if (!s) return;
            if (s.endsWith('.')) {
                amountInp.value = formatMoneyInputGrouped(s);
                return;
            }
            const n = parseMoneyInputToNumber(s);
            if (!Number.isFinite(n) || n <= 0) return;
            amountInp.value = formatMoneyAzDisplay(n);
        });

        amountInp.addEventListener("input", () => {
            syncAmountFormatted();
        });

        submitBtn.addEventListener('click', async () => {
            const digits = normalizeCard(cardInp.value);
            const amountClean = sanitizeMoneyInput(stripMoneyDisplay(amountInp.value));
            const amount = parseMoneyInputToNumber(amountClean);
            const bal = parseBalance();

            if (digits.length !== 16) {
                if (typeof window.showAppToast === 'function') {
                    window.showAppToast('Kart nömrəsi 16 rəqəm olmalıdır.', 'warn');
                }
                setFieldState(cardField, false, cardErr, "16 rəqəm daxil edin.");
                return;
            }
            const az = isAzCardByBin(digits);
            if (!az.ok) {
                if (typeof window.showAppToast === 'function') {
                    window.showAppToast('Yalnız Azərbaycan bank kartları qəbul olunur.', 'warn');
                }
                setFieldState(cardField, false, cardErr, "Yalnız Azərbaycan bank kartları qəbul olunur.");
                return;
            }
            if (amountClean.endsWith('.')) {
                if (typeof window.showAppToast === 'function') {
                    window.showAppToast('Məbləği tam daxil edin.', 'warn');
                }
                setFieldState(amountField, false, amountErr, "Məbləği tam daxil edin.");
                return;
            }
            if (!Number.isFinite(amount) || amount <= 0) {
                if (typeof window.showAppToast === 'function') {
                    window.showAppToast('Məbləği düzgün daxil edin.', 'warn');
                }
                setFieldState(amountField, false, amountErr, "Məbləği düzgün daxil edin.");
                return;
            }
            if (amount > bal + 1e-6) {
                if (typeof window.showAppToast === 'function') {
                    window.showAppToast('Balans kifayət deyil.', 'error');
                }
                setFieldState(amountField, false, amountErr, "Balans kifayət deyil.");
                return;
            }

            submitBtn.disabled = true;
            setSubmitLoading(true);
            try {
                const amountSend = Number.isFinite(amount)
                    ? Number.parseFloat(Number(amount).toFixed(2))
                    : NaN;
                if (!Number.isFinite(amountSend) || amountSend <= 0) {
                    if (typeof window.showAppToast === "function") {
                        window.showAppToast("Məbləği düzgün daxil edin.", "warn");
                    }
                    setFieldState(amountField, false, amountErr, "Məbləği düzgün daxil edin.");
                    return;
                }
                const postOpts = () => ({
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ amount: amountSend, card: digits }),
                });
                let res = await fetch('/api/me/withdrawals', postOpts());
                if (res.status === 404) {
                    res = await fetch('/api/driver/withdrawals', postOpts());
                }
                const j = await res.json().catch(() => ({}));
                if (!res.ok || !j.success) {
                    const msg = j.message || 'Xəta baş verdi';
                    if (typeof window.showAppToast === 'function') {
                        window.showAppToast(msg, 'error');
                    }
                    return;
                }
                const valEl = root.querySelector('.balance-amount-value');
                if (valEl && j.balance != null) {
                    const nb = Number(j.balance);
                    valEl.textContent = formatMoneyAzDisplay(j.balance);
                    if (Number.isFinite(nb)) {
                        valEl.dataset.rawBalance = nb.toFixed(2);
                    }
                }
                if (typeof window.showAppToast === 'function') {
                    window.showAppToast('Çıxarış sorğusu qəbul olundu.', 'info');
                }
                setOpen(false);
                cardInp.value = '';
                amountInp.value = '';
                if (bankEl) bankEl.textContent = "";
                setFieldState(cardField, false, cardErr, "");
                setFieldState(amountField, false, amountErr, "");
                this.refreshDriverPayoutHistory().catch(() => {});
            } finally {
                setSubmitLoading(false);
                setTimeout(() => {
                    submitBtn.disabled = false;
                }, 650);
            }
        });

        const payRefresh = root.querySelector('#balance-payout-refresh');
        if (payRefresh) {
            payRefresh.addEventListener('click', async () => {
                payRefresh.classList.add('is-loading');
                payRefresh.disabled = true;
                try {
                    await this.refreshDriverPayoutHistory();
                } finally {
                    payRefresh.classList.remove('is-loading');
                    payRefresh.disabled = false;
                }
            });
        }
    }

    async refreshDriverPayoutHistory() {
        if (this.currentUserType !== 'driver' || !this.profileScreen) return;
        const listEl = this.profileScreen.querySelector('#balance-payout-list');
        if (!listEl) return;
        try {
            let r = await fetch('/api/me/withdrawals', { credentials: 'include' });
            if (r.status === 404) {
                r = await fetch('/api/driver/withdrawals', { credentials: 'include' });
            }
            const j = await r.json().catch(() => ({}));
            if (!r.ok || !j.success) {
                if (typeof window.showAppToast === 'function') {
                    const msg =
                        j.message ||
                        (r.status === 404
                            ? 'Serverdə çıxarış API tapılmadı (404). Tətbiqi yenidən yükləyin və ya administratora bildirin.'
                            : 'Siyahı yüklənmədi');
                    window.showAppToast(msg, 'error');
                }
                return;
            }
            this._renderPayoutList(listEl, j.items || []);
        } catch (e) {
            if (typeof window.showAppToast === 'function') {
                window.showAppToast('Şəbəkə xətası', 'error');
            }
        }
    }

    _renderPayoutList(container, items) {
        const stAz = {
            pending: 'Gözləmədə',
            processing: 'Emalda',
            completed: 'Tamamlandı',
            rejected: 'Rədd edildi',
        };
        const esc = (s) =>
            String(s ?? '')
                .replace(/&/g, '&amp;')
                .replace(/</g, '&lt;')
                .replace(/>/g, '&gt;')
                .replace(/"/g, '&quot;');
        const fmtAmt = (a) => formatMoneyAzDisplay(a);
        if (!items.length) {
            container.innerHTML =
                '<div class="balance-payout-empty">Hələ çıxarış sorğusu yoxdur.</div>';
            return;
        }
        const rows = items
            .map((w) => {
                const rawSt = String(w.status || "").trim().toLowerCase();
                const stMod = ["pending", "processing", "completed", "rejected"].includes(rawSt)
                    ? rawSt
                    : "pending";
                const st = esc(stAz[w.status] || w.status || '');
                const amt = esc(fmtAmt(w.amount));
                const bin6 = String(w.card_bin6 || '').replace(/\D/g, '');
                const last4 = String(w.card_last4 || '').replace(/\D/g, '');
                const pan =
                    bin6.length >= 4
                        ? `${bin6.slice(0, 4)} •••• •••• ${last4}`
                        : `•••• ${last4}`;
                const panEsc = esc(pan);
                const tl = (w.timeline || [])
                    .map((e) => {
                        const tline = formatPayoutAtShort(e.at);
                        const stLine = esc(stAz[e.status] || e.status || '');
                        const cmt = e.comment ? `<p class="bp-line-msg">${esc(e.comment)}</p>` : '';
                        return `<li class="bp-line"><time class="bp-line-time">${esc(tline)}</time><div class="bp-line-body"><span class="bp-line-st">${stLine}</span>${cmt}</div></li>`;
                    })
                    .join('');
                return (
                    `<article class="balance-payout-item">` +
                    `<header class="bp-head"><span class="bp-sum">${amt}<span class="bp-cur">₼</span></span><span class="bp-badge bp-badge--${stMod}">${st}</span></header>` +
                    `<p class="bp-pan" translate="no"><i class="fa-regular fa-credit-card bp-pan-ico" aria-hidden="true"></i><span class="bp-pan-num">${panEsc}</span></p>` +
                    `<ul class="bp-steps">${tl}</ul>` +
                    `</article>`
                );
            })
            .join('');
        container.innerHTML = rows;
    }

    _clearProfileEditFileInputs(root) {
        root.querySelectorAll('.profile-edit-file-input').forEach((el) => {
            el.value = '';
            const box = el.closest('.profile-edit-upload');
            const nameEl = box?.querySelector('.profile-edit-upload-name');
            if (nameEl) nameEl.textContent = '';
            if (box) box.classList.remove('has-file');
        });
    }

    _bindProfileUploadNames(root) {
        root.querySelectorAll('.profile-edit-file-input').forEach((inp) => {
            inp.addEventListener('change', () => {
                const wrap = inp.closest('.profile-edit-upload');
                const nameEl = wrap?.querySelector('.profile-edit-upload-name');
                const f = inp.files && inp.files[0];
                if (nameEl) nameEl.textContent = f ? f.name : '';
                if (wrap) wrap.classList.toggle('has-file', !!f);
            });
        });
    }

    async _fillProfileEditForm() {
        const root = this.profileScreen;
        if (!root) return;
        const fb = root.querySelector('#profile-edit-feedback');
        if (fb) {
            fb.textContent = '';
            fb.classList.remove('is-error', 'is-ok');
        }
        this._clearProfileEditFileInputs(root);
        try {
            const res = await fetch('/api/me', {
                method: 'POST',
                credentials: 'include',
                headers: { 'Content-Type': 'application/json' },
            });
            const data = await res.json();
            if (!data.success) {
                if (fb) {
                    fb.textContent = 'Məlumat yüklənmədi';
                    fb.classList.add('is-error');
                }
                return;
            }
            const u = data.user;
            if (data.user_type === 'client') {
                const set = (id, v) => {
                    const el = root.querySelector(`#${id}`);
                    if (el) el.value = v ?? '';
                };
                set('profile-c-name', u.name);
                set('profile-c-surname', u.surname);
                set('profile-c-phone', phoneLocalFromStored(u.phone));
                set('profile-c-email', u.email);
                set('profile-c-password', '');
            } else {
                const set = (id, v) => {
                    const el = root.querySelector(`#${id}`);
                    if (el) el.value = v ?? '';
                };
                set('profile-d-name', u.name);
                set('profile-d-surname', u.surname);
                set('profile-d-phone', phoneLocalFromStored(u.phone));
                set('profile-d-email', u.email);
                set('profile-d-password', '');
                set('profile-d-car-name', u.car_name);
                set('profile-d-car-year', u.car_year != null ? String(u.car_year) : '');
                set('profile-d-car-number', u.car_number);
                set('profile-d-tech-passport', u.car_tech_passport);
                set('profile-d-driver-license', u.driver_license);
            }
        } catch (e) {
            if (fb) {
                fb.textContent = 'Şəbəkə xətası';
                fb.classList.add('is-error');
            }
        }
    }

    _initProfileEditUI(user_type) {
        const root = this.profileScreen;
        if (!root) return;
        const toggle = root.querySelector('#profile-edit-toggle');
        const collapse = root.querySelector('#profile-edit-collapse');
        const cFields = root.querySelector('#profile-client-fields');
        const dFields = root.querySelector('#profile-driver-fields');
        const saveBtn = root.querySelector('#profile-save-changes');
        if (!toggle || !collapse || !saveBtn) return;

        if (user_type === 'client') {
            if (cFields) cFields.style.display = '';
            if (dFields) dFields.style.display = 'none';
        } else {
            if (dFields) dFields.style.display = '';
            if (cFields) cFields.style.display = 'none';
        }

        collapse.classList.remove('is-open');
        toggle.classList.remove('is-active');
        toggle.setAttribute('aria-expanded', 'false');

        toggle.addEventListener('click', () => {
            const open = collapse.classList.toggle('is-open');
            toggle.classList.toggle('is-active', open);
            toggle.setAttribute('aria-expanded', open ? 'true' : 'false');
            if (open) this._fillProfileEditForm();
        });

        this._bindProfileUploadNames(root);

        saveBtn.addEventListener('click', async () => {
            const fb = root.querySelector('#profile-edit-feedback');
            if (fb) {
                fb.textContent = '';
                fb.classList.remove('is-error', 'is-ok');
            }
            const ut = this.currentUserType;
            if (!ut) return;

            const q = (id) => root.querySelector(`#${id}`);

            const buildClientBody = async () => {
                const body = {};
                const name = q('profile-c-name')?.value?.trim();
                const surname = q('profile-c-surname')?.value?.trim();
                if (name) body.name = name;
                if (surname) body.surname = surname;
                const phone = q('profile-c-phone')?.value?.trim();
                if (phone) body.phone = phone;
                body.email = q('profile-c-email')?.value?.trim() ?? '';
                const pw = q('profile-c-password')?.value;
                if (pw && pw.length >= 6) body.new_password = pw;
                const pho = await readInputFileAsBase64(q('profile-c-photo-file'));
                if (pho) body.photo = pho;
                return body;
            };

            const buildDriverBody = async () => {
                const body = {};
                const pairs = [
                    ['profile-d-name', 'name'],
                    ['profile-d-surname', 'surname'],
                    ['profile-d-phone', 'phone'],
                    ['profile-d-car-name', 'car_name'],
                    ['profile-d-car-number', 'car_number'],
                    ['profile-d-tech-passport', 'car_tech_passport'],
                    ['profile-d-driver-license', 'driver_license'],
                ];
                pairs.forEach(([id, key]) => {
                    const el = q(id);
                    if (!el) return;
                    const v = String(el.value || '').trim();
                    if (v) body[key] = v;
                });
                const yearEl = q('profile-d-car-year');
                if (yearEl && yearEl.value !== '') {
                    const y = parseInt(yearEl.value, 10);
                    if (!Number.isNaN(y)) body.car_year = y;
                }
                body.email = q('profile-d-email')?.value?.trim() ?? '';
                const pw = q('profile-d-password')?.value;
                if (pw && pw.length >= 6) body.new_password = pw;
                const carP = await readInputFileAsBase64(q('profile-d-car-photo-file'));
                if (carP) body.car_front_photo = carP;
                const licP = await readInputFileAsBase64(q('profile-d-license-photo-file'));
                if (licP) body.driver_license_photo = licP;
                const techP = await readInputFileAsBase64(q('profile-d-tech-photo-file'));
                if (techP) body.car_tech_photo = techP;
                const faceP = await readInputFileAsBase64(q('profile-d-face-photo-file'));
                if (faceP) body.face_photo = faceP;
                return body;
            };

            try {
                const payload = ut === 'client' ? await buildClientBody() : await buildDriverBody();
                const res = await fetch('/api/me/profile', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload),
                });
                const out = await res.json().catch(() => ({}));
                if (fb) {
                    fb.textContent = out.message || (out.success ? 'Saxlanıldı' : 'Xəta');
                    fb.classList.toggle('is-error', !out.success);
                    fb.classList.toggle('is-ok', !!out.success);
                }
                if (out.success) {
                    await this.loadProfileData();
                    if (window.taxiServices?.checkTripsForProfile) {
                        await window.taxiServices.checkTripsForProfile();
                    }
                }
            } catch (e) {
                if (fb) {
                    fb.textContent = 'Şəbəkə xətası';
                    fb.classList.add('is-error');
                }
            }
        });
    }

    displayRegistrationRequired() {
        const templateContent = this.registrationTemplate.innerHTML;
        this.profileScreen.innerHTML = templateContent;
        // this.profileScreen.classList.add('active');

    }

    /**
     * Круглое фото в шапке профиля: задаём src через DOM (не через fillTemplate), чтобы длинные data URL
     * не ломали разметку. Свой профиль: фото клиента/водителя всегда, даже при anonymous_profile.
     */
    _syncProfileHeaderAvatar(user, userType) {
        const root = this.profileScreen;
        if (!root) return;
        const img = root.querySelector('.profile-header-photo-img');
        const icon = root.querySelector('.profile-header-photo-fallback');
        if (!img || !icon) return;
        let raw = null;
        if (userType === 'client') {
            raw = user.photo != null ? user.photo : user.avatar;
        } else if (userType === 'driver') {
            raw = user.avatar != null ? user.avatar : user.face_photo;
        }
        const s = raw != null ? String(raw).trim() : '';
        if (s) {
            img.src = typeof profileAvatarSrc === 'function' ? profileAvatarSrc(raw) : String(raw);
            img.style.display = 'block';
            icon.style.display = 'none';
        } else {
            img.removeAttribute('src');
            img.style.display = 'none';
            icon.style.display = 'block';
        }
    }

    fillTemplate(template, data) {
        return template.replace(/\{(\w+)\}/g, (match, key) => {
            return data[key] !== undefined ? data[key] : match;
        });
    }

    formatJoinDate(dateString) {
        if (!dateString) return '2026';
        
        try {
            const date = new Date(dateString);
            return date.getFullYear().toString();
        } catch {
            return '2026';
        }
    }

    formatDateAZ(dateString) {
        const monthsAZ = [
            "yanvar", "fevral", "mart", "aprel", "may", "iyun",
            "iyul", "avqust", "sentyabr", "oktyabr", "noyabr", "dekabr"
        ];

        const date = new Date(dateString);
        const day = date.getDate();
        const month = monthsAZ[date.getMonth()];
        const year = date.getFullYear();

        return `${day} ${month} ${year}`;
    }



    formatTimeAZ(dateString) {
        if (dateString == null || dateString === '') return '—';
        const date = new Date(dateString);
        if (Number.isNaN(date.getTime())) return '—';
        const hours = date.getHours().toString().padStart(2, '0');
        const minutes = date.getMinutes().toString().padStart(2, '0');
        return `${hours}:${minutes}`;
    }

    /** Первое непустое поле-дата (для fallback цепочки начала/конца поездки). */
    _pickFirstTimestamp(...candidates) {
        for (let i = 0; i < candidates.length; i += 1) {
            const v = candidates[i];
            if (v == null || v === '') continue;
            const d = new Date(v);
            if (!Number.isNaN(d.getTime())) return v;
        }
        return null;
    }

    _profileRole() {
        return this.currentUserType || localStorage.getItem('userType') || '';
    }

    getProfileHistorySection() {
        if (!this.profileScreen) return null;
        if (this._profileRole() === 'driver') {
            return this.profileScreen.querySelector('.driver-profile-history');
        }
        return this.profileScreen.querySelector('.client-profile-data .history-section');
    }

    getProfileTripsContainer() {
        return this.getProfileHistorySection()?.querySelector('.trips-container') ?? null;
    }

    getTripTimeRange(trip) {
        const status = String(trip.status || '').toLowerCase();
        const fmt = (v) => this.formatTimeAZ(v);

        // Начало поездки для пассажира: фактический старт > принятие водителем > заявка > created_at
        const tripStart = this._pickFirstTimestamp(
            trip.started_at,
            trip.accepted_at,
            trip.requested_at,
            trip.created_at
        );
        const tripEndDone = this._pickFirstTimestamp(trip.completed_at);
        const tripEndCancel = this._pickFirstTimestamp(trip.cancelled_at);

        if (status === 'pending' || status === 'offered') {
            const t = this._pickFirstTimestamp(trip.requested_at, trip.created_at);
            return t ? fmt(t) : '—';
        }

        if (status === 'completed') {
            const start = this._pickFirstTimestamp(trip.started_at, trip.accepted_at, trip.requested_at, trip.created_at);
            const end = tripEndDone;
            if (start && end) return `${fmt(start)} - ${fmt(end)}`;
            if (end) return `${fmt(this._pickFirstTimestamp(trip.requested_at, trip.created_at))} - ${fmt(end)}`;
            if (start) return fmt(start);
            return '—';
        }

        if (status === 'cancelled') {
            const start = this._pickFirstTimestamp(trip.requested_at, trip.created_at, trip.accepted_at);
            const end = tripEndCancel;
            if (start && end) return `${fmt(start)} - ${fmt(end)}`;
            if (end) return `${fmt(this._pickFirstTimestamp(trip.requested_at, trip.created_at))} - ${fmt(end)}`;
            if (start) return fmt(start);
            return '—';
        }

        // busy / accepted: поездка ещё не завершена — начало; конец только если уже есть completed_at
        if (status === 'busy' || status === 'accepted') {
            const start = this._pickFirstTimestamp(trip.accepted_at, trip.started_at, trip.requested_at, trip.created_at);
            const end = tripEndDone;
            if (start && end) return `${fmt(start)} - ${fmt(end)}`;
            if (start) return `${fmt(start)} —`;
            return '—';
        }

        const endAny = this._pickFirstTimestamp(trip.completed_at, trip.cancelled_at);
        if (tripStart && endAny) return `${fmt(tripStart)} - ${fmt(endAny)}`;
        if (tripStart) return fmt(tripStart);
        if (endAny) return fmt(endAny);
        return '—';
    }

    // Добавьте метод для временного хранения поездок
    setPendingTrips(trips) {
        const role = this._profileRole();
        const canHistory =
            (role === 'client' || role === 'driver') && this.getProfileTripsContainer();
        if (canHistory) {
            this.addTripsToProfile(trips);
        } else {
            this.pendingTrips = trips;
        }
    }

    async showProfile() {
        // Показываем экран с загрузкой
        window.taxiApp.showScreen('profile-screen');
        
        // Сначала загружаем данные профиля и отрисовываем шаблон
        await this.loadProfileData(); // Добавьте await
        
        // Теперь, когда профиль отрисован, запрашиваем поездки
        await window.taxiServices?.checkTripsForProfile();
    }

    renderTrips(trips) {
        if (!trips || !Array.isArray(trips) || trips.length === 0) {
            return `<div class="empty-trips"><i class="fas fa-history nav-icon"></i> Поездок пока нет</div>`;
        }
        if (this._profileRole() === 'driver') {
            return trips
                .map((trip) => {
                    const distKm = trip.distance != null ? trip.distance : trip.distance_km;
                    const distLabel = distKm != null && distKm !== '' ? `${distKm}` : '-';
                    const cname = trip.client_profile_name || trip.client_name || 'Müştəri';
                    const initials = cname
                        .split(' ')
                        .filter(Boolean)
                        .map((n) => n[0])
                        .join('');
                    const clientRatingRaw = trip.client_rating ?? trip.client_live_rating;
                    const clientRatingStr =
                        clientRatingRaw != null &&
                        clientRatingRaw !== '' &&
                        Number.isFinite(Number(clientRatingRaw))
                            ? Number(clientRatingRaw).toFixed(1)
                            : '—';
                    const fromClient = trip.post_trip_driver_stars;
                    const myRate = trip.post_trip_client_stars;
                    const TRh = window.TripRatingShared;
                    const histParts = [];
                    if (TRh) {
                        if (myRate != null) {
                            histParts.push(
                                TRh.formatYouRatedBlock(
                                    TRh.LABEL_YOU_RATED_CLIENT,
                                    myRate,
                                    trip.post_trip_client_comment
                                )
                            );
                        }
                        if (fromClient != null) {
                            const remPeer = TRh.peerReviewRevealRemainingMs(trip);
                            if (remPeer <= 0) {
                                histParts.push(TRh.formatPeerRatedLine(fromClient));
                            }
                        }
                    }
                    const rateBlock =
                        histParts.length > 0
                            ? `<div class="trip-rating-history">${histParts.join('')}</div>`
                            : '';
                    return `
            <div class="trip-card ${trip.status}" data-trip-id="${trip.trip_id}">
                <div class="card-header">
                    <div class="date-info">
                        <span class="date-day">${this.formatDateAZ(trip.created_at)}</span>
                        <span class="date-time">
                            <i class="fa-regular fa-clock"></i>
                            ${this.getTripTimeRange(trip)}
                        </span> 
                    </div>
                    <span class="status-badge">
                        <div class="status-badge-text"></div>
                    </span>
                </div>

                <div class="route-section">
                    <div class="route-icon">
                        <div class="route-dot"></div>
                        <div class="route-line"></div>
                        <div class="route-dot end"></div>
                    </div>
                    <div class="route-addresses">
                        <div class="address-item">
                            <span class="address-value"><span class="address-description">Haradan</span> ${trip.start_address || '-'}</span>
                            <span class="address-value"><span class="address-description">Hara</span> ${trip.end_address || '-'}</span>
                        </div>
                    </div>
                </div>

                <div class="trip-footer">
                    <div class="stats-group">
                        <div class="stat-item"><i class="fas fa-road"></i> ${distLabel} km</div>
                        <div class="stat-item"><i class="fas fa-clock"></i> ${trip.driving_time || '-'}</div>
                    </div>
                    <div class="price">${trip.price} <small>₼</small></div>
                </div>

                <div class="driver-info">
                    <div class="driver-avatar">${initials || '?'}</div>
                    <div class="driver-details">
                        <div class="driver-name">${cname}</div>
                        <div class="car-info trip-card-client-meta">
                            <div class="rating-badge" title="Müştəri reytinqi (sifarişə görə və ya cari)">
                                <i class="fas fa-star"></i> ${clientRatingStr}
                            </div>
                        </div>
                    </div>
                </div>
                ${rateBlock}
            </div>`;
                })
                .join('');
        }

        return trips.map((trip) => {
            const did = trip.driver_id;
            const hasDriver = did != null && did !== '' && Number(did) > 0;
            const distKm = trip.distance != null ? trip.distance : trip.distance_km;
            const distLabel = distKm != null && distKm !== '' ? `${distKm}` : '-';
            const TRc = window.TripRatingShared;
            const clientHistParts = [];
            if (TRc) {
                if (trip.post_trip_driver_stars != null) {
                    clientHistParts.push(
                        TRc.formatYouRatedBlock(
                            TRc.LABEL_YOU_RATED_DRIVER,
                            trip.post_trip_driver_stars,
                            trip.post_trip_driver_comment
                        )
                    );
                }
                if (trip.post_trip_client_stars != null) {
                    const remPeerC = TRc.peerReviewRevealRemainingMs(trip);
                    if (remPeerC <= 0) {
                        clientHistParts.push(TRc.formatPeerRatedLine(trip.post_trip_client_stars));
                    }
                }
            }
            const myDriverRating =
                clientHistParts.length > 0
                    ? `<div class="trip-rating-history">${clientHistParts.join('')}</div>`
                    : '';
            const drvInitials = trip.driver_name
                ? trip.driver_name.split(' ').filter(Boolean).map((n) => n[0]).join('')
                : '?';
            return `
            <div class="trip-card ${trip.status}" data-trip-id="${trip.trip_id}">
                <div class="card-header">
                    <div class="date-info">
                        <span class="date-day">${this.formatDateAZ(trip.created_at)}</span>
                        <span class="date-time">
                            <i class="fa-regular fa-clock"></i>
                            ${this.getTripTimeRange(trip)}
                        </span> 
                    </div>
                    <span class="status-badge">
                        <div class="status-badge-text"></div>
                    </span>
                </div>

                <div class="route-section">
                    <div class="route-icon">
                        <div class="route-dot"></div>
                        <div class="route-line"></div>
                        <div class="route-dot end"></div>
                    </div>
                    <div class="route-addresses">
                        <div class="address-item">
                            <span class="address-value"><span class="address-description">Haradan</span> ${trip.start_address || '-'}</span>
                            <span class="address-value"><span class="address-description">Hara</span> ${trip.end_address || '-'}</span>
                        </div>
                    </div>
                </div>

                <div class="trip-footer">
                    <div class="stats-group">
                        <div class="stat-item"><i class="fas fa-road"></i> ${distLabel} km</div>
                        <div class="stat-item"><i class="fas fa-clock"></i> ${trip.driving_time || '-'}</div>
                    </div>
                    <div class="price">${trip.price} <small>₼</small></div>
                </div>

                ${hasDriver ? `
                <div class="driver-info">
                    <div class="driver-avatar">${drvInitials || '?'}</div>
                    <div class="driver-details">
                        <div class="driver-name">${trip.driver_name || 'Sürücü'}</div>
                        <div class="car-info">
                            <i class="fas fa-car"></i>
                            ${trip.car_name || ''} •
                            <span class="car-number"><svg width="15px" height="15px" viewBox="0 -4 28 28" fill="none" xmlns="http://www.w3.org/2000/svg"><g id="SVGRepo_bgCarrier" stroke-width="0"></g><g id="SVGRepo_tracerCarrier" stroke-linecap="round" stroke-linejoin="round"></g><g id="SVGRepo_iconCarrier"> <g clip-path="url(#clip0_503_4502)"> <rect width="28" height="20" rx="2" fill="white"></rect> <mask id="mask0_503_4502" style="mask-type:alpha" maskUnits="userSpaceOnUse" x="0" y="0" width="28" height="20"> <rect width="28" height="20" rx="2" fill="white"></rect> </mask> <g mask="url(#mask0_503_4502)"> <path fill-rule="evenodd" clip-rule="evenodd" d="M0 6.66667H28V0H0V6.66667Z" fill="#24AAD5"></path> <path fill-rule="evenodd" clip-rule="evenodd" d="M0 20H28V13.3333H0V20Z" fill="#21BF75"></path> <path fill-rule="evenodd" clip-rule="evenodd" d="M0 13.3333H28V6.66666H0V13.3333Z" fill="#ED1845"></path> <g filter="url(#filter0_d_503_4502)"> <path fill-rule="evenodd" clip-rule="evenodd" d="M14 12C14.4113 12 14.7936 11.8759 15.1114 11.663C15.0747 11.6654 15.0376 11.6666 15.0002 11.6666C14.0797 11.6666 13.3335 10.9205 13.3335 9.99998C13.3335 9.0795 14.0797 8.33331 15.0002 8.33331C15.0375 8.33331 15.0746 8.33454 15.1114 8.33696C14.7935 8.12413 14.4113 8 14 8C12.8954 8 12 8.89543 12 10C12 11.1046 12.8954 12 14 12ZM15.9998 9.99998C15.9998 10.3682 15.7014 10.6666 15.3332 10.6666C14.965 10.6666 14.6665 10.3682 14.6665 9.99998C14.6665 9.63179 14.965 9.33331 15.3332 9.33331C15.7014 9.33331 15.9998 9.63179 15.9998 9.99998Z" fill="white"></path> </g> </g> </g> <defs> <filter id="filter0_d_503_4502" x="12" y="8" width="3.99988" height="5" filterUnits="userSpaceOnUse" color-interpolation-filters="sRGB"> <feFlood flood-opacity="0" result="BackgroundImageFix"></feFlood> <feColorMatrix in="SourceAlpha" type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 127 0" result="hardAlpha"></feColorMatrix> <feOffset dy="1"></feOffset> <feColorMatrix type="matrix" values="0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0.06 0"></feColorMatrix> <feBlend mode="normal" in2="BackgroundImageFix" result="effect1_dropShadow_503_4502"></feBlend> <feBlend mode="normal" in="SourceGraphic" in2="effect1_dropShadow_503_4502" result="shape"></feBlend> </filter> <clipPath id="clip0_503_4502"> <rect width="28" height="20" rx="2" fill="white"></rect> </clipPath> </defs> </g></svg> ${trip.car_number || ''}</span>
                            <div class="rating-badge">
                                <i class="fas fa-star"></i> ${trip.driver_rating != null ? trip.driver_rating : '0.0'}
                            </div>
                        </div>
                    </div>
                </div>
                ` : ''}
                ${myDriverRating}
            </div>
        `;
        }).join('');
    }

    async waitForTripsContainer(timeout = 3000) {
        const startTime = Date.now();
        
        while (Date.now() - startTime < timeout) {
            const container = this.getProfileTripsContainer();
            if (container) {
                return container;
            }
            // Ждем немного перед следующей проверкой
            await new Promise(resolve => setTimeout(resolve, 50));
        }
        return null;
    }

    _schedulePeerReviewRevealRefresh(trips) {
        const TR = window.TripRatingShared;
        if (!TR?.peerReviewRevealRemainingMs || !trips || !Array.isArray(trips)) return;
        const role = this._profileRole();
        let minMs = Infinity;
        for (const trip of trips) {
            const rem = TR.peerReviewRevealRemainingMs(trip);
            if (rem <= 0) continue;
            const hasPeer =
                role === 'driver'
                    ? trip.post_trip_driver_stars != null
                    : role === 'client'
                      ? trip.post_trip_client_stars != null
                      : false;
            if (hasPeer) minMs = Math.min(minMs, rem);
        }
        if (minMs === Infinity || minMs <= 0) return;
        const delay = Math.min(minMs + 200, 2147483647);
        this._peerRevealTimer = setTimeout(() => {
            this._peerRevealTimer = null;
            if (this._lastProfileTrips) {
                this.addTripsToProfile(this._lastProfileTrips);
            }
        }, delay);
    }

    addTripsToProfile(trips) {
        // Проверяем, что профиль существует
        if (!this.profileScreen) {
            console.error('Profile screen not initialized');
            return;
        }
        
        const role = this._profileRole();
        if (role !== 'client' && role !== 'driver') {
            console.log('No trip history for this role');
            return;
        }

        if (this._peerRevealTimer) {
            clearTimeout(this._peerRevealTimer);
            this._peerRevealTimer = null;
        }
        this._lastProfileTrips = trips;
        
        const section = this.getProfileHistorySection();
        const container = this.getProfileTripsContainer();

        if (!container) {
            console.log('Trips container not found yet, saving trips for later');
            this.pendingTrips = trips;
            return;
        }

        container.innerHTML = this.renderTrips(trips);

        const showAllBtn = section?.querySelector('.show-all-trips');
        if (showAllBtn) {
            showAllBtn.style.display = (!trips || trips.length === 0) ? 'none' : '';
        }

        this._schedulePeerReviewRevealRefresh(trips);
    }




}


// Функция выхода
async function logout() {
    const taxiNotificationButton = document.getElementById('taxi-notification-button');
    if (taxiNotificationButton && localStorage.getItem('userType') === 'driver') {
        taxiNotificationButton.classList.remove('offline', 'available');
        taxiNotificationButton.classList.add('spinner');
        if (window.taxiControlles?.sendTaxiStatus) {
            await window.taxiControlles.sendTaxiStatus('offline', null);
        }
    }
    if (taxiNotificationButton) taxiNotificationButton.style.display = 'none';
    
    try {
        // Вызываем API выхода
        await fetch('/api/logout', {method: 'POST', credentials: 'include'});
        window.location.reload();
        // window.taxiApp.showScreen('main-screen')
        
    } catch (error) {
        console.error('Ошибка выхода:', error);
        window.taxiApp.showScreen('main-screen')
    }

    window.location.reload();
}



// Инициализируем менеджер профиля
window.profileManager = new ProfileManager();
document.addEventListener("click", (event) => {
    const button = event.target.closest(".show-all-trips");
    if (!button) return;

    const section = button.closest(".history-section");
    if (section.classList.contains("open")) {
        section.classList.remove("open");
        section.classList.add("close");
        button.innerHTML = '<i class="fa-solid fa-chevron-down"></i>';
    } else {
        section.classList.remove("close");
        section.classList.add("open");
        button.innerHTML = '<i class="fa-solid fa-chevron-up"></i>';
    }

    // Удаляем кнопку
    // button.innerHTML = '<i class="fa-solid fa-chevron-up"></i> Bütün hekayəni gizlədin';
});

// Темная тема
function applyDarkModeFromStorage(status = false) {
    DarkReader.setFetchMethod(window.fetch);

    // ВКЛЮЧАЕМ тёмную тему
    if (status) {
        DarkReader.enable({
            brightness: 115, contrast: 78,
            sepia: 4, grayscale: 0,
            darkSchemeBackgroundColor: "#022f15",
            darkSchemeTextColor: "#eafff2"
        });
    } 
    // ВЫКЛЮЧАЕМ тёмную тему
    else {
        DarkReader.disable();
    }

    if (typeof window.JITaxiMapBasemap?.syncAll === 'function') {
        window.JITaxiMapBasemap.syncAll(!!status);
    }
}



/** Радар-камеры только для водителя: класс на body + CSS (#settings-road-cams-row). */
function applySettingsRoadCamsRowVisibility() {
    const ut = String(localStorage.getItem('userType') || '').toLowerCase();
    const isDriver = ut === 'driver';
    document.body.classList.toggle('ji-settings-show-road-cams', isDriver);

    const rc = document.getElementById('roadCamsToggle');
    if (rc && isDriver && window.taxiServices?.settings) {
        const s = window.taxiServices.settings.get();
        rc.checked = s.roadCams ?? false;
    }
}

window.applySettingsRoadCamsRowVisibility = applySettingsRoadCamsRowVisibility;

/** Одна заявка /api/me: актуальный userType в localStorage, строка радаров, анонимность. */
window.refreshSettingsScreenFromSession = async function refreshSettingsScreenFromSession() {
    const anonRow = document.getElementById('anonymous-profile-setting-row');
    const anonTgl = document.getElementById('anonymousProfileToggle');
    try {
        const res = await fetch('/api/me', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
        });
        const data = await res.json().catch(() => ({}));
        if (data.success && data.user_type && data.user?.id != null) {
            localStorage.setItem('userType', data.user_type);
            localStorage.setItem('userID', String(data.user.id));
            applySettingsRoadCamsRowVisibility();
            void jiReportDeviceMeta();
        } else {
            document.body.classList.remove('ji-settings-show-road-cams');
        }
        if (anonRow && anonTgl) {
            if (data.success && data.user_type === 'client') {
                anonRow.style.display = '';
                anonTgl.checked = !!data.user?.anonymous_profile;
            } else {
                anonRow.style.display = 'none';
            }
        }
    } catch (_) {
        document.body.classList.remove('ji-settings-show-road-cams');
        if (anonRow) anonRow.style.display = 'none';
    }
};

window.syncAnonymousProfileToggle = window.refreshSettingsScreenFromSession;

function initFirstRunOnboarding() {
    const LS_KEY = 'ji_onboarding_v1_done';
    const root = document.getElementById('ji-onboarding');
    if (!root) return;

    try {
        if (localStorage.getItem(LS_KEY) === '1') return;
    } catch (_) {
        // если localStorage недоступен — просто не показываем
        return;
    }

    const track = document.getElementById('ji-onb-track');
    const dots = document.getElementById('ji-onb-dots');
    const btnPrev = document.getElementById('ji-onb-prev');
    const btnNext = document.getElementById('ji-onb-next');
    const viewport = root.querySelector('.ji-onb-viewport');
    if (!track || !dots || !btnPrev || !btnNext || !viewport) return;

    const slides = [
        {
            hero_html:
                '<img src="/static/images/logo.png" aria-hidden="true" width="40" height="40" class="ji-onb-logo" />',
            title: 'Добро пожаловать!',
            text: 'Пара быстрых подсказок — и можно начинать. Это окно появится только один раз.',
            bullets: [
                { icon: 'fa-solid fa-bolt', text: 'Быстрый старт — меньше минуты.' },
                { icon: 'fa-solid fa-wand-magic-sparkles', text: 'Простой и понятный интерфейс' },
                { icon: 'fa-solid fa-map-location-dot', text: 'Работаем во всех районах.' },
                { icon: 'fa-solid fa-coins', text: 'Низкие цены на поездки.' },
            ],
        },
        {
            icon: 'fa-solid fa-location-dot',
            title: 'Точный адрес — быстрее подача!',
            text: 'Укажите “Откуда” и “Куда”, чтобы мы построили маршрут и показали точную стоимость.',
            permission: 'location',
            bullets: [
                { icon: 'fa-solid fa-crosshairs', text: 'Геолокация ускоряет подачу.' },
                { icon: 'fa-solid fa-route', text: 'Маршрут рассчитывается автоматически.' },
                { icon: 'fa-solid fa-money-bills', text: 'Цена известна заранее.' },
                
            ],
        },
        {
            icon: 'fa-solid fa-bell',
            title: 'Не пропускайте важное!',
            text: 'Включите уведомления, чтобы видеть статус поездки и ответы водителей.',
            permission: 'notifications',
            bullets: [
                { icon: 'fa-solid fa-circle-check', text: 'Принятие заказа водителем.' },
                { icon: 'fa-solid fa-shield-halved', text: 'Меньше рисков, изменения статуса поездки.' },
                { icon: 'fa-solid fa-gear', text: 'Важные уведомления можно настроить в настройках.' },

            ],
        },
        {
            icon: 'fa-solid fa-shield-halved',
            title: 'Безопасно и прозрачно!',
            text: 'Вы всегда видите статус поездки и данные водителя.',
            bullets: [
                { icon: 'fa-solid fa-masks-theater', text: 'Можно скрыть свои данные.' },
                { icon: 'fa-solid fa-shield-heart', text: 'Все ваши данные защищены.' },
                { icon: 'fa-solid fa-history', text: 'История поездок доступна в приложении.' },
            ],

        },
        {
            icon: 'fa-solid fa-language',
            title: 'Выберите язык приложения!',
            text: 'Выберите удобный язык интерфейса.',
            custom_html:
                '<div class="ji-onb-lang" role="group" aria-label="Выбор языка">' +
                '<button type="button" class="ji-onb-lang-opt" data-onb-lang="ru" aria-pressed="false">' +
                '<span class="ji-onb-lang-name">Русский</span>' +
                '<span class="ji-onb-lang-meta">RU</span>' +
                '</button>' +
                '<button type="button" class="ji-onb-lang-opt" data-onb-lang="az" aria-pressed="false">' +
                '<span class="ji-onb-lang-name">Азербайджанский</span>' +
                '<span class="ji-onb-lang-meta">AZ</span>' +
                '</button>' +
                '<button type="button" class="ji-onb-lang-opt" data-onb-lang="en" aria-pressed="false">' +
                '<span class="ji-onb-lang-name">Английский</span>' +
                '<span class="ji-onb-lang-meta">EN</span>' +
                '</button>' +
                '</div>',
        },
        {   
            icon: 'fa-solid fa-crown',
            title: 'Готово. Поехали?',
            text: 'Создайте заказ и следите за поездкой в реальном времени.',
            bullets: [
                { icon: 'fa-solid fa-map-location-dot', text: 'Карта и трекинг — в реальном времени.' },
                { icon: 'fa-solid fa-star', text: 'Оценивайте поездки и оставляйте отзывы.' },
                { icon: 'fa-solid fa-gear', text: 'Настройте приложение под себя → Настройки.' },
                { icon: 'fa-solid fa-id-card', text: 'Все водители проходят проверку.' },
            ],
        },
    ];

    const requestLocationPermission = async () => {
        if (!("geolocation" in navigator)) return "unsupported";
        return await new Promise((resolve) => {
            let done = false;
            const finish = (v) => {
                if (done) return;
                done = true;
                resolve(v);
            };
            try {
                navigator.geolocation.getCurrentPosition(
                    () => finish("granted"),
                    (err) => finish(err && err.code === 1 ? "denied" : "error"),
                    { enableHighAccuracy: false, timeout: 7000, maximumAge: 60_000 }
                );
            } catch (_) {
                finish("error");
            }
        });
    };

    const requestNotificationsPermission = async () => {
        if (!("Notification" in window)) return "unsupported";
        try {
            if (Notification.permission === "granted") return "granted";
            if (Notification.permission === "denied") return "denied";
            const res = await Notification.requestPermission();
            return res || "default";
        } catch (_) {
            return "error";
        }
    };

    track.innerHTML = slides
        .map((s) => {
            const hero =
                s.hero_html ||
                ('<i class="' + String(s.icon || 'fa-solid fa-circle') + '" aria-hidden="true"></i>');
            const bullets = Array.isArray(s.bullets) && s.bullets.length
                ? '<ul class="ji-onb-bullets">' +
                  s.bullets
                    .map(
                        (b) =>
                            '<li><i class="' +
                            String(b.icon || "fa-solid fa-check") +
                            '" aria-hidden="true"></i><span>' +
                            String(b.text || "") +
                            "</span></li>"
                    )
                    .join("") +
                  "</ul>"
                : "";
            const custom = s.custom_html ? '<div class="ji-onb-custom">' + String(s.custom_html) + "</div>" : "";
            return (
                '<section class="ji-onb-slide">' +
                '<div class="ji-onb-hero">' +
                hero +
                '</div>' +
                '<div class="ji-onb-title">' +
                String(s.title || '') +
                '</div>' +
                '<p class="ji-onb-text">' +
                String(s.text || '') +
                '</p>' +
                custom +
                bullets +
                '</section>'
            );
        })
        .join('');

    dots.innerHTML = slides
        .map((_, i) => '<span class="ji-onb-dot" data-onb-dot="' + i + '" aria-hidden="true"></span>')
        .join('');

    let idx = 0;
    const setIdx = (next) => {
        const n = Math.max(0, Math.min(slides.length - 1, Number(next) || 0));
        idx = n;
        track.style.transform = 'translate3d(' + String(-idx * 100) + '%, 0, 0)';
        btnPrev.disabled = idx === 0;
        btnNext.textContent = idx === slides.length - 1 ? 'Начать' : 'Далее';
        root.querySelectorAll('.ji-onb-dot').forEach((el, j) => {
            el.classList.toggle('is-active', j === idx);
        });
    };

    let closing = false;
    const close = () => {
        if (closing) return;
        closing = true;
        try {
            localStorage.setItem(LS_KEY, '1');
        } catch (_) {}
        root.setAttribute('aria-hidden', 'true');
        root.classList.add('is-closing');
        setTimeout(() => {
            root.hidden = true;
            root.classList.remove('is-closing');
            closing = false;
        }, 240);
    };

    btnPrev.addEventListener('click', () => setIdx(idx - 1));
    const permDone = { location: false, notifications: false };
    btnNext.addEventListener('click', async () => {
        if (idx >= slides.length - 1) {
            close();
            return;
        }
        const cur = slides[idx] || {};
        const need = cur.permission;
        if (need && !permDone[need]) {
            const prevLabel = btnNext.textContent;
            btnNext.disabled = true;
            btnNext.classList.add("is-busy");
            btnNext.textContent = need === "location" ? "Разрешить геолокацию…" : "Разрешить уведомления…";
            try {
                if (need === "location") await requestLocationPermission();
                if (need === "notifications") await requestNotificationsPermission();
            } finally {
                permDone[need] = true;
                btnNext.classList.remove("is-busy");
                btnNext.disabled = false;
                btnNext.textContent = prevLabel;
            }
        }
        setIdx(idx + 1);
    });
    dots.addEventListener('click', (ev) => {
        const t = ev.target && ev.target.closest('[data-onb-dot]');
        if (!t) return;
        const n = parseInt(t.getAttribute('data-onb-dot') || '0', 10);
        if (!Number.isFinite(n)) return;
        setIdx(n);
    });
    root.addEventListener('click', (ev) => {
        const skip = ev.target && ev.target.closest('[data-onb-skip]');
        const closeHit = ev.target && ev.target.closest('[data-onb-close]');
        if (skip || closeHit) close();
    });

    // language mock (без функционала смены языка): можно перевыбирать
    root.addEventListener("click", (ev) => {
        const b = ev.target && ev.target.closest("[data-onb-lang]");
        if (!b) return;
        const lang = String(b.getAttribute("data-onb-lang") || "").trim().toLowerCase();
        if (!lang) return;
        root.querySelectorAll(".ji-onb-lang-opt").forEach((el) => {
            const isPick = String(el.getAttribute("data-onb-lang") || "").trim().toLowerCase() === lang;
            el.classList.toggle("is-selected", isPick);
            el.setAttribute("aria-pressed", isPick ? "true" : "false");
            el.classList.remove("is-locked");
            el.removeAttribute("aria-disabled");
            el.disabled = false;
        });
    });

    // swipe
    let startX = 0;
    let moved = 0;
    viewport.addEventListener(
        'touchstart',
        (e) => {
            const t = e.touches && e.touches[0];
            if (!t) return;
            startX = t.clientX;
            moved = 0;
        },
        { passive: true }
    );
    viewport.addEventListener(
        'touchmove',
        (e) => {
            const t = e.touches && e.touches[0];
            if (!t) return;
            moved = t.clientX - startX;
        },
        { passive: true }
    );
    viewport.addEventListener(
        'touchend',
        () => {
            if (Math.abs(moved) < 34) return;
            if (moved < 0) setIdx(idx + 1);
            else setIdx(idx - 1);
        },
        { passive: true }
    );

    root.hidden = false;
    root.setAttribute('aria-hidden', 'false');
    setIdx(0);
}

// Супер компактный вариант с логами
document.addEventListener('DOMContentLoaded', () => {
    console.log('[Settings] Init started');

    // Onboarding (первый запуск)
    try {
        initFirstRunOnboarding();
    } catch (_) {
        /* ignore */
    }

    const settingsAPI = window.taxiServices.settings;
    const settings = settingsAPI.get();

    // 📱 уведомления
    const pn = document.getElementById('phoneNotificationToggle');
    if (pn) {
        pn.checked = settings.phoneNotifications ?? false;

        pn.addEventListener('change', () => {
            settingsAPI.update('phoneNotifications', pn.checked);
            console.log('[Settings] phoneNotifications:', pn.checked);
        });
    }

    // 🚨 радары (строка настроек скрыта у клиента; переключатель в DOM остаётся)
    const rc = document.getElementById('roadCamsToggle');
    if (rc && !rc.dataset.boundRoadCams) {
        rc.dataset.boundRoadCams = '1';
        rc.checked = settings.roadCams ?? false;
        rc.addEventListener('change', () => {
            settingsAPI.update('roadCams', rc.checked);
            console.log('[Settings] roadCams:', rc.checked);
        });
    }

    // 🌙 тёмная тема
    const dm = document.getElementById('darkModeToggle');
    if (dm) {
        dm.checked = settings.darkMode ?? false;

        applyDarkModeFromStorage(dm.checked);

        dm.addEventListener('change', () => {
            settingsAPI.update('darkMode', dm.checked);
            applyDarkModeFromStorage(dm.checked);

            console.log('[Settings] darkMode:', dm.checked);
        });
    }

    console.log('[Settings] Init finished');

    const anonTgl = document.getElementById('anonymousProfileToggle');
    if (anonTgl && !anonTgl.dataset.boundPrivacy) {
        anonTgl.dataset.boundPrivacy = '1';
        anonTgl.addEventListener('change', async () => {
            try {
                await fetch('/api/me/profile', {
                    method: 'POST',
                    credentials: 'include',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ anonymous_profile: anonTgl.checked }),
                });
            } catch (_) { /* ignore */ }
            if (window.profileManager && typeof window.profileManager.loadProfileData === 'function') {
                await window.profileManager.loadProfileData().catch(() => {});
            }
        });
    }

    void window.refreshSettingsScreenFromSession().catch(() => {});
});