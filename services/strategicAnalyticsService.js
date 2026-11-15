// Deterministic strategic analytics — Layer 1 of the Gemini AI Integration (CIPRMS, 2026-11, Phase 1).
// Pure, side-effect-free math over data already produced by existing, unmodified functions
// (computeStatusFromEnd, withTargetProgress/computeTargetAccomplishment) — this module never
// recomputes a partnership's status or a target's accomplishment itself; it only reads the one
// new cross-tab (per-unit active/international/expiring counts) that doesn't exist anywhere else
// in the app yet, and ranks/summarizes it. No Gemini, no network call, no write to any collection.
const { computeStatusFromEnd } = require('./partnershipStatus');

// Approved 2026-11-10 (CIPRMS Gemini AI Integration, Phase 1 planning — see the chat record's
// five-decision comparison table for the full rationale). Kept as a single named config object so
// any future change happens in exactly one place, not scattered through the ranking logic.
const RANKING_CONFIG = {
  weights: { activeCoverage: 0.50, internationalCoverage: 0.25, expiringShare: 0.25 },
  epsilon: 0.01,          // adjacent-gap chaining threshold — revisit once real (post-approval) score distributions exist
  sortDescending: true,   // highest development-attention score first
  tieConvention: 'dense', // 1, 2, 2, 3 — no skipped numbers after a tied cohort
};

const INTERNATIONAL_CATEGORY = 'International';
const SCORE_LABEL = 'Development-attention priority indicator — not a performance score or a forecast';

/**
 * Per-responsible-unit partnership breakdown: {unit, total, active, international, expiringSoon}.
 * Every unit in responsibleunits is included even with zero partnerships (surfaced, never dropped) —
 * a unit referenced on a partnership record but missing from responsibleunits (legacy data) is still
 * counted, not discarded. Status is recomputed live via the shared computeStatusFromEnd, the same
 * authoritative rule /api/partnerships/stats already uses — never a second implementation of it.
 */
async function computeUnitPartnershipBreakdown(db) {
  const units = await db.collection('responsibleunits').find({}).sort({ name: 1 }).toArray();
  const byUnit = new Map(units.map(u => [u.name, { unit: u.name, total: 0, active: 0, international: 0, expiringSoon: 0 }]));

  const docs = await db.collection('partnerships').find({}, { projection: { unit: 1, cat: 1, end: 1 } }).toArray();
  for (const p of docs) {
    const status = computeStatusFromEnd(p.end);
    const unitList = Array.isArray(p.unit) ? p.unit : (p.unit ? [p.unit] : []);
    for (const u of unitList) {
      if (!byUnit.has(u)) byUnit.set(u, { unit: u, total: 0, active: 0, international: 0, expiringSoon: 0 });
      const entry = byUnit.get(u);
      entry.total += 1;
      if (status === 'Active') entry.active += 1;
      if (status === 'Expiring Soon') entry.expiringSoon += 1;
      if (p.cat === INTERNATIONAL_CATEGORY) entry.international += 1;
    }
  }
  return Array.from(byUnit.values()).sort((a, b) => a.unit.localeCompare(b.unit));
}

/**
 * Ranks units by development-attention priority. See the chat record for the full derivation;
 * summary:
 *   - Criterion 1 (active-coverage gap) is always defined. When every unit has 0 active
 *     partnerships (maxActive === 0), it is fixed at 1.0 for all units rather than dividing by
 *     zero — this can never produce NaN/Infinity, but it also means criterion 1 contributes no
 *     discriminating power in that scenario (flagged via institutionWideZeroActive).
 *   - Criteria 2/3 (international-coverage gap, expiring-share) are undefined when a unit has 0
 *     total partnerships; the weighted average renormalizes over only the defined criteria rather
 *     than treating "undefined" as 0.
 *   - Units are sorted by score (direction per config.sortDescending), tie-broken by lower total
 *     count then alphabetically, then grouped into cohorts via adjacent-gap (single-linkage)
 *     chaining at config.epsilon — a cohort guarantees no two ADJACENT members differ by more than
 *     epsilon; it does NOT guarantee every pair within it does (a long run of small gaps can chain
 *     a wider scoreSpan into one cohort — scoreSpan is reported so this is never hidden).
 *   - Rank numbers use dense ranking: every cohort, tied or not, advances the rank by exactly 1.
 */
function rankOpportunities(unitBreakdown, config = RANKING_CONFIG) {
  const { weights, epsilon, sortDescending } = config;
  const maxActive = unitBreakdown.length ? Math.max(0, ...unitBreakdown.map(u => u.active)) : 0;
  const institutionWideZeroActive = maxActive === 0;

  const scored = unitBreakdown.map(u => {
    const activeCoverageGap = institutionWideZeroActive ? 1 : 1 - (u.active / maxActive);
    const internationalCoverageGap = u.total > 0 ? 1 - (u.international / u.total) : undefined;
    const expiringShare = u.total > 0 ? (u.expiringSoon / u.total) : undefined;

    let weightSum = weights.activeCoverage;
    let valueSum = weights.activeCoverage * activeCoverageGap;
    let criteriaUsed = 1;
    if (internationalCoverageGap !== undefined) { weightSum += weights.internationalCoverage; valueSum += weights.internationalCoverage * internationalCoverageGap; criteriaUsed += 1; }
    if (expiringShare !== undefined) { weightSum += weights.expiringShare; valueSum += weights.expiringShare * expiringShare; criteriaUsed += 1; }

    return {
      unit: u.unit, total: u.total, active: u.active, international: u.international, expiringSoon: u.expiringSoon,
      criteria: { activeCoverageGap, internationalCoverageGap, expiringShare },
      weightedScore: valueSum / weightSum,
      criteriaUsed: `${criteriaUsed}/3`,
      weightRedistributed: criteriaUsed < 3,
    };
  });

  scored.sort((a, b) => {
    if (b.weightedScore !== a.weightedScore) return sortDescending ? (b.weightedScore - a.weightedScore) : (a.weightedScore - b.weightedScore);
    if (a.total !== b.total) return a.total - b.total;
    return a.unit.localeCompare(b.unit);
  });

  const cohorts = [];
  for (const item of scored) {
    const prevCohort = cohorts[cohorts.length - 1];
    const prevItem = prevCohort && prevCohort[prevCohort.length - 1];
    if (prevItem && Math.abs(prevItem.weightedScore - item.weightedScore) <= epsilon) {
      prevCohort.push(item);
    } else {
      cohorts.push([item]);
    }
  }

  let rank = 1;
  const rankGroups = cohorts.map(items => {
    const scores = items.map(i => i.weightedScore);
    const group = {
      rank,
      tied: items.length > 1,
      scoreSpan: Number((Math.max(...scores) - Math.min(...scores)).toFixed(6)),
      confidenceReduced: items.some(i => i.weightRedistributed),
      units: items.map(i => ({ ...i, scorePercent: Math.round(i.weightedScore * 1000) / 10 })),
    };
    rank += 1; // dense ranking convention — approved 2026-11-10
    return group;
  });

  return {
    scoreLabel: SCORE_LABEL,
    institutionWideZeroActive,
    ...(institutionWideZeroActive ? {
      note: 'No unit currently has any active partnership. Rankings below are driven by international-coverage and expiring-share signals only, not relative active-coverage differences.'
    } : {}),
    rankGroups,
  };
}

/**
 * Reshapes an already-computed targets-with-progress array (the exact output of the existing,
 * unmodified withTargetProgress()) into the AI-ready target-gap summary. Never recomputes
 * accomplishment itself, and never introduces a per-college breakdown — targets are institution-
 * wide only in CIPRMS's data model, and this function says so explicitly rather than inventing one.
 */
function computeTargetGapSummary(targetsWithProgress) {
  return {
    scope: 'institution-wide',
    collegeBreakdown: null,
    note: 'Targets are not tracked per college in CIPRMS; see partnership coverage by unit instead.',
    targets: (targetsWithProgress || []).filter(t => t.active).map(t => ({
      id: t.id, type: t.type, year: t.year, month: t.month, targetCount: t.targetCount,
      current: t.progress.current, lacking: t.progress.lacking,
      percentage: t.progress.percentage, status: t.progress.status,
    })),
  };
}

/**
 * Institution-wide distinct partnership totals — counts each partnership record exactly ONCE,
 * matching the same counting convention as computeDashboardStats()/the main Dashboard and
 * GET /api/partnerships/stats in cirl.js. This is DELIBERATELY NOT the same number you get by
 * summing computeUnitPartnershipBreakdown()'s per-unit `total`/`active`/`expiringSoon` columns:
 * those intentionally count a multi-unit partnership once per responsible unit it lists — the same
 * established convention cirl.js's own `/api/partnerships/stats` byUnit tally and the Reports
 * module's "By College / Unit" grouping already use (see cirl.js's "unit is an array ... a
 * partnership with multiple responsible units counts toward each unit's tally" comment). A
 * partnership shared across N units is spread over N rows of the per-unit breakdown but must still
 * count as exactly 1 here — summing the per-unit breakdown and presenting it as this institution-wide
 * total was a real bug (2026-11 dashboard/AI-figures reconciliation) that inflated the AI Strategic
 * Insights "Total"/"Active"/"Expiring Soon" figures above what the main Dashboard shows whenever any
 * partnership had more than one responsible unit. `international` has no pre-existing distinct-count
 * equivalent elsewhere in the app; it is computed here the same way (one partnership, one count).
 */
async function computeInstitutionTotals(db) {
  const docs = await db.collection('partnerships').find({}, { projection: { end: 1, cat: 1 } }).toArray();
  let active = 0, expiringSoon = 0, expired = 0, international = 0;
  for (const p of docs) {
    const status = computeStatusFromEnd(p.end);
    if (status === 'Active') active += 1;
    else if (status === 'Expiring Soon') expiringSoon += 1;
    else if (status === 'Expired') expired += 1;
    if (p.cat === INTERNATIONAL_CATEGORY) international += 1;
  }
  return { total: docs.length, active, expiringSoon, expired, international };
}

/** Full deterministic snapshot — the only thing strategicAnalyticsService hands to the AI layer. */
async function computeSnapshot(db, { targetsWithProgress = [] } = {}, config = RANKING_CONFIG) {
  const [unitBreakdown, institutionTotals] = await Promise.all([
    computeUnitPartnershipBreakdown(db),
    computeInstitutionTotals(db),
  ]);
  return {
    generatedAt: new Date().toISOString(),
    institutionTotals,
    ranking: rankOpportunities(unitBreakdown, config),
    targetGaps: computeTargetGapSummary(targetsWithProgress),
  };
}

module.exports = {
  RANKING_CONFIG,
  computeUnitPartnershipBreakdown,
  computeInstitutionTotals,
  rankOpportunities,
  computeTargetGapSummary,
  computeSnapshot,
};
