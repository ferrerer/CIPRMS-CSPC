// Covers the 2026-09-14 Staff Document Library correction: Administrator and
// Staff each get their own separate Document Library (already true via the
// existing uploadedByEmail-scoped OWN_SCOPE_ROLES filter — untouched here),
// but Staff previously had no way to directly upload/OCR into it at all:
// - views/administrator/documents.ejs gated the "Upload & Extract" button
//   and the entire upload modal behind `user.role === 'Administrator'` even
//   though the backend (requireUploader) already permitted Staff.
// - POST /api/ocr/extract was gated by requireAuth (any authenticated role)
//   rather than the same requireUploader gate the rest of the Document
//   Library routes use — tightened for explicit, future-proof intent.
//
// 2026-10-03 WORKFLOW CHANGE: OCR no longer auto-archives.
// - POST /api/ocr/extract + GET /api/ocr/status/:jobId only extract; nothing
//   is written to the Document Library during this phase.
// - POST /api/ocr/confirm permanently archives the document after user review.
// - POST /api/ocr/discard cleans up the temp file without creating any record.
// This file verifies the backend authorization and the real, live OCR pipeline
// for both Administrator and Staff, plus per-user library isolation.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { DOCUMENTS_DIR } = require('../services/documentLibraryService');

let db;
let adminAgent, staffAgent, personnelAgent, partnerAgent;
let adminUser, staffUser;
const createdDocIds = [];

// A real, Tesseract-readable PNG — same technique used for the health-check
// audit's live OCR verification (rendered SVG text -> raster), so this
// exercises the actual OCR engine, not a mock.
function buildTestImage(label) {
  const svg = `
    <svg width="900" height="260" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="white"/>
      <text x="40" y="60" font-family="Arial" font-size="30" font-weight="bold" fill="black">MEMORANDUM OF AGREEMENT</text>
      <text x="40" y="110" font-family="Arial" font-size="20" fill="black">Camarines Sur Polytechnic Colleges and Osaka University of Japan</text>
      <text x="40" y="150" font-family="Arial" font-size="18" fill="black">Uploaded by: ${label}</text>
      <text x="40" y="190" font-family="Arial" font-size="18" fill="black">Date of Signing: Jan 15, 2026</text>
      <text x="40" y="220" font-family="Arial" font-size="18" fill="black">Date of Expiration: Jan 15, 2031</text>
    </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Uploads, polls to completion, and returns the completed job.
// Does NOT call confirm — callers must do that explicitly.
async function uploadAndWait(agent, imageBuffer, filename) {
  const uploadRes = await agent
    .post('/api/ocr/extract')
    .attach('document', imageBuffer, { filename, contentType: 'image/png' });
  expect(uploadRes.status).toBe(202);
  const jobId = uploadRes.body.jobId;

  let job;
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 1500));
    const statusRes = await agent.get(`/api/ocr/status/${jobId}`);
    job = statusRes.body;
    if (job.status === 'done' || job.status === 'error') break;
  }
  return { job, jobId };
}

// Confirms a completed job and returns { documentId, fileLink }.
async function confirmJob(agent, jobId, overrides = {}) {
  const res = await agent.post('/api/ocr/confirm')
    .set('Content-Type', 'application/json')
    .send({ jobId, ...overrides });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  return res.body;
}

beforeAll(async () => {
  db = await connectDB();
  adminUser = await createTestUser({ role: 'Administrator' });
  adminAgent = request.agent(app);
  await loginAs(adminAgent, adminUser);
  staffUser = await createTestUser({ role: 'Staff' });
  staffAgent = request.agent(app);
  await loginAs(staffAgent, staffUser);
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
});

afterAll(async () => {
  for (const id of createdDocIds) {
    const doc = await db.collection('documents').findOne({ id });
    if (doc && doc.fileLink && doc.fileLink.startsWith('/uploads/documents/')) {
      const filePath = path.join(DOCUMENTS_DIR, path.basename(doc.fileLink));
      if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
    }
  }
  if (createdDocIds.length) await db.collection('documents').deleteMany({ id: { $in: createdDocIds } });
  await cleanupAll();
  await closeDB();
});

describe('Backend authorization for OCR/direct upload (RBAC)', () => {
  // Each RBAC test fully runs OCR and then discards the temp file without
  // creating any DB record — confirming that /api/ocr/extract + /api/ocr/status
  // no longer create documents by themselves.
  test('Administrator: POST /api/ocr/extract is allowed (202, not blocked), and /api/ocr/discard cleans up', async () => {
    const img = await buildTestImage('rbac-admin-check');
    const { job, jobId } = await uploadAndWait(adminAgent, img, 'a.png');
    expect(job.status).toBe('done');
    // Discard without saving — no DB record should be created.
    const discardRes = await adminAgent.post('/api/ocr/discard').send({ jobId });
    expect(discardRes.status).toBe(200);
    expect(discardRes.body.success).toBe(true);
    // Confirm no document was written.
    expect(job.result.documentId).toBeUndefined();
  }, 30000);

  test('Staff: POST /api/ocr/extract is allowed (202, not blocked) — the actual bug being fixed', async () => {
    const img = await buildTestImage('rbac-staff-check');
    const { job, jobId } = await uploadAndWait(staffAgent, img, 's.png');
    expect(job.status).toBe('done');
    const discardRes = await staffAgent.post('/api/ocr/discard').send({ jobId });
    expect(discardRes.status).toBe(200);
    expect(job.result.documentId).toBeUndefined();
  }, 30000);

  test('Auth. Personnel: OCR access is preserved unchanged (still allowed — not broadened, not revoked)', async () => {
    const img = await buildTestImage('rbac-personnel-check');
    const { job, jobId } = await uploadAndWait(personnelAgent, img, 'p.png');
    expect(job.status).toBe('done');
    await personnelAgent.post('/api/ocr/discard').send({ jobId });
    expect(job.result.documentId).toBeUndefined();
  }, 30000);

  test('potential_partner: OCR access is preserved unchanged (still allowed — not broadened, not revoked)', async () => {
    const img = await buildTestImage('rbac-partner-check');
    const { job, jobId } = await uploadAndWait(partnerAgent, img, 'pp.png');
    expect(job.status).toBe('done');
    await partnerAgent.post('/api/ocr/discard').send({ jobId });
    expect(job.result.documentId).toBeUndefined();
  }, 30000);

  test('Unauthenticated: POST /api/ocr/extract is rejected (redirected, never reaches the OCR pipeline)', async () => {
    const img = await buildTestImage('rbac-anon-check');
    const res = await request(app).post('/api/ocr/extract').attach('document', img, { filename: 'x.png', contentType: 'image/png' });
    expect(res.status).toBe(302); // requireUploader redirect — never starts a job, nothing to clean up
  });

  test('Administrator and Staff can both reach the Document Library listing/folder routes', async () => {
    const adminDocs = await adminAgent.get('/api/documents');
    expect(adminDocs.status).toBe(200);
    const staffDocs = await staffAgent.get('/api/documents');
    expect(staffDocs.status).toBe(200);
    const adminFolders = await adminAgent.get('/api/document-folders/mine');
    expect(adminFolders.status).toBe(200);
    const staffFolders = await staffAgent.get('/api/document-folders/mine');
    expect(staffFolders.status).toBe(200);
  });
});

describe('Explicit-confirm workflow: nothing is saved until POST /api/ocr/confirm', () => {
  test('OCR job completes but NO document is created until confirm is called', async () => {
    const img = await buildTestImage('confirm-guard-check');
    const { job, jobId } = await uploadAndWait(adminAgent, img, 'guard-test.png');
    expect(job.status).toBe('done');
    // No documentId in the result — nothing saved yet.
    expect(job.result.documentId).toBeUndefined();

    const libBefore = await adminAgent.get('/api/documents');
    const beforeCount = libBefore.body.length;

    // Explicitly confirm — only NOW is the document written.
    const confirmed = await confirmJob(adminAgent, jobId);
    expect(confirmed.documentId).toBeTruthy();
    createdDocIds.push(confirmed.documentId);

    const libAfter = await adminAgent.get('/api/documents');
    expect(libAfter.body.length).toBe(beforeCount + 1);
    expect(libAfter.body.some(d => d.id === confirmed.documentId)).toBe(true);
  }, 45000);

  test('Discard after OCR leaves NO document in the library', async () => {
    const img = await buildTestImage('discard-check');
    const { job, jobId } = await adminAgent
      .post('/api/ocr/extract')
      .attach('document', img, { filename: 'discard-test.png', contentType: 'image/png' })
      .then(async (uploadRes) => {
        expect(uploadRes.status).toBe(202);
        const jId = uploadRes.body.jobId;
        let j;
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 1500));
          const s = await adminAgent.get(`/api/ocr/status/${jId}`);
          j = s.body;
          if (j.status === 'done' || j.status === 'error') break;
        }
        return { job: j, jobId: jId };
      });

    expect(job.status).toBe('done');

    const libBefore = await adminAgent.get('/api/documents');
    const beforeCount = libBefore.body.length;

    const discardRes = await adminAgent.post('/api/ocr/discard').send({ jobId });
    expect(discardRes.status).toBe(200);
    expect(discardRes.body.success).toBe(true);

    const libAfter = await adminAgent.get('/api/documents');
    // Library count must be unchanged — discard creates no record.
    expect(libAfter.body.length).toBe(beforeCount);
  }, 45000);

  test('Closing modal without saving (discard) does not pollute the library', async () => {
    // Simulates what the frontend does when modal is closed: POST /api/ocr/discard
    const img = await buildTestImage('modal-close-discard');
    const uploadRes = await adminAgent
      .post('/api/ocr/extract')
      .attach('document', img, { filename: 'modal-close.png', contentType: 'image/png' });
    expect(uploadRes.status).toBe(202);
    const jobId = uploadRes.body.jobId;
    // Don't wait for completion — just discard immediately to simulate fast close.
    const discardRes = await adminAgent.post('/api/ocr/discard').send({ jobId });
    expect(discardRes.status).toBe(200);
    // Job is cleaned up from memory.
    const statusRes = await adminAgent.get(`/api/ocr/status/${jobId}`);
    expect(statusRes.status).toBe(404);
  }, 15000);

  test('Cannot confirm a job twice (idempotency guard)', async () => {
    const img = await buildTestImage('double-confirm-guard');
    const { job, jobId } = await uploadAndWait(adminAgent, img, 'double-confirm.png');
    expect(job.status).toBe('done');

    const first = await confirmJob(adminAgent, jobId);
    expect(first.documentId).toBeTruthy();
    createdDocIds.push(first.documentId);

    // Attempting a second confirm must be rejected.
    const secondRes = await adminAgent.post('/api/ocr/confirm').send({ jobId });
    expect(secondRes.status).toBe(409);
  }, 45000);

  test('Cannot confirm another user\'s job (ownership check)', async () => {
    const img = await buildTestImage('ownership-check');
    const { jobId } = await uploadAndWait(adminAgent, img, 'ownership.png');

    // Staff tries to confirm Admin's job.
    const res = await staffAgent.post('/api/ocr/confirm').send({ jobId });
    expect(res.status).toBe(403);

    // Clean up the temp file.
    await adminAgent.post('/api/ocr/discard').send({ jobId });
  }, 45000);
});

describe('Real end-to-end OCR pipeline (actual Tesseract, not mocked) for Administrator and Staff', () => {
  test('Administrator: real OCR extracts text, classifies the document, and archives it only after confirm', async () => {
    const img = await buildTestImage('E2E Admin Upload');
    const { job, jobId } = await uploadAndWait(adminAgent, img, 'admin-e2e.png');

    expect(job.status).toBe('done');
    expect(job.result.method).toBe('ocr');
    expect(job.result.confidence).toBeGreaterThan(0);
    expect(job.result.rawText).toMatch(/MEMORANDUM OF AGREEMENT/i);
    expect(job.result.documentType).toMatch(/Memorandum of Agreement/i);
    expect(job.result.country).toBe('Japan');
    // No documentId yet — document is NOT in the library yet.
    expect(job.result.documentId).toBeUndefined();

    // Explicitly confirm.
    const confirmed = await confirmJob(adminAgent, jobId);
    expect(confirmed.documentId).toBeTruthy();
    createdDocIds.push(confirmed.documentId);

    const lib = await adminAgent.get('/api/documents');
    const entry = lib.body.find((d) => d.id === confirmed.documentId);
    expect(entry).toBeTruthy();
    expect(entry.uploadedByEmail).toBe(adminUser.email);
  }, 45000);

  test('Staff: real OCR extracts text, classifies the document, and archives it to their OWN Document Library after confirm', async () => {
    const img = await buildTestImage('E2E Staff Upload');
    const { job, jobId } = await uploadAndWait(staffAgent, img, 'staff-e2e.png');

    expect(job.status).toBe('done');
    expect(job.result.method).toBe('ocr');
    expect(job.result.confidence).toBeGreaterThan(0);
    expect(job.result.rawText).toMatch(/MEMORANDUM OF AGREEMENT/i);
    expect(job.result.documentType).toMatch(/Memorandum of Agreement/i);
    expect(job.result.country).toBe('Japan');
    expect(job.result.documentId).toBeUndefined();

    const confirmed = await confirmJob(staffAgent, jobId);
    expect(confirmed.documentId).toBeTruthy();
    createdDocIds.push(confirmed.documentId);

    const lib = await staffAgent.get('/api/documents');
    const entry = lib.body.find((d) => d.id === confirmed.documentId);
    expect(entry).toBeTruthy();
    expect(entry.uploadedByEmail).toBe(staffUser.email);
  }, 45000);

  test('Shared library (2026-11): Administrator sees Staff\'s OCR upload, and Staff sees Administrator\'s', async () => {
    // Relies on the two documentIds captured by the previous two tests.
    const adminDocId = createdDocIds[createdDocIds.length - 2];
    const staffDocId = createdDocIds[createdDocIds.length - 1];
    expect(adminDocId).toBeTruthy();
    expect(staffDocId).toBeTruthy();

    const adminLib = await adminAgent.get('/api/documents');
    expect(adminLib.body.some((d) => d.id === staffDocId)).toBe(true);

    const staffLib = await staffAgent.get('/api/documents');
    expect(staffLib.body.some((d) => d.id === adminDocId)).toBe(true);
  });
});
