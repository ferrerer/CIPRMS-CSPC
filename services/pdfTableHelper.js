// Shared PDF table-row layout helper (2026-10 export-layout audit) — row height measured from the actual
// text, not assumed, so a long institution name/address wraps instead of silently truncating. Used by
// renderPartnershipReportPdf (both the flat and grouped paths), renderMultiComparisonReportPdf, and
// renderTablePdf (Audit Trail). Deliberately NOT used by renderDocumentRequestPdf, which already solved
// this same problem on its own (its textRow() helper) before this file existed, and has its own passing
// geometry tests — reusing this helper there would be a behavior change to an already-correct template.
//
// Core technique, verified empirically against the actual installed pdfkit (not assumed): doc.heightOfString
// (text, {width}) predicts doc.text(text, x, y, {width})'s real draw height exactly, including for strings
// with no spaces (pdfkit character-wraps a word that doesn't fit, both when measuring and when drawing) —
// confirmed by comparing a measured height against doc.y's actual advance after a real draw call, for both
// ordinary text and an unbroken string, and finding them equal.
//
// One non-obvious finding from that same verification: doc.currentLineHeight() and heightOfString()'s own
// internal per-line unit are NOT the same value (heightOfString carries extra leading currentLineHeight()
// doesn't) — sizing a truncation height cap off currentLineHeight() silently under-budgets it, which showed
// up as text being cut after a single line instead of the intended multi-line cap. oneLineUnit() below always
// derives the unit from heightOfString itself to avoid that trap.
function oneLineUnit(doc) {
  return doc.heightOfString('Mg', { width: 1000 });
}

// Row height a set of per-column values needs, each measured at its own column's real text width. Any single
// cell is capped at `maxLines` (default 4) — not a limit that affects normal institution names/addresses
// (which wrap comfortably well under that in these column widths), but a safety bound against a pathological
// free-text value (an accidentally pasted paragraph) blowing up one row's height without limit.
function measureRowHeight(doc, cellTexts, colWidths, { minHeight = 16, maxLines = 4, padY = 4 } = {}) {
  const cap = oneLineUnit(doc) * maxLines;
  let maxH = minHeight;
  cellTexts.forEach((text, i) => {
    const w = colWidths[i];
    if (!w) return;
    const natural = doc.heightOfString(String(text == null ? '' : text), { width: w });
    maxH = Math.max(maxH, Math.min(natural, cap) + padY * 2);
  });
  return maxH;
}

// Draws one row's cells, left-aligned per column, top-aligned within the row (matches the alignment every
// existing PDF table in this codebase already uses). A cell whose natural height exceeds the maxLines cap is
// drawn with an explicit height + ellipsis: true (a visible "…", never a silent clip) — verified this only
// activates when genuinely needed: a generously-sized height budget produces the identical output to drawing
// with no height constraint at all, confirmed by comparing the two draw paths' y-advancement directly.
// `cellColor(cellIndex, cellText)`, when given, returns a hex color for that one cell — passed BOTH the
// column index and the cell's own actual text value (e.g. a Status column needs the real value, "Active" vs
// "Expired", to pick the right color by status NAME, not merely by which column it's in) — restored to
// `baseColor` immediately after, so it never leaks into the next cell. `baseColor` must be passed explicitly
// by the caller (verified empirically: pdfkit's own `doc.fillColor()` does NOT act as a getter when called
// with no arguments in the installed version — it returns `this` for chaining, not the current color — so
// this function cannot discover "whatever color the caller already set" on its own; the caller already knows
// that value, since it set it). Both are optional and additive: every existing caller that passes neither
// keeps drawing every cell in whatever single color it already set on `doc` before calling drawTable(),
// exactly as before this was added.
function drawRowCells(doc, cellTexts, colWidths, x0, y, { maxLines = 4, padX = 4, padY = 4, cellColor, baseColor } = {}) {
  const cap = oneLineUnit(doc) * maxLines;
  let x = x0;
  cellTexts.forEach((text, i) => {
    const w = colWidths[i];
    if (!w) return;
    const str = String(text == null || text === '' ? '—' : text);
    const innerW = w - padX * 2;
    const color = cellColor ? cellColor(i, text) : null;
    if (color) doc.fillColor(color);
    const natural = doc.heightOfString(str, { width: innerW });
    if (natural > cap + 0.5) {
      doc.text(str, x + padX, y + padY, { width: innerW, height: cap, ellipsis: true });
    } else {
      doc.text(str, x + padX, y + padY, { width: innerW });
    }
    if (color && baseColor) doc.fillColor(baseColor);
    x += w;
  });
}

// Orchestrates one table: for each row, measures its real height, page-breaks when it won't fit (using that
// real height, not a guess), redraws the column header after every page break, draws the row's
// background/border at the measured height via the caller's own rowStyle (so each report's own colors/zebra-
// striping stay exactly as they are today — this helper only changes HOW TALL a row is, never its styling),
// then the cells.
//
// `pageBottom` must already account for the footer/page-number area (the caller passes
// doc.page.height - doc.page.margins.bottom, exactly as every existing ensureSpace()-style check in this
// codebase already does — page numbers are written in a separate pass after all content, over a temporarily
// zeroed bottom margin, the same established pattern already used by every PDF export here).
//
// Handles the "a single row cannot fit even on a fresh page" edge case (an extreme, previously unseen case
// given the maxLines cap keeps any one row small, but handled explicitly rather than assumed away): if a
// row's measured height alone exceeds the full usable page height, it is clamped to the usable height for
// that one page rather than triggering a second, pointless page break — this can only ever fire once per
// row, so no loop is possible.
// The caller must draw the table header ONCE, itself, before calling drawTable() — this function only
// redraws it on an actual page break (via the same `drawHeader` callback), never at entry. This matters
// when a caller draws several of these tables back-to-back under ONE already-drawn header (e.g. one call per
// category group in a single continuous table) — drawTable() calling drawHeader() unconditionally at its own
// start would have duplicated the header between every group, a real bug caught before this was wired in.
function drawTable(doc, { columns, rows, cellValues, left, pageTop, pageBottom, drawHeader, rowStyle, maxLines = 4, cellColor, baseColor }) {
  const colWidths = columns.map(c => c.width);
  const usablePageHeight = pageBottom - pageTop;
  rows.forEach((row, idx) => {
    const cells = cellValues(row, idx);
    let h = measureRowHeight(doc, cells, colWidths, { maxLines });
    let effectiveMaxLines = maxLines;
    if (doc.y + h > pageBottom) {
      doc.addPage();
      doc.y = pageTop;
      drawHeader();
      if (h > usablePageHeight) {
        // A single row too tall even for a fresh page — clamp once, never loop. Critically, drawRowCells()
        // below must be told the SAME reduced budget: if it were left measuring/drawing against the original
        // (uncapped) maxLines, its own text() call could request a height taller than one page, and pdfkit
        // can paginate internally for a height that large — silently producing extra pages this clamp was
        // supposed to prevent. Caught by a test that deliberately forced this exact case (maxLines=500 against
        // a pathologically long value) before this fix: the clamp alone was not enough on its own.
        h = usablePageHeight;
        effectiveMaxLines = Math.max(1, Math.floor(usablePageHeight / oneLineUnit(doc)));
      }
    }
    const y = doc.y;
    const contentWidth = colWidths.reduce((a, b) => a + b, 0);
    if (rowStyle) rowStyle(doc, idx, left, y, contentWidth, h);
    drawRowCells(doc, cells, colWidths, left, y, { maxLines: effectiveMaxLines, cellColor, baseColor });
    doc.y = y + h;
  });
}

// Fixed, font-independent vertical gap after a block of letterhead/subtitle text and before the next
// section (a table's column-header bar, a summary table, etc.) — added for the 2026-10 subtitle/header-
// overlap fix. Root cause: every PDF generator in this codebase previously used `doc.moveDown(0.8)` for
// this exact transition, but moveDown()'s amount scales off *whatever font/fontSize happens to still be
// active* on `doc` (e.g. 8pt Oblique if an optional filter line was drawn, 9pt Helvetica if it wasn't) —
// an inconsistent, sometimes-too-small gap (~7pt) that reads as the subtitle crowding the header bar right
// below it, especially once a filter line or a wrapped long title is also present. `doc.y` itself is
// already correct at the call site (pdfkit's own text()/heightOfString() already account for the real
// rendered height, including wrapped lines — verified in this file's own oneLineUnit()/measureRowHeight()
// above); the bug was only ever in the SIZE of the gap added after that correct position, never in the
// position itself. Using a flat point value removes the font-size dependency entirely.
function sectionGap(doc, pts = 14) {
  doc.y += pts;
}

module.exports = { oneLineUnit, measureRowHeight, drawRowCells, drawTable, sectionGap };
