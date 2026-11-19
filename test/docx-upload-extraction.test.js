// Word (.docx) upload/extraction support (2026-11). .docx goes through the exact same OCR/IDP pipeline
// as a PDF/image upload (POST /api/ocr/extract -> GET /api/ocr/status/:jobId -> POST /api/ocr/confirm),
// just with mammoth.extractRawText() standing in for Tesseract/the PDF text layer (services/ocrService.js
// processDocx()) — extractFields()/the Document Library archiving path are completely unchanged. This
// file proves: a real .docx extracts and archives correctly; a renamed ZIP/PDF claiming to be .docx is
// rejected by verifyMagicBytes' deeper ZIP-content check; .docm and legacy .doc are both rejected with a
// clear message; the existing 10MB limit still applies.
jest.setTimeout(30000);

const fs = require('fs');
const path = require('path');
const os = require('os');
const JSZip = require('jszip');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, getDb } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');
const { archiveToDocumentLibrary } = require('../services/documentLibraryService');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ciprms-docx-'));
function tmpPath(name) { return path.join(TMP, name); }

const DOCX_CONTENT_TYPES = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
  '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
  '<Default Extension="xml" ContentType="application/xml"/>' +
  '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
  '</Types>';
const DOCX_RELS = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
  '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
  '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>' +
  '</Relationships>';
function documentXml(text) {
  return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
    '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">' +
    '<w:body><w:p><w:r><w:t>' + text + '</w:t></w:r></w:p></w:body></w:document>';
}

async function buildRealDocx(text) {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', DOCX_CONTENT_TYPES);
  zip.folder('_rels').file('.rels', DOCX_RELS);
  zip.folder('word').file('document.xml', documentXml(text));
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildFakeDocx() {
  // A real zip, correctly signed, but with no word/document.xml inside — e.g. a renamed .xlsx or a plain
  // archive someone renamed to .docx.
  const zip = new JSZip();
  zip.file('readme.txt', 'this is just a plain zip, not a Word document');
  return zip.generateAsync({ type: 'nodebuffer' });
}

async function buildMacroDocx() {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', DOCX_CONTENT_TYPES);
  zip.folder('word').file('document.xml', documentXml('has a macro'));
  zip.folder('word').file('vbaProject.bin', Buffer.alloc(16));
  return zip.generateAsync({ type: 'nodebuffer' });
}

let agent, db;

beforeAll(async () => {
  db = await connectDB();
  const user = await createTestUser({ role: 'Administrator' });
  agent = request.agent(app);
  await loginAs(agent, user);
});

afterAll(async () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  await cleanupAll();
  await closeDB();
});

async function pollUntilDone(jobId) {
  const deadline = Date.now() + 15000;
  let last;
  while (Date.now() < deadline) {
    const res = await agent.get('/api/ocr/status/' + jobId);
    expect(res.status).toBe(200);
    last = res.body;
    if (last.status === 'done' || last.status === 'error') return last;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Job did not finish in time: ' + JSON.stringify(last));
}

describe('A valid .docx extracts text and autofills the same way OCR results do', () => {
  let jobId, result, documentId;

  test('upload + extract succeeds', async () => {
    const text = `MEMORANDUM OF UNDERSTANDING between Camarines Sur Polytechnic Colleges and ${TEST_TAG} Docx University, a research institution in Japan, effective 2025-01-01 through 2030-01-01.`;
    const buf = await buildRealDocx(text);
    const p = tmpPath('real.docx');
    fs.writeFileSync(p, buf);

    const startRes = await agent.post('/api/ocr/extract').attach('document', p);
    expect(startRes.status).toBe(202);
    jobId = startRes.body.jobId;

    const done = await pollUntilDone(jobId);
    expect(done.status).toBe('done');
    result = done.result;
  });

  test('used direct text extraction (no OCR), at full confidence', () => {
    expect(result.method).toBe('docx-text-extraction');
    expect(result.confidence).toBe(100);
  });

  test('ran the extracted text through the same field parsing OCR results use', () => {
    expect(result.partner).toMatch(new RegExp(`${TEST_TAG} Docx University`, 'i'));
    expect(result.country).toBe('Japan');
    expect(result.documentType).toMatch(/Memorandum of Understanding/i);
  });

  test('confirm archives it to the Document Library like any other upload', async () => {
    const res = await agent.post('/api/ocr/confirm').send({ jobId });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    documentId = res.body.documentId;

    const archived = await db.collection('documents').findOne({ id: documentId });
    expect(archived).toBeTruthy();
    expect(archived.fileLink).toMatch(/\.docx$/);
    expect(fs.existsSync(path.join(__dirname, '..', 'uploads', 'documents', path.basename(archived.fileLink)))).toBe(true);
    expect(archived.ocrText).toMatch(/Memorandum of Understanding/i);
  });

  test('downloading it returns the correct Content-Type and forces a download (Content-Disposition: attachment), and requireFileAccess still applies', async () => {
    const archived = await db.collection('documents').findOne({ id: documentId });
    const dl = await agent.get(archived.fileLink);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.document/);
    expect(dl.headers['content-disposition']).toMatch(/^attachment/);

    // requireFileAccess still applies: no session at all is redirected, same as any other file.
    const anon = request.agent(app);
    const dlAnon = await anon.get(archived.fileLink);
    expect(dlAnon.status).toBe(302);
  });

  afterAll(async () => {
    if (documentId) {
      const doc = await db.collection('documents').findOne({ id: documentId });
      await db.collection('documents').deleteOne({ id: documentId });
      if (doc && doc.fileLink) fs.unlink(path.join(__dirname, '..', 'uploads', 'documents', path.basename(doc.fileLink)), () => {});
    }
  });
});

describe('Rejected files', () => {
  test('a renamed zip with no word/document.xml is rejected', async () => {
    const p = tmpPath('fake-zip.docx');
    fs.writeFileSync(p, await buildFakeDocx());
    const res = await agent.post('/api/ocr/extract').attach('document', p);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('a PDF renamed to .docx (not even a real zip) is rejected', async () => {
    const p = tmpPath('fake-pdf.docx');
    fs.writeFileSync(p, Buffer.from('%PDF-1.4\n%fake pdf content pretending to be docx'));
    const res = await agent.post('/api/ocr/extract').attach('document', p);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('a macro-enabled zip (vbaProject.bin) renamed to .docx is rejected even though word/document.xml is present', async () => {
    const p = tmpPath('macro-renamed.docx');
    fs.writeFileSync(p, await buildMacroDocx());
    const res = await agent.post('/api/ocr/extract').attach('document', p);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });

  test('.docm is rejected outright with a clear message', async () => {
    const p = tmpPath('macro.docm');
    fs.writeFileSync(p, await buildRealDocx('irrelevant'));
    const res = await agent.post('/api/ocr/extract').attach('document', p);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/macro-enabled/i);
  });

  test('legacy .doc is rejected with a "save as .docx" message', async () => {
    const p = tmpPath('legacy.doc');
    fs.writeFileSync(p, Buffer.from('this would be an OLE2 legacy .doc in real life'));
    const res = await agent.post('/api/ocr/extract').attach('document', p);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/save as \.docx/i);
  });

  test('an oversized .docx is rejected (existing 10MB limit still applies)', async () => {
    const text = 'A'.repeat(1024);
    const buf = await buildRealDocx(text);
    // Pad well past 10MB with an incompressible extra entry so the file on disk exceeds the limit —
    // multer's own size limit is enforced on the raw upload stream regardless of what's inside the zip.
    const zip = new JSZip();
    zip.file('[Content_Types].xml', DOCX_CONTENT_TYPES);
    zip.folder('word').file('document.xml', documentXml(text));
    zip.file('padding.bin', require('crypto').randomBytes(11 * 1024 * 1024)); // random bytes don't compress away
    const bigBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 0 } });
    expect(bigBuf.length).toBeGreaterThan(10 * 1024 * 1024);
    const p = tmpPath('big.docx');
    fs.writeFileSync(p, bigBuf);

    const res = await agent.post('/api/ocr/extract').attach('document', p);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);
  });

  test('a zip-bomb-style .docx (tiny on disk, huge declared uncompressed size) is rejected by the 50MB guard', async () => {
    // A real zip bomb: the file on disk stays well under the 10MB upload limit (so multer lets it through),
    // but its own ZIP central directory declares a genuinely huge uncompressed size (60MB of repeated
    // zero bytes compresses to tens of KB via real DEFLATE) — exactly the case
    // MAX_DOCX_UNCOMPRESSED_BYTES in middleware/verifyMagicBytes.js exists to catch before mammoth ever
    // decompresses it. Confirms the limit (lowered from 200MB to 50MB) is actually enforced, not just
    // that the unrelated 10MB upload-size limit happens to also reject large files.
    const zip = new JSZip();
    zip.file('[Content_Types].xml', DOCX_CONTENT_TYPES);
    zip.folder('word').file('document.xml', documentXml('bomb'));
    zip.file('padding.bin', Buffer.alloc(60 * 1024 * 1024, 0));
    const bombBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 9 } });
    expect(bombBuf.length).toBeLessThan(1 * 1024 * 1024); // comfortably under the 10MB upload limit
    const p = tmpPath('bomb.docx');
    fs.writeFileSync(p, bombBuf);

    const res = await agent.post('/api/ocr/extract').attach('document', p);
    expect(res.status).toBe(400);
    expect(res.body.success).toBe(false);
  });
});

describe('Download headers: the new attachment-forcing behavior is scoped to .docx only', () => {
  let pdfDocumentId;

  afterAll(async () => {
    if (pdfDocumentId) {
      const doc = await db.collection('documents').findOne({ id: pdfDocumentId });
      await db.collection('documents').deleteOne({ id: pdfDocumentId });
      if (doc && doc.fileLink) fs.unlink(path.join(__dirname, '..', 'uploads', 'documents', path.basename(doc.fileLink)), () => {});
    }
  });

  test('a PDF archived the same way keeps the existing inline-renderable behavior (no Content-Disposition), so document_viewer.ejs\'s <iframe> preview is unaffected', async () => {
    const pdfPath = tmpPath('regression.pdf');
    fs.writeFileSync(pdfPath, Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF'));
    const { documentId: docId } = await archiveToDocumentLibrary(pdfPath, 'regression.pdf', null, { uploadedBy: 'Test', uploadedByEmail: null });
    pdfDocumentId = docId;
    const archived = await db.collection('documents').findOne({ id: docId });

    const dl = await agent.get(archived.fileLink);
    expect(dl.status).toBe(200);
    expect(dl.headers['content-type']).toMatch(/application\/pdf/);
    expect(dl.headers['content-disposition']).toBeUndefined();
  });
});

describe('EJS render check: the "Low confidence" label is gone, the allowed-types text mentions DOCX', () => {
  test('Administrator Monitoring (OCR panel)', async () => {
    const res = await agent.get('/lifecycle');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/low confidence/i);
    expect(res.text).toContain('DOCX');
  });

  test('Document Library (Upload & Extract)', async () => {
    const res = await agent.get('/documents');
    expect(res.status).toBe(200);
    expect(res.text).not.toMatch(/low confidence/i);
    expect(res.text).toContain('DOCX');
  });
});
