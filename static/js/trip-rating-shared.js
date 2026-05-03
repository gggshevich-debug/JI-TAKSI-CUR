/**
 * Qiymətləndirmə: «sizi qiymətləndirdilər», öz ulduzlarınız, səbəb çipləri.
 */
(function (global) {
  const PEER_TIER_BY_STAR = {
    5: { label: 'Əla', iconClass: 'fa-solid fa-thumbs-up' },
    4: { label: 'Yaxşı', iconClass: 'fa-regular fa-face-smile' },
    3: { label: 'Normal', iconClass: 'fa-regular fa-face-meh' },
    2: { label: 'Pis', iconClass: 'fa-regular fa-face-frown' },
    1: { label: 'Çox pis', iconClass: 'fa-solid fa-circle-xmark' },
  };

  /** Tarixdə saxlanmış teqlərin etiketi (köhnə slug-lar daxil). */
  const REASON_LABELS = {
    polite_driver: 'Nəzakətli',
    clean_interior: 'Təmiz salon',
    careful_driving: 'Ehtiyatlı sürüş',
    arrived_on_time: 'Vaxtında gəldi',
    good_navigation: 'Yaxşı orientasiya',
    late: 'Gecikdi',
    rude_behavior: 'Kobud davranış',
    dangerous_driving: 'Təhlükəli sürüş',
    driver_no_show: 'Gəlmədi / çıxmayıb',
    driver_no_answer: 'Cavab vermədi',
    wrong_pickup_by_driver: 'Oturacaq nöqtəsi səhvi',
    polite_client: 'Nəzakətli',
    quick_exit: 'Tez çıxdı',
    was_reachable: 'Əlaqədə idi',
    good_behavior: 'Yaxşı davranış',
    client_no_show: 'Çıxmadı',
    rude_client: 'Kobud',
    long_wait: 'Uzun gözləmə',
    client_no_answer: 'Cavab vermədi',
    cancel_after_arrival: 'Gəldikdən sonra ləğv',
    wrong_pickup_by_client: 'Yanlış oturacaq nöqtəsi',
    clean_car: 'Təmiz salon',
    arrived_fast: 'Vaxtında gəldi',
    on_time_out: 'Tez çıxdı',
    no_show: 'Çıxmadı',
  };

  const LABEL_YOU_RATED_DRIVER = 'Sürücünü qiymətləndirdiniz:';
  const LABEL_YOU_RATED_CLIENT = 'Müştərini qiymətləndirdiniz:';
  const LABEL_PEER_RATED_YOU = 'Sizi qiymətləndirdilər:';

  /** Müştəri → sürücü */
  const REASONS_CLIENT = {
    pos: [
      { id: 'polite_driver', label: 'Nəzakətli' },
      { id: 'clean_interior', label: 'Təmiz salon' },
      { id: 'careful_driving', label: 'Ehtiyatlı sürüş' },
      { id: 'arrived_on_time', label: 'Vaxtında gəldi' },
      { id: 'good_navigation', label: 'Yaxşı orientasiya' },
    ],
    neg: [
      { id: 'late', label: 'Gecikdi' },
      { id: 'rude_behavior', label: 'Kobud davranış' },
      { id: 'dangerous_driving', label: 'Təhlükəli sürüş' },
      { id: 'driver_no_show', label: 'Gəlmədi / çıxmayıb' },
      { id: 'driver_no_answer', label: 'Cavab vermədi' },
      { id: 'wrong_pickup_by_driver', label: 'Oturacaq nöqtəsi səhvi' },
    ],
  };

  /** Sürücü → müştəri */
  const REASONS_DRIVER = {
    pos: [
      { id: 'polite_client', label: 'Nəzakətli' },
      { id: 'quick_exit', label: 'Tez çıxdı' },
      { id: 'was_reachable', label: 'Əlaqədə idi' },
      { id: 'good_behavior', label: 'Yaxşı davranış' },
    ],
    neg: [
      { id: 'client_no_show', label: 'Çıxmadı' },
      { id: 'rude_client', label: 'Kobud' },
      { id: 'long_wait', label: 'Uzun gözləmə' },
      { id: 'client_no_answer', label: 'Cavab vermədi' },
      { id: 'cancel_after_arrival', label: 'Gəldikdən sonra ləğv' },
      { id: 'wrong_pickup_by_client', label: 'Yanlış oturacaq nöqtəsi' },
    ],
  };

  function clampStar(n) {
    const s = Math.round(Number(n));
    if (!Number.isFinite(s)) return null;
    return Math.min(5, Math.max(1, s));
  }

  function peerStarsToTier(stars) {
    const s = clampStar(stars);
    if (s == null) return null;
    return PEER_TIER_BY_STAR[s];
  }

  function renderStarsHtml(stars) {
    const s = clampStar(stars);
    if (s == null) return '';
    let html = '<span class="trip-rating-history-own-stars" aria-hidden="true">';
    for (let i = 1; i <= 5; i += 1) {
      html +=
        i <= s
          ? '<i class="fas fa-star trip-rating-history-own-star trip-rating-history-own-star--on"></i>'
          : '<i class="far fa-star trip-rating-history-own-star"></i>';
    }
    html += '</span>';
    return html;
  }

  function parseReasonTagsFromComment(raw) {
    if (raw == null || raw === '') return [];
    const str = String(raw).trim();
    if (!str) return [];
    if (str.startsWith('{')) {
      try {
        const o = JSON.parse(str);
        const tags = o && Array.isArray(o.tags) ? o.tags : [];
        return tags.filter((t) => typeof t === 'string' && /^[a-z_]{1,40}$/.test(t));
      } catch (_) {
        return [];
      }
    }
    return [];
  }

  function renderReasonTagsHtml(tagIds) {
    if (!tagIds || !tagIds.length) return '';
    const parts = tagIds
      .map((id) => REASON_LABELS[id] || id)
      .map(
        (label) =>
          `<span class="trip-rating-history-tag">${String(label).replace(/</g, '&lt;')}</span>`
      );
    return `<div class="trip-rating-history-tags">${parts.join('')}</div>`;
  }

  function formatPeerRatedLine(stars) {
    const tier = peerStarsToTier(stars);
    if (!tier) return '';
    return `<div class="trip-rating-history-line trip-rating-history-line--peer">
      <span class="trip-rating-history-line-label">${LABEL_PEER_RATED_YOU}</span>
      <span class="trip-rating-history-peer-tier">
        <i class="${tier.iconClass}" aria-hidden="true"></i>
        <span>${tier.label}</span>
      </span>
    </div>`;
  }

  function formatYouRatedBlock(youRatedLabel, stars, storedComment) {
    const s = clampStar(stars);
    if (s == null) return '';
    const tags = parseReasonTagsFromComment(storedComment);
    return `<div class="trip-rating-history-line trip-rating-history-line--own">
      <div class="trip-rating-history-own-head">
        <span class="trip-rating-history-line-label">${youRatedLabel}</span>
        ${renderStarsHtml(s)}
      </div>
      ${renderReasonTagsHtml(tags)}
    </div>`;
  }

  function getReasonOptionsForRole(role, starCount) {
    const n = Number(starCount);
    const positive = n >= 4;
    const pack = role === 'driver' ? REASONS_DRIVER : REASONS_CLIENT;
    return positive ? pack.pos : pack.neg;
  }

  /** Tarixdə «sizi qiymətləndirdilər» xəttini completed_at-dan sonra 1 dəqiqə gec göstərmək. */
  const PEER_HISTORY_REVEAL_DELAY_MS = 60_000;

  function peerReviewRevealRemainingMs(trip) {
    if (!trip || typeof trip !== 'object') return 0;
    const raw =
      trip.completed_at ?? trip.updated_at ?? trip.requested_at ?? trip.created_at;
    if (raw == null || raw === '') return 0;
    const t = new Date(raw).getTime();
    if (!Number.isFinite(t)) return 0;
    return Math.max(0, t + PEER_HISTORY_REVEAL_DELAY_MS - Date.now());
  }

  global.TripRatingShared = {
    PEER_TIER_BY_STAR,
    REASONS_CLIENT,
    REASONS_DRIVER,
    REASON_LABELS,
    LABEL_YOU_RATED_DRIVER,
    LABEL_YOU_RATED_CLIENT,
    LABEL_PEER_RATED_YOU,
    clampStar,
    peerStarsToTier,
    renderStarsHtml,
    parseReasonTagsFromComment,
    renderReasonTagsHtml,
    formatPeerRatedLine,
    formatYouRatedBlock,
    getReasonOptionsForRole,
    PEER_HISTORY_REVEAL_DELAY_MS,
    peerReviewRevealRemainingMs,
  };
})(typeof window !== 'undefined' ? window : globalThis);
