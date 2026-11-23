// LAU Internal Review Uploads (2026-11) — LAU may submit a revised document / notes / a status (Approve,
// Approve with Revision, Not Approve) on a Partnership Request it can already view. Everything LAU submits
// (`requests.lauReviews`) must be invisible to the request's own submitter everywhere — server-side, not
// just in the UI — while Administrator, Staff, AND every other LAU user see every entry (2026-11 decision:
// LAU visibility is org-wide, not self-only). See cirl.js's scopeLauReviewsForViewer (near
// REQUEST_VIEW_ALL_ROLES), requireLauOnly, and the isOwnerOfLinkedRequest('partnership-lau-review') branch
// for the implementation this exercises, plus the leak-audit fixes in documentLibraryService.js and
// searchService.js covered in their own describe block below.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { findPossibleDuplicates } = require('../services/documentLibraryService');

let db;
beforeAll(async () => { db = await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

// Unique institution per call — POST /api/requests refuses a second Pending/Under Review request for the
// same institution, and every describe block below needs its own independent fixture.
let reqCounter = 0;
async function createPendingRequest(requesterAgent) {
  reqCounter += 1;
  const res = await requesterAgent.post('/api/requests').send({
    institution: `jesttest LAU Review University ${Date.now()}.${reqCounter}`, country: 'Testland', type: 'MOA', nature: 'Academic'
  });
  expect(res.status).toBe(200);
  return res.body.request.id;
}

describe('LAU Internal Review Uploads', () => {
  let lauAgent, lau2Agent, adminAgent, staffAgent, requesterAgent, partnerAgent;
  let lauUser, lau2User, requesterUser;
  const createdRequestIds = [];

  beforeAll(async () => {
    lauUser = await createTestUser({ role: 'LAU' });
    lau2User = await createTestUser({ role: 'LAU' });
    // potential_partner, not Auth. Personnel: denyCollegeStaffPartnershipRequests blocks a College Dean
    // from submitting a plain Partnership Request at all (it must go through isCollegeReport instead) —
    // Partner is the simplest requester role unaffected by that guard, and (crucially for this suite) a
    // role with no special lauReviews visibility of its own, unlike Administrator/Staff/LAU.
    requesterUser = await createTestUser({ role: 'potential_partner' });
    const partnerUser = await createTestUser({ role: 'potential_partner' });

    lauAgent = request.agent(app); await loginAs(lauAgent, lauUser);
    lau2Agent = request.agent(app); await loginAs(lau2Agent, lau2User);
    adminAgent = request.agent(app); await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
    staffAgent = request.agent(app); await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
    requesterAgent = request.agent(app); await loginAs(requesterAgent, requesterUser);
    partnerAgent = request.agent(app); await loginAs(partnerAgent, partnerUser);
  });

  afterAll(async () => {
    await db.collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  });

  describe('Submission — validation and content', () => {
    let reqId;
    beforeAll(async () => { reqId = await createPendingRequest(requesterAgent); createdRequestIds.push(reqId); });

    test('rejects a submission with none of document/notes/status', async () => {
      const res = await lauAgent.post(`/api/requests/${reqId}/lau-review`).send({});
      expect(res.status).toBe(400);
    });

    test('rejects an invalid status value', async () => {
      const res = await lauAgent.post(`/api/requests/${reqId}/lau-review`).send({ status: 'Totally Fine I Guess' });
      expect(res.status).toBe(400);
    });

    test('notes alone is a valid submission, recorded with submitter identity and timestamp', async () => {
      const res = await lauAgent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'jesttest looks fine to me' });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.review.note).toBe('jesttest looks fine to me');
      expect(res.body.review.submittedByEmail).toBe(lauUser.email);
      expect(res.body.review.submittedBy).toBeTruthy();
      expect(res.body.review.submittedAt).toBeTruthy();
      expect(res.body.review.status).toBeNull();
    });

    test('a status alone (one of the three allowed values) is a valid submission', async () => {
      const res = await lauAgent.post(`/api/requests/${reqId}/lau-review`).send({ status: 'Approve with Revision' });
      expect(res.status).toBe(200);
      expect(res.body.review.status).toBe('Approve with Revision');
    });

    test('multiple submissions accumulate as separate versioned entries, never overwriting a prior one', async () => {
      const stored = await db.collection('requests').findOne({ id: reqId });
      expect(stored.lauReviews.length).toBeGreaterThanOrEqual(2);
      expect(stored.lauReviews[0].note).toBe('jesttest looks fine to me');
      expect(stored.lauReviews[1].status).toBe('Approve with Revision');
    });

    test('does NOT change the request\'s own requester-visible status', async () => {
      const stored = await db.collection('requests').findOne({ id: reqId });
      expect(stored.status).toBe('Pending');
    });
  });

  describe('RBAC on POST /api/requests/:id/lau-review', () => {
    let reqId;
    beforeAll(async () => { reqId = await createPendingRequest(requesterAgent); createdRequestIds.push(reqId); });

    // requireLauOnly denies via the shared denyAccess() helper, same as every other RBAC guard in this
    // file — a plain (non-"X-Requested-With: ciprms") call gets redirected, not a JSON 401/403; see
    // test/target-tracker.test.js's identical "matching existing requireAdmin convention" precedent.
    test('unauthenticated is denied', async () => {
      const res = await request(app).post(`/api/requests/${reqId}/lau-review`).send({ note: 'x' });
      expect(res.status).toBe(302);
    });

    test('the request\'s own submitter cannot use this route', async () => {
      const res = await requesterAgent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'x' });
      expect(res.status).toBe(302);
    });

    test('a Partner (unrelated requester role) cannot use this route', async () => {
      const res = await partnerAgent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'x' });
      expect(res.status).toBe(302);
    });

    // 2026-11, Partnership Request Communication Channels: the Internal section is now a two-way
    // conversation — Administrator/Staff can post into it too (requireLauOrReviewer), not just read what
    // LAU submits. Still never the request's own submitter (checked above) or an unrelated Partner.
    test('Administrator can use this route too — the Internal section is a two-way conversation', async () => {
      const res = await adminAgent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'jesttest admin reply' });
      expect(res.status).toBe(200);
      expect(res.body.review.authorRole).toBe('Administrator');
      expect(res.body.review.visibility).toBe('internal');
    });

    test('Staff can use this route too', async () => {
      const res = await staffAgent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'jesttest staff reply' });
      expect(res.status).toBe(200);
      expect(res.body.review.authorRole).toBe('Staff');
    });

    test('LAU can use this route', async () => {
      const res = await lauAgent.post(`/api/requests/${reqId}/lau-review`).send({ status: 'Approve' });
      expect(res.status).toBe(200);
    });
  });

  describe('Visibility — server-side scoping of lauReviews per viewer role', () => {
    let reqId;
    beforeAll(async () => {
      reqId = await createPendingRequest(requesterAgent);
      createdRequestIds.push(reqId);
      await lauAgent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'jesttest from LAU #1', status: 'Approve' });
      await lau2Agent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'jesttest from LAU #2', status: 'Not Approve' });
    });

    function findReq(list, id) { return list.find(r => r.id === id); }

    test('Administrator sees every lauReviews entry from every LAU submitter', async () => {
      const res = await adminAgent.get('/api/requests');
      expect(res.status).toBe(200);
      const r = findReq(res.body, reqId);
      expect(r.lauReviews.length).toBe(2);
      expect(r.lauReviews.map(x => x.submittedByEmail).sort()).toEqual([lauUser.email, lau2User.email].sort());
    });

    test('Staff sees every lauReviews entry too', async () => {
      const res = await staffAgent.get('/api/requests');
      const r = findReq(res.body, reqId);
      expect(r.lauReviews.length).toBe(2);
    });

    // 2026-11 decision (leak audit follow-up): LAU users DO see every LAU review, not just their own —
    // reversed from this suite's original assumption. Matches REQUEST_VIEW_ALL_ROLES's existing org-wide
    // visibility convention for the request itself.
    test('an LAU viewer sees EVERY lauReviews entry, including a colleague\'s', async () => {
      const res = await lauAgent.get('/api/requests');
      const r = findReq(res.body, reqId);
      expect(r.lauReviews.length).toBe(2);
      expect(r.lauReviews.map(x => x.submittedByEmail).sort()).toEqual([lauUser.email, lau2User.email].sort());

      const res2 = await lau2Agent.get('/api/requests');
      const r2 = findReq(res2.body, reqId);
      expect(r2.lauReviews.length).toBe(2);
    });

    test('the request\'s own submitter never receives the lauReviews field at all, via GET /api/requests', async () => {
      const res = await requesterAgent.get('/api/requests');
      expect(res.status).toBe(200);
      const r = findReq(res.body, reqId);
      expect(r).toBeTruthy();
      expect(r.lauReviews).toBeUndefined();
      expect(JSON.stringify(r)).not.toContain('jesttest from LAU');
    });

    test('the request\'s own submitter never receives the lauReviews field via GET /api/requests/mine either', async () => {
      const res = await requesterAgent.get('/api/requests/mine');
      expect(res.status).toBe(200);
      const r = findReq(res.body, reqId);
      expect(r).toBeTruthy();
      expect(r.lauReviews).toBeUndefined();
    });

    test('an unrelated Partner requester gets no trace of it either (defense in depth, not just ownership)', async () => {
      const res = await partnerAgent.get('/api/requests');
      const r = findReq(res.body, reqId);
      // Partner cannot see this institution's request at all (not its own) — either absent, or if present
      // for some other reason, must still never carry lauReviews.
      if (r) expect(r.lauReviews).toBeUndefined();
    });
  });

  describe('File access — a revised document LAU uploads is blocked from the requester by direct URL', () => {
    let reqId, fileLink;
    beforeAll(async () => {
      reqId = await createPendingRequest(requesterAgent);
      createdRequestIds.push(reqId);
      const res = await lauAgent
        .post(`/api/requests/${reqId}/lau-review`)
        .field('note', 'jesttest revised copy attached')
        .attach('document', Buffer.from('%PDF-1.4 jesttest lau review'), { filename: 'lau-review.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(200);
      fileLink = res.body.review.fileLink;
    });

    test('a document was actually archived and tagged with the LAU-review request type', async () => {
      expect(fileLink).toBeTruthy();
      const doc = await db.collection('documents').findOne({ fileLink });
      expect(doc).toBeTruthy();
      expect(doc.requestType).toBe('partnership-lau-review');
      expect(doc.requestId).toBe(reqId);
    });

    test('the request\'s own submitter gets 403 fetching the file by direct URL', async () => {
      const res = await requesterAgent.get(fileLink);
      expect(res.status).toBe(403);
    });

    test('Administrator, Staff, and the uploading LAU user can all fetch it', async () => {
      expect((await adminAgent.get(fileLink)).status).toBe(200);
      expect((await staffAgent.get(fileLink)).status).toBe(200);
      expect((await lauAgent.get(fileLink)).status).toBe(200);
    });

    test('unauthenticated access to the same URL is denied', async () => {
      const res = await request(app).get(fileLink);
      // requireFileAccess's "no session" branch also denies via denyAccess() — redirected, not a JSON 401,
      // same convention as the RBAC block above (the IN-HANDLER 403 "Forbidden" above is a different,
      // deliberately raw-text code path that only runs once a session already exists).
      expect(res.status).toBe(302);
    });
  });

  describe('Existing Partnership Request behavior is unaffected', () => {
    let reqId;
    beforeAll(async () => { reqId = await createPendingRequest(requesterAgent); createdRequestIds.push(reqId); });

    test('the pre-existing supportingDocuments upload route still works for the reviewer', async () => {
      const res = await adminAgent.post(`/api/requests/${reqId}/documents`).send({ note: 'jesttest ordinary draft note' });
      expect(res.status).toBe(200);
      expect(res.body.request.supportingDocuments.length).toBeGreaterThanOrEqual(1);
    });

    test('LAU still cannot use the pre-existing supportingDocuments route (unchanged — LAU has no reviewer/owner standing there)', async () => {
      const res = await lauAgent.post(`/api/requests/${reqId}/documents`).send({ note: 'jesttest should fail' });
      expect(res.status).toBe(403);
    });

    test('a request with no LAU review yet still serializes normally (no lauReviews key, no error)', async () => {
      const res = await adminAgent.get('/api/requests');
      const r = res.body.find(x => x.id === reqId);
      expect(r).toBeTruthy();
      expect(r.lauReviews).toBeUndefined();
    });
  });

  describe('Leak audit fixes (2026-11 follow-up)', () => {
    let reqId, fileLink, docId;
    beforeAll(async () => {
      reqId = await createPendingRequest(requesterAgent);
      createdRequestIds.push(reqId);
      const res = await lauAgent
        .post(`/api/requests/${reqId}/lau-review`)
        .field('note', 'jesttest confidential review content')
        .attach('document', Buffer.from('%PDF-1.4 jesttest leak audit fixture'), { filename: 'leak-audit.pdf', contentType: 'application/pdf' });
      expect(res.status).toBe(200);
      fileLink = res.body.review.fileLink;
      const doc = await db.collection('documents').findOne({ fileLink });
      docId = doc.id;
    });

    test('POST /api/requests/:id/documents (the requester\'s OWN upload) no longer echoes lauReviews back to them', async () => {
      const res = await requesterAgent.post(`/api/requests/${reqId}/documents`).send({ note: 'jesttest my own revision' });
      expect(res.status).toBe(200);
      expect(res.body.request.lauReviews).toBeUndefined();
      expect(JSON.stringify(res.body)).not.toContain('jesttest confidential review content');
    });

    test('PATCH /api/requests/:id (Administrator/Staff decision) still returns full lauReviews to them (scoping is a no-op for this role, not a regression)', async () => {
      const res = await adminAgent.patch(`/api/requests/${reqId}`).send({ status: 'Under Review', notes: 'jesttest need more info' });
      expect(res.status).toBe(200);
      expect(res.body.request.lauReviews.length).toBeGreaterThanOrEqual(1);
    });

    test('GET /api/documents?scope=all (Select Existing Documents picker) never includes the LAU review file', async () => {
      const res = await adminAgent.get('/api/documents?scope=all');
      expect(res.status).toBe(200);
      expect(res.body.find(d => d.id === docId)).toBeUndefined();
    });

    test('GET /api/documents (Administrator/Staff own-library view) never includes the LAU review file either', async () => {
      const res = await adminAgent.get('/api/documents');
      expect(res.status).toBe(200);
      expect(res.body.find(d => d.id === docId)).toBeUndefined();
    });

    test('OCR duplicate detection never surfaces the LAU review file, even on an exact institution match', async () => {
      const target = await db.collection('requests').findOne({ id: reqId });
      const result = await findPossibleDuplicates(db, { institution: target.institution }, {});
      const match = (result.matches || []).find(m => m.id === docId);
      expect(match).toBeUndefined();
    });

    test('the global header search (Admin/Staff) never surfaces the LAU review file by its title', async () => {
      const res = await adminAgent.get('/api/search?q=' + encodeURIComponent('LAU Internal Review'));
      expect(res.status).toBe(200);
      const hit = (res.body.documents || []).find(d => d.id === docId);
      expect(hit).toBeUndefined();
    });

    test('Administrator/Staff get a content-free notification when LAU submits a review', async () => {
      // 2026-11, Communication Channels: retitled "Internal note added" (was "LAU internal review
      // submitted") since this same notification now also fires the other way (Administrator/Staff
      // posting), when the old LAU-specific wording would have been actively misleading.
      const notif = await db.collection('notifications').findOne({
        tag: 'LAU Internal Review',
        title: { $regex: 'Internal note added' }
      });
      expect(notif).toBeTruthy();
      expect(notif.desc).not.toContain('jesttest confidential review content');
      expect(notif.desc).not.toContain('Approve');
      expect(notif.desc).not.toContain('leak-audit.pdf');
    });

    test('the requester never receives an LAU-review notification at all', async () => {
      const notif = await db.collection('notifications').findOne({
        targetEmail: requesterUser.email,
        tag: 'LAU Internal Review'
      });
      expect(notif).toBeNull();
    });
  });

  // 2026-11, Partnership Request Communication Channels: the Internal section is now a two-way
  // conversation — Administrator/Staff posting notifies LAU (the "other side"), mirroring the existing
  // LAU-posts-notifies-reviewers behavior above. Every notification created through notifyUsers/
  // notifyReviewers also sends an email (services/notificationService.js) — checked here via the Jest-only
  // sentForTests capture (services/emailService.js), never a real send.
  describe('Two-way conversation: Administrator/Staff posting notifies LAU, with an email', () => {
    let reqId;
    const emailService = require('../services/emailService');
    beforeAll(async () => { reqId = await createPendingRequest(requesterAgent); createdRequestIds.push(reqId); });

    test('Administrator posting an internal entry notifies every active LAU user, in-app and by e-mail', async () => {
      emailService.sentForTests.length = 0;
      const res = await adminAgent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'jesttest notify-lau check' });
      expect(res.status).toBe(200);

      const notif = await db.collection('notifications').findOne({ targetEmail: lauUser.email, tag: 'LAU Internal Review' });
      expect(notif).toBeTruthy();
      expect(notif.desc).not.toContain('jesttest notify-lau check'); // content-free, same rule as the reverse direction

      const sentToLau = emailService.sentForTests.some((m) => m.to === lauUser.email);
      expect(sentToLau).toBe(true);
    });

    test('LAU posting still notifies reviewers by e-mail too (unchanged direction, re-confirmed with the mock transport)', async () => {
      emailService.sentForTests.length = 0;
      const res = await lauAgent.post(`/api/requests/${reqId}/lau-review`).send({ note: 'jesttest notify-reviewers check' });
      expect(res.status).toBe(200);
      expect(emailService.sentForTests.length).toBeGreaterThan(0);
    });
  });
});
