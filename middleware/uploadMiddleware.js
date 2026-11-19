const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const UPLOAD_DIR = path.join(__dirname, '..', 'uploads', 'tmp');
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

// DOCX (2026-11) — .docx only. verifyMagicBytes does the real work of telling a genuine Word document
// apart from any other ZIP-based Office format (including .docm, rejected below by extension before this
// even runs) renamed to .docx; this allow-list only gets the request past the first, cheap gate.
const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
const ALLOWED_MIME = new Set(['application/pdf', 'image/jpeg', 'image/png', DOCX_MIME]);
const ALLOWED_EXT = new Set(['.pdf', '.jpg', '.jpeg', '.png', '.docx']);

if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // timestamp + random suffix guarantees we never collide with / overwrite an existing upload
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, unique);
  }
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  // Legacy/macro-enabled Word formats get their own clear message instead of the generic one below —
  // rejected by extension alone (neither is in ALLOWED_EXT/ALLOWED_MIME, so they'd otherwise just fall
  // through to the generic "Unsupported file type" message). No LibreOffice (or other) converter is
  // installed on this deployment, so .doc is rejected rather than silently converted — see
  // services/ocrService.js's own comment on this same decision.
  if (ext === '.doc') {
    const err = new Error('Legacy .doc files are not supported. Please save as .docx and try again.');
    err.clientSafe = true;
    return cb(err);
  }
  if (ext === '.docm') {
    const err = new Error('Macro-enabled Word documents (.docm) are not supported. Please save as a plain .docx.');
    err.clientSafe = true;
    return cb(err);
  }
  if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
    // clientSafe: the route handler's upload-error callback (cirl.js) uses this flag to decide whether
    // err.message is safe to send to the client as-is — true only for this deliberate, user-facing
    // validation message, never for an unexpected disk/system error reaching the same callback.
    const err = new Error('Unsupported file type. Only PDF, JPG, JPEG, PNG, and DOCX are accepted.');
    err.clientSafe = true;
    return cb(err);
  }
  cb(null, true);
}

module.exports = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });
module.exports.UPLOAD_DIR = UPLOAD_DIR;
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
module.exports.DOCX_MIME = DOCX_MIME;
