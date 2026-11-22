// Backend RBAC for the Partnership Request API (/api/requests) — enforced by the server, not by hiding a page:
//   * College Dean (stored role "Auth. Personnel") has no Partnership Request workflow any more (page and form
//     removed; it submits Document Requests only), so every submitter route of /api/requests answers it 403 —
//     create, edit a draft, submit a draft, delete a draft, withdraw;
//   * Partner (Submit Only) and Administrator keep exactly what they had; CIRL Staff is still turned away
//     (302, unchanged) and still reviews;
//   * what College Dean legitimately keeps (Document Requests, its own Monitoring reads, renewal ownership
//     check) is untouched, and nothing in the existing request records is modified by any of this.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, agents, users, anon, baseline;
const requestIds = [], docRequestIds = [];

async function snapshotRequests() {
  return JSON.stringify(await db.collection('requests').find({ id: { $nin: requestIds } }).sort({ id: 1 }).toArray());
}

beforeAll(async () => {
  db = await connectDB();
  baseline = await snapshotRequests();
  agents = {}; users = {};
  for (const [key, role, unit] of [['admin', 'Administrator', ''], ['staff', 'Staff', ''], ['college', 'Auth. Personnel', 'CCS'], ['partner', 'potential_partner', '']]) {
    users[key] = await createTestUser({ role, unit });
    agents[key] = request.agent(app);
    await loginAs(agents[key], users[key]);
  }
  anon = request.agent(app);
});

afterAll(async () => {
  // Clean up first and always close the connection; only then assert, so a failing run can never leave rows
  // behind or hang the process.
  let after;
  try {
    // rows this file's accounts own, whatever a (failing) test did to their notes
    const owned = Object.values(users).map(u => u.email);
    await db.collection('requests').deleteMany({ $or: [{ id: { $in: requestIds } }, { submittedByEmail: { $in: owned } }] });
    if (docRequestIds.length) await db.collection('documentrequests').deleteMany({ id: { $in: docRequestIds } });
    await db.collection('documents').deleteMany({ $or: [{ requestType: 'partnership', requestId: { $in: requestIds } }, { requestType: 'document', requestId: { $in: docRequestIds } }] });
    await cleanupAll();
    after = await snapshotRequests();
  } finally {
    await closeDB();
  }
  expect(after).toBe(baseline);     // nothing outside this file's own rows moved
});

const body = (tag, extra) => ({ institution: `jesttest RBAC ${tag} ${Date.now()}${Math.random().toString(36).slice(2, 6)}`, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest', ...extra });

async function insertRequest(key, fields) {
  const last = await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = (last[0] ? last[0].id : 0) + 1;
  await db.collection('requests').insertOne({ id, institution: `jesttest RBAC inserted ${id}`, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest', requestedBy: `jesttest ${key}`, submittedByEmail: users[key].email, status: 'Pending', date: 'Sep 21, 2026', updatedAt: new Date().toISOString(), ...fields });
  requestIds.push(id);
  return id;
}
const countFor = (email) => db.collection('requests').countDocuments({ submittedByEmail: email });

describe('College Dean cannot use the Partnership Request API', () => {
  test('POST /api/requests -> 403 with a JSON error, and nothing is created', async () => {
    const res = await agents.college.post('/api/requests').send(body('college'));
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toMatch(/json/);
    expect(res.body.error).toMatch(/College Dean cannot submit Partnership Requests/);
    expect(res.body.success).toBeUndefined();
    expect(await countFor(users.college.email)).toBe(0);
  });

  test('a draft, a renewal, or a form-encoded post is refused the same way (no shape of the call gets around it)', async () => {
    const attempts = [
      agents.college.post('/api/requests').send(body('draft', { isDraft: true })),
      agents.college.post('/api/requests').send(body('renewal', { isRenewal: true, renewalPartnershipId: 1 })),
      agents.college.post('/api/requests').type('form').send(body('form')),
      agents.college.post('/api/requests').send({ isDraft: true }),
      agents.college.post('/api/requests').send({}),
      // fields that try to pass as someone else / another role
      agents.college.post('/api/requests').send(body('spoof', { submittedByEmail: users.partner.email, role: 'potential_partner', requestedBy: 'Someone Else' })),
      agents.college.post('/api/requests').set('X-HTTP-Method-Override', 'PUT').send(body('override')),
    ];
    for (const res of await Promise.all(attempts)) expect(res.status).toBe(403);
    expect(await countFor(users.college.email)).toBe(0);
    expect(await countFor(users.partner.email)).toBe(0);
  });

  test('an older draft or pending request owned by a College Dean account cannot be edited, submitted, deleted or withdrawn through the API', async () => {
    const draft = await insertRequest('college', { status: 'Draft' });
    const pending = await insertRequest('college', { status: 'Pending' });
    const before = await db.collection('requests').find({ id: { $in: [draft, pending] } }).sort({ id: 1 }).toArray();

    expect((await agents.college.patch(`/api/requests/${draft}/edit`).send({ notes: 'changed' })).status).toBe(403);
    expect((await agents.college.post(`/api/requests/${draft}/submit`)).status).toBe(403);
    expect((await agents.college.delete(`/api/requests/${draft}`)).status).toBe(403);
    expect((await agents.college.post(`/api/requests/${pending}/withdraw`)).status).toBe(403);

    const after = await db.collection('requests').find({ id: { $in: [draft, pending] } }).sort({ id: 1 }).toArray();
    expect(after).toEqual(before);                       // byte-for-byte unchanged: still Draft / still Pending
    expect(after.map(r => r.status)).toEqual(['Draft', 'Pending']);
  });

  test('no session still gets the existing redirect, and CIRL Staff is still turned away as before (302)', async () => {
    expect((await anon.post('/api/requests').send(body('anon'))).status).toBe(302);
    expect((await agents.staff.post('/api/requests').send(body('staff'))).status).toBe(302);
    expect(await countFor(users.staff.email)).toBe(0);
  });

  test('what College Dean legitimately keeps still works: Document Requests, its own request/partnership reads', async () => {
    const dr = await agents.college.post('/api/document-requests').send({ institution: 'jesttest RBAC college DR', documentTypes: ['Certificate'], notes: 'jesttest' });
    expect(dr.status).toBe(200);
    docRequestIds.push(dr.body.request.id);
    const mine = await agents.college.get('/api/document-requests/mine');
    expect(mine.status).toBe(200);
    expect(mine.body.some(r => r.id === dr.body.request.id)).toBe(true);
    expect((await agents.college.get('/api/requests/mine')).status).toBe(200);
    expect((await agents.college.get('/api/partnerships/mine')).status).toBe(200);
    expect((await agents.college.get('/api/requests')).status).toBe(200);            // own-scoped list (unchanged)
    // the renewal route keeps its own ownership rule: nothing approved of its own, so nothing to renew
    const renew = await agents.college.post('/api/partnerships/1/renew-request').send({ proposedEndDate: '2033-01-01' });
    expect([403, 404]).toContain(renew.status);
    expect((await agents.college.delete(`/api/document-requests/${dr.body.request.id}`)).status).toBe(200);
  });

  test('no 500 from any of the refused calls', async () => {
    const draft = await insertRequest('college', { status: 'Draft' });
    const calls = await Promise.all([
      agents.college.post('/api/requests').send(body('x')),
      agents.college.patch(`/api/requests/${draft}/edit`).send({}),
      agents.college.post(`/api/requests/${draft}/submit`),
      agents.college.delete(`/api/requests/${draft}`),
      agents.college.post('/api/requests/999999999/withdraw'),
      agents.college.post('/api/requests/not-a-number/withdraw'),
    ]);
    for (const res of calls) expect(res.status).toBe(403);
  });
});

describe('Partner keeps its Partnership Request workflow', () => {
  test('create, save a draft, edit it, submit it, delete a draft; withdrawing a pending one is refused', async () => {
    const created = await agents.partner.post('/api/requests').send(body('partner'));
    expect(created.status).toBe(200); expect(created.body.request.status).toBe('Pending'); requestIds.push(created.body.request.id);

    const draft = await agents.partner.post('/api/requests').send(body('partner-draft', { isDraft: true }));
    expect(draft.status).toBe(200); expect(draft.body.request.status).toBe('Draft'); requestIds.push(draft.body.request.id);
    const edited = await agents.partner.patch(`/api/requests/${draft.body.request.id}/edit`).send({ notes: 'edited jesttest', type: 'MOU' });
    expect(edited.status).toBe(200); expect(edited.body.request.type).toBe('MOU');
    const submitted = await agents.partner.post(`/api/requests/${draft.body.request.id}/submit`);
    expect(submitted.status).toBe(200); expect(submitted.body.request.status).toBe('Pending');

    const draft2 = await agents.partner.post('/api/requests').send(body('partner-draft2', { isDraft: true }));
    requestIds.push(draft2.body.request.id);
    expect((await agents.partner.delete(`/api/requests/${draft2.body.request.id}`)).status).toBe(200);

    const withdrawn = await agents.partner.post(`/api/requests/${created.body.request.id}/withdraw`);
    expect(withdrawn.status).toBe(403);
    expect((await agents.partner.get('/api/requests/mine')).body.map(r => r.id)).toEqual(expect.arrayContaining([created.body.request.id, draft.body.request.id]));
  });
});

describe('Administrator and CIRL Staff keep their request functionality', () => {
  let target;
  beforeAll(async () => { target = await insertRequest('partner', { status: 'Pending' }); });

  test('Administrator can still submit, list every request, and review', async () => {
    const created = await agents.admin.post('/api/requests').send(body('admin'));
    expect(created.status).toBe(200); requestIds.push(created.body.request.id);
    expect((await agents.admin.get('/api/requests')).body.map(r => r.id)).toEqual(expect.arrayContaining([target, created.body.request.id]));
    const review = await agents.admin.patch(`/api/requests/${target}`).send({ status: 'Under Review' });
    expect(review.status).toBe(200);
    expect((await db.collection('requests').findOne({ id: target })).status).toBe('Under Review');
  });

  test('CIRL Staff can still see every request and review one (submitting stays closed to it)', async () => {
    expect((await agents.staff.get('/api/requests')).body.map(r => r.id)).toContain(target);
    const review = await agents.staff.patch(`/api/requests/${target}`).send({ status: 'Pending' });
    expect(review.status).toBe(200);
    expect((await db.collection('requests').findOne({ id: target })).status).toBe('Pending');
    expect((await agents.staff.post(`/api/requests/${target}/withdraw`)).status).toBe(302);
  });

  test('a request that is no longer open cannot be moved back to Pending / Under Review (stale dialogs and direct calls are refused)', async () => {
    for (const closed of ['Rejected', 'Withdrawn', 'Approved']) {
      const id = await insertRequest('partner', { status: closed });
      for (const to of ['Under Review', 'Pending']) {
        const res = await agents.admin.patch(`/api/requests/${id}`).send({ status: to });
        expect({ closed, to, status: res.status }).toEqual({ closed, to, status: 400 });
        expect(res.body.error).toMatch(/already been decided/);
      }
      expect((await db.collection('requests').findOne({ id })).status).toBe(closed);
    }
    const draft = await insertRequest('partner', { status: 'Draft' });
    const res = await agents.staff.patch(`/api/requests/${draft}`).send({ status: 'Under Review' });
    expect(res.status).toBe(400); expect(res.body.error).toMatch(/draft/i);
    expect((await agents.admin.patch('/api/requests/99999999').send({ status: 'Under Review' })).status).toBe(404);
  });

  test('College Dean cannot review either (unchanged) — the reviewer route redirects it', async () => {
    expect((await agents.college.patch(`/api/requests/${target}`).send({ status: 'Approved' })).status).toBe(302);
    expect((await db.collection('requests').findOne({ id: target })).status).toBe('Pending');
  });

  // 2026-11 audit fix (Critical #1): the updateOne filter is now conditioned on the exact status just
  // read, so the loser of a race gets matchedCount 0 -> 409, instead of both racers silently succeeding
  // and double-applying side effects (notifications, Document Library marking, renewal extension).
  test('two simultaneous Approve calls on the same request: exactly one succeeds (200), the other gets 409, and the side effect (logActivity/notification) fires only once', async () => {
    const id = await insertRequest('partner', { status: 'Pending' });
    const [a, b] = await Promise.all([
      agents.admin.patch(`/api/requests/${id}`).send({ status: 'Approved' }),
      agents.staff.patch(`/api/requests/${id}`).send({ status: 'Approved' })
    ]);
    // Exactly one must win; the other is rejected either by the race guard itself (409, if both requests'
    // findOne genuinely interleaved) or by the pre-existing "already decided" pre-check (400, if the
    // loser's own findOne happened to run after the winner had already fully committed) — both are
    // correct outcomes of the same fix, and which one fires is a real timing detail, not a contract.
    const winner = a.status === 200 ? a : b;
    const loser = a.status === 200 ? b : a;
    expect(winner.status).toBe(200);
    expect([400, 409]).toContain(loser.status);
    expect(winner.body.request.status).toBe('Approved');
    expect(loser.body.error).toMatch(/already (been decided|updated)/);

    const stored = await db.collection('requests').findOne({ id });
    expect(stored.status).toBe('Approved');
    const logs = await db.collection('activitylogs').find({ action: 'APPROVE', record: { $regex: `ID #${id}|jesttest RBAC inserted ${id}` } }).toArray();
    expect(logs.length).toBe(1);
  });
});
