const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { getDb, insertWithNextId } = require('../db');
const documentStorageService = require('./documentStorageService');

const DOCUMENTS_DIR = path.join(__dirname, '..', 'uploads', 'documents');
if (!fs.existsSync(DOCUMENTS_DIR)) fs.mkdirSync(DOCUMENTS_DIR, { recursive: true });

const EXT_MIME_TYPES = { '.pdf': 'application/pdf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

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

  const candidates = await db.collection('documents').find({ $or: orClauses }).limit(30).toArray();
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
    matches: topMatches.map(({ c, reasons, score, matchPercentage }) => ({
      id: c.id,
      title: c.title || 'Untitled Document',
      type: c.type || 'Other',
      institution: c.institution || c.partner || 'N/A',
      partner: c.partner || c.institution || 'N/A',
      validity: c.validity || 'N/A',
      originalFilename: c.originalFilename || 'Unknown',
      uploadedAt: c.uploadedAt || c.date || 'N/A',
      uploadedBy: c.uploadedBy || 'Unknown',
      fileLink: c.fileLink || '#',
      reasons: reasons,
      reason: reasons.join(' · '),
      score: score,
      matchPercentage: matchPercentage
    }))
  };
}

// Every file uploaded through the OCR pipeline is archived here automatically
// — regardless of whether OCR extraction itself succeeded — so nothing a user
// uploads is ever silently discarded. `extraction` is null when OCR failed.
async function archiveToDocumentLibrary(tempFilePath, originalName, extraction, meta = {}) {
  const ext = path.extname(originalName || tempFilePath) || '.bin';
  const permanentName = `${Date.now()}-${crypto.randomBytes(6).toString('hex')}${ext}`;

  const db = getDb();

  // Google Drive storage, tried first whenever Google Docs is connected (see services/documentStorageService.js
  // for why — Render's free plan wipes local disk on every redeploy). Local disk is always the fallback: when
  // Drive isn't connected, when the upload fails, and ALWAYS under Jest (JEST_WORKER_ID) — the existing test
  // suite's local-disk assertions (e.g. test/partnership-document-persistence.test.js) are unaffected.
  let driveFileId = null;
  if (!process.env.JEST_WORKER_ID) {
    try {
      const buffer = await fsp.readFile(tempFilePath);
      driveFileId = await documentStorageService.uploadDocument(db, buffer, permanentName, EXT_MIME_TYPES[ext.toLowerCase()]);
    } catch (err) {
      console.error('⚠️  Document Library: Google Drive upload failed, falling back to local disk:', documentStorageService.describeGoogleError(err));
    }
  }

  const permanentPath = path.join(DOCUMENTS_DIR, permanentName);
  if (driveFileId) {
    // Drive already has the bytes — no point also keeping a local copy Render will wipe on the next deploy anyway.
    await fsp.unlink(tempFilePath).catch(() => {});
  } else {
    try {
      await fsp.rename(tempFilePath, permanentPath);
    } catch {
      // Cross-device fallback (rename can fail across filesystems/mounts)
      await fsp.copyFile(tempFilePath, permanentPath);
      await fsp.unlink(tempFilePath).catch(() => {});
    }
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
    driveFileId: driveFileId || null,
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
    ...(meta.partnershipId != null ? { partnershipId: meta.partnershipId } : {})
  });

  // 2026-11 Phase 3: documents was the one sequential-id collection the Phase 2 race-condition fix
  // missed (nextDocumentId() read-then-inserted with no protection against two concurrent uploads
  // landing on the same id). insertWithNextId() (db.js) retries on an id collision the same way every
  // other collection's insert does now.
  const doc = await insertWithNextId(db.collection('documents'), buildDoc);
  return { documentId: doc.id, fileLink: doc.fileLink };
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

module.exports = { archiveToDocumentLibrary, updateDocument, archiveRequestRecordToLibrary, findPossibleDuplicates, DOCUMENTS_DIR, EXT_MIME_TYPES };
