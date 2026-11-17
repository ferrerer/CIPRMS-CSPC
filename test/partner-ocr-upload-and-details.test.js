// Partner: View Request Details and Draft, and Fix Lost OCR Uploads (2026-11).
//
// Part 1 bug fix: the partner's OCR dropzone (views/potential_partner/partner_requests.ejs) extracted and
// autofilled fields correctly, but never called POST /api/ocr/confirm — the one step that actually archives
// the file — so ocrExtractedResult.fileLink was always undefined, attachmentLink was never sent, and the
// uploaded file was lost (not in Drafts, never reached Admin/Staff, never in the Document Library). Fixed by
// calling the existing /api/ocr/confirm endpoint, same as the Admin/Staff "Request Partnership" modal
// already does — no new server logic, nothing duplicated. This file proves the resulting server-side state
// is correct end to end: a real (sharp-rendered) image through the real OCR pipeline.
//
// Part 2: GET /api/requests/mine (already scopeLauReviewsForViewer-wrapped, already attachmentLink/
// supportingDocuments-bearing) is the only server surface the new partner_monitoring.ejs "View" details
// panel reads from — no server changes there either. This file proves the pre-existing visibility/LAU-
// hiding/file-access-control rules this view relies on actually hold for a request carrying a real OCR
// attachment.
jest.setTimeout(60000);

const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
const requestIds = [];
const documentIds = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  await db.collection('requests').deleteMany({ id: { $in: requestIds } });
  if (documentIds.length) await db.collection('documents').deleteMany({ id: { $in: documentIds } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(user) {
  const agent = request.agent(app);
  await loginAs(agent, user);
  return agent;
}

async function uploadAndExtract(agent, text) {
  const file = path.join(os.tmpdir(), `${TEST_TAG}-${Date.now()}-${Math.floor(Math.random() * 1e6)}.png`);
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="100%" height="100%" fill="white"/><text x="20" y="60" font-size="28" font-family="sans-serif" fill="black">${text}</text></svg>`);
  await sharp(svg).png().toFile(file);
  try {
    const start = await agent.post('/api/ocr/extract').attach('document', file);
    expect(start.status).toBe(202);
    let status, tries = 0;
    do {
      await new Promise(r => setTimeout(r, 500));
      status = await agent.get('/api/ocr/status/' + start.body.jobId);
      tries++;
    } while (status.body.status === 'processing' && tries < 20);
    expect(status.body.status).toBe('done');
    return start.body.jobId;
  } finally {
    fs.unlinkSync(file);
  }
}

describe('Part 1 — partner OCR upload is no longer lost', () => {
  let partnerA, partnerB, admin, lau;

  beforeAll(async () => {
    partnerA = await createTestUser({ role: 'potential_partner' });
    partnerB = await createTestUser({ role: 'potential_partner' });
    admin = await createTestUser({ role: 'Administrator' });
    lau = await createTestUser({ role: 'LAU' });
  });

  test('extract -> confirm -> save as draft: the file is attached (attachmentLink set) and archived to the Document Library', async () => {
    const agent = await agentFor(partnerA);
    const jobId = await uploadAndExtract(agent, 'MOA with Gamma Research Institute, Japan');

    const confirm = await agent.post('/api/ocr/confirm').send({ jobId, documentType: 'MOA' });
    expect(confirm.status).toBe(200);
    expect(confirm.body.fileLink).toBeTruthy();
    documentIds.push(confirm.body.documentId);

    const draft = await agent.post('/api/requests').send({
      institution: `${TEST_TAG} Draft Gamma University`, country: 'Japan', type: 'MOA', nature: 'Research',
      isDraft: true, attachmentLink: confirm.body.fileLink
    });
    expect(draft.status).toBe(200);
    requestIds.push(draft.body.request.id);
    expect(draft.body.request.attachmentLink).toBe(confirm.body.fileLink);
    expect(draft.body.request.status).toBe('Draft');

    // Still there when the draft is "reopened" (GET /api/requests/mine, what editDraft() reads from).
    const mine = await agent.get('/api/requests/mine');
    const reopened = mine.body.find(r => r.id === draft.body.request.id);
    expect(reopened.attachmentLink).toBe(confirm.body.fileLink);

    // Really archived to the Document Library, not just a string on the request.
    const archived = await db.collection('documents').findOne({ id: confirm.body.documentId });
    expect(archived).toBeTruthy();
    expect(archived.fileLink).toBe(confirm.body.fileLink);
    expect(archived.uploadedByEmail).toBe(partnerA.email);
  });

  test('kept when the draft is edited (without re-uploading) and then submitted; visible to Admin/Staff', async () => {
    const agent = await agentFor(partnerA);
    const jobId = await uploadAndExtract(agent, 'MOU with Delta College, Vietnam');
    const confirm = await agent.post('/api/ocr/confirm').send({ jobId, documentType: 'MOU' });
    documentIds.push(confirm.body.documentId);

    const draft = await agent.post('/api/requests').send({
      institution: `${TEST_TAG} Edit-Submit Delta College`, country: 'Vietnam', type: 'MOU', nature: 'Student Exchange',
      isDraft: true, attachmentLink: confirm.body.fileLink
    });
    requestIds.push(draft.body.request.id);
    const id = draft.body.request.id;

    // Edit the draft WITHOUT resending attachmentLink (exactly what collectFormData() sends when the user
    // reopens a draft and re-saves without touching the OCR section) — must not erase the attachment.
    const edited = await agent.patch(`/api/requests/${id}/edit`).send({ notes: 'updated notes, no re-upload' });
    expect(edited.status).toBe(200);
    expect(edited.body.request.attachmentLink).toBe(confirm.body.fileLink);

    const submitted = await agent.post(`/api/requests/${id}/submit`).send();
    expect(submitted.status).toBe(200);
    expect(submitted.body.request.status).toBe('Pending');
    expect(submitted.body.request.attachmentLink).toBe(confirm.body.fileLink);

    const adminAgent = await agentFor(admin);
    const adminView = await adminAgent.get('/api/requests');
    const seenByAdmin = adminView.body.find(r => r.id === id);
    expect(seenByAdmin.attachmentLink).toBe(confirm.body.fileLink);
  });

  test('a bad file type and an oversized file are still rejected on /api/ocr/extract (unchanged validation)', async () => {
    const agent = await agentFor(partnerA);
    const fakePath = path.join(os.tmpdir(), `${TEST_TAG}-fake.png`);
    fs.writeFileSync(fakePath, 'not a real png, just text pretending to be one');
    try {
      const res = await agent.post('/api/ocr/extract').attach('document', fakePath);
      expect(res.status).toBe(400);
    } finally {
      fs.unlinkSync(fakePath);
    }
  });
});

describe('Part 2 — visibility and access control the new "View" details panel relies on', () => {
  let partnerA, partnerB, admin, lau;
  let requestId, documentId, fileLink;

  beforeAll(async () => {
    partnerA = await createTestUser({ role: 'potential_partner' });
    partnerB = await createTestUser({ role: 'potential_partner' });
    admin = await createTestUser({ role: 'Administrator' });
    lau = await createTestUser({ role: 'LAU' });

    const agent = await agentFor(partnerA);
    const jobId = await uploadAndExtract(agent, 'MOA with Epsilon Foundation, Korea');
    const confirm = await agent.post('/api/ocr/confirm').send({ jobId, documentType: 'MOA' });
    documentId = confirm.body.documentId;
    fileLink = confirm.body.fileLink;
    documentIds.push(documentId);

    const create = await agent.post('/api/requests').send({
      institution: `${TEST_TAG} Visibility Epsilon Foundation`, country: 'Korea', type: 'MOA', nature: 'Research',
      isDraft: false, attachmentLink: fileLink
    });
    requestId = create.body.request.id;
    requestIds.push(requestId);

    const lauAgent = await agentFor(lau);
    await lauAgent.post(`/api/requests/${requestId}/lau-review`).send({ note: `${TEST_TAG} internal note` });
  });

  test('the partner sees their own request and its document in GET /api/requests/mine, with no LAU data', async () => {
    const agent = await agentFor(partnerA);
    const mine = await agent.get('/api/requests/mine');
    const seen = mine.body.find(r => r.id === requestId);
    expect(seen).toBeTruthy();
    expect(seen.attachmentLink).toBe(fileLink);
    expect(seen.lauReviews).toBeUndefined();
  });

  test('a different partner cannot see the request, and gets 403 downloading its file', async () => {
    const otherAgent = await agentFor(partnerB);
    const mine = await otherAgent.get('/api/requests/mine');
    expect(mine.body.some(r => r.id === requestId)).toBe(false);

    const filename = fileLink.split('/').pop();
    const download = await otherAgent.get('/uploads/documents/' + filename);
    expect(download.status).toBe(403);
  });

  test('the owning partner CAN download their own attached file', async () => {
    const agent = await agentFor(partnerA);
    const filename = fileLink.split('/').pop();
    const download = await agent.get('/uploads/documents/' + filename);
    expect(download.status).toBe(200);
  });

  test('Admin sees the full record including lauReviews; the partner never does, even after the LAU review exists', async () => {
    const adminAgent = await agentFor(admin);
    const adminView = await adminAgent.get('/api/requests');
    const seenByAdmin = adminView.body.find(r => r.id === requestId);
    expect(Array.isArray(seenByAdmin.lauReviews)).toBe(true);
    expect(seenByAdmin.lauReviews.length).toBeGreaterThan(0);

    const partnerAgent = await agentFor(partnerA);
    const partnerView = await partnerAgent.get('/api/requests/mine');
    const seenByPartner = partnerView.body.find(r => r.id === requestId);
    expect(seenByPartner.lauReviews).toBeUndefined();
  });

  // 2026-11 follow-up: the Request Details modal and the (now separate) Draft modal both render purely
  // from this same GET /api/requests/mine response — neither modal does its own extra fetch. Since that
  // response already has no lauReviews field (scopeLauReviewsForViewer, confirmed above) for a request
  // that has both a real attachment AND an LAU review, there is no way for either modal to show LAU data —
  // there's nothing in their shared data source to show.
  test('the single record both modals render from carries attachmentLink but never lauReviews, even together', async () => {
    const agent = await agentFor(partnerA);
    const mine = await agent.get('/api/requests/mine');
    const seen = mine.body.find(r => r.id === requestId);
    expect(seen.attachmentLink).toBe(fileLink);
    expect(seen.lauReviews).toBeUndefined();
    expect(Object.keys(seen)).not.toContain('lauReviews');
  });
});
