// Document Library duplicate cleanup for Partnership Requests (2026-11, revised: supersede, never
// delete). Re-uploading or re-submitting a Partnership Request's MOA/MOU must leave exactly one CURRENT
// Document Library entry for that request — the latest version marks the previous one superseded
// instead of deleting it or piling up alongside it unmarked — and approval marks the surviving (current)
// entry final. See services/documentLibraryService.js's supersedePreviousRequestDocuments().
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');

let db;
const createdRequestIds = [];
beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  if (createdRequestIds.length) await db.collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);

// Only the CURRENT (non-superseded) entry counts toward "one entry per request" — a superseded row is
// deliberately still in the collection (never deleted), just excluded from ordinary Library browsing.
function currentLibraryCountFor(requestId) {
  return db.collection('documents').countDocuments({ requestId, requestType: 'partnership', superseded: { $ne: true } });
}

describe('Document Library — one entry per Partnership Request', () => {
  test('re-uploading a new version marks the previous Document Library entry superseded — never deleted — instead of adding a second current one', async () => {
    const { agent } = await agentFor('potential_partner');
    const made = await agent.post('/api/requests').send({ institution: 'jesttest Dedup University', country: 'Japan', type: 'MOA', nature: 'Research', notes: 'jesttest dedup' });
    expect(made.status).toBe(200);
    const id = made.body.request.id;
    createdRequestIds.push(id);

    const first = await agent.post(`/api/requests/${id}/documents`).attach('document', PNG_HEADER, 'v1.png');
    expect(first.status).toBe(200);
    const firstDocId = first.body.documentId;
    expect(await currentLibraryCountFor(id)).toBe(1);

    const second = await agent.post(`/api/requests/${id}/documents`).attach('document', PNG_HEADER, 'v2.png');
    expect(second.status).toBe(200);
    const secondDocId = second.body.documentId;

    // Still exactly one CURRENT entry for this request — the new version, not the old one.
    expect(await currentLibraryCountFor(id)).toBe(1);
    const survivor = await db.collection('documents').findOne({ id: secondDocId });
    expect(survivor).not.toBeNull();
    expect(survivor.requestId).toBe(id);
    expect(survivor.originalFilename).toBe('v2.png');
    expect(survivor.superseded).not.toBe(true);

    // The OLD version was never deleted — its own record and file both still exist, and its link in the
    // request's own history timeline still resolves (this is exactly the bug the delete-based approach
    // had: the old file was gone, so re-opening an earlier version's link in the timeline 404'd).
    const previous = await db.collection('documents').findOne({ id: firstDocId });
    expect(previous).not.toBeNull();
    expect(previous.superseded).toBe(true);
    expect(previous.supersededBy).toBe(secondDocId);
    expect(previous.originalFilename).toBe('v1.png');
    const fs = require('fs');
    const path = require('path');
    expect(fs.existsSync(path.join(__dirname, '..', 'uploads', 'documents', path.basename(previous.fileLink)))).toBe(true);
    const oldLink = await agent.get(previous.fileLink);
    expect(oldLink.status).toBe(200);

    // The request's own history timeline still lists and links every version, old and new alike.
    const list = await agent.get('/api/requests');
    const thisRequest = list.body.find((r) => r.id === id);
    const links = thisRequest.supportingDocuments.map((d) => d.fileLink);
    expect(links).toContain(previous.fileLink);
    expect(links).toContain(survivor.fileLink);

    // The superseded version no longer shows up in ordinary Document Library browsing.
    const library = await agent.get('/api/documents');
    expect(library.body.some((d) => d.id === firstDocId)).toBe(false);
    expect(library.body.some((d) => d.id === secondDocId)).toBe(true);
  });

  test('approving the request marks its one CURRENT Document Library entry final, not an older superseded one', async () => {
    const { agent } = await agentFor('potential_partner');
    const { agent: adminAgent } = await agentFor('Administrator');
    const made = await agent.post('/api/requests').send({ institution: 'jesttest Approve University', country: 'Japan', type: 'MOU', nature: 'Research', notes: 'jesttest dedup approve' });
    const id = made.body.request.id;
    createdRequestIds.push(id);
    // A fresh potential_partner submission with no attachmentLink also gets a no-file placeholder
    // library record from archiveRequestRecordToLibrary (same {requestId, requestType} pair) — the real
    // file upload below marks THAT superseded too, so approval must still land on the uploaded file, not
    // the placeholder.
    const upload = await agent.post(`/api/requests/${id}/documents`).attach('document', PNG_HEADER, 'final.png');
    expect(upload.status).toBe(200);

    const decided = await adminAgent.patch(`/api/requests/${id}`).send({ status: 'Approved' });
    expect(decided.status).toBe(200);

    const current = await db.collection('documents').findOne({ requestId: id, requestType: 'partnership', superseded: { $ne: true } });
    expect(current).not.toBeNull();
    expect(current.originalFilename).toBe('final.png');
    expect(current.final).toBe(true);
    expect(current.approvedAt).toBeTruthy();

    const placeholder = await db.collection('documents').findOne({ requestId: id, requestType: 'partnership', superseded: true });
    expect(placeholder).not.toBeNull();
    expect(placeholder.final).toBeFalsy(); // approval never marks a superseded row final
  });

  test('a brand-new request created with an OCR-confirmed attachment gets retroactively tagged with its requestId', async () => {
    const { agent, user } = await agentFor('potential_partner');
    // Simulates exactly what POST /api/ocr/confirm archives for a request that doesn't exist yet — a
    // documents row with a fileLink but no requestId/requestType at all (actually running OCR here is out
    // of scope for this test; only the retroactive-tagging step that follows is under test).
    const fakeDoc = await db.collection('documents').insertOne({
      id: 999900001, title: 'jesttest Retro Attachment', type: 'MOA', fileLink: '/uploads/documents/jesttest-retro-attachment.png',
      uploadedBy: user.name, uploadedByEmail: user.email, uploadedAt: new Date().toISOString()
    });

    const made = await agent.post('/api/requests').send({
      institution: 'jesttest Retro University', country: 'Japan', type: 'MOA', nature: 'Research', notes: 'jesttest retro',
      attachmentLink: '/uploads/documents/jesttest-retro-attachment.png'
    });
    expect(made.status).toBe(200);
    const id = made.body.request.id;
    createdRequestIds.push(id);

    const tagged = await db.collection('documents').findOne({ id: 999900001 });
    expect(tagged.requestId).toBe(id);
    expect(tagged.requestType).toBe('partnership');
    await db.collection('documents').deleteOne({ id: 999900001 });
  });
});
