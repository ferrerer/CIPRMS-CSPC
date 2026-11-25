// Document Library <-> Google Drive bidirectional sync (2026-11, pragmatic scope). Tests the
// Drive -> CIPRMS reconciliation pass (services/driveSyncService.js's runDriveSync) against a fully mocked
// Drive client (no network) but a REAL local test database, so insertWithNextId/updateMany/findOne all run
// for real — the thing actually worth proving here is the upsert-by-stable-id, no-duplicate,
// archive-not-delete, and conflict-detection logic, not the Drive API call shape (already covered by
// test/google-drive-error-classification.test.js).
jest.mock('../services/documentStorageService', () => ({
  ...jest.requireActual('../services/documentStorageService'),
  getDriveContext: jest.fn()
}));
const documentStorageService = require('../services/documentStorageService');
const { runDriveSync } = require('../services/driveSyncService');
const { connectDB, closeDB } = require('../db');

const ROOT_ID = 'jesttest-root-folder';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// `state.tree` maps a Drive parent id -> array of its children (the shape files.list would return for that
// parent). Each test mutates `state.tree` between "runs" to simulate rename/move/trash/new-file changes in
// Drive, then calls runDriveSync() again.
function buildFakeDrive(state) {
  return {
    files: {
      list: jest.fn(async ({ q }) => {
        const m = q.match(/^'([^']+)' in parents/);
        const parentId = m ? m[1] : null;
        return { data: { files: state.tree[parentId] || [] } };
      })
    }
  };
}

describe('runDriveSync() — Drive -> CIPRMS reconciliation', () => {
  let db;
  const state = { tree: {} };

  beforeAll(async () => {
    db = await connectDB();
    documentStorageService.getDriveContext.mockImplementation(async () => ({ drive: buildFakeDrive(state), rootFolderId: ROOT_ID }));
  });

  afterEach(() => { documentStorageService.getDriveContext.mockClear(); });

  afterAll(async () => {
    await db.collection('documents').deleteMany({ fileLink: { $regex: '^/uploads/documents/drive-jesttest' } });
    await db.collection('documentfolders').deleteMany({ driveFolderId: { $regex: '^jesttest-' } });
    await db.collection('sync_conflicts').deleteMany({ driveId: { $regex: '^jesttest-' } });
    await closeDB();
  });

  test('not connected: returns a clean not_connected result, touches nothing', async () => {
    documentStorageService.getDriveContext.mockResolvedValueOnce(null);
    const result = await runDriveSync(db);
    expect(result).toEqual({ ok: false, reason: 'not_connected' });
  });

  test('first run: imports a new subfolder, a new file at root, a new file inside the subfolder, and skips a native Google Doc', async () => {
    state.tree = {
      [ROOT_ID]: [
        { id: 'jesttest-folder-agreements', name: 'Agreements', mimeType: FOLDER_MIME },
        { id: 'jesttest-file-report', name: 'Report.pdf', mimeType: 'application/pdf', modifiedTime: new Date().toISOString() },
        { id: 'jesttest-file-notes', name: 'Notes', mimeType: 'application/vnd.google-apps.document' }
      ],
      'jesttest-folder-agreements': [
        { id: 'jesttest-file-moa', name: 'MOA Draft.pdf', mimeType: 'application/pdf', modifiedTime: new Date().toISOString() }
      ]
    };

    const result = await runDriveSync(db);
    expect(result.ok).toBe(true);
    expect(result.foldersSeen).toBe(1);
    expect(result.filesSeen).toBe(2); // Report.pdf + MOA Draft.pdf — the native Google Doc is never counted as a file
    expect(result.errors).toEqual([]);

    const folder = await db.collection('documentfolders').findOne({ driveFolderId: 'jesttest-folder-agreements' });
    expect(folder).toBeTruthy();
    expect(folder.name).toBe('Agreements');
    expect(folder.parentFolderId).toBeNull();

    const report = await db.collection('documents').findOne({ driveFileId: 'jesttest-file-report' });
    expect(report.title).toBe('Report.pdf');
    expect(report.folderId).toBeNull();
    expect(report.importedFromDrive).toBe(true);
    expect(report.fileLink).toBe('/uploads/documents/drive-jesttest-file-report.pdf');

    const moa = await db.collection('documents').findOne({ driveFileId: 'jesttest-file-moa' });
    expect(moa.folderId).toBe(folder.id);

    const notes = await db.collection('documents').findOne({ driveFileId: 'jesttest-file-notes' });
    expect(notes).toBeNull(); // native Google Doc — never imported as a document record
  });

  test('second run with no Drive changes: no duplicate folders or documents are created', async () => {
    const beforeFolders = await db.collection('documentfolders').countDocuments({ driveFolderId: 'jesttest-folder-agreements' });
    const beforeDocs = await db.collection('documents').countDocuments({ driveFileId: { $in: ['jesttest-file-report', 'jesttest-file-moa'] } });

    await runDriveSync(db);

    const afterFolders = await db.collection('documentfolders').countDocuments({ driveFolderId: 'jesttest-folder-agreements' });
    const afterDocs = await db.collection('documents').countDocuments({ driveFileId: { $in: ['jesttest-file-report', 'jesttest-file-moa'] } });
    expect(afterFolders).toBe(beforeFolders);
    expect(afterDocs).toBe(beforeDocs);
    expect(beforeFolders).toBe(1);
    expect(beforeDocs).toBe(2);
  });

  test('a file renamed in Drive updates the existing CIPRMS record\'s title — never creates a second record', async () => {
    state.tree[ROOT_ID] = state.tree[ROOT_ID].map((f) =>
      f.id === 'jesttest-file-report' ? { ...f, name: 'Report Final.pdf' } : f
    );

    await runDriveSync(db);

    const matches = await db.collection('documents').find({ driveFileId: 'jesttest-file-report' }).toArray();
    expect(matches.length).toBe(1);
    expect(matches[0].title).toBe('Report Final.pdf');
    expect(matches[0].originalFilename).toBe('Report Final.pdf');
  });

  test('a file moved in Drive to a different folder updates the CIPRMS record\'s folderId', async () => {
    // Move jesttest-file-report from root into Agreements
    const reportEntry = state.tree[ROOT_ID].find((f) => f.id === 'jesttest-file-report');
    state.tree[ROOT_ID] = state.tree[ROOT_ID].filter((f) => f.id !== 'jesttest-file-report');
    state.tree['jesttest-folder-agreements'].push(reportEntry);

    await runDriveSync(db);

    const folder = await db.collection('documentfolders').findOne({ driveFolderId: 'jesttest-folder-agreements' });
    const report = await db.collection('documents').findOne({ driveFileId: 'jesttest-file-report' });
    expect(report.folderId).toBe(folder.id);
  });

  test('a file removed from Drive (trashed) is archived in CIPRMS, never deleted', async () => {
    state.tree['jesttest-folder-agreements'] = state.tree['jesttest-folder-agreements'].filter((f) => f.id !== 'jesttest-file-moa');

    await runDriveSync(db);

    const moa = await db.collection('documents').findOne({ driveFileId: 'jesttest-file-moa' });
    expect(moa).toBeTruthy(); // record still exists
    expect(moa.archived).toBe(true);
  });

  test('a folder removed from Drive is archived, and its already-imported contents stay archived too', async () => {
    delete state.tree['jesttest-folder-agreements'];
    state.tree[ROOT_ID] = state.tree[ROOT_ID].filter((f) => f.id !== 'jesttest-folder-agreements');

    await runDriveSync(db);

    const folder = await db.collection('documentfolders').findOne({ driveFolderId: 'jesttest-folder-agreements' });
    expect(folder.archived).toBe(true);
  });

  test('a genuine conflict (both sides changed) is recorded, not silently overwritten', async () => {
    // Fresh file: import it, then simulate a local CIPRMS edit after the sync timestamp, then change Drive's
    // name for the same file and sync again — this must produce a conflict record, not a silent overwrite.
    state.tree[ROOT_ID] = [
      ...state.tree[ROOT_ID],
      { id: 'jesttest-file-conflict', name: 'Original Name.pdf', mimeType: 'application/pdf', modifiedTime: new Date().toISOString() }
    ];
    await runDriveSync(db);
    const before = await db.collection('documents').findOne({ driveFileId: 'jesttest-file-conflict' });
    expect(before.title).toBe('Original Name.pdf');

    // Simulate "CIPRMS renamed it locally" after the last sync completed.
    await db.collection('documents').updateOne({ id: before.id }, { $set: { title: 'Locally Renamed.pdf', updatedLocallyAt: new Date(Date.now() + 1000).toISOString() } });

    // Drive, independently, also renamed it.
    state.tree[ROOT_ID] = state.tree[ROOT_ID].map((f) => f.id === 'jesttest-file-conflict' ? { ...f, name: 'Drive Renamed.pdf' } : f);

    const result = await runDriveSync(db);
    expect(result.conflicts.length).toBe(1);
    expect(result.conflicts[0].driveFileId).toBe('jesttest-file-conflict');

    const after = await db.collection('documents').findOne({ id: before.id });
    expect(after.title).toBe('Locally Renamed.pdf'); // neither side silently overwritten
    expect(after.syncStatus).toBe('conflict');

    const conflictRecord = await db.collection('sync_conflicts').findOne({ driveId: 'jesttest-file-conflict' });
    expect(conflictRecord).toBeTruthy();
    expect(conflictRecord.resolved).toBe(false);
  });
});
