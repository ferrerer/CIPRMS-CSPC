// Bidirectional Document Library <-> Google Drive sync (2026-11), pragmatic scope per the brief this
// implements: periodic full reconciliation (no Drive Changes API page-token state to persist, no webhooks —
// robust across a Render restart/redeploy with nothing to recover, at the cost of O(items) Drive API calls
// per run instead of an incremental diff; acceptable at this library's scale). Reused everywhere else:
// documentStorageService.js's getDriveContext()/getAuthorizedDrive() (same single connected account, same
// "CIPRMS Document Library" root folder) — this file adds no new OAuth/connection machinery of its own.
//
// Drive -> CIPRMS (runDriveSync): walks the Drive folder tree under the root breadth-first, upserting a
// documentfolders/documents record per Drive folder/file it finds (matched by the stable driveFolderId/
// driveFileId, never by name — a rename in Drive must update the existing record, never create a second
// one). Anything CIPRMS already has a Drive id for that this pass did NOT see is archived (soft, reversible
// — never deleted) rather than assumed gone forever, since "not found" and "trashed" are indistinguishable
// from the same account's view (see services/googleDocsService.js's classifyGoogleError comment on this
// exact ambiguity). Native Google Docs/Sheets/Slides files are skipped (can't be read via alt=media the way
// a binary can) — logged as skipped, never a failure.
//
// CIPRMS -> Drive: NOT done here. Those are direct, synchronous calls at the point of the CIPRMS action
// itself (cirl.js's rename/organize/folder routes call documentStorageService.renameFile/moveFile/
// createFolder/trashFile directly) — reconciliation only needs to run the Drive -> CIPRMS direction.
const path = require('path');
const documentStorageService = require('./documentStorageService');
const { integrationCollection } = require('./googleDocsService');
const { insertWithNextId } = require('../db');

const NATIVE_GOOGLE_MIME_PREFIX = 'application/vnd.google-apps.';
const FOLDER_MIME = 'application/vnd.google-apps.folder';
const DRIVE_LIST_FIELDS = 'nextPageToken, files(id,name,mimeType,parents,modifiedTime,size,webViewLink,trashed)';

async function recordSyncConflict(db, kind, recordId, driveId, reason) {
  return insertWithNextId(db.collection('sync_conflicts'), (id) => ({
    id, kind, recordId, driveId, reason, detectedAt: new Date().toISOString(), resolved: false, resolvedBy: null, resolvedAt: null
  }));
}

async function upsertFolderFromDrive(db, driveFolder, cirlParentId) {
  const existing = await db.collection('documentfolders').findOne({ driveFolderId: driveFolder.id });
  const now = new Date().toISOString();
  if (existing) {
    const updates = {};
    if (existing.name !== driveFolder.name) updates.name = driveFolder.name;
    if (existing.parentFolderId !== cirlParentId) updates.parentFolderId = cirlParentId;
    if (existing.archived) updates.archived = false; // un-trashed in Drive since the last pass
    updates.syncStatus = 'synced';
    updates.lastSyncedAt = now;
    updates.syncError = null;
    await db.collection('documentfolders').updateOne({ id: existing.id }, { $set: updates });
    return existing.id;
  }
  const created = await insertWithNextId(db.collection('documentfolders'), (id) => ({
    id, name: driveFolder.name, ownerEmail: null, archived: false, createdAt: now,
    parentFolderId: cirlParentId, driveFolderId: driveFolder.id,
    syncStatus: 'synced', lastSyncedAt: now, syncError: null
  }));
  return created.id;
}

// `existing` is passed in (not re-fetched) so the caller's single findOne() covers both the conflict check
// and the update — avoids a second round trip per file in what's already an O(files) loop.
async function upsertDocumentFromDrive(db, driveFile, cirlFolderId) {
  const existing = await db.collection('documents').findOne({ driveFileId: driveFile.id });
  const now = new Date().toISOString();
  if (existing) {
    const driveSideChanged = existing.title !== driveFile.name || existing.folderId !== cirlFolderId;
    // Conflict: CIPRMS's own record was touched locally (updatedLocallyAt) AFTER the last time we
    // successfully synced it (lastSyncedAt), AND Drive also changed in the meantime — last-write-wins would
    // silently discard whichever side loses, so this records it for review instead and leaves both sides
    // exactly as they are until an Administrator/Staff resolves it.
    const localSideChangedSinceSync = existing.updatedLocallyAt && (!existing.lastSyncedAt || existing.updatedLocallyAt > existing.lastSyncedAt);
    if (driveSideChanged && localSideChangedSinceSync) {
      await recordSyncConflict(db, 'document', existing.id, driveFile.id,
        `CIPRMS and Google Drive were both changed before sync completed (CIPRMS: "${existing.title}", Drive: "${driveFile.name}").`);
      await db.collection('documents').updateOne({ id: existing.id },
        { $set: { syncStatus: 'conflict', syncError: 'Conflicting changes on both sides — see Sync Conflicts for review.' } });
      return { id: existing.id, conflict: true };
    }
    const updates = {};
    if (existing.title !== driveFile.name) { updates.title = driveFile.name; updates.originalFilename = driveFile.name; }
    if (existing.folderId !== cirlFolderId) updates.folderId = cirlFolderId;
    if (existing.archived) updates.archived = false;
    updates.syncStatus = 'synced';
    updates.lastSyncedAt = now;
    updates.syncError = null;
    if (Object.keys(updates).length) await db.collection('documents').updateOne({ id: existing.id }, { $set: updates });
    return { id: existing.id, conflict: false };
  }

  // Genuinely new: a file uploaded straight into Drive, never through CIPRMS. Its bytes live only in Drive
  // (no local copy was ever written), so fileLink is a synthetic, stable path keyed by the Drive file id —
  // GET /uploads/documents/:filename (cirl.js) looks documents up BY fileLink, so this keeps that route
  // working unmodified for a Drive-originated record, exactly as it already does for a CIPRMS-uploaded one.
  const ext = path.extname(driveFile.name || '') || '';
  const fileLink = `/uploads/documents/drive-${driveFile.id}${ext}`;
  const uploadedAt = driveFile.modifiedTime || now;
  const created = await insertWithNextId(db.collection('documents'), (id) => ({
    id, title: driveFile.name, type: 'Other', institution: null, partner: null,
    date: new Date(uploadedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    status: 'Needs Review', fileLink, driveFileId: driveFile.id, tags: ['Drive Import'],
    uploadedBy: 'Google Drive', uploadedByEmail: null, uploadedAt,
    originalFilename: driveFile.name, folderId: cirlFolderId, archived: false,
    importedFromDrive: true, syncStatus: 'synced', lastSyncedAt: now, syncError: null
  }));
  return { id: created.id, conflict: false };
}

async function archiveUnseenFolders(db, seenDriveFolderIds) {
  await db.collection('documentfolders').updateMany(
    { driveFolderId: { $nin: [null, ...seenDriveFolderIds] }, archived: { $ne: true } },
    { $set: { archived: true, syncStatus: 'synced', lastSyncedAt: new Date().toISOString(), syncError: 'No longer found in Drive (trashed or inaccessible) — archived, not deleted.' } }
  );
}

async function archiveUnseenDocuments(db, seenDriveFileIds) {
  await db.collection('documents').updateMany(
    { driveFileId: { $nin: [null, ...seenDriveFileIds] }, archived: { $ne: true } },
    { $set: { archived: true, syncStatus: 'synced', lastSyncedAt: new Date().toISOString(), syncError: 'No longer found in Drive (trashed or inaccessible) — archived, not deleted.' } }
  );
}

// Walks every page of one folder's children. `onFolder`/`onFile` are called per item; returns nothing —
// callers accumulate via closures (keeps this function a single, testable traversal primitive).
async function forEachChild(drive, parentDriveId, onFolder, onFile) {
  let pageToken;
  do {
    let res;
    try {
      res = await drive.files.list({
        q: `'${parentDriveId}' in parents and trashed = false`,
        fields: DRIVE_LIST_FIELDS, pageToken, pageSize: 200
      });
    } catch (err) {
      throw Object.assign(new Error(`Listing Drive folder ${parentDriveId} failed: ${err.message}`), { cause: err });
    }
    for (const f of (res.data.files || [])) {
      if (f.mimeType === FOLDER_MIME) await onFolder(f);
      else if (f.mimeType.startsWith(NATIVE_GOOGLE_MIME_PREFIX)) continue; // unsupported type — skipped, not an error
      else await onFile(f);
    }
    pageToken = res.data.nextPageToken;
  } while (pageToken);
}

// Full reconciliation pass. Returns a summary; never throws — a failure on one branch/file is collected
// into `errors` and the rest of the tree is still processed, so one bad file can never abort the whole sync.
async function runDriveSync(db) {
  const ctx = await documentStorageService.getDriveContext(db);
  if (!ctx) return { ok: false, reason: 'not_connected' };
  const { drive, rootFolderId } = ctx;

  const seenFolderDriveIds = [];
  const seenFileDriveIds = [];
  const conflicts = [];
  const errors = [];
  const driveIdToCirlFolderId = new Map([[rootFolderId, null]]);

  let level = [rootFolderId];
  while (level.length) {
    const nextLevel = [];
    for (const driveParentId of level) {
      const cirlParentId = driveIdToCirlFolderId.get(driveParentId) ?? null;
      try {
        await forEachChild(
          drive, driveParentId,
          async (driveFolder) => {
            seenFolderDriveIds.push(driveFolder.id);
            const cirlFolderId = await upsertFolderFromDrive(db, driveFolder, cirlParentId);
            driveIdToCirlFolderId.set(driveFolder.id, cirlFolderId);
            nextLevel.push(driveFolder.id);
          },
          async (driveFile) => {
            seenFileDriveIds.push(driveFile.id);
            try {
              const result = await upsertDocumentFromDrive(db, driveFile, cirlParentId);
              if (result.conflict) conflicts.push({ documentId: result.id, driveFileId: driveFile.id, name: driveFile.name });
            } catch (err) {
              errors.push({ context: `importing Drive file ${driveFile.id} (${driveFile.name})`, error: err.message });
            }
          }
        );
      } catch (err) {
        errors.push({ context: `traversing Drive folder ${driveParentId}`, error: err.message });
      }
    }
    level = nextLevel;
  }

  await archiveUnseenFolders(db, seenFolderDriveIds);
  await archiveUnseenDocuments(db, seenFileDriveIds);

  const summary = {
    ok: true, syncedAt: new Date().toISOString(),
    foldersSeen: seenFolderDriveIds.length, filesSeen: seenFileDriveIds.length,
    conflicts, errors
  };
  await integrationCollection(db).updateOne({}, { $set: { lastDriveSyncAt: summary.syncedAt, lastDriveSyncSummary: { foldersSeen: summary.foldersSeen, filesSeen: summary.filesSeen, conflictCount: conflicts.length, errorCount: errors.length } } }).catch(() => {});
  return summary;
}

module.exports = { runDriveSync, recordSyncConflict, upsertFolderFromDrive, upsertDocumentFromDrive };
