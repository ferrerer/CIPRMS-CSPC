
// Escapes text before it's placed inside an HTML string (2026-11 stored-XSS fix). Institution name, type,
// category, and the start/end date fields are all plain strings server-side (cirl.js's PARTNERSHIP_FIELDS/
// sanitizePartnershipFields) — inst has no character restriction at all, and start/end are validated only
// as non-empty strings, never as real dates — so every one of them can legitimately contain `<`/`>`/`"`
// characters and must never be trusted as-is inside .innerHTML. Same implementation as the sibling
// registry-gridjs.init.js's own escapeHtml() (Monitoring page); duplicated here rather than shared because
// the two files are independent <script> includes on different pages with no module system between them.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ─── PAGINATION HELPERS (Request pattern) ─── */
var lcCurrentPage = 1, lcItemsPerPage = 10;

function buildPageList(current, total) {
    var maxVisible = 5;
    if (total <= maxVisible + 2) return Array.from({length: total}, function(_, i){ return i + 1; });
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
    var pageItem = function(label, page, opts) {
        opts = opts || {};
        var disabled = opts.disabled ? ' disabled' : '';
        var active = opts.active ? ' active' : '';
        var isEllipsis = opts.ellipsis ? ' ellipsis-item' : '';
        var isPrevNext = opts.isPrev ? ' page-link-prev' : (opts.isNext ? ' page-link-next' : '');
        var click = opts.disabled || opts.ellipsis ? '' : 'onclick="' + onClickFn + '(' + page + ')"';
        return '<li class="page-item' + disabled + active + isEllipsis + '"><a class="page-link' + isPrevNext + '" href="javascript:void(0)" ' + click + '>' + label + '</a></li>';
    };
    var html = pageItem('&lsaquo; Previous', current - 1, { disabled: current === 1, isPrev: true });
    buildPageList(current, total).forEach(function(p) {
        html += (p === '...')
            ? pageItem('&hellip;', null, { ellipsis: true, disabled: true })
            : pageItem(p, p, { active: p === current });
    });
    html += pageItem('Next &rsaquo;', current + 1, { disabled: current === total, isNext: true });
    return '<div class="d-flex justify-content-end mb-3"><ul class="pagination pagination-custom align-items-center m-0">' + html + '</ul></div>';
}

function goToLcPage(p) {
    lcCurrentPage = p;
    buildGrid();
}
// ── Lifecycle Monitor – Grid.js init (now backed by real Partnership Registry data) ──

var partnerships = [];
var activeStatus = '', activeCat = '', lcGrid = null;

// Load partnerships from the same MongoDB-backed API the Registry page uses —
// Lifecycle is a monitoring view over that one source of truth, not a separate dataset.
fetch('/api/partnerships')
  .then(function(r) { return r.json(); })
  .then(function(data) {
    partnerships = data.map(function(p) {
      var end = p.end || '';
      var expDate = new Date(end);
      var daysLeft = isNaN(expDate) ? 0 : Math.ceil((expDate - new Date()) / 86400000);
      return {
        id:     p.id,
        inst:   p.inst || p.institution || p.name || '',
        type:   p.type || '',
        cat:    p.cat || p.category || 'International',
        start:  p.start || '',
        end:    end,
        days:   daysLeft,
        status: p.status || (daysLeft < 0 ? 'Expired' : daysLeft <= 90 ? 'Expiring Soon' : 'Active')
      };
    });
    buildGrid();
    renderOverview();
    renderUrgentList();
    renderDssAlerts();
  })
  .catch(function(err) {
    console.error('Failed to load partnerships:', err);
    buildGrid();
    document.getElementById('urgent-list').innerHTML = '<li class="list-group-item px-3 py-3 text-danger fs-12">Could not load data.</li>';
  });

// Same Days Left / Status badges as the admin Monitoring registry (assets/js/shared/status-colors.js).
function daysBadgeHtml(d, s) { return CIPRMS_STATUS_COLORS.daysLeftBadgeHtml(d, s); }
function statusBadgeHtml(s, d) { return CIPRMS_STATUS_COLORS.statusBadgeHtml(s, d); }

function typeBadgeHtml(t) {
    var cls = t === 'MOU' ? 'bg-info-subtle text-info' : 'bg-primary-subtle text-primary';
    return '<span class="badge ' + cls + '">' + escapeHtml(t) + '</span>';
}

function getFiltered() {
    return partnerships.filter(function (p) {
        var statusOk = !activeStatus || (activeStatus === 'Expiring' ? p.status === 'Expiring Soon' : p.status === activeStatus);
        return statusOk && (!activeCat || p.cat === activeCat);
    });
}

function buildGrid() {
    var filtered = getFiltered();
    var countEl = document.getElementById('lc-count');
    if (countEl) countEl.textContent = filtered.length + ' of ' + partnerships.length + ' agreements';

    var totalPages = Math.ceil(filtered.length / lcItemsPerPage);
    if (lcCurrentPage > totalPages) lcCurrentPage = totalPages || 1;
    var startIdx = (lcCurrentPage - 1) * lcItemsPerPage;
    var pageSlice = filtered.slice(startIdx, startIdx + lcItemsPerPage);

    var data = pageSlice.map(function (p) {
        return [
            p.inst,
            gridjs.html(typeBadgeHtml(p.type)),
            p.cat,
            p.end,
            gridjs.html(daysBadgeHtml(p.days, p.status)),
            gridjs.html(statusBadgeHtml(p.status, p.days)),
            gridjs.html((function () {
                // Renew/Edit/Delete are Administrator-only; View/Remind stay
                // available to everyone (read-only). POST/PATCH/DELETE
                // /api/partnerships enforce this server-side regardless.
                var canManage = typeof CAN_MANAGE_LIFECYCLE !== 'undefined' && CAN_MANAGE_LIFECYCLE;
                return '<div class="dropdown">'
                + '<button class="btn btn-soft-secondary btn-sm" data-bs-toggle="dropdown"><i class="ri-more-fill"></i></button>'
                + '<ul class="dropdown-menu dropdown-menu-end">'
                + (p.status === 'Expired'
                    ? (canManage ? '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openRenewModal(' + p.id + ')"><i class="ri-refresh-line me-2 text-muted"></i>Renew</a></li>' : '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openViewModal(' + p.id + ')"><i class="ri-eye-line me-2 text-muted"></i>View</a></li>')
                    : p.days <= 90
                        ? '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openViewModal(' + p.id + ')"><i class="ri-notification-line me-2 text-muted"></i>Remind</a></li>'
                        : '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openViewModal(' + p.id + ')"><i class="ri-eye-line me-2 text-muted"></i>View</a></li>')
                + (canManage ? '<li><a href="javascript:void(0);" class="dropdown-item" onclick="openEditModal(' + p.id + ')"><i class="ri-pencil-line me-2 text-muted"></i>Edit</a></li>' : '')
                + (canManage ? '<li><a href="javascript:void(0);" class="dropdown-item text-danger" onclick="openDeleteModal(' + p.id + ')"><i class="ri-delete-bin-line me-2"></i>Delete</a></li>' : '')
                + '</ul></div>';
            })())
        ];
    });

    // Always update pagination
    var pagEl = document.getElementById('lc-pagination');
    if (pagEl) pagEl.innerHTML = buildPaginationHtml(lcCurrentPage, totalPages, 'goToLcPage');

    if (lcGrid) {
        lcGrid.updateConfig({ data: data }).forceRender();
        return;
    }

    var lcGridEl = document.getElementById('lc-grid');
    if (lcGridEl) lcGridEl.innerHTML = ''; // clear the template's loading placeholder — Grid.js requires an empty container on first render

    lcGridEl && (lcGrid = new gridjs.Grid({
        columns: [
            { name: 'Institution', width: '28%' },
            { name: 'Type',        width: '8%',  sort: false },
            { name: 'Category',    width: '12%' },
            { name: 'Expiry Date', width: '14%' },
            { name: 'Days Left',   width: '13%', sort: false },
            { name: 'Status',      width: '12%', sort: false },
            { name: 'Action',      width: '10%', sort: false }
        ],
        data: data,
        search: false,
        pagination: false,
        sort: false,   // column sorting is off for every table
        className: {
            table:  'table table-hover align-middle mb-0',
            thead:  'table-light'
        }
    }).render(document.getElementById('lc-grid')));
}


function setPill(type, val, btn) {
    var group = document.getElementById('pills-' + type);
    group.querySelectorAll('.nav-link').forEach(function (p) { p.classList.remove('active'); });
    btn.classList.add('active');
    if (type === 'status') activeStatus = val;
    else activeCat = val;
    buildGrid();
}

// ── Overview panel, Urgent list, DSS Smart Alerts — all computed from real data ──

function renderOverview() {
    var total = partnerships.length;
    var active = partnerships.filter(function(p) { return p.status === 'Active'; }).length;
    var expiring90 = partnerships.filter(function(p) { return p.status === 'Expiring Soon'; }).length;
    var expiring30 = partnerships.filter(function(p) { return p.status === 'Expiring Soon' && p.days <= 30; }).length;
    var expired = partnerships.filter(function(p) { return p.status === 'Expired'; }).length;
    var moa = partnerships.filter(function(p) { return p.type === 'MOA'; }).length;
    var mou = partnerships.filter(function(p) { return p.type === 'MOU'; }).length;
    var intl = partnerships.filter(function(p) { return p.cat === 'International'; }).length;
    var local = partnerships.filter(function(p) { return p.cat === 'Local'; }).length;
    var activeRate = total ? Math.round((active / total) * 100) : 0;

    function setText(id, v) { var el = document.getElementById(id); if (el) el.textContent = v; }
    setText('cnt-total', total);
    setText('cnt-active', active);
    setText('cnt-expiring', expiring90);
    setText('cnt-expired', expired);
    setText('cnt-moamou', 'MOA: ' + moa + '  MOU: ' + mou);

    setText('ov-total', total);
    setText('ov-active', active);
    setText('ov-expiring30', expiring30);
    setText('ov-expiring90', expiring90);
    setText('ov-expired', expired);
    setText('ov-active-rate', activeRate + '%');
    setText('ov-moa', moa);
    setText('ov-mou', mou);
    setText('ov-intl', intl);
    setText('ov-local', local);
    setText('cnt-active-rate', activeRate + '%');

    var activeBar = document.getElementById('ov-active-bar'); if (activeBar) activeBar.style.width = activeRate + '%';
    var moaBar = document.getElementById('ov-moa-bar'); if (moaBar) moaBar.style.width = (total ? Math.round(moa / total * 100) : 0) + '%';
    var mouBar = document.getElementById('ov-mou-bar'); if (mouBar) mouBar.style.width = (total ? Math.round(mou / total * 100) : 0) + '%';
}

function renderUrgentList() {
    var urgent = partnerships
        .filter(function(p) { return p.status === 'Expiring Soon' || p.status === 'Expired'; })
        .sort(function(a, b) { return a.days - b.days; })
        .slice(0, 7);
    var ul = document.getElementById('urgent-list');
    if (!ul) return;
    if (!urgent.length) {
        ul.innerHTML = '<li class="list-group-item px-3 py-3 text-muted fs-12">No urgent agreements.</li>';
        return;
    }
    ul.innerHTML = urgent.map(function(p) {
        var dotClass = p.status === 'Expired' ? 'bg-danger' : (p.days <= 14 ? 'bg-danger' : 'bg-warning');
        var textClass = p.status === 'Expired' ? 'text-danger' : (p.days <= 14 ? 'text-danger' : 'text-warning');
        var label = p.status === 'Expired' ? 'Expired' : (p.days + ' days');
        return '<li class="list-group-item px-3 py-2"><div class="d-flex align-items-center gap-2">'
            + '<span class="badge ' + dotClass + ' rounded-circle p-1">&nbsp;</span>'
            + '<div><div class="fw-semibold fs-13">' + escapeHtml(p.inst) + '</div>'
            + '<div class="text-muted fs-12">' + escapeHtml(p.type) + ' &middot; <strong class="' + textClass + '">' + label + '</strong></div></div>'
            + '</div></li>';
    }).join('');
}

function renderDssAlerts() {
    var expiringSoon = partnerships.filter(function(p) { return p.status === 'Expiring Soon'; }).sort(function(a,b){ return a.days - b.days; });
    var expired = partnerships.filter(function(p) { return p.status === 'Expired'; });

    var actionEl = document.getElementById('dss-action-text');
    if (actionEl) {
        if (expiringSoon.length) {
            var soonest = expiringSoon[0];
            actionEl.innerHTML = '<span class="fw-semibold">Action Required:</span> '
                + escapeHtml(soonest.inst) + ' ' + escapeHtml(soonest.type) + ' expires in <strong>' + soonest.days + ' day' + (soonest.days === 1 ? '' : 's') + '</strong>. '
                + (expiringSoon.length > 1 ? (expiringSoon.length - 1) + ' other agreement' + (expiringSoon.length > 2 ? 's are' : ' is') + ' also expiring within 90 days.' : 'Consider initiating renewal.');
        } else {
            actionEl.textContent = 'No agreements are currently expiring within the next 90 days.';
        }
    }

    var reviewEl = document.getElementById('dss-review-text');
    if (reviewEl) {
        if (expired.length) {
            var mostOverdue = expired.slice().sort(function(a,b){ return a.days - b.days; })[0];
            var overdueDays = Math.abs(mostOverdue.days);
            reviewEl.innerHTML = '<span class="fw-semibold">Review Suggested:</span> '
                + escapeHtml(mostOverdue.inst) + ' ' + escapeHtml(mostOverdue.type) + ' expired ' + overdueDays + ' day' + (overdueDays === 1 ? '' : 's') + ' ago. '
                + (expired.length > 1 ? (expired.length - 1) + ' other expired agreement' + (expired.length > 2 ? 's remain' : ' remains') + ' unrenewed.' : 'Renew or archive this record.');
        } else {
            reviewEl.textContent = 'No expired agreements currently require review.';
        }
    }
}

// ── Modal Helpers ────────────────────────────────────────────────────────────

// Independent modals (no swap/stacking between them) — each drops the breadcrumb back
// to the page base the moment it's closed for good. Registered once, not per open-call.
// viewPartnershipModal is NOT in this list (2026-11) — it now swaps with activitiesModal (List of
// Activities), and resetting the breadcrumb on every hide would also fire during that swap, same bug
// already found and fixed once in registry-gridjs.init.js's own identical loop.
['editPartnershipModal', 'renewPartnershipModal', 'deleteRecordModal'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('hidden.bs.modal', function () { if (typeof resetBreadcrumb === 'function') resetBreadcrumb(); });
});

var currentViewPartnershipId = null;
var viewToActivitiesSwap = false;
var activitiesReturnTo = null;
// Guarded with `if (el)`, same as the forEach loop just above — this script tag loads before the modal
// markup further down the page (confirmed in views/administrator/lifecycle.ejs), so document.getElementById
// here would otherwise return null and .addEventListener on it would throw, aborting the REST of this
// script's own top-level execution (openViewModal/openActivitiesModal/etc. would never get defined at all —
// exactly the "clicking does nothing" symptom this feature is being added to fix, not introduce).
(function () {
    var viewEl = document.getElementById('viewPartnershipModal');
    if (viewEl) viewEl.addEventListener('hidden.bs.modal', function () {
        if (viewToActivitiesSwap) { viewToActivitiesSwap = false; return; }
        if (typeof resetBreadcrumb === 'function') resetBreadcrumb();
    });
    var actEl = document.getElementById('activitiesModal');
    if (actEl) actEl.addEventListener('hidden.bs.modal', function () {
        if (activitiesReturnTo) {
            var returnTo = activitiesReturnTo;
            activitiesReturnTo = null;
            if (returnTo === 'viewPartnershipModal') openViewModal(currentViewPartnershipId);
            return;
        }
        if (typeof resetBreadcrumb === 'function') resetBreadcrumb();
    });
})();

function openViewModal(id) {
    var p = partnerships.find(function(x) { return x.id === id; });
    if (!p) return;
    currentViewPartnershipId = id;
    if (typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst]));
    document.getElementById('view-title').textContent = p.inst;
    document.getElementById('view-body').innerHTML =
        '<div class="row g-3">'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Institution</div><div class="fw-bold">' + escapeHtml(p.inst) + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Type</div><div>' + typeBadgeHtml(p.type) + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Category</div><div class="fw-bold">' + escapeHtml(p.cat) + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Status</div><div>' + statusBadgeHtml(p.status, p.days) + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Start Date</div><div class="fw-bold">' + escapeHtml(p.start) + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12 text-uppercase fw-semibold">Expiry Date</div><div class="fw-bold">' + escapeHtml(p.end) + '</div></div>'
        + '<div class="col-sm-12"><div class="text-muted fs-12 text-uppercase fw-semibold">Days Remaining</div><div class="fw-bold">' + (p.status === 'Expired' ? 'None' : p.days + ' days') + '</div></div>'
        + '</div>';
    // getOrCreateInstance, not `new bootstrap.Modal(...)` — this is also the modal openActivitiesModal()
    // swaps back to below; constructing a brand-new instance while the Activities modal's own
    // hide-transition/backdrop teardown might still be settling corrupts the backdrop count (same bug
    // already found and fixed once in registry-gridjs.init.js's own openViewModal).
    bootstrap.Modal.getOrCreateInstance(document.getElementById('viewPartnershipModal')).show();
}

// ── List of Activities (2026-11) — Administrator only (the button itself is role-gated in the EJS; the
// activities API routes are requireStaffAccess, so Staff would also work here if this page ever gained a
// Staff route, but Auth. Personnel never can). Straight port of registry-gridjs.init.js's own functions,
// adapted to this file's plain-fetch/showToast conventions instead of CIPRMS.api/CIPRMS.busy. ──
var currentActivities = [];
function renderActivitiesPartnerInfo(p) {
    document.getElementById('activities-title').textContent = 'List of Activities — ' + p.inst;
    document.getElementById('activities-partner-info').innerHTML =
        '<div class="col-sm-6"><div class="text-muted fs-12">Institution</div><div class="fw-semibold">' + escapeHtml(p.inst) + '</div></div>'
        + '<div class="col-sm-6"><div class="text-muted fs-12">Type</div><div class="fw-semibold">' + escapeHtml(p.type) + '</div></div>';
}
function renderActivitiesTable() {
    var tbody = document.getElementById('activities-tbody');
    var sorted = currentActivities.slice().sort(function (a, b) { return new Date(a.dateConducted) - new Date(b.dateConducted); });
    document.getElementById('activities-empty').style.display = sorted.length ? 'none' : '';
    tbody.innerHTML = sorted.map(function (a) {
        return '<tr><td>' + escapeHtml(a.dateConducted) + '</td><td>' + escapeHtml(a.activityConducted) + '</td>'
            + '<td>' + escapeHtml(a.natureOfActivity) + '</td><td>' + (a.remarks ? escapeHtml(a.remarks) : '—') + '</td></tr>';
    }).join('');
}
function openActivitiesModal(id) {
    if (!id) return;
    var p = partnerships.find(function (x) { return x.id === id; });
    if (!p) return;
    currentViewPartnershipId = id;
    renderActivitiesPartnerInfo(p);
    currentActivities = [];
    renderActivitiesTable();
    ['act-date', 'act-activity', 'act-nature', 'act-remarks'].forEach(function (f) { document.getElementById(f).value = ''; });
    document.getElementById('activities-add-error').style.display = 'none';
    if (typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst, 'List of Activities']));

    var viewInstance = bootstrap.Modal.getInstance(document.getElementById('viewPartnershipModal'));
    if (viewInstance) { viewToActivitiesSwap = true; viewInstance.hide(); }
    bootstrap.Modal.getOrCreateInstance(document.getElementById('activitiesModal')).show();

    fetch('/api/partnerships/' + id + '/activities')
        .then(function (r) { return r.json(); })
        .then(function (data) {
            if (Array.isArray(data.activities)) { currentActivities = data.activities; renderActivitiesTable(); }
        }).catch(function (e) { console.error(e); });
}
function backToViewFromActivities() {
    activitiesReturnTo = 'viewPartnershipModal';
    bootstrap.Modal.getInstance(document.getElementById('activitiesModal'))?.hide();
}
function addActivity() {
    var errBox = document.getElementById('activities-add-error');
    errBox.style.display = 'none';
    var payload = {
        dateConducted: document.getElementById('act-date').value,
        activityConducted: document.getElementById('act-activity').value.trim(),
        natureOfActivity: document.getElementById('act-nature').value.trim(),
        remarks: document.getElementById('act-remarks').value.trim()
    };
    if (!payload.dateConducted || !payload.activityConducted || !payload.natureOfActivity) {
        errBox.textContent = 'Date, activity conducted, and nature of activity are all required.';
        errBox.style.display = '';
        return;
    }
    var btn = document.getElementById('activities-add-btn');
    var html = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Adding…';
    fetch('/api/partnerships/' + currentViewPartnershipId + '/activities', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload)
    }).then(function (r) { return r.json(); }).then(function (data) {
        btn.disabled = false; btn.innerHTML = html;
        if (data.success && data.activity) {
            currentActivities.push(data.activity);
            renderActivitiesTable();
            ['act-date', 'act-activity', 'act-nature', 'act-remarks'].forEach(function (f) { document.getElementById(f).value = ''; });
            showToast('Activity added.');
        } else {
            errBox.textContent = (data && data.error) || 'Unable to add the activity right now.';
            errBox.style.display = '';
        }
    }).catch(function (e) {
        btn.disabled = false; btn.innerHTML = html;
        console.error(e);
        errBox.textContent = 'Unable to add the activity right now.';
        errBox.style.display = '';
    });
}
function exportActivitiesPdf() {
    if (!currentViewPartnershipId) return;
    var id = currentViewPartnershipId;
    var p = partnerships.find(function (x) { return x.id === id; });
    var filename = 'Activities-' + (p ? p.inst.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') : id) + '.pdf';
    var btn = document.getElementById('activities-export-btn');
    var html = btn.innerHTML;
    btn.disabled = true; btn.textContent = 'Exporting…';
    fetch('/api/partnerships/' + id + '/activities/export', { method: 'POST' }).then(function (res) {
        if (!res.ok) {
            return res.json().catch(function () { return {}; }).then(function (body) {
                throw new Error(body.error || 'Unable to export the PDF right now.');
            });
        }
        return res.blob();
    }).then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url; a.download = filename;
        document.body.appendChild(a); a.click(); a.remove();
        URL.revokeObjectURL(url);
    }).catch(function (err) {
        showToast(err.message || 'Unable to export the PDF right now.');
    }).then(function () { btn.disabled = false; btn.innerHTML = html; });
}

var editingId = null;
function openEditModal(id) {
    var p = partnerships.find(function(x) { return x.id === id; });
    if (!p) return;
    editingId = id;
    // toISOString() converts to UTC first, which silently shifts the shown calendar day back by one
    // whenever the browser's local timezone is ahead of UTC (e.g. Asia/Manila, UTC+8) — reading the
    // local Y/M/D components directly keeps the stored date intact for the <input type="date"> field.
    var toISO = function(s) { var d = new Date(s); if (isNaN(d)) return ''; return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
    document.getElementById('e-inst').value = p.inst;
    document.getElementById('e-type').value = p.type;
    document.getElementById('e-cat').value = p.cat;
    document.getElementById('e-expiry').value = toISO(p.end);
    document.getElementById('e-status').value = p.status;
    if (typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst, 'Edit']));
    new bootstrap.Modal(document.getElementById('editPartnershipModal')).show();
}

function computeEditStatus() {
    var v = document.getElementById('e-expiry').value;
    if (!v) return;
    var d = Math.ceil((new Date(v) - new Date()) / 86400000);
    document.getElementById('e-status').value = d < 0 ? 'Expired' : d <= 90 ? 'Expiring Soon' : 'Active';
}

function saveEdit() {
    var inst = document.getElementById('e-inst').value.trim(), expiry = document.getElementById('e-expiry').value;
    if (!inst || !expiry) { alert('Institution and Expiry Date are required.'); return; }
    var p = partnerships.find(function(x) { return x.id === editingId; });
    if (!p) return;
    var fmt = function(v) { return new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
    var updates = {
        inst: inst, type: document.getElementById('e-type').value, cat: document.getElementById('e-cat').value,
        end: fmt(expiry), endYear: new Date(expiry).getFullYear(), status: document.getElementById('e-status').value
    };
    fetch('/api/partnerships/' + editingId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) {
                p.inst = updates.inst; p.type = updates.type; p.cat = updates.cat; p.end = updates.end; p.status = updates.status;
                p.days = Math.ceil((new Date(p.end) - new Date()) / 86400000);
                bootstrap.Modal.getInstance(document.getElementById('editPartnershipModal'))?.hide();
                buildGrid(); renderOverview(); renderUrgentList(); renderDssAlerts();
                showToast('Agreement updated successfully.');
            }
        }).catch(function(e) { console.error(e); showToast('Error updating agreement.'); });
}

var renewingId = null;
function openRenewModal(id) {
    var p = partnerships.find(function(x) { return x.id === id; });
    if (!p) return;
    renewingId = id;
    document.getElementById('renew-inst-name').textContent = p.inst;
    document.getElementById('renew-inst-sub').textContent = p.type + ' · Previously expired: ' + p.end;
    document.getElementById('renew-prev-expiry').value = p.end;
    document.getElementById('renew-new-expiry').value = '';
    document.getElementById('renew-status').value = '';
    if (typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst, 'Renew']));
    new bootstrap.Modal(document.getElementById('renewPartnershipModal')).show();
}

function computeRenewStatus() {
    var v = document.getElementById('renew-new-expiry').value;
    if (!v) return;
    var d = Math.ceil((new Date(v) - new Date()) / 86400000);
    document.getElementById('renew-status').value = d < 0 ? 'Expired' : d <= 90 ? 'Expiring Soon' : 'Active';
}

function saveRenew() {
    var newEx = document.getElementById('renew-new-expiry').value;
    if (!newEx) { alert('Please set a new expiry date.'); return; }
    var p = partnerships.find(function(x) { return x.id === renewingId; });
    if (!p) return;
    var fmt = function(v) { return new Date(v).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }); };
    var d = Math.ceil((new Date(newEx) - new Date()) / 86400000);
    var updates = { end: fmt(newEx), endYear: new Date(newEx).getFullYear(), status: document.getElementById('renew-status').value };
    fetch('/api/partnerships/' + renewingId, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(updates) })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) {
                p.end = updates.end; p.status = updates.status; p.days = d;
                bootstrap.Modal.getInstance(document.getElementById('renewPartnershipModal'))?.hide();
                buildGrid(); renderOverview(); renderUrgentList(); renderDssAlerts();
                showToast('Agreement renewed successfully.');
            }
        }).catch(function(e) { console.error(e); showToast('Error renewing agreement.'); });
}

var deletingId = null;
function openDeleteModal(id) {
    deletingId = id;
    var p = partnerships.find(function(x) { return x.id === id; });
    if (p && typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst, 'Delete']));
    new bootstrap.Modal(document.getElementById('deleteRecordModal')).show();
}
function confirmDelete() {
    if (!deletingId) return;
    var idx = partnerships.findIndex(function(x) { return x.id === deletingId; });
    if (idx === -1) return;
    var name = partnerships[idx].inst;
    fetch('/api/partnerships/' + deletingId, { method: 'DELETE' })
        .then(function(r) { return r.json(); })
        .then(function(data) {
            if (data.success) {
                partnerships.splice(idx, 1); deletingId = null;
                bootstrap.Modal.getInstance(document.getElementById('deleteRecordModal'))?.hide();
                buildGrid(); renderOverview(); renderUrgentList(); renderDssAlerts();
                showToast('"' + name + '" has been removed.');
            }
        }).catch(function(e) { console.error(e); showToast('Error deleting agreement.'); });
}

var toastTimer = null;
function showToast(msg) {
    var t = document.getElementById('reg-toast');
    document.getElementById('reg-toast-msg').textContent = msg;
    t.style.display = 'flex';
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function() { t.style.display = 'none'; }, 3500);
}

// Init on DOM ready — buildGrid()/renderOverview()/etc. are called by fetch().then() above
document.addEventListener('DOMContentLoaded', function() {});
