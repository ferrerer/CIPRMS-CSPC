// "The first uploaded file goes missing" investigation (2026-11).
//
// Root cause #1 (client-side, fixed in views/administrator/partnership_requests.ejs,
// views/potential_partner/partner_requests.ejs, assets/js/pages/registry-gridjs.init.js): every one of
// these pages' own OCR-confirm / direct-upload call sites checked only res.ok / data.success before this
// fix — but a HELD duplicate (duplicateWarningGate / ocrService.confirmJob's own duplicate check) responds
// with {success:true, duplicateFound:true, pendingId, ...} and NO documentId/fileLink/request. Only
// documents.ejs ever checked `duplicateFound` — every other page silently treated the hold as success,
// so the file sat under its pendingUpload/OCR-job TTL until it was deleted, never attached to anything.
// The server-side hold/accept/cancel mechanics themselves were already correct and already covered by
// test/duplicate-warning.test.js (direct uploads) and test/idp-duplicate-detection.test.js
// (findPossibleDuplicates itself) — this file does not re-prove those. It proves the two things that
// WERE wrong at the server/service level, and the one end-to-end OCR-confirm path those two existing
// files don't exercise.
//
// Root cause #2 (server-side, fixed in services/documentLibraryService.js's
// supersedePreviousRequestDocuments): matched every other document tagged with the same
// {requestId, requestType} regardless of its own `type`, so uploading a genuinely different document to
// the same request (e.g. an Accreditation after an MOA) marked the MOA superseded too — hidden from
// Document Library browsing even though it was never actually replaced. Fixed to also require the same
// `type` as the current document.
jest.setTimeout(60000); // this file's OCR-path tests each run 2 real extract+poll cycles in sequence

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
const createdRequestIds = [];
const createdDocumentIds = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  if (createdRequestIds.length) await db.collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  if (createdDocumentIds.length) await db.collection('documents').deleteMany({ id: { $in: createdDocumentIds } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

const RUN_SALT = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
let fileCounter = 0;
// >1024 bytes (MIN_HASH_MATCH_BYTES) so each upload is content-unique and never accidentally exact-hash-
// matches another test's fixture (which would hold it for the wrong reason).
function bigPng(label) {
  fileCounter += 1;
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  return Buffer.concat([sig, Buffer.from(`${TEST_TAG} first-upload-fix ${RUN_SALT} #${fileCounter}: ${label}`.padEnd(1100, '.'))]);
}

async function makeRequest(agent, institutionLabel, type) {
  const institution = `${TEST_TAG} ${RUN_SALT} ${institutionLabel}`;
  const res = await agent.post('/api/requests').send({ institution, country: 'Japan', type: type || 'MOA', nature: 'Research', notes: `${TEST_TAG} fix` });
  expect(res.status).toBe(200);
  createdRequestIds.push(res.body.request.id);
  return res.body.request.id;
}

describe('Sequential uploads to the same request all stay attached', () => {
  test('2-3 files in a row each appear in supportingDocuments, none silently dropped', async () => {
    const { agent } = await agentFor('potential_partner');
    const id = await makeRequest(agent, 'Sequential Uploads Inst');

    const r1 = await agent.post(`/api/requests/${id}/documents`).attach('document', bigPng('v1'), 'v1.png');
    expect(r1.body.documentId).toBeTruthy();
    createdDocumentIds.push(r1.body.documentId);

    const r2 = await agent.post(`/api/requests/${id}/documents`).attach('document', bigPng('v2'), 'v2.png');
    expect(r2.body.documentId).toBeTruthy();
    createdDocumentIds.push(r2.body.documentId);

    const r3 = await agent.post(`/api/requests/${id}/documents`).attach('document', bigPng('v3'), 'v3.png');
    expect(r3.body.documentId).toBeTruthy();
    createdDocumentIds.push(r3.body.documentId);

    const updated = await db.collection('requests').findOne({ id });
    expect(updated.supportingDocuments.length).toBe(3);
    expect(updated.supportingDocuments.map((d) => d.documentId)).toEqual([r1.body.documentId, r2.body.documentId, r3.body.documentId]);

    // Each earlier version IS superseded (same type — these genuinely are successive versions) but still
    // exists, still has its own fileLink, and is still reachable from the request's own timeline above.
    const v1Doc = await db.collection('documents').findOne({ id: r1.body.documentId });
    expect(v1Doc.superseded).toBe(true);
    expect(v1Doc.fileLink).toBeTruthy();
  });
});

describe('Two different document types on one request are never treated as versions of each other', () => {
  // Realistic path for this: re-confirming an OCR job against an EXISTING request (requestId passed to
  // POST /api/ocr/confirm) also calls supersedePreviousRequestDocuments (see ocrService.confirmJob) —
  // and documentType there is a free-text override, not constrained to the request's own fixed MOA/MOU
  // type, so this is exactly how a genuinely different document type ends up tagged to one request.
  async function ocrExtractText(agent, text) {
    const file = path.join(os.tmpdir(), `${TEST_TAG}-ocr-type-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="100%" height="100%" fill="white"/><text x="20" y="60" font-size="20" font-family="sans-serif" fill="black">${TEST_TAG} first-upload-fix type test ${RUN_SALT}: ${text}</text></svg>`);
    await sharp(svg).png().toFile(file);
    try {
      const start = await agent.post('/api/ocr/extract').attach('document', file);
      expect(start.status).toBe(202);
      let status, tries = 0;
      do {
        await new Promise((r) => setTimeout(r, 300));
        status = await agent.get('/api/ocr/status/' + start.body.jobId);
        tries++;
      } while (status.body.status === 'processing' && tries < 20);
      expect(status.body.status).toBe('done');
      return start.body.jobId;
    } finally {
      fs.unlinkSync(file);
    }
  }

  test('an MOA followed by an Accreditation on the same request: neither is marked superseded', async () => {
    const { agent } = await agentFor('potential_partner');
    const id = await makeRequest(agent, 'MOA Plus Accreditation Inst');

    const jobMoa = await ocrExtractText(agent, 'moa');
    const moa = await agent.post('/api/ocr/confirm').send({ jobId: jobMoa, documentType: 'MOA', requestId: id });
    expect(moa.body.success).toBe(true);
    expect(moa.body.documentId).toBeTruthy();
    createdDocumentIds.push(moa.body.documentId);

    const jobAccred = await ocrExtractText(agent, 'accreditation');
    const accred = await agent.post('/api/ocr/confirm').send({ jobId: jobAccred, documentType: 'Accreditation', requestId: id });
    expect(accred.body.success).toBe(true);
    expect(accred.body.documentId).toBeTruthy();
    createdDocumentIds.push(accred.body.documentId);

    const moaDoc = await db.collection('documents').findOne({ id: moa.body.documentId });
    const accredDoc = await db.collection('documents').findOne({ id: accred.body.documentId });
    expect(moaDoc.type).not.toBe(accredDoc.type); // confirms the two really did archive as different types
    expect(moaDoc.superseded).toBeFalsy(); // a different document — must never be hidden as a "replaced" version
    expect(accredDoc.superseded).toBeFalsy();
  });
});

describe('A duplicate on the first upload is held, warned, and attaches on "Upload anyway" (OCR path)', () => {
  async function ocrExtract(agent, text) {
    const file = path.join(os.tmpdir(), `${TEST_TAG}-ocr-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
    // POST /api/ocr/extract only accepts PDF/JPG/PNG/DOCX — a real (sharp-rendered) image, same fixture
    // pattern as test/partner-ocr-upload-and-details.test.js. findPossibleDuplicates only ever needs
    // institution/fileHash/filename to produce a match here, never the OCR'd text itself.
    const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="100%" height="100%" fill="white"/><text x="20" y="60" font-size="20" font-family="sans-serif" fill="black">${TEST_TAG} first-upload-fix OCR fixture ${RUN_SALT}: ${text}</text></svg>`);
    await sharp(svg).png().toFile(file);
    try {
      const start = await agent.post('/api/ocr/extract').attach('document', file);
      expect(start.status).toBe(202);
      let status, tries = 0;
      do {
        await new Promise((r) => setTimeout(r, 300));
        status = await agent.get('/api/ocr/status/' + start.body.jobId);
        tries++;
      } while (status.body.status === 'processing' && tries < 20);
      expect(status.body.status).toBe('done');
      return start.body.jobId;
    } finally {
      fs.unlinkSync(file);
    }
  }

  test('first OCR confirm archives normally; a second confirm matching the same institution is held, then "Upload anyway" archives it', async () => {
    const { agent } = await agentFor('potential_partner');
    const institution = `${TEST_TAG} ${RUN_SALT} OCR Duplicate Inst`;

    const jobA = await ocrExtract(agent, 'first');
    const confirmA = await agent.post('/api/ocr/confirm').send({ jobId: jobA, institution });
    expect(confirmA.status).toBe(200);
    expect(confirmA.body.success).toBe(true);
    expect(confirmA.body.duplicateFound).toBeFalsy();
    expect(confirmA.body.documentId).toBeTruthy();
    createdDocumentIds.push(confirmA.body.documentId);

    // A second, unrelated upload that happens to name the SAME institution — exactly what the client-side
    // bug let through as a silent "success" before this fix (res.ok/data.success is true either way).
    const jobB = await ocrExtract(agent, 'second');
    const confirmB = await agent.post('/api/ocr/confirm').send({ jobId: jobB, institution });
    expect(confirmB.status).toBe(200);
    expect(confirmB.body.success).toBe(true);
    expect(confirmB.body.duplicateFound).toBe(true);
    expect(confirmB.body.documentId).toBeUndefined(); // nothing archived — exactly the state the bug left on screen as "success"

    const countBeforeAck = await db.collection('documents').countDocuments({ fileLink: { $exists: true } });

    // "Upload anyway" — same jobId, acknowledgeDuplicate: true (what the three fixed pages now do).
    const ack = await agent.post('/api/ocr/confirm').send({ jobId: jobB, institution, acknowledgeDuplicate: true });
    expect(ack.status).toBe(200);
    expect(ack.body.success).toBe(true);
    expect(ack.body.duplicateFound).toBeFalsy();
    expect(ack.body.documentId).toBeTruthy();
    createdDocumentIds.push(ack.body.documentId);

    const countAfterAck = await db.collection('documents').countDocuments({ fileLink: { $exists: true } });
    expect(countAfterAck).toBe(countBeforeAck + 1); // the previously-held file really did get archived, not lost

    const ackedDoc = await db.collection('documents').findOne({ id: ack.body.documentId });
    expect(ackedDoc.duplicateAcknowledged).toBe(true);
    expect(ackedDoc.acknowledgedMatchIds).toContain(confirmA.body.documentId);
  });
});

describe('POST /api/uploads/pending/:id/accept now passes through the full updated request', () => {
  test('accepting a held direct upload returns `updated` (the request with its pushed supportingDocuments entry)', async () => {
    const { agent } = await agentFor('potential_partner');
    const idA = await makeRequest(agent, 'Accept Returns Request Inst A');
    const idB = await makeRequest(agent, 'Accept Returns Request Inst B');
    const bytes = bigPng('accept-returns-request');

    const first = await agent.post(`/api/requests/${idA}/documents`).attach('document', bytes, 'first.png');
    createdDocumentIds.push(first.body.documentId);

    const dup = await agent.post(`/api/requests/${idB}/documents`).attach('document', bytes, 'second.png');
    expect(dup.body.duplicateFound).toBe(true);

    const accept = await agent.post(`/api/uploads/pending/${dup.body.pendingId}/accept`);
    expect(accept.status).toBe(200);
    expect(accept.body.documentId).toBeTruthy();
    createdDocumentIds.push(accept.body.documentId);
    // 2026-11 fix: previously only {success, documentId, fileLink} — a caller had no way to refresh its
    // own cached copy of the request (e.g. the draft-collaboration timeline) without a full reload.
    expect(accept.body.updated).toBeTruthy();
    expect(accept.body.updated.id).toBe(idB);
    expect(accept.body.updated.supportingDocuments.length).toBe(1);
  });
});
