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
    'expiring soon': { label: 'Expiring Soon', badgeClass: 'bg-warning-subtle text-warning', hex: '#f7b84b' },
    expired: { label: 'Expired', badgeClass: 'bg-danger-subtle text-danger', hex: '#f06548' },
    inactive: { label: 'Inactive', badgeClass: 'bg-secondary-subtle text-secondary', hex: '#878a99' }
  };
  // Neutral, not accidentally alarming (not red) and not accidentally reassuring (not green) — an unknown or
  // missing status must never be guessed into looking like Active or Expired.
  const UNKNOWN = { label: null, badgeClass: 'bg-light text-dark', hex: '#878a99' };

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
    ORDER: ['Active', 'Expiring Soon', 'Expired', 'Inactive']
  };
}));
