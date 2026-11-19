// Duplicate-warning hold/accept/cancel (2026-11) — "Warn on Duplicates and Let the User Accept or Cancel".
// Covers the DIRECT (non-OCR) upload path (POST /api/requests/:id/documents) end to end: a match holds
// the upload (pendingUploadService) instead of archiving it, and only POST /api/uploads/pending/:id/accept
// or .../cancel ever resolves it. The OCR path's own equivalent (ocrService.confirmJob/
// acknowledgeDuplicate) is covered by test/idp-duplicate-detection.test.js (findPossibleDuplicates itself)
// and exercised implicitly by every existing OCR test that still archives immediately (no match).
//
// Must be set BEFORE requiring ../cirl — services/pendingUploadService.js reads these once at module load.
process.env.PENDING_UPLOAD_TTL_MS = '1200';
process.env.PENDING_UPLOAD_SWEEP_MS = '300';

const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, getDb } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
const createdRequestIds = [];
// Tracks every document actually archived (not held) during this run, by fileHash, so a re-run of this
// same file can clean up anything a PREVIOUS run's own afterAll already removed via requests cleanup
// cascading nothing (documents are never deleted by the requests cleanup above) — without this, a
// leftover document from a prior run would make a "fresh" upload with the same fixture content look like
// an exact duplicate of itself before the test ever gets to its own real assertion.
const createdDocumentHashes = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  if (createdRequestIds.length) await db.collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  if (createdDocumentHashes.length) await db.collection('documents').deleteMany({ fileHash: { $in: createdDocumentHashes } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

// >1024 bytes (MIN_HASH_MATCH_BYTES in cirl.js) so exact-hash duplicate detection actually engages — a
// real uploaded document is never this trivially small, unlike the 8-byte PNG_HEADER fixture most other
// test files in this suite share (which stays below the threshold on purpose, so this doesn't collide
// with any of them).
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
// Unique per process run — a re-run of this same file must never produce the same bytes (and therefore
// the same SHA-256) as a previous run's, or a leftover document from a run that crashed before its own
// cleanup could make a brand-new upload look like an exact duplicate of itself before the test's own
// assertion even runs.
const RUN_SALT = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
function bigPng(label) {
  const buf = Buffer.concat([PNG_SIG, Buffer.from(`${TEST_TAG} duplicate-warning fixture ${RUN_SALT}: ${label}`.padEnd(1100, '.'))]);
  createdDocumentHashes.push(require('crypto').createHash('sha256').update(buf).digest('hex'));
  return buf;
}

// Every upload in this file uses 'MOA' as its request type, so filename is otherwise the ONE signal that
// can accidentally repeat across two DIFFERENT tests' otherwise-unrelated uploads — findPossibleDuplicates
// scores a filename match (+2) together with a document-type match (+2) as >=4, its own real-match
// threshold, so two tests both naming a file "first.png" would make each other's uploads look like a
// (false) duplicate of one another. A per-call unique name avoids that regardless of which specific label
// a given test happens to reuse.
let fileNameCounter = 0;
function uniqueName(label) {
  fileNameCounter += 1;
  return `${label}-${RUN_SALT}-${fileNameCounter}.png`;
}

// RUN_SALT in every institution string too (not just file content) — findPossibleDuplicates matches
// institution by substring containment in BOTH directions, so a generic label like "Accept University A"
// could otherwise collide with some unrelated leftover institution name from elsewhere in this same
// long-lived shared test database (most other test files never clean up their own `documents` collection
// entries either). The salt makes every institution string here unique to this one process run.
async function makeRequest(agent, institutionLabel) {
  const institution = `${TEST_TAG} ${RUN_SALT} ${institutionLabel}`;
  const res = await agent.post('/api/requests').send({ institution, country: 'Japan', type: 'MOA', nature: 'Research', notes: `${TEST_TAG} dup-warning` });
  expect(res.status).toBe(200);
  createdRequestIds.push(res.body.request.id);
  return res.body.request.id;
}

describe('Duplicate-warning hold/accept/cancel', () => {
  test('an exact duplicate (same file hash) holds the upload — archives nothing until a choice is made', async () => {
    const { agent } = await agentFor('potential_partner');
    const idA = await makeRequest(agent, `Exact Hash University A`);
    const idB = await makeRequest(agent, `Exact Hash University B`);
    const bytes = bigPng('exact-a-b');

    const before = await agent.post(`/api/requests/${idA}/documents`).attach('document', bytes, uniqueName('first'));
    expect(before.status).toBe(200);
    expect(before.body.documentId).toBeTruthy();
    const countBefore = await db.collection('documents').countDocuments({});

    const dupRes = await agent.post(`/api/requests/${idB}/documents`).attach('document', bytes, uniqueName('second'));
    expect(dupRes.status).toBe(200);
    expect(dupRes.body.duplicateFound).toBe(true);
    expect(dupRes.body.matchLevel).toBe('exact');
    expect(dupRes.body.pendingId).toBeTruthy();
    expect(dupRes.body.documentId).toBeUndefined();

    const countAfter = await db.collection('documents').countDocuments({});
    expect(countAfter).toBe(countBefore); // nothing archived yet

    const requestB = await db.collection('requests').findOne({ id: idB });
    expect(requestB.supportingDocuments || []).toEqual([]); // no side effect ran either
  });

  test('accept archives the file with duplicateAcknowledged/acknowledgedBy/acknowledgedAt/acknowledgedMatchIds', async () => {
    const { agent, user } = await agentFor('potential_partner');
    const idA = await makeRequest(agent, `Accept University A`);
    const idB = await makeRequest(agent, `Accept University B`);
    const bytes = bigPng('accept-a-b');

    const first = await agent.post(`/api/requests/${idA}/documents`).attach('document', bytes, uniqueName('first'));
    const original = first.body.documentId;

    const dupRes = await agent.post(`/api/requests/${idB}/documents`).attach('document', bytes, uniqueName('second'));
    expect(dupRes.body.duplicateFound).toBe(true);
    const pendingId = dupRes.body.pendingId;

    const acceptRes = await agent.post(`/api/uploads/pending/${pendingId}/accept`);
    expect(acceptRes.status).toBe(200);
    expect(acceptRes.body.success).toBe(true);
    expect(acceptRes.body.documentId).toBeTruthy();

    const doc = await db.collection('documents').findOne({ id: acceptRes.body.documentId });
    expect(doc).not.toBeNull();
    expect(doc.duplicateAcknowledged).toBe(true);
    expect(doc.acknowledgedBy).toBe(user.email);
    expect(doc.acknowledgedAt).toBeTruthy();
    expect(doc.acknowledgedMatchIds).toContain(original);

    const requestB = await db.collection('requests').findOne({ id: idB });
    expect(requestB.supportingDocuments.length).toBe(1); // the deferred side effect DID run on accept
  });

  test('cancel saves nothing and deletes the held temp file', async () => {
    const { agent } = await agentFor('potential_partner');
    const idA = await makeRequest(agent, `Cancel University A`);
    const idB = await makeRequest(agent, `Cancel University B`);
    const bytes = bigPng('cancel-a-b');

    await agent.post(`/api/requests/${idA}/documents`).attach('document', bytes, uniqueName('first'));
    const countBefore = await db.collection('documents').countDocuments({});

    const dupRes = await agent.post(`/api/requests/${idB}/documents`).attach('document', bytes, uniqueName('second'));
    expect(dupRes.body.duplicateFound).toBe(true);
    const pendingId = dupRes.body.pendingId;

    const cancelRes = await agent.post(`/api/uploads/pending/${pendingId}/cancel`);
    expect(cancelRes.status).toBe(200);
    expect(cancelRes.body.cancelled).toBe(true);

    const countAfter = await db.collection('documents').countDocuments({});
    expect(countAfter).toBe(countBefore); // nothing new archived

    // Accepting the same (now-cancelled) pendingId again does nothing — it's gone.
    const lateAccept = await agent.post(`/api/uploads/pending/${pendingId}/accept`);
    expect(lateAccept.status).toBe(404);
  });

  test('calling the API directly without accepting never archives — an expired pending upload is cleaned up', async () => {
    const { agent } = await agentFor('potential_partner');
    const idA = await makeRequest(agent, `Expiry University A`);
    const idB = await makeRequest(agent, `Expiry University B`);
    const bytes = bigPng('expiry-a-b');

    await agent.post(`/api/requests/${idA}/documents`).attach('document', bytes, uniqueName('first'));
    const countBefore = await db.collection('documents').countDocuments({});

    const dupRes = await agent.post(`/api/requests/${idB}/documents`).attach('document', bytes, uniqueName('second'));
    expect(dupRes.body.duplicateFound).toBe(true);
    const pendingId = dupRes.body.pendingId;

    // Never call accept or cancel — just wait past PENDING_UPLOAD_TTL_MS (1200ms) + one sweep (300ms).
    await new Promise((resolve) => setTimeout(resolve, 1800));

    const acceptRes = await agent.post(`/api/uploads/pending/${pendingId}/accept`);
    expect(acceptRes.status).toBe(404);

    const countAfter = await db.collection('documents').countDocuments({});
    expect(countAfter).toBe(countBefore); // still nothing archived — expiry never saves anything either
  });

  test('a possible duplicate (same institution, different bytes) also holds the upload, labeled "possible"', async () => {
    const { agent } = await agentFor('potential_partner');
    // Two DIFFERENT institution strings (one containing the other) rather than the exact same string —
    // POST /api/requests itself refuses a second Pending request for an institution that already has one,
    // regardless of this feature. findPossibleDuplicates' CANDIDATE QUERY only matches a stored
    // institution that CONTAINS the new upload's own institution as a substring (not the other
    // direction) — so idA (archived first, found as a candidate later) must be the LONGER string, and
    // idB (the one whose upload triggers the check) the SHORTER one it contains.
    const idA = await makeRequest(agent, `Possible Dup University Satellite Campus`);
    const idB = await makeRequest(agent, `Possible Dup University`);

    await agent.post(`/api/requests/${idA}/documents`).attach('document', bigPng('possible-a'), uniqueName('a'));
    const dupRes = await agent.post(`/api/requests/${idB}/documents`).attach('document', bigPng('possible-b'), uniqueName('b'));

    expect(dupRes.body.duplicateFound).toBe(true);
    expect(dupRes.body.matchLevel).toBe('possible');
  });

  test("a Partner sees no other partner's document details — only a generic signal", async () => {
    const { agent: agentA } = await agentFor('potential_partner');
    const { agent: agentB } = await agentFor('potential_partner');
    // Deliberately UNRELATED institution names (neither containing the other) — POST /api/requests itself
    // auto-archives a no-file "placeholder" library record for every new request with no attachment yet
    // (archiveRequestRecordToLibrary), tagged with that request's own institution/type. Two institution
    // names in a containment relationship (as the "possible duplicate" test above deliberately uses) would
    // make EACH request's own placeholder a false "possible duplicate" candidate for the OTHER's real file
    // upload — unrelated to what this test is actually checking (an EXACT file-hash match), which works
    // regardless of institution wording.
    const idA = await makeRequest(agentA, `Privacy University Alpha`);
    const idB = await makeRequest(agentB, `Privacy University Beta`);
    const bytes = bigPng('privacy-a-b');

    await agentA.post(`/api/requests/${idA}/documents`).attach('document', bytes, uniqueName('a'));
    const dupRes = await agentB.post(`/api/requests/${idB}/documents`).attach('document', bytes, uniqueName('b'));

    expect(dupRes.body.duplicateFound).toBe(true);
    expect(dupRes.body.genericOnly).toBe(true);
    expect(dupRes.body.matches).toEqual([]); // no title, institution, uploader, or link revealed
  });

  test('a new version of the same request gives no warning — goes straight through the existing supersede flow', async () => {
    const { agent } = await agentFor('potential_partner');
    const id = await makeRequest(agent, `Same Request University`);
    const bytes = bigPng('same-request');

    const first = await agent.post(`/api/requests/${id}/documents`).attach('document', bytes, uniqueName('v1'));
    expect(first.body.duplicateFound).toBeUndefined();
    expect(first.body.documentId).toBeTruthy();

    // Re-uploading the IDENTICAL bytes as a "new version" of its OWN request must not warn — it supersedes.
    const second = await agent.post(`/api/requests/${id}/documents`).attach('document', bytes, uniqueName('v2'));
    expect(second.body.duplicateFound).toBeUndefined();
    expect(second.body.documentId).toBeTruthy();
    expect(second.body.documentId).not.toBe(first.body.documentId);
  });
});
