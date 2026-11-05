const express = require('express');
const fs = require('fs');
const multer = require('multer');
const upload = require('../middleware/uploadMiddleware');
const verifyMagicBytes = require('../middleware/verifyMagicBytes');
const ocrController = require('../controllers/ocrController');

const router = express.Router();

// Max photos accepted in one multi-photo extraction (2026-11) — bounds the total request size
// deterministically at MAX_MULTI_PHOTOS * MAX_FILE_SIZE (10 * 10MB = 100MB worst case) without a separate
// aggregate-byte-size check, and is a generous ceiling for "one scanned document, one photo per page".
const MAX_MULTI_PHOTOS = 10;

// Wrapped manually (instead of `upload.single('document')` directly) so a
// rejected file type or an over-limit file returns a clean JSON 400 instead
// of falling through to Express's default HTML error page.
// 'document' (singular, maxCount 1) is the original field — every existing caller (Document Library
// single-file upload, potential_partner's Partnership Request OCR) keeps sending exactly that and is
// completely unaffected. 'documents' (plural, 2026-11) is new: the Document Library's multi-photo
// extraction appends one or more files under this field instead.
router.post('/extract', (req, res) => {
  upload.fields([{ name: 'document', maxCount: 1 }, { name: 'documents', maxCount: MAX_MULTI_PHOTOS }])(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      let message;
      if (err.code === 'LIMIT_FILE_SIZE') message = 'File is too large. Maximum size is 10MB per file.';
      else if (err.code === 'LIMIT_UNEXPECTED_FILE') message = `Too many photos selected. Maximum ${MAX_MULTI_PHOTOS} per extraction.`;
      else message = err.message;
      return res.status(400).json({ success: false, error: message });
    }
    if (err) {
      // clientSafe (middleware/uploadMiddleware.js's fileFilter): the one deliberate validation error this
      // can throw — any other, unexpected error here previously leaked err.message straight to the client.
      if (!err.clientSafe) console.error('❌ OCR upload error:', err);
      return res.status(400).json({ success: false, error: err.clientSafe ? err.message : 'Upload failed. Please try again.' });
    }
    // No real caller ever sends both fields — 'document' (single-file) and 'documents' (multi-photo) are
    // two different UI pickers, never submitted together. Reject this combination outright instead of
    // silently processing one and orphaning the other: ocrController.extract() prioritizes 'documents' when
    // both are present, which previously left the 'document' field's file on disk forever (2026-11 review
    // finding — confirmed live before this fix).
    if (req.files && req.files.document && req.files.document.length && req.files.documents && req.files.documents.length) {
      [...req.files.document, ...req.files.documents].forEach((f) => { if (f.path) fs.unlink(f.path, () => {}); });
      return res.status(400).json({ success: false, error: 'Send either one document or one or more photos, not both in the same request.' });
    }
    // Every file across both fields is validated — magic bytes are checked per file (requirement: validate
    // each image independently), but a mismatch on ANY one of them rejects the whole batch rather than
    // silently OCR'ing an incomplete document with no indication a page was dropped.
    const allFiles = [].concat((req.files && req.files.document) || [], (req.files && req.files.documents) || []);
    for (const f of allFiles) {
      if (!verifyMagicBytes(f)) {
        // verifyMagicBytes already deleted the bad file itself; clean up the rest of this batch too.
        allFiles.forEach((other) => { if (other.path && other !== f) fs.unlink(other.path, () => {}); });
        return res.status(400).json({ success: false, error: `"${f.originalname}" is not a valid file for its type. Only PDF, JPG, JPEG, and PNG are accepted.` });
      }
    }
    ocrController.extract(req, res);
  });
});

router.get('/status/:jobId', ocrController.status);

// POST /api/ocr/confirm — permanently archive a completed OCR job to the
// Document Library after the user explicitly reviews and confirms the upload.
// No file upload here — just JSON body with jobId and any user-edited fields.
router.post('/confirm', ocrController.confirm);

// POST /api/ocr/discard — clean up the temp file without creating any DB record.
// Called on modal close / "Discard" without saving.
router.post('/discard', ocrController.discard);

module.exports = router;
