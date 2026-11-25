// Google Drive integration repair (2026-11) — route-level proof that GET /uploads/documents/:filename and
// GET /uploads/achievements/:filename no longer collapse every Drive failure into a blanket 404. The whole
// documentStorageService module is auto-mocked (own file — jest.mock is hoisted file-wide, see the same
// precedent/reasoning in test/ocr-confirm-error-safety.test.js), so each test controls exactly what
// downloadDocument()/classifyGoogleError() report, independent of any real Google API call.
const request = require('supertest');

jest.mock('../services/documentStorageService');
const documentStorageService = require('../services/documentStorageService');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { insertWithNextId } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent;
let doc;
let achievement;

beforeAll(async () => {
  const db = await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));

  doc = await insertWithNextId(db.collection('documents'), (id) => ({
    id, title: 'jesttest Drive-backed doc', type: 'MOA', fileLink: '/uploads/documents/jesttest-drive-doc.pdf',
    driveFileId: 'drive-file-jesttest-1', uploadedAt: new Date().toISOString(), uploadedBy: 'Jest', uploadedByEmail: 'jesttest@example.com',
    archived: false, tags: []
  }));

  achievement = await insertWithNextId(db.collection('achievements'), (id) => ({
    id, title: 'jesttest Drive-backed achievement', category: 'PQA', fileLink: '/uploads/achievements/jesttest-drive-ach.pdf',
    driveFileId: 'drive-file-jesttest-2', fileType: 'application/pdf', createdBy: 'Jest', createdByEmail: 'jesttest@example.com',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  }));
});

afterEach(() => { jest.resetAllMocks(); });

afterAll(async () => {
  const db = await connectDB();
  await db.collection('documents').deleteOne({ id: doc.id });
  await db.collection('achievements').deleteOne({ id: achievement.id });
  await cleanupAll();
  await closeDB();
});

// Real classifyGoogleError logic, reused directly so these tests assert the SAME mapping production code uses.
const { classifyGoogleError: realClassify } = jest.requireActual('../services/googleDocsService');

describe('GET /uploads/documents/:filename — Drive error classification reaches the response', () => {
  test('a file the connected account cannot see (Drive 404) responds 404 with a clear, non-generic message', async () => {
    const err = Object.assign(new Error('File not found: drive-file-jesttest-1.'), { code: 404 });
    documentStorageService.downloadDocument.mockRejectedValue(err);
    documentStorageService.classifyGoogleError.mockImplementation(realClassify);
    documentStorageService.describeGoogleError.mockReturnValue('File not found: drive-file-jesttest-1.');

    const res = await adminAgent.get('/uploads/documents/jesttest-drive-doc.pdf');
    expect(res.status).toBe(404);
    expect(res.text).toMatch(/isn't accessible with the currently connected Google account/);
    expect(res.text).not.toBe('Not found');
  });

  test('an expired/revoked connection (invalid_grant) responds 503, not 404', async () => {
    const err = new Error('invalid_grant: Token has been expired or revoked.');
    documentStorageService.downloadDocument.mockRejectedValue(err);
    documentStorageService.classifyGoogleError.mockImplementation(realClassify);
    documentStorageService.describeGoogleError.mockReturnValue('reauthorize message');

    const res = await adminAgent.get('/uploads/documents/jesttest-drive-doc.pdf');
    expect(res.status).toBe(503);
    expect(res.text).toMatch(/reauthorized/);
  });

  test('a timeout responds 504, not 404', async () => {
    const err = new Error('This operation was aborted due to timeout');
    err.name = 'TimeoutError';
    documentStorageService.downloadDocument.mockRejectedValue(err);
    documentStorageService.classifyGoogleError.mockImplementation(realClassify);
    documentStorageService.describeGoogleError.mockReturnValue('timeout message');

    const res = await adminAgent.get('/uploads/documents/jesttest-drive-doc.pdf');
    expect(res.status).toBe(504);
  });

  test('a successful download is unaffected by the new error-handling (regression check)', async () => {
    const { PassThrough } = require('stream');
    const stream = new PassThrough();
    documentStorageService.downloadDocument.mockResolvedValue(stream);
    process.nextTick(() => { stream.end('%PDF-1.4 fake content'); });

    const res = await adminAgent.get('/uploads/documents/jesttest-drive-doc.pdf');
    expect(res.status).toBe(200);
    // application/pdf isn't a text content-type supertest auto-parses into res.text, so it lands in res.body as a Buffer.
    expect(Buffer.from(res.body).toString()).toContain('%PDF-1.4 fake content');
  });
});

describe('GET /uploads/achievements/:filename — same classification applies', () => {
  test('a file not accessible to the connected account responds 404 with the clear message, not a bare "Not found"', async () => {
    const err = Object.assign(new Error('File not found: drive-file-jesttest-2.'), { code: 404 });
    documentStorageService.downloadDocument.mockRejectedValue(err);
    documentStorageService.classifyGoogleError.mockImplementation(realClassify);
    documentStorageService.describeGoogleError.mockReturnValue('File not found: drive-file-jesttest-2.');

    const res = await adminAgent.get('/uploads/achievements/jesttest-drive-ach.pdf');
    expect(res.status).toBe(404);
    expect(res.text).not.toBe('Not found');
  });
});
