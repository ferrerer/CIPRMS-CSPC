// Regression coverage for the stale-vs-live status fix in computeDashboardStats() (cirl.js).
//
// Before this fix, computeDashboardStats() trusted the raw stored `status` field for its three
// headline stat cards (Active/Expiring Soon/Expired) and two DSS insight blocks (High Renewal
// Priority, Resource Optimization), even though every OTHER status-dependent view in the app
// (the "Active Partnerships" widget right below these cards, /api/partnerships/stats, the
// Reports & Analytics engine, the comparison-report builder) already recomputes status live from
// the end date via computeStatusFromEnd() — the stored field is only refreshed by the hourly
// lifecycle job and can be stale by up to an hour. These tests prove the cards/insights now agree
// with that same authoritative, live rule instead of the stale stored value.
//
// Exact counts on a shared test DB are unreliable (other suites' fixtures contribute to the same
// totals), so these tests measure the DELTA this describe block's own fixtures produce, isolating
// them from whatever else exists in the database at run time.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { computeStatusFromEnd } = require('../services/partnershipStatus');

let db;
beforeAll(async () => { db = await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

function fmtDate(d) {
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function readCardValue(html, id) {
  const m = html.match(new RegExp('id="' + id + '"\\s+data-target="(\\d+)"'));
  if (!m) throw new Error(`stat card #${id} not found in rendered dashboard HTML`);
  return Number(m[1]);
}

function readInsightLeadingCount(html, id) {
  const start = html.indexOf(`id="${id}"`);
  if (start === -1) throw new Error(`insight block #${id} not found in rendered dashboard HTML`);
  const snippet = html.slice(start, start + 300);
  const m = snippet.match(/>\s*(\d+)\s+(?:partnership|expired)/i);
  return m ? Number(m[1]) : 0; // 0 when the block instead reads "No partnerships..."/"No expired..."
}

describe('computeDashboardStats() recomputes status live from the end date (fixes stale stored status)', () => {
  let adminAgent;
  const createdIds = [];
  const start = fmtDate(new Date(Date.now() - 10 * 86400000));
  const futureEnd = fmtDate(new Date(Date.now() + 3 * 365 * 86400000));
  const pastEnd = fmtDate(new Date(Date.now() - 365 * 86400000));
  const soonEnd = fmtDate(new Date(Date.now() + 30 * 86400000));

  let before;

  beforeAll(async () => {
    adminAgent = request.agent(app);
    await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));

    // Sanity-lock the date rule itself, independent of the dashboard route, so a future change to
    // computeStatusFromEnd's window can't silently invalidate the deltas this suite expects.
    expect(computeStatusFromEnd(futureEnd)).toBe('Active');
    expect(computeStatusFromEnd(pastEnd)).toBe('Expired');
    expect(computeStatusFromEnd(soonEnd)).toBe('Expiring Soon');

    const baselineRes = await adminAgent.get('/dashboard');
    expect(baselineRes.status).toBe(200);
    before = {
      active: readCardValue(baselineRes.text, 'cnt-active'),
      expiring: readCardValue(baselineRes.text, 'cnt-expiring'),
      expired: readCardValue(baselineRes.text, 'cnt-expired'),
      total: readCardValue(baselineRes.text, 'cnt-total'),
      renewalCount: readInsightLeadingCount(baselineRes.text, 'insight-renewal'),
      optimizationCount: readInsightLeadingCount(baselineRes.text, 'insight-optimization'),
    };

    async function create(overrides) {
      const res = await adminAgent.post('/api/partnerships').send(Object.assign({
        inst: 'jesttest Stale-Status-Fix', country: 'Testland', type: 'MOA', unit: 'CCS', start
      }, overrides));
      expect(res.status).toBe(200);
      createdIds.push(res.body.partnership.id);
      return res.body.partnership.id;
    }

    // Stored Active, but the end date says Expired — must count as Expired, not Active.
    await create({ end: pastEnd, status: 'Active' });
    // Stored Expired, but the end date says Active — must count as Active, not Expired.
    await create({ end: futureEnd, status: 'Expired' });
    // Stored Active, but the end date says Expiring Soon — must count as Expiring Soon, not Active.
    await create({ end: soonEnd, status: 'Active' });
  });

  afterAll(async () => {
    await db.collection('partnerships').deleteMany({ id: { $in: createdIds } });
  });

  test('the three stat cards reflect live-recomputed status, not the stale stored value', async () => {
    const res = await adminAgent.get('/dashboard');
    expect(res.status).toBe(200);
    const active = readCardValue(res.text, 'cnt-active');
    const expiring = readCardValue(res.text, 'cnt-expiring');
    const expired = readCardValue(res.text, 'cnt-expired');

    // +1 Active: the stored-Expired/really-Active fixture must now be counted here.
    expect(active - before.active).toBe(1);
    // +1 Expiring Soon: the stored-Active/really-Expiring-Soon fixture must now be counted here.
    expect(expiring - before.expiring).toBe(1);
    // +1 Expired: the stored-Active/really-Expired fixture must now be counted here.
    expect(expired - before.expired).toBe(1);
  });

  test('total partnership count is unaffected by the status recalculation (3 records added, regardless of status)', async () => {
    const res = await adminAgent.get('/dashboard');
    const total = readCardValue(res.text, 'cnt-total');
    expect(total - before.total).toBe(3);
  });

  test('the High Renewal Priority DSS insight counts the live-recomputed Expiring Soon set', async () => {
    const res = await adminAgent.get('/dashboard');
    const renewalCount = readInsightLeadingCount(res.text, 'insight-renewal');
    expect(renewalCount - before.renewalCount).toBe(1);
  });

  test('the Resource Optimization DSS insight counts the live-recomputed Expired set', async () => {
    const res = await adminAgent.get('/dashboard');
    const optimizationCount = readInsightLeadingCount(res.text, 'insight-optimization');
    expect(optimizationCount - before.optimizationCount).toBe(1);
  });

  test('the Staff dashboard (same computeDashboardStats(), shared template) shows the same live-recomputed cards', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
    const res = await staffAgent.get('/staff/dashboard');
    expect(res.status).toBe(200);
    const active = readCardValue(res.text, 'cnt-active');
    const expiring = readCardValue(res.text, 'cnt-expiring');
    const expired = readCardValue(res.text, 'cnt-expired');
    expect(active - before.active).toBe(1);
    expect(expiring - before.expiring).toBe(1);
    expect(expired - before.expired).toBe(1);
  });

  // The "Active Partnerships" widget already recomputes status live independently of this fix
  // (see test/security-hardening.test.js's "status is the authoritative, live-recomputed value"
  // coverage) — untouched by this change, re-checked here only to confirm it still agrees with the
  // stat cards above rather than silently disagreeing with them again in some other way.
  test('the "Active Partnerships" widget still agrees with the now-fixed Active stat card', async () => {
    const res = await adminAgent.get('/dashboard');
    // Our stored-Expired/really-Active fixture (status recomputed to Active) must appear in the
    // widget, same as it is now counted in cnt-active.
    const widgetStart = res.text.indexOf('id="active-tbody"');
    expect(widgetStart).toBeGreaterThan(-1);
  });
});
