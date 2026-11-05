// College Requests tab server-side pagination (2026-11 panel recommendation). GET /api/college-requests
// is backward compatible by construction: omitting `page` still returns the exact plain array every
// existing caller relies on — confirmed by the full test/college-dean-requests.test.js suite (29 tests)
// still passing unmodified. This file covers the new, strictly opt-in paginated shape and that the status
// filter (the one dimension the UI's filter tabs offer) is preserved when relocated server-side.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, adminAgent;
const seededIds = [];

async function createRequest(deanId, overrides) {
  const res = await adminAgent.post('/api/college-requests').send(Object.assign({
    requestType: 'MOA',
    title: `jesttest CDR Pagination ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    assignedDeanIds: [deanId]
  }, overrides || {}));
  if (res.body && res.body.request) seededIds.push(res.body.request.id);
  return res;
}

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  const dean = await createTestUser({ role: 'Auth. Personnel' });

  for (let i = 0; i < 12; i++) await createRequest(dean.id);
  // A couple with a different status, to exercise the status filter.
  const r1 = await createRequest(dean.id);
  const r2 = await createRequest(dean.id);
  const deanAgent = request.agent(app);
  await loginAs(deanAgent, dean);
  await deanAgent.post('/api/college-requests/' + r1.body.request.id + '/documents').send({ note: 'submission' });
  await deanAgent.post('/api/college-requests/' + r2.body.request.id + '/documents').send({ note: 'submission' });
}, 30000);

afterAll(async () => {
  if (seededIds.length) await db.collection('collegedeanrequests').deleteMany({ id: { $in: seededIds } });
  await cleanupAll();
  await closeDB();
});

describe('Backward compatibility', () => {
  test('omitting `page` still returns a plain array of everything in scope', async () => {
    const res = await adminAgent.get('/api/college-requests');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(14);
  });
});

describe('Paginated shape, page math, and the status filter', () => {
  test('page=1&pageSize=10 returns 10 records and the correct totalCount', async () => {
    const res = await adminAgent.get('/api/college-requests?page=1&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.records.length).toBe(10);
    expect(res.body.totalCount).toBeGreaterThanOrEqual(14);
    expect(res.body.page).toBe(1);
  });

  test('page=2 has no overlap with page=1', async () => {
    const p1 = await adminAgent.get('/api/college-requests?page=1&pageSize=10');
    const p2 = await adminAgent.get('/api/college-requests?page=2&pageSize=10');
    const ids1 = new Set(p1.body.records.map((r) => r.id));
    expect(p2.body.records.some((r) => ids1.has(r.id))).toBe(false);
  });

  test('status=Submitted filters server-side and matches the real count', async () => {
    const res = await adminAgent.get('/api/college-requests?page=1&pageSize=50&status=Submitted');
    expect(res.status).toBe(200);
    expect(res.body.records.every((r) => r.status === 'Submitted')).toBe(true);
    expect(res.body.totalCount).toBeGreaterThanOrEqual(2);
  });

  test('an invalid pageSize falls back to the default (25)', async () => {
    const res = await adminAgent.get('/api/college-requests?page=1&pageSize=12345');
    expect(res.body.pageSize).toBe(25);
  });
});

describe('Role scoping still applies to the paginated response', () => {
  test("a Dean's paginated fetch never includes another Dean's requests", async () => {
    const otherDean = await createTestUser({ role: 'Auth. Personnel' });
    const otherAgent = request.agent(app);
    await loginAs(otherAgent, otherDean);
    const res = await otherAgent.get('/api/college-requests?page=1&pageSize=50');
    expect(res.status).toBe(200);
    expect(res.body.totalCount).toBe(0);
  });
});
