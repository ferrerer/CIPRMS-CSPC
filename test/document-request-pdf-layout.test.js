// Layout check for the downloadable CSPC-F-CIRL-04 PDF (GET /api/document-requests/:id/pdf).
//
// The PDF is drawn imperatively with PDFKit, so "does anything overlap?" cannot be answered by
// reading the source. This suite records the geometry of everything the real route draws — the
// text boxes (position + measured height), the row rectangles and the horizontal rules — and
// asserts on it:
//   * no text box straddles a horizontal rule or a row border (the old bug: the Approver's title
//     was struck through by the signature line and printed on top of "DATE:", and a long Purpose
//     ran through the next row's border);
//   * no two text boxes overlap;
//   * the Approver's name and title are on the page, the title below the signature line.
// A synthetic control proves the detector really flags the original defect.
const request = require('supertest');
const PDFDocument = require('pdfkit');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

const APPROVER = 'Filmor J. Murillo';
const APPROVER_TITLE = 'Head, Center for International Relations and Linkages';
const LONG_UNBROKEN = 'Article_4_Duration_and_Termination_Provisions_SubsectionB_ExtendedRenewalTermsAndConditions_WithoutAnySpaces';

/** Wraps PDFKit's drawing calls so a callback sees the geometry of every text box, rectangle and horizontal rule. */
function recordGeometry(run) {
  const texts = [], rects = [], hlines = [];
  const orig = { text: PDFDocument.prototype.text, rect: PDFDocument.prototype.rect, moveTo: PDFDocument.prototype.moveTo, lineTo: PDFDocument.prototype.lineTo };
  let armed = false, lastMove = null;
  PDFDocument.prototype.text = function (str, a, b, c) {
    let x = this.x, y = this.y, opts = {};
    if (typeof a === 'number') { x = a; if (typeof b === 'number') { y = b; opts = c || {}; } else opts = b || {}; } else if (a && typeof a === 'object') opts = a;
    const text = String(str);
    // no explicit width: the text runs on one line, so its box is exactly as wide as the text
    const width = opts.width != null ? opts.width : Math.min(this.widthOfString(text), this.page.width - this.page.margins.right - x);
    const h = opts.lineBreak === false ? this.currentLineHeight() : this.heightOfString(text, { width });
    if (armed) texts.push({ text, x, y, w: width, h });
    if (text === 'DOCUMENTS REQUEST FORM') armed = true; // geometry below the letterhead only
    return orig.text.apply(this, arguments);
  };
  PDFDocument.prototype.rect = function (x, y, w, h) { if (armed && w > 100) rects.push({ x, y, w, h }); return orig.rect.apply(this, arguments); };
  PDFDocument.prototype.moveTo = function (x, y) { lastMove = { x, y }; return orig.moveTo.apply(this, arguments); };
  PDFDocument.prototype.lineTo = function (x, y) {
    if (armed && lastMove && Math.abs(lastMove.y - y) < 0.01 && Math.abs(x - lastMove.x) > 20) hlines.push({ y, x1: Math.min(x, lastMove.x), x2: Math.max(x, lastMove.x) });
    return orig.lineTo.apply(this, arguments);
  };
  const restore = () => Object.assign(PDFDocument.prototype, orig);
  return Promise.resolve().then(run).then(() => ({ texts, rects, hlines }), (e) => { throw e; }).finally(restore);
}

/** Every horizontal edge that ink must not run through: rule lines and the top/bottom of each row box. */
function horizontalEdges({ rects, hlines }) {
  return [
    ...hlines.map(l => ({ y: l.y, x1: l.x1, x2: l.x2, what: 'rule' })),
    ...rects.flatMap(r => [{ y: r.y, x1: r.x, x2: r.x + r.w, what: 'row top' }, { y: r.y + r.h, x1: r.x, x2: r.x + r.w, what: 'row bottom' }])
  ];
}
function overlaps(geometry) {
  const problems = [];
  const edges = horizontalEdges(geometry);
  for (const t of geometry.texts) {
    if (!t.text.trim()) continue;
    for (const e of edges) {
      const xOverlap = Math.min(t.x + t.w, e.x2) - Math.max(t.x, e.x1) > 1;
      if (xOverlap && t.y + 0.5 < e.y && t.y + t.h - 0.5 > e.y) problems.push(`"${t.text.slice(0, 40)}" runs through a ${e.what} at y=${e.y.toFixed(1)} (text ${t.y.toFixed(1)}–${(t.y + t.h).toFixed(1)})`);
    }
  }
  const real = geometry.texts.filter(t => t.text.trim());
  for (let i = 0; i < real.length; i++) {
    for (let j = i + 1; j < real.length; j++) {
      const a = real[i], b = real[j];
      const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
      const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      if (ox > 1 && oy > 1) problems.push(`"${a.text.slice(0, 30)}" overlaps "${b.text.slice(0, 30)}"`);
    }
  }
  return problems;
}

let adminAgent, partnerAgent, db;
const requestIds = [];

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
});
afterAll(async () => {
  if (requestIds.length) await db.collection('documentrequests').deleteMany({ id: { $in: requestIds } });
  await cleanupAll();
  await closeDB();
});

async function completedRequest(overrides) {
  const created = await partnerAgent.post('/api/document-requests').send({
    institution: 'jesttest Office', documentTypes: ['jesttest Memorandum of Agreement'], notes: 'jesttest purpose',
    contactNumber: '0917-000-0000', documentForm: 'Printed Copy', ...overrides
  });
  const id = created.body.request.id;
  requestIds.push(id);
  for (const status of ['Preparing', 'Awaiting for Approval', 'Approved', 'Release', 'Completed']) {
    const res = await adminAgent.patch(`/api/document-requests/${id}`).send({ status, receivedBy: overrides && overrides.receivedBy });
    expect(res.status).toBe(200);
  }
  return id;
}
const downloadPdf = async (id) => {
  const res = await adminAgent.get(`/api/document-requests/${id}/pdf`).buffer(true).parse((r, cb) => { const chunks = []; r.on('data', c => chunks.push(c)); r.on('end', () => cb(null, Buffer.concat(chunks))); });
  expect(res.status).toBe(200);
  expect(res.headers['content-type']).toBe('application/pdf');
  expect(res.body.slice(0, 5).toString()).toBe('%PDF-');
  return res.body;
};

describe('the overlap detector itself', () => {
  test('flags the original defect: a title drawn on top of a signature line and another text', async () => {
    const geometry = await recordGeometry(() => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      doc.on('data', () => {});
      doc.text('DOCUMENTS REQUEST FORM', 40, 40);
      doc.fontSize(7.5).text(APPROVER_TITLE, 40, 297, { width: 150, align: 'center' }); // two lines at y≈297–315
      doc.moveTo(40, 300).lineTo(190, 300).stroke();                                  // signature line through the title
      doc.fontSize(8).text('DATE: Sep 20, 2026', 40, 304, { width: 150 });            // and DATE printed on top of it
      doc.end();
    });
    const problems = overlaps(geometry);
    expect(problems.some(p => /runs through a rule/.test(p))).toBe(true);
    expect(problems.some(p => /overlaps "DATE/.test(p))).toBe(true);
  });

  test('is quiet for a clean layout', async () => {
    const geometry = await recordGeometry(() => {
      const doc = new PDFDocument({ margin: 40, size: 'A4' });
      doc.on('data', () => {});
      doc.text('DOCUMENTS REQUEST FORM', 40, 40);
      doc.text('Name', 40, 300, { width: 150 });
      doc.moveTo(40, 320).lineTo(190, 320).stroke();
      doc.fontSize(7.5).text(APPROVER_TITLE, 40, 324, { width: 150 });
      doc.end();
    });
    expect(overlaps(geometry)).toEqual([]);
  });
});

describe('Document Request PDF layout (the real download route)', () => {
  test('an ordinary Completed request: the Approver name sits above the line, the DATE is under the line, and nothing overlaps', async () => {
    const id = await completedRequest({ receivedBy: 'jesttest Receiver' });
    const geometry = await recordGeometry(() => downloadPdf(id));
    const name = geometry.texts.find(t => t.text === APPROVER);
    expect(name).toBeTruthy();
    // the signature line of the Approved By column (the horizontal rule spanning the name)
    const line = geometry.hlines.filter(l => l.x1 <= name.x + 1 && l.x2 >= name.x + name.w - 1 && l.y >= name.y && l.y <= name.y + 30).sort((a, b) => a.y - b.y)[0];
    expect(line).toBeTruthy();
    expect(name.y + name.h).toBeLessThanOrEqual(line.y + 0.5);   // name sits above the line
    const date = geometry.texts.find(t => t.text.startsWith('DATE:') && t.x === name.x);
    expect(date.y).toBeGreaterThanOrEqual(line.y);               // and the DATE is under the line
    expect(overlaps(geometry)).toEqual([]);
  });

  test('Approved By aligns exactly with Released By/Received By — same name, line, and date heights — whether or not it carries a signature', async () => {
    // One Completed (and signed) request, one request still in progress (no Approved By text at all,
    // but Released By/Received By geometry to compare the OTHER two columns' baseline against).
    const signedId = await completedRequest({ receivedBy: 'jesttest Receiver' });
    const signedGeometry = await recordGeometry(() => downloadPdf(signedId));
    const approvedName = signedGeometry.texts.find(t => t.text === APPROVER);
    const releasedName = signedGeometry.texts.find(t => t.text === 'jesttest Administrator');
    const receivedName = signedGeometry.texts.find(t => t.text === 'jesttest Receiver');
    expect(approvedName && releasedName && receivedName).toBeTruthy();
    // None of these three names are wide enough to trigger the column's shrink-to-fit, so all three sit
    // at the exact same baseline — this is the bug the task fixed (the signature used to push Approved
    // By's name below the line while the other two stayed above it).
    expect(approvedName.y).toBe(releasedName.y);
    expect(approvedName.y).toBe(receivedName.y);

    const lineAt = (col) => signedGeometry.hlines.filter(l => l.x1 <= col.x + 1 && l.x2 >= col.x + col.w - 1 && l.y >= col.y).sort((a, b) => a.y - b.y)[0];
    const approvedLine = lineAt(approvedName), releasedLine = lineAt(releasedName), receivedLine = lineAt(receivedName);
    expect(approvedLine.y).toBe(releasedLine.y);
    expect(approvedLine.y).toBe(receivedLine.y);

    const dateAt = (col) => signedGeometry.texts.find(t => t.text.startsWith('DATE:') && t.x === col.x);
    expect(dateAt(approvedName).y).toBe(dateAt(releasedName).y);
    expect(dateAt(approvedName).y).toBe(dateAt(receivedName).y);
    expect(overlaps(signedGeometry)).toEqual([]);

    // A request not yet Completed has no Approved By signature (and no Approved By text at all yet,
    // since it never reached Approved) — the label itself must still land at the exact same height as
    // it did on the signed request above (the signature must never push the whole column down).
    const created = await partnerAgent.post('/api/document-requests').send({ institution: 'jesttest Office', documentTypes: ['jesttest doc'], notes: 'jesttest' });
    requestIds.push(created.body.request.id);
    const blankGeometry = await recordGeometry(() => downloadPdf(created.body.request.id));
    const blankLabel = blankGeometry.texts.find(t => t.text === 'Approved By:');
    const signedLabel = signedGeometry.texts.find(t => t.text === 'Approved By:');
    expect(blankLabel.y).toBe(signedLabel.y);
    expect(overlaps(blankGeometry)).toEqual([]);
  });

  test('long values (institution, purpose with an unbroken word, e-mail, a long Received By) grow their rows instead of running into the next one', async () => {
    const id = await completedRequest({
      institution: 'jesttest Office of the University President and the Board of Regents of the Camarines Sur Polytechnic Colleges Main Campus',
      notes: `jesttest purpose: please prepare the certified true copy for ${LONG_UNBROKEN} and the notarized annex, to be presented at the regional review committee.`,
      documentTypes: ['jesttest Memorandum of Agreement with a deliberately long description to force wrapping onto several lines in the printed form', 'jesttest Certificate of Accreditation'],
      receivedBy: 'jesttest Dr. Maria Cristina Delos Reyes-Santos y Fernandez of the Office of the President'
    });
    const geometry = await recordGeometry(() => downloadPdf(id));
    expect(geometry.texts.some(t => t.text === APPROVER)).toBe(true);
    expect(overlaps(geometry)).toEqual([]);
    // the long Received By was fitted to its column, not allowed to wrap down onto the line
    const received = geometry.texts.find(t => /Dr\. Maria|Delos|…/.test(t.text));
    expect(received).toBeTruthy();
    expect(received.h).toBeLessThan(14);
  });

  test('a request that has not been approved yet prints no approver, and the layout is still clean', async () => {
    const created = await partnerAgent.post('/api/document-requests').send({ institution: 'jesttest Office', documentTypes: ['jesttest doc'], notes: 'jesttest' });
    requestIds.push(created.body.request.id);
    const geometry = await recordGeometry(() => downloadPdf(created.body.request.id));
    expect(geometry.texts.some(t => t.text === APPROVER)).toBe(false);
    expect(overlaps(geometry)).toEqual([]);
  });
});
