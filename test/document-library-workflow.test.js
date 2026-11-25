// Covers the 2026-07-28 request-workflow/Document Library task:
// - Submitted Partnership/Document Requests auto-copy into the submitter's
//   own Document Library (Auth. Personnel and potential_partner only).
// - New personal folders (create/rename/archive) and document organize
//   (move to folder / archive) routes, both ownership-checked per user.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let personnelAgent, partnerAgent, adminAgent, otherPartnerAgent;
let createdRequestIds = [];
let createdDocRequestIds = [];
let createdFolderIds = [];

beforeAll(async () => {
  await connectDB();
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
  otherPartnerAgent = request.agent(app);
  await loginAs(otherPartnerAgent, await createTestUser({ role: 'potential_partner' }));
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
});

afterAll(async () => {
  const db = await connectDB();
  if (createdRequestIds.length) {
    await db.collection('requests').deleteMany({ id: { $in: createdRequestIds } });
    await db.collection('documents').deleteMany({ requestType: 'partnership', requestId: { $in: createdRequestIds } });
  }
  if (createdDocRequestIds.length) {
    await db.collection('documentrequests').deleteMany({ id: { $in: createdDocRequestIds } });
    await db.collection('documents').deleteMany({ requestType: 'document', requestId: { $in: createdDocRequestIds } });
  }
  if (createdFolderIds.length) await db.collection('documentfolders').deleteMany({ id: { $in: createdFolderIds } });
  await cleanupAll();
  await closeDB();
});

// College Dean (stored role "Auth. Personnel") no longer has a Partnership Request workflow — the API refuses it (403), so
// there is nothing to archive. (It used to be accepted here; see denyCollegeStaffPartnershipRequests in cirl.js.)
test('College Dean can no longer submit a Partnership Request, so nothing is archived for one', async () => {
  const res = await personnelAgent.post('/api/requests').send({
    institution: 'Jest DocLib University', country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest'
  });
  expect(res.status).toBe(403);
  const libRes = await personnelAgent.get('/api/documents/mine');
  expect(libRes.body.some(d => d.requestType === 'partnership')).toBe(false);
});

test('Auto-archive: a Partnership Request submitted by potential_partner copies into their own Document Library', async () => {
  const res = await partnerAgent.post('/api/requests').send({
    institution: 'Jest DocLib Partner University', country: 'Testland', type: 'MOU', nature: 'Research', notes: 'jesttest'
  });
  expect(res.status).toBe(200);
  createdRequestIds.push(res.body.request.id);

  const libRes = await partnerAgent.get('/api/documents/mine');
  const entry = libRes.body.find(d => d.requestType === 'partnership' && d.requestId === res.body.request.id);
  expect(entry).toBeTruthy();
});

test('Auto-archive: a Document Request submitted by either role copies into their own Document Library, linked to the printable form', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentType: 'MOU', notes: 'jesttest purpose'
  });
  expect(res.status).toBe(200);
  createdDocRequestIds.push(res.body.request.id);

  const libRes = await personnelAgent.get('/api/documents/mine');
  const entry = libRes.body.find(d => d.requestType === 'document' && d.requestId === res.body.request.id);
  expect(entry).toBeTruthy();
  expect(entry.fileLink).toBe(`/document-requests/${res.body.request.id}/print`);
});

test('Auto-archive is scoped to Auth. Personnel/potential_partner only — an Administrator submitting a request does not get one', async () => {
  const res = await adminAgent.post('/api/requests').send({
    institution: 'Jest DocLib Admin University', country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest'
  });
  expect(res.status).toBe(200);
  createdRequestIds.push(res.body.request.id);

  const libRes = await adminAgent.get('/api/documents/mine');
  const entry = libRes.body.find(d => d.requestType === 'partnership' && d.requestId === res.body.request.id);
  expect(entry).toBeUndefined();
});

test('Auto-archive is skipped when a Partnership Request already has an OCR-attached document (no duplicate library entry)', async () => {
  const res = await partnerAgent.post('/api/requests').send({
    institution: 'Jest DocLib Attached University', country: 'Testland', type: 'MOA', nature: 'Research',
    notes: 'jesttest', attachmentLink: '/uploads/documents/does-not-matter-for-this-test.pdf'
  });
  expect(res.status).toBe(200);
  createdRequestIds.push(res.body.request.id);

  const libRes = await partnerAgent.get('/api/documents/mine');
  const entries = libRes.body.filter(d => d.requestType === 'partnership' && d.requestId === res.body.request.id);
  expect(entries.length).toBe(0);
});

test('Document folders: create, list (own-scoped), rename, and archive', async () => {
  const createRes = await partnerAgent.post('/api/document-folders').send({ name: 'Jest Folder A' });
  expect(createRes.status).toBe(200);
  const folderId = createRes.body.folder.id;
  createdFolderIds.push(folderId);

  const mineRes = await partnerAgent.get('/api/document-folders/mine');
  expect(mineRes.body.some(f => f.id === folderId)).toBe(true);

  const otherMineRes = await otherPartnerAgent.get('/api/document-folders/mine');
  expect(otherMineRes.body.some(f => f.id === folderId)).toBe(false);

  const renameRes = await partnerAgent.patch('/api/document-folders/' + folderId).send({ name: 'Jest Folder A Renamed' });
  expect(renameRes.status).toBe(200);
  expect(renameRes.body.folder.name).toBe('Jest Folder A Renamed');

  const archiveRes = await partnerAgent.patch('/api/document-folders/' + folderId).send({ archived: true });
  expect(archiveRes.status).toBe(200);
  expect(archiveRes.body.folder.archived).toBe(true);
});

test('Document folders: a user cannot rename or archive another user\'s folder', async () => {
  const createRes = await partnerAgent.post('/api/document-folders').send({ name: 'Jest Folder B' });
  const folderId = createRes.body.folder.id;
  createdFolderIds.push(folderId);

  const patchRes = await otherPartnerAgent.patch('/api/document-folders/' + folderId).send({ name: 'Hijacked' });
  expect(patchRes.status).toBe(403);

  const check = await partnerAgent.get('/api/document-folders/mine');
  expect(check.body.find(f => f.id === folderId).name).toBe('Jest Folder B');
});

test('Document organize: an owner can move their own document into a folder and archive it', async () => {
  const reqRes = await partnerAgent.post('/api/document-requests').send({
    institution: 'CCS', documentType: 'MOA', notes: 'jesttest organize'
  });
  createdDocRequestIds.push(reqRes.body.request.id);
  const libRes = await partnerAgent.get('/api/documents/mine');
  const doc = libRes.body.find(d => d.requestType === 'document' && d.requestId === reqRes.body.request.id);
  expect(doc).toBeTruthy();

  const folderRes = await partnerAgent.post('/api/document-folders').send({ name: 'Jest Folder C' });
  createdFolderIds.push(folderRes.body.folder.id);

  const moveRes = await partnerAgent.patch(`/api/documents/${doc.id}/organize`).send({ folderId: folderRes.body.folder.id });
  expect(moveRes.status).toBe(200);
  expect(moveRes.body.document.folderId).toBe(folderRes.body.folder.id);

  const archiveRes = await partnerAgent.patch(`/api/documents/${doc.id}/organize`).send({ archived: true });
  expect(archiveRes.status).toBe(200);
  expect(archiveRes.body.document.archived).toBe(true);
});

test('Document organize: a user cannot move or archive another user\'s document', async () => {
  const reqRes = await partnerAgent.post('/api/document-requests').send({
    institution: 'CCS', documentType: 'MOA', notes: 'jesttest ownership'
  });
  createdDocRequestIds.push(reqRes.body.request.id);
  const libRes = await partnerAgent.get('/api/documents/mine');
  const doc = libRes.body.find(d => d.requestType === 'document' && d.requestId === reqRes.body.request.id);

  const moveRes = await otherPartnerAgent.patch(`/api/documents/${doc.id}/organize`).send({ folderId: null });
  expect(moveRes.status).toBe(403);

  const archiveRes = await otherPartnerAgent.patch(`/api/documents/${doc.id}/organize`).send({ archived: true });
  expect(archiveRes.status).toBe(403);
});

// 2026-11 Document Library repair — Administrator/Staff share ONE Document Library (OWN_SCOPE_ROLES
// excludes both), so most documents an Administrator views were uploaded by someone else entirely. The
// organize route's ownership check used to 403 that unconditionally; this mirrors DELETE /api/documents/:id's
// own pre-existing owner-or-Administrator exception.
test('Document organize: an Administrator CAN move/archive/restore a document uploaded by someone else (shared library)', async () => {
  const reqRes = await partnerAgent.post('/api/document-requests').send({
    institution: 'CCS', documentType: 'MOA', notes: 'jesttest admin-organize-shared'
  });
  createdDocRequestIds.push(reqRes.body.request.id);
  const libRes = await partnerAgent.get('/api/documents/mine');
  const sharedDoc = libRes.body.find(d => d.requestType === 'document' && d.requestId === reqRes.body.request.id);
  expect(sharedDoc).toBeTruthy(); // uploaded by partnerAgent's own test account, not adminAgent's — a genuinely shared-library case

  const archiveRes = await adminAgent.patch(`/api/documents/${sharedDoc.id}/organize`).send({ archived: true });
  expect(archiveRes.status).toBe(200);
  expect(archiveRes.body.document.archived).toBe(true);

  const restoreRes = await adminAgent.patch(`/api/documents/${sharedDoc.id}/organize`).send({ archived: false });
  expect(restoreRes.status).toBe(200);
  expect(restoreRes.body.document.archived).toBe(false);
});

// Staff keeps the pre-existing own-uploads-only restriction — same asymmetry DELETE already has
// (Administrator bypasses ownership, Staff does not). This is NOT a regression: Staff's rights are
// unchanged by the fix above, only Administrator's are.
test('Document organize: Staff still cannot move/archive another user\'s document (restriction preserved)', async () => {
  const staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));

  const reqRes = await partnerAgent.post('/api/document-requests').send({
    institution: 'CCS', documentType: 'MOA', notes: 'jesttest staff-organize-restricted'
  });
  createdDocRequestIds.push(reqRes.body.request.id);
  const libRes = await partnerAgent.get('/api/documents/mine');
  const sharedDoc = libRes.body.find(d => d.requestType === 'document' && d.requestId === reqRes.body.request.id);

  const archiveRes = await staffAgent.patch(`/api/documents/${sharedDoc.id}/organize`).send({ archived: true });
  expect(archiveRes.status).toBe(403);
});

test('Document folders and organize routes require a session', async () => {
  expect((await request(app).get('/api/document-folders/mine')).status).toBe(302);
  expect((await request(app).post('/api/document-folders').send({ name: 'nope' })).status).toBe(302);
});

// 2026-08-27 View-Only → Staff migration: Staff joined requireUploader (own-
// scoped Document Library access, like Auth. Personnel/potential_partner) —
// every real role is now uploader-eligible, so this confirms Staff's own
// folder routes work rather than testing an "ineligible role" example that
// no longer exists.
test('Staff can use its own Document Library folder routes (requireUploader now includes Staff)', async () => {
  const staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  expect((await staffAgent.get('/api/document-folders/mine')).status).toBe(200);
  const createRes = await staffAgent.post('/api/document-folders').send({ name: 'jesttest Staff Folder' });
  expect(createRes.status).toBe(200);
  expect(createRes.body.success).toBe(true);
  createdFolderIds.push(createRes.body.folder.id);
});
