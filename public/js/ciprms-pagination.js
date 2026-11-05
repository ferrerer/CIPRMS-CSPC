/**
 * CIPRMS Shared Pagination Helper (2026-11 panel recommendation)
 *
 * buildPageList/buildPaginationHtml below are the exact same Previous/numbered-pages-with-ellipsis/Next
 * renderer already used (as near-identical copies) by assets/js/pages/registry-gridjs.init.js,
 * views/administrator/partnership_requests.ejs, views/users.ejs, and views/administrator/notifications.ejs
 * — centralized here as the one canonical implementation for any NEW pagination (Document Library,
 * College Requests) rather than a 5th copy, while those four existing, already-working call sites are left
 * untouched (see the panel-recommendations implementation report for why).
 *
 * renderPageSizeSelector/summaryText are new: a selectable records-per-page control and a "Showing X–Y of
 * Z records" label, matching the panel's explicit "allow users to select the number of records per page"
 * and "display the current page and total record count" requirements — neither existed anywhere before.
 */
(function (window) {
  'use strict';

  function buildPageList(current, total) {
    var maxVisible = 5;
    if (total <= maxVisible + 2) {
      return Array.from({ length: total }, function (_, i) { return i + 1; });
    }
    var start = Math.max(1, current - Math.floor(maxVisible / 2));
    var end = start + maxVisible - 1;
    if (end > total) { end = total; start = Math.max(1, end - maxVisible + 1); }
    var pages = [];
    for (var i = start; i <= end; i++) pages.push(i);
    if (start > 1) { pages.unshift('...'); pages.unshift(1); }
    if (end < total) { pages.push('...'); pages.push(total); }
    return pages;
  }

  function buildPaginationHtml(current, total, onClickFn) {
    if (total <= 1) return '';
    var pageItem = function (label, page, opts) {
      opts = opts || {};
      var disabled = opts.disabled ? ' disabled' : '';
      var active = opts.active ? ' active' : '';
      var isEllipsis = opts.ellipsis ? ' ellipsis-item' : '';
      var isPrevNext = opts.isPrev ? ' page-link-prev' : (opts.isNext ? ' page-link-next' : '');
      var click = opts.disabled || opts.ellipsis ? '' : 'onclick="' + onClickFn + '(' + page + ')"';
      return '<li class="page-item' + disabled + active + isEllipsis + '"><a class="page-link' + isPrevNext + '" href="javascript:void(0)" ' + click + '>' + label + '</a></li>';
    };
    var html = pageItem('&lsaquo; Previous', current - 1, { disabled: current === 1, isPrev: true });
    buildPageList(current, total).forEach(function (p) {
      html += (p === '...')
        ? pageItem('&hellip;', null, { ellipsis: true, disabled: true })
        : pageItem(p, p, { active: p === current });
    });
    html += pageItem('Next &rsaquo;', current + 1, { disabled: current === total, isNext: true });
    return '<ul class="pagination pagination-custom align-items-center m-0">' + html + '</ul>';
  }

  // Renders a 10/25/50-style page-size <select> into containerId, calling onChange(newSize) when the
  // user picks a different value. Safe to call again on every render — it just rebuilds the control
  // (keeping the currently-selected size shown correctly), same convention as buildPaginationHtml above.
  function renderPageSizeSelector(containerId, currentSize, options, onChange) {
    var el = document.getElementById(containerId);
    if (!el) return;
    options = options || [10, 25, 50];
    el.innerHTML = '<label class="fs-12 text-muted me-1 mb-0">Show</label>' +
      '<select class="form-select form-select-sm d-inline-block" style="width:auto;">' +
      options.map(function (n) { return '<option value="' + n + '"' + (n === currentSize ? ' selected' : '') + '>' + n + '</option>'; }).join('') +
      '</select>';
    el.querySelector('select').addEventListener('change', function (e) {
      onChange(parseInt(e.target.value, 10));
    });
  }

  // "Showing 1–25 of 118 records" / "No records found." — the one place this exact phrasing is built.
  function summaryText(page, pageSize, total) {
    if (!total) return 'No records found.';
    var start = (page - 1) * pageSize + 1;
    var end = Math.min(page * pageSize, total);
    return 'Showing ' + start + '–' + end + ' of ' + total + ' record' + (total === 1 ? '' : 's');
  }

  window.CIPRMSPagination = {
    buildPaginationHtml: buildPaginationHtml,
    renderPageSizeSelector: renderPageSizeSelector,
    summaryText: summaryText
  };
})(window);
