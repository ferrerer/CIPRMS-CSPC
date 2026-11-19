const fs = require('fs');
const { DOCX_MIME } = require('./uploadMiddleware');

// multer's fileFilter only sees the client-controlled mimetype/extension
// before any bytes are read off the stream, so a renamed file (e.g. a script
// renamed to .png) passes fileFilter unchecked (S12, Roadmap v2 Phase G3,
// docs/SYSTEM_AUDIT_2026-07-16.md). This runs after the file is already saved
// to disk by multer's diskStorage and confirms its first bytes actually match
// a real magic number for the mimetype it claims — deleting the file and
// returning false if they don't.
const SIGNATURES = {
  'image/jpeg': [Buffer.from([0xFF, 0xD8, 0xFF])],
  'image/png': [Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])],
  'application/pdf': [Buffer.from('%PDF-', 'ascii')],
  // .docx is itself a ZIP archive — the local-file-header signature only proves "this is some ZIP file",
  // not "this is actually a Word document" (any renamed .zip/.xlsx/.pptx/.docm passes it too). The deeper
  // isValidDocx() check below is what actually distinguishes a real .docx.
  [DOCX_MIME]: [Buffer.from([0x50, 0x4B, 0x03, 0x04])]
};

// Zip-bomb guard (2026-11, lowered from 200MB to 50MB in follow-up review): a ZIP's central directory
// declares each entry's uncompressed size in its own header — read that instead of actually decompressing
// anything. A real .docx (even with embedded images) is nowhere near this; a crafted bomb claiming
// gigabytes while compressing to a few KB is rejected before mammoth (services/ocrService.js) ever has to
// decompress it.
const MAX_DOCX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;

// Minimal, dependency-free ZIP central-directory reader — just enough to answer "what entries does this
// zip contain, and how large is each one uncompressed", which is all isValidDocx() below needs. Returns
// null if the buffer doesn't have a well-formed End-Of-Central-Directory record (i.e. not really a zip,
// whatever its first 4 bytes claimed).
function readZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  const CD_SIG = 0x02014b50;
  const minStart = Math.max(0, buffer.length - 22 - 65535); // EOCD comment is at most 65535 bytes
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minStart; i--) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) return null;

  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  const entries = [];
  let pos = cdOffset;
  const end = Math.min(cdOffset + cdSize, buffer.length);
  while (pos + 46 <= end) {
    if (buffer.readUInt32LE(pos) !== CD_SIG) break;
    const uncompressedSize = buffer.readUInt32LE(pos + 24);
    const nameLen = buffer.readUInt16LE(pos + 28);
    const extraLen = buffer.readUInt16LE(pos + 30);
    const commentLen = buffer.readUInt16LE(pos + 32);
    const name = buffer.toString('utf8', pos + 46, pos + 46 + nameLen);
    entries.push({ name, uncompressedSize });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// Confirms the zip is actually a Word document: has word/document.xml (what every real .docx contains),
// has no vbaProject.bin (the macro-storage entry present in any macro-enabled Office file — .docx itself
// can't legally contain one, so this also catches a .docm simply renamed to .docx), and its total
// uncompressed size stays under the zip-bomb ceiling above.
function isValidDocx(buffer) {
  const entries = readZipEntries(buffer);
  if (!entries) return false;
  const names = entries.map((e) => e.name);
  if (!names.includes('word/document.xml')) return false;
  if (names.some((n) => /vbaProject\.bin$/i.test(n))) return false;
  const totalUncompressed = entries.reduce((sum, e) => sum + e.uncompressedSize, 0);
  if (totalUncompressed > MAX_DOCX_UNCOMPRESSED_BYTES) return false;
  return true;
}

function verifyMagicBytes(file) {
  const signatures = SIGNATURES[file.mimetype];
  if (!signatures) return false;
  const header = Buffer.alloc(8);
  const fd = fs.openSync(file.path, 'r');
  fs.readSync(fd, header, 0, 8, 0);
  fs.closeSync(fd);
  let matches = signatures.some((sig) => header.slice(0, sig.length).equals(sig));

  if (matches && file.mimetype === DOCX_MIME) {
    // The whole file, not just the header — already capped at 10MB by uploadMiddleware's own limit, so
    // reading it in full here is cheap, and the zip's central directory can be anywhere in the file.
    const buffer = fs.readFileSync(file.path);
    matches = isValidDocx(buffer);
  }

  if (!matches) fs.unlink(file.path, () => {});
  return matches;
}

module.exports = verifyMagicBytes;
