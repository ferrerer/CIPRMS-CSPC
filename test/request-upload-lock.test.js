// Lock Partnership Request Uploads After Approval (2026-11) — once a request's stored status is Approved
// or Rejected, every route that adds content to it (POST .../documents, POST .../lau-review, POST
// .../google-docs) must refuse, for every role, checked against the DATABASE record (never anything the
// client sends). See cirl.js's isRequestUploadLocked/LOCKED_REQUEST_STATUSES (declared near
// UNDECIDED_REQUEST_STATUSES). Viewing/downloading existing documents and LAU reviews stays open either
// way — only the ability to ADD something new is locked.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
const requestIds = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  await db.collection('requests').deleteMany({ id: { $in: requestIds } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(user) {
  const agent = request.agent(app);
  await loginAs(agent, user);
  return agent;
}

async function insertRequest(fields) {
  const last = await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = (last.length ? last[0].id : 0) + 1;
  await db.collection('requests').insertOne({
    id, institution: `${TEST_TAG} Lock University`, country: 'Testland', type: 'MOA', nature: 'Research',
    unit: 'CCS', status: 'Pending', date: 'Nov 17, 2026', ...fields
  });
  requestIds.push(id);
  return id;
}

describe('Lock Partnership Request Uploads After Approval', () => {
  let admin, staff, lau, requester;

  beforeAll(async () => {
    admin = await createTestUser({ role: 'Administrator' });
    staff = await createTestUser({ role: 'Staff' });
    lau = await createTestUser({ role: 'LAU' });
    requester = await createTestUser({ role: 'potential_partner' });
  });

  describe('POST /api/requests/:id/documents — locked once Approved or Rejected', () => {
    test('the request owner (Partner) is rejected on an Approved request', async () => {
      const id = await insertRequest({ status: 'Approved', submittedByEmail: requester.email });
      const agent = await agentFor(requester);
      const res = await agent.post(`/api/requests/${id}/documents`).send({ note: 'jesttest should be blocked' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already been approved/i);
    });

    test('the request owner is rejected on a Rejected request too', async () => {
      const id = await insertRequest({ status: 'Rejected', submittedByEmail: requester.email });
      const agent = await agentFor(requester);
      const res = await agent.post(`/api/requests/${id}/documents`).send({ note: 'jesttest should be blocked' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/already been rejected/i);
    });

    test('Administrator is rejected on an Approved request', async () => {
      const id = await insertRequest({ status: 'Approved', submittedByEmail: requester.email });
      const agent = await agentFor(admin);
      const res = await agent.post(`/api/requests/${id}/documents`).send({ note: 'jesttest should be blocked' });
      expect(res.status).toBe(400);
    });

    test('Staff is rejected on an Approved request', async () => {
      const id = await insertRequest({ status: 'Approved', submittedByEmail: requester.email });
      const agent = await agentFor(staff);
      const res = await agent.post(`/api/requests/${id}/documents`).send({ note: 'jesttest should be blocked' });
      expect(res.status).toBe(400);
    });

    test('a non-approved (Pending) request still accepts an upload exactly as before — no regression', async () => {
      const id = await insertRequest({ status: 'Pending', submittedByEmail: requester.email });
      const agent = await agentFor(requester);
      const res = await agent.post(`/api/requests/${id}/documents`).send({ note: 'jesttest still allowed' });
      expect(res.status).toBe(200);
      expect(res.body.request.supportingDocuments.length).toBeGreaterThanOrEqual(1);
    });

    test('a client-sent status is ignored — the lock is read from the database record, not the request body', async () => {
      const id = await insertRequest({ status: 'Approved', submittedByEmail: requester.email });
      const agent = await agentFor(requester);
      const res = await agent.post(`/api/requests/${id}/documents`).send({ note: 'jesttest spoof attempt', status: 'Pending' });
      expect(res.status).toBe(400);
    });
  });

  describe('POST /api/requests/:id/lau-review — now locked (was previously status-independent by design)', () => {
    test('LAU is rejected on an Approved request', async () => {
      const id = await insertRequest({ status: 'Approved', submittedByEmail: requester.email });
      const agent = await agentFor(lau);
      const res = await agent.post(`/api/requests/${id}/lau-review`).send({ status: 'Approve' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/approved/i);
    });

    test('LAU is rejected on a Rejected request', async () => {
      const id = await insertRequest({ status: 'Rejected', submittedByEmail: requester.email });
      const agent = await agentFor(lau);
      const res = await agent.post(`/api/requests/${id}/lau-review`).send({ status: 'Approve' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/rejected/i);
    });

    test('LAU can still submit a review on a Pending request — no regression', async () => {
      const id = await insertRequest({ status: 'Pending', submittedByEmail: requester.email });
      const agent = await agentFor(lau);
      const res = await agent.post(`/api/requests/${id}/lau-review`).send({ note: 'jesttest still allowed' });
      expect(res.status).toBe(200);
    });

    test('an existing LAU review on a request that is LATER approved remains visible to Administrator/Staff/LAU (view/download stays open)', async () => {
      const id = await insertRequest({ status: 'Pending', submittedByEmail: requester.email });
      const lauAgent = await agentFor(lau);
      const submitRes = await lauAgent.post(`/api/requests/${id}/lau-review`).send({ note: 'jesttest pre-approval review', status: 'Approve' });
      expect(submitRes.status).toBe(200);

      await db.collection('requests').updateOne({ id }, { $set: { status: 'Approved' } });

      const adminAgent = await agentFor(admin);
      const afterApproval = await adminAgent.get('/api/requests');
      const r = afterApproval.body.find(x => x.id === id);
      expect(r.status).toBe('Approved');
      expect(r.lauReviews.length).toBe(1);
      expect(r.lauReviews[0].note).toBe('jesttest pre-approval review');

      // The requester still never sees it, approved or not.
      const reqAgent = await agentFor(requester);
      const asRequester = await reqAgent.get('/api/requests');
      const rForRequester = asRequester.body.find(x => x.id === id);
      expect(rForRequester.lauReviews).toBeUndefined();

      // And LAU can no longer add a NEW one now that it's approved.
      const blocked = await lauAgent.post(`/api/requests/${id}/lau-review`).send({ status: 'Not Approve' });
      expect(blocked.status).toBe(409);
    });
  });

  describe('POST /api/requests/:id/google-docs — now locked (previously only blocked Draft)', () => {
    test('Administrator is rejected (409) on an Approved request, before any Google call is attempted', async () => {
      const id = await insertRequest({ status: 'Approved', submittedByEmail: requester.email });
      const agent = await agentFor(admin);
      const res = await agent.post(`/api/requests/${id}/google-docs`).send({ kind: 'MOA' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/approved/i);
    });

    test('Staff is rejected (409) on a Rejected request', async () => {
      const id = await insertRequest({ status: 'Rejected', submittedByEmail: requester.email });
      const agent = await agentFor(staff);
      const res = await agent.post(`/api/requests/${id}/google-docs`).send({ kind: 'MOU' });
      expect(res.status).toBe(409);
      expect(res.body.error).toMatch(/rejected/i);
    });

    test('a Pending request still reaches the real Google Docs check (422 "not connected") — proves the lock did not fire, no regression', async () => {
      const id = await insertRequest({ status: 'Pending', submittedByEmail: requester.email });
      const agent = await agentFor(admin);
      const res = await agent.post(`/api/requests/${id}/google-docs`).send({ kind: 'MOA' });
      expect(res.status).toBe(422);
      expect(res.body.error).toMatch(/not connected/i);
    });

    test('Draft is still rejected with its own distinct message, unaffected by the new lock', async () => {
      const id = await insertRequest({ status: 'Draft', submittedByEmail: requester.email });
      const agent = await agentFor(admin);
      const res = await agent.post(`/api/requests/${id}/google-docs`).send({ kind: 'MOA' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/not been submitted/i);
    });
  });

  describe('Direct API calls bypassing the UI are rejected the same way', () => {
    test('a bare supertest call with no UI involved is still blocked on all 3 routes for an Approved request', async () => {
      const id = await insertRequest({ status: 'Approved', submittedByEmail: requester.email });
      expect((await (await agentFor(requester)).post(`/api/requests/${id}/documents`).send({ note: 'x' })).status).toBe(400);
      expect((await (await agentFor(lau)).post(`/api/requests/${id}/lau-review`).send({ status: 'Approve' })).status).toBe(409);
      expect((await (await agentFor(admin)).post(`/api/requests/${id}/google-docs`).send({ kind: 'MOA' })).status).toBe(409);
    });
  });
});
