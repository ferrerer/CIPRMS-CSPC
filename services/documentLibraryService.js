const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { getDb, insertWithNextId } = require('../db');
const documentStorageService = require('./documentStorageService');

const DOCUMENTS_DIR = path.join(__dirname, '..', 'uploads', 'documents');
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

const EXT_MIME_TYPES = {
  '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
};

// Maps the free-form OCR document-type guess down to the short codes the
// Document Library UI filters by (All / MOA / MOU / Other). Accreditation records keep their
// "Accreditation" type (and still show under All) — only its filter button was removed (2026-09-20).
function shortDocType(documentType) {
  if (!documentType) return 'Other';
  if (/agreement|\bmoa\b/i.test(documentType)) return 'MOA';
  if (/understanding|\bmou\b/i.test(documentType)) return 'MOU';
  if (/accreditation|certification/i.test(documentType)) return 'Accreditation';
  if (/proposal/i.test(documentType)) return 'Proposal';
  if (/letter of intent|\bloi\b/i.test(documentType)) return 'LOI';
  if (/contract/i.test(documentType)) return 'Contract';
  if (/^jva$/i.test(documentType)) return 'JVA';
  // Partner Activities (2026-11) — the "List of Activities" PDF archived per partnership (see
  // archivePartnerActivitiesPdf in cirl.js). Its own type so it is never grouped under 'Other' with
  // every unrecognized upload.
  if (/partner activities/i.test(documentType)) return 'Partner Activities';
  // Achievements (2026-11) — a QS Ranking/TÜV Certification/PQA/Accreditation/Award certificate archived
  // from the Dashboard's Institutional Achievements section (see POST/PATCH /api/achievements in
  // cirl.js). Same reasoning as Partner Activities: its own type/filter, never lumped into 'Other'.
  if (/^achievement/i.test(documentType)) return 'Achievements';
  return 'Other';
}

function escapeRegex(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'from', 'have', 'were', 'which',
  'shall', 'between', 'parties', 'herein', 'hereinafter', 'referred', 'agreement',
  'memorandum', 'understanding', 'party', 'their', 'other', 'colleges', 'state'
]);

function computeTextSimilarity(textA, textB) {
  if (!textA || !textB) return 0;
  const wordsA = new Set(String(textA).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w)));
  const wordsB = new Set(String(textB).toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3 && !STOPWORDS.has(w)));
  if (wordsA.size === 0 || wordsB.size === 0) return 0;
  let overlap = 0;
  for (const w of wordsA) {
    if (wordsB.has(w)) overlap++;
  }
  const union = wordsA.size + wordsB.size - overlap;
  return union > 0 ? (overlap / union) : 0;
}

// Multi-signal duplicate detection (filename, document type, institution, text similarity, file hash)
// meta.excludeRequestKey ({requestId, requestType}), when given, drops candidates tagged with that exact
// pair from consideration (2026-11 duplicate-warning follow-up) — a new version of the SAME request isn't
// a duplicate of its own previous version; that case already goes through the existing supersede flow
// (supersedePreviousRequestDocuments) and must never also trigger a duplicate warning.
async function findPossibleDuplicates(db, extraction, meta = {}) {
  if (!extraction && !meta.fileHash && !meta.originalName) return { found: false, matches: [] };

  const orClauses = [];
  if (meta.fileHash) {
    orClauses.push({ fileHash: meta.fileHash });
  }
  if (extraction && extraction.institution) {
    orClauses.push({ institution: { $regex: escapeRegex(extraction.institution), $options: 'i' } });
  }
  if (extraction && extraction.partner) {
    orClauses.push({ partner: { $regex: escapeRegex(extraction.partner), $options: 'i' } });
  }
  if (meta.originalName) {
    orClauses.push({ originalFilename: { $regex: escapeRegex(meta.originalName), $options: 'i' } });
  }
  if (orClauses.length === 0) return { found: false, matches: [] };

  // LAU Internal Review Uploads and Partner Activities PDFs (2026-11) — excluded from duplicate-detection
  // candidates entirely. Without this, a requester uploading any unrelated document through the normal OCR
  // flow, for the SAME institution an LAU reviewer already left an internal review on (or that already has
  // a "List of Activities" PDF archived), would get that document back in `matches` — with its real
  // title/fileLink in the mapped shape below — purely because the institution name matched. Both are also
  // simply the wrong category to ever flag as a duplicate of an MOA/MOU/Accreditation upload, and LAU
  // review files must never be revealed to anyone outside LAU via this path either.
  const filter = { $or: orClauses, requestType: { $ne: 'partnership-lau-review' }, type: { $ne: 'Partner Activities' } };
  if (meta.excludeRequestKey && meta.excludeRequestKey.requestId != null && meta.excludeRequestKey.requestType) {
    filter.$nor = [{ requestId: meta.excludeRequestKey.requestId, requestType: meta.excludeRequestKey.requestType }];
  }
  const candidates = await db.collection('documents').find(filter).limit(30).toArray();
  const type = extraction ? shortDocType(extraction.documentType) : null;
  const rawText = extraction ? extraction.rawText : null;

  const scored = [];
  for (const c of candidates) {
    let score = 0;
    const reasons = [];
    let exactHash = false;
    let textSim = 0;

    // 1. File Hash Match (Exact file identity)
    if (meta.fileHash && c.fileHash && meta.fileHash === c.fileHash) {
      score += 10;
      reasons.push('Identical file content (exact SHA-256 hash match)');
      exactHash = true;
    }

    // 2. Extracted text / content similarity
    const candidateText = c.ocrText || c.rawText;
    if (rawText && candidateText) {
      textSim = computeTextSimilarity(rawText, candidateText);
      if (textSim >= 0.70) {
        score += 5;
        reasons.push(`High text content similarity (${Math.round(textSim * 100)}%)`);
      } else if (textSim >= 0.45) {
        score += 2;
        reasons.push(`Moderate text content similarity (${Math.round(textSim * 100)}%)`);
      }
    }

    // 3. Institution / Partner Match
    const cInst = (c.institution || c.partner || '').trim().toLowerCase();
    const eInst = (extraction && (extraction.institution || extraction.partner) || '').trim().toLowerCase();
    if (eInst && cInst && (cInst === eInst || cInst.includes(eInst) || eInst.includes(cInst))) {
      score += 3;
      reasons.push(`Same institution (${c.institution || c.partner})`);
    }

    // 4. Document Type Match
    if (type && c.type === type) {
      score += 2;
      reasons.push(`Same document type (${c.type})`);
    }

    // 5. Filename Match
    if (meta.originalName && c.originalFilename && meta.originalName.trim().toLowerCase() === c.originalFilename.trim().toLowerCase()) {
      score += 2;
      reasons.push(`Same filename (${c.originalFilename})`);
    }

    // 6. Validity Date Overlap
    if (extraction && extraction.endDate && c.validity && c.validity.includes(extraction.endDate)) {
      score += 1;
      reasons.push('Overlapping validity dates');
    }

    // False positive threshold: exact hash OR score >= 4
    if (exactHash || score >= 4) {
      const matchPercentage = exactHash
        ? 100
        : Math.min(99, Math.round(textSim > 0 ? textSim * 100 : (score / 8) * 100));
      scored.push({ c, score, reasons, exactHash, matchPercentage });
    }
  }

  scored.sort((a, b) => b.score - a.score);
  const topMatches = scored.slice(0, 5);

  return {
    found: topMatches.length > 0,
    // Exact (same file hash) vs Possible (everything else — similar text/institution/title): an overall
    // classification for the whole result, not per-match, matching the two warning levels the upload-
    // confirmation flow shows (2026-11 duplicate-warning follow-up). null when nothing matched at all.
    matchLevel: topMatches.length === 0 ? null : topMatches.some((m) => m.exactHash) ? 'exact' : 'possible',
    matches: topMatches.map(({ c, reasons, score, matchPercentage, exactHash }) => ({
      id: c.id,
      title: c.title || 'Untitled Document',
      type: c.type || 'Other',
      institution: c.institution || c.partner || 'N/A',
      partner: c.partner || c.institution || 'N/A',
      validity: c.validity || 'N/A',
      originalFilename: c.originalFilename || 'Unknown',
      uploadedAt: c.uploadedAt || c.date || 'N/A',
      uploadedBy: c.uploadedBy || 'Unknown',
      // uploadedByEmail/requestId/requestType are server-internal — used by scopeDuplicateMatchesForViewer()
      // below to decide what a given viewer is allowed to see, and stripped before any HTTP response.
      uploadedByEmail: c.uploadedByEmail || null,
      requestId: c.requestId != null ? c.requestId : null,
      requestType: c.requestType || null,
      exactHash: exactHash,
      fileLink: c.fileLink || '#',
      reasons: reasons,
      reason: reasons.join(' · '),
      score: score,
      matchPercentage: matchPercentage
    }))
  };
}

// Privacy scoping for a duplicate-warning response (2026-11): a reviewer (Administrator/Staff) sees full
// match details for anything findPossibleDuplicates returned — they already have unrestricted read access
// to every document via GET /uploads/documents/:filename. Everyone else (Partner/potential_partner, Dean/
// Auth. Personnel) only ever sees details for a match that is their OWN upload; any other match is folded
// into a plain "a similar document may already exist" signal with no title, institution, uploader, or
// link revealed — `genericOnly` tells the caller whether to render ONLY that generic sentence (true) or
// the (possibly filtered-down) match list below it (false). uploadedByEmail is stripped from every match
// either way — it is never meant to reach the client, only to decide what to keep server-side.
function scopeDuplicateMatchesForViewer(duplicateResult, viewer, isReviewerRole) {
  if (!duplicateResult || !duplicateResult.found) return { found: false, matchLevel: null, matches: [], genericOnly: false };
  const strip = (m) => {
    const { uploadedByEmail, ...rest } = m;
    return rest;
  };
  if (isReviewerRole) {
    return { found: true, matchLevel: duplicateResult.matchLevel, matches: duplicateResult.matches.map(strip), genericOnly: false };
  }
  const viewerEmail = viewer && viewer.email;
  const ownMatches = duplicateResult.matches.filter((m) => viewerEmail && m.uploadedByEmail === viewerEmail).map(strip);
  const hadOtherPeoplesMatches = ownMatches.length < duplicateResult.matches.length;
  return {
    found: true,
    matchLevel: duplicateResult.matchLevel,
    matches: ownMatches,
    genericOnly: ownMatches.length === 0 && hadOtherPeoplesMatches
  };
}

// Every file uploaded through the OCR pipeline is archived here automatically
// — regardless of whether OCR extraction itself succeeded — so nothing a user
// uploads is ever silently discarded. `extraction` is null when OCR failed.
async function archiveToDocumentLibrary(tempFilePath, originalName, extraction, meta = {}) {
  const ext = path.extname(originalName || tempFilePath) || '.bin';
  const permanentName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;

  const db = getDb();

  // Local disk first, always — fast and synchronous, exactly as this function behaved before Google Drive
  // storage existed. The caller (POST /api/ocr/confirm, etc.) is a live HTTP request a real person is
  // waiting on; it must never be held open by a slow network call. Google Drive upload used to be awaited
  // right here, and on Render's network a slow Drive API response could keep this request open long enough
  // to trip the browser's/Render's own connection timeout — surfacing to the user as "failed to upload /
  // lost connection" even though the document had actually saved successfully. See uploadToDriveInBackground()
  // below for where Drive upload actually happens now: after this function has already returned.
  const permanentPath = path.join(DOCUMENTS_DIR, permanentName);
  try {
    await fsp.rename(tempFilePath, permanentPath);
  } catch {
    // Cross-device fallback (rename can fail across filesystems/mounts)
    await fsp.copyFile(tempFilePath, permanentPath);
    await fsp.unlink(tempFilePath).catch(() => {});
  }
  const type = shortDocType(extraction && extraction.documentType);
  const institution = (extraction && extraction.institution) || null;
  const partner = (extraction && (extraction.partner || extraction.institution)) || null;
  const issuingBody = (extraction && extraction.issuingBody) || null;
  const accreditationLevel = (extraction && extraction.accreditationLevel) || null;
  const certificateNumber = (extraction && extraction.certificateNumber) || null;
  const accreditedProgram = (extraction && extraction.accreditedProgram) || null;

  let title;
  if (extraction && extraction.title) {
    title = extraction.title;
  } else if (type === 'Accreditation') {
    const body = issuingBody || 'Accreditation';
    const subject = accreditedProgram || institution || partner || 'Program Unspecified';
    title = `${body} Accreditation – ${subject}${accreditationLevel ? ` (${accreditationLevel})` : ''}`;
  } else {
    title = `${type} – ${partner || institution || originalName || 'Uploaded Document'}`;
  }

  const validity = extraction && (extraction.startDate || extraction.endDate)
    ? `${extraction.startDate || '?'} – ${extraction.endDate || '?'}`
    : null;

  const buildDoc = (id) => ({
    id,
    title,
    type,
    institution,
    partner: partner || 'Unknown',
    validity,
    issuingBody,
    accreditationLevel,
    certificateNumber,
    accreditedProgram,
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    status: extraction ? 'Active' : 'Needs Review',
    fileLink: `/uploads/documents/${permanentName}`,
    driveFileId: null, // set asynchronously by uploadToDriveInBackground() below, after this document already exists
    tags: [type, extraction ? 'OCR Extracted' : 'OCR Failed'].concat(issuingBody ? [issuingBody] : []),
    uploadedBy: meta.uploadedBy || 'Unknown',
    uploadedByEmail: meta.uploadedByEmail || null,
    uploadedAt: new Date().toISOString(),
    ocrConfidence: extraction ? extraction.confidence : null,
    originalFilename: originalName || null,
    // ── IDP upgrade (2026-07-28) ──────────────────────────────────────────
    ocrText: extraction ? (extraction.rawText || null) : null,
    searchKeywords: extraction ? (extraction.searchKeywords || []) : [],
    summary: extraction ? (extraction.summary || null) : null,
    country: extraction ? (extraction.country || null) : null,
    category: extraction ? (extraction.category || null) : null,
    region: extraction ? (extraction.region || null) : null,
    nature: extraction ? (extraction.nature || null) : null,
    unit: extraction ? (extraction.unit || null) : null,
    fieldConfidence: extraction ? {
      institution: extraction.institutionConfidence || 0,
      country: extraction.countryConfidence || 0,
      documentType: extraction.documentTypeConfidence || 0,
      category: extraction.categoryConfidence || 0,
      region: extraction.regionConfidence || 0,
      nature: extraction.natureConfidence || 0,
      unit: extraction.unitConfidence || 0,
      startDate: extraction.startDateConfidence || 0,
      endDate: extraction.endDateConfidence || 0
    } : null,
    expiration: extraction ? {
      startDate: extraction.startDate || null,
      endDate: extraction.endDate || null,
      duration: extraction.duration || null,
      remainingDays: extraction.remainingDays != null ? extraction.remainingDays : null,
      expirationLabel: extraction.expirationLabel || null
    } : null,
    imageQualityWarnings: (extraction && extraction.imageQuality && extraction.imageQuality.warnings)
      ? extraction.imageQuality.warnings.map((w) => w.message) : [],
    possibleDuplicateIds: (extraction && extraction.duplicateWarning && extraction.duplicateWarning.found)
      ? extraction.duplicateWarning.matches.map((m) => m.id) : [],
    fileHash: meta.fileHash || null,
    // Links a document back to the Partnership/Document Request it was
    // uploaded during review of, when applicable (undefined for the OCR
    // registry-upload path, which doesn't set these).
    ...(meta.requestId != null ? { requestId: meta.requestId } : {}),
    ...(meta.requestType ? { requestType: meta.requestType } : {}),
    // 2026-11 New Partnership / Document Library investigation: the OCR auto-fill upload on the Add New
    // Partnership form (views/administrator/monitoring.ejs, assets/js/pages/registry-gridjs.init.js) is a
    // separate relationship from requestId/requestType above (that pair links to a pending Partnership
    // *Request* awaiting review — this partnership already exists, straight in the Registry) — its own
    // field so the two are never confused, and so a Document Library record can show which partnership it
    // was the supporting document for.
    ...(meta.partnershipId != null ? { partnershipId: meta.partnershipId } : {}),
    // Links a Document Library entry back to the Institutional Achievement it was archived from
    // (2026-11) — lets a future duplicate/cross-reference check recognize this entry as already
    // belonging to that specific achievement rather than treating it as an unrelated match.
    ...(meta.achievementId != null ? { achievementId: meta.achievementId } : {}),
    // Duplicate-warning acknowledgment (2026-11): set only when the uploader explicitly chose "Upload
    // anyway" on a duplicate/possible-duplicate warning (never set for an ordinary, no-match upload) — see
    // the pending-upload accept flow in cirl.js/ocrService.js. acknowledgedMatchIds links the acknowledgment
    // to exactly which existing document(s) it was warned about, for the Document Library's own
    // "Acknowledged duplicate" badge/filter.
    ...(meta.duplicateAcknowledged ? {
      duplicateAcknowledged: true,
      acknowledgedBy: meta.acknowledgedBy || null,
      acknowledgedAt: meta.acknowledgedAt || new Date().toISOString(),
      acknowledgedMatchIds: meta.acknowledgedMatchIds || []
    } : {})
  });

  // 2026-11 Phase 3: documents was the one sequential-id collection the Phase 2 race-condition fix
  // missed (nextDocumentId() read-then-inserted with no protection against two concurrent uploads
  // landing on the same id). insertWithNextId() (db.js) retries on an id collision the same way every
  // other collection's insert does now.
  const doc = await insertWithNextId(db.collection('documents'), buildDoc);

  // Google Drive upload happens here, AFTER the document is already saved and this function is about to
  // return — never awaited, so it cannot delay the caller's response (see the comment above). Skipped
  // entirely under Jest: the existing test suite's local-disk assertions (e.g.
  // test/partnership-document-persistence.test.js) expect the file to stay on disk, unaffected by this.
  if (!process.env.JEST_WORKER_ID) {
    uploadToDriveInBackground(db, doc.id, permanentPath, permanentName, EXT_MIME_TYPES[ext.toLowerCase()]);
  }

  return { documentId: doc.id, fileLink: doc.fileLink };
}

// Fire-and-forget: reads the just-saved local file, uploads it to the connected Google Drive account, and
// on success records driveFileId + deletes the local copy (Render will wipe it on the next redeploy anyway,
// so there's no reason to keep both). On any failure — Drive not connected, a network error, an expired
// token — the document simply stays on local disk exactly as it always did before Drive storage existed;
// logged for visibility, never thrown, never surfaced to whichever request triggered the original upload
// (which has already finished and responded by the time this runs).
function uploadToDriveInBackground(db, documentId, localPath, filename, mimeType) {
  fsp.readFile(localPath)
    .then((buffer) => documentStorageService.uploadDocument(db, buffer, filename, mimeType))
    .then((driveFileId) => {
      if (!driveFileId) return; // Drive isn't connected — stays on local disk, nothing more to do
      return db.collection('documents').updateOne({ id: documentId }, { $set: { driveFileId } })
        .then(() => fsp.unlink(localPath).catch(() => {}));
    })
    .catch((err) => {
      console.error(`⚠️  Document Library: background Google Drive upload failed for document ${documentId}, staying on local disk:`, documentStorageService.describeGoogleError(err));
    });
}

async function updateDocument(id, updates) {
  const db = getDb();
  const allowed = ['title', 'type', 'institution', 'partner', 'validity', 'status', 'issuingBody', 'accreditationLevel', 'certificateNumber', 'accreditedProgram'];
  const patch = {};
  for (const key of allowed) {
    if (updates[key] !== undefined) patch[key] = updates[key];
  }
  await db.collection('documents').updateOne({ id: Number(id) }, { $set: patch });
  return db.collection('documents').findOne({ id: Number(id) });
}

// Gives a submitter their own record of a Partnership/Document Request in the
// Document Library even when no file was uploaded with it (Document Requests
// never have an upload step, and a Partnership Request without OCR auto-fill
// has no attachment either) — there is no physical file to archive here, just
// a metadata entry in the same `documents` collection everything else in the
// library already reads from. `type` is expected to already be a short code
// (both requests collections store one — MOA/MOU/LOI/JVA/Accreditation/Other —
// so no OCR-style free-text mapping is needed here).
// Partnership Request de-duplication (2026-11, revised): keeps exactly one CURRENT Document Library
// record per Partnership Request. An earlier version of this function deleted the previous record's DB
// row and its physical file outright — which broke the request's own supportingDocuments/history
// timeline, since that array stores each version's fileLink directly and keeps linking to it forever.
// This version never deletes anything: it marks every other document already tagged with this
// {requestId, requestType} as superseded (superseded: true, supersededBy: the new document's id,
// supersededAt: now), leaving its DB record and file completely intact. A superseded document is
// excluded from Document Library listings/search/folders (see the `superseded: { $ne: true }` filter on
// GET /api/documents) so only the current version clutters browsing, but every version — superseded or
// not — stays fully downloadable via its own unchanged fileLink, exactly as the request's timeline
// expects. Call this AFTER archiving the new version, passing its id, so the new document is never the
// one that gets marked superseded by its own call.
// 2026-11 (first-upload-goes-missing investigation): this used to match every OTHER document tagged with
// this {requestId, requestType} regardless of its own `type` — so uploading a genuinely different document
// to the same request (e.g. an Accreditation added after an MOA) marked the MOA superseded too, hiding it
// from Document Library browsing even though it was never actually replaced. Only a document sharing the
// SAME `type` as the new one is a version of it; a different type is a different document and must never
// be touched here. The current document's own type is looked up rather than passed in, so none of this
// function's existing callers need to change.
async function supersedePreviousRequestDocuments(db, requestId, requestType, currentDocumentId) {
  if (requestId == null || !requestType || currentDocumentId == null) return;
  const current = await db.collection('documents').findOne({ id: currentDocumentId }, { projection: { type: 1 } });
  if (!current) return;
  await db.collection('documents').updateMany(
    { requestId, requestType, type: current.type, id: { $ne: currentDocumentId }, superseded: { $ne: true } },
    { $set: { superseded: true, supersededBy: currentDocumentId, supersededAt: new Date().toISOString() } }
  );
}

async function archiveRequestRecordToLibrary(db, meta) {
  const label = meta.requestType === 'document' ? 'Document Request' : 'Partnership Request';
  return insertWithNextId(db.collection('documents'), (id) => ({
    id,
    title: `${label} – ${meta.institution || 'Untitled'} (#${meta.requestId})`,
    type: meta.type || 'Other',
    institution: meta.institution || null,
    partner: meta.institution || 'Unknown',
    date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
    status: 'Active',
    fileLink: meta.viewLink || '',
    tags: [label],
    uploadedBy: meta.submittedBy || 'Unknown',
    uploadedByEmail: meta.submittedByEmail || null,
    uploadedAt: new Date().toISOString(),
    originalFilename: null,
    requestId: meta.requestId,
    requestType: meta.requestType
  }));
}

module.exports = { archiveToDocumentLibrary, updateDocument, archiveRequestRecordToLibrary, supersedePreviousRequestDocuments, findPossibleDuplicates, scopeDuplicateMatchesForViewer, DOCUMENTS_DIR, EXT_MIME_TYPES };
