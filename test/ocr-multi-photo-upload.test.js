// Multiple photo uploads for OCR/IDP extraction (2026-11) — Administrator/Staff can select several JPG/PNG
// photos of one physical document (e.g. one photo per page) in a single extraction instead of being limited
// to one file. They are merged into ONE PDF server-side (services/ocrService.js mergeImagesToPdf) and run
// through the exact same, unchanged processPdf() pipeline a real scanned-PDF upload already uses — so this
// file proves: (a) multiple photos produce exactly one merged result/one archived document, never several,
// (b) the legacy single-file 'document' field is completely unaffected, (c) per-file validation (magic
// bytes, count limit) still applies to the new 'documents' field.
// Real Tesseract + real PDF rasterization (same as test/ocr-pipeline-live.test.js) — no OCR engine mocking.
jest.setTimeout(60000);

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ciprms-ocr-multi-'));
const tmpFiles = [];
function tmpPath(name) { const p = path.join(TMP, name); tmpFiles.push(p); return p; }

async function renderTextImage(lines, outPath, width) {
  width = width || 1000;
  const lineHeight = 46, height = lines.length * lineHeight + 40;
  const text = lines.map((l, i) => `<text x="20" y="${40 + i * lineHeight}" font-size="30" font-family="sans-serif" fill="black">${l.replace(/&/g, '&amp;')}</text>`).join('');
  const svg = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="white"/>${text}</svg>`);
  await sharp(svg).png().toFile(outPath);
  return outPath;
}

let agent, db;

beforeAll(async () => {
  db = await connectDB();
  const user = await createTestUser({ role: 'Staff' }); // Staff, not Administrator — confirms this isn't Admin-only
  agent = request.agent(app);
  await loginAs(agent, user);
});

afterAll(async () => {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {}
  await cleanupAll();
  await closeDB();
});

async function pollUntilDone(jobId) {
  const deadline = Date.now() + 45000;
  let last;
  while (Date.now() < deadline) {
    const res = await agent.get('/api/ocr/status/' + jobId);
    expect(res.status).toBe(200);
    last = res.body;
    if (last.status === 'done' || last.status === 'error') return last;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('OCR job did not finish within the test deadline: ' + JSON.stringify(last));
}

describe('Multiple photos — one merged extraction', () => {
  let jobId, result;

  beforeAll(async () => {
    const p1 = tmpPath('page1.png');
    const p2 = tmpPath('page2.png');
    const p3 = tmpPath('page3.png');
    await renderTextImage(['MEMORANDUM OF UNDERSTANDING', 'Between CSPC and ABC Institute of Testland.'], p1, 1400);
    await renderTextImage(['Page Two: Terms and Conditions apply as stated herein.'], p2, 1400);
    await renderTextImage(['Page Three: Signed and effective January 10, 2026 through January 10, 2031.'], p3, 1400);

    const startRes = await agent.post('/api/ocr/extract')
      .attach('documents', p1)
      .attach('documents', p2)
      .attach('documents', p3);
    expect(startRes.status).toBe(202);
    jobId = startRes.body.jobId;
    result = await pollUntilDone(jobId);
  });

  test('all three photos are combined into one job producing one 3-page result', () => {
    expect(result.status).toBe('done');
    expect(result.result.pages).toBe(3);
    expect(result.result.method).toBe('ocr');
  });

  test('extracted text includes content from every photo, in selection order', () => {
    const text = result.result.rawText;
    expect(text).toMatch(/MEMORANDUM OF UNDERSTANDING/i);
    expect(text).toMatch(/Terms and Conditions/i);
    expect(text).toMatch(/Signed and effective/i);
    expect(text.indexOf('MEMORANDUM')).toBeLessThan(text.indexOf('Terms and Conditions'));
    expect(text.indexOf('Terms and Conditions')).toBeLessThan(text.indexOf('Signed and effective'));
  });

  test('confirming the job archives exactly ONE Document Library record for all three photos', async () => {
    const before = await db.collection('documents').countDocuments({});
    const confirmRes = await agent.post('/api/ocr/confirm').send({ jobId, title: 'jesttest Combined MOU' });
    expect(confirmRes.status).toBe(200);
    expect(confirmRes.body.success).toBe(true);
    expect(confirmRes.body.documentId).toBeTruthy();
    const after = await db.collection('documents').countDocuments({});
    expect(after - before).toBe(1); // exactly one new record, never three

    const doc = await db.collection('documents').findOne({ id: confirmRes.body.documentId });
    expect(doc).toBeTruthy();
    expect(doc.fileLink).toMatch(/\.pdf$/); // archived as the one merged PDF, not a .png
  });
});

describe('A single photo sent under the new "documents" field still works', () => {
  test('one photo via "documents" behaves like a normal 1-page extraction', async () => {
    const p = tmpPath('single-via-plural.png');
    await renderTextImage(['SINGLE PHOTO VIA PLURAL FIELD'], p, 1200);
    const startRes = await agent.post('/api/ocr/extract').attach('documents', p);
    expect(startRes.status).toBe(202);
    const result = await pollUntilDone(startRes.body.jobId);
    expect(result.status).toBe('done');
    expect(result.result.pages).toBe(1);
    expect(result.result.rawText).toMatch(/SINGLE PHOTO VIA PLURAL FIELD/i);
    await agent.post('/api/ocr/discard').send({ jobId: startRes.body.jobId });
  });
});

describe('The legacy single-file "document" field is unaffected', () => {
  test('a single image via the original field name still extracts normally', async () => {
    const p = tmpPath('legacy-single.png');
    await renderTextImage(['LEGACY SINGLE FIELD STILL WORKS'], p, 1200);
    const startRes = await agent.post('/api/ocr/extract').attach('document', p);
    expect(startRes.status).toBe(202);
    const result = await pollUntilDone(startRes.body.jobId);
    expect(result.status).toBe('done');
    expect(result.result.pages).toBe(1);
    expect(result.result.rawText).toMatch(/LEGACY SINGLE FIELD STILL WORKS/i);
    await agent.post('/api/ocr/discard').send({ jobId: startRes.body.jobId });
  });
});

describe('Per-file validation on the "documents" field', () => {
  test('a mixed valid+invalid batch is rejected entirely, naming the bad file, and leaves no files on disk', async () => {
    const uploadsTmp = path.join(__dirname, '..', 'uploads', 'tmp');
    const before = new Set(fs.readdirSync(uploadsTmp));

    const good = tmpPath('mixed-good.png');
    await renderTextImage(['GOOD FILE'], good, 800);
    const fakePath = tmpPath('mixed-fake.png'); // .png extension, but not real PNG bytes — fails magic-byte check
    fs.writeFileSync(fakePath, 'not a real png file, just text pretending to be one');

    const res = await agent.post('/api/ocr/extract')
      .attach('documents', good)
      .attach('documents', fakePath);
    expect(res.status).toBe(400);
    expect(res.body.success).toBeFalsy();
    expect(res.body.error).toMatch(/mixed-fake\.png/);
    // No jobId is ever returned — the batch was rejected before ocrController.extract() (and therefore
    // ocrService.startJob()) ran at all, so there is no in-memory job and no OCR work was ever attempted
    // on the good file either.
    expect(res.body.jobId).toBeUndefined();

    // Give the fire-and-forget fs.unlink() calls a moment, then confirm uploads/tmp is back to exactly
    // what it was before this request — neither the bad file nor its good sibling was left behind.
    await new Promise((r) => setTimeout(r, 700));
    const after = new Set(fs.readdirSync(uploadsTmp));
    expect(after).toEqual(before);
  });

  test('exceeding the maximum photo count (10) is rejected with a clear error, and leaves no files behind', async () => {
    const uploadsTmp = path.join(__dirname, '..', 'uploads', 'tmp');
    const before = new Set(fs.readdirSync(uploadsTmp));

    const imgs = [];
    for (let i = 0; i < 11; i++) {
      const p = tmpPath(`overflow-${i}.png`);
      await renderTextImage(['PAGE ' + i], p, 400);
      imgs.push(p);
    }
    let req = agent.post('/api/ocr/extract');
    imgs.forEach((p) => { req = req.attach('documents', p); });
    const res = await req;
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/maximum/i);

    // multer's own maxCount rejection cleans up every file it had already written for this request — no
    // extra cleanup code needed on our side, but this is exactly the "uncontrolled aggregate upload" risk
    // the 2026-11 review asked to be verified, so it's pinned here as a real assertion, not an assumption.
    await new Promise((r) => setTimeout(r, 700));
    const after = new Set(fs.readdirSync(uploadsTmp));
    expect(after).toEqual(before);
  });

  test('an oversized file (over 10MB) among several photos is rejected and leaves no files behind', async () => {
    const uploadsTmp = path.join(__dirname, '..', 'uploads', 'tmp');
    const before = new Set(fs.readdirSync(uploadsTmp));

    const small = tmpPath('small-ok.png');
    await renderTextImage(['SMALL OK'], small, 400);
    const bigPath = tmpPath('too-big.png');
    // A real PNG header followed by >10MB of filler — passes the magic-byte check, fails multer's own
    // per-file size limit first (the two checks are independent; this one must trip before the other).
    fs.writeFileSync(bigPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(11 * 1024 * 1024)]));

    const res = await agent.post('/api/ocr/extract').attach('documents', small).attach('documents', bigPath);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/too large/i);

    await new Promise((r) => setTimeout(r, 700));
    const after = new Set(fs.readdirSync(uploadsTmp));
    expect(after).toEqual(before);
  });

  test('sending both "document" and "documents" in the same request is rejected and leaks neither file (2026-11 review fix)', async () => {
    const uploadsTmp = path.join(__dirname, '..', 'uploads', 'tmp');
    const before = new Set(fs.readdirSync(uploadsTmp));

    const single = tmpPath('both-fields-single.png');
    await renderTextImage(['SINGLE FIELD FILE'], single, 400);
    const multi = tmpPath('both-fields-multi.png');
    await renderTextImage(['MULTI FIELD FILE'], multi, 400);

    const res = await agent.post('/api/ocr/extract').attach('document', single).attach('documents', multi);
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not both/i);
    expect(res.body.jobId).toBeUndefined();

    await new Promise((r) => setTimeout(r, 700));
    const after = new Set(fs.readdirSync(uploadsTmp));
    expect(after).toEqual(before);
  });
});
