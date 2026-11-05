// OCR pipeline safe-error-response fix (2026-11 Phase 3). Root cause: three raw err.message leaks outside
// cirl.js, the only file Phase 1's safe-error-response pass covered:
//   - services/ocrService.js's runJob() catch block stored err.message directly as the job's `error` field,
//     with no console.error at all — the real failure (a Tesseract/sharp/PDF-parsing exception) was both
//     leaked to the client (GET /api/ocr/status/:jobId returns job.error verbatim) and undiagnosable
//     server-side afterward.
//   - controllers/ocrController.js's confirm() catch block did `error: err.message || '...'` — since a real
//     Error always has a message, this almost always leaked the raw failure from ocrService.confirmJob().
//   - routes/ocrRoutes.js's multer wrapper echoed err.message for ANY non-MulterError, not just the one
//     deliberate, clientSafe-flagged "unsupported file type" validation error multer's fileFilter can throw.
//
// No MongoDB connection anywhere in this file — startJob()/getJob() never touch the database (confirmed by,
// and following the same established pattern as, test/ocr-temp-file-cleanup.test.js), and the controller/
// route tests mock ocrService entirely. Satisfies Phase 3's "no writes to the production database" rule
// without needing an isolated test database at all.
jest.setTimeout(60000); // same precedent as the sibling test/ocr-temp-file-cleanup.test.js — real OCR-pipeline polling

const request = require('supertest');
const express = require('express');
const fs = require('fs');
const path = require('path');
const os = require('os');

describe('services/ocrService.js: a real processing failure never reaches the client as a raw exception', () => {
  let ocrService, corruptFile;

  beforeAll(() => {
    ocrService = require('../services/ocrService');
    corruptFile = path.join(os.tmpdir(), `ciprms-ocr-corrupt-test-${Date.now()}.png`);
    // Deliberately invalid image bytes with a .png extension — sharp() validates the header and rejects
    // this fast (no real OCR ever runs), a realistic stand-in for "a file that makes the pipeline throw"
    // without needing minutes of real Tesseract time to reach the failure.
    fs.writeFileSync(corruptFile, Buffer.from('this is not a real png file, just garbage bytes'));
  });

  afterAll(() => {
    try { fs.rmSync(corruptFile, { force: true }); } catch (_) { /* best-effort */ }
  });

  test('a corrupt upload reaches status "error" with a safe, generic message — never the raw library exception', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const jobId = ocrService.startJob(corruptFile, 'image/png', { originalName: 'corrupt.png' });

      const deadline = Date.now() + 20000;
      let job = null;
      do {
        job = ocrService.getJob(jobId);
        if (job && (job.status === 'done' || job.status === 'error')) break;
        await new Promise(r => setTimeout(r, 100));
      } while (Date.now() < deadline);

      expect(job).not.toBeNull();
      expect(job.status).toBe('error'); // confirms the corrupt file genuinely failed processing, proving this test exercises the real catch block
      expect(job.error).toBe('OCR processing failed. Please try again.');
      // Never a raw library message — sharp/Tesseract exceptions for invalid input mention the library,
      // a byte offset, or a format name; none of that belongs in a client-facing message.
      expect(job.error).not.toMatch(/sharp|libvips|Tesseract|ENOENT|Input buffer|at Object\.<anonymous>|node_modules[\\/]/i);

      // The real error was not thrown away — it's still available server-side for diagnosis.
      expect(errorSpy).toHaveBeenCalled();
      const logged = errorSpy.mock.calls.flat().map(String).join(' ');
      expect(logged).toContain('OCR job failed');
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// controllers/ocrController.js confirm()'s own safe-error-response fix is covered in a separate file,
// test/ocr-confirm-error-safety.test.js — jest.mock('../services/ocrService') hoists to the top of whatever
// file it's written in, which would otherwise auto-mock ocrService for the real-pipeline test above too.

describe('routes/ocrRoutes.js multer wrapper: only the deliberate clientSafe validation message is ever echoed', () => {
  test('a clientSafe error (the real "unsupported file type" case) still reaches the client as-is', async () => {
    jest.resetModules();
    jest.doMock('../middleware/uploadMiddleware', () => {
      const clientSafeErr = new Error('Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.');
      clientSafeErr.clientSafe = true;
      // routes/ocrRoutes.js calls .fields([...]) (2026-11 multi-photo upload), not .single() — the mock
      // must match whichever multer method the route actually calls.
      return { fields: () => (req, res, cb) => cb(clientSafeErr), UPLOAD_DIR: '/tmp' };
    });
    jest.doMock('../middleware/verifyMagicBytes', () => () => true);
    jest.doMock('../controllers/ocrController', () => ({ extract: jest.fn(), status: jest.fn(), confirm: jest.fn(), discard: jest.fn() }));
    const ocrRoutes = require('../routes/ocrRoutes');
    const app = express();
    app.use('/api/ocr', ocrRoutes);

    const res = await request(app).post('/api/ocr/extract');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.');
    jest.dontMock('../middleware/uploadMiddleware');
    jest.dontMock('../middleware/verifyMagicBytes');
    jest.dontMock('../controllers/ocrController');
  });

  test('an unexpected, non-clientSafe error is genericized, not echoed raw', async () => {
    jest.resetModules();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.doMock('../middleware/uploadMiddleware', () => {
      // A realistic unexpected failure multer/busboy could surface that is NOT the deliberate
      // fileFilter validation error — e.g. a filesystem problem — with no clientSafe flag.
      const rawErr = new Error('EACCES: permission denied, open \'/uploads/tmp/x\'');
      // routes/ocrRoutes.js calls .fields([...]) (2026-11 multi-photo upload), not .single().
      return { fields: () => (req, res, cb) => cb(rawErr), UPLOAD_DIR: '/tmp' };
    });
    jest.doMock('../middleware/verifyMagicBytes', () => () => true);
    jest.doMock('../controllers/ocrController', () => ({ extract: jest.fn(), status: jest.fn(), confirm: jest.fn(), discard: jest.fn() }));
    const ocrRoutes = require('../routes/ocrRoutes');
    const app = express();
    app.use('/api/ocr', ocrRoutes);

    try {
      const res = await request(app).post('/api/ocr/extract');
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Upload failed. Please try again.');
      expect(res.body.error).not.toMatch(/EACCES|permission denied/i);
      expect(errorSpy).toHaveBeenCalled();
    } finally {
      errorSpy.mockRestore();
      jest.dontMock('../middleware/uploadMiddleware');
      jest.dontMock('../middleware/verifyMagicBytes');
      jest.dontMock('../controllers/ocrController');
    }
  });
});
