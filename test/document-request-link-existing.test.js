// "Link Existing Documents When Fulfilling Document Requests" (2026-11). Administrator/Staff can attach a
// document already in THEIR OWN Document Library (GET /api/documents' existing own-upload scope) to a
// Document Request's draft timeline via POST /api/document-requests/:id/documents { documentIds: [...] }
// instead of re-uploading the same file. Covers: no duplicate `documents` record or physical file is ever
// created; the original document's own metadata/ownership/storage is untouched; the requester can download
// a linked document even though its OWN requestId/requestType tag points at a different, unrelated request
// (the isOwnerOfLinkedRequest fix); and the link is scoped server-side to the acting reviewer's own library,
// not an arbitrary document id.
// beforeAll logs in 4 test accounts and seeds 3 Document Library fixtures sequentially — comfortably past
// the global 15s default (jest.config.js) on a loaded machine, same reasoning as test/ocr-pipeline-live.test.js.
jest.setTimeout(30000);

const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { DOCUMENTS_DIR } = require('../services/documentLibraryService');

let db;
let adminAgent, staffAgent, requesterAgent, otherPartnerAgent;
let staffUser, adminUser, requesterUser;
let staffDocId, adminDocId, staffDoc2Id;
const seededFiles = [];
const seededDocIds = [];
let requestId;

function seedDoc(ownerEmail, titleSuffix, extraRequestTags) {
  const fname = `zztest-linkexisting-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pdf`;
  const fpath = path.join(DOCUMENTS_DIR, fname);
  fs.writeFileSync(fpath, 'ZZ Test link-existing fixture content: ' + titleSuffix);
  seededFiles.push(fpath);
  return (async () => {
    const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    await db.collection('documents').insertOne(Object.assign({
      id, title: 'ZZ Test Link Existing — ' + titleSuffix, type: 'MOA',
      institution: 'Testland Institute', partner: 'Testland Institute',
      fileLink: '/uploads/documents/' + fname,
      uploadedByEmail: ownerEmail, uploadedBy: 'Fixture', uploadedAt: new Date().toISOString(),
      originalFilename: titleSuffix + '.pdf'
    }, extraRequestTags || {}));
    seededDocIds.push(id);
    return id;
  })();
}

beforeAll(async () => {
  db = await connectDB();
  adminUser = await createTestUser({ role: 'Administrator' });
  adminAgent = request.agent(app); await loginAs(adminAgent, adminUser);
  staffUser = await createTestUser({ role: 'Staff' });
  staffAgent = request.agent(app); await loginAs(staffAgent, staffUser);
  requesterUser = await createTestUser({ role: 'potential_partner' });
  requesterAgent = request.agent(app); await loginAs(requesterAgent, requesterUser);
  otherPartnerAgent = request.agent(app);
  await loginAs(otherPartnerAgent, await createTestUser({ role: 'potential_partner' }));

  // Staff's own library: one document NOT tied to any request at all (simulates a plain OCR upload), and a
  // second one tied to a DIFFERENT, unrelated document request — this is the exact scenario the
  // isOwnerOfLinkedRequest fix covers (linking it to the real request below must not depend on that stale tag).
  staffDocId = await seedDoc(staffUser.email, 'Staff Unrelated Upload');
  staffDoc2Id = await seedDoc(staffUser.email, 'Staff Doc Originally For Another Request', { requestId: 999999, requestType: 'document' });
  // Administrator's own library — used to prove Staff cannot link across the ownership boundary.
  adminDocId = await seedDoc(adminUser.email, 'Admin Only Upload');

  const res = await requesterAgent.post('/api/document-requests').send({
    institution: 'Jest Test Link Existing Inst', documentType: 'MOA', notes: 'jesttest link-existing'
  });
  requestId = res.body.request.id;
});

afterAll(async () => {
  if (requestId) await db.collection('documentrequests').deleteOne({ id: requestId });
  if (seededDocIds.length) await db.collection('documents').deleteMany({ id: { $in: seededDocIds } });
  seededFiles.forEach((p) => { if (fs.existsSync(p)) fs.unlinkSync(p); });
  await cleanupAll();
  await closeDB();
});

describe('Linking existing documents — no duplication', () => {
  test('Staff can link one of their own existing documents without uploading a file', async () => {
    const before = await db.collection('documents').countDocuments({});
    const res = await staffAgent.post(`/api/document-requests/${requestId}/documents`)
      .field('documentIds', JSON.stringify([staffDocId]))
      .field('note', 'Here is the document you need.');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.linkedCount).toBe(1);

    const after = await db.collection('documents').countDocuments({});
    expect(after).toBe(before); // no new `documents` record was created

    const docs = res.body.request.supportingDocuments;
    expect(docs.length).toBe(1);
    expect(docs[0].linked).toBe(true);
    expect(docs[0].documentId).toBe(staffDocId);
    expect(docs[0].note).toBe('Here is the document you need.');
    expect(docs[0].uploaderRole).toBe('Staff');
  });

  test("the original document's own record is completely unchanged after being linked", async () => {
    const doc = await db.collection('documents').findOne({ id: staffDocId });
    expect(doc.uploadedByEmail).toBe(staffUser.email);
    expect(doc.title).toBe('ZZ Test Link Existing — Staff Unrelated Upload');
    expect(doc.fileLink).toBe(`/uploads/documents/${path.basename(seededFiles[0])}`);
  });

  test('multiple documents can be linked in a single request — one timeline entry each, still no duplicates', async () => {
    const before = await db.collection('documents').countDocuments({});
    const res = await staffAgent.post(`/api/document-requests/${requestId}/documents`)
      .field('documentIds', JSON.stringify([staffDocId, staffDoc2Id]));
    expect(res.status).toBe(200);
    expect(res.body.linkedCount).toBe(2);
    const after = await db.collection('documents').countDocuments({});
    expect(after).toBe(before);
    const docs = res.body.request.supportingDocuments;
    expect(docs.length).toBe(3); // 1 from the first test + 2 from this one
    expect(docs[1].documentId).toBe(staffDocId);
    expect(docs[2].documentId).toBe(staffDoc2Id);
    expect(docs[1].linked).toBe(true);
    expect(docs[2].linked).toBe(true);
  });
});

describe('Scope — reviewers may link any document in the system; non-reviewer submitters stay restricted to their own', () => {
  // 2026-11 review finding: GET /uploads/documents/:filename already grants Administrator/Staff
  // unrestricted read access to ANY document once it's attached to a request they review (the
  // REQUEST_REVIEWER_ROLES exemption from SELF_UPLOAD_ONLY_ROLES). Restricting the link picker to only the
  // acting reviewer's own uploads was therefore a stricter rule than their actual authorization level, and
  // it defeated half the point of the feature — one reviewer could never link a document a DIFFERENT
  // reviewer had already archived. This is now corrected: reviewers can link any existing document id;
  // only non-reviewer submitters (potential_partner) remain scoped to their own uploads, matching their own
  // (still-restricted) download authorization.
  test("Staff CAN link a document Administrator uploaded — reviewers share one document pool, not separate private libraries", async () => {
    const before = await db.collection('documents').countDocuments({});
    const res = await staffAgent.post(`/api/document-requests/${requestId}/documents`)
      .field('documentIds', JSON.stringify([adminDocId]));
    expect(res.status).toBe(200);
    expect(res.body.linkedCount).toBe(1);
    const after = await db.collection('documents').countDocuments({});
    expect(after).toBe(before); // still no duplicate record
    const docs = res.body.request.supportingDocuments;
    expect(docs[docs.length - 1].documentId).toBe(adminDocId);
    expect(docs[docs.length - 1].linked).toBe(true);
  });

  test('a non-existent document id is still rejected for a reviewer', async () => {
    const before = await db.collection('documentrequests').findOne({ id: requestId });
    const res = await staffAgent.post(`/api/document-requests/${requestId}/documents`)
      .field('documentIds', JSON.stringify([999999999]));
    expect(res.status).toBe(400);
    const after = await db.collection('documentrequests').findOne({ id: requestId });
    expect(after.supportingDocuments.length).toBe(before.supportingDocuments.length); // nothing was added
  });

  test('a mixed batch with one real id (from a different reviewer) and one non-existent id is rejected entirely — no partial linking', async () => {
    const before = await db.collection('documentrequests').findOne({ id: requestId });
    const res = await staffAgent.post(`/api/document-requests/${requestId}/documents`)
      .field('documentIds', JSON.stringify([adminDocId, 999999999]));
    expect(res.status).toBe(400);
    const after = await db.collection('documentrequests').findOne({ id: requestId });
    expect(after.supportingDocuments.length).toBe(before.supportingDocuments.length);
  });

  test("GET /api/documents still defaults to the caller's own uploads only — scope=all is opt-in and reviewer-only", async () => {
    const ownScope = await staffAgent.get('/api/documents');
    expect(ownScope.body.some((d) => d.id === adminDocId)).toBe(false); // Staff's default view never shows Admin's upload
    expect(ownScope.body.some((d) => d.id === staffDocId)).toBe(true);

    const allScope = await staffAgent.get('/api/documents?scope=all');
    expect(allScope.body.some((d) => d.id === adminDocId)).toBe(true); // only the explicit, reviewer-only opt-in does

    // A non-reviewer passing scope=all gets no broadening at all — still just their own uploads.
    const partnerDocId = await seedDoc(requesterUser.email, 'Requester Own Upload');
    const partnerAllScope = await requesterAgent.get('/api/documents?scope=all');
    expect(partnerAllScope.body.some((d) => d.id === adminDocId)).toBe(false);
    expect(partnerAllScope.body.some((d) => d.id === partnerDocId)).toBe(true);
  });

  test('the requester (potential_partner) cannot link a reviewer\'s document — stays restricted to their own Document Library', async () => {
    const before = await db.collection('documentrequests').findOne({ id: requestId });
    const res = await requesterAgent.post(`/api/document-requests/${requestId}/documents`)
      .field('documentIds', JSON.stringify([adminDocId]));
    expect(res.status).toBe(400);
    const after = await db.collection('documentrequests').findOne({ id: requestId });
    expect(after.supportingDocuments.length).toBe(before.supportingDocuments.length);
  });

  test('the requester (potential_partner) CAN link their own existing upload', async () => {
    const partnerDocId = await seedDoc(requesterUser.email, 'Requester Second Own Upload');
    const res = await requesterAgent.post(`/api/document-requests/${requestId}/documents`)
      .field('documentIds', JSON.stringify([partnerDocId]));
    expect(res.status).toBe(200);
    const docs = res.body.request.supportingDocuments;
    expect(docs[docs.length - 1].documentId).toBe(partnerDocId);
    expect(docs[docs.length - 1].uploaderRole).toBe('potential_partner');
  });
});

describe('Requester access to a linked document (isOwnerOfLinkedRequest fix)', () => {
  test("the requester can download a document linked from Staff's library, even though that document's own original tag points at a different request", async () => {
    // staffDoc2Id was seeded with requestId: 999999 (a request that doesn't even exist) — proves access
    // here does NOT depend on that stale original tag, only on the real link recorded on THIS request.
    const doc = await db.collection('documents').findOne({ id: staffDoc2Id });
    const res = await requesterAgent.get(doc.fileLink);
    expect(res.status).toBe(200);
  });

  test('an unrelated potential_partner (not this request\'s requester) still gets 403 on the same linked document', async () => {
    const doc = await db.collection('documents').findOne({ id: staffDoc2Id });
    const res = await otherPartnerAgent.get(doc.fileLink);
    expect(res.status).toBe(403);
  });

  test('Administrator/Staff (reviewers) can always open it regardless of linking', async () => {
    const doc = await db.collection('documents').findOne({ id: staffDoc2Id });
    expect((await adminAgent.get(doc.fileLink)).status).toBe(200);
    expect((await staffAgent.get(doc.fileLink)).status).toBe(200);
  });
});

describe('Combining a link with a new upload and/or a note in one request', () => {
  test('a file upload and a linked document together both appear as separate timeline entries', async () => {
    const before = await db.collection('documentrequests').findOne({ id: requestId });
    const beforeCount = before.supportingDocuments.length;

    const res = await staffAgent.post(`/api/document-requests/${requestId}/documents`)
      .field('documentIds', JSON.stringify([staffDocId]))
      .field('note', 'Combined upload + link')
      .attach('document', Buffer.from('%PDF-1.4 jesttest combined'), 'combined-new-upload.pdf');

    expect(res.status).toBe(200);
    const docs = res.body.request.supportingDocuments;
    expect(docs.length).toBe(beforeCount + 2);
    const newOnes = docs.slice(beforeCount);
    expect(newOnes.some((d) => d.linked === true && d.documentId === staffDocId)).toBe(true);
    expect(newOnes.some((d) => d.linked === false && d.originalFilename === 'combined-new-upload.pdf')).toBe(true);
  });
});
