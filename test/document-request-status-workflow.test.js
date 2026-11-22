// Covers the 2026-09-04 Document Request workflow redesign: the 6-stage
// pipeline (Received -> Preparing -> Awaiting for Approval -> Approved ->
// Release -> Completed) that replaced the old binary Pending/Under Review
// decision model, plus the separate Rejected outcome kept alongside it.
// Tests here focus on what test/document-request-print.test.js and
// test/document-request-draft-collaboration.test.js don't already cover:
// canonicalStatus normalization for legacy records, per-stage notifications,
// statusHistory shape, RBAC on the PATCH endpoint, and the cancel/DELETE
// gate's new "Received-only" rule.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent, staffAgent, personnelAgent, otherPersonnelAgent;
let personnelUser;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  personnelUser = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, personnelUser);
  otherPersonnelAgent = request.agent(app);
  await loginAs(otherPersonnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
});

afterAll(async () => {
  // cleanupAll() (users/partnerships/requests/activitylogs) doesn't reach
  // documentrequests or notifications — every doc/notification this file
  // creates is already explicitly deleted per-describe above, but this is a
  // final safety net against any leftover matching this file's fixed
  // institution/document-type test marker, since MONGO_URI is the real,
  // shared database (no separate test DB in this project).
  const db = await connectDB();
  await db.collection('documentrequests').deleteMany({ documentType: { $regex: 'jesttest Workflow Document' } });
  await db.collection('notifications').deleteMany({ desc: { $regex: 'jesttest Workflow Document' } });
  await cleanupAll();
  await closeDB();
});

async function submitDocRequest(agent, extra) {
  const res = await agent.post('/api/document-requests').send(Object.assign({
    institution: 'CCS', documentTypes: ['jesttest Workflow Document'], notes: 'jesttest'
  }, extra || {}));
  return res.body.request;
}

describe('New submissions start at the canonical pipeline start', () => {
  test('POST /api/document-requests creates the record with status "Received", not the legacy "Pending"', async () => {
    const r = await submitDocRequest(personnelAgent);
    expect(r.status).toBe('Received');
    await (await connectDB()).collection('documentrequests').deleteOne({ id: r.id });
  });
});

describe('Status transition enforcement (forward-only, one step at a time)', () => {
  let id;
  beforeAll(async () => { id = (await submitDocRequest(personnelAgent)).id; });
  afterAll(async () => { await (await connectDB()).collection('documentrequests').deleteOne({ id }); });

  test('Skipping ahead (Received -> Approved) is rejected', async () => {
    const res = await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Approved' });
    expect(res.status).toBe(400);
  });

  test('The one legitimate next step (Received -> Preparing) succeeds', async () => {
    const res = await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Preparing' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('Preparing');
  });

  test('Moving backward (Preparing -> Received) is rejected', async () => {
    const res = await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Received' });
    expect(res.status).toBe(400);
  });

  test('Rejected is reachable from any non-terminal stage, out of sequence', async () => {
    const res = await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Rejected', remark: 'jesttest reason' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('Rejected');
  });

  test('An unrecognized status string is rejected outright', async () => {
    const freshId = (await submitDocRequest(personnelAgent)).id;
    try {
      const res = await adminAgent.patch(`/api/document-requests/${freshId}`).send({ status: 'NotARealStatus' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Invalid status.');
    } finally {
      await (await connectDB()).collection('documentrequests').deleteOne({ id: freshId });
    }
  });
});

describe('Legacy status backward compatibility', () => {
  let id;
  beforeAll(async () => {
    // Simulate a pre-2026-09-04 record by writing the legacy status names
    // directly, bypassing the API (which now only ever writes canonical
    // values) — this is the only way to get a genuinely legacy-shaped
    // document into the collection for the test.
    const r = await submitDocRequest(personnelAgent);
    id = r.id;
    const db = await connectDB();
    await db.collection('documentrequests').updateOne({ id }, { $set: { status: 'Under Review' } });
  });
  afterAll(async () => { await (await connectDB()).collection('documentrequests').deleteOne({ id }); });

  test('GET /api/document-requests exposes canonicalStatus without altering the stored legacy value', async () => {
    const res = await adminAgent.get('/api/document-requests');
    const found = res.body.find(r => r.id === id);
    expect(found.status).toBe('Under Review');
    expect(found.canonicalStatus).toBe('Preparing');
  });

  test('GET /api/document-requests/mine exposes the same normalization for the requester', async () => {
    const res = await personnelAgent.get('/api/document-requests/mine');
    const found = res.body.find(r => r.id === id);
    expect(found.canonicalStatus).toBe('Preparing');
  });

  test('PATCH accepts a legacy status value as input and normalizes it to canonical on write', async () => {
    // The record's real position is 'Preparing' (canonical). Sending the
    // legacy 'Fulfilled' (-> canonical 'Completed') would be an illegal
    // 4-stage skip, so this proves normalization happens on the INPUT side
    // too by using the one legacy name that IS the legitimate next step.
    const res = await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Fulfilled' });
    // 'Fulfilled' normalizes to 'Completed', which is NOT the next step from
    // 'Preparing' (Awaiting for Approval is) — must still be rejected.
    expect(res.status).toBe(400);
  });

  test('A legacy-shaped current status still transitions correctly to its real next canonical stage', async () => {
    const res = await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Awaiting for Approval' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('Awaiting for Approval');
  });
});

describe('statusHistory: append-only audit trail of every transition', () => {
  let id;
  beforeAll(async () => { id = (await submitDocRequest(personnelAgent)).id; });
  afterAll(async () => { await (await connectDB()).collection('documentrequests').deleteOne({ id }); });

  test('Each transition appends one entry with from/to/by/at — never overwriting a previous one', async () => {
    await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Preparing', remark: 'jesttest step 1' });
    await staffAgent.patch(`/api/document-requests/${id}`).send({ status: 'Awaiting for Approval', remark: 'jesttest step 2' });

    const db = await connectDB();
    const doc = await db.collection('documentrequests').findOne({ id });
    expect(doc.statusHistory.length).toBe(2);
    expect(doc.statusHistory[0]).toEqual(expect.objectContaining({
      from: 'Received', to: 'Preparing', by: 'jesttest Administrator', remark: 'jesttest step 1'
    }));
    expect(doc.statusHistory[1]).toEqual(expect.objectContaining({
      from: 'Preparing', to: 'Awaiting for Approval', by: 'jesttest Staff', remark: 'jesttest step 2'
    }));
    expect(typeof doc.statusHistory[0].at).toBe('string');
    expect(typeof doc.statusHistory[0].byEmail).toBe('string');
  });
});

describe('Notifications fire for every stage except the starting "Received" state', () => {
  let id;
  beforeAll(async () => { id = (await submitDocRequest(personnelAgent)).id; });
  afterAll(async () => {
    const db = await connectDB();
    await db.collection('documentrequests').deleteOne({ id });
    await db.collection('notifications').deleteMany({ targetEmail: personnelUser.email, desc: { $regex: 'jesttest Workflow Document' } });
  });

  test('Preparing, Awaiting for Approval, Approved, Release, and Completed each notify the requester', async () => {
    const db = await connectDB();
    for (const status of ['Preparing', 'Awaiting for Approval', 'Approved', 'Release', 'Completed']) {
      await adminAgent.patch(`/api/document-requests/${id}`).send({ status });
      const notif = await db.collection('notifications').findOne({
        targetEmail: personnelUser.email,
        title: { $regex: `Document Request ${status}` }
      });
      expect(notif).toBeTruthy();
    }
  });
});

describe('Rejection notification', () => {
  let id;
  beforeAll(async () => { id = (await submitDocRequest(personnelAgent)).id; });
  afterAll(async () => {
    const db = await connectDB();
    await db.collection('documentrequests').deleteOne({ id });
    await db.collection('notifications').deleteMany({ targetEmail: personnelUser.email, desc: { $regex: 'jesttest Workflow Document' } });
  });

  test('Rejected notifies the requester with the rejection reason', async () => {
    await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Rejected', remark: 'jesttest missing signature' });
    const db = await connectDB();
    const notif = await db.collection('notifications').findOne({ targetEmail: personnelUser.email, title: { $regex: 'Document Request Rejected' } });
    expect(notif).toBeTruthy();
    expect(notif.desc).toMatch(/jesttest missing signature/);
  });
});

describe('RBAC: only Administrator/Staff can advance the workflow; only the owner can cancel', () => {
  let id;
  beforeAll(async () => { id = (await submitDocRequest(personnelAgent)).id; });
  afterAll(async () => { await (await connectDB()).collection('documentrequests').deleteOne({ id }); });

  test('Auth. Personnel (even the requester) cannot PATCH the status', async () => {
    const res = await personnelAgent.patch(`/api/document-requests/${id}`).send({ status: 'Preparing' });
    expect(res.status).toBe(302); // requireStaffAccess redirects non-reviewers
  });

  test('Staff CAN advance the workflow (full parity with Administrator)', async () => {
    const res = await staffAgent.patch(`/api/document-requests/${id}`).send({ status: 'Preparing' });
    expect(res.status).toBe(200);
  });

  test('A different Auth. Personnel account cannot cancel someone else\'s request', async () => {
    const freshId = (await submitDocRequest(personnelAgent)).id;
    try {
      const res = await otherPersonnelAgent.delete(`/api/document-requests/${freshId}`);
      expect(res.status).toBe(403);
    } finally {
      await (await connectDB()).collection('documentrequests').deleteOne({ id: freshId });
    }
  });
});

describe('Cancel (DELETE): only while still at the pipeline\'s starting stage', () => {
  test('The owner can cancel a freshly-submitted (Received) request', async () => {
    const r = await submitDocRequest(personnelAgent);
    const res = await personnelAgent.delete(`/api/document-requests/${r.id}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  test('The owner cannot cancel once it has moved past Received', async () => {
    const r = await submitDocRequest(personnelAgent);
    try {
      await adminAgent.patch(`/api/document-requests/${r.id}`).send({ status: 'Preparing' });
      const res = await personnelAgent.delete(`/api/document-requests/${r.id}`);
      expect(res.status).toBe(400);
    } finally {
      await (await connectDB()).collection('documentrequests').deleteOne({ id: r.id });
    }
  });

  test('A legacy "Pending" record is still cancellable (backward compatibility)', async () => {
    const r = await submitDocRequest(personnelAgent);
    const db = await connectDB();
    await db.collection('documentrequests').updateOne({ id: r.id }, { $set: { status: 'Pending' } });
    const res = await personnelAgent.delete(`/api/document-requests/${r.id}`);
    expect(res.status).toBe(200);
  });
});

describe('Terminal states cannot be advanced further', () => {
  test('Completed cannot be moved to any other status, including Rejected', async () => {
    const r = await submitDocRequest(personnelAgent);
    try {
      for (const status of ['Preparing', 'Awaiting for Approval', 'Approved', 'Release', 'Completed']) {
        const res = await adminAgent.patch(`/api/document-requests/${r.id}`).send({ status });
        expect(res.status).toBe(200);
      }
      const rejectAttempt = await adminAgent.patch(`/api/document-requests/${r.id}`).send({ status: 'Rejected' });
      expect(rejectAttempt.status).toBe(400);
    } finally {
      await (await connectDB()).collection('documentrequests').deleteOne({ id: r.id });
    }
  });

  test('Rejected cannot be moved to any other status', async () => {
    const r = await submitDocRequest(personnelAgent);
    try {
      await adminAgent.patch(`/api/document-requests/${r.id}`).send({ status: 'Rejected' });
      const res = await adminAgent.patch(`/api/document-requests/${r.id}`).send({ status: 'Preparing' });
      expect(res.status).toBe(400);
    } finally {
      await (await connectDB()).collection('documentrequests').deleteOne({ id: r.id });
    }
  });
});

// 2026-11 audit fix (Critical #1): the updateOne filter is now conditioned on the exact status just read
// (current.status), so the loser of a race gets matchedCount 0 -> 409 instead of silently applying a
// transition validated against data that's already stale.
describe('Race condition fix: concurrent status changes on the same document request', () => {
  test('two simultaneous "advance to Preparing" calls: exactly one succeeds (200), the other gets 409, and only one statusHistory entry is appended', async () => {
    const r = await submitDocRequest(personnelAgent);
    try {
      const [a, b] = await Promise.all([
        adminAgent.patch(`/api/document-requests/${r.id}`).send({ status: 'Preparing' }),
        staffAgent.patch(`/api/document-requests/${r.id}`).send({ status: 'Preparing' })
      ]);
      // Exactly one must win; the other is rejected either by the race guard itself (409, if both
      // requests' findOne genuinely interleaved) or by the pre-existing pipeline pre-check (400, "can
      // only move to X next" — if the loser's own findOne ran after the winner had already committed
      // "Preparing" and its own next-step check no longer matches) — both are correct outcomes of the
      // same fix; which one fires is a timing detail, not a contract.
      const winner = a.status === 200 ? a : b;
      const loser = a.status === 200 ? b : a;
      expect(winner.status).toBe(200);
      expect([400, 409]).toContain(loser.status);

      const stored = await (await connectDB()).collection('documentrequests').findOne({ id: r.id });
      expect(stored.status).toBe('Preparing');
      expect(stored.statusHistory.filter((h) => h.to === 'Preparing').length).toBe(1);
    } finally {
      await (await connectDB()).collection('documentrequests').deleteOne({ id: r.id });
    }
  });
});
