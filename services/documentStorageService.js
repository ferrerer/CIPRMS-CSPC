// Document Library file storage via Google Drive (2026-11) — reuses the exact same connected-account
// OAuth plumbing as the Google Docs agreement-drafts feature (services/googleDocsService.js: same
// GOOGLE_CLIENT_ID/SECRET, same stored refresh token, same token-refresh/error-handling), just a second,
// separate Drive folder ("CIPRMS Document Library") holding generic uploaded files (scanned MOA/MOU PDFs,
// images) instead of Google Docs drafts.
//
// Why this exists: Render's free web-service plan wipes the app's local disk on every redeploy (see the
// comment on GET /uploads/documents/:filename in cirl.js) — a document OCR'd and archived today is gone
// the next time the app redeploys, even though its database record survives. Google Drive is reached over
// the same Google API client already used for Calendar/Docs, and its files persist independently of the
// app's own container lifecycle.
//
// Every function here returns/throws cleanly when Google Docs isn't connected — callers (documentLibraryService.js,
// cirl.js) are expected to fall back to local disk in that case, exactly as the app already behaved before
// this file existed. Nothing here is required for the app to run.
const { Readable } = require('stream');
const { getAuthorizedDrive, integrationCollection, describeGoogleError } = require('./googleDocsService');

const FOLDER_NAME = 'CIPRMS Document Library';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const FOLDER_FIELD = 'documentLibraryFolderId'; // separate from googleDocsService's own `folderId` (Agreement Drafts)

// Mirrors googleDocsService.js's own ensureFolder() — a sibling folder, created on first use, recreated if
// it was deleted in Drive. Kept as its own small function (not shared code) since the two folders have
// different names/purposes and only a few lines are actually duplicated.
async function ensureFolder(db, drive, integration) {
  if (integration[FOLDER_FIELD]) {
    try {
      const f = await drive.files.get({ fileId: integration[FOLDER_FIELD], fields: 'id,trashed' });
      if (f.data && !f.data.trashed) return integration[FOLDER_FIELD];
    } catch (err) { /* gone — create a new one below */ }
  }
  const created = await drive.files.create({ requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME }, fields: 'id' });
  await integrationCollection(db).updateOne({ _id: integration._id }, { $set: { [FOLDER_FIELD]: created.data.id } });
  return created.data.id;
}

// Uploads a buffer to the connected Drive account. Returns the new file's id, or null if Google Docs isn't
// connected (the caller's signal to fall back to local disk) — never throws for "not connected", only for a
// real API failure once a connection exists.
async function uploadDocument(db, buffer, filename, mimeType) {
  const authorized = await getAuthorizedDrive(db);
  if (!authorized) return null;
  const { drive, integration } = authorized;
  const folderId = await ensureFolder(db, drive, integration);
  const created = await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from([buffer]) },
    fields: 'id'
  });
  return created.data.id;
}

// Streams a file's content back from Drive. Throws if Google Docs isn't connected — unlike uploadDocument(),
// a caller only ever calls this when a document record already has a driveFileId, so "not connected" here
// means the connection was lost after the file was uploaded, a real error worth surfacing, not a silent
// fallback (there is nothing to fall back to — the file was never written locally).
async function downloadDocument(db, fileId) {
  const authorized = await getAuthorizedDrive(db);
  if (!authorized) throw new Error('Google Docs is not connected. An Administrator can reconnect it in Settings → Integrations.');
  const res = await authorized.drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return res.data; // a Readable stream
}

// Best-effort delete — mirrors the local-disk delete path's own fs.unlink(..., () => {}) fire-and-forget
// style (cirl.js, DELETE /api/documents/:id): the database row is the source of truth for "does this
// document exist"; a failed cleanup on the storage side is logged, never surfaced to the caller.
async function deleteDocument(db, fileId) {
  try {
    const authorized = await getAuthorizedDrive(db);
    if (!authorized) return;
    await authorized.drive.files.delete({ fileId });
  } catch (err) {
    console.error(`⚠️  Document Library: failed to delete Drive file ${fileId}:`, describeGoogleError(err));
  }
}

module.exports = { uploadDocument, downloadDocument, deleteDocument, describeGoogleError };
