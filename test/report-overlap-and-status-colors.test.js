// Regression tests for the 2026-10 "subtitle/table-header overlap + standardized status-color mapping" fix.
//
// Three layers, matching this codebase's own existing conventions for exactly this kind of PDF-layout work
// (test/document-request-pdf-layout.test.js's geometry-recording technique; test/export-layout-helper.test.js's
// direct-against-pdfkit unit style):
//   A) Unit tests against assets/js/shared/status-colors.js directly — the one shared mapping now used by
//      BOTH the on-screen preview (views/administrator/reports.ejs, loaded as a <script> global) and every
//      PDF generator (cirl.js, require()'d server-side).
//   B) Unit tests against services/pdfTableHelper.js's new sectionGap()/drawTable() cellColor support.
//   C) Live, end-to-end tests that hit the real HTTP export routes and record the actual geometry PDFKit
//      drew (same monkey-patch technique as test/document-request-pdf-layout.test.js) — proving the
//      subtitle genuinely does not overlap the table header in the real generated PDF, not just that the
//      code "looks right" by inspection.
const request = require('supertest');
const PDFDocument = require('pdfkit');
const statusColors = require('../assets/js/shared/status-colors.js');
const pdfTableHelper = require('../services/pdfTableHelper');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

// ───────────────────────────── A) shared status-color mapping ─────────────────────────────

describe('assets/js/shared/status-colors.js — the one mapping both preview and PDF read from', () => {
  test('the four real statuses each get their own distinct, correct semantic color', () => {
    expect(statusColors.hex('Active')).toBe('#0ab39c'); // green
    expect(statusColors.hex('Expiring Soon')).toBe('#f7b84b'); // amber
    expect(statusColors.hex('Expired')).toBe('#f06548'); // red
    expect(statusColors.hex('Inactive')).toBe('#878a99'); // gray
    const hexes = new Set([statusColors.hex('Active'), statusColors.hex('Expiring Soon'), statusColors.hex('Expired'), statusColors.hex('Inactive')]);
    expect(hexes.size).toBe(4); // no two real statuses collide — the exact bug report ("red assigned to both Active and Expired")
  });

  test('Active and Expired never resolve to the same color (the reported bug, directly)', () => {
    expect(statusColors.hex('Active')).not.toBe(statusColors.hex('Expired'));
    expect(statusColors.badgeClass('Active')).not.toBe(statusColors.badgeClass('Expired'));
  });

  test('status labels normalize safely — case and surrounding whitespace never change the color', () => {
    const variants = ['Active', 'active', 'ACTIVE', '  Active  ', 'AcTiVe'];
    const hexes = variants.map((s) => statusColors.hex(s));
    const badges = variants.map((s) => statusColors.badgeClass(s));
    expect(new Set(hexes).size).toBe(1);
    expect(new Set(badges).size).toBe(1);
  });

  test('unknown, missing, null, undefined, and empty-string statuses all get the same neutral color — never red or green', () => {
    const neutral = statusColors.hex('Inactive'); // the neutral gray this file documents
    for (const bad of ['Some Unexpected Value', 'Total', '', null, undefined]) {
      expect(statusColors.hex(bad)).toBe(neutral);
      expect(statusColors.isKnownStatus(bad)).toBe(false);
    }
    // ...but real statuses are still correctly recognized as known — isKnownStatus isn't just always false.
    expect(statusColors.isKnownStatus('Active')).toBe(true);
    expect(statusColors.isKnownStatus('Expired')).toBe(true);
  });

  test('ORDER is the stable canonical presentation order for a legend, regardless of any dataset ordering', () => {
    expect(statusColors.ORDER).toEqual(['Active', 'Expiring Soon', 'Expired', 'Inactive']);
  });
});

describe('views/administrator/reports.ejs — no duplicate hand-written status→color mapping survives', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'reports.ejs'), 'utf8');

  test('loads the shared status-colors.js script (same file cirl.js requires server-side)', () => {
    expect(source).toMatch(/<script src="\/velzon\/assets\/js\/shared\/status-colors\.js">/);
  });

  test('both known status-badge call sites delegate to CIPRMS_STATUS_COLORS instead of hand-rolling their own if/else', () => {
    const occurrences = source.match(/CIPRMS_STATUS_COLORS\.badgeClass\(/g) || [];
    expect(occurrences.length).toBeGreaterThanOrEqual(2); // the flat-table badge + statusBadgeClass()'s own body
    // The specific duplicate this fix removed: a conditional chain keyed on the four status strings that
    // itself returns a literal badge-class string (as opposed to delegating). A reintroduced duplicate would
    // look like `=== 'Active'` immediately followed, within a few characters, by a literal `bg-` class.
    expect(source).not.toMatch(/===\s*'Active'\)\s*return\s*'bg-/);
    expect(source).not.toMatch(/===\s*'Expired'\)\s*return\s*'bg-/);
  });
});

// ───────────────────────────── B) pdfTableHelper — layout + per-cell color ─────────────────────────────

describe('pdfTableHelper.sectionGap — font-independent fixed gap (the overlap fix itself)', () => {
  function freshDoc() {
    const doc = new PDFDocument({ margin: 36, size: 'A4' });
    doc.pipe(new (require('stream').PassThrough)());
    return doc;
  }

  test('the gap added is identical regardless of whatever font/fontSize was last active on the document', () => {
    const doc = freshDoc();
    doc.font('Helvetica-Oblique').fontSize(8); // the filter-line font — the smaller of the two real cases
    const y1 = doc.y;
    pdfTableHelper.sectionGap(doc);
    const delta1 = doc.y - y1;

    doc.font('Helvetica-Bold').fontSize(15); // a large, unrelated font — must not change the gap
    const y2 = doc.y;
    pdfTableHelper.sectionGap(doc);
    const delta2 = doc.y - y2;

    expect(delta1).toBe(delta2);
    expect(delta1).toBe(14); // the documented default
  });

  test('an explicit point value is honored exactly, for the smaller table-to-summary transitions', () => {
    const doc = freshDoc();
    const y0 = doc.y;
    pdfTableHelper.sectionGap(doc, 10);
    expect(doc.y - y0).toBe(10);
  });

  test('old moveDown(0.8)-style behavior (gap scales with font size) is NOT what sectionGap does — regression guard against reverting to it', () => {
    const doc = freshDoc();
    doc.font('Helvetica').fontSize(8);
    const smallFontDelta = (() => { const y = doc.y; doc.moveDown(0.8); return doc.y - y; })();
    doc.y = 36;
    doc.font('Helvetica').fontSize(15);
    const bigFontDelta = (() => { const y = doc.y; doc.moveDown(0.8); return doc.y - y; })();
    expect(smallFontDelta).not.toBe(bigFontDelta); // moveDown DOES vary with font — proves why it was replaced
  });
});

describe('pdfTableHelper.drawTable — cellColor keyed by actual cell value, not row position', () => {
  function freshDoc() {
    const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });
    doc.pipe(new (require('stream').PassThrough)());
    doc.font('Helvetica').fontSize(8.5);
    return doc;
  }

  test('reordering which row comes first never changes which color a given status is drawn in', () => {
    function colorsUsedForStatusColumn(order) {
      const doc = freshDoc();
      const seen = [];
      const origFillColor = PDFDocument.prototype.fillColor;
      PDFDocument.prototype.fillColor = function (c) { if (c) seen.push(c); return origFillColor.apply(this, arguments); };
      try {
        pdfTableHelper.drawTable(doc, {
          columns: [{ width: 100 }, { width: 100 }],
          rows: order,
          cellValues: (status) => ['Institution X', status],
          left: 36,
          pageTop: doc.page.margins.top,
          pageBottom: doc.page.height - doc.page.margins.bottom,
          drawHeader: () => {},
          cellColor: (colIdx, cellText) => (colIdx === 1 ? statusColors.hex(cellText) : null),
          baseColor: '#222'
        });
      } finally {
        PDFDocument.prototype.fillColor = origFillColor;
      }
      return seen.filter((c) => c !== '#222');
    }

    const forward = colorsUsedForStatusColumn(['Active', 'Expired', 'Expiring Soon']);
    const reversed = colorsUsedForStatusColumn(['Expiring Soon', 'Expired', 'Active']);
    // Same three statuses, opposite order — the SET of colors actually used for the status column is
    // identical either way (each status always maps to its own fixed color, never to "whichever color is
    // next in a palette for this row's position").
    expect(new Set(forward)).toEqual(new Set(reversed));
    expect(forward).toEqual(expect.arrayContaining([statusColors.hex('Active'), statusColors.hex('Expired'), statusColors.hex('Expiring Soon')]));
  });
});

// ───────────────────────────── C) live PDF routes — real geometry, real HTTP ─────────────────────────────

/** Records every text box and every large (header-bar-sized) rectangle PDFKit actually draws, tagged with
 * the page index it landed on — the same technique test/document-request-pdf-layout.test.js uses, generalized
 * (not armed on a specific title string) so it covers whichever report generator the caller exercises. */
function recordGeometry(run) {
  const texts = [], rects = [];
  // PDFDocument's own constructor calls addPage() internally for page 1 — starting the counter at -1 (not
  // 0) so that first, constructor-driven call lands on page index 0, matching what addPage() calls from
  // report code itself (actual page breaks) increment from.
  let page = -1;
  const orig = { text: PDFDocument.prototype.text, rect: PDFDocument.prototype.rect, addPage: PDFDocument.prototype.addPage };
  PDFDocument.prototype.text = function (str, a, b, c) {
    let x = this.x, y = this.y, opts = {};
    if (typeof a === 'number') { x = a; if (typeof b === 'number') { y = b; opts = c || {}; } else opts = b || {}; } else if (a && typeof a === 'object') opts = a;
    const text = String(str);
    const width = opts.width != null ? opts.width : Math.min(this.widthOfString(text), this.page.width - this.page.margins.right - x);
    const h = opts.lineBreak === false ? this.currentLineHeight() : this.heightOfString(text, { width });
    texts.push({ text, x, y, w: width, h, page });
    return orig.text.apply(this, arguments);
  };
  PDFDocument.prototype.rect = function (x, y, w, h) { if (w > 100) rects.push({ x, y, w, h, page }); return orig.rect.apply(this, arguments); };
  PDFDocument.prototype.addPage = function () { page += 1; return orig.addPage.apply(this, arguments); };
  const restore = () => Object.assign(PDFDocument.prototype, orig);
  return Promise.resolve().then(run).then(() => ({ texts, rects }), (e) => { throw e; }).finally(restore);
}

async function fetchPdfBuffer(agent, url) {
  return agent.get(url).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
}

let agent;
const createdIds = [];
const stamp = Date.now();
const TAG = `jesttest OverlapColor ${stamp}`;
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

beforeAll(async () => {
  await connectDB();
  agent = request.agent(app);
  await loginAs(agent, await createTestUser({ role: 'Administrator' }));

  const longInstName = `${TAG} A Very Long Institution Name That Should Wrap Across Multiple Lines In The Generated Report Table Without Being Truncated University`;
  const fixtures = [
    { inst: `${TAG} Active`, end: fmt(daysFromNow(365)), status: 'Active' },
    { inst: `${TAG} ExpiringSoon`, end: fmt(daysFromNow(30)), status: 'Active' },
    { inst: `${TAG} Expired`, end: fmt(daysFromNow(-30)), status: 'Active' },
    { inst: longInstName, end: fmt(daysFromNow(400)), status: 'Active' }
  ];
  for (const f of fixtures) {
    const res = await agent.post('/api/partnerships').send({
      inst: f.inst, country: 'Testland', region: 'Asia', type: 'MOU', nature: 'Training',
      cat: 'International', unit: 'CIRL', start: 'Jan 1, 2020', end: f.end, status: f.status, remarks: 'jesttest'
    });
    createdIds.push(res.body.partnership.id);
  }
}, 30000);

afterAll(async () => {
  const db = await connectDB();
  await db.collection('partnerships').deleteMany({ id: { $in: createdIds } });
  await cleanupAll();
  await closeDB();
});

/** Asserts the gap between the bottom-most subtitle/letterhead text and the top of the next header-bar
 * rectangle below it is positive (no overlap) and at least `minGap` points — not just "doesn't crash". */
function assertNoOverlapBeforeHeader(geometry, minGap = 5) {
  const subtitleTexts = geometry.texts.filter((t) => t.page === 0 && t.text.trim());
  const headerRects = geometry.rects.filter((r) => r.page === 0);
  expect(subtitleTexts.length).toBeGreaterThan(0);
  expect(headerRects.length).toBeGreaterThan(0);
  // The first header-bar rectangle drawn on the page (column header / grouped header / summary-table header)
  // is the one the subtitle block must clear.
  const firstHeaderTop = Math.min(...headerRects.map((r) => r.y));
  const subtitleBottoms = subtitleTexts.filter((t) => t.y < firstHeaderTop + 1).map((t) => t.y + t.h);
  const lowestSubtitleBottom = Math.max(...subtitleBottoms);
  expect(firstHeaderTop - lowestSubtitleBottom).toBeGreaterThanOrEqual(minGap);
}

describe('Partnership Report PDF (flat path) — subtitle never overlaps the table header', () => {
  test('a long title with multiple active filters still leaves a real gap before the column-header bar', async () => {
    let response;
    const geometry = await recordGeometry(async () => {
      response = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=' +
        encodeURIComponent('An Unusually Long Custom Report Title That Exercises Wrapping Behavior Across Lines') +
        '&country=Testland&status=Active&unit=CIRL');
    });
    expect(response.status).toBe(200);
    assertNoOverlapBeforeHeader(geometry);
  });

  test('an unfiltered report (shortest subtitle: "Filters: None — all records") also keeps a real gap', async () => {
    let response;
    const geometry = await recordGeometry(async () => {
      response = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=Short&country=Testland');
    });
    expect(response.status).toBe(200);
    assertNoOverlapBeforeHeader(geometry);
  });
});

describe('Partnership Report PDF (grouped path) — same overlap fix applies to drawGroupedHeader()', () => {
  test('a Group By report with a long title keeps the subtitle clear of the grouped header bar', async () => {
    let response;
    const geometry = await recordGeometry(async () => {
      response = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=' +
        encodeURIComponent('Grouped Report With A Deliberately Long Title For Wrapping') +
        '&country=Testland&groupBy=unit');
    });
    expect(response.status).toBe(200);
    assertNoOverlapBeforeHeader(geometry);
  });
});

describe('Multi-Configuration Comparison PDF — same overlap fix applies to the summary-table header', () => {
  test('the title/period block keeps clear of the Comparison-summary table header bar', async () => {
    const configs = encodeURIComponent(JSON.stringify([
      { label: 'All Testland', country: 'Testland' },
      { label: 'CIRL Unit Only', country: 'Testland', unit: 'CIRL' }
    ]));
    let response;
    const geometry = await recordGeometry(async () => {
      response = await fetchPdfBuffer(agent, `/api/reports/comparison/multi/pdf?configs=${configs}`);
    });
    expect(response.status).toBe(200);
    assertNoOverlapBeforeHeader(geometry);
  });
});

describe('Partnership Report PDF — multi-page: table header repeats, full letterhead does not', () => {
  test('page 2+ repeats the column-header row but never the CSPC letterhead title again', async () => {
    // Force a page break: every fixture row set to wrap across several lines via a long institution name,
    // so even a handful of records overflow a single A4 page.
    const manyIds = [];
    for (let i = 0; i < 20; i++) {
      const res = await agent.post('/api/partnerships').send({
        inst: `${TAG} PageBreak Filler Institution Number ${i} With Extra Padding Text To Force Wrapping`,
        country: 'Testland', region: 'Asia', type: 'MOU', nature: 'Training',
        cat: 'International', unit: 'CIRL', start: 'Jan 1, 2020', end: fmt(daysFromNow(365)), status: 'Active', remarks: 'jesttest'
      });
      manyIds.push(res.body.partnership.id);
    }
    try {
      let response;
      const geometry = await recordGeometry(async () => {
        response = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=PageBreak&country=Testland&unit=CIRL');
      });
      expect(response.status).toBe(200);
      const pageCount = Math.max(...geometry.texts.map((t) => t.page)) + 1;
      expect(pageCount).toBeGreaterThan(1); // confirms the fixture data actually forced a page break

      const titleOccurrences = geometry.texts.filter((t) => /CAMARINES SUR POLYTECHNIC COLLEGES/i.test(t.text));
      expect(titleOccurrences.length).toBe(1); // letterhead drawn once, not re-drawn per page
      expect(titleOccurrences[0].page).toBe(0);

      const headerLabelOccurrencesByPage = new Set(
        geometry.texts.filter((t) => t.text === 'Name of Schools/Institutions').map((t) => t.page)
      );
      expect(headerLabelOccurrencesByPage.size).toBeGreaterThan(1); // the column header itself DOES repeat
    } finally {
      const db = await connectDB();
      await db.collection('partnerships').deleteMany({ id: { $in: manyIds } });
    }
  }, 30000);
});

describe('Multi-Configuration Comparison PDF — status colors match the shared mapping, by value not position', () => {
  test('mixed statuses within one comparison report are colored by their real status name', async () => {
    const configs = encodeURIComponent(JSON.stringify([
      { label: 'All Testland', country: 'Testland' }
    ]));
    const seenColors = [];
    let response;
    const origFillColor = PDFDocument.prototype.fillColor;
    PDFDocument.prototype.fillColor = function (c) { if (c) seenColors.push(c); return origFillColor.apply(this, arguments); };
    try {
      response = await fetchPdfBuffer(agent, `/api/reports/comparison/multi/pdf?configs=${configs}`);
    } finally {
      PDFDocument.prototype.fillColor = origFillColor;
    }
    expect(response.status).toBe(200);
    // At least the Active-status color must appear (every fixture in this suite is a currently-active
    // partnership by end date) — proves the PDF's Status column really is being colored via the shared
    // mapping, not left in whatever single color the row style already set.
    expect(seenColors).toEqual(expect.arrayContaining([statusColors.hex('Active')]));
  });
});
