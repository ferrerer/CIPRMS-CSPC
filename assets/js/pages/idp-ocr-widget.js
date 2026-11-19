/* Shared Intelligent Document Processing (IDP) result renderer — used by the
 * Registry "Add Partnership" OCR panel and both Partnership Request forms
 * (Auth. Personnel and potential_partner). Reuses the same /api/ocr/extract
 * + /api/ocr/status/:jobId job result that the existing OCR flow already
 * produces (see services/ocrService.js / extractionService.js) — this file
 * only renders it and exposes a couple of small DOM helpers; it does not
 * talk to the network itself except for the two duplicate-warning actions,
 * which reuse the existing PATCH /api/documents/:id/organize route.
 *
 * Usage per page:
 *   IDP.renderResult('some-container-id', result, {
 *     docTypeSelectId: 'existing select id to sync, optional',
 *     onCancelDuplicate: function(documentId){ ... },   // "Cancel" button
 *     onViewDuplicate: function(fileLink){ ... }         // "View Existing" button
 *   });
 *   IDP.markFilled('pr-f-inst', confidencePctOrNull); // called once per field a form's own apply function actually set
 *   IDP.mapDocumentType(detectedType, ['MOA','MOU','LOI','JVA','Other']); // -> a valid option, or null if none maps confidently
 *
 * 2026-07-29 UX upgrade: the Partnership Request forms (personnel_requests.ejs,
 * partner_requests.ejs) now call their own apply function automatically as
 * soon as OCR succeeds, instead of waiting for a button click — this file's
 * job stays the same (render the result panel + expose highlight/mapping
 * helpers); which page calls markFilled() automatically vs. on a click is
 * each page's own decision, not this shared widget's.
 */
(function (global) {
  'use strict';

  var DOC_TYPE_OPTIONS = [
    'Memorandum of Agreement (MOA)', 'Memorandum of Understanding (MOU)', 'Letter of Intent',
    'Partnership Proposal', 'Accreditation/Certification', 'Research Agreement',
    'Student Exchange Agreement', 'Faculty Exchange Agreement', 'Training Agreement',
    'Contract', 'Other'
  ];

  var CONFIDENCE_FIELDS = [
    ['institution', 'Institution Name'], ['country', 'Country'], ['documentType', 'Document Type'],
    ['nature', 'Nature of Partnership'], ['category', 'Category'], ['region', 'Region'],
    ['unit', 'Responsible CSPC Unit'], ['startDate', 'Start Date'], ['endDate', 'End Date']
  ];

  // A detected document type maps onto a form's fixed dropdown only when it
  // confidently matches one of these — anything else (e.g. "Research
  // Agreement", which has no dedicated option on the Partnership Request
  // forms) is intentionally left unmapped so the caller can leave the
  // dropdown blank and warn, rather than guessing.
  var TYPE_ALIASES = [
    [/memorandum of understanding/i, 'MOU'], [/\bmou\b/i, 'MOU'],
    [/memorandum of agreement/i, 'MOA'], [/\bmoa\b/i, 'MOA'],
    [/letter of intent/i, 'LOI'], [/\bloi\b/i, 'LOI'],
    [/joint venture/i, 'JVA'], [/\bjva\b/i, 'JVA']
  ];

  var LOW_CONFIDENCE_THRESHOLD = 70;
  var AUTOFILL_PULSE_MS = 4000; // "briefly" highlight what just changed, then let it fade even if the user never touches it

  function injectStyleOnce() {
    if (document.getElementById('idp-widget-style')) return;
    var style = document.createElement('style');
    style.id = 'idp-widget-style';
    style.textContent =
      '.ocr-autofilled{background-color:#fff8e1!important;border-color:#f7b84b!important;transition:background-color 1.2s ease,border-color 1.2s ease}' +
      '.ocr-low-confidence{border-color:#f06548!important;box-shadow:0 0 0 1px rgba(240,101,72,.25)}' +
      '.ocr-conf-warn{font-size:.72rem}' +
      '.idp-summary{background:#f8f9fb;border-left:3px solid #405189;padding:.6rem .9rem;font-size:.83rem;color:#3c3c3c;border-radius:4px}' +
      '.idp-conf-grid{display:flex;flex-wrap:wrap;gap:6px}';
    document.head.appendChild(style);
  }

  function confidenceClass(pct) {
    if (pct >= 95) return 'success';
    if (pct >= 80) return 'primary';
    if (pct >= 60) return 'warning';
    return 'danger';
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function confidenceBadge(label, pct) {
    var cls = confidenceClass(pct);
    return '<span class="badge bg-' + cls + '-subtle text-' + cls + ' me-1 mb-1">' +
      esc(label) + ': ' + Math.round(pct) + '%</span>';
  }

  // confidence is optional — pass the field's <x>Confidence value when known so a low-confidence
  // auto-filled value still gets the persistent border highlight (ocr-low-confidence), not just the
  // "briefly, just filled" pulse. The "Low confidence (NN%) — please verify this value." text label this
  // used to insert next to the field was removed (2026-11) per request — the confidence value itself, and
  // this border-highlight behavior that depends on it, are both unchanged.
  function markFilled(id, confidence) {
    injectStyleOnce();
    var el = document.getElementById(id);
    if (!el) return;

    el.classList.add('ocr-autofilled');
    var pulseTimer = setTimeout(function () { el.classList.remove('ocr-autofilled'); }, AUTOFILL_PULSE_MS);

    var clear = function () {
      clearTimeout(pulseTimer);
      el.classList.remove('ocr-autofilled');
      el.classList.remove('ocr-low-confidence');
    };
    el.addEventListener('input', clear, { once: true });
    el.addEventListener('change', clear, { once: true });

    if (confidence != null && confidence > 0 && confidence < LOW_CONFIDENCE_THRESHOLD) {
      el.classList.add('ocr-low-confidence');
    }
  }

  // Maps a free-text detected document type onto one of a form's actual
  // dropdown options. Returns null (never a guess) when nothing matches
  // confidently — the caller is expected to leave the field blank and show a
  // small warning in that case, per the "don't insert placeholders" rule.
  function mapDocumentType(detectedType, validOptions) {
    if (!detectedType || !validOptions || !validOptions.length) return null;
    for (var i = 0; i < TYPE_ALIASES.length; i++) {
      if (TYPE_ALIASES[i][0].test(detectedType) && validOptions.indexOf(TYPE_ALIASES[i][1]) !== -1) {
        return TYPE_ALIASES[i][1];
      }
    }
    return null;
  }

  function renderResult(containerId, result, opts) {
    injectStyleOnce();
    opts = opts || {};
    var container = document.getElementById(containerId);
    if (!container || !result) return;

    var html = '';

    // ✓ OCR Summary
    if (result.summary) {
      html += '<div class="idp-summary mb-3"><i class="ri-sparkling-2-line text-primary me-1"></i>' + esc(result.summary) + '</div>';
    }

    // ✓ Document Type (+ manual override when confidence is low)
    var detectedType = result.documentType || 'Other';
    var typeConf = result.documentTypeConfidence || 0;
    html += '<div class="mb-3"><label class="form-label fs-13 fw-semibold mb-1">Document Type</label><div class="d-flex align-items-center gap-2 flex-wrap">';
    html += confidenceBadge('Detected', typeConf) || '';
    html += '<select class="form-select form-select-sm" style="max-width:280px" id="' + containerId + '-doctype-select">';
    DOC_TYPE_OPTIONS.forEach(function (t) {
      html += '<option value="' + esc(t) + '"' + (t === detectedType ? ' selected' : '') + '>' + esc(t) + '</option>';
    });
    if (detectedType && DOC_TYPE_OPTIONS.indexOf(detectedType) === -1) {
      html += '<option value="' + esc(detectedType) + '" selected>' + esc(detectedType) + '</option>';
    }
    html += '</select></div></div>';

    // ✓ Confidence Scores
    var confHtml = '';
    CONFIDENCE_FIELDS.forEach(function (pair) {
      var pct = result[pair[0] + 'Confidence'];
      if (pct) confHtml += confidenceBadge(pair[1], pct);
    });
    if (confHtml) html += '<div class="mb-3"><label class="form-label fs-13 fw-semibold mb-1">Confidence Scores</label><div class="idp-conf-grid">' + confHtml + '</div></div>';

    // ✓ Expiration Date / ✓ Renewal Reminder Status
    if (result.endDate) {
      var expClass = result.expirationLabel === 'Expired' ? 'danger' : result.expirationLabel === 'Expiring Soon' ? 'warning' : 'success';
      var expText = result.expirationLabel === 'Expired'
        ? 'Already expired'
        : (result.remainingDays != null ? result.remainingDays + ' day(s) remaining' : result.expirationLabel || '');
      html += '<div class="mb-3"><label class="form-label fs-13 fw-semibold mb-1">Expiration / Renewal Monitoring</label><div>' +
        '<span class="badge bg-' + expClass + '-subtle text-' + expClass + '">' + esc(result.expirationLabel || 'Active') + ' — ' + esc(expText) + '</span> ' +
        '<span class="text-muted fs-12">Once saved to the Registry, this partnership is automatically tracked by the existing renewal/expiry monitoring system.</span></div></div>';
    }

    // ✓ Duplicate Warning
    if (result.duplicateWarning && result.duplicateWarning.found) {
      html += '<div class="alert alert-warning mb-3" id="' + containerId + '-dup-alert">' +
        '<div class="fw-semibold mb-1"><i class="ri-error-warning-line me-1"></i>Possible duplicate partnership document found.</div>' +
        '<ul class="mb-2 fs-13">';
      result.duplicateWarning.matches.forEach(function (m, i) {
        html += '<li>' + esc(m.title) + (m.reason ? ' <span class="text-muted">(' + esc(m.reason) + ')</span>' : '') +
          ' — <a href="#" class="idp-view-dup" data-filelink="' + esc(m.fileLink || '') + '">View Existing</a></li>';
      });
      html += '</ul>' +
        '<button type="button" class="btn btn-sm btn-outline-secondary me-2 idp-continue-upload">Continue Upload</button>' +
        '<button type="button" class="btn btn-sm btn-outline-danger idp-cancel-upload">Cancel (Archive This Upload)</button>' +
        '</div>';
    }

    // Search Keywords are intentionally NOT rendered here (2026-07-29) — the
    // backend still computes/persists them (services/extractionService.js,
    // documentLibraryService.js) for Document Library full-text search, they
    // just aren't shown on this results panel.

    // Image Quality Warnings
    if (result.imageQuality && result.imageQuality.warnings && result.imageQuality.warnings.length) {
      html += '<div class="alert alert-info py-2 fs-13 mb-0"><i class="ri-image-line me-1"></i><strong>Image quality:</strong> ' +
        result.imageQuality.warnings.map(function (w) { return esc(w.message); }).join(' ') +
        ' <span class="text-muted">You may continue — this only affects extraction accuracy.</span></div>';
    }

    container.innerHTML = html;
    container.style.display = '';

    // Wire duplicate-warning buttons
    var dupAlert = document.getElementById(containerId + '-dup-alert');
    if (dupAlert) {
      dupAlert.querySelectorAll('.idp-view-dup').forEach(function (a) {
        a.addEventListener('click', function (e) {
          e.preventDefault();
          var link = a.getAttribute('data-filelink');
          if (link && typeof opts.onViewDuplicate === 'function') opts.onViewDuplicate(link);
          else if (link) window.open(link, '_blank');
        });
      });
      var cancelBtn = dupAlert.querySelector('.idp-cancel-upload');
      if (cancelBtn) cancelBtn.addEventListener('click', function () {
        if (typeof opts.onCancelDuplicate === 'function') opts.onCancelDuplicate(result.documentId);
        dupAlert.innerHTML = '<span class="text-muted fs-13"><i class="ri-archive-line me-1"></i>This upload was archived and removed from the active Document Library.</span>';
      });
      var continueBtn = dupAlert.querySelector('.idp-continue-upload');
      if (continueBtn) continueBtn.addEventListener('click', function () { dupAlert.style.display = 'none'; });
    }

    // Keep the doctype <select> in sync with an existing on-page select, if named
    if (opts.docTypeSelectId) {
      var mirror = document.getElementById(opts.docTypeSelectId);
      var picker = document.getElementById(containerId + '-doctype-select');
      if (mirror && picker) picker.addEventListener('change', function () { mirror.value = picker.value; });
    }
  }

  function getSelectedDocType(containerId) {
    var picker = document.getElementById(containerId + '-doctype-select');
    return picker ? picker.value : null;
  }

  global.IDP = {
    DOC_TYPE_OPTIONS: DOC_TYPE_OPTIONS,
    LOW_CONFIDENCE_THRESHOLD: LOW_CONFIDENCE_THRESHOLD,
    confidenceClass: confidenceClass,
    confidenceBadge: confidenceBadge,
    markFilled: markFilled,
    mapDocumentType: mapDocumentType,
    renderResult: renderResult,
    getSelectedDocType: getSelectedDocType
  };
})(window);
