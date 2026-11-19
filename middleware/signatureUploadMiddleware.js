const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

// One organization-wide asset (the Head of CIRL's e-signature) — a dedicated, small-limit upload
// middleware rather than reusing uploadMiddleware.js's PDF/DOCX-capable 10MB one. Kept out of
// uploads/documents (the Document Library's own tree) and never statically served (see
// services/signatureService.js) — the image only ever reaches a client inside a generated PDF/print
// view, or as a base64 data URI in the signature-settings JSON response.
const SIGNATURE_DIR = path.join(__dirname, '..', 'uploads', 'signatures');
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png']);
const ALLOWED_EXT = new Set(['.jpg', '.jpeg', '.png']);

if (!fs.existsSync(SIGNATURE_DIR)) fs.mkdirSync(SIGNATURE_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, SIGNATURE_DIR),
  filename: (req, file, cb) => {
    // Every upload gets its own never-reused filename — replacing or removing the "current" signature
    // never touches an older file, so a Document Request completed under an earlier signature keeps
    // rendering it (see signatureFileIdAtCompletion in cirl.js).
    const unique = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${path.extname(file.originalname).toLowerCase()}`;
    cb(null, unique);
  }
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (!ALLOWED_MIME.has(file.mimetype) || !ALLOWED_EXT.has(ext)) {
    const err = new Error('Unsupported file type. Only PNG and JPG are accepted.');
    err.clientSafe = true;
    return cb(err);
  }
  cb(null, true);
}

module.exports = multer({ storage, fileFilter, limits: { fileSize: MAX_FILE_SIZE } });
module.exports.SIGNATURE_DIR = SIGNATURE_DIR;
module.exports.MAX_FILE_SIZE = MAX_FILE_SIZE;
