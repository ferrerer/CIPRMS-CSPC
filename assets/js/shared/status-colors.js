// Canonical partnership-status → semantic-color mapping (2026-10 status-color standardization) — the ONE
// place this mapping is ever defined. Loaded as a <script> by the browser (Custom Report Builder preview,
// views/administrator/reports.ejs) AND require()'d by the server (PDF generation, cirl.js) via the small UMD
// wrapper below, so there is no second, hand-duplicated copy anywhere to drift out of sync with this one.
//
// Root cause this replaces: reports.ejs had at least two separate, inline status→color computations (the
// flat-records-table badge and a separate statusBadgeClass() function) that did not agree with each other —
// one of them defaulted any non-"Active"/non-"Expiring Soon" status (including "Inactive" and anything
// unexpected) to the danger/red color, rather than a neutral one. The PDF side had no status coloring at
// all. This file is the single source both sides now read from.
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.CIPRMS_STATUS_COLORS = factory();
  }
}(typeof self !== 'undefined' ? self : this, function () {
  // Normalizes a status label before lookup: trimmed and case-insensitive, so "active ", "ACTIVE", and
  // "Active" all resolve to the same entry — a capitalization or stray-whitespace difference (e.g. from a
  // manually-typed customStatuses value) must never silently fall through to the neutral/unknown color.
  function normalize(status) {
    return String(status == null ? '' : status).trim().toLowerCase();
  }

  // One entry per real status this system's own business logic computes (computeStatusFromEnd, cirl.js) plus
  // "Inactive", the aggregate label some report types use for it (Expired, and sometimes also Expiring Soon,
  // depending on report type — see cirl.js's own metricGroups handling; this file only maps a LABEL to a
  // COLOR, it never decides which records count as which status — that classification is untouched).
  // badgeClass values are this app's own existing Bootstrap/Velzon subtle-badge utility classes (already used
  // throughout the rest of the app for every other status-like badge), so a CIPRMS status badge looks
  // identical here to everywhere else in the product, not a new one-off style.
  const ENTRIES = {
    active: { label: 'Active', badgeClass: 'bg-success-subtle text-success', hex: '#0ab39c' },
    // Deep orange (2026-11) — reads as "almost expired"; .bg-expiring-subtle/.text-expiring live in assets/css/status-expiring.css.
    'expiring soon': { label: 'Expiring Soon', badgeClass: 'bg-expiring-solid', hex: '#f97316' },   // solid orange (2026-11-24)
    expired: { label: 'Expired', badgeClass: 'bg-danger-subtle text-danger', hex: '#f06548' },
    inactive: { label: 'Inactive', badgeClass: 'bg-secondary-subtle text-secondary', hex: '#878a99' }
  };
  // Neutral, not accidentally alarming (not red) and not accidentally reassuring (not green) — an unknown or
  // missing status must never be guessed into looking like Active or Expired.
  const UNKNOWN = { label: null, badgeClass: 'bg-light text-dark', hex: '#878a99' };

  function escapeHtml(v) {
    return String(v).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }

  function entryFor(status) {
    return ENTRIES[normalize(status)] || UNKNOWN;
  }

  return {
    // Bootstrap/Velzon badge classes — the browser preview's badges and status-colored table cells.
    badgeClass: function (status) { return entryFor(status).badgeClass; },
    // A real color value — the PDF generator's text fillColor, and any chart series that is genuinely keyed
    // BY STATUS NAME (never by array position/index — see this file's own header comment and the callers in
    // cirl.js/reports.ejs for why that distinction matters).
    hex: function (status) { return entryFor(status).hex; },
    // Whether a given label is one of the four real statuses this maps (vs. some other dimension value, e.g.
    // a country or unit name, that a caller might also be iterating over in the same loop).
    isKnownStatus: function (status) { return !!ENTRIES[normalize(status)]; },
    // Stable canonical order for anything presenting all four together (e.g. a legend) — always
    // Active, Expiring Soon, Expired, Inactive, regardless of the order they happen to appear in one dataset.
    ORDER: ['Active', 'Expiring Soon', 'Expired', 'Inactive'],
    // The partnership Status / Days Left badges, in the admin Monitoring registry's format — used by every page
    // that shows them (registry + View modal, Lifecycle, Reports, partner Renewal Status), so all roles see the
    // same thing. `days` = days left until the end date (null/undefined when unknown).
    //   Expired                     → solid red pill with a ✖ icon
    //   Expiring Soon               → solid orange pill with an alarm icon (≤ 14 days: slightly darker orange + a gentle pulse, "Critical")
    //   anything else               → the light status pill from badgeClass() above
    statusBadgeHtml: function (status, days) {
      var label = escapeHtml(status || '—');
      if (normalize(status) === 'expired') return '<span class="badge table-pill bg-danger" title="This partnership has expired"><i class="ri-close-circle-fill me-1"></i>Expired</span>';
      if (normalize(status) === 'expiring soon') {
        var critical = typeof days === 'number' && days <= 14;
        return '<span class="badge table-pill ' + (critical ? 'bg-critical-solid status-alarm" title="Critical: ' + days + ' day(s) left"' : 'bg-expiring-solid"') + '><i class="ri-alarm-warning-fill me-1"></i>' + label + '</span>';
      }
      return '<span class="badge table-pill ' + entryFor(status).badgeClass + '">' + label + '</span>';
    },
    daysLeftBadgeHtml: function (days, status) {
      if (normalize(status) === 'expired' || (typeof days === 'number' && days < 0)) return '<span class="badge table-pill bg-danger"><i class="ri-close-circle-fill me-1"></i>Expired</span>';
      if (typeof days !== 'number' || isNaN(days)) return '—';
      if (days <= 14) return '<span class="badge table-pill bg-critical-solid"><i class="ri-alarm-warning-fill me-1"></i>Critical (' + days + 'd)</span>';
      if (days <= 90) return '<span class="badge table-pill bg-expiring-solid"><i class="ri-alarm-warning-fill me-1"></i>' + days + ' days</span>';
      return '<span class="badge table-pill bg-success-subtle text-success">' + days + ' days</span>';
    },
    // Whole days from today to an end date (string or Date); null when it can't be parsed.
    daysUntil: function (end) {
      if (!end) return null;
      var e = new Date(end); if (isNaN(e)) return null;
      var t = new Date(); t.setHours(0, 0, 0, 0); e.setHours(0, 0, 0, 0);
      return Math.round((e - t) / 86400000);
    }
  };
}));
