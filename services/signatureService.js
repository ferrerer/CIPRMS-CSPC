const fs = require('fs');
const path = require('path');
const { SIGNATURE_DIR } = require('../middleware/signatureUploadMiddleware');

// Single current-signature record, keyed by a fixed _id so get/save/remove is always exactly one
// document — no per-user records, since this is the one organization-wide Head-of-CIRL signature.
const CURRENT_ID = 'current';

function signatureFilePath(fileId) {
  return path.join(SIGNATURE_DIR, fileId);
}

async function getCurrentSignature(db) {
  return db.collection('headsignature').findOne({ _id: CURRENT_ID });
}

async function saveSignature(db, { fileId, mimetype, uploadedBy, uploadedByEmail }) {
  const uploadedAt = new Date().toISOString();
  await db.collection('headsignature').updateOne(
    { _id: CURRENT_ID },
    { $set: { fileId, mimetype, uploadedBy, uploadedByEmail, uploadedAt } },
    { upsert: true }
  );
  return getCurrentSignature(db);
}

async function removeSignature(db) {
  // The physical file is deliberately left on disk — any Document Request already Completed under it
  // references this exact fileId via signatureFileIdAtCompletion and must keep rendering it.
  await db.collection('headsignature').deleteOne({ _id: CURRENT_ID });
}

// Resolves the actual signature file to draw for ONE Document Request — always the fileId snapshotted
// at the moment it became Completed (never the org's current signature, which may have since been
// replaced or removed). Returns null (render with no signature, not a crash) if nothing was snapshotted
// or that file no longer exists on disk.
function resolveSignatureFileForRequest(r) {
  if (!r || !r.signatureFileIdAtCompletion) return null;
  const p = signatureFilePath(r.signatureFileIdAtCompletion);
  return fs.existsSync(p) ? p : null;
}

module.exports = { signatureFilePath, getCurrentSignature, saveSignature, removeSignature, resolveSignatureFileForRequest };
