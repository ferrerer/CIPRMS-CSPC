const fs = require('fs');
const { Binary } = require('mongodb');

// Single current-signature record, keyed by a fixed _id so get/save/remove is always exactly one
// document — no per-user records, since this is the one organization-wide Head-of-CIRL signature.
const CURRENT_ID = 'current';

// 2026-11 audit fix (Critical/High #3): the image bytes themselves now live in MongoDB
// (`signatureversions`, one document per upload, keyed by the same never-reused fileId the upload
// route already generates), not on local disk — Render's free plan wipes local disk on every
// redeploy, which previously meant every production redeploy silently deleted the signature
// backing already-Completed Document Request forms. `headsignature` keeps the exact same shape as
// before (a pointer: {fileId, mimetype, uploadedBy, uploadedByEmail, uploadedAt}); only WHERE the
// bytes a fileId resolves to live has changed.

async function getCurrentSignature(db) {
  return db.collection('headsignature').findOne({ _id: CURRENT_ID });
}

// Returns { buffer, mimetype } for a given fileId, or null if it was never stored (shouldn't happen)
// or has been removed. Shared by resolveSignatureFileForRequest (a Document Request's own frozen
// snapshot) and the GET /api/settings/signature route (the org's current signature) below — one
// lookup implementation, two different fileId sources.
async function getSignatureBytes(db, fileId) {
  if (!fileId) return null;
  const version = await db.collection('signatureversions').findOne({ _id: fileId });
  if (!version || !version.data) return null;
  const buffer = Buffer.isBuffer(version.data) ? version.data : Buffer.from(version.data.buffer || version.data);
  return { buffer, mimetype: version.mimetype };
}

// `filePath` is the temp file multer just wrote and verifyMagicBytes already validated (unchanged
// upload path — see middleware/signatureUploadMiddleware.js) — read once into a Buffer, stored
// directly in MongoDB, and the temp file is then deleted: Mongo is the only persistent copy from
// this point on, so a redeploy wiping local disk can never lose it.
async function saveSignature(db, { fileId, filePath, mimetype, uploadedBy, uploadedByEmail }) {
  const data = fs.readFileSync(filePath);
  const uploadedAt = new Date().toISOString();
  await db.collection('signatureversions').insertOne({
    _id: fileId, data: new Binary(data), mimetype, uploadedBy, uploadedByEmail, uploadedAt
  });
  await db.collection('headsignature').updateOne(
    { _id: CURRENT_ID },
    { $set: { fileId, mimetype, uploadedBy, uploadedByEmail, uploadedAt } },
    { upsert: true }
  );
  fs.unlink(filePath, () => {}); // best-effort cleanup of our own transient temp file, not a stray left for someone else
  return getCurrentSignature(db);
}

async function removeSignature(db) {
  // The signatureversions document for this fileId is deliberately left in place — any Document
  // Request already Completed under it references this exact fileId via signatureFileIdAtCompletion
  // and must keep rendering it. Only the "current" pointer is cleared.
  await db.collection('headsignature').deleteOne({ _id: CURRENT_ID });
}

// Resolves the actual signature bytes to draw for ONE Document Request — always the fileId
// snapshotted at the moment it became Completed (never the org's current signature, which may have
// since been replaced or removed). Returns null (render with no signature, not a crash) if nothing
// was snapshotted or that version is missing.
async function resolveSignatureFileForRequest(db, r) {
  if (!r || !r.signatureFileIdAtCompletion) return null;
  return getSignatureBytes(db, r.signatureFileIdAtCompletion);
}

module.exports = { getCurrentSignature, getSignatureBytes, saveSignature, removeSignature, resolveSignatureFileForRequest };
