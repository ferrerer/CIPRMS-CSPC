// Monthly/Yearly Target Tracker (2026-09-06): org-wide targets (confirmed
// with the user — no per-unit dimension), counting every partnership
// regardless of `nature` (also confirmed). Current accomplishment is always
// computed live from the `partnerships` collection via the one authoritative
// computeTargetAccomplishment() in cirl.js — never stored/copied onto the
// target document itself, so these tests double as proof that creating a
// partnership record is what moves the numbers, not editing a target.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db;
let adminAgent, staffAgent, personnelAgent, partnerAgent;
const createdTargetIds = [];
const createdPartnershipIds = [];

// 2026-11 audit fix (test hygiene #9): every year below used to be a hardcoded absolute value
// (2031-2050) — fine today, but a magic value that eventually becomes "the past" as real time
// advances, and a flat risk of colliding with another test file's own hardcoded pick (this is
// exactly how test/yearly-target-card.test.js now does it too). Relative to CURRENT_YEAR with a
// fixed, distinct offset per logical period keeps every test's own year-to-year relationships
// (same year reused across a describe block, two YEARS in a row for the boundary test) identical
// to before, just anchored to "now" instead of a fixed point that will eventually stop being future.
const CURRENT_YEAR = new Date().getFullYear();
const Y_BASIC = CURRENT_YEAR + 5;      // RBAC/Test1/Test3/Test4 — single reused year
const Y_STAFF = CURRENT_YEAR + 6;      // Test 2 — Staff create
const Y_REJECTED = CURRENT_YEAR + 7;   // Test 2 — non-admin rejected create
const Y_VALIDATION = CURRENT_YEAR + 8; // Validation describe block
const Y_MONTHLY = CURRENT_YEAR + 9;    // Test 5, 7 & 8 — monthly accomplishment
const Y_YEARLY = CURRENT_YEAR + 10;    // Test 6 — yearly accomplishment
const Y_EXCEEDED = CURRENT_YEAR + 11;  // Test 9 — TARGET_EXCEEDED
const Y_MONTH_BOUNDARY = CURRENT_YEAR + 12; // Test 10 — Feb/Mar same year
const Y_BOUNDARY_A = CURRENT_YEAR + 13;     // Test 11 — year boundary, first year
const Y_BOUNDARY_B = CURRENT_YEAR + 14;     // Test 11 — year boundary, next year (must stay consecutive)
const Y_DELETE = CURRENT_YEAR + 15;         // Delete describe block

async function seedPartnership(startDate, extra = {}) {
  const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = last.length ? last[0].id + 1 : 1;
  const doc = {
    id, inst: 'jesttest Target Univ', country: 'Testland', region: 'Test Region',
    type: 'MOA', nature: 'New', cat: 'Academic', unit: ['CCS'],
    start: startDate, end: 'Dec 31, 2099', status: 'Active', remarks: 'jesttest',
    ...extra
  };
  await db.collection('partnerships').insertOne(doc);
  createdPartnershipIds.push(id);
  return doc;
}

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
});

afterAll(async () => {
  if (createdTargetIds.length) await db.collection('targets').deleteMany({ id: { $in: createdTargetIds } });
  if (createdPartnershipIds.length) await db.collection('partnerships').deleteMany({ id: { $in: createdPartnershipIds } });
  await cleanupAll();
  await closeDB();
});

describe('RBAC', () => {
  test('unauthenticated request cannot reach target APIs', async () => {
    const getRes = await request(app).get('/api/targets');
    expect(getRes.status).toBe(302);
    const postRes = await request(app).post('/api/targets').send({ type: 'yearly', year: Y_BASIC, targetCount: 5 });
    expect(postRes.status).toBe(302);
  });

  // 2026-11 audit fix (test hygiene #6): the id is now tracked for cleanup IMMEDIATELY after the create
  // call succeeds, before any expect() that could throw — previously the push sat after five assertions,
  // so a failing assertion here left the record untracked and afterAll() never deleted it, exactly the
  // leak that caused a stray year to collide (409) with a later run.
  test('Test 1 — Administrator can create a target', async () => {
    const res = await adminAgent.post('/api/targets').send({ type: 'yearly', year: Y_BASIC, targetCount: 50 });
    if (res.body && res.body.target) createdTargetIds.push(res.body.target.id);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.target.type).toBe('yearly');
    expect(res.body.target.year).toBe(Y_BASIC);
    expect(res.body.target.targetCount).toBe(50);
    expect(res.body.target.createdBy).toBe('jesttest Administrator');
  });

  test('Test 2 — Staff can also create a target (2026-11, confirmed for the Yearly Target dashboard card); Auth. Personnel and potential_partner still cannot', async () => {
    const staffRes = await staffAgent.post('/api/targets').send({ type: 'yearly', year: Y_STAFF, targetCount: 10 });
    if (staffRes.body && staffRes.body.target) createdTargetIds.push(staffRes.body.target.id);
    expect(staffRes.status).toBe(200);
    expect(staffRes.body.target.createdBy).toBe('jesttest Staff');

    const personnelRes = await personnelAgent.post('/api/targets').send({ type: 'yearly', year: Y_REJECTED, targetCount: 10 });
    expect(personnelRes.status).toBe(302);
    const partnerRes = await partnerAgent.post('/api/targets').send({ type: 'yearly', year: Y_REJECTED, targetCount: 10 });
    expect(partnerRes.status).toBe(302);
    const created = await db.collection('targets').findOne({ type: 'yearly', year: Y_REJECTED });
    expect(created).toBeNull();
  });

  test('Auth. Personnel and potential_partner cannot even VIEW targets (requireStaffAccess, not requireAuth)', async () => {
    const personnelRes = await personnelAgent.get('/api/targets');
    expect(personnelRes.status).toBe(302);
    const partnerRes = await partnerAgent.get('/api/targets');
    expect(partnerRes.status).toBe(302);
  });

  test('Staff CAN view targets (full dashboard parity)', async () => {
    const res = await staffAgent.get('/api/targets');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('Test 3 — Administrator can update a target', async () => {
    const target = await db.collection('targets').findOne({ type: 'yearly', year: Y_BASIC });
    const res = await adminAgent.patch(`/api/targets/${target.id}`).send({ targetCount: 75 });
    expect(res.status).toBe(200);
    expect(res.body.target.targetCount).toBe(75);
  });

  test('Test 4 — Staff can also update a target; Auth. Personnel still cannot', async () => {
    const target = await db.collection('targets').findOne({ type: 'yearly', year: Y_BASIC });
    const staffRes = await staffAgent.patch(`/api/targets/${target.id}`).send({ targetCount: 80, notes: 'jesttest note' });
    expect(staffRes.status).toBe(200);
    expect(staffRes.body.target.targetCount).toBe(80);
    expect(staffRes.body.target.notes).toBe('jesttest note');

    const personnelRes = await personnelAgent.patch(`/api/targets/${target.id}`).send({ targetCount: 999 });
    expect(personnelRes.status).toBe(302);
    const unchanged = await db.collection('targets').findOne({ id: target.id });
    expect(unchanged.targetCount).toBe(80);
  });
});

describe('Validation', () => {
  test('rejects an invalid type', async () => {
    const res = await adminAgent.post('/api/targets').send({ type: 'weekly', year: Y_VALIDATION, targetCount: 5 });
    expect(res.status).toBe(400);
  });

  test('rejects a monthly target with no month', async () => {
    const res = await adminAgent.post('/api/targets').send({ type: 'monthly', year: Y_VALIDATION, targetCount: 5 });
    expect(res.status).toBe(400);
  });

  test('rejects a yearly target that also supplies a month', async () => {
    const res = await adminAgent.post('/api/targets').send({ type: 'yearly', year: Y_VALIDATION, month: 5, targetCount: 5 });
    expect(res.status).toBe(400);
  });

  test('rejects a non-positive targetCount', async () => {
    const res = await adminAgent.post('/api/targets').send({ type: 'yearly', year: Y_VALIDATION, targetCount: 0 });
    expect(res.status).toBe(400);
  });

  test('rejects an out-of-range year', async () => {
    const res = await adminAgent.post('/api/targets').send({ type: 'yearly', year: 1900, targetCount: 5 });
    expect(res.status).toBe(400);
  });

  test('Test 12 — a duplicate target definition for the same period is rejected', async () => {
    const first = await adminAgent.post('/api/targets').send({ type: 'monthly', year: Y_VALIDATION, month: 6, targetCount: 8 });
    expect(first.status).toBe(200);
    createdTargetIds.push(first.body.target.id);
    const dup = await adminAgent.post('/api/targets').send({ type: 'monthly', year: Y_VALIDATION, month: 6, targetCount: 20 });
    expect(dup.status).toBe(409);
    const count = await db.collection('targets').countDocuments({ type: 'monthly', year: Y_VALIDATION, month: 6 });
    expect(count).toBe(1);
  });
});

describe('Progress calculation — the authoritative source of truth', () => {
  test('Test 5 — monthly accomplishment counts only partnerships whose real start date falls in that month/year', async () => {
    await seedPartnership(`Mar 5, ${Y_MONTHLY}`);
    await seedPartnership(`Mar 20, ${Y_MONTHLY}`);
    await seedPartnership(`Apr 1, ${Y_MONTHLY}`); // wrong month, must NOT count
    const created = await adminAgent.post('/api/targets').send({ type: 'monthly', year: Y_MONTHLY, month: 3, targetCount: 10 });
    expect(created.status).toBe(200);
    createdTargetIds.push(created.body.target.id);
    expect(created.body.target.progress.current).toBe(2);
  });

  test('Test 6 — yearly accomplishment counts every partnership that started that calendar year, independent of month', async () => {
    await seedPartnership(`Jan 1, ${Y_YEARLY}`);
    await seedPartnership(`Jun 15, ${Y_YEARLY}`);
    await seedPartnership(`Dec 31, ${Y_YEARLY}`);
    await seedPartnership(`Jan 1, ${Y_YEARLY + 1}`); // wrong year, must NOT count
    const created = await adminAgent.post('/api/targets').send({ type: 'yearly', year: Y_YEARLY, targetCount: 10 });
    expect(created.status).toBe(200);
    createdTargetIds.push(created.body.target.id);
    expect(created.body.target.progress.current).toBe(3);
  });

  test('Test 7 & 8 — lacking and percentage are computed correctly below target', async () => {
    // Reuses the 2 accomplishments seeded for the Mar Y_MONTHLY monthly target above.
    const target = await db.collection('targets').findOne({ type: 'monthly', year: Y_MONTHLY, month: 3 });
    const res = await adminAgent.get('/api/targets');
    const found = res.body.find(t => t.id === target.id);
    expect(found.progress.current).toBe(2);
    expect(found.progress.lacking).toBe(8); // 10 - 2
    expect(found.progress.percentage).toBe(20); // 2/10
    expect(found.progress.rawPercentage).toBe(20);
    expect(found.progress.status).toBe('IN_PROGRESS');
  });

  test('Test 9 — current exceeding target is preserved (not hidden), progress bar caps at 100, status is TARGET_EXCEEDED', async () => {
    await seedPartnership(`Jul 1, ${Y_EXCEEDED}`);
    await seedPartnership(`Jul 2, ${Y_EXCEEDED}`);
    await seedPartnership(`Jul 3, ${Y_EXCEEDED}`);
    const created = await adminAgent.post('/api/targets').send({ type: 'monthly', year: Y_EXCEEDED, month: 7, targetCount: 2 });
    createdTargetIds.push(created.body.target.id);
    const p = created.body.target.progress;
    expect(p.current).toBe(3); // real value preserved, not capped
    expect(p.lacking).toBe(0); // max(target - current, 0)
    expect(p.percentage).toBe(100); // visual indicator capped at 100
    expect(p.rawPercentage).toBe(150); // true percentage still exposed
    expect(p.status).toBe('TARGET_EXCEEDED');
  });

  test('Test 10 — month boundaries: Feb 28 and Mar 1 land in different months, no off-by-one', async () => {
    await seedPartnership(`Feb 28, ${Y_MONTH_BOUNDARY}`);
    await seedPartnership(`Mar 1, ${Y_MONTH_BOUNDARY}`);
    const febTarget = await adminAgent.post('/api/targets').send({ type: 'monthly', year: Y_MONTH_BOUNDARY, month: 2, targetCount: 5 });
    const marTarget = await adminAgent.post('/api/targets').send({ type: 'monthly', year: Y_MONTH_BOUNDARY, month: 3, targetCount: 5 });
    createdTargetIds.push(febTarget.body.target.id, marTarget.body.target.id);
    expect(febTarget.body.target.progress.current).toBe(1);
    expect(marTarget.body.target.progress.current).toBe(1);
  });

  test('Test 11 — year boundaries: Dec 31 and Jan 1 of the next year land in different years', async () => {
    await seedPartnership(`Dec 31, ${Y_BOUNDARY_A}`);
    await seedPartnership(`Jan 1, ${Y_BOUNDARY_B}`);
    const yA = await adminAgent.post('/api/targets').send({ type: 'yearly', year: Y_BOUNDARY_A, targetCount: 5 });
    const yB = await adminAgent.post('/api/targets').send({ type: 'yearly', year: Y_BOUNDARY_B, targetCount: 5 });
    createdTargetIds.push(yA.body.target.id, yB.body.target.id);
    expect(yA.body.target.progress.current).toBe(1);
    expect(yB.body.target.progress.current).toBe(1);
  });

  test('Test 13 — reading target progress never modifies the underlying Registry records', async () => {
    const before = await db.collection('partnerships').findOne({ id: createdPartnershipIds[0] });
    await adminAgent.get('/api/targets');
    await adminAgent.get('/api/targets');
    const after = await db.collection('partnerships').findOne({ id: createdPartnershipIds[0] });
    expect(after).toEqual(before);
  });
});

describe('Delete', () => {
  test('Administrator can delete a target; non-admin cannot', async () => {
    const created = await adminAgent.post('/api/targets').send({ type: 'yearly', year: Y_DELETE, targetCount: 5 });
    const id = created.body.target.id;
    const staffAttempt = await staffAgent.delete(`/api/targets/${id}`);
    expect(staffAttempt.status).toBe(302);
    const adminAttempt = await adminAgent.delete(`/api/targets/${id}`);
    expect(adminAttempt.status).toBe(200);
    expect(await db.collection('targets').findOne({ id })).toBeNull();
  });
});
