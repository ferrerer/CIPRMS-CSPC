// Google Drive bidirectional sync investigation (2026-11), Phase 2 — root cause: the file CIPRMS uploaded
// to Drive was always named after the generated on-disk filename ("<timestamp>-<hex>.<ext>", chosen only to
// avoid local filesystem collisions) instead of the user's real original filename, even though the
// ORIGINAL name was already stored correctly in MongoDB (documents.originalFilename) the whole time — so
// CIPRMS showed the right name and Drive showed the wrong one. Fixed at both of CIPRMS's two Drive-upload
// call sites (documentLibraryService.js's uploadToDriveInBackground, cirl.js's saveAchievementFile).
//
// uploadToDriveInBackground() only runs when `!process.env.JEST_WORKER_ID` (see archiveToDocumentLibrary's
// own comment), so — same pattern as test/email-delivery-real-path.test.js — it must be cleared for the
// duration of each test here, restored immediately after.
jest.mock('../services/documentStorageService');
const documentStorageService = require('../services/documentStorageService');
const { archiveToDocumentLibrary, DOCUMENTS_DIR } = require('../services/documentLibraryService');
const { connectDB, closeDB } = require('../db');
const fs = require('fs');
const path = require('path');

async function waitForMockCall(mockFn, timeoutMs = 2000) {
  const start = Date.now();
  while (mockFn.mock.calls.length === 0) {
    if (Date.now() - start > timeoutMs) throw new Error('Timed out waiting for the mocked uploadDocument() call.');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('Drive uploads preserve the original uploaded filename (not the generated on-disk name)', () => {
  let db;
  const createdDocIds = [];
  const tempFiles = [];

  beforeAll(async () => { db = await connectDB(); });
  afterEach(() => { jest.resetAllMocks(); });
  afterAll(async () => {
    if (createdDocIds.length) await db.collection('documents').deleteMany({ id: { $in: createdDocIds } });
    for (const f of tempFiles) { try { fs.unlinkSync(f); } catch {} }
    await closeDB();
  });

  test('a document with an ordinary original filename uploads to Drive under that same name', async () => {
    const tempPath = path.join(DOCUMENTS_DIR, `jesttest-temp-${Date.now()}.pdf`);
    fs.writeFileSync(tempPath, 'fake pdf bytes');
    tempFiles.push(tempPath);

    documentStorageService.uploadDocument.mockResolvedValue('mock-drive-file-id');
    documentStorageService.describeGoogleError.mockReturnValue('n/a');

    const savedWorkerId = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    let result;
    try {
      result = await archiveToDocumentLibrary(tempPath, '2026 Annual Report - CHED Region V.pdf', null, {
        uploadedBy: 'Jest', uploadedByEmail: 'jesttest@example.com'
      });
      createdDocIds.push(result.documentId);
      await waitForMockCall(documentStorageService.uploadDocument);
    } finally {
      if (savedWorkerId !== undefined) process.env.JEST_WORKER_ID = savedWorkerId;
    }

    expect(documentStorageService.uploadDocument).toHaveBeenCalledTimes(1);
    const [, , filenamePassedToDrive] = documentStorageService.uploadDocument.mock.calls[0];
    expect(filenamePassedToDrive).toBe('2026 Annual Report - CHED Region V.pdf');
    expect(filenamePassedToDrive).not.toMatch(/^\d{10,}-[0-9a-f]{12}\.pdf$/); // the old generated-name shape

    const doc = await db.collection('documents').findOne({ id: result.documentId });
    expect(doc.originalFilename).toBe('2026 Annual Report - CHED Region V.pdf');
  });

  test('a missing original name safely falls back to the generated name rather than passing undefined to Drive', async () => {
    const tempPath = path.join(DOCUMENTS_DIR, `jesttest-temp-${Date.now()}-b.pdf`);
    fs.writeFileSync(tempPath, 'fake pdf bytes');
    tempFiles.push(tempPath);

    documentStorageService.uploadDocument.mockResolvedValue('mock-drive-file-id-2');
    documentStorageService.describeGoogleError.mockReturnValue('n/a');

    const savedWorkerId = process.env.JEST_WORKER_ID;
    delete process.env.JEST_WORKER_ID;
    let result;
    try {
      result = await archiveToDocumentLibrary(tempPath, '', null, { uploadedBy: 'Jest', uploadedByEmail: 'jesttest@example.com' });
      createdDocIds.push(result.documentId);
      await waitForMockCall(documentStorageService.uploadDocument);
    } finally {
      if (savedWorkerId !== undefined) process.env.JEST_WORKER_ID = savedWorkerId;
    }

    const [, , filenamePassedToDrive] = documentStorageService.uploadDocument.mock.calls[0];
    expect(typeof filenamePassedToDrive).toBe('string');
    expect(filenamePassedToDrive.length).toBeGreaterThan(0);
  });
});
