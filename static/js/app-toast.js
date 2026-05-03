/**
 * Замена alert(): аккуратные тосты для клиента и водителя.
 * variant: 'error' | 'info' | 'warn'
 */
(function () {
  const DEFAULT_MS = 10000;

  function ensureRoot() {
    let root = document.getElementById('ji-app-toasts');
    if (!root) {
      root = document.createElement('div');
      root.id = 'ji-app-toasts';
      root.className = 'ji-app-toasts';
      root.setAttribute('aria-live', 'polite');
      document.body.appendChild(root);
    }
    return root;
  }

  function iconFor(v) {
    if (v === 'error') return '<i class="fa-solid fa-circle-exclamation ji-app-toast__icon" aria-hidden="true"></i>';
    if (v === 'warn') return '<i class="fa-solid fa-triangle-exclamation ji-app-toast__icon" aria-hidden="true"></i>';
    return '<i class="fa-solid fa-circle-info ji-app-toast__icon" aria-hidden="true"></i>';
  }

  window.showAppToast = function (message, variant, durationMs) {
    const text = message == null ? '' : String(message).trim();
    if (!text) return;
    const v = variant === 'error' || variant === 'warn' || variant === 'info' ? variant : 'info';
    const ms = typeof durationMs === 'number' && durationMs > 0 ? durationMs : DEFAULT_MS;
    const root = ensureRoot();
    const el = document.createElement('div');
    el.className = 'ji-app-toast ji-app-toast--' + v;
    el.setAttribute('role', 'status');
    el.innerHTML = iconFor(v) + '<span class="ji-app-toast__text"></span>';
    const span = el.querySelector('.ji-app-toast__text');
    if (span) span.textContent = text;
    root.appendChild(el);
    const t = window.setTimeout(function () {
      try {
        el.style.opacity = '0';
        el.style.transform = 'translateY(-10px) scale(0.98)';
        el.style.transition = 'opacity .24s ease, transform .24s ease';
      } catch (_) {
        /* ignore */
      }
      window.setTimeout(function () {
        try {
          el.remove();
        } catch (_) {
          /* ignore */
        }
      }, 240);
    }, ms);
    el._jiToastTimer = t;
  };
})();
