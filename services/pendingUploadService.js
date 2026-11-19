// Pending-upload hold for duplicate warnings (2026-11) — for every upload path that archives to the
// Document Library WITHOUT going through the OCR job system (which already has its own 10-minute-TTL
// job store doubling as the pending-upload hold — see services/ocrService.js's confirmJob/JOB_TTL_MS):
// POST /api/requests/:id/documents, POST /api/document-requests/:id/documents, POST
// /api/college-requests/:id/reference-documents and .../documents. When findPossibleDuplicates matches
// something, the uploaded temp file is held here (never archived) along with a closure that knows how to
// finish archiving it later — the route itself is otherwise unaware of this module beyond calling
// hold()/resolve to it.
//
// In-memory only, same convention as services/downloadTokenService.js — fine for a single-instance
// deployment, and nothing here needs to survive a restart.
const fs = require('fs');
const crypto = require('crypto');

// Overridable the same way ocrService's JOB_TTL_MS is (OCR_JOB_TTL_MS) — lets a test exercise real expiry
// without actually waiting 10 minutes.
const PENDING_TTL_MS = Number(process.env.PENDING_UPLOAD_TTL_MS) || 10 * 60 * 1000;
const SWEEP_INTERVAL_MS = Number(process.env.PENDING_UPLOAD_SWEEP_MS) || 60 * 1000;

const pending = new Map(); // pendingId -> { tempFilePath, archive, uploadedByEmail, createdAt, expiresAt }

// `archive` is an async () => Promise<{documentId, fileLink}> closure the CALLER builds, capturing
// whatever that specific route needs to finish the job (archiveToDocumentLibrary's own args, plus any
// post-archive step like pushing into a request's supportingDocuments array) — this module never needs
// to know the shape of any particular route's side effects, only when to run it.
function hold({ tempFilePath, uploadedByEmail, archive }) {
  const pendingId = crypto.randomBytes(16).toString('hex');
  pending.set(pendingId, { tempFilePath, uploadedByEmail, archive, createdAt: Date.now(), expiresAt: Date.now() + PENDING_TTL_MS });
  return pendingId;
}

function peek(pendingId) {
  const entry = pending.get(pendingId);
  if (!entry) return null;
  if (entry.expiresAt < Date.now()) { cleanup(entry); pending.delete(pendingId); return null; }
  return entry;
}

function cleanup(entry) {
  if (entry.tempFilePath) fs.unlink(entry.tempFilePath, () => {});
}

// Accept ("Upload anyway"): runs the held archive closure and removes the hold. Returns null if the
// pendingId is unknown/expired (already cleaned up — nothing left to accept).
async function accept(pendingId) {
  const entry = peek(pendingId);
  if (!entry) return null;
  pending.delete(pendingId);
  return entry.archive();
}

// Cancel: deletes the temp file, creates no Document Library record, removes the hold. Returns false if
// the pendingId is unknown/expired (nothing to cancel — it's already gone).
function cancel(pendingId) {
  const entry = pending.get(pendingId);
  if (!entry) return false;
  pending.delete(pendingId);
  cleanup(entry);
  return true;
}

// Same sweep pattern as services/downloadTokenService.js — an abandoned hold (browser closed, user never
// came back) cleans up its own temp file once its TTL passes, instead of leaking it forever.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pending) {
    if (entry.expiresAt < now) { cleanup(entry); pending.delete(id); }
  }
}, SWEEP_INTERVAL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

module.exports = { hold, peek, accept, cancel };
