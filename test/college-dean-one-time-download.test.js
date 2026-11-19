// College Dean one-time download (2026-11, revised for reliability). A reference document
// Administrator/Staff attaches to a College Dean request (an MOA/MOU/Accreditation request assigned to a
// specific Dean — see test/college-dean-requests.test.js for the rest of that workflow) may be opened by
// each assigned Dean only once, counted only on a complete transfer. A short-lived, single-use download
// token (services/downloadTokenService.js) gates the actual file URL; Administrator/Staff stay unlimited
// and can reset the limit.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
const seededRequestIds = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  if (seededRequestIds.length) await db.collection('collegedeanrequests').deleteMany({ id: { $in: seededRequestIds } });
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
  return Buffer.from(`%PDF-1.4\n% ${TEST_TAG} one-time-download fixture: ${label}\n`);
}

async function createRequest(adminAgent, deanId) {
  const res = await adminAgent.post('/api/college-requests').set('X-Requested-With', 'ciprms').send({
    requestType: 'Accreditation',
    title: `${TEST_TAG} One-Time Download Request ${Date.now()}-${Math.floor(Math.random() * 1e6)}`,
    instructions: 'n/a', description: 'n/a', requiredDocuments: 'n/a',
    deadline: '2027-01-31', assignedDeanId: deanId
  });
  seededRequestIds.push(res.body.request.id);
  return res.body.request;
}

async function attachReference(adminAgent, requestId, label, buffer) {
  const res = await adminAgent.post('/api/college-requests/' + requestId + '/reference-documents')
    .set('X-Requested-With', 'ciprms').attach('document', buffer || pdfBuffer(label), label + '.pdf');
  return res.body; // { success, documentId, fileLink, request }
}

// Recording a download is deliberately fire-and-forget (cirl.js never delays the response for it — see
// recordDeanDownload's own comment) — the same "background write" convention test/email-notifications.test.js's
// settle() already exists for. A DB read immediately after a successful download can otherwise race that write.
const settle = () => new Promise((r) => setTimeout(r, 150));

async function getToken(deanAgent, requestId, documentId) {
  const res = await deanAgent
    .post('/api/college-requests/' + requestId + '/reference-documents/' + documentId + '/download-token')
    .set('X-Requested-With', 'ciprms');
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body.token;
}

describe('College Dean one-time download — token-gated file URL', () => {
  test("the Dean's first complete download succeeds, the second attempt is blocked with a clear message", async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const { fileLink, documentId } = await attachReference(adminAgent, r.id, 'first-second');

    const token = await getToken(deanAgent, r.id, documentId);
    const first = await deanAgent.get(fileLink + '?token=' + token);
    expect(first.status).toBe(200);

    const second = await deanAgent.get(fileLink);
    expect(second.status).toBe(403);
    expect(second.text).toMatch(/already been downloaded/i);

    // Issuing a brand-new token after a completed download is also refused — the "already downloaded"
    // check happens at token-issuance time too, not only at the file URL.
    const retoken = await deanAgent
      .post('/api/college-requests/' + r.id + '/reference-documents/' + documentId + '/download-token')
      .set('X-Requested-With', 'ciprms');
    expect(retoken.status).toBe(403);

    const doc = await db.collection('documents').findOne({ id: documentId });
    expect(doc.requestId).toBe(r.id);
    const cdr = await db.collection('collegedeanrequests').findOne({ id: r.id });
    const refDoc = cdr.referenceDocuments.find((d) => d.documentId === documentId);
    expect(refDoc.downloads.length).toBe(1);
    expect(refDoc.downloads[0].email).toBe(dean.email);
  });

  test('a bare file URL with no token is refused even for the correctly assigned Dean', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const { fileLink } = await attachReference(adminAgent, r.id, 'bare-url');

    const bare = await deanAgent.get(fileLink);
    expect(bare.status).toBe(403);
    expect(bare.text).toMatch(/invalid or has expired/i);

    const stale = await deanAgent.get(fileLink + '?token=not-a-real-token');
    expect(stale.status).toBe(403);
  });

  test('a Range request is rejected (416) and never consumes the token or the one try', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const { fileLink, documentId } = await attachReference(adminAgent, r.id, 'range');

    const token = await getToken(deanAgent, r.id, documentId);
    const ranged = await deanAgent.get(fileLink + '?token=' + token).set('Range', 'bytes=0-10');
    expect(ranged.status).toBe(416);

    // The same token still works for a normal, full request — the Range attempt never touched it.
    const full = await deanAgent.get(fileLink + '?token=' + token);
    expect(full.status).toBe(200);
    await settle();

    const cdr = await db.collection('collegedeanrequests').findOne({ id: r.id });
    const refDoc = cdr.referenceDocuments.find((d) => d.documentId === documentId);
    expect(refDoc.downloads.length).toBe(1); // only the one full request counted
  });

  test('Administrator and Staff remain unlimited and unaffected by the token/Range rules', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: staffAgent } = await agentFor('Staff');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const { fileLink } = await attachReference(adminAgent, r.id, 'unlimited');

    expect((await adminAgent.get(fileLink)).status).toBe(200);
    expect((await adminAgent.get(fileLink)).status).toBe(200);
    expect((await staffAgent.get(fileLink)).status).toBe(200);
    // Range is still perfectly normal for a role the one-time-download rule doesn't apply to.
    const staffRanged = await staffAgent.get(fileLink).set('Range', 'bytes=0-5');
    expect([200, 206]).toContain(staffRanged.status);

    // The Dean's own limit is untouched by Admin/Staff opening the same file.
    const token = await getToken(deanAgent, r.id, (await db.collection('documents').findOne({ fileLink })).id);
    expect((await deanAgent.get(fileLink + '?token=' + token)).status).toBe(200);
    expect((await deanAgent.get(fileLink)).status).toBe(403);
  });

  test('a failed transfer (storage error) never counts against the try — the Dean can retry with a fresh token', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const { fileLink, documentId } = await attachReference(adminAgent, r.id, 'storage-fail');

    // Simulate the underlying file being gone (e.g. a disk hiccup) WITHOUT touching the documents
    // collection — sendFile will 404, which must not record a download.
    const fs = require('fs');
    const path = require('path');
    const localPath = path.join(__dirname, '..', 'uploads', 'documents', path.basename(fileLink));
    const saved = fs.readFileSync(localPath);
    fs.unlinkSync(localPath);

    const token = await getToken(deanAgent, r.id, documentId);
    const failed = await deanAgent.get(fileLink + '?token=' + token);
    expect(failed.status).toBe(404);

    const cdrAfterFail = await db.collection('collegedeanrequests').findOne({ id: r.id });
    expect((cdrAfterFail.referenceDocuments.find((d) => d.documentId === documentId).downloads || []).length).toBe(0);

    // Restore the file and retry — the failed attempt did not burn the Dean's one try.
    fs.writeFileSync(localPath, saved);
    const retryToken = await getToken(deanAgent, r.id, documentId);
    const retried = await deanAgent.get(fileLink + '?token=' + retryToken);
    expect(retried.status).toBe(200);
    await settle();

    const cdrAfterRetry = await db.collection('collegedeanrequests').findOne({ id: r.id });
    expect(cdrAfterRetry.referenceDocuments.find((d) => d.documentId === documentId).downloads.length).toBe(1);
  });

  // A true client-mid-transfer abort (socket destroyed after the first TCP chunk but before the last)
  // isn't something Jest + supertest can simulate deterministically without risking a hanging test run —
  // tried with a raw Node http client against a dedicated server instance, and it left a socket the test
  // server's close() never finished draining. The code-level guarantee this would exercise is already
  // airtight by inspection: downloads are only ever recorded from the response's 'finish' event (cirl.js,
  // GET /uploads/documents/:filename), which Node emits ONLY once the entire response has been flushed —
  // an aborted connection goes straight to 'close' and 'finish' never fires at all. The "storage failure"
  // test above exercises the exact same deanDownloadFailed guard for the other way a transfer can end
  // without completing. The real-browser Playwright test (test/e2e/college-dean-one-time-download.spec.js)
  // covers one genuine complete download end-to-end instead.

  test('Administrator/Staff can reset the download so the Dean can try again, and the reset is logged', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const { fileLink, documentId } = await attachReference(adminAgent, r.id, 'reset');

    const token = await getToken(deanAgent, r.id, documentId);
    expect((await deanAgent.get(fileLink + '?token=' + token)).status).toBe(200);
    expect((await deanAgent.get(fileLink)).status).toBe(403);

    const resetRes = await adminAgent
      .patch('/api/college-requests/' + r.id + '/reference-documents/' + documentId + '/reset-download')
      .set('X-Requested-With', 'ciprms');
    expect(resetRes.status).toBe(200);
    expect(resetRes.body.success).toBe(true);

    const retoken = await getToken(deanAgent, r.id, documentId);
    expect((await deanAgent.get(fileLink + '?token=' + retoken)).status).toBe(200);

    const logged = await db.collection('activitylogs').findOne({ record: { $regex: 'Reset Dean download limit' } });
    expect(logged).not.toBeNull();

    // A non-reviewer can't reset it themselves.
    const resetByDean = await deanAgent
      .patch('/api/college-requests/' + r.id + '/reference-documents/' + documentId + '/reset-download')
      .set('X-Requested-With', 'ciprms');
    expect(resetByDean.status).toBe(403);
  });

  test('there is no inline preview for the Dean — the response always forces attachment, never inline', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: deanAgent, user: dean } = await agentFor('Auth. Personnel');
    const r = await createRequest(adminAgent, dean.id);
    const { fileLink, documentId } = await attachReference(adminAgent, r.id, 'no-preview');

    const token = await getToken(deanAgent, r.id, documentId);
    const res = await deanAgent.get(fileLink + '?token=' + token);
    expect(res.status).toBe(200);
    expect(res.headers['content-disposition']).toMatch(/^attachment/);
  });
});
