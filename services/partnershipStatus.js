// Extracted from cirl.js (2026-11, Gemini AI Integration Phase 1) so the new
// strategicAnalyticsService can reuse the SAME authoritative status rule
// instead of re-implementing it — computeStatusFromEnd is the single rule
// every other status read in the app already depends on (Reports & Analytics,
// the Dashboard widget, the hourly lifecycle job, /api/partnerships/stats).
// Behavior is unchanged from its prior inline definition in cirl.js — this is
// a pure move, not a rewrite.
const LIFECYCLE_EXPIRING_WINDOW_DAYS = 90;

/**
 * Derives a partnership's status purely from its end date.
 * Agreed day boundaries (days = ceil((end date) − (now), in days)):
 *   days > 90       → Active
 *   0 < days <= 90  → Expiring Soon
 *   days === 0      → Expiring Soon (the expiry date itself)
 *   days < 0        → Expired
 */
function computeStatusFromEnd(endStr) {
  const end = new Date(endStr);
  if (isNaN(end)) return null; // unparseable/missing end date — leave the record alone
  const daysLeft = Math.ceil((end - new Date()) / 86400000);
  if (daysLeft < 0) return 'Expired';
  if (daysLeft <= LIFECYCLE_EXPIRING_WINDOW_DAYS) return 'Expiring Soon';
  return 'Active';
}

module.exports = { LIFECYCLE_EXPIRING_WINDOW_DAYS, computeStatusFromEnd };
