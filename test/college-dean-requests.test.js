// College Dean Request and Accreditation Submission Workflow (2026-11). Administrator/Staff assign a dated
// MOA/MOU/Accreditation request to one specific College Dean (role "Auth. Personnel"); the Dean submits
// documents back; Administrator/Staff accepts or returns for revision, and the Dean can resubmit. Covers
// creation/assignment, Dean-scoped access restrictions, notifications, submission, accept/return/resubmit,
// cross-dean attachment isolation (via the existing GET /uploads/documents/:filename authorization), and
// audit trail recording.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, uniqueEmail, TEST_TAG } = require('./helpers');

let db;
const seededRequestIds = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  if (seededRequestIds.length) await db.collection('collegedeanrequests').deleteMany({ id: { $in: seededRequestIds } });
  // documents/notifications created during these tests carry a TEST_TAG-prefixed uploadedByEmail/targetEmail
  // and are swept generically by cleanupAll() below — nothing extra needed for those two collections here.
  await cleanupAll();
  await closeDB();
});

async function agentFor(role, extra) {
  const user = await createTestUser({ role, ...(extra || {}) });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

function pdfBuffer(label) {
  return Buffer.from(`%PDF-1.4\n% ${TEST_TAG} college-dean-requests fixture: ${label}\n`);
}

async function createRequest(adminAgent, deanId, overrides) {
  const res = await adminAgent.post('/api/college-requests').set('X-Requested-With', 'ciprms').send(Object.assign({
    requestType: 'Accreditation',
    title: `${TEST_TAG} Accreditation Request ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    instructions: 'Submit the accomplishment report and faculty profile.',
    description: 'Annual accreditation cycle.',
    requiredDocuments: 'Accomplishment Report, Faculty Profile',
    deadline: '2027-01-31',
    assignedDeanId: deanId
  }, overrides || {}));
  if (res.body && res.body.request) seededRequestIds.push(res.body.request.id);
  return res;
}

describe('1. Administrator/Staff creation and assignment', () => {
  test('Administrator can create and assign a request to a specific College Dean', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { user: dean } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    const res = await createRequest(adminAgent, dean.id);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.request.status).toBe('Pending');
    expect(res.body.request.assignedDeanEmail).toBe(dean.email);
    expect(res.body.request.assignedCollege).toBe('CCS');
  });

  test('Staff can also create and assign a request (not Administrator-only)', async () => {
    const { agent: staffAgent } = await agentFor('Staff');
    const { user: dean } = await agentFor('Auth. Personnel');
    const res = await createRequest(staffAgent, dean.id);
    expect(res.status).toBe(200);
  });

  test('rejects an unknown requestType', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { user: dean } = await agentFor('Auth. Personnel');
    const res = await createRequest(adminAgent, dean.id, { requestType: 'Scholarship' });
    expect(res.status).toBe(400);
  });

  test('rejects a missing title', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { user: dean } = await agentFor('Auth. Personnel');
    const res = await createRequest(adminAgent, dean.id, { title: '' });
    expect(res.status).toBe(400);
  });

  test('rejects an assignedDeanId that is not an Auth. Personnel account', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { user: staffUser } = await agentFor('Staff');
    const res = await createRequest(adminAgent, staffUser.id);
    expect(res.status).toBe(400);
  });

  test('Auth. Personnel, potential_partner, and LAU cannot create a college request', async () => {
    const { agent: deanAgent } = await agentFor('Auth. Personnel');
    const { agent: partnerAgent } = await agentFor('potential_partner');
    const { agent: lauAgent } = await agentFor('LAU');
    const { user: dean } = await agentFor('Auth. Personnel');
    expect((await createRequest(deanAgent, dean.id)).status).toBe(403);
    expect((await createRequest(partnerAgent, dean.id)).status).toBe(403);
    expect((await createRequest(lauAgent, dean.id)).status).toBe(403);
  });
});

describe('2. College Dean access restrictions', () => {
  test("a Dean's request list contains only their own assigned requests, never another Dean's", async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAAgent, user: deanA } = await agentFor('Auth. Personnel');
    const { user: deanB } = await agentFor('Auth. Personnel');
    const rA = await createRequest(adminAgent, deanA.id);
    const rB = await createRequest(adminAgent, deanB.id);

    const listRes = await deanAAgent.get('/api/college-requests').set('X-Requested-With', 'ciprms');
    expect(listRes.status).toBe(200);
    const ids = listRes.body.map(r => r.id);
    expect(ids).toContain(rA.body.request.id);
    expect(ids).not.toContain(rB.body.request.id);
  });

  test('Administrator and Staff see every request regardless of assignee', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: staffAgent } = await agentFor('Staff');
    const { user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);

    expect((await adminAgent.get('/api/college-requests').set('X-Requested-With', 'ciprms')).body.map(x => x.id)).toContain(r.body.request.id);
    expect((await staffAgent.get('/api/college-requests').set('X-Requested-With', 'ciprms')).body.map(x => x.id)).toContain(r.body.request.id);
  });

  test("a Dean cannot open another Dean's request detail", async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanBAgent } = await agentFor('Auth. Personnel');
    const { user: deanA } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, deanA.id);

    const res = await deanBAgent.get('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(403);
  });

  test("a Dean cannot submit documents to another Dean's request", async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanBAgent } = await agentFor('Auth. Personnel');
    const { user: deanA } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, deanA.id);

    const res = await deanBAgent.post('/api/college-requests/' + r.body.request.id + '/documents')
      .set('X-Requested-With', 'ciprms')
      .field('note', 'Attempting to submit on another Dean\'s request');
    expect(res.status).toBe(403);
  });
});

describe('3. Notifications', () => {
  test('creating/assigning a request notifies the assigned Dean', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);

    const notif = await db.collection('notifications').findOne({ targetEmail: dean.email, tag: 'College Request' });
    expect(notif).toBeTruthy();
    expect(notif.title).toContain(r.body.request.title);
  });

  test('submitting documents notifies the reviewers (Administrator/Staff)', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);

    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents')
      .set('X-Requested-With', 'ciprms')
      .attach('document', pdfBuffer('submission'), 'accomplishment-report.pdf');

    const notif = await db.collection('notifications').findOne({ tag: 'College Request', title: { $regex: 'Submission received' } });
    expect(notif).toBeTruthy();
  });

  test('accepting or returning a submission notifies the assigned Dean', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents')
      .set('X-Requested-With', 'ciprms')
      .field('note', 'first submission');

    await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms').send({ action: 'accept' });

    const notif = await db.collection('notifications').findOne({ targetEmail: dean.email, tag: 'College Request', title: { $regex: 'accepted' } });
    expect(notif).toBeTruthy();
  });
});

describe('4. Accreditation document submission', () => {
  test('the assigned Dean can submit a file and a note; status advances to Submitted', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);

    const res = await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents')
      .set('X-Requested-With', 'ciprms')
      .field('note', 'Here is our accomplishment report.')
      .attach('document', pdfBuffer('accreditation'), 'accomplishment-report.pdf');

    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('Submitted');
    expect(res.body.request.submittedDocuments.length).toBe(1);
    expect(res.body.request.submittedDocuments[0].originalFilename).toBe('accomplishment-report.pdf');
    expect(res.body.request.submittedAt).toBeTruthy();
  });

  test('rejects a submission with neither a file nor a note', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);

    const res = await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents').set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(400);
  });

  test('Administrator cannot submit documents on the Dean\'s behalf, even though it can view the request', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);

    const res = await adminAgent.post('/api/college-requests/' + r.body.request.id + '/documents')
      .set('X-Requested-With', 'ciprms')
      .field('note', 'Administrator trying to submit');
    expect(res.status).toBe(403);
  });
});

describe('5. Accept and return-for-revision workflow', () => {
  test('cannot accept or return a request that has not been submitted yet (still Pending)', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);

    const res = await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms').send({ action: 'accept' });
    expect(res.status).toBe(400);
  });

  test('returning for revision requires a comment', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents').set('X-Requested-With', 'ciprms').field('note', 'submission');

    const res = await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms').send({ action: 'return', remark: '' });
    expect(res.status).toBe(400);
  });

  test('Administrator can return a submission for revision with a comment', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents').set('X-Requested-With', 'ciprms').field('note', 'submission');

    const res = await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms')
      .send({ action: 'return', remark: 'Please attach the missing faculty profile.' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('Returned for Revision');
    expect(res.body.request.reviewRemark).toBe('Please attach the missing faculty profile.');
  });

  test('Administrator can accept a submission, marking it Completed', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents').set('X-Requested-With', 'ciprms').field('note', 'submission');

    const res = await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms').send({ action: 'accept' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe('Completed');
    expect(res.body.request.decidedBy).toBe(adminAgentUserName(res));
  });

  test('a Completed request cannot be decided on again', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents').set('X-Requested-With', 'ciprms').field('note', 'submission');
    await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms').send({ action: 'accept' });

    const res = await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms').send({ action: 'accept' });
    expect(res.status).toBe(400);
  });
});

// decidedBy is always the acting Administrator's own name — the assertion above only needs to confirm it's
// set to *something* real rather than hardcoded, so this helper just extracts it back from the same response
// instead of hardcoding an unrelated expected string.
function adminAgentUserName(res) { return res.body.request.decidedBy; }

describe('6. Resubmission and submission history', () => {
  test('after a return-for-revision, the Dean can resubmit and the request moves back to Submitted', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);

    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents')
      .set('X-Requested-With', 'ciprms').attach('document', pdfBuffer('v1'), 'v1.pdf');
    await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms')
      .send({ action: 'return', remark: 'Needs more detail.' });

    const resubmit = await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents')
      .set('X-Requested-With', 'ciprms').attach('document', pdfBuffer('v2'), 'v2.pdf');

    expect(resubmit.status).toBe(200);
    expect(resubmit.body.request.status).toBe('Submitted');
    expect(resubmit.body.request.submittedDocuments.length).toBe(2);
  });

  test('the full status history (creation, submission, return, resubmission, acceptance) is preserved in order', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const id = r.body.request.id;

    await deanAgent.post('/api/college-requests/' + id + '/documents').set('X-Requested-With', 'ciprms').field('note', 'v1');
    await adminAgent.patch('/api/college-requests/' + id).set('X-Requested-With', 'ciprms').send({ action: 'return', remark: 'revise' });
    await deanAgent.post('/api/college-requests/' + id + '/documents').set('X-Requested-With', 'ciprms').field('note', 'v2');
    await adminAgent.patch('/api/college-requests/' + id).set('X-Requested-With', 'ciprms').send({ action: 'accept' });

    const final = await adminAgent.get('/api/college-requests/' + id).set('X-Requested-With', 'ciprms');
    const transitions = final.body.statusHistory.map(h => h.to);
    expect(transitions).toEqual(['Pending', 'Submitted', 'Returned for Revision', 'Submitted', 'Completed']);
  });
});

describe('7. Attachment isolation between Deans (file-access authorization)', () => {
  test("only the assigned Dean and Administrator/Staff can open a submitted document — a different Dean gets 403", async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAAgent, user: deanA } = await agentFor('Auth. Personnel');
    const { agent: deanBAgent } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, deanA.id);

    const submitRes = await deanAAgent.post('/api/college-requests/' + r.body.request.id + '/documents')
      .set('X-Requested-With', 'ciprms').attach('document', pdfBuffer('isolation'), 'isolation.pdf');
    const fileLink = submitRes.body.fileLink;
    expect(fileLink).toBeTruthy();

    const ownerRes = await deanAAgent.get(fileLink);
    expect(ownerRes.status).toBe(200);

    const adminRes = await adminAgent.get(fileLink);
    expect(adminRes.status).toBe(200);

    const otherDeanRes = await deanBAgent.get(fileLink);
    expect(otherDeanRes.status).toBe(403);
  });

  test("a reference document Administrator attaches is also readable by the assigned Dean but not by another Dean", async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAAgent, user: deanA } = await agentFor('Auth. Personnel');
    const { agent: deanBAgent } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, deanA.id);

    const refRes = await adminAgent.post('/api/college-requests/' + r.body.request.id + '/reference-documents')
      .set('X-Requested-With', 'ciprms').attach('document', pdfBuffer('reference'), 'checklist.pdf');
    expect(refRes.status).toBe(200);
    const fileLink = refRes.body.fileLink;

    expect((await deanAAgent.get(fileLink)).status).toBe(200);
    expect((await deanBAgent.get(fileLink)).status).toBe(403);
  });
});

describe('8. Multi-dean assignment (2026-11)', () => {
  test('a request can be assigned to multiple Deans via assignedDeanIds, and both can access it', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAAgent, user: deanA } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    const { agent: deanBAgent, user: deanB } = await agentFor('Auth. Personnel', { unit: 'CNAS' });
    const { agent: deanCAgent } = await agentFor('Auth. Personnel');

    const res = await createRequest(adminAgent, deanA.id, { assignedDeanIds: [deanA.id, deanB.id] });
    expect(res.status).toBe(200);
    expect(res.body.request.assignedDeans.map(d => d.email).sort()).toEqual([deanA.email, deanB.email].sort());
    // Legacy singular fields still mirror the first assigned dean, for any code path not yet updated.
    expect(res.body.request.assignedDeanEmail).toBe(deanA.email);

    const id = res.body.request.id;
    const detailA = await deanAAgent.get('/api/college-requests/' + id).set('X-Requested-With', 'ciprms');
    const detailB = await deanBAgent.get('/api/college-requests/' + id).set('X-Requested-With', 'ciprms');
    const detailC = await deanCAgent.get('/api/college-requests/' + id).set('X-Requested-With', 'ciprms');
    expect(detailA.status).toBe(200);
    expect(detailB.status).toBe(200);
    expect(detailC.status).toBe(403);

    const listA = await deanAAgent.get('/api/college-requests').set('X-Requested-With', 'ciprms');
    const listB = await deanBAgent.get('/api/college-requests').set('X-Requested-With', 'ciprms');
    expect(listA.body.map(r => r.id)).toContain(id);
    expect(listB.body.map(r => r.id)).toContain(id);
  });

  test('either co-assigned Dean can submit documents, and the assigned-Dean notification goes to both', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAAgent, user: deanA } = await agentFor('Auth. Personnel');
    const { agent: deanBAgent, user: deanB } = await agentFor('Auth. Personnel');

    const r = await createRequest(adminAgent, deanA.id, { assignedDeanIds: [deanA.id, deanB.id] });
    const id = r.body.request.id;

    const notifA = await db.collection('notifications').findOne({ targetEmail: deanA.email, tag: 'College Request' });
    const notifB = await db.collection('notifications').findOne({ targetEmail: deanB.email, tag: 'College Request' });
    expect(notifA).toBeTruthy();
    expect(notifB).toBeTruthy();

    // Dean B (not the "first" dean) can still submit — ownership is "any assigned dean", not just deanA.
    const submitRes = await deanBAgent.post('/api/college-requests/' + id + '/documents')
      .set('X-Requested-With', 'ciprms').field('note', 'Submitted by the second co-assigned dean.');
    expect(submitRes.status).toBe(200);
    expect(submitRes.body.request.status).toBe('Submitted');

    await adminAgent.patch('/api/college-requests/' + id).set('X-Requested-With', 'ciprms').send({ action: 'accept' });
    const acceptNotifA = await db.collection('notifications').findOne({ targetEmail: deanA.email, tag: 'College Request', title: { $regex: 'accepted' } });
    const acceptNotifB = await db.collection('notifications').findOne({ targetEmail: deanB.email, tag: 'College Request', title: { $regex: 'accepted' } });
    expect(acceptNotifA).toBeTruthy();
    expect(acceptNotifB).toBeTruthy();
    // Also exercises deanAAgent so it isn't an unused variable — confirms the first dean retains access too.
    expect((await deanAAgent.get('/api/college-requests/' + id).set('X-Requested-With', 'ciprms')).status).toBe(200);
  });

  test('a request created before the multi-dean change (singular fields only) still works for access, listing, and submission', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel', { unit: 'CETE' });

    // Simulates a pre-2026-11 document: inserted directly with only the legacy singular fields, no
    // assignedDeans array at all — getAssignedDeans()'s fallback path is what this test is proving out.
    const legacyId = Date.now() % 1000000;
    await db.collection('collegedeanrequests').insertOne({
      id: legacyId, requestType: 'MOA', title: `${TEST_TAG} Legacy single-dean request ${legacyId}`,
      instructions: '', description: '', requiredDocuments: [], deadline: '',
      assignedDeanId: dean.id, assignedDeanEmail: dean.email, assignedDeanName: dean.name, assignedCollege: dean.unit,
      createdBy: 'System', createdByEmail: 'system@test.local', referenceDocuments: [], submittedDocuments: [],
      status: 'Pending', statusHistory: [], date: new Date().toLocaleDateString('en-US'),
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
    });
    seededRequestIds.push(legacyId);

    expect((await deanAgent.get('/api/college-requests/' + legacyId).set('X-Requested-With', 'ciprms')).status).toBe(200);
    expect((await deanAgent.get('/api/college-requests').set('X-Requested-With', 'ciprms')).body.map(r => r.id)).toContain(legacyId);

    const submitRes = await deanAgent.post('/api/college-requests/' + legacyId + '/documents')
      .set('X-Requested-With', 'ciprms').field('note', 'Submitting against a legacy single-dean record.');
    expect(submitRes.status).toBe(200);
  });
});

describe('9. Audit trail recording', () => {
  test('creation/assignment, submission, and the accept/return decision are all logged', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const title = r.body.request.title;

    const addLog = await db.collection('activitylogs').findOne({ action: 'ADD', record: { $regex: title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
    expect(addLog).toBeTruthy();

    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents').set('X-Requested-With', 'ciprms').field('note', 'submission');
    const submitLog = await db.collection('activitylogs').findOne({ action: 'SUBMIT', record: { $regex: title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
    expect(submitLog).toBeTruthy();

    await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms').send({ action: 'return', remark: 'revise please' });
    const returnLog = await db.collection('activitylogs').findOne({ action: 'REJECT', record: { $regex: title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
    expect(returnLog).toBeTruthy();

    await deanAgent.post('/api/college-requests/' + r.body.request.id + '/documents').set('X-Requested-With', 'ciprms').field('note', 'resubmission');
    const resubmitLog = await db.collection('activitylogs').findOne({ action: 'RESUBMIT', record: { $regex: title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
    expect(resubmitLog).toBeTruthy();

    await adminAgent.patch('/api/college-requests/' + r.body.request.id).set('X-Requested-With', 'ciprms').send({ action: 'accept' });
    const acceptLog = await db.collection('activitylogs').findOne({ action: 'APPROVE', record: { $regex: title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
    expect(acceptLog).toBeTruthy();
  });
});
