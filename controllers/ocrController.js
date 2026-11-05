const fs = require('fs');
const ocrService = require('../services/ocrService');

// POST /api/ocr/extract — accepts either one document (field 'document', the original single-file path —
// still used as-is by every existing caller) or multiple photos of one document (field 'documents',
// 2026-11), starts OCR in the background, and immediately returns a jobId. The heavy work (merging
// multiple photos into one PDF, rasterizing pages, running Tesseract) happens after the response so the
// client can poll for real progress instead of blocking on one long request.
// NOTE: This endpoint does NOT save anything to the Document Library. The file(s) are held in the temp
// uploads directory until the user either confirms (via POST /api/ocr/confirm) or discards (via
// POST /api/ocr/discard).
function extract(req, res) {
  const singleFile = req.file || (req.files && req.files.document && req.files.document[0]) || null;
  const multiFiles = (req.files && req.files.documents && req.files.documents.length) ? req.files.documents : null;

  if (!singleFile && !multiFiles) {
    return res.status(400).json({ success: false, error: 'No file was uploaded.' });
  }

  const allPaths = multiFiles ? multiFiles.map((f) => f.path) : [singleFile.path];
  try {
    const meta = {
      // A merged multi-photo job archives as one PDF regardless of what the individual photos were named —
      // this is purely a display/filename fallback (see docOcrSucceed in documents.ejs), never used to
      // infer the file's real type (archiveToDocumentLibrary infers that from the actual temp file).
      originalName: multiFiles
        ? (multiFiles.length === 1 ? multiFiles[0].originalname : `Combined Scan (${multiFiles.length} photos).pdf`)
        : singleFile.originalname,
      uploadedBy: (req.session && req.session.user && req.session.user.name) || 'Unknown',
      uploadedByEmail: (req.session && req.session.user && req.session.user.email) || null
    };
    const jobId = ocrService.startJob(multiFiles ? allPaths : singleFile.path, multiFiles ? null : singleFile.mimetype, meta);
    res.status(202).json({ success: true, jobId });
  } catch (err) {
    allPaths.forEach((p) => fs.unlink(p, () => {}));
    res.status(500).json({ success: false, error: 'Failed to start OCR processing.' });
  }
}

// GET /api/ocr/status/:jobId — polled by the frontend for progress + final result.
function status(req, res) {
  const job = ocrService.getJob(req.params.jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or has expired.' });
  }
  const sessionEmail = req.session && req.session.user && req.session.user.email;
  if (job.uploadedByEmail && job.uploadedByEmail !== sessionEmail) {
    return res.status(403).json({ success: false, error: 'You do not have access to this job.' });
  }

  res.json({
    success: true,
    status: job.status,      // 'processing' | 'done' | 'error'
    progress: job.progress,  // 0-100
    stage: job.stage,
    result: job.result,      // populated only once status === 'done'
    error: job.error
  });
}

// POST /api/ocr/confirm — called after the user reviews the OCR result and
// explicitly clicks "Save to Document Library". Merges any user edits (title,
// institution) with the extracted fields, then permanently archives the file.
// Only the session owner of the job may confirm it.
async function confirm(req, res) {
  const { jobId, title, institution, documentType, partnershipId } = req.body || {};
  if (!jobId) {
    return res.status(400).json({ success: false, error: 'jobId is required.' });
  }

  const job = ocrService.getJob(jobId);
  if (!job) {
    return res.status(404).json({ success: false, error: 'Job not found or has expired. Please re-upload the document.' });
  }
  const sessionEmail = req.session && req.session.user && req.session.user.email;
  if (job.uploadedByEmail && job.uploadedByEmail !== sessionEmail) {
    return res.status(403).json({ success: false, error: 'You do not have access to this job.' });
  }
  if (job.confirmed) {
    return res.status(409).json({ success: false, error: 'This upload has already been saved to the Document Library.' });
  }

  // User-supplied edits take precedence over OCR-extracted values.
  const overrides = {};
  if (title && title.trim()) overrides.title = title.trim();
  if (institution && institution.trim()) {
    overrides.institution = institution.trim();
    overrides.partner = institution.trim();
  }
  // documentType (2026-11 investigation): lets a caller whose own form has its own, already-user-confirmed
  // type selection (e.g. the Add New Partnership form's MOA/MOU field) make the archived Document Library
  // record agree with it, instead of only ever reflecting OCR's own free-text guess.
  if (documentType && String(documentType).trim()) overrides.documentType = String(documentType).trim();

  // Only a bare positive integer is ever accepted — never trusted beyond that (it is looked up server-side
  // the same as any other id; this merely records which partnership this upload belongs to).
  const extraMeta = {};
  if (partnershipId != null && Number.isInteger(Number(partnershipId)) && Number(partnershipId) > 0) {
    extraMeta.partnershipId = Number(partnershipId);
  }

  try {
    const session = (req.session && req.session.user) || {};
    const archived = await ocrService.confirmJob(jobId, overrides, session, extraMeta);
    res.json({ success: true, documentId: archived.documentId, fileLink: archived.fileLink });
  } catch (err) {
    // Same convention as the safe-error-response pass elsewhere in this app: log the real error
    // server-side, never echo it to the client (it previously did `error: err.message`).
    console.error('❌ OCR confirm error:', err);
    res.status(500).json({ success: false, error: 'Failed to save the document. Please try again.' });
  }
}

// POST /api/ocr/discard — called when the user closes the modal without saving,
// or clicks "Discard". Deletes the temporary file; nothing is written to the DB.
async function discard(req, res) {
  const { jobId } = req.body || {};
  if (!jobId) {
    // No jobId means nothing was uploaded — nothing to do.
    return res.json({ success: true });
  }

  const job = ocrService.getJob(jobId);
  if (job) {
    const sessionEmail = req.session && req.session.user && req.session.user.email;
    if (job.uploadedByEmail && job.uploadedByEmail !== sessionEmail) {
      return res.status(403).json({ success: false, error: 'You do not have access to this job.' });
    }
  }

  try {
    await ocrService.discardJob(jobId);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ OCR discard error:', err);
    res.status(500).json({ success: false, error: 'Failed to discard upload.' });
  }
}

module.exports = { extract, status, confirm, discard };
