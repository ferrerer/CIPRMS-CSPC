const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const sharp = require('sharp');
const PDFDocument = require('pdfkit');
const Tesseract = require('tesseract.js');
const { PDFParse } = require('pdf-parse');
const { extractFields } = require('./extractionService');
const { UPLOAD_DIR } = require('../middleware/uploadMiddleware');
const { archiveToDocumentLibrary, findPossibleDuplicates } = require('./documentLibraryService');
const { analyzeImageQuality } = require('./imageQualityService');
const { getDb } = require('../db');
const realtime = require('./realtime');
// confirmJob is exported so ocrController can archive a completed job to the
// Document Library only after the user explicitly clicks "Save".

const OCR_TIMEOUT_MS = 90 * 1000;
const LOW_CONFIDENCE_THRESHOLD = 45;
const MIN_EMBEDDED_TEXT_LENGTH = 200; // above this, a PDF is treated as "digitally created" and skips OCR
// Overridable only for test/partnership-document-persistence's sibling, test/ocr-temp-file-cleanup.test.js,
// to exercise this sweep in real (sub-second) time instead of waiting out a real 10-minute TTL — production
// behavior is completely unchanged (both env vars are unset outside that one test file).
const JOB_TTL_MS = Number(process.env.OCR_JOB_TTL_MS) || 10 * 60 * 1000;
const JOB_SWEEP_INTERVAL_MS = Number(process.env.OCR_JOB_SWEEP_MS) || 60 * 1000;

// In-memory job store (mirrors the pattern already used for the login rate
// limiter in cirl.js) — fine for a single-instance capstone deployment.
const jobs = new Map();

// 2026-11 upload/OCR performance investigation: this used to only `jobs.delete(id)` — the in-memory job
// record disappeared, but an unconfirmed job's temp file (set on the job as `tempFilePath` once OCR
// finishes; see runJob()) was never unlinked, so a user who extracted a document and then just closed the
// tab or the modal (without clicking either Save or Discard) leaked that file in uploads/tmp permanently —
// nothing left to ever clean it up once the job itself expired. Deleting the file here, right before the
// job record that was the only reference to its path, closes that leak at its one root cause instead of
// trying to catch every caller that might abandon a job without discarding it.
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (now - job.createdAt > JOB_TTL_MS) {
      if (job.tempFilePath) fs.unlink(job.tempFilePath, () => {});
      jobs.delete(id);
    }
  }
}, JOB_SWEEP_INTERVAL_MS).unref();

// uploadedByEmail is stored on the job itself (not just passed through to
// runJob) so GET /api/ocr/status/:jobId can enforce ownership (S15, Roadmap
// v2 Phase G6, docs/SYSTEM_AUDIT_2026-07-16.md) — previously any
// requireUploader session could poll any other user's job by jobId.
function createJob(uploadedByEmail) {
  const id = crypto.randomUUID();
  jobs.set(id, { status: 'processing', progress: 0, stage: 'queued', result: null, error: null, createdAt: Date.now(), uploadedByEmail: uploadedByEmail || null });
  return id;
}

function updateJob(id, patch) {
  const job = jobs.get(id);
  if (job) Object.assign(job, patch);
}

function getJob(id) {
  return jobs.get(id) || null;
}

async function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// ── Image preprocessing (sharp) ───────────────────────────────────────────────
// Grayscale + normalize + upscale small images — improves Tesseract accuracy
// on low-resolution phone photos of printed documents.
async function preprocessImage(input) {
  const image = sharp(input).rotate(); // auto-orient using EXIF
  const meta = await image.metadata();
  let pipeline = image.grayscale().normalize();
  if (meta.width && meta.width < 1500) {
    pipeline = pipeline.resize({ width: Math.min(meta.width * 2, 3000) });
  }
  return pipeline.toBuffer();
}

// ── Core OCR over a single image buffer ───────────────────────────────────────
// `worker`, when passed, is used as-is and left running — the caller owns its lifecycle (see
// processPdf()'s multi-page loop below, which creates one and reuses it across every page instead of
// paying Tesseract's WASM-core-plus-language-data startup cost on every single page). With no worker
// passed, behavior is exactly what it always was: create one, recognize once, terminate — still the
// right choice for processImage() below, which only ever has the one page to do.
async function ocrImage(buffer, onProgress, worker) {
  const ownWorker = !worker;
  if (ownWorker) {
    worker = await Tesseract.createWorker('eng', 1, {
      logger: (m) => {
        if (m.status === 'recognizing text' && typeof onProgress === 'function') {
          onProgress(m.progress);
        }
      }
    });
  }
  try {
    const { data } = await worker.recognize(buffer);
    return { text: data.text || '', confidence: data.confidence || 0 };
  } finally {
    if (ownWorker) await worker.terminate();
  }
}

// One worker for an entire multi-page job, created once and reused for every page — the expensive part of
// Tesseract.js is createWorker() (loading the WASM core and the English language data), not recognize()
// itself, so a 5-page scan used to pay that startup cost 5 times over for no reason. Tesseract.js's logger
// is fixed at worker-creation time, but each page needs ITS OWN progress callback (a different
// pageBaseProgress per iteration — see processPdf()'s loop below) — so the logger here calls through a
// mutable holder the loop repoints before every recognize() call, instead of baking in one fixed callback.
async function createReusableWorker() {
  const handler = { current: null };
  const worker = await Tesseract.createWorker('eng', 1, {
    logger: (m) => {
      if (m.status === 'recognizing text' && typeof handler.current === 'function') handler.current(m.progress);
    }
  });
  return { worker, setProgressHandler: (fn) => { handler.current = fn; } };
}

// Rasterizes every page of a PDF to PNG in a child process. Isolation is
// required here: pdf-parse and pdf-to-png-converter bundle incompatible major
// versions of pdfjs-dist, and loading both in one process trips pdfjs's own
// "API version does not match Worker version" guard.
function rasterizePdfPages(filePath, outDir) {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [path.join(__dirname, 'pdfRasterWorker.js'), filePath, outDir],
      { maxBuffer: 10 * 1024 * 1024, timeout: OCR_TIMEOUT_MS },
      (err, stdout) => {
        if (err) return reject(new Error('Failed to render PDF pages: ' + err.message));
        let parsed;
        try {
          parsed = JSON.parse(stdout);
        } catch {
          return reject(new Error('Failed to render PDF pages (unexpected renderer output).'));
        }
        if (!parsed.success) return reject(new Error(parsed.error || 'Failed to render PDF pages.'));
        resolve(parsed.files);
      }
    );
  });
}

// ── Multiple photos → one merged PDF (2026-11 multi-photo upload) ───────────
// Rather than inventing a separate "multi-image OCR" code path, N selected photos (one per page of the
// same physical document) are combined into ONE PDF — one page per photo, in selection order — which then
// runs through processPdf() below completely unchanged: same rasterization, same reused-Tesseract-worker
// per-page loop, same confidence averaging, same image-quality check on page 1, same single tempFilePath
// handed to archiveToDocumentLibrary() on confirm. This guarantees exactly one physical file and one
// Document Library record for the whole set, never N unrelated ones.
//
// RASTER_SCALE mirrors services/pdfRasterWorker.js's viewportScale (3, ~216 DPI) — a merged page's PDF
// point-size is the photo's own pixel size divided by this same factor, so rasterizing it back for OCR
// reproduces roughly the photo's original resolution instead of needlessly blowing it up or softening it.
// If pdfRasterWorker.js's viewportScale ever changes, this constant should change with it.
const RASTER_SCALE = 3;
function pxToPagePoints(px) {
  return Math.max(1, Math.round((px || 1000) / RASTER_SCALE));
}

async function mergeImagesToPdf(imagePaths, outPath) {
  const doc = new PDFDocument({ autoFirstPage: false });
  const stream = fs.createWriteStream(outPath);
  const finished = new Promise((resolve, reject) => {
    stream.on('finish', resolve);
    stream.on('error', reject);
    doc.on('error', reject);
  });
  doc.pipe(stream);
  for (const imgPath of imagePaths) {
    // EXIF-auto-orient via sharp first — pdfkit does not read EXIF orientation itself, and
    // preprocessImage() below already relies on the same rotate() convention for consistency.
    const rotatedBuffer = await sharp(imgPath).rotate().toBuffer();
    const meta = await sharp(rotatedBuffer).metadata();
    const w = pxToPagePoints(meta.width);
    const h = pxToPagePoints(meta.height);
    doc.addPage({ size: [w, h], margin: 0 });
    doc.image(rotatedBuffer, 0, 0, { width: w, height: h });
  }
  doc.end();
  await finished;
  return outPath;
}

// ── PDF handling: embedded-text fast path, OCR fallback for scanned pages ────
async function processPdf(filePath, jobId) {
  const buffer = await fsp.readFile(filePath);
  const parser = new PDFParse({ data: buffer });
  let embeddedText = '';
  let pageCount = 0;
  try {
    const parsed = await parser.getText();
    embeddedText = (parsed.pages || []).map((p) => p.text || '').join('\n\n').trim();
    pageCount = (parsed.pages || []).length;
  } finally {
    await parser.destroy();
  }

  if (embeddedText.length >= MIN_EMBEDDED_TEXT_LENGTH) {
    // Digitally created PDF — the text layer IS the ground truth, no OCR needed.
    // No rasterized page image exists on this fast path, so there's nothing
    // for the image-quality checks (section 8) to analyze.
    updateJob(jobId, { progress: 90, stage: 'extracting-text-layer' });
    return { text: embeddedText, confidence: 100, method: 'text-layer', pages: pageCount, imageQuality: null };
  }

  // Likely a scanned/image-based PDF — rasterize every page and OCR each one.
  updateJob(jobId, { progress: 15, stage: 'rendering-pdf-pages' });
  const pageDir = path.join(UPLOAD_DIR, `pages-${jobId}`);
  await fsp.mkdir(pageDir, { recursive: true });

  let pageFiles = [];
  try {
    pageFiles = await rasterizePdfPages(filePath, pageDir);
    if (pageFiles.length === 0) throw new Error('The PDF has no pages to process.');

    // Image quality (section 8) is analyzed once, on the first page only —
    // running it per-page for a multi-page scan would add real latency for
    // marginal benefit, and the first page is representative of how the
    // whole document was scanned.
    const firstPageBuffer = await fsp.readFile(pageFiles[0]);
    const imageQuality = await analyzeImageQuality(firstPageBuffer).catch(() => ({ metrics: {}, warnings: [] }));

    const texts = [];
    const confidences = [];
    // One Tesseract worker for every page in this job instead of one per page (2026-11 performance
    // investigation) — createWorker()'s WASM-core-plus-language-data load is the actual expensive step,
    // not recognize(), so a 5-page scanned MOA/MOU used to pay full Tesseract startup cost 5 separate
    // times for no reason. Always terminated below, success or failure, same as the old per-page worker
    // was.
    const { worker, setProgressHandler } = await createReusableWorker();
    try {
      for (let i = 0; i < pageFiles.length; i++) {
        const pageBaseProgress = 20 + Math.round((i / pageFiles.length) * 65);
        updateJob(jobId, { progress: pageBaseProgress, stage: `ocr-page-${i + 1}-of-${pageFiles.length}` });

        const pageBuffer = await fsp.readFile(pageFiles[i]);
        const processed = await preprocessImage(pageBuffer);
        setProgressHandler((p) => {
          updateJob(jobId, { progress: pageBaseProgress + Math.round((p * 65) / pageFiles.length) });
        });
        const { text, confidence } = await ocrImage(processed, null, worker);
        texts.push(text);
        confidences.push(confidence);
      }
    } finally {
      await worker.terminate();
    }

    const avgConfidence = confidences.length
      ? Math.round(confidences.reduce((a, b) => a + b, 0) / confidences.length)
      : 0;

    return { text: texts.join('\n\n'), confidence: avgConfidence, method: 'ocr', pages: pageFiles.length, imageQuality };
  } finally {
    // Rendered page images are scratch output — clean them up regardless of outcome.
    await fsp.rm(pageDir, { recursive: true, force: true });
  }
}

async function processImage(filePath, jobId) {
  updateJob(jobId, { progress: 15, stage: 'preprocessing-image' });
  const buffer = await fsp.readFile(filePath);

  // Image quality (section 8) runs against the original upload, before the
  // grayscale/normalize/upscale preprocessing below — that preprocessing is
  // meant to help Tesseract, but would mask the very issues (low-res, dark,
  // blurry) the user actually needs to be warned about.
  const imageQuality = await analyzeImageQuality(buffer).catch(() => ({ metrics: {}, warnings: [] }));

  const processed = await preprocessImage(buffer);

  updateJob(jobId, { progress: 25, stage: 'ocr-image' });
  const { text, confidence } = await ocrImage(processed, (p) => {
    updateJob(jobId, { progress: 25 + Math.round(p * 65) });
  });

  return { text, confidence, method: 'ocr', pages: 1, imageQuality };
}

// ── Orchestration for a single uploaded file, tracked by jobId ───────────────
// NOTE: This function deliberately does NOT persist anything to the database.
// The uploaded file is kept in the temp uploads directory while the job is
// live; permanent archiving to the Document Library only happens when the user
// explicitly confirms via POST /api/ocr/confirm (handled in ocrController).
async function runJob(jobId, filePath, mimetype, meta = {}) {
  const startedAt = Date.now();
  try {
    updateJob(jobId, { progress: 5, stage: 'starting' });

    const ocrResult = await withTimeout(
      mimetype === 'application/pdf' ? processPdf(filePath, jobId) : processImage(filePath, jobId),
      OCR_TIMEOUT_MS,
      'OCR processing timed out. Try a smaller file or a clearer scan.'
    );

    const rawText = (ocrResult.text || '').trim();
    if (!rawText) {
      throw new Error('No readable text was found in the uploaded document.');
    }

    updateJob(jobId, { progress: 95, stage: 'extracting-fields' });
    const fields = extractFields(rawText);

    // Compute file hash for duplicate detection and document identity
    try {
      const fileBuffer = await fsp.readFile(filePath);
      meta.fileHash = crypto.createHash('sha256').update(fileBuffer).digest('hex');
    } catch (hashErr) {
      console.warn('Unable to compute file hash for duplicate detection:', hashErr && hashErr.message);
    }

    // Duplicate detection — best-effort, never fails the job.
    let duplicateWarning = { found: false, matches: [] };
    try {
      duplicateWarning = await findPossibleDuplicates(getDb(), fields, meta);
    } catch { /* duplicate check is best-effort */ }

    const processingTimeMs = Date.now() - startedAt;
    const result = {
      rawText,
      confidence: ocrResult.confidence,
      language: 'eng',
      processingTimeMs,
      method: ocrResult.method,
      pages: ocrResult.pages,
      warning: ocrResult.confidence < LOW_CONFIDENCE_THRESHOLD
        ? 'Low OCR confidence — please double-check the extracted data carefully before saving.'
        : null,
      imageQuality: ocrResult.imageQuality || null,
      duplicateWarning,
      ...fields
    };

    // Store the temp file path and meta on the job so confirmJob() can archive it later.
    updateJob(jobId, { status: 'done', progress: 100, stage: 'done', result, tempFilePath: filePath, meta });
  } catch (err) {
    // On failure, clean up the temp file and mark the job as errored.
    // Nothing is saved to the Document Library — the user simply sees an error.
    // The real error (a Tesseract/PDF-rasterization/filesystem failure, etc.) is logged here — this
    // catch previously stored err.message directly on the job with no server-side log at all, so a
    // real failure was both leaked to the client (GET /api/ocr/status/:jobId returns job.error
    // verbatim) and undiagnosable afterward.
    console.error('❌ OCR job failed:', jobId, err);
    fs.unlink(filePath, () => {});
    updateJob(jobId, { status: 'error', progress: 100, stage: 'error', error: 'OCR processing failed. Please try again.', tempFilePath: null });
  }
}

// ── Confirm: permanently archive a completed OCR job to the Document Library ──
// Called by POST /api/ocr/confirm after the user reviews and explicitly saves.
// `overrides` contains any field values the user edited in the results form.
// `extraMeta` (2026-11 New Partnership / Document Library investigation) carries archival metadata that
// isn't an extracted/editable field at all — today just { partnershipId }, set only by the Add New
// Partnership flow once its own save actually succeeds (see registry-gridjs.init.js), so a partnership
// that never ends up created never gets a document archived for it either — nothing to roll back.
async function confirmJob(jobId, overrides = {}, session = {}, extraMeta = {}) {
  const job = jobs.get(jobId);
  if (!job) throw new Error('Job not found or has expired.');
  if (job.status !== 'done') throw new Error('Job is not in a completed state.');
  if (!job.tempFilePath) throw new Error('Temporary file is no longer available (already confirmed or timed out).');

  // Merge user edits into the extracted result before archiving.
  const extraction = Object.assign({}, job.result, overrides);
  const meta = Object.assign({}, job.meta, extraMeta, {
    uploadedBy: session.name || job.meta.uploadedBy || 'Unknown',
    uploadedByEmail: session.email || job.meta.uploadedByEmail || null
  });

  try {
    const archived = await archiveToDocumentLibrary(job.tempFilePath, meta.originalName, extraction, meta);
    // Mark the job as confirmed so it cannot be confirmed again and its temp path is cleared.
    updateJob(jobId, { confirmed: true, tempFilePath: null, documentId: archived.documentId, fileLink: archived.fileLink });
    // Notify the uploader's open Document Library tab so it can refresh.
    if (meta.uploadedByEmail) {
      realtime.publish('document.updated', { id: archived.documentId, action: 'created' }, realtime.audience.emails([meta.uploadedByEmail]));
    }
    return archived;
  } catch (err) {
    throw new Error('Failed to save the document to the library: ' + err.message);
  }
}

// ── Discard: delete the temporary file without creating any DB record ──────────
// Called by POST /api/ocr/discard when the user cancels or closes the modal.
async function discardJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return; // already expired or never existed — nothing to do
  if (job.confirmed) return; // already confirmed — don't delete the archived file
  if (job.tempFilePath) {
    fs.unlink(job.tempFilePath, () => {});
  }
  jobs.delete(jobId);
}

function startJob(filePathOrPaths, mimetype, meta) {
  const jobId = createJob(meta && meta.uploadedByEmail);
  if (Array.isArray(filePathOrPaths)) {
    // Multi-photo job (2026-11): merge into one PDF first, then hand off to the exact same runJob() path
    // a single-PDF upload already uses — see mergeImagesToPdf()'s comment above for why.
    (async () => {
      const mergedPath = path.join(UPLOAD_DIR, `merged-${jobId}.pdf`);
      updateJob(jobId, { progress: 5, stage: 'combining-photos' });
      try {
        await mergeImagesToPdf(filePathOrPaths, mergedPath);
      } catch (err) {
        console.error('❌ OCR photo-merge failed:', jobId, err);
        await Promise.all(filePathOrPaths.map((p) => fsp.unlink(p).catch(() => {})));
        await fsp.unlink(mergedPath).catch(() => {});
        updateJob(jobId, { status: 'error', progress: 100, stage: 'error', error: 'Could not combine the selected photos. Please try again.', tempFilePath: null });
        return;
      }
      // Originals are now embedded in the merged PDF — no longer needed.
      await Promise.all(filePathOrPaths.map((p) => fsp.unlink(p).catch(() => {})));
      runJob(jobId, mergedPath, 'application/pdf', meta); // fire-and-forget; progress/result polled via getJob()
    })();
  } else {
    runJob(jobId, filePathOrPaths, mimetype, meta); // fire-and-forget; progress/result polled via getJob()
  }
  return jobId;
}

module.exports = { startJob, getJob, confirmJob, discardJob };
