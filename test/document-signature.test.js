// Head of CIRL E-Signature (2026-11) — "Applied Only When Completed".
// Covers: RBAC on /api/settings/signature (Administrator + Staff only), upload validation
// (magic bytes, size), the Completed-only gate on the printable form/PDF, and the
// snapshot-at-completion behavior (signatureFileIdAtCompletion) that keeps an already-Completed
// form showing the signature it was completed with even after the org signature is replaced or removed.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
function pngBuffer(label) {
  return Buffer.concat([PNG_SIG, Buffer.from(`jesttest signature fixture: ${label}`)]);
}

let db;
let adminAgent, staffAgent, personnelAgent, partnerAgent, lauAgent;
const requestIds = [];

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
  lauAgent = request.agent(app);
  await loginAs(lauAgent, await createTestUser({ role: 'LAU' }));
  // Clean slate — a previous crashed run (or another suite) must never leak a signature into this file's
  // "no signature uploaded yet" assertions.
  await db.collection('headsignature').deleteOne({ _id: 'current' });
});

afterAll(async () => {
  if (requestIds.length) await db.collection('documentrequests').deleteMany({ id: { $in: requestIds } });
  await db.collection('headsignature').deleteOne({ _id: 'current' });
  // 2026-11 audit fix: signature bytes now live in MongoDB (`signatureversions`), not on local disk —
  // every version this file's uploads created (one per upload across every test) is swept here.
  await db.collection('signatureversions').deleteMany({ uploadedByEmail: { $regex: 'jesttest', $options: 'i' } });
  await cleanupAll();
  await closeDB();
});

async function makeDocumentRequest(institution) {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution, documentTypes: ['jesttest MOA'], notes: 'jesttest purpose',
    contactNumber: '0917-000-0000', documentForm: 'Printed Copy'
  });
  expect(res.status).toBe(200);
  requestIds.push(res.body.request.id);
  return res.body.request.id;
}

async function completeRequest(id) {
  let last;
  for (const status of ['Preparing', 'Awaiting for Approval', 'Approved', 'Release', 'Completed']) {
    last = await adminAgent.patch(`/api/document-requests/${id}`).send({ status });
    expect(last.status).toBe(200);
  }
  return last.body;
}

// requireStaffAccess denies via the shared denyAccess() helper: a plain call gets redirected (302), and
// only a caller identifying itself as a script (X-Requested-With: ciprms — what views' own CIPRMS.api
// helper always sends) gets a JSON 401/403 — same convention as every other RBAC-gated route in this app
// (see test/lau-internal-review.test.js's identical note).
describe('RBAC on /api/settings/signature', () => {
  test('no session is rejected', async () => {
    const res = await request(app).get('/api/settings/signature').set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(401);
  });

  test('Auth. Personnel, potential_partner and LAU are rejected on every method', async () => {
    for (const agent of [personnelAgent, partnerAgent, lauAgent]) {
      expect((await agent.get('/api/settings/signature').set('X-Requested-With', 'ciprms')).status).toBe(403);
      expect((await agent.post('/api/settings/signature').set('X-Requested-With', 'ciprms').attach('signature', pngBuffer('x'), 'x.png')).status).toBe(403);
      expect((await agent.delete('/api/settings/signature').set('X-Requested-With', 'ciprms')).status).toBe(403);
    }
  });

  test('Administrator and Staff can both read the current signature', async () => {
    expect((await adminAgent.get('/api/settings/signature')).status).toBe(200);
    expect((await staffAgent.get('/api/settings/signature')).status).toBe(200);
  });
});

describe('Upload validation', () => {
  test('with no signature uploaded yet, GET reports hasSignature: false', async () => {
    const res = await adminAgent.get('/api/settings/signature');
    expect(res.status).toBe(200);
    expect(res.body.hasSignature).toBe(false);
  });

  test('rejects a renamed non-image file (magic bytes mismatch)', async () => {
    const res = await staffAgent.post('/api/settings/signature')
      .attach('signature', Buffer.from('not a real png'), 'fake.png');
    expect(res.status).toBe(400);
    const check = await adminAgent.get('/api/settings/signature');
    expect(check.body.hasSignature).toBe(false);
  });

  test('rejects an oversized file (>2MB)', async () => {
    const big = Buffer.concat([PNG_SIG, Buffer.alloc(2.1 * 1024 * 1024)]);
    const res = await staffAgent.post('/api/settings/signature').attach('signature', big, 'big.png');
    expect(res.status).toBe(400);
  });

  test('Staff can upload a valid signature; GET then reports it with uploader metadata', async () => {
    const res = await staffAgent.post('/api/settings/signature')
      .attach('signature', pngBuffer('v1'), 'v1.png');
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const check = await adminAgent.get('/api/settings/signature');
    expect(check.body.hasSignature).toBe(true);
    expect(check.body.uploadedBy).toMatch(/^jesttest/);
    expect(check.body.dataUri).toMatch(/^data:image\/png;base64,/);
  });
});

describe('Applied only when Completed, with a frozen snapshot', () => {
  test('Received/Preparing/Approved: the print view and PDF have no signature image', async () => {
    const id = await makeDocumentRequest('jesttest Signature Office A');
    let printRes = await personnelAgent.get(`/document-requests/${id}/print`);
    expect(printRes.text).not.toContain('signature-image');

    await adminAgent.patch(`/api/document-requests/${id}`).send({ status: 'Preparing' });
    printRes = await personnelAgent.get(`/document-requests/${id}/print`);
    expect(printRes.text).not.toContain('signature-image');

    const imgRes = await adminAgent.get(`/api/document-requests/${id}/signature-image`);
    expect(imgRes.status).toBe(404);
  });

  test('Completed: the print view embeds the signature image route, and that route returns the image', async () => {
    const id = await makeDocumentRequest('jesttest Signature Office B');
    await completeRequest(id);

    const printRes = await personnelAgent.get(`/document-requests/${id}/print`);
    expect(printRes.text).toContain(`/api/document-requests/${id}/signature-image`);

    const imgRes = await adminAgent.get(`/api/document-requests/${id}/signature-image`).buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(imgRes.status).toBe(200);
    expect(imgRes.body.slice(0, 8)).toEqual(PNG_SIG);

    // The unrelated requester (owner) may fetch it too; an unrelated partner may not.
    const otherPartner = request.agent(app);
    await loginAs(otherPartner, await createTestUser({ role: 'potential_partner' }));
    expect((await otherPartner.get(`/api/document-requests/${id}/signature-image`)).status).toBe(403);
  });

  test('replacing the signature does not change an already-Completed form; a new completion uses the new one', async () => {
    const idOld = await makeDocumentRequest('jesttest Signature Office C-old');
    await completeRequest(idOld);
    const oldImg = await adminAgent.get(`/api/document-requests/${idOld}/signature-image`).buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });

    // Replace the org signature with a visibly different image.
    const replaceRes = await adminAgent.post('/api/settings/signature').attach('signature', pngBuffer('v2-replacement'), 'v2.png');
    expect(replaceRes.status).toBe(200);

    const idNew = await makeDocumentRequest('jesttest Signature Office C-new');
    await completeRequest(idNew);
    const newImg = await adminAgent.get(`/api/document-requests/${idNew}/signature-image`).buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });

    expect(oldImg.status).toBe(200);
    expect(newImg.status).toBe(200);
    expect(oldImg.body.equals(newImg.body)).toBe(false);

    // The old request, re-fetched AFTER the replace, still serves the ORIGINAL bytes.
    const oldImgAgain = await adminAgent.get(`/api/document-requests/${idOld}/signature-image`).buffer(true)
      .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
    expect(oldImgAgain.body.equals(oldImg.body)).toBe(true);
  });

  test('removing the signature: new completions warn and print blank; the old Completed form is unaffected', async () => {
    const survivorId = await makeDocumentRequest('jesttest Signature Office D-survivor');
    await completeRequest(survivorId);
    const survivorImgBefore = await adminAgent.get(`/api/document-requests/${survivorId}/signature-image`);
    expect(survivorImgBefore.status).toBe(200);

    const removeRes = await adminAgent.delete('/api/settings/signature');
    expect(removeRes.status).toBe(200);
    const check = await adminAgent.get('/api/settings/signature');
    expect(check.body.hasSignature).toBe(false);

    // The already-Completed survivor keeps showing its own snapshot, untouched by the removal.
    const survivorImgAfter = await adminAgent.get(`/api/document-requests/${survivorId}/signature-image`);
    expect(survivorImgAfter.status).toBe(200);

    const blankId = await makeDocumentRequest('jesttest Signature Office D-blank');
    const result = await completeRequest(blankId);
    expect(result.noSignatureWarning).toBe(true);
    const blankImg = await adminAgent.get(`/api/document-requests/${blankId}/signature-image`);
    expect(blankImg.status).toBe(404);

    const printRes = await personnelAgent.get(`/document-requests/${blankId}/print`);
    expect(printRes.status).toBe(200);
    expect(printRes.text).not.toContain('signature-image');
  });
});

// 2026-11 Batch 1 follow-up: ETag is derived from signatureFileIdAtCompletion, frozen the moment a
// request becomes Completed — so a cache based on it is exactly as safe as the snapshot guarantee
// already is (the bytes behind that fileId can never change again), and replacing the ORG's current
// signature afterward must NOT change an already-Completed request's own ETag (the opposite of the
// avatar case, where a new upload is SUPPOSED to invalidate the old URL/ETag).
describe('ETag / Cache-Control on the signature-image route', () => {
  // This describe block runs after one above that deliberately ends with no org signature on file —
  // every test here re-uploads its own, rather than depending on leftover state from earlier tests.
  beforeEach(async () => {
    const res = await adminAgent.post('/api/settings/signature').attach('signature', pngBuffer('etag-setup'), 'etag-setup.png');
    expect(res.status).toBe(200);
  });

  test('a matching If-None-Match gets a 304; Cache-Control/ETag are only set once Completed', async () => {
    const id = await makeDocumentRequest('jesttest Signature Office F-etag');
    const notYet = await adminAgent.get(`/api/document-requests/${id}/signature-image`);
    expect(notYet.status).toBe(404);
    expect(notYet.headers['cache-control']).toBe('no-store');
    expect(notYet.headers.etag).toBeFalsy();

    await completeRequest(id);
    const first = await adminAgent.get(`/api/document-requests/${id}/signature-image`);
    expect(first.status).toBe(200);
    const etag = first.headers.etag;
    expect(etag).toBeTruthy();
    expect(first.headers['cache-control']).toMatch(/private/);
    expect(first.headers['cache-control']).toMatch(/max-age=86400/);

    const second = await adminAgent.get(`/api/document-requests/${id}/signature-image`).set('If-None-Match', etag);
    expect(second.status).toBe(304);
  });

  test('replacing the org signature does not change an already-Completed request\'s own ETag; a new Completed request gets a different one', async () => {
    const oldId = await makeDocumentRequest('jesttest Signature Office G-etag-old');
    await completeRequest(oldId);
    const oldEtagBefore = (await adminAgent.get(`/api/document-requests/${oldId}/signature-image`)).headers.etag;

    const replaceRes = await adminAgent.post('/api/settings/signature').attach('signature', pngBuffer('etag-replacement'), 'etag-v2.png');
    expect(replaceRes.status).toBe(200);

    const oldEtagAfter = (await adminAgent.get(`/api/document-requests/${oldId}/signature-image`)).headers.etag;
    expect(oldEtagAfter).toBe(oldEtagBefore); // unchanged — this form's snapshot is frozen

    const newId = await makeDocumentRequest('jesttest Signature Office G-etag-new');
    await completeRequest(newId);
    const newEtag = (await adminAgent.get(`/api/document-requests/${newId}/signature-image`)).headers.etag;
    expect(newEtag).not.toBe(oldEtagBefore); // a different snapshot really is a different resource
  });
});

// 2026-11 audit fix (Critical/High #3): the signature image used to live only on local disk, which
// Render's free plan wipes on every redeploy — silently deleting the signature backing every
// already-Completed Document Request form. Bytes now live in MongoDB (signatureversions); this proves
// it by actually deleting the entire local uploads/signatures/ directory (test-only — never done
// outside this file) and confirming both the org signature and an already-Completed form's frozen
// snapshot keep working exactly as before.
describe('Survives local disk being wiped (e.g. a Render redeploy)', () => {
  const fs = require('fs');
  const path = require('path');
  const SIGNATURE_DIR = path.join(__dirname, '..', 'uploads', 'signatures');

  test('deleting uploads/signatures/ entirely does not affect the current signature or an already-Completed form', async () => {
    const id = await makeDocumentRequest('jesttest Signature Office E-disk-wipe');
    const uploadRes = await adminAgent.post('/api/settings/signature').attach('signature', pngBuffer('disk-wipe'), 'disk-wipe.png');
    expect(uploadRes.status).toBe(200);
    await completeRequest(id);

    // Simulate a Render redeploy wiping ephemeral local disk entirely.
    fs.rmSync(SIGNATURE_DIR, { recursive: true, force: true });
    try {
      const check = await adminAgent.get('/api/settings/signature');
      expect(check.status).toBe(200);
      expect(check.body.hasSignature).toBe(true);
      expect(check.body.dataUri).toMatch(/^data:image\/png;base64,/);

      const imgRes = await adminAgent.get(`/api/document-requests/${id}/signature-image`).buffer(true)
        .parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
      expect(imgRes.status).toBe(200);
      expect(imgRes.body.slice(0, 8)).toEqual(PNG_SIG);

      const printRes = await personnelAgent.get(`/document-requests/${id}/print`);
      expect(printRes.status).toBe(200);
      expect(printRes.text).toContain(`/api/document-requests/${id}/signature-image`);
    } finally {
      // Restore the directory AND its git-tracked .gitkeep — rmSync above deletes that file too, and
      // leaving it gone would show up as an unintended real deletion in git status after this suite runs.
      fs.mkdirSync(SIGNATURE_DIR, { recursive: true });
      fs.writeFileSync(path.join(SIGNATURE_DIR, '.gitkeep'), '');
    }
  });
});
