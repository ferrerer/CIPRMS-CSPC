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
const { getAuthorizedDrive, integrationCollection, describeGoogleError, classifyGoogleError } = require('./googleDocsService');

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
  // A failure here (unlike the self-healing files.get above) means the connected account could not even
  // create a fresh folder — a real, distinct problem (e.g. no permission on this Drive, quota exceeded, API
  // outage), not the ordinary "folder was trashed, make a new one" case. Tagged so callers can show a
  // specific "folder inaccessible" message instead of a generic upload failure.
  try {
    const created = await drive.files.create({ requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME }, fields: 'id' });
    await integrationCollection(db).updateOne({ _id: integration._id }, { $set: { [FOLDER_FIELD]: created.data.id } });
    return created.data.id;
  } catch (err) {
    err.driveErrorCategory = 'folder_error';
    throw err;
  }
}

// Resolves {drive, rootFolderId} in one call — the same authorize-then-ensure-root-folder sequence every
// Drive mutation below needs. Returns null when Google Docs isn't connected (every caller's signal to fall
// back to local disk / skip sync, never a thrown error for that case alone).
async function getDriveContext(db) {
  const authorized = await getAuthorizedDrive(db);
  if (!authorized) return null;
  const { drive, integration } = authorized;
  const rootFolderId = await ensureFolder(db, drive, integration);
  return { drive, rootFolderId };
}

// Uploads a buffer to the connected Drive account. Returns the new file's id, or null if Google Docs isn't
// connected (the caller's signal to fall back to local disk) — never throws for "not connected", only for a
// real API failure once a connection exists. `parentFolderId` defaults to the Document Library root — pass
// a specific Drive folder id (from a synced CIPRMS folder) to upload directly into a subfolder instead.
async function uploadDocument(db, buffer, filename, mimeType, parentFolderId) {
  const ctx = await getDriveContext(db);
  if (!ctx) return null;
  const created = await ctx.drive.files.create({
    requestBody: { name: filename, parents: [parentFolderId || ctx.rootFolderId] },
    media: { mimeType: mimeType || 'application/octet-stream', body: Readable.from([buffer]) },
    fields: 'id'
  });
  return created.data.id;
}

// Creates a Drive folder under parentFolderId (defaults to the Document Library root). Returns the new
// folder's Drive id, or null if not connected.
async function createFolder(db, name, parentFolderId) {
  const ctx = await getDriveContext(db);
  if (!ctx) return null;
  const created = await ctx.drive.files.create({
    requestBody: { name, mimeType: FOLDER_MIME, parents: [parentFolderId || ctx.rootFolderId] },
    fields: 'id'
  });
  return created.data.id;
}

// Renames a Drive file OR folder (Drive's API treats both as "files" resources). Silently does nothing if
// not connected — a rename that can't reach Drive is never worth failing the CIPRMS-side rename over.
async function renameFile(db, fileId, newName) {
  const ctx = await getDriveContext(db);
  if (!ctx) return;
  await ctx.drive.files.update({ fileId, requestBody: { name: newName } });
}

// Moves a file or folder to a new parent. oldParentId is required by Drive's API (removeParents is how a
// file leaves its current folder — Drive files can technically have multiple parents, but every folder this
// app creates has exactly one, so this always passes the single known previous parent).
async function moveFile(db, fileId, newParentId, oldParentId) {
  const ctx = await getDriveContext(db);
  if (!ctx) return;
  await ctx.drive.files.update({ fileId, addParents: newParentId || ctx.rootFolderId, removeParents: oldParentId, fields: 'id,parents' });
}

// Moves a file or folder to Drive's trash — recoverable (Drive keeps trashed items for 30 days before
// permanent auto-deletion), unlike the permanent drive.files.delete() this replaces (2026-11 sync-safety
// fix: a CIPRMS-side delete must never be a silent, unrecoverable Drive delete — see Phase 7 of the
// bidirectional-sync brief this implements). Trashing a folder trashes its contents with it, Drive's own
// native behavior — exactly matching CIPRMS's own folder "archive" being soft/reversible too.
async function trashFile(db, fileId) {
  const ctx = await getDriveContext(db);
  if (!ctx) return;
  await ctx.drive.files.update({ fileId, requestBody: { trashed: true } });
}

// Restores a previously trashed file or folder — the other half of trashFile(), used when CIPRMS unarchives
// a document/folder so the two sides stay consistent in both directions.
async function restoreFile(db, fileId) {
  const ctx = await getDriveContext(db);
  if (!ctx) return;
  await ctx.drive.files.update({ fileId, requestBody: { trashed: false } });
}

// Streams a file's content back from Drive. Throws if Google Docs isn't connected — unlike uploadDocument(),
// a caller only ever calls this when a document record already has a driveFileId, so "not connected" here
// means the connection was lost after the file was uploaded, a real error worth surfacing, not a silent
// fallback (there is nothing to fall back to — the file was never written locally).
async function downloadDocument(db, fileId) {
  const authorized = await getAuthorizedDrive(db);
  if (!authorized) {
    const err = new Error('Google Docs is not connected. An Administrator can reconnect it in Settings → Integrations.');
    err.driveErrorCategory = 'not_connected';
    throw err;
  }
  const res = await authorized.drive.files.get({ fileId, alt: 'media' }, { responseType: 'stream' });
  return res.data; // a Readable stream
}

// Best-effort delete — mirrors the local-disk delete path's own fs.unlink(..., () => {}) fire-and-forget
// style (cirl.js, DELETE /api/documents/:id): the database row is the source of truth for "does this
// document exist"; a failed cleanup on the storage side is logged, never surfaced to the caller. Trashes
// rather than permanently deletes (see trashFile()'s own comment) — recoverable from Drive's own Trash for
// 30 days, consistent with CIPRMS never permanently deleting a document/folder record either.
async function deleteDocument(db, fileId) {
  try {
    await trashFile(db, fileId);
  } catch (err) {
    console.error(`⚠️  Document Library: failed to trash Drive file ${fileId}:`, describeGoogleError(err));
  }
}

module.exports = {
  uploadDocument, downloadDocument, deleteDocument, describeGoogleError, classifyGoogleError,
  getDriveContext, createFolder, renameFile, moveFile, trashFile, restoreFile, FOLDER_FIELD, FOLDER_MIME
};
