// Google Drive integration repair (2026-11) — root cause: cirl.js's two file-serving routes
// (GET /uploads/documents/:filename, GET /uploads/achievements/:filename) collapsed EVERY Drive failure —
// a real 404, a permission error, an expired/invalid-grant token, a timeout, anything — into a blanket
// `res.status(404).send('Not found')`. This file proves the new classification (googleDocsService's
// classifyGoogleError, consumed by documentStorageService) actually distinguishes these cases, and that
// documentStorageService's own functions (ensureFolder/downloadDocument) tag the cases they uniquely know
// about (not_connected, folder_error) rather than leaving everything to message-pattern guessing.
//
// Only getAuthorizedDrive is mocked (a fake Drive API client) — integrationCollection/classifyGoogleError/
// describeGoogleError all run for real against the real (test-only, see test/setup-env.js's
// GOOGLE_DOCS_INTEGRATION_COLLECTION override) jesttest_googleDocsIntegration collection, so this also
// exercises ensureFolder's actual persistence logic, not just a mocked return value.
jest.mock('../services/googleDocsService', () => {
  const actual = jest.requireActual('../services/googleDocsService');
  return { ...actual, getAuthorizedDrive: jest.fn() };
});
const googleDocsService = require('../services/googleDocsService');
const documentStorageService = require('../services/documentStorageService');
const { connectDB, closeDB } = require('../db');

describe('classifyGoogleError() — pure classification, no network', () => {
  test('explicit driveErrorCategory on the error wins over any message/code inference', () => {
    const err = new Error('irrelevant message');
    err.driveErrorCategory = 'not_connected';
    const result = googleDocsService.classifyGoogleError(err);
    expect(result).toMatchObject({ category: 'not_connected', httpStatus: 503 });
  });

  test('HTTP 404 from the Drive client -> not_found (covers both "deleted" and "never shared with this account")', () => {
    const err = new Error('File not found: abc123.');
    err.code = 404;
    expect(googleDocsService.classifyGoogleError(err)).toMatchObject({ category: 'not_found', httpStatus: 404 });
  });

  test('HTTP 403 -> forbidden', () => {
    const err = new Error('The user does not have sufficient permissions for this file.');
    err.code = 403;
    expect(googleDocsService.classifyGoogleError(err)).toMatchObject({ category: 'forbidden', httpStatus: 403 });
  });

  test('invalid_grant (revoked/expired authorization) -> auth_expired', () => {
    const err = new Error('invalid_grant: Token has been expired or revoked.');
    expect(googleDocsService.classifyGoogleError(err)).toMatchObject({ category: 'auth_expired', httpStatus: 503 });
  });

  test('a stored-token decrypt failure -> auth_expired, same as describeGoogleError\'s own pattern', () => {
    const err = new Error('Unsupported state or unable to authenticate data');
    expect(googleDocsService.classifyGoogleError(err)).toMatchObject({ category: 'auth_expired', httpStatus: 503 });
  });

  test('a configured timeout abort -> timeout', () => {
    const err = new Error('This operation was aborted due to timeout');
    err.name = 'TimeoutError';
    expect(googleDocsService.classifyGoogleError(err)).toMatchObject({ category: 'timeout', httpStatus: 504 });
  });

  test('anything else unrecognized -> api_error (never thrown past this, never exposes the raw message)', () => {
    const err = new Error('Internal error encountered.');
    const result = googleDocsService.classifyGoogleError(err);
    expect(result).toMatchObject({ category: 'api_error', httpStatus: 502 });
    expect(result.publicMessage).not.toMatch(/Internal error encountered/);
  });

  test('none of the public messages ever mention the encryption key or env var names (no internal details leaked)', () => {
    const categories = ['not_connected', 'auth_expired', 'folder_error', 'not_found', 'forbidden', 'timeout', 'api_error'];
    for (const cat of categories) {
      const err = new Error('x');
      err.driveErrorCategory = cat;
      const { publicMessage } = googleDocsService.classifyGoogleError(err);
      expect(publicMessage).not.toMatch(/GOOGLE_TOKEN_ENCRYPTION_KEY|GOOGLE_CLIENT_SECRET|refresh_token/i);
    }
  });
});

describe('documentStorageService — real ensureFolder/download/upload logic against a fake Drive client', () => {
  let db;
  let integrationId;

  beforeAll(async () => {
    db = await connectDB();
  });

  afterEach(async () => {
    googleDocsService.getAuthorizedDrive.mockReset();
    if (integrationId) {
      await db.collection('jesttest_googleDocsIntegration').deleteOne({ _id: integrationId });
      integrationId = null;
    }
  });

  afterAll(async () => { await closeDB(); });

  async function seedIntegration(extra = {}) {
    const result = await db.collection('jesttest_googleDocsIntegration').insertOne({
      connectedByEmail: 'jesttest@example.com', connectedAt: new Date().toISOString(), ...extra
    });
    integrationId = result.insertedId;
    return { _id: integrationId, connectedByEmail: 'jesttest@example.com', ...extra };
  }

  test('downloadDocument(): not connected at all throws a not_connected-tagged error (no Drive call attempted)', async () => {
    googleDocsService.getAuthorizedDrive.mockResolvedValue(null);
    let caught;
    try { await documentStorageService.downloadDocument(db, 'some-file-id'); } catch (err) { caught = err; }
    expect(caught).toBeTruthy();
    expect(googleDocsService.classifyGoogleError(caught)).toMatchObject({ category: 'not_connected', httpStatus: 503 });
  });

  test('downloadDocument(): success returns whatever the Drive client gives back', async () => {
    const fakeStream = { on: jest.fn(), pipe: jest.fn() };
    const filesGet = jest.fn().mockResolvedValue({ data: fakeStream });
    googleDocsService.getAuthorizedDrive.mockResolvedValue({ drive: { files: { get: filesGet } }, integration: await seedIntegration() });

    const result = await documentStorageService.downloadDocument(db, 'file-xyz');
    expect(result).toBe(fakeStream);
    expect(filesGet).toHaveBeenCalledWith({ fileId: 'file-xyz', alt: 'media' }, { responseType: 'stream' });
  });

  test('downloadDocument(): a Drive 404 propagates as a classifiable not_found error', async () => {
    const notFoundErr = Object.assign(new Error('File not found: file-gone.'), { code: 404 });
    const filesGet = jest.fn().mockRejectedValue(notFoundErr);
    googleDocsService.getAuthorizedDrive.mockResolvedValue({ drive: { files: { get: filesGet } }, integration: await seedIntegration() });

    await expect(documentStorageService.downloadDocument(db, 'file-gone')).rejects.toThrow('File not found');
  });

  test('uploadDocument(): success creates the folder once, persists documentLibraryFolderId, and returns the new file id', async () => {
    const integration = await seedIntegration();
    const filesGet = jest.fn().mockRejectedValue(new Error('not found')); // no stored folder yet -> falls to create
    const filesCreate = jest.fn()
      .mockResolvedValueOnce({ data: { id: 'new-folder-id' } }) // ensureFolder's create
      .mockResolvedValueOnce({ data: { id: 'new-file-id' } });  // the actual file create
    googleDocsService.getAuthorizedDrive.mockResolvedValue({ drive: { files: { get: filesGet, create: filesCreate } }, integration });

    const fileId = await documentStorageService.uploadDocument(db, Buffer.from('hello'), 'hello.pdf', 'application/pdf');
    expect(fileId).toBe('new-file-id');

    const persisted = await db.collection('jesttest_googleDocsIntegration').findOne({ _id: integration._id });
    expect(persisted.documentLibraryFolderId).toBe('new-folder-id');
  });

  test('uploadDocument(): folder creation failing (not just the validity check) throws a folder_error-tagged error, not a generic crash', async () => {
    const integration = await seedIntegration();
    const filesGet = jest.fn().mockRejectedValue(new Error('not found'));
    const createErr = new Error('The user does not have sufficient permissions for this file.');
    createErr.code = 403;
    const filesCreate = jest.fn().mockRejectedValue(createErr);
    googleDocsService.getAuthorizedDrive.mockResolvedValue({ drive: { files: { get: filesGet, create: filesCreate } }, integration });

    let caught;
    try {
      await documentStorageService.uploadDocument(db, Buffer.from('hello'), 'hello.pdf', 'application/pdf');
    } catch (err) { caught = err; }
    expect(caught).toBeTruthy();
    expect(caught.driveErrorCategory).toBe('folder_error');
    expect(googleDocsService.classifyGoogleError(caught)).toMatchObject({ category: 'folder_error', httpStatus: 503 });
  });

  test('uploadDocument(): a still-valid stored folder is reused without calling create again', async () => {
    const integration = await seedIntegration({ documentLibraryFolderId: 'existing-folder-id' });
    const filesGet = jest.fn().mockResolvedValue({ data: { id: 'existing-folder-id', trashed: false } });
    const filesCreate = jest.fn().mockResolvedValue({ data: { id: 'new-file-id' } });
    googleDocsService.getAuthorizedDrive.mockResolvedValue({ drive: { files: { get: filesGet, create: filesCreate } }, integration });

    const fileId = await documentStorageService.uploadDocument(db, Buffer.from('hello'), 'hello.pdf', 'application/pdf');
    expect(fileId).toBe('new-file-id');
    expect(filesCreate).toHaveBeenCalledTimes(1); // only the file create, not a second folder create
    expect(filesCreate.mock.calls[0][0].requestBody.parents).toEqual(['existing-folder-id']);
  });
});
