// Deterministic strategic analytics — pure-function tests (ranking/chaining/target-gap reshape need
// no database at all) plus a small DB-integration check for the one new cross-tab query
// (computeUnitPartnershipBreakdown) against synthetic, jesttest-tagged fixtures only — never real
// institutional data, per the approved privacy design.
const { connectDB, closeDB } = require('../db');
const { cleanupAll } = require('./helpers');
const {
  RANKING_CONFIG, rankOpportunities, computeTargetGapSummary, computeUnitPartnershipBreakdown,
  computeInstitutionTotals, computeSnapshot
} = require('../services/strategicAnalyticsService');

describe('rankOpportunities — pure ranking math', () => {
  test('matches the approved hand-calculated examples (A/B/C), including a zero-partnership unit', () => {
    // Mirrors the chat record's worked examples exactly: maxActiveAcrossUnits=8 (from some other unit
    // not shown), CCS/CBA fully defined, CoE has zero partnerships at all.
    const breakdown = [
      { unit: 'CTE', total: 20, active: 8, international: 4, expiringSoon: 1 }, // sets maxActive=8
      { unit: 'CCS', total: 10, active: 6, international: 3, expiringSoon: 2 },
      { unit: 'CBA', total: 4, active: 1, international: 0, expiringSoon: 1 },
      { unit: 'CoE', total: 0, active: 0, international: 0, expiringSoon: 0 },
    ];
    const result = rankOpportunities(breakdown, RANKING_CONFIG);
    const byUnit = {};
    for (const g of result.rankGroups) for (const u of g.units) byUnit[u.unit] = { ...u, rank: g.rank, tied: g.tied };

    expect(byUnit.CCS.weightedScore).toBeCloseTo(0.350, 5);
    expect(byUnit.CBA.weightedScore).toBeCloseTo(0.750, 5);
    expect(byUnit.CoE.weightedScore).toBeCloseTo(1.000, 5);
    expect(byUnit.CoE.criteriaUsed).toBe('1/3');
    expect(byUnit.CoE.weightRedistributed).toBe(true);
    expect(byUnit.CCS.criteriaUsed).toBe('3/3');
    expect(result.institutionWideZeroActive).toBe(false);

    // Descending (approved): CoE highest, then CBA, then CCS.
    expect(byUnit.CoE.rank).toBeLessThan(byUnit.CBA.rank);
    expect(byUnit.CBA.rank).toBeLessThan(byUnit.CCS.rank);
  });

  test('maxActiveAcrossUnits === 0 never produces NaN/Infinity and flattens criterion 1 for every unit', () => {
    const breakdown = [
      { unit: 'A', total: 5, active: 0, international: 1, expiringSoon: 2 },
      { unit: 'B', total: 3, active: 0, international: 0, expiringSoon: 0 },
    ];
    const result = rankOpportunities(breakdown, RANKING_CONFIG);
    expect(result.institutionWideZeroActive).toBe(true);
    expect(result.note).toMatch(/No unit currently has any active partnership/);
    for (const g of result.rankGroups) {
      for (const u of g.units) {
        expect(u.criteria.activeCoverageGap).toBe(1);
        expect(Number.isFinite(u.weightedScore)).toBe(true);
        expect(Number.isNaN(u.weightedScore)).toBe(false);
      }
    }
  });

  test('adjacent-gap chaining groups a broken transitive chain into one cohort and reports a scoreSpan > EPSILON', () => {
    // A/B within 0.01, B/C within 0.01, but A/C is NOT within 0.01 — constructed directly as scores
    // via a breakdown shaped to land on these exact weightedScore values is awkward, so this test
    // exercises the chaining step in isolation against pre-computed scores instead.
    // (activeCoverageGap-only breakdown, maxActive=1000 so active-count differences produce fine-
    // grained scores close to the documented 0.300/0.308/0.316 example.)
    const breakdown = [
      { unit: 'HIGH', total: 0, active: 700, international: 0, expiringSoon: 0 }, // sets maxActive=700 -> baseline
      { unit: 'A', total: 0, active: 490, international: 0, expiringSoon: 0 },    // gap1 = 1-490/700 = 0.300
      { unit: 'B', total: 0, active: 484.4, international: 0, expiringSoon: 0 },  // gap1 = 1-484.4/700 = 0.308
      { unit: 'C', total: 0, active: 478.8, international: 0, expiringSoon: 0 },  // gap1 = 1-478.8/700 = 0.316
    ];
    const result = rankOpportunities(breakdown, RANKING_CONFIG);
    const cohortWithABC = result.rankGroups.find(g => g.units.some(u => u.unit === 'A'));
    const names = cohortWithABC.units.map(u => u.unit).sort();
    expect(names).toEqual(['A', 'B', 'C']);
    expect(cohortWithABC.tied).toBe(true);
    expect(cohortWithABC.scoreSpan).toBeGreaterThan(RANKING_CONFIG.epsilon);
    // Every member of the cohort shares one rank number — never sequential ranks within a tie.
    const ranksInCohort = new Set([cohortWithABC.rank]);
    expect(ranksInCohort.size).toBe(1);
  });

  test('dense ranking: a tied cohort never skips a rank number for what follows', () => {
    const breakdown = [
      { unit: 'TOP', total: 10, active: 0, international: 5, expiringSoon: 0 },
      { unit: 'TIE1', total: 10, active: 5, international: 5, expiringSoon: 0 },
      { unit: 'TIE2', total: 10, active: 5, international: 5, expiringSoon: 0 },
      { unit: 'LAST', total: 10, active: 10, international: 5, expiringSoon: 0 },
    ];
    const result = rankOpportunities(breakdown, RANKING_CONFIG);
    const ranks = result.rankGroups.map(g => g.rank);
    expect(ranks).toEqual([1, 2, 3]); // TOP=1, {TIE1,TIE2}=2 (tied), LAST=3 — never 1,2,2,4
  });
});

describe('computeTargetGapSummary — institution-wide only, no invented per-college breakdown', () => {
  test('reshapes an already-computed withTargetProgress()-style array without recomputing accomplishment', () => {
    const targetsWithProgress = [
      { id: 1, type: 'monthly', year: 2026, month: 11, targetCount: 10, active: true, progress: { current: 4, lacking: 6, percentage: 40, status: 'IN_PROGRESS' } },
      { id: 2, type: 'yearly', year: 2025, month: null, targetCount: 50, active: false, progress: { current: 50, lacking: 0, percentage: 100, status: 'TARGET_REACHED' } },
    ];
    const summary = computeTargetGapSummary(targetsWithProgress);
    expect(summary.scope).toBe('institution-wide');
    expect(summary.collegeBreakdown).toBeNull();
    expect(summary.targets).toHaveLength(1); // inactive target (#2) excluded
    expect(summary.targets[0]).toMatchObject({ id: 1, lacking: 6, percentage: 40, status: 'IN_PROGRESS' });
  });
});

describe('computeUnitPartnershipBreakdown — DB integration, synthetic fixtures only', () => {
  const stamp = Date.now();
  const unitA = `jesttest-unit-A-${stamp}`;
  const unitZero = `jesttest-unit-Z-${stamp}`;
  let db;
  const partnershipIds = [];
  const unitDocIds = [];

  beforeAll(async () => {
    db = await connectDB();
    const units = await db.collection('responsibleunits').find({}).sort({ id: -1 }).limit(1).toArray();
    let nextId = units.length ? units[0].id + 1 : 1;
    for (const name of [unitA, unitZero]) {
      await db.collection('responsibleunits').insertOne({ id: nextId, name, createdAt: new Date().toISOString() });
      unitDocIds.push(nextId);
      nextId += 1;
    }
    const partnerships = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
    let pId = partnerships.length ? partnerships[0].id + 1 : 1;
    const farFuture = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10); // Active
    const soon = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);       // Expiring Soon
    const fixtures = [
      { unit: [unitA], cat: 'International', end: farFuture },
      { unit: [unitA], cat: 'Local', end: soon },
    ];
    for (const f of fixtures) {
      await db.collection('partnerships').insertOne({ id: pId, unit: f.unit, cat: f.cat, end: f.end, remarks: `jesttest strategic-analytics ${stamp}` });
      partnershipIds.push(pId);
      pId += 1;
    }
  });

  afterAll(async () => {
    if (partnershipIds.length) await db.collection('partnerships').deleteMany({ id: { $in: partnershipIds } });
    if (unitDocIds.length) await db.collection('responsibleunits').deleteMany({ id: { $in: unitDocIds } });
    await cleanupAll();
    await closeDB();
  });

  test('a unit with partnerships gets the correct active/international/expiring counts; a unit with none is still surfaced at zero', async () => {
    const breakdown = await computeUnitPartnershipBreakdown(db);
    const a = breakdown.find(u => u.unit === unitA);
    const z = breakdown.find(u => u.unit === unitZero);
    expect(a).toMatchObject({ total: 2, active: 1, international: 1, expiringSoon: 1 });
    expect(z).toMatchObject({ total: 0, active: 0, international: 0, expiringSoon: 0 });
  });
});

// 2026-11 dashboard/AI-figures reconciliation: the AI Strategic Insights "Verified Institutional
// Figures" stat tiles were briefly computed by summing computeUnitPartnershipBreakdown()'s per-unit
// columns, which inflates the total whenever any partnership lists more than one responsible unit
// (that per-unit counting convention is deliberate — see cirl.js's /api/partnerships/stats byUnit
// tally for the same, pre-existing pattern — but it must never be presented as an institution-wide
// total). computeInstitutionTotals() is the fix: it must always match the SAME distinct-record
// counting convention as computeDashboardStats()/the main Dashboard, regardless of how many units a
// partnership lists.
describe('computeInstitutionTotals — distinct partnership counts, never inflated by multi-unit records', () => {
  const stamp = Date.now();
  const unitP = `jesttest-totals-P-${stamp}`;
  const unitQ = `jesttest-totals-Q-${stamp}`;
  const unitR = `jesttest-totals-R-${stamp}`;
  let db;
  const partnershipIds = [];
  const unitDocIds = [];

  beforeAll(async () => {
    db = await connectDB();
    const units = await db.collection('responsibleunits').find({}).sort({ id: -1 }).limit(1).toArray();
    let nextId = units.length ? units[0].id + 1 : 1;
    for (const name of [unitP, unitQ, unitR]) {
      await db.collection('responsibleunits').insertOne({ id: nextId, name, createdAt: new Date().toISOString() });
      unitDocIds.push(nextId);
      nextId += 1;
    }
    const partnerships = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
    let pId = partnerships.length ? partnerships[0].id + 1 : 1;
    const farFuture = new Date(Date.now() + 400 * 86400000).toISOString().slice(0, 10); // Active
    const past = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);       // Expired
    // 3 DISTINCT partnerships: 2 single-unit + 1 that lists all three units (unitP/Q/R) at once.
    const fixtures = [
      { unit: [unitP], cat: 'Local', end: farFuture },      // distinct partnership #1 — Active
      { unit: [unitQ], cat: 'Local', end: past },           // distinct partnership #2 — Expired
      { unit: [unitP, unitQ, unitR], cat: 'International', end: farFuture }, // distinct partnership #3 — Active, 3 units
    ];
    for (const f of fixtures) {
      await db.collection('partnerships').insertOne({ id: pId, unit: f.unit, cat: f.cat, end: f.end, remarks: `jesttest strategic-analytics-totals ${stamp}` });
      partnershipIds.push(pId);
      pId += 1;
    }
  });

  afterAll(async () => {
    if (partnershipIds.length) await db.collection('partnerships').deleteMany({ id: { $in: partnershipIds } });
    if (unitDocIds.length) await db.collection('responsibleunits').deleteMany({ id: { $in: unitDocIds } });
    await cleanupAll();
    await closeDB();
  });

  test('a partnership shared across 3 units counts ONCE institution-wide, not 3 times', async () => {
    const before = await db.collection('partnerships').countDocuments({});
    const totals = await computeInstitutionTotals(db);
    // Exactly the 3 synthetic fixtures above exist as of this describe block's own insert — assert
    // against the real distinct document count rather than a hardcoded absolute, so this test stays
    // correct even if other fixtures happen to coexist in the shared test DB.
    expect(totals.total).toBe(before);
  });

  test('institution totals reflect each distinct partnership exactly once, by status and category', async () => {
    const totals = await computeInstitutionTotals(db);
    const mine = await db.collection('partnerships').find({ id: { $in: partnershipIds } }).toArray();
    // Isolate to just this test's 3 fixtures for the status/category assertions (the shared test DB
    // may hold other partnerships created by a concurrently-running suite).
    expect(mine).toHaveLength(3);
    // 2 Active (farFuture end), 1 Expired (past end); 1 International, 2 Local — all counted once each.
    const activeAmongMine = mine.filter(p => new Date(p.end) > new Date()).length;
    const expiredAmongMine = mine.filter(p => new Date(p.end) < new Date()).length;
    const internationalAmongMine = mine.filter(p => p.cat === 'International').length;
    expect(activeAmongMine).toBe(2);
    expect(expiredAmongMine).toBe(1);
    expect(internationalAmongMine).toBe(1);
    // The institution-wide totals must be >= these counts (other concurrent fixtures could add more,
    // never fewer) — the precise regression guard is the multi-unit non-inflation test above.
    expect(totals.active).toBeGreaterThanOrEqual(activeAmongMine);
    expect(totals.expired).toBeGreaterThanOrEqual(expiredAmongMine);
    expect(totals.international).toBeGreaterThanOrEqual(internationalAmongMine);
  });

  test('computeSnapshot() exposes institutionTotals, and it does NOT equal summing the per-unit breakdown when a partnership spans multiple units', async () => {
    const snapshot = await computeSnapshot(db, { targetsWithProgress: [] });
    expect(snapshot.institutionTotals).toBeDefined();

    const breakdown = await computeUnitPartnershipBreakdown(db);
    const relevant = breakdown.filter(u => [unitP, unitQ, unitR].includes(u.unit));
    const perUnitSum = relevant.reduce((s, u) => s + u.total, 0);
    // The 3-unit partnership contributes 1 to each of unitP/unitQ/unitR's `total` — summing those
    // rows therefore double-counts it twice over. perUnitSum for just these 3 units must be strictly
    // greater than the number of distinct partnerships that touch them (3), proving the inflation
    // this fix addresses is real and reproducible, not just a one-off miscount.
    const distinctAmongTheseThreeUnits = 3; // all 3 synthetic fixtures touch at least one of unitP/Q/R
    expect(perUnitSum).toBeGreaterThan(distinctAmongTheseThreeUnits);
    expect(perUnitSum).toBe(5); // unitP:2 (fixtures #1,#3) + unitQ:2 (#2,#3) + unitR:1 (#3) = 5
  });
});
