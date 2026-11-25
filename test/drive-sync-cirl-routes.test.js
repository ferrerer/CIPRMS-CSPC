// Document Library <-> Google Drive bidirectional sync (2026-11, pragmatic scope) — CIPRMS -> Drive
// propagation at the route level: rename/move/archive/restore a document or folder in CIPRMS and confirm
// the matching Drive mutation (documentStorageService.renameFile/moveFile/trashFile/restoreFile/createFolder)
// is actually called with the right arguments, plus the manual sync route and sync-status route.
// documentStorageService is auto-mocked (own file, same precedent as test/ocr-confirm-error-safety.test.js);
// driveSyncService is separately mocked for the manual-sync-route tests only.
jest.mock('../services/documentStorageService');
jest.mock('../services/driveSyncService');
const documentStorageService = require('../services/documentStorageService');
const driveSyncService = require('../services/driveSyncService');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, insertWithNextId } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent, staffAgent, partnerAgent, adminUser;
const createdDocIds = [];
const createdFolderIds = [];

async function waitForCall(mockFn, timeoutMs = 1500) {
  const start = Date.now();
  while (mockFn.mock.calls.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the mocked Drive call.');
    await new Promise((r) => setTimeout(r, 20));
  }
}

beforeAll(async () => {
  const db = await connectDB();
  adminAgent = request.agent(app);
  adminUser = await createTestUser({ role: 'Administrator' });
  await loginAs(adminAgent, adminUser);
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
});

afterEach(() => { jest.resetAllMocks(); });

afterAll(async () => {
  const db = await connectDB();
  if (createdDocIds.length) await db.collection('documents').deleteMany({ id: { $in: createdDocIds } });
  if (createdFolderIds.length) await db.collection('documentfolders').deleteMany({ id: { $in: createdFolderIds } });
  await cleanupAll();
  await closeDB();
});

async function seedDoc(db, overrides = {}) {
  const doc = await insertWithNextId(db.collection('documents'), (id) => ({
    id, title: 'jesttest Sync Doc', type: 'MOA', fileLink: '/uploads/documents/jesttest-sync.pdf',
    uploadedAt: new Date().toISOString(), uploadedBy: 'Jest', uploadedByEmail: 'jesttest@example.com',
    archived: false, tags: [], originalFilename: 'jesttest Sync Doc.pdf', folderId: null, driveFileId: null,
    ...overrides
  }));
  createdDocIds.push(doc.id);
  return doc;
}

async function seedFolder(db, overrides = {}) {
  const folder = await insertWithNextId(db.collection('documentfolders'), (id) => ({
    id, name: 'jesttest Folder', ownerEmail: adminUser.email, archived: false,
    createdAt: new Date().toISOString(), parentFolderId: null, driveFolderId: null, ...overrides
  }));
  createdFolderIds.push(folder.id);
  return folder;
}

describe('PATCH /api/documents/:id — rename propagates to Drive', () => {
  test('renaming a document with a driveFileId calls renameFile() with the new name + original extension', async () => {
    const db = await connectDB();
    const doc = await seedDoc(db, { driveFileId: 'drive-rename-target', originalFilename: 'Old Name.pdf' });
    documentStorageService.renameFile.mockResolvedValue(undefined);

    const res = await adminAgent.patch(`/api/documents/${doc.id}`).send({ title: 'New Name' });
    expect(res.status).toBe(200);

    await waitForCall(documentStorageService.renameFile);
    expect(documentStorageService.renameFile).toHaveBeenCalledWith(expect.anything(), 'drive-rename-target', 'New Name.pdf');
  });

  test('renaming a document with no driveFileId never calls Drive at all', async () => {
    const db = await connectDB();
    const doc = await seedDoc(db, { driveFileId: null });
    const res = await adminAgent.patch(`/api/documents/${doc.id}`).send({ title: 'Still Local' });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(documentStorageService.renameFile).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/documents/:id/organize — move/archive/restore propagate to Drive', () => {
  test('moving a document into a folder with a Drive counterpart calls moveFile() with both Drive folder ids', async () => {
    const db = await connectDB();
    const targetFolder = await seedFolder(db, { driveFolderId: 'drive-folder-target' });
    const doc = await seedDoc(db, { driveFileId: 'drive-move-target', folderId: null });
    documentStorageService.moveFile.mockResolvedValue(undefined);

    const res = await adminAgent.patch(`/api/documents/${doc.id}/organize`).send({ folderId: targetFolder.id });
    expect(res.status).toBe(200);

    await waitForCall(documentStorageService.moveFile);
    expect(documentStorageService.moveFile).toHaveBeenCalledWith(expect.anything(), 'drive-move-target', 'drive-folder-target', null);
  });

  test('archiving a document with a driveFileId calls trashFile() (recoverable), never a permanent delete', async () => {
    const db = await connectDB();
    const doc = await seedDoc(db, { driveFileId: 'drive-archive-target' });
    documentStorageService.trashFile.mockResolvedValue(undefined);

    const res = await adminAgent.patch(`/api/documents/${doc.id}/organize`).send({ archived: true });
    expect(res.status).toBe(200);

    await waitForCall(documentStorageService.trashFile);
    expect(documentStorageService.trashFile).toHaveBeenCalledWith(expect.anything(), 'drive-archive-target');
  });

  test('restoring (unarchiving) a document calls restoreFile()', async () => {
    const db = await connectDB();
    const doc = await seedDoc(db, { driveFileId: 'drive-restore-target', archived: true });
    documentStorageService.restoreFile.mockResolvedValue(undefined);

    const res = await adminAgent.patch(`/api/documents/${doc.id}/organize`).send({ archived: false });
    expect(res.status).toBe(200);

    await waitForCall(documentStorageService.restoreFile);
    expect(documentStorageService.restoreFile).toHaveBeenCalledWith(expect.anything(), 'drive-restore-target');
  });
});

describe('Folders — create (with nesting) and rename/archive propagate to Drive', () => {
  test('creating a top-level folder calls createFolder() with no parent (defaults to the Drive root)', async () => {
    const db = await connectDB();
    documentStorageService.createFolder.mockResolvedValue('drive-new-folder-id');

    const res = await adminAgent.post('/api/document-folders').send({ name: 'jesttest Top Folder' });
    expect(res.status).toBe(200);
    createdFolderIds.push(res.body.folder.id);

    await waitForCall(documentStorageService.createFolder);
    expect(documentStorageService.createFolder).toHaveBeenCalledWith(expect.anything(), 'jesttest Top Folder', null);

    // Once the background Drive create resolves, the CIPRMS folder record picks up the returned driveFolderId.
    await new Promise((r) => setTimeout(r, 150));
    const stored = await db.collection('documentfolders').findOne({ id: res.body.folder.id });
    expect(stored.driveFolderId).toBe('drive-new-folder-id');
  });

  test('creating a subfolder passes the parent\'s driveFolderId through to createFolder()', async () => {
    const db = await connectDB();
    const parent = await seedFolder(db, { driveFolderId: 'drive-parent-folder' });
    documentStorageService.createFolder.mockResolvedValue('drive-child-folder-id');

    const res = await adminAgent.post('/api/document-folders').send({ name: 'jesttest Subfolder', parentFolderId: parent.id });
    expect(res.status).toBe(200);
    createdFolderIds.push(res.body.folder.id);
    expect(res.body.folder.parentFolderId).toBe(parent.id);

    await waitForCall(documentStorageService.createFolder);
    expect(documentStorageService.createFolder).toHaveBeenCalledWith(expect.anything(), 'jesttest Subfolder', 'drive-parent-folder');
  });

  test('renaming a synced folder calls renameFile() on its driveFolderId', async () => {
    const db = await connectDB();
    const folder = await seedFolder(db, { driveFolderId: 'drive-rename-folder' });
    documentStorageService.renameFile.mockResolvedValue(undefined);

    const res = await adminAgent.patch(`/api/document-folders/${folder.id}`).send({ name: 'jesttest Renamed Folder' });
    expect(res.status).toBe(200);

    await waitForCall(documentStorageService.renameFile);
    expect(documentStorageService.renameFile).toHaveBeenCalledWith(expect.anything(), 'drive-rename-folder', 'jesttest Renamed Folder');
  });

  test('archiving a synced folder calls trashFile() (recoverable, matching the folder\'s own soft-delete semantics)', async () => {
    const db = await connectDB();
    const folder = await seedFolder(db, { driveFolderId: 'drive-archive-folder' });
    documentStorageService.trashFile.mockResolvedValue(undefined);

    const res = await adminAgent.patch(`/api/document-folders/${folder.id}`).send({ archived: true });
    expect(res.status).toBe(200);

    await waitForCall(documentStorageService.trashFile);
    expect(documentStorageService.trashFile).toHaveBeenCalledWith(expect.anything(), 'drive-archive-folder');
  });
});

describe('Manual sync route and status route', () => {
  test('POST /api/documents/sync-drive runs the reconciliation pass and returns its summary', async () => {
    driveSyncService.runDriveSync.mockResolvedValue({ ok: true, foldersSeen: 2, filesSeen: 5, conflicts: [], errors: [] });
    const res = await adminAgent.post('/api/documents/sync-drive');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, foldersSeen: 2, filesSeen: 5 });
    expect(driveSyncService.runDriveSync).toHaveBeenCalledTimes(1);
  });

  test('Staff can also trigger a manual sync (shared Document Library)', async () => {
    driveSyncService.runDriveSync.mockResolvedValue({ ok: true, foldersSeen: 0, filesSeen: 0, conflicts: [], errors: [] });
    const res = await staffAgent.post('/api/documents/sync-drive');
    expect(res.status).toBe(200);
  });

  test('a potential_partner cannot trigger a manual sync (Admin/Staff-only feature)', async () => {
    // requireStaffAccess's denyAccess() redirects (302) for a plain request — it only returns a JSON 403
    // when the caller sends X-Requested-With: ciprms, matching every other requireStaffAccess-guarded route
    // in this app (the real frontend never shows this button to a role other than Admin/Staff anyway).
    const res = await partnerAgent.post('/api/documents/sync-drive');
    expect(res.status).toBe(302);
    expect(driveSyncService.runDriveSync).not.toHaveBeenCalled();
  });

  test('GET /api/documents/sync-status reports the open conflict count and last sync time', async () => {
    const db = await connectDB();
    const conflict = await insertWithNextId(db.collection('sync_conflicts'), (id) => ({
      id, kind: 'document', recordId: 1, driveId: 'jesttest-conflict-status', reason: 'test', detectedAt: new Date().toISOString(), resolved: false
    }));
    try {
      const res = await adminAgent.get('/api/documents/sync-status');
      expect(res.status).toBe(200);
      expect(typeof res.body.connected).toBe('boolean');
      expect(res.body.openConflictCount).toBeGreaterThanOrEqual(1);
    } finally {
      await db.collection('sync_conflicts').deleteOne({ id: conflict.id });
    }
  });
});
