// Regression tests for services/pdfTableHelper.js and services/excelFormatHelper.js (2026-10 export-layout
// audit) — the shared row-height-measurement/wrapping helper now used by renderPartnershipReportPdf (both
// paths), renderMultiComparisonReportPdf, renderTablePdf, buildPartnershipExcel, the Audit Trail Excel
// export, and buildMultiComparisonExcel. Deliberately NOT used by renderDocumentRequestPdf (unchanged,
// already covered by test/document-request-pdf-layout.test.js) or the UI-unreachable legacy two-group
// Comparison exports (also unchanged).
//
// Unit-level: exercises the helper functions directly against a real pdfkit/exceljs document — no HTTP
// layer, no database — for fast, precise coverage of the specific scenarios this audit was asked to cover.
// A separate geometry-recording block (same technique as test/document-request-pdf-layout.test.js: monkey-
// patch PDFDocument.prototype to record what was actually drawn) proves drawTable() never produces
// overlapping cells, including across a forced page break.
const { PassThrough } = require('stream');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { oneLineUnit, measureRowHeight, drawTable } = require('../services/pdfTableHelper');
const { applyLongTextWrap } = require('../services/excelFormatHelper');

function freshDoc(opts) {
  const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true, ...opts });
  doc.pipe(new PassThrough()); // drain the output; these tests only care about measured/drawn geometry
  doc.font('Helvetica').fontSize(8.5);
  return doc;
}

const LONG_WITH_SPACES = 'Camarines Sur Polytechnic Colleges International Partnership and Linkages Coordination Office';
const LONG_UNBROKEN = 'Article_4_Duration_and_Termination_Provisions_SubsectionB_ExtendedRenewalTermsAndConditions_WithoutAnySpaces';
const PATHOLOGICAL = 'word '.repeat(400); // a pasted paragraph — the "exceptionally long content" case

describe('pdfTableHelper — measureRowHeight', () => {
  test('a short, ordinary value stays close to a single line — never inflated toward the multi-line cap', () => {
    const doc = freshDoc();
    // One real line (heightOfString's own unit, ~9.8 at this font/size) plus the default 4px top+bottom
    // padding — not exactly minHeight (16), since minHeight is a FLOOR this still clears, not a fixed value
    // every short cell snaps to.
    const expected = oneLineUnit(doc) + 8;
    const h = measureRowHeight(doc, ['Japan', 'Active'], [150, 150]);
    expect(h).toBeCloseTo(expected, 1);
    expect(h).toBeLessThan(oneLineUnit(doc) * 2); // nowhere close to a 2-line height
  });

  test('a long institution name (with spaces) grows the row past the minimum — not truncated to one line', () => {
    const doc = freshDoc();
    const h = measureRowHeight(doc, [LONG_WITH_SPACES], [150]);
    expect(h).toBeGreaterThan(16);
  });

  test('a long unbroken string (no spaces — the pdfkit character-wrap case) also grows row height, not just overflow', () => {
    const doc = freshDoc();
    const h = measureRowHeight(doc, [LONG_UNBROKEN], [150]);
    expect(h).toBeGreaterThan(16);
  });

  test('multiline (embedded \\n) content is measured taller than a single line', () => {
    const doc = freshDoc();
    const multi = 'Line one\nLine two\nLine three';
    expect(measureRowHeight(doc, [multi], [200])).toBeGreaterThan(16);
  });

  test('empty string, null, and undefined cells are all handled safely (no throw, minimum height)', () => {
    const doc = freshDoc();
    expect(() => measureRowHeight(doc, ['', null, undefined], [100, 100, 100])).not.toThrow();
    expect(measureRowHeight(doc, ['', null, undefined], [100, 100, 100])).toBe(16);
  });

  test('an exceptionally long (pathological) value is capped at maxLines, not left unbounded', () => {
    const doc = freshDoc();
    const uncapped = doc.heightOfString(PATHOLOGICAL, { width: 150 });
    const h = measureRowHeight(doc, [PATHOLOGICAL], [150], { maxLines: 4 });
    const cap = oneLineUnit(doc) * 4 + 8; // default padY=4, so +8 total
    expect(uncapped).toBeGreaterThan(cap); // confirms the test data really is long enough to need capping
    expect(h).toBeLessThanOrEqual(cap + 0.5);
  });

  test('the row height is the MAX across all cells in the row, not the first or last', () => {
    const doc = freshDoc();
    const h = measureRowHeight(doc, ['short', LONG_WITH_SPACES, 'also short'], [150, 150, 150]);
    const longAlone = measureRowHeight(doc, [LONG_WITH_SPACES], [150]);
    expect(h).toBe(longAlone);
  });
});

describe('pdfTableHelper — drawTable: pagination, header repeat, and the no-infinite-loop edge case', () => {
  test('a dataset that forces a page break redraws the header exactly once per page and draws every row', () => {
    const doc = freshDoc();
    let headerCalls = 0;
    const rows = Array.from({ length: 60 }, (_, i) => ({ name: `Partner Institution Number ${i}` }));
    const drawnNames = [];
    const pageTop = doc.page.margins.top;
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    doc.y = pageTop;
    drawTable(doc, {
      columns: [{ width: 200 }],
      rows,
      cellValues: (row) => { drawnNames.push(row.name); return [row.name]; },
      left: doc.page.margins.left,
      pageTop,
      pageBottom,
      drawHeader: () => { headerCalls++; }
    });
    expect(drawnNames.length).toBe(60); // every row was actually drawn, not dropped at a page boundary
    const pageCount = doc.bufferedPageRange().count;
    expect(pageCount).toBeGreaterThan(1); // this dataset genuinely forced a page break
    // drawTable() only redraws the header on an actual page BREAK (the caller is responsible for the very
    // first page's header, not counted here since this test — unlike every real caller in cirl.js — never
    // calls drawHeader() itself before drawTable()) — so headerCalls is break-count, one less than page count.
    expect(headerCalls).toBe(pageCount - 1);
  });

  test('a row near the page-bottom boundary either fits cleanly on the current page or moves to a fresh one — never split mid-row', () => {
    const doc = freshDoc();
    const pageTop = doc.page.margins.top;
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    // Position doc.y just a few pixels above the bottom margin, deliberately tight.
    doc.y = pageBottom - 10;
    const startPage = doc.bufferedPageRange().count;
    let rowDrawnOnPage;
    drawTable(doc, {
      columns: [{ width: 200 }],
      rows: [{ name: 'Boundary Row' }],
      cellValues: (row) => [row.name],
      left: doc.page.margins.left,
      pageTop,
      pageBottom,
      drawHeader: () => {},
      rowStyle: () => { rowDrawnOnPage = doc.bufferedPageRange().count; }
    });
    // Whichever page it landed on, the row's bottom edge must not exceed pageBottom.
    expect(doc.y).toBeLessThanOrEqual(pageBottom + 0.5);
    expect(rowDrawnOnPage).toBeGreaterThanOrEqual(startPage);
  });

  test('a single row too tall even for a fresh page is clamped once, never causes an infinite page-break loop', () => {
    const doc = freshDoc();
    const pageTop = doc.page.margins.top;
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    doc.y = pageTop;
    const start = Date.now();
    drawTable(doc, {
      columns: [{ width: 100 }],
      // maxLines is large enough, combined with a narrow column, that the natural height would exceed one
      // full page if it weren't clamped — this is the exact scenario the clamp exists for.
      rows: [{ name: PATHOLOGICAL }],
      cellValues: (row) => [row.name],
      left: doc.page.margins.left,
      pageTop,
      pageBottom,
      drawHeader: () => {},
      maxLines: 500
    });
    expect(Date.now() - start).toBeLessThan(2000); // would hang/timeout if the clamp didn't prevent a loop
    expect(doc.bufferedPageRange().count).toBeLessThanOrEqual(2); // at most one extra page, never many
  });

  test('an empty rows array draws nothing and does not throw', () => {
    const doc = freshDoc();
    expect(() => drawTable(doc, {
      columns: [{ width: 100 }],
      rows: [],
      cellValues: () => [],
      left: doc.page.margins.left,
      pageTop: doc.page.margins.top,
      pageBottom: doc.page.height - doc.page.margins.bottom,
      drawHeader: () => {}
    })).not.toThrow();
  });
});

describe('pdfTableHelper — geometry: no overlapping cells, including across a page break', () => {
  // Same technique as test/document-request-pdf-layout.test.js: monkey-patch PDFDocument.prototype to record
  // the real x/y/width/height of everything drawn, then assert none of it overlaps.
  function recordGeometry(run) {
    const texts = [], rects = [];
    const orig = { text: PDFDocument.prototype.text, rect: PDFDocument.prototype.rect };
    PDFDocument.prototype.text = function (str, a, b, c) {
      let x = this.x, y = this.y, opts = {};
      if (typeof a === 'number') { x = a; if (typeof b === 'number') { y = b; opts = c || {}; } else opts = b || {}; } else if (a && typeof a === 'object') opts = a;
      const text = String(str);
      const width = opts.width != null ? opts.width : this.widthOfString(text);
      const h = opts.height != null ? opts.height : this.heightOfString(text, { width });
      if (text.trim()) texts.push({ text, x, y, w: width, h, page: this.bufferedPageRange().start + this.bufferedPageRange().count - 1 });
      return orig.text.apply(this, arguments);
    };
    PDFDocument.prototype.rect = function (x, y, w, h) { if (w > 5) rects.push({ x, y, w, h }); return orig.rect.apply(this, arguments); };
    const restore = () => Object.assign(PDFDocument.prototype, orig);
    try { run(); return { texts, rects }; } finally { restore(); }
  }

  function textsOverlap(a, b) {
    if (a.page !== b.page) return false;
    const ax2 = a.x + a.w, ay2 = a.y + a.h, bx2 = b.x + b.w, by2 = b.y + b.h;
    const xOverlap = a.x < bx2 - 0.5 && b.x < ax2 - 0.5;
    const yOverlap = a.y < by2 - 0.5 && b.y < ay2 - 0.5;
    return xOverlap && yOverlap;
  }

  test('a mixed dataset (short values, a long wrapping institution name, and a forced page break) produces zero overlapping text boxes', () => {
    const doc = freshDoc();
    const pageTop = doc.page.margins.top;
    const pageBottom = doc.page.height - doc.page.margins.bottom;
    doc.y = pageTop;
    const rows = [
      { a: 'Japan', b: 'Active' },
      { a: LONG_WITH_SPACES, b: 'Expiring Soon' }, // the row that must wrap and grow taller than its neighbors
      { a: LONG_UNBROKEN, b: 'Expired' },
      ...Array.from({ length: 50 }, (_, i) => ({ a: `Filler Institution ${i}`, b: 'Active' })) // forces a page break
    ];
    const geometry = recordGeometry(() => {
      drawTable(doc, {
        columns: [{ width: 150 }, { width: 100 }],
        rows,
        cellValues: (row) => [row.a, row.b],
        left: doc.page.margins.left,
        pageTop,
        pageBottom,
        drawHeader: () => {
          doc.font('Helvetica-Bold').text('Col A', doc.page.margins.left, doc.y, { width: 150, lineBreak: false });
          doc.text('Col B', doc.page.margins.left + 150, doc.y, { width: 100, lineBreak: false });
          doc.font('Helvetica');
          doc.y += 16;
        }
      });
    });
    const overlaps = [];
    for (let i = 0; i < geometry.texts.length; i++) {
      for (let j = i + 1; j < geometry.texts.length; j++) {
        if (textsOverlap(geometry.texts[i], geometry.texts[j])) overlaps.push([geometry.texts[i].text, geometry.texts[j].text]);
      }
    }
    expect(overlaps).toEqual([]);
  });
});

describe('excelFormatHelper — applyLongTextWrap', () => {
  async function buildTestWorkbook() {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Test');
    sheet.columns = [{ key: 'inst', width: 32 }, { key: 'country', width: 18 }];
    const headerRow = sheet.addRow(['Institution', 'Country']);
    const shortRow = sheet.addRow({ inst: 'Short Name', country: 'Japan' });
    shortRow.height = 16;
    const longRow = sheet.addRow({ inst: LONG_WITH_SPACES, country: 'Philippines' });
    longRow.height = 16;
    return { wb, sheet, headerRow };
  }

  test('full cell values are preserved exactly — wrapping never truncates the underlying data', async () => {
    const { sheet, headerRow } = await buildTestWorkbook();
    applyLongTextWrap(sheet, { wrapColumnKeys: ['inst'], firstDataRow: headerRow.number + 1, lastDataRow: sheet.rowCount, headerRowNumber: headerRow.number });
    expect(sheet.getRow(3).getCell(1).value).toBe(LONG_WITH_SPACES); // unchanged, full value
  });

  test('wrapText is applied only to the named column, not every column', async () => {
    const { sheet, headerRow } = await buildTestWorkbook();
    applyLongTextWrap(sheet, { wrapColumnKeys: ['inst'], firstDataRow: headerRow.number + 1, lastDataRow: sheet.rowCount, headerRowNumber: headerRow.number });
    expect(sheet.getRow(3).getCell(1).alignment.wrapText).toBe(true); // inst column
    expect(sheet.getRow(3).getCell(2).alignment?.wrapText).not.toBe(true); // country column — not in wrapColumnKeys
  });

  test('explicit row height is cleared on wrapped data rows so Excel can auto-fit on open (verified at the file level, see the helper\'s own comment for the Excel-rendering limitation this cannot check)', async () => {
    const { sheet, headerRow } = await buildTestWorkbook();
    expect(sheet.getRow(3).height).toBe(16); // before: explicit, like every export had before this change
    applyLongTextWrap(sheet, { wrapColumnKeys: ['inst'], firstDataRow: headerRow.number + 1, lastDataRow: sheet.rowCount, headerRowNumber: headerRow.number });
    expect(sheet.getRow(3).height).toBeUndefined(); // after: cleared
  });

  test('the header row itself is never given wrapText or an altered height — only data rows are touched', async () => {
    const { sheet, headerRow } = await buildTestWorkbook();
    headerRow.height = 20;
    applyLongTextWrap(sheet, { wrapColumnKeys: ['inst'], firstDataRow: headerRow.number + 1, lastDataRow: sheet.rowCount, headerRowNumber: headerRow.number });
    expect(headerRow.height).toBe(20);
  });

  test('freeze panes are set at the header row, and the auto-filter covers only the header row — never the letterhead/title rows above it', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Test');
    sheet.columns = [{ key: 'inst', width: 32 }, { key: 'country', width: 18 }];
    sheet.addRow(['LETTERHEAD TITLE ROW']); // row 1 — must never be inside the filter range
    const headerRow = sheet.addRow(['Institution', 'Country']); // row 2
    sheet.addRow({ inst: 'A', country: 'B' }); // row 3
    applyLongTextWrap(sheet, { wrapColumnKeys: ['inst'], firstDataRow: headerRow.number + 1, lastDataRow: sheet.rowCount, headerRowNumber: headerRow.number });
    expect(sheet.views).toEqual([{ state: 'frozen', ySplit: headerRow.number }]);
    expect(sheet.autoFilter.from.row).toBe(headerRow.number);
    expect(sheet.autoFilter.from.row).not.toBe(1); // not the letterhead row
  });

  test('an empty data range (zero rows) does not throw and still applies freeze/filter at the header', async () => {
    const wb = new ExcelJS.Workbook();
    const sheet = wb.addWorksheet('Test');
    sheet.columns = [{ key: 'inst', width: 32 }];
    const headerRow = sheet.addRow(['Institution']);
    expect(() => applyLongTextWrap(sheet, { wrapColumnKeys: ['inst'], firstDataRow: headerRow.number + 1, lastDataRow: sheet.rowCount, headerRowNumber: headerRow.number })).not.toThrow();
    expect(sheet.views[0].state).toBe('frozen');
  });

  test('real round-trip: saving and reloading the workbook preserves wrapText and the cleared height together', async () => {
    const { sheet, headerRow } = await buildTestWorkbook();
    applyLongTextWrap(sheet, { wrapColumnKeys: ['inst'], firstDataRow: headerRow.number + 1, lastDataRow: sheet.rowCount, headerRowNumber: headerRow.number });
    const buf = await sheet.workbook.xlsx.writeBuffer();
    const reloaded = new ExcelJS.Workbook();
    await reloaded.xlsx.load(buf);
    const reloadedSheet = reloaded.getWorksheet('Test');
    const reloadedLongRow = reloadedSheet.getRow(3);
    expect(reloadedLongRow.getCell(1).value).toBe(LONG_WITH_SPACES); // value survives a real save/reload
    expect(reloadedLongRow.height).toBeUndefined(); // height genuinely absent from the saved file, not just in-memory
    expect(reloadedLongRow.getCell(1).alignment.wrapText).toBe(true);
  });
});
