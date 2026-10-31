// Shared Excel formatting pass (2026-10 export-layout audit) — long-text wrapping, freeze panes, and
// auto-filter, applied consistently to the exports that need it: buildPartnershipExcel, the Audit Trail
// Excel export, and buildMultiComparisonExcel (cirl.js). NOT applied to the legacy two-group Comparison
// Excel export — confirmed unreachable from the UI earlier in this same audit, left unchanged.
//
// Verified limitation, not assumed: ExcelJS has no text-measurement API, so it cannot calculate how tall a
// wrapped cell needs to be — only Excel itself can, when it opens the file. Every export this helper touches
// previously set an explicit numeric `row.height` on every data row; empirically confirmed (saved a workbook
// with an explicit height, reloaded it, the height survives) that an explicit height is NOT something
// `wrapText: true` overrides — Excel only auto-fits a row's height on open when the file carries no explicit
// height for it at all. applyLongTextWrap() therefore CLEARS the explicit height on the rows it's given
// (rather than estimating one, which ExcelJS cannot verify against Excel's own font metrics) so Excel
// auto-fits them on open. Confirmed at the file level: clearing `row.height` before saving measurably omits
// it from the saved .xlsx (reloaded a test file and found the height attribute genuinely absent, wrapText
// preserved) — but Excel's own rendering of that auto-fit is NOT something this environment can visually
// confirm (no Excel/compatible application available here); flagged as a real, named limitation, not claimed
// as verified.
function applyLongTextWrap(sheet, { wrapColumnKeys, firstDataRow, lastDataRow, headerRowNumber }) {
  const wrapSet = new Set(wrapColumnKeys);
  const colIndexByKey = {};
  sheet.columns.forEach((col, i) => { if (col.key) colIndexByKey[col.key] = i + 1; });

  for (let r = firstDataRow; r <= lastDataRow; r++) {
    const row = sheet.getRow(r);
    row.height = undefined; // let Excel auto-fit on open — see the file-level comment above
    wrapSet.forEach((key) => {
      const colIdx = colIndexByKey[key];
      if (!colIdx) return;
      const cell = row.getCell(colIdx);
      const existing = cell.alignment || {};
      cell.alignment = { ...existing, wrapText: true, vertical: existing.vertical || 'top' };
    });
  }

  if (headerRowNumber) {
    // Freeze everything at/above the column header (letterhead rows included) so it stays visible while
    // scrolling through data — absent from every export before this change.
    sheet.views = [{ state: 'frozen', ySplit: headerRowNumber }];
    // Deliberately scoped to ONLY the header row's range, never the letterhead/title rows above it — a
    // filter dropdown on a merged title cell would be meaningless and was explicitly ruled out.
    sheet.autoFilter = { from: { row: headerRowNumber, column: 1 }, to: { row: headerRowNumber, column: sheet.columns.length } };
  }
}

module.exports = { applyLongTextWrap };
