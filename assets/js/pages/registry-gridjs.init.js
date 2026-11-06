// ── Registry – Grid.js init (Velzon pattern) ─────────────────────────────────

var partnerships = [];
var filtered = [];
var regCurrentPage = 1;
var regPageSize = 10; // selectable (2026-11 panel recommendation) — was a hardcoded 6

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

function goToRegPage(p) {
    regCurrentPage = p;
    buildGrid();
}

// Set while the Add New Partnership modal was opened via "Approve" on a
// pending Partnership Request (see checkFromRequestParam()) — carries the
// source request's id so submitPartnership() can link the two records.
// Cleared whenever the modal closes, whether or not it was saved.
var pendingRequestConversion = null;

// ── Institution autocomplete — worldwide university search ───────────────────
// Backed by the /api/institutions proxy (universities.hipolabs.com). Country
// auto-fills exactly from the matched record; region auto-fills from a best-
// effort country→region table and is simply left blank (for manual selection)
// for any country not in it — never guessed.
var COUNTRY_REGION = {
  'Philippines': 'Local',
  'Japan': 'Asia', 'South Korea': 'Asia', 'China': 'Asia', 'Singapore': 'Asia', 'Thailand': 'Asia',
  'Vietnam': 'Asia', 'Malaysia': 'Asia', 'Indonesia': 'Asia', 'India': 'Asia', 'Taiwan': 'Asia',
  'Hong Kong': 'Asia', 'Cambodia': 'Asia', 'Brunei': 'Asia', 'Myanmar': 'Asia', 'Laos': 'Asia',
  'Pakistan': 'Asia', 'Bangladesh': 'Asia', 'Sri Lanka': 'Asia', 'Nepal': 'Asia',
  'United Kingdom': 'Europe', 'Germany': 'Europe', 'France': 'Europe', 'Spain': 'Europe', 'Italy': 'Europe',
  'Netherlands': 'Europe', 'Switzerland': 'Europe', 'Sweden': 'Europe', 'Norway': 'Europe', 'Denmark': 'Europe',
  'Finland': 'Europe', 'Belgium': 'Europe', 'Austria': 'Europe', 'Poland': 'Europe', 'Portugal': 'Europe',
  'Ireland': 'Europe', 'Greece': 'Europe', 'Russia': 'Europe', 'Czech Republic': 'Europe',
  'United States': 'Americas', 'USA': 'Americas', 'Canada': 'Americas', 'Mexico': 'Americas', 'Brazil': 'Americas',
  'Argentina': 'Americas', 'Chile': 'Americas', 'Colombia': 'Americas', 'Peru': 'Americas',
  'Australia': 'Oceania', 'New Zealand': 'Oceania', 'Fiji': 'Oceania',
  'South Africa': 'Africa', 'Nigeria': 'Africa', 'Kenya': 'Africa', 'Egypt': 'Africa', 'Ghana': 'Africa', 'Morocco': 'Africa'
};

// COUNTRY_OPTIONS (2026-09-22, moved to its own shared file 2026-09-23 so the Reports & Analytics Custom
// Report Builder's Country filter can use the exact same list) now lives in assets/js/shared/country-options.js
// — loaded as a separate <script> tag before this file in monitoring.ejs. Kept in sync with cirl.js's
// VALID_PARTNERSHIP_COUNTRIES (server-side validation uses the exact same names).

// Common alternate spellings/abbreviations an external source (the worldwide-university API in selectInstitution(),
// or OCR'd/request text) might produce, mapped to this dropdown's exact option text. Matching is otherwise exact
// (case-insensitive) by design — an unrecognized name is never guessed at, only these well-known equivalents.
var COUNTRY_ALIASES = {
  'usa': 'United States', 'us': 'United States', 'u.s.a.': 'United States', 'u.s.': 'United States',
  'united states of america': 'United States', 'america': 'United States',
  'uk': 'United Kingdom', 'u.k.': 'United Kingdom', 'great britain': 'United Kingdom', 'britain': 'United Kingdom',
  'korea, south': 'South Korea', 'republic of korea': 'South Korea', 's. korea': 'South Korea',
  'korea, north': 'North Korea', 'dprk': 'North Korea',
  'viet nam': 'Vietnam', 'russian federation': 'Russia', 'uae': 'United Arab Emirates',
  'u.a.e.': 'United Arab Emirates', 'macao': 'Macau', 'czechia': 'Czech Republic',
  'cote d\'ivoire': 'Ivory Coast', 'côte d\'ivoire': 'Ivory Coast', 'east timor': 'Timor-Leste',
  'swaziland': 'Eswatini', 'burma': 'Myanmar', 'cape verde': 'Cabo Verde',
  'republic of the congo': 'Congo (Republic of the)', 'congo-brazzaville': 'Congo (Republic of the)',
  'dr congo': 'Democratic Republic of the Congo', 'congo-kinshasa': 'Democratic Republic of the Congo'
};

// Finds the exact COUNTRY_OPTIONS entry a raw string (from OCR, an approved request, or the worldwide
// institution API) refers to — an exact case-insensitive match first, then a small known-alias table for
// minor formatting differences ("USA", "U.K.", trailing periods). Returns null (never a guess) when the raw
// value isn't recognized, so a caller can leave the field for manual selection instead of picking wrong.
function resolveCountryOption(raw) {
  var q = String(raw == null ? '' : raw).trim();
  if (!q) return null;
  var exact = COUNTRY_OPTIONS.find(function (o) { return o.toLowerCase() === q.toLowerCase(); });
  if (exact) return exact;
  var key = q.toLowerCase().replace(/\.$/, '').replace(/\.(?=\s|$)/g, '');
  var alias = COUNTRY_ALIASES[q.toLowerCase()] || COUNTRY_ALIASES[key];
  return (alias && COUNTRY_OPTIONS.indexOf(alias) !== -1) ? alias : null;
}

// Fills a Country <select> with every COUNTRY_OPTIONS entry (alphabetical, exactly as authored above) below
// its existing placeholder option — called once per select at load, not rebuilt afterward.
function populateCountrySelect(id) {
  var el = document.getElementById(id);
  if (!el) return;
  var frag = document.createDocumentFragment();
  COUNTRY_OPTIONS.forEach(function (name) {
    var opt = document.createElement('option');
    opt.value = name; opt.textContent = name;
    frag.appendChild(opt);
  });
  el.appendChild(frag);
}

// Keeps the visible, searchable Country combobox input (see createCountryCombo below) showing exactly what the
// real, hidden <select> currently holds — called after anything OTHER than the combobox's own click/Enter
// selection sets the select's value directly (OCR, edit-modal load, the worldwide-institution auto-fill, the
// map preview's "Did you mean" suggestion), so the two never visibly disagree.
function syncCountryDisplay(prefix) {
  var select = document.getElementById(prefix + '-country');
  var display = document.getElementById(prefix + '-country-input');
  if (select && display) display.value = select.value || '';
}

// Applies an externally-sourced country value (OCR, an approved request, the worldwide institution API) to a
// Country <select> — auto-selects it when it (or a known alias of it) matches an option; otherwise the select
// is left exactly as it was and a small hint below it names the unrecognized value so the person knows manual
// selection may be needed, rather than silently choosing something that might be wrong. Returns true when a
// value was actually selected (callers use this to decide whether to flag the field as "OCR-filled").
function setCountryField(prefix, raw) {
  var select = document.getElementById(prefix + '-country');
  var hint = document.getElementById(prefix + '-country-hint');
  if (!select) return null;
  var matched = resolveCountryOption(raw);
  if (matched) {
    select.value = matched;
    if (hint) { hint.classList.add('d-none'); hint.textContent = ''; }
    syncCountryDisplay(prefix);
    return matched;
  }
  if (raw && hint) {
    hint.innerHTML = '<i class="ri-error-warning-line me-1"></i>Detected "' + escapeHtml(raw) + '" — not in the list above; please select the country manually.';
    hint.classList.remove('d-none');
  }
  syncCountryDisplay(prefix);
  return null;
}

// Edit modal only: an existing partnership's stored country might legitimately be something this form's own
// closed list doesn't (yet) contain — a legacy free-text value from before this field became a dropdown, or a
// spelling this list doesn't carry. Rather than silently leaving the select blank (which would erase that
// value the moment the form is saved), an extra option holding the exact stored text is added and selected, so
// the true value is visibly preserved and an untouched save keeps it byte-for-byte unchanged. The combobox's
// dropdown (createCountryCombo) also offers this exact preserved value as its own top search result, so it
// stays selectable/searchable like any other option, just not one of COUNTRY_OPTIONS.
function setEditCountryValue(value) {
  var select = document.getElementById('e-country');
  if (!select) return;
  select.querySelectorAll('option[data-legacy-country]').forEach(function (o) { o.remove(); });
  var matched = resolveCountryOption(value);
  if (matched) { select.value = matched; syncCountryDisplay('e'); return; }
  var trimmed = String(value == null ? '' : value).trim();
  if (!trimmed) { select.value = ''; syncCountryDisplay('e'); return; }
  var opt = document.createElement('option');
  opt.value = trimmed; opt.textContent = trimmed + ' (not in list)';
  opt.setAttribute('data-legacy-country', '1');
  select.insertBefore(opt, select.firstChild.nextSibling);
  select.value = trimmed;
  syncCountryDisplay('e');
}

// Country — single-select searchable combobox (2026-09-22): the person can type to filter (substring match,
// anywhere in the name — "land" finds Finland/Iceland/Ireland/..., "republic" finds every option containing
// it) but the value that ends up in the real, hidden <select id="{prefix}-country"> (still exactly what
// submitPartnership()/saveEdit()/setCountryField()/setEditCountryValue()/the institution-autocomplete auto-fill
// already read and write) can only ever be one of COUNTRY_OPTIONS, or — Edit only — the one legacy value
// setEditCountryValue() preserved. This deliberately reuses the exact same searchable-list interaction and CSS
// (.unit-combo*) as the Unit/Nature comboboxes above rather than a single-select mode bolted onto
// createChipCombo (that factory is chip/multi-value shaped throughout); it is its own small function because a
// single committed value, not a growing chip list, is a different enough shape to not force through the same
// code paths. A native <select> was tried first (see the 2026-09-22 "Country dropdown" change this replaces)
// but cannot filter by substring — only this already-established in-house pattern does, and the project has no
// working third-party searchable-select library (choices.min.js is referenced in older pages but the vendor
// file itself is absent — confirmed 404 in live testing — so it was never a real option to build on).
function createCountryCombo(prefix) {
  var select = document.getElementById(prefix + '-country');
  var input = document.getElementById(prefix + '-country-input');
  var dropdown = document.getElementById(prefix + '-country-dropdown');
  if (!select || !input || !dropdown) return null;
  var blurTimer = null;

  function legacyOptionValue() {
    var opt = select.querySelector('option[data-legacy-country]');
    return opt ? opt.value : null;
  }
  function searchPool() {
    var legacy = legacyOptionValue();
    return legacy ? [legacy].concat(COUNTRY_OPTIONS) : COUNTRY_OPTIONS;
  }
  function closeDropdown() {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
  }
  function selectValue(val) {
    select.value = val;
    input.value = val;
    // A real <select>'s own dropdown fires a native 'change' event on pick — this combobox fronts that select
    // instead of the person interacting with it directly, so the same event has to be dispatched by hand to
    // keep existing 'change'-driven behavior (the map-location preview refresh) working exactly as before.
    select.dispatchEvent(new Event('change', { bubbles: true }));
    var hint = document.getElementById(prefix + '-country-hint');
    if (hint) { hint.classList.add('d-none'); hint.textContent = ''; }
    closeDropdown();
  }
  function openDropdown() {
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
    var q = input.value.trim().toLowerCase();
    if (dropdown.style.display === 'block' && dropdown.dataset.q === q) return;
    dropdown.dataset.q = q;
    var matches = q ? searchPool().filter(function (c) { return c.toLowerCase().indexOf(q) !== -1; }) : searchPool();
    dropdown.innerHTML = matches.length
      ? matches.map(function (c) { return '<div class="unit-combo-option" data-val="' + escapeHtml(c) + '">' + escapeHtml(c) + '</div>'; }).join('')
      : '<div class="unit-combo-empty">No matching country.</div>';
    dropdown.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
    dropdown.querySelectorAll('.unit-combo-option').forEach(function (opt) {
      opt.addEventListener('mousedown', function (e) { e.preventDefault(); selectValue(opt.getAttribute('data-val')); });
    });
  }

  input.addEventListener('focus', openDropdown);
  input.addEventListener('click', openDropdown); // re-opens after a pick closed it (focus is a no-op if already focused)
  input.addEventListener('input', openDropdown);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var q = input.value.trim().toUpperCase();
      var pool = searchPool();
      var match = pool.find(function (c) { return c.toUpperCase() === q; }) || pool.find(function (c) { return c.toUpperCase().indexOf(q) === 0; });
      if (match) selectValue(match);
    } else if (e.key === 'Escape' && dropdown.style.display === 'block') {
      // Only intercept Escape while OUR dropdown is actually open, and stop it there — Bootstrap's modal also
      // listens for Escape (its default "close on Escape" behavior) on the same bubbling keydown, so without
      // this the same keypress that was meant to just dismiss the country results would also close the whole
      // Add/Edit Partnership form and discard everything already filled in. With nothing open, Escape is left
      // alone to reach the modal as normal.
      e.stopPropagation();
      closeDropdown();
      input.value = select.value || ''; // discard an unmatched in-progress query
    }
  });
  input.addEventListener('blur', function () {
    blurTimer = setTimeout(function () {
      closeDropdown();
      // A typed query that was never actually picked (left partial/unmatched on blur) must not masquerade as
      // a real selection — revert the visible text to whatever is genuinely selected in the hidden <select>.
      input.value = select.value || '';
    }, 120);
  });

  input.value = select.value || '';
}

populateCountrySelect('f-country');
populateCountrySelect('e-country');
createCountryCombo('f');
createCountryCombo('e');

var instSearchTimer = null;
var instResults = [];
var instActiveIndex = -1;
var instPrefix = 'f'; // which field set ('f' = Add form, 'e' = Edit modal) the open dropdown belongs to

// HTML-escape untrusted text (institution name/country come from a third-party
// API) before it goes into innerHTML — never trust external API content as safe markup.
function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

// Validate a stored document/partner link before it's ever placed into an
// href (2026-09-06 security hardening) — escaping alone protects text
// content but NOT an attribute that can carry its own dangerous scheme
// (javascript:, data:, vbscript:, ...). The Add/Edit Partnership form's
// Document Link field is a native type="url" input seeded with an
// "https://…" placeholder, so only absolute http(s) URLs or the app's own
// relative paths are ever legitimately stored here — anything else is
// refused rather than guessed at.
function sanitizeUrl(url) {
  var s = String(url == null ? '' : url).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.charAt(0) === '/' && s.charAt(1) !== '/') return s; // same-app relative path, not protocol-relative
  return '';
}

// ── "Responsible Unit" combobox — searchable multi-select restricted to the
// predefined CSPC unit list, with removable chips (2026-09-03). Unlike the
// Document Request combobox elsewhere in this app, no custom/free-text
// entries are allowed here — only values from this list are ever selectable
// (restrictToOptions stays true, below).
//
// 2026-11 investigation, extracted 2026-11 (Dynamic College/Unit Dropdowns): UNIT_OPTIONS and its
// load/add-new machinery now live in assets/js/shared/responsible-units.js (loaded before this file, same
// as COUNTRY_OPTIONS/country-options.js below), reused as-is by Reports & Analytics' College/Unit filter
// and Comparison fields too — see that file for loadResponsibleUnits()/openAddResponsibleUnitModal()/
// submitAddResponsibleUnit(). createUnitCombo() below still hands that exact shared array reference to
// both the Add and Edit forms' combos, so updating its contents in place is what lets a newly added unit
// appear in an already-constructed combo without reconstructing it — unchanged from before the extraction.

// "Nature of Partnership" reuses this exact same searchable chip-combobox
// pattern (2026-09-19, multi-select) — same predefined-list behavior as
// Unit, just backed by its own option list and its own set of element ids
// (f/e-nature-chips/-input/-dropdown instead of -unit-*). The options below
// are the exact 8 values the single-select dropdown it replaced already had
// — none added, none removed.
var NATURE_OPTIONS = ['Research', 'Student Exchange', 'Training', 'Conference', 'Faculty Exchange', 'Joint Program', 'Internship', 'Other'];

// Generic factory behind both combos above — parameterized by `field` (the
// id-segment: 'unit' or 'nature') and its own allowed `options` list, so the
// exact same searchable/removable-chips behavior, keyboard handling, and
// outside-click-closes-dropdown logic isn't duplicated per field.
//
// `restrictToOptions` (default true, Unit's original behavior) controls what
// setValues() does with a value that ISN'T in `options`: Unit has always had
// closed-set backend validation, so filtering out anything unrecognized here
// is pure defense-in-depth. Nature never had that closed-set validation as a
// plain string, so an existing record can legitimately hold a value outside
// this form's 8 options (e.g. a legacy/free-text/OCR value) — silently
// dropping it on load would destroy real data, so Nature passes
// restrictToOptions:false and keeps any such value as its own chip (visible,
// removable) while the dropdown of NEW picks still only ever offers the
// fixed list.
function createChipCombo(prefix, field, options, comboOpts) {
  var restrictToOptions = !(comboOpts && comboOpts.restrictToOptions === false);
  var selected = [];
  var chips = document.getElementById(prefix + '-' + field + '-chips');
  var input = document.getElementById(prefix + '-' + field + '-input');
  var dropdown = document.getElementById(prefix + '-' + field + '-dropdown');
  // A blur (e.g. clicking a chip's remove button, which isn't
  // mousedown-guarded like dropdown options are) schedules a delayed close
  // rather than an immediate one. If the input regains focus before that
  // timer fires, it must be cancelled — otherwise it can fire asynchronously
  // in the middle of a later, unrelated interaction and wipe the dropdown
  // out from under it.
  var blurTimer = null;

  function renderChips() {
    chips.innerHTML = selected.map(function (val, i) {
      return '<span class="unit-chip">' + escapeHtml(val) +
        '<button type="button" data-i="' + i + '" aria-label="Remove ' + escapeHtml(val) + '">&times;</button></span>';
    }).join('');
    chips.querySelectorAll('button').forEach(function (btn) {
      btn.addEventListener('click', function () {
        selected.splice(parseInt(btn.getAttribute('data-i'), 10), 1);
        renderChips();
        input.classList.remove('is-invalid');
      });
    });
  }

  function closeDropdown() {
    dropdown.style.display = 'none';
    dropdown.innerHTML = '';
    input.setAttribute('aria-expanded', 'false');
  }

  function addValue(val) {
    if (!val || selected.indexOf(val) !== -1) { input.value = ''; closeDropdown(); return; }
    selected.push(val);
    renderChips();
    input.value = '';
    input.classList.remove('is-invalid');
    closeDropdown();
    input.focus();
  }

  function openDropdown() {
    if (blurTimer) { clearTimeout(blurTimer); blurTimer = null; }
    var q = input.value.trim().toLowerCase();
    // 'focus' and 'click' both fire on a mouse click into an unfocused input,
    // and both call this function — without this guard, the second call
    // rebuilds the option list (a fresh set of DOM nodes) a moment after the
    // first, which can detach the very node a fast synthetic click (e.g.
    // Playwright) is already mid-click on. Skip the rebuild when the
    // dropdown is already open showing this exact query's results.
    if (dropdown.style.display === 'block' && dropdown.dataset.q === q) return;
    dropdown.dataset.q = q;
    var available = options.filter(function (u) { return selected.indexOf(u) === -1; });
    var matches = q ? available.filter(function (u) { return u.toLowerCase().indexOf(q) !== -1; }) : available;
    // "+ Add Responsible Unit" (2026-11) — Unit-only (comboOpts.allowAddNew), appended after the real
    // options/empty-state rather than replacing them, so it's discoverable without hiding the existing
    // list it sits below — the exact same dropdown the user is already searching, not a second,
    // separate control elsewhere on the form.
    var addRowHtml = (comboOpts && comboOpts.allowAddNew)
      ? '<div class="unit-combo-option unit-combo-add" data-add="1"><i class="ri-add-line me-1"></i>Add Responsible Unit</div>'
      : '';
    dropdown.innerHTML = (matches.length
      ? matches.map(function (u) { return '<div class="unit-combo-option" data-val="' + escapeHtml(u) + '">' + escapeHtml(u) + '</div>'; }).join('')
      : '<div class="unit-combo-empty">' + (available.length ? 'No matching option.' : 'All options selected.') + '</div>') + addRowHtml;
    dropdown.style.display = 'block';
    input.setAttribute('aria-expanded', 'true');
    var addRow = dropdown.querySelector('.unit-combo-add');
    if (addRow) {
      addRow.addEventListener('mousedown', function (e) {
        e.preventDefault(); // same reason as the real options below — a mousedown-before-blur guard, not a click
        closeDropdown();
        openAddResponsibleUnitModal({ getValues: function () { return selected.slice(); }, addValue: addValue });
      });
    }
    dropdown.querySelectorAll('.unit-combo-option:not(.unit-combo-add)').forEach(function (opt) {
      opt.addEventListener('mousedown', function (e) {
        e.preventDefault();
        addValue(opt.getAttribute('data-val'));
      });
    });
  }

  input.addEventListener('focus', openDropdown);
  // 'click' (not just 'focus') so re-clicking an already-focused input
  // reopens the dropdown after a selection closed it — selecting an option
  // calls input.focus(), which is a no-op (and fires no 'focus' event) when
  // the input is already the active element.
  input.addEventListener('click', openDropdown);
  input.addEventListener('input', openDropdown);
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') {
      e.preventDefault();
      var q = input.value.trim().toUpperCase();
      var match = options.filter(function (u) { return selected.indexOf(u) === -1; })
        .find(function (u) { return u.toUpperCase() === q || u.toUpperCase().indexOf(q) === 0; });
      if (match) addValue(match);
    } else if (e.key === 'Backspace' && !input.value && selected.length) {
      selected.pop();
      renderChips();
    } else if (e.key === 'Escape') {
      closeDropdown();
    }
  });
  input.addEventListener('blur', function () { blurTimer = setTimeout(closeDropdown, 120); });

  return {
    getValues: function () { return selected.slice(); },
    setValues: function (vals) {
      // Accepts an array (new records) or a single legacy string value
      // (records created before the 2026-09-03 multi-unit / 2026-09-19
      // multi-nature combobox).
      var arr = Array.isArray(vals) ? vals : (vals ? [vals] : []);
      arr = arr.filter(function (v) { return typeof v === 'string' && v.trim(); }).map(function (v) { return v.trim(); });
      selected = restrictToOptions ? arr.filter(function (v) { return options.indexOf(v) !== -1; }) : arr;
      renderChips();
      input.value = '';
    },
    clear: function () { selected = []; renderChips(); input.value = ''; closeDropdown(); },
    markInvalid: function () { input.classList.add('is-invalid'); }
  };
}

function createUnitCombo(prefix) { return createChipCombo(prefix, 'unit', UNIT_OPTIONS, { allowAddNew: true }); }
function createNatureCombo(prefix) { return createChipCombo(prefix, 'nature', NATURE_OPTIONS, { restrictToOptions: false }); }

// openAddResponsibleUnitModal()/modalInstanceGlobal()/submitAddResponsibleUnit() (the "+ Add Responsible
// Unit" dropdown row above calls the first of these) and the DOMContentLoaded wiring that used to live here
// now live in assets/js/shared/responsible-units.js, reused by Reports & Analytics too — see that file.

document.addEventListener('click', function (e) {
  ['f', 'e'].forEach(function (prefix) {
    ['unit', 'nature', 'country'].forEach(function (field) {
      var dropdown = document.getElementById(prefix + '-' + field + '-dropdown');
      var input = document.getElementById(prefix + '-' + field + '-input');
      if (dropdown && input && e.target !== input && !dropdown.contains(e.target)) {
        dropdown.style.display = 'none';
        dropdown.innerHTML = '';
      }
    });
  });
});

function instIds(prefix) {
  return {
    dropdown: prefix === 'e' ? 'e-ac-dropdown' : 'ac-dropdown',
    spinner: prefix === 'e' ? 'e-ac-spinner' : 'ac-spinner',
    inst: prefix === 'e' ? 'e-inst' : 'f-inst',
    country: prefix === 'e' ? 'e-country' : 'f-country',
    region: prefix === 'e' ? 'e-region' : 'f-region'
  };
}

function instSearch(value, prefix) {
  prefix = prefix || 'f';
  instPrefix = prefix;
  var ids = instIds(prefix);
  clearTimeout(instSearchTimer);
  var dropdown = document.getElementById(ids.dropdown);
  var spinner = document.getElementById(ids.spinner);
  var q = (value || '').trim();
  if (q.length < 2) {
    instResults = [];
    if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
    if (spinner) spinner.style.display = 'none';
    return;
  }
  if (spinner) spinner.style.display = 'inline-block';
  instSearchTimer = setTimeout(function () {
    fetch('/api/institutions?name=' + encodeURIComponent(q))
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (spinner) spinner.style.display = 'none';
        instResults = Array.isArray(data) ? data : [];
        instActiveIndex = -1;
        renderInstDropdown();
      })
      .catch(function () {
        if (spinner) spinner.style.display = 'none';
        instResults = [];
        renderInstDropdown();
      });
  }, 300); // debounce so we don't hammer the external API on every keystroke
}

function renderInstDropdown() {
  var ids = instIds(instPrefix);
  var dropdown = document.getElementById(ids.dropdown);
  if (!dropdown) return;
  if (!instResults.length) {
    // Institution Name has always been free text — no worldwide match is never a dead end, just confirmation
    // that whatever is already typed will be kept as a manual entry once the field is left/the form is saved.
    dropdown.innerHTML = '<div class="list-group-item text-muted fs-13">No matching institutions found — you can keep typing to use this name manually.</div>';
    dropdown.style.display = 'block';
    return;
  }
  dropdown.innerHTML = instResults.map(function (u, i) {
    return '<button type="button" class="list-group-item list-group-item-action' + (i === instActiveIndex ? ' active' : '') + '" '
      + 'onmousedown="event.preventDefault(); selectInstitution(' + i + ')">'
      + '<div class="fw-semibold fs-13">' + escapeHtml(u.name) + '</div>'
      + '<div class="text-muted fs-12">' + escapeHtml(u.country || '') + '</div>'
      + '</button>';
  }).join('');
  dropdown.style.display = 'block';
}

function selectInstitution(i) {
  var u = instResults[i];
  if (!u) return;
  var ids = instIds(instPrefix);
  var instEl = document.getElementById(ids.inst);
  var regionEl = document.getElementById(ids.region);
  if (instEl) instEl.value = u.name;
  var resolvedCountry = u.country ? setCountryField(instPrefix, u.country) : false;
  var region = COUNTRY_REGION[resolvedCountry || u.country];
  if (regionEl && region) regionEl.value = region;

  var dropdown = document.getElementById(ids.dropdown);
  if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
  instResults = [];
  instActiveIndex = -1;
  scheduleLocationPreview(instPrefix);
}

// ── Automatic map location (preview) ─────────────────────────────────────────
// Shows what location a save would produce — exact / approximate / unresolved —
// via POST /api/geocode/preview (the same resolver the save itself uses). It is
// only ever triggered on COMMIT (an institution picked from the list, or the
// institution/country field left with a changed value), never per keystroke:
// the geocoding provider's usage policy forbids autocomplete-style querying.
// A slow or failed preview never blocks anything — saving always works, and the
// server works out the location again at save time.
var locPreviewSeq = { f: 0, e: 0 };      // discards out-of-order responses
var locPreviewTimer = { f: null, e: null };
var LOCATION_KEYS = ['lat', 'lng', 'locationSource', 'locationPrecision', 'locationStatus', 'countryCode', 'locationResolvedName', 'locationResolvedAt'];
// Same pattern as OUR_INSTITUTION_RE in services/extractionService.js (CSPC's own names).
var OUR_INSTITUTION_RE_CLIENT = /camarines sur polytechnic colleges|\bcspc\b|center for international relations|\bcirl\b/i;
var LOC_REASON_TEXT = {
  'own-institution': "CSPC's own name can't be placed as a partner",
  'no-confident-match': 'The institution could not be matched confidently in this country',
  'provider-unavailable': 'The location service is unavailable right now',
  'geocoder-disabled': 'Institution-level lookup is turned off',
  'no-institution': 'No institution name yet',
  'country-unrecognized': 'This country is not recognized for mapping',
  'no-country': 'Enter a country to place this partnership on the map',
  'error': 'The location could not be determined'
};

function locStatusHtml(d, willUpdate) {
  var lead = willUpdate ? 'On save: ' : '';
  var why = LOC_REASON_TEXT[d.reason] ? escapeHtml(LOC_REASON_TEXT[d.reason]) : '';
  if (d.status === 'resolved') {
    return lead + '<span class="badge bg-success-subtle text-success"><i class="ri-map-pin-2-fill me-1"></i>Exact location</span> '
      + '<span>' + escapeHtml(d.resolvedName || '') + '</span>';
  }
  if (d.status === 'approximate') {
    return lead + '<span class="badge bg-warning-subtle text-warning"><i class="ri-map-pin-line me-1"></i>Approximate &mdash; country level</span> '
      + (why ? '<span>' + why + '. </span>' : '') + '<span>Shown as a dashed marker on the map.</span>';
  }
  var html = lead + '<span class="badge bg-secondary-subtle text-secondary"><i class="ri-map-pin-line me-1"></i>Not on map</span> '
    + (why ? '<span>' + why + '. </span>' : '') + '<span>You can still save this partnership.</span>';
  if (d.suggestion) {
    html += ' <button type="button" class="btn btn-link btn-sm p-0 align-baseline loc-suggest" data-country="'
      + escapeHtml(d.suggestion) + '">Did you mean &ldquo;' + escapeHtml(d.suggestion) + '&rdquo;?</button>';
  }
  return html;
}

function requestLocationPreview(prefix) {
  var el = document.getElementById(prefix + '-location-status');
  var instEl = document.getElementById(prefix + '-inst');
  var countryEl = document.getElementById(prefix + '-country');
  if (!el || !instEl || !countryEl) return;
  var inst = instEl.value.trim(), country = countryEl.value.trim();
  var seq = ++locPreviewSeq[prefix];
  if (!inst && !country) { el.innerHTML = ''; return; }
  if (!country) { el.innerHTML = '<span>' + escapeHtml(LOC_REASON_TEXT['no-country']) + '.</span>'; return; }
  el.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span>Finding map location&hellip;';
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, 9000);
  fetch('/api/geocode/preview', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ institution: inst, country: country }), signal: ctrl.signal
  })
    .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
    .then(function (d) { if (seq === locPreviewSeq[prefix]) el.innerHTML = locStatusHtml(d, prefix === 'e'); })
    .catch(function () {
      if (seq === locPreviewSeq[prefix]) el.innerHTML = 'The map location will be worked out when you save. You can still save.';
    })
    .then(function () { clearTimeout(timer); });
}

function scheduleLocationPreview(prefix) {
  clearTimeout(locPreviewTimer[prefix]);
  // The institution/country just changed, so whatever result is on screen no
  // longer describes it — replace it at once rather than showing a stale
  // outcome for the debounce interval.
  var el = document.getElementById(prefix + '-location-status');
  if (el) el.innerHTML = '<span class="spinner-border spinner-border-sm me-1" role="status"></span>Finding map location&hellip;';
  locPreviewTimer[prefix] = setTimeout(function () { requestLocationPreview(prefix); }, 400);
}

function describeStoredLocation(p) {
  if (p.locationStatus === 'resolved') return 'Map location: exact &mdash; ' + escapeHtml(p.locationResolvedName || '');
  if (p.locationStatus === 'approximate') return 'Map location: approximate (country level).';
  if (p.locationStatus === 'unresolved') return 'No map location yet. It is looked up again if you change the institution or country.';
  if (typeof p.lat === 'number' && typeof p.lng === 'number') return 'Map location on file.';
  return 'No map location on file. It is looked up if you change the institution or country.';
}

function locationNote(p) {
  if (!p || !p.locationStatus) return '';
  if (p.locationStatus === 'resolved') return ' Map location: exact.';
  if (p.locationStatus === 'approximate') return ' Map location: approximate (country level).';
  return ' Not placed on the map (location unresolved).';
}

document.addEventListener('click', function (e) {
  var btn = e.target.closest && e.target.closest('.loc-suggest');
  if (!btn) return;
  var status = btn.closest('[id$="-location-status"]');
  var prefix = status ? status.id.charAt(0) : 'f';
  var countryEl = document.getElementById(prefix + '-country');
  if (countryEl) { countryEl.value = btn.getAttribute('data-country') || ''; syncCountryDisplay(prefix); scheduleLocationPreview(prefix); }
});

function instKeyNav(event, prefix) {
  prefix = prefix || 'f';
  if (!instResults.length) return;
  if (event.key === 'ArrowDown') {
    event.preventDefault();
    instActiveIndex = Math.min(instActiveIndex + 1, instResults.length - 1);
    renderInstDropdown();
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    instActiveIndex = Math.max(instActiveIndex - 1, 0);
    renderInstDropdown();
  } else if (event.key === 'Enter') {
    if (instActiveIndex >= 0) {
      event.preventDefault();
      selectInstitution(instActiveIndex);
    }
  } else if (event.key === 'Escape') {
    var dropdown = document.getElementById(instIds(prefix).dropdown);
    if (dropdown) { dropdown.innerHTML = ''; dropdown.style.display = 'none'; }
  }
}

document.addEventListener('click', function (e) {
  ['f', 'e'].forEach(function (prefix) {
    var ids = instIds(prefix);
    var dropdown = document.getElementById(ids.dropdown);
    var input = document.getElementById(ids.inst);
    if (dropdown && input && e.target !== input && !dropdown.contains(e.target)) {
      dropdown.innerHTML = '';
      dropdown.style.display = 'none';
    }
  });
});

// Days remaining until `end` — negative once expired. Used by the table's
// "Days Left" column, the Urgent list, and DSS Smart Alerts (all merged in
// from the former separate Monitoring/Lifecycle page, 2026-09-05).
function computeDays(endStr) {
  var d = new Date(endStr);
  return isNaN(d) ? 0 : Math.ceil((d - new Date()) / 86400000);
}

// Load partnerships from MongoDB API. live=true is a background refresh after a live update: the active filters are
// kept, and a failed read leaves what is on screen alone. Every KPI card, overview bar and list is recomputed from the
// server's data by buildGrid() - nothing is calculated from the update itself.
function loadPartnerships(live) {
  return CIPRMS.api('/api/partnerships', { quiet: true }).then(function(res) {
    if (!res.ok || !Array.isArray(res.data)) {
      if (!live) { console.error('Failed to load partnerships:', res.error); buildGrid(); }
      return live ? false : undefined;   // false = a background refresh failed; CIPRMS.live will try again
    }
    // Normalize: map MongoDB docs to the shape this JS expects
    partnerships = res.data.map(function(p) {
      return {
        id:           p.id || 0,
        inst:         p.inst || p.institution || p.name || '',
        country:      p.country || '',
        region:       p.region || '',
        type:         p.type || '',
        nature:       p.nature || '',
        cat:          p.cat || p.category || 'International',
        unit:         p.unit || '',
        coordinator:  p.coordinator || '',
        partnerEmail: p.partnerEmail || '',
        docLink:      p.docLink || '',
        startYear:    p.startYear || (p.start ? new Date(p.start).getFullYear() : ''),
        endYear:      p.endYear   || (p.end   ? new Date(p.end).getFullYear()   : ''),
        start:        p.start || '',
        end:          p.end   || '',
        status:       p.status || '',
        remarks:      p.remarks || '',
        days:         computeDays(p.end),
        // Server-controlled map-location fields (never sent back by the forms).
        lat: p.lat, lng: p.lng, locationSource: p.locationSource, locationPrecision: p.locationPrecision,
        locationStatus: p.locationStatus, countryCode: p.countryCode,
        locationResolvedName: p.locationResolvedName, locationResolvedAt: p.locationResolvedAt
      };
    });
    if (live) { applyFilter(); } else { filtered = partnerships.slice(); if (!applyStatusFromQuery()) buildGrid(); }
  });
}

// Status pre-filter from the URL, e.g. the dashboard's Resource Optimization card
// links to /lifecycle?status=Expired. Only a status the Status dropdown offers is
// applied. Returns true when it filtered (applyFilter() has already rebuilt the grid).
function applyStatusFromQuery() {
  var st = new URLSearchParams(window.location.search).get('status');
  var sel = document.getElementById('reg-status');
  if (!st || !sel) return false;
  var known = Array.prototype.some.call(sel.options, function(o) { return o.value === st; });
  if (!known) return false;
  sel.value = st;
  applyFilter();
  return true;
}

// Deep link from the global header search (a Partnerships result links here as `?q=<institution name>`) — reuses the
// page's own existing search box/filter rather than trying to scroll to and highlight a row inside the Grid.js table
// (which repaginates client-side, so a stable "row N" DOM handle doesn't exist across renders). This runs once the
// initial load has populated `partnerships`, so the filter has real data to narrow down immediately.
function applyQueryPrefill() {
  var q = new URLSearchParams(window.location.search).get('q');
  var box = document.getElementById('reg-search');
  if (!q || !box) return;
  box.value = q;
  applyFilter();
}
loadPartnerships(false).then(applyQueryPrefill);
if (window.CIPRMS && CIPRMS.live) {
  CIPRMS.live(['partnership.updated', 'partnership.statusChanged'], function() { return loadPartnerships(true); }, { debounce: 250 });
}

// One save at a time: the trigger button is disabled (with progress text) until the server has answered, so a double
// click cannot submit twice.
function runOnce(btnSelector, label, fn) {
  return CIPRMS.busy(document.querySelector(btnSelector), fn, label);
}


function sbadge(s) {
  var m = { 'Active':'bg-success-subtle text-success', 'Expiring Soon':'bg-warning-subtle text-warning', 'Expired':'bg-danger-subtle text-danger', 'Pending Approval':'bg-info-subtle text-info' };
  return '<span class="badge ' + (m[s]||'bg-secondary-subtle text-secondary') + '">' + s + '</span>';
}

// Days-remaining badge for the table's "Days Left" column — ported from the
// former separate Monitoring/Lifecycle page's own table (2026-09-05 page
// consolidation), so that validity information isn't lost when the two
// tables were merged into one.
function daysBadgeHtml(d, s) {
  if (s === 'Expired') return '<span class="badge bg-danger-subtle text-danger">Expired</span>';
  if (d <= 14)         return '<span class="badge bg-danger">Critical (' + d + 'd)</span>';
  if (d <= 90)         return '<span class="badge bg-warning-subtle text-warning">' + d + ' days</span>';
  return '<span class="badge bg-success-subtle text-success">' + d + ' days</span>';
}

// DSS Smart Alerts — ported from the former separate Monitoring/Lifecycle
// page (2026-09-05 consolidation); same data source (`partnerships`), so the
// advice always matches what the Partnership Registry table below shows.
function renderDssAlerts() {
  var expiringSoon = partnerships.filter(function(p){ return p.status==='Expiring Soon'; }).sort(function(a,b){ return a.days-b.days; });
  var expired = partnerships.filter(function(p){ return p.status==='Expired'; });

  var actionEl = document.getElementById('dss-action-text');
  if (actionEl) {
    if (expiringSoon.length) {
      var soonest = expiringSoon[0];
      actionEl.innerHTML = '<span class="fw-semibold">Action Required:</span> '
        + escapeHtml(soonest.inst) + ' ' + escapeHtml(soonest.type) + ' expires in <strong>' + soonest.days + ' day' + (soonest.days===1?'':'s') + '</strong>. '
        + (expiringSoon.length > 1 ? (expiringSoon.length-1) + ' other partnership' + (expiringSoon.length>2?'s are':' is') + ' also expiring within 90 days.' : 'Consider initiating renewal.');
    } else {
      actionEl.textContent = 'No partnerships are currently expiring within the next 90 days.';
    }
  }

  var reviewEl = document.getElementById('dss-review-text');
  if (reviewEl) {
    if (expired.length) {
      var mostOverdue = expired.slice().sort(function(a,b){ return a.days-b.days; })[0];
      var overdueDays = Math.abs(mostOverdue.days);
      reviewEl.innerHTML = '<span class="fw-semibold">Review Suggested:</span> '
        + escapeHtml(mostOverdue.inst) + ' ' + escapeHtml(mostOverdue.type) + ' expired ' + overdueDays + ' day' + (overdueDays===1?'':'s') + ' ago. '
        + (expired.length > 1 ? (expired.length-1) + ' other expired partnership' + (expired.length>2?'s remain':' remains') + ' unrenewed.' : 'Renew or archive this record.');
    } else {
      reviewEl.textContent = 'No expired partnerships currently require review.';
    }
  }
}

function applyFilter() {
  var q   = (document.getElementById('reg-search')||{value:''}).value.toLowerCase();
  var typ = document.getElementById('reg-type').value;
  var cat = document.getElementById('reg-cat').value;
  var st  = document.getElementById('reg-status').value;
  var reg = document.getElementById('reg-region').value;
  var unt = document.getElementById('reg-unit').value;
  var yrs = document.getElementById('reg-yr-signed').value;
  var yre = document.getElementById('reg-yr-exp').value;
  filtered = partnerships.filter(function(p) {
    return (!q   || p.inst.toLowerCase().includes(q) || p.country.toLowerCase().includes(q))
        && (!typ || p.type === typ)
        && (!cat || p.cat === cat)
        && (!st  || p.status === st)
        && (!reg || p.region === reg)
        // unit is an array on records created via the multi-unit combobox
        // (legacy records still hold a single string) — the filter matches
        // if the chosen unit is any one of the partnership's units.
        && (!unt || (Array.isArray(p.unit) ? p.unit.indexOf(unt) !== -1 : p.unit === unt))
        && (!yrs || p.startYear == yrs)
        && (!yre || p.endYear == yre);
  });
  regCurrentPage = 1;
  buildGrid();
}

function clearFilters() {
  ['reg-search','reg-type','reg-cat','reg-status','reg-region','reg-unit','reg-yr-signed','reg-yr-exp'].forEach(function(id) {
    var el = document.getElementById(id); if (el) el.value = '';
  });
  applyFilter();
}

// Contextual report generation (2026-11 panel recommendation) — fetches the Custom Report Builder's own
// preview backend (/api/reports/custom/preview, views/administrator/reports.ejs's previewCustomReport()
// calls the exact same endpoint) with Monitoring's current Type/Category/Status/Unit filters, and renders
// the result into a modal on THIS page. No redirect, no new tab, no separate reporting engine — only the
// rendering is duplicated (trimmed down: no Group By controls, no Compare view), the data and backend are
// the same one Reports & Analytics itself uses. region/year/search filters have no equivalent field in the
// builder today, so they are not carried over (the four that do match are).
function monitoringGenerateReport() {
  var params = new URLSearchParams({ reportType: 'Detailed' });
  var agtype = (document.getElementById('reg-type') || {}).value;
  var cat = (document.getElementById('reg-cat') || {}).value;
  var status = (document.getElementById('reg-status') || {}).value;
  var unit = (document.getElementById('reg-unit') || {}).value;
  if (agtype) params.set('agtype', agtype);
  if (cat) params.set('cat', cat);
  if (status) params.set('status', status);
  if (unit) params.set('unit', unit);

  var modalEl = document.getElementById('monReportPreviewModal');
  var modal = bootstrap.Modal.getOrCreateInstance(modalEl);
  monShowRpmLoading();
  modal.show();

  var mySeq = ++_monPreviewRequestSeq;
  fetch('/api/reports/custom/preview?' + params.toString())
    .then(function (r) {
      if (!r.ok) return r.json().then(function (e) { throw new Error(e.error || 'Server error while generating the preview.'); });
      return r.json();
    })
    .then(function (data) {
      if (mySeq !== _monPreviewRequestSeq) return; // superseded by a newer Generate Report click
      if (data.error) throw new Error(data.error);
      monRenderReportPreview(data);
    })
    .catch(function (err) {
      if (mySeq !== _monPreviewRequestSeq) return;
      console.error('Monitoring report preview error:', err);
      monShowRpmError('Failed to generate report preview: ' + err.message);
    });
}

var _monPreviewRequestSeq = 0; // same stale-response guard as reports.ejs's _previewRequestSeq

function monShowRpmLoading() {
  document.getElementById('mon-rpm-loading').style.display = '';
  document.getElementById('mon-rpm-error').style.display = 'none';
  document.getElementById('mon-rpm-body').style.display = 'none';
}
function monShowRpmError(message) {
  document.getElementById('mon-rpm-loading').style.display = 'none';
  document.getElementById('mon-rpm-body').style.display = 'none';
  document.getElementById('mon-rpm-error-text').textContent = message;
  document.getElementById('mon-rpm-error').style.display = '';
}

// Trimmed-down twin of reports.ejs's renderReportPreview()/renderGroupedPreviewTable(): same data shape
// (computeCustomReportData()'s result, via the same endpoint), same filter-badge/summary-card/status-badge
// logic, just targeting this page's mon-prev-* element ids instead of reports.ejs's prev-*. Monitoring's
// own Generate Report never sends a groupBy, but the grouped branch is kept so a result that happens to
// carry one (e.g. a saved/bookmarked filter state) still renders correctly instead of showing nothing.
function monRenderReportPreview(data) {
  document.getElementById('mon-rpm-loading').style.display = 'none';
  document.getElementById('mon-rpm-error').style.display = 'none';
  document.getElementById('mon-rpm-body').style.display = '';

  document.getElementById('mon-prev-title').textContent = data.title;
  document.getElementById('mon-prev-meta').textContent = 'Generated ' + data.generatedDate + ' by ' + data.generatedBy + ' • Total Records: ' + data.totalRecords;

  var filtersEl = document.getElementById('mon-prev-filters');
  var badgesHtml = '';
  if (data.filters) {
    var LABELS = { reportType: 'Report Type', category: 'Category', dateFrom: 'Date From', dateTo: 'Date To', unit: 'College / Unit', agreementType: 'Agreement Type', country: 'Country', status: 'Status', compareBy: 'Compare By', groupBy: 'Group By' };
    Object.entries(data.filters).forEach(function (pair) {
      var label = LABELS[pair[0]] || pair[0];
      badgesHtml += '<span class="badge bg-secondary-subtle text-secondary me-1 mb-1"><strong class="text-secondary-emphasis">' + escapeHtml(label) + ':</strong> ' + escapeHtml(pair[1]) + '</span>';
    });
  }
  filtersEl.innerHTML = badgesHtml;

  var cardsEl = document.getElementById('mon-prev-summary-cards');
  var sum = data.summary || {};
  cardsEl.innerHTML =
    '<div class="col-md-3"><div class="card card-animate mb-0 bg-primary-subtle border-0"><div class="card-body p-3">' +
      '<h6 class="fs-12 text-uppercase text-primary fw-semibold mb-1">Total Partnerships</h6><h3 class="mb-0 text-primary fw-bold">' + (sum.totalCount || 0) + '</h3></div></div></div>' +
    '<div class="col-md-3"><div class="card card-animate mb-0 bg-success-subtle border-0"><div class="card-body p-3">' +
      '<h6 class="fs-12 text-uppercase text-success fw-semibold mb-1">Active Agreements</h6><h3 class="mb-0 text-success fw-bold">' + (sum.activeCount || 0) + '</h3></div></div></div>' +
    '<div class="col-md-3"><div class="card card-animate mb-0 bg-warning-subtle border-0"><div class="card-body p-3">' +
      '<h6 class="fs-12 text-uppercase text-warning fw-semibold mb-1">Expiring Soon</h6><h3 class="mb-0 text-warning fw-bold">' + (sum.expiringSoonCount || 0) + '</h3></div></div></div>' +
    '<div class="col-md-3"><div class="card card-animate mb-0 bg-danger-subtle border-0"><div class="card-body p-3">' +
      '<h6 class="fs-12 text-uppercase text-danger fw-semibold mb-1">Expired / Inactive</h6><h3 class="mb-0 text-danger fw-bold">' + (sum.inactiveCount || 0) + '</h3></div></div></div>';

  var groupedWrap = document.getElementById('mon-prev-grouped-wrap');
  var flatWrap = document.getElementById('mon-prev-flat-wrap');
  if (data.isComparison && Array.isArray(data.comparisonData)) {
    flatWrap.style.display = 'none';
    groupedWrap.style.display = '';
    monRenderGroupedPreviewTable(data);
    return;
  }
  groupedWrap.style.display = 'none';
  flatWrap.style.display = '';

  var recCountEl = document.getElementById('mon-prev-records-count');
  var recTbody = document.getElementById('mon-prev-records-tbody');
  var records = data.records || [];
  recCountEl.textContent = records.length;

  var recHtml = '';
  if (records.length === 0) {
    recHtml = '<tr><td colspan="10" class="text-center text-muted py-3">No partnerships found matching the selected filters.</td></tr>';
  } else {
    records.forEach(function (p, i) {
      var stBadge = CIPRMS_STATUS_COLORS.badgeClass(p.status);
      recHtml += '<tr>'
        + '<td>' + (i + 1) + '</td>'
        + '<td class="fw-semibold">' + escapeHtml(p.inst) + '</td>'
        + '<td>' + escapeHtml(p.country || '—') + '</td>'
        + '<td>' + escapeHtml(p.region || '—') + '</td>'
        + '<td><span class="badge bg-primary-subtle text-primary">' + escapeHtml(p.type || '—') + '</span></td>'
        + '<td>' + escapeHtml((Array.isArray(p.nature) ? p.nature.join(', ') : p.nature) || '—') + '</td>'
        + '<td><span class="badge bg-secondary-subtle text-secondary">' + escapeHtml((Array.isArray(p.unit) ? p.unit.join(', ') : p.unit) || '—') + '</span></td>'
        + '<td>' + escapeHtml(p.start || '—') + '</td>'
        + '<td>' + escapeHtml(p.end || '—') + '</td>'
        + '<td><span class="badge ' + stBadge + '">' + escapeHtml(p.status || '—') + '</span></td>'
        + '</tr>';
    });
  }
  recTbody.innerHTML = recHtml;
}

function monRenderGroupedPreviewTable(data) {
  var theadRow = document.getElementById('mon-prev-grouped-thead-row');
  var tbody = document.getElementById('mon-prev-grouped-tbody');
  var metrics = data.metrics || [];
  theadRow.innerHTML = metrics.map(function (m) {
    var swatch = CIPRMS_STATUS_COLORS.isKnownStatus(m)
      ? '<span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:' + CIPRMS_STATUS_COLORS.hex(m) + ';margin-right:5px;"></span>'
      : '';
    return '<th>' + swatch + escapeHtml(m) + '</th>';
  }).join('');

  var rows = data.comparisonData || [];
  if (!rows.length) {
    tbody.innerHTML = '<tr><td colspan="' + Math.max(metrics.length, 1) + '" class="text-center text-muted py-3">No partnerships found matching the selected filters.</td></tr>';
    return;
  }
  tbody.innerHTML = rows.map(function (row) {
    return '<tr>' + metrics.map(function (m) {
      var v = row[m];
      if (Array.isArray(v)) v = v.join(', ');
      return '<td>' + escapeHtml(v === undefined || v === null || v === '' ? '—' : v) + '</td>';
    }).join('') + '</tr>';
  }).join('');
}

function buildGrid() {
  var total    = partnerships.length;
  var nActive  = partnerships.filter(function(p){return p.status==='Active';}).length;
  var nExpiring= partnerships.filter(function(p){return p.status==='Expiring Soon';}).length;
  var nExpiring30 = partnerships.filter(function(p){return p.status==='Expiring Soon' && p.days<=30;}).length;
  var nExpired = partnerships.filter(function(p){return p.status==='Expired';}).length;
  var nMOA     = partnerships.filter(function(p){return p.type==='MOA';}).length;
  var nMOU     = partnerships.filter(function(p){return p.type==='MOU';}).length;
  var nIntl    = partnerships.filter(function(p){return p.cat==='International';}).length;
  var nLocal   = partnerships.filter(function(p){return p.cat==='Local';}).length;
  var activeRate = total ? Math.round(nActive/total*100) : 0;
  function setText(id,v){ var el=document.getElementById(id); if(el) el.textContent=v; }
  setText('cnt-total',total); setText('cnt-active',nActive); setText('cnt-expiring',nExpiring); setText('cnt-expired',nExpired);
  setText('reg-count', filtered.length+' of '+total+' records');
  // Overview (Section 2) — Total/Active/Expiring(30d & 90d split)/Expired/Active
  // Rate/MOA/MOU/International/Local, all from this same `partnerships` array —
  // the one source of truth also driving the KPI cards and the table below.
  setText('ov-total',total); setText('ov-active',nActive);
  setText('ov-expiring30',nExpiring30); setText('ov-expiring90',nExpiring);
  setText('ov-expired',nExpired); setText('ov-active-rate',activeRate+'%');
  setText('ov-moa',nMOA); setText('ov-mou',nMOU); setText('ov-intl',nIntl); setText('ov-local',nLocal);
  var activeBar=document.getElementById('ov-active-bar'), moaBar=document.getElementById('ov-moa-bar'), mouBar=document.getElementById('ov-mou-bar');
  if(activeBar) activeBar.style.width = activeRate+'%';
  if(moaBar) moaBar.style.width = total ? Math.round(nMOA/total*100)+'%' : '0%';
  if(mouBar) mouBar.style.width = total ? Math.round(nMOU/total*100)+'%' : '0%';

  // Urgent (Section 4) — one list, days-based (soonest/most-overdue first),
  // sourced from the same `partnerships` array as everything else on this page.
  var urgent = partnerships.filter(function(p){ return p.status==='Expiring Soon'||p.status==='Expired'; })
    .sort(function(a,b){ return a.days-b.days; })
    .slice(0,7);
  var ul = document.getElementById('urgent-list');
  if (ul) ul.innerHTML = urgent.length===0
    ? '<li class="list-group-item px-3 py-2 text-muted fs-12">No urgent partnerships.</li>'
    : urgent.map(function(p){
        var critical = p.status==='Expired' || p.days<=14;
        var dot = critical ? 'bg-danger' : 'bg-warning';
        var sub = critical ? 'text-danger' : 'text-warning';
        var label = p.status==='Expired' ? 'Expired' : (p.days+' days');
        return '<li class="list-group-item px-3 py-2"><div class="d-flex align-items-center gap-2"><span class="badge '+dot+' rounded-circle p-1">&nbsp;</span><div><div class="fw-semibold fs-13">'+escapeHtml(p.inst)+'</div><div class="text-muted fs-12">'+escapeHtml(p.type)+' &middot; <strong class="'+sub+'">'+label+'</strong></div></div></div></li>';
      }).join('');

  renderDssAlerts();

  var data = filtered.map(function(p) {
    // Type/Unit are intentionally NOT rendered as table columns (2026-09-08
    // UI change) — they still live on `p` and are shown in full in the
    // View/Preview modal (openViewModal below) and everywhere else (Edit
    // form, Reports, filters); this table just no longer duplicates them.
    var statusBadge = sbadge(p.status);
    var endColor    = p.status==='Expired'?'#dc2626':p.status==='Expiring Soon'?'#d97706':'#15803d';
    var instHtml    = escapeHtml(p.inst)+(p.coordinator?'<div class="text-muted fs-11"><i class="ri-user-line me-1"></i>'+escapeHtml(p.coordinator)+'</div>':'');
    var countryHtml = escapeHtml(p.country)+'<div class="text-muted fs-11"><i class="ri-map-pin-line me-1"></i>'+escapeHtml(p.region)+'</div>';
    var endHtml     = '<span style="color:'+endColor+';font-weight:600">'+p.end+'</span>';
    // Mutation controls (Edit/Approve/Renew/Delete) are Administrator- and
    // Staff-only — the View button always shows for every other role.
    // POST/PATCH/DELETE /api/partnerships enforce this server-side regardless.
    var canManage = typeof CAN_MANAGE_REGISTRY !== 'undefined' && CAN_MANAGE_REGISTRY;
    var actions = '<div class="d-flex gap-1 flex-wrap">'
      +'<button class="btn btn-sm btn-soft-info" title="View details" aria-label="View details" onclick="openViewModal('+p.id+')"><i class="ri-eye-line"></i></button>'
      +(!canManage ? '' : (p.status==='Pending Approval'
        ?'<button class="btn btn-sm btn-soft-success" title="Approve" aria-label="Approve" onclick="approveRecord('+p.id+')"><i class="ri-checkbox-circle-line"></i></button>'
        :'<button class="btn btn-sm btn-soft-success" title="Edit" aria-label="Edit" onclick="openEditModal('+p.id+')"><i class="ri-pencil-line"></i></button>'))
      +(!canManage ? '' : (p.status==='Expired'||p.status==='Expiring Soon'
        ?'<button class="btn btn-sm btn-soft-warning" title="Renew" aria-label="Renew" onclick="openRenewModal('+p.id+')"><i class="ri-refresh-line"></i></button>':''))
      +(canManage ? '<button class="btn btn-sm btn-soft-danger" title="Delete" aria-label="Delete" onclick="openDeleteModal('+p.id+')"><i class="ri-delete-bin-line"></i></button>' : '')
      +'</div>';
    // nature can be an array (multi-select, 2026-09-19) — join for display,
    // same treatment as Unit already gets in the View modal below.
    var natureDisplay = Array.isArray(p.nature) ? p.nature.join(', ') : p.nature;
    return [gridjs.html(instHtml), gridjs.html(countryHtml), natureDisplay, p.start, gridjs.html(endHtml), gridjs.html(daysBadgeHtml(p.days, p.status)), gridjs.html(statusBadge), gridjs.html(actions)];
  });

  var totalPages = Math.ceil(data.length / regPageSize);
  if (regCurrentPage > totalPages) regCurrentPage = Math.max(1, totalPages);
  var startIdx = (regCurrentPage - 1) * regPageSize;
  var pageData = data.slice(startIdx, startIdx + regPageSize);

  var pagEl = document.getElementById('reg-pagination');
  if (pagEl) pagEl.innerHTML = buildPaginationHtml(regCurrentPage, totalPages, 'goToRegPage');
  // Page-size selector (2026-11 panel recommendation) — the shared helper from ciprms-pagination.js;
  // the Previous/Next/numbered renderer above stays this file's own (identical logic either way).
  if (window.CIPRMSPagination) {
    window.CIPRMSPagination.renderPageSizeSelector('reg-page-size', regPageSize, [10, 25, 50], function (newSize) {
      regPageSize = newSize;
      regCurrentPage = 1;
      buildGrid();
    });
  }

  if (window._regGrid) { window._regGrid.updateConfig({data:pageData}).forceRender(); return; }
  var regGridEl = document.getElementById('reg-grid');
  if (regGridEl) regGridEl.innerHTML = ''; // clear the template's loading placeholder — Grid.js requires an empty container on first render
  regGridEl && (window._regGrid = new gridjs.Grid({
    columns:[
      {name:'Institution',width:'23%'},{name:'Country/Region',width:'14%'},
      {name:'Nature',width:'11%'},{name:'Start',width:'10%'},
      {name:'End',width:'11%'},{name:'Days Left',width:'11%',sort:false},
      {name:'Status',width:'10%',sort:false},{name:'Actions',width:'10%',sort:false}
    ],
    data:pageData, search:false, pagination:false, sort:true,
    className:{table:'table table-hover align-middle mb-0',thead:'table-light'}
  }).render(document.getElementById('reg-grid')));
}


// ── Modal helpers ────────────────────────────────────────────────────────────

// Independent modals (no swap/stacking between them) — each drops the breadcrumb back
// to the page base the moment it's closed for good. Registered once, not per open-call.
['viewPartnershipModal', 'editPartnershipModal', 'renewPartnershipModal', 'deleteRecordModal'].forEach(function (id) {
  var el = document.getElementById(id);
  if (el) el.addEventListener('hidden.bs.modal', function () { if (typeof resetBreadcrumb === 'function') resetBreadcrumb(); });
});

function openViewModal(id) {
  var p = partnerships.find(function(x){return x.id===id;}); if(!p) return;
  document.getElementById('view-title').textContent = p.inst;
  var safeDocLink = sanitizeUrl(p.docLink);
  var safePartnerEmail = escapeHtml(p.partnerEmail || '');
  document.getElementById('view-body').innerHTML =
    '<div class="row g-3">'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Institution</div><div class="fw-semibold">'+escapeHtml(p.inst)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Country</div><div class="fw-semibold">'+escapeHtml(p.country)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Region</div><div class="fw-semibold">'+escapeHtml(p.region)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Type</div><div class="fw-semibold">'+escapeHtml(p.type)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Nature</div><div class="fw-semibold">'+escapeHtml(Array.isArray(p.nature)?p.nature.join(', '):p.nature)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Category</div><div class="fw-semibold">'+escapeHtml(p.cat)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Start Date</div><div class="fw-semibold">'+escapeHtml(p.start)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">End Date</div><div class="fw-semibold">'+escapeHtml(p.end)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Status</div><div>'+sbadge(p.status)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Responsible Unit</div><div class="fw-semibold">'+escapeHtml(Array.isArray(p.unit)?p.unit.join(', '):p.unit)+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">CIRL Coordinator</div><div class="fw-semibold">'+(p.coordinator?escapeHtml(p.coordinator):'—')+'</div></div>'
    +'<div class="col-sm-6"><div class="text-muted fs-12">Partner Email</div><div>'+(p.partnerEmail?'<a href="mailto:'+safePartnerEmail+'">'+safePartnerEmail+'</a>':'—')+'</div></div>'
    +'<div class="col-sm-12"><div class="text-muted fs-12">Document Link</div><div>'+(safeDocLink?'<a href="'+safeDocLink+'" target="_blank" rel="noopener noreferrer">'+escapeHtml(p.docLink)+'</a>':(p.docLink?'— Invalid link':'— Not uploaded'))+'</div></div>'
    +'<div class="col-sm-12"><div class="text-muted fs-12">Remarks</div><div>'+(p.remarks?escapeHtml(p.remarks):'—')+'</div></div>'
    +'</div>';
  if (typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst]));
  new bootstrap.Modal(document.getElementById('viewPartnershipModal')).show();
}

function approveRecord(id) {
  var p=partnerships.find(function(x){return x.id===id;}); if(!p) return;
  if(!confirm('Approve and activate the partnership with "'+p.inst+'"?')) return;
  p.status='Active'; filtered=partnerships.slice(); buildGrid();
  showToast('<i class="ri-checkbox-circle-line"></i> Partnership approved and set to Active!');
}

var deletingId=null;
function openDeleteModal(id){
  deletingId=id;
  var p=partnerships.find(function(x){return x.id===id;});
  if (p && typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst, 'Delete']));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('deleteRecordModal')).show();
}
function confirmDelete(){
  if(!deletingId) return;
  var id=deletingId;
  var idx=partnerships.findIndex(function(x){return x.id===id;}); if(idx===-1) return;
  var name=partnerships[idx].inst;
  return runOnce('#delete-record','Deleting...',function(){
    return CIPRMS.api('/api/partnerships/'+id,{method:'DELETE',quiet:true}).then(function(res){
      if(res.ok){
        partnerships=partnerships.filter(function(x){return x.id!==id;}); deletingId=null;
        bootstrap.Modal.getInstance(document.getElementById('deleteRecordModal'))?.hide();
        applyFilter(); showToast('"'+name+'" has been removed from the registry.');
      } else {
        showToast(res.error||'Error deleting partnership.');
        if(res.status===404||res.status===409) loadPartnerships(true);
      }
    });
  });
}

var editingId=null;
var eUnitCombo = createUnitCombo('e');
var eNatureCombo = createNatureCombo('e');
function openEditModal(id){
  var p=partnerships.find(function(x){return x.id===id;}); if(!p) return; editingId=id;
  // ocrIsoDate (defined above) reads local Y/M/D directly instead of going through toISOString(), which
  // would silently shift the shown date back a day in any timezone ahead of UTC (e.g. Asia/Manila) — the
  // same bug this shared helper already fixes for OCR-extracted dates applies equally to pre-filling a
  // stored partnership's Start/End date here.
  document.getElementById('e-inst').value=p.inst; setEditCountryValue(p.country);
  var eCountryHint = document.getElementById('e-country-hint'); if (eCountryHint) { eCountryHint.classList.add('d-none'); eCountryHint.textContent = ''; }
  document.getElementById('e-region').value=p.region; document.getElementById('e-partner-email').value=p.partnerEmail||'';
  document.getElementById('e-type').value=p.type; eNatureCombo.setValues(p.nature);
  document.getElementById('e-cat').value=p.cat; document.getElementById('e-start').value=ocrIsoDate(p.start);
  document.getElementById('e-end').value=ocrIsoDate(p.end); document.getElementById('e-status').value=p.status;
  eUnitCombo.setValues(p.unit); document.getElementById('e-coordinator').value=p.coordinator||'';
  document.getElementById('e-doclink').value=p.docLink||''; document.getElementById('e-remarks').value=p.remarks||'';
  locPreviewSeq.e++; clearTimeout(locPreviewTimer.e);
  document.getElementById('e-location-status').innerHTML=describeStoredLocation(p);
  if (typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst, 'Edit']));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('editPartnershipModal')).show();
}
function computeEditStatus(){var v=document.getElementById('e-end').value;if(!v)return;var d=Math.ceil((new Date(v)-new Date())/86400000);document.getElementById('e-status').value=d<0?'Expired':d<=90?'Expiring Soon':'Active';}
function saveEdit(){
  var inst=document.getElementById('e-inst').value.trim(),end=document.getElementById('e-end').value;
  var units=eUnitCombo.getValues();
  if(!inst||!end||!units.length){
    if(!units.length) eUnitCombo.markInvalid();
    showToast('Institution name, End Date, and at least one Responsible Unit are required.');
    return;
  }
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var p=partnerships.find(function(x){return x.id===editingId;}); if(!p) return;
  var updates={inst:inst,country:document.getElementById('e-country').value.trim(),region:document.getElementById('e-region').value,
    partnerEmail:document.getElementById('e-partner-email').value.trim(),type:document.getElementById('e-type').value,
    nature:eNatureCombo.getValues(),cat:document.getElementById('e-cat').value,
    start:fmt(document.getElementById('e-start').value),end:fmt(end),endYear:new Date(end).getFullYear(),
    status:document.getElementById('e-status').value,unit:units,
    coordinator:document.getElementById('e-coordinator').value.trim(),docLink:document.getElementById('e-doclink').value.trim(),
    remarks:document.getElementById('e-remarks').value.trim()};
  var editId=editingId;
  return runOnce('#edit-btn','Saving...',function(){
    return CIPRMS.api('/api/partnerships/'+editId,{method:'PATCH',json:updates,quiet:true}).then(function(res){
      var data=res.data;
      if(res.ok){
        var locBefore=p.locationResolvedAt;
        Object.assign(p,updates); p.days=computeDays(p.end);
        // The server re-evaluates the map location when the institution or
        // country changed - take its result (unset fields come back absent).
        if(data.partnership) LOCATION_KEYS.forEach(function(k){p[k]=data.partnership[k];});
        var locChanged=data.partnership&&data.partnership.locationResolvedAt!==locBefore;
        bootstrap.Modal.getInstance(document.getElementById('editPartnershipModal'))?.hide();
        applyFilter();showToast('"'+inst+'" updated successfully.'+(locChanged?locationNote(data.partnership):''));
      } else {
        showToast(res.error||'Error updating partnership.');
        if(res.status===404||res.status===409) loadPartnerships(true);
      }
    });
  });
}

var renewingId=null;
function openRenewModal(id){
  var p=partnerships.find(function(x){return x.id===id;}); if(!p) return; renewingId=id;
  document.getElementById('renew-inst-name').textContent=p.inst;
  document.getElementById('renew-inst-sub').textContent=p.type+' \u00b7 '+p.country+' \u00b7 Previously expired: '+p.end;
  document.getElementById('renew-prev-end').value=p.end;
  document.getElementById('renew-new-end').value='';document.getElementById('renew-validity').value='';
  document.getElementById('renew-status').value='';document.getElementById('renew-remarks').value='';
  if (typeof setBreadcrumb === 'function') setBreadcrumb(BREADCRUMB_BASE.concat([p.inst, 'Renew']));
  bootstrap.Modal.getOrCreateInstance(document.getElementById('renewPartnershipModal')).show();
}
function computeRenewStatus(){
  var v=document.getElementById('renew-new-end').value; if(!v) return;
  var ed=new Date(v),d=Math.ceil((ed-new Date())/86400000);
  document.getElementById('renew-status').value=d<0?'Expired':d<=90?'Expiring Soon':'Active';
  var now=new Date(),tot=(ed.getFullYear()-now.getFullYear())*12+(ed.getMonth()-now.getMonth());
  var y=Math.floor(tot/12),m=tot%12;
  document.getElementById('renew-validity').value=(y>0?y+' yr'+(y>1?'s':''):'')+(m>0?(y>0?' ':'')+m+' mo':'')||'< 1 month';
}
function saveRenew(){
  var newEnd=document.getElementById('renew-new-end').value; if(!newEnd){showToast('Please set a new end date.');return;}
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var p=partnerships.find(function(x){return x.id===renewingId;}); if(!p) return;
  var d=Math.ceil((new Date(newEnd)-new Date())/86400000);
  var updates={end:fmt(newEnd),endYear:new Date(newEnd).getFullYear(),status:d<0?'Expired':d<=90?'Expiring Soon':'Active'};
  var rmk=document.getElementById('renew-remarks').value.trim(); if(rmk) updates.remarks=rmk;
  var renewId=renewingId;
  return runOnce('#renewPartnershipModal .btn-success','Renewing...',function(){
    return CIPRMS.api('/api/partnerships/'+renewId,{method:'PATCH',json:updates,quiet:true}).then(function(res){
      if(res.ok){
        Object.assign(p,updates); p.days=computeDays(p.end);
        bootstrap.Modal.getInstance(document.getElementById('renewPartnershipModal'))?.hide();
        applyFilter();showToast('"'+p.inst+'" renewed - new end date: '+p.end+'.');
      } else {
        showToast(res.error||'Error renewing partnership.');
        if(res.status===404||res.status===409) loadPartnerships(true);
      }
    });
  });
}

var toastTimer=null;
function showToast(msg){
  var t=document.getElementById('reg-toast');
  document.getElementById('reg-toast-msg').textContent=msg;
  t.style.display='flex';
  if(toastTimer) clearTimeout(toastTimer);
  toastTimer=setTimeout(function(){t.style.display='none';},3500);
}

function computeStatus(){var v=document.getElementById('f-end').value;if(!v)return;var d=Math.ceil((new Date(v)-new Date())/86400000);document.getElementById('f-status').value=d<0?'Expired':d<=90?'Expiring Soon':'Active';}

// \u2500\u2500 OCR auto-fill (Extract using OCR button in the Add Partnership modal) \u2500\u2500\u2500\u2500
// ocrJobId (2026-11 New Partnership / Document Library investigation): root cause of uploaded documents
// never appearing in the Document Library from this form \u2014 extraction (POST /api/ocr/extract) only ever
// held the file as an unconfirmed job; applyOcrToForm() below copies the EXTRACTED FIELDS into the
// partnership form, but nothing here ever called POST /api/ocr/confirm (the one call that actually
// archives the file \u2014 see controllers/ocrController.js's own comment on /extract for why), so the job
// quietly expired and its temp file leaked. Mirrors documents.ejs's own currentJobId \u2014 confirmed only once
// submitPartnership() below actually succeeds (so a partnership that fails to save never gets an orphaned
// document archived for it either), discarded if the modal is closed/reset without saving.
var ocrJobId = null;
var ocrExtractedResult = null;
var ocrPollTimer = null;
var OCR_MAX_FILE_SIZE = 10 * 1024 * 1024;
var OCR_ALLOWED_EXT = ['.pdf', '.jpg', '.jpeg', '.png'];

function ocrShow(id, on) { var el = document.getElementById(id); if (el) el.style.display = on ? '' : 'none'; }

function startOcrExtraction() {
  var input = document.getElementById('ocr-file-input');
  var file = input.files[0];
  if (!file) { showToast('Choose a file first.'); return; }

  var ext = '.' + file.name.split('.').pop().toLowerCase();
  if (OCR_ALLOWED_EXT.indexOf(ext) === -1) { showToast('Unsupported file type. Use PDF, JPG, JPEG, or PNG.'); return; }
  if (file.size > OCR_MAX_FILE_SIZE) { showToast('File is too large. Maximum size is 10MB.'); return; }

  // Replacing an earlier extraction that was never saved — discard its temp file server-side instead of
  // leaking it (it would otherwise just sit in uploads/tmp until the 10-minute job TTL, unrecoverable
  // either way once ocrJobId below is overwritten).
  discardOcrJob();

  ocrShow('ocr-error-box', false);
  ocrShow('ocr-result-box', false);
  ocrShow('ocr-progress-wrap', true);
  document.getElementById('ocr-stage-text').textContent = 'Uploading\u2026';
  document.getElementById('ocr-percent-text').textContent = '0%';
  document.getElementById('ocr-progress-bar').style.width = '0%';
  document.getElementById('ocr-extract-btn').disabled = true;

  var formData = new FormData();
  formData.append('document', file);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/ocr/extract');
  xhr.upload.addEventListener('progress', function (e) {
    if (!e.lengthComputable) return;
    var pct = Math.round((e.loaded / e.total) * 100);
    document.getElementById('ocr-progress-bar').style.width = pct + '%';
    document.getElementById('ocr-percent-text').textContent = pct + '%';
  });
  xhr.onload = function () {
    var data;
    try { data = JSON.parse(xhr.responseText); } catch (e) { data = null; }
    if (xhr.status !== 202 || !data || !data.success) {
      ocrFail((data && data.error) || 'Failed to start OCR processing.');
      return;
    }
    document.getElementById('ocr-stage-text').textContent = 'OCR Processing\u2026';
    pollOcrStatus(data.jobId);
  };
  xhr.onerror = function () { ocrFail('Network error while uploading the document.'); };
  xhr.send(formData);
}

function pollOcrStatus(jobId) {
  clearTimeout(ocrPollTimer);
  fetch('/api/ocr/status/' + jobId)
    .then(function (r) { return r.json(); })
    .then(function (data) {
      if (!data.success) { ocrFail(data.error || 'Job not found.'); return; }
      var pct = data.progress || 0;
      document.getElementById('ocr-progress-bar').style.width = pct + '%';
      document.getElementById('ocr-percent-text').textContent = pct + '%';
      document.getElementById('ocr-stage-text').textContent = 'OCR Processing\u2026 (' + (data.stage || '') + ')';

      if (data.status === 'error') { ocrFail(data.error || 'OCR processing failed.'); return; }
      if (data.status === 'done') { ocrJobId = jobId; ocrSucceed(data.result); return; }
      ocrPollTimer = setTimeout(function () { pollOcrStatus(jobId); }, 700);
    })
    .catch(function () { ocrFail('Lost connection while checking OCR progress.'); });
}

function ocrFail(message) {
  document.getElementById('ocr-extract-btn').disabled = false;
  ocrShow('ocr-progress-wrap', false);
  var box = document.getElementById('ocr-error-box');
  box.textContent = message;
  ocrShow('ocr-error-box', true);
  showToast('OCR error: ' + message);
}

// Tells the server to delete the temp file for a job that will never be confirmed — replacing it with a
// new upload, or closing the modal without saving. Fire-and-forget (nothing in the UI needs to wait for
// this): the job is already done from this form's point of view either way.
function discardOcrJob() {
  if (!ocrJobId) return;
  var id = ocrJobId;
  ocrJobId = null;
  fetch('/api/ocr/discard', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jobId: id }) }).catch(function () {});
}

// Called by submitPartnership() only after /api/partnerships has actually reported success — permanently
// archives the upload to the Document Library, tagged with the partnership it supports, with the user's
// own saved Institution/Agreement Type values (not whatever OCR merely guessed) — overrides take
// precedence server-side exactly like documents.ejs's saveDocument() already does.
function confirmOcrDocument(jobId, institution, docType, partnershipId) {
  fetch('/api/ocr/confirm', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jobId: jobId, institution: institution, documentType: docType, partnershipId: partnershipId })
  }).then(function (r) { return r.json(); }).then(function (data) {
    if (!data.success) {
      // The partnership itself is already saved — this only ever reports a SEPARATE problem: its
      // supporting document did not make it into the Document Library. Never silently dropped.
      showToast('Partnership saved, but the uploaded document could not be added to the Document Library: ' + (data.error || 'unknown error') + '. You can upload it again from the Document Library page.', '#f06548');
    }
  }).catch(function () {
    showToast('Partnership saved, but the uploaded document could not be added to the Document Library (network error). You can upload it again from the Document Library page.', '#f06548');
  });
}

function ocrSucceed(result) {
  ocrExtractedResult = result;
  document.getElementById('ocr-extract-btn').disabled = false;
  ocrShow('ocr-progress-wrap', false);
  ocrShow('ocr-result-box', true);
  document.getElementById('ocr-confidence-badge').textContent = 'Confidence: ' + Math.round(result.confidence) + '%';
  document.getElementById('ocr-doctype-badge').textContent = 'Document type: ' + (result.documentType || 'Unrecognized');
  document.getElementById('ocr-raw-text').textContent = result.rawText;
  ocrShow('ocr-warning-badge', !!result.warning);
  if (window.IDP) {
    IDP.renderResult('ocr-idp-panel', result, {
      onCancelDuplicate: function (documentId) {
        if (!documentId) return;
        fetch('/api/documents/' + documentId + '/organize', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ archived: true })
        }).then(function () { showToast('Upload archived \u2014 it will no longer appear as an active Document Library entry.'); });
      },
      onViewDuplicate: function (fileLink) { window.open(fileLink, '_blank'); }
    });
  }
  showToast('OCR extraction complete \u2014 review the suggested values, then apply them to the form.');
}

function ocrIsoDate(str) {
  if (!str) return '';
  var d = new Date(str);
  if (isNaN(d.getTime())) return '';
  // toISOString() converts to UTC first, which silently shifts the calendar day backward whenever the
  // browser's local timezone is ahead of UTC (e.g. Asia/Manila, UTC+8) — "February 10, 2026" parsed as
  // local midnight became "2026-02-09" once rendered in UTC. Reading the local Y/M/D components straight
  // off the Date object (same as the <input type="date"> the value feeds) keeps the extracted date intact.
  var y = d.getFullYear(), m = String(d.getMonth() + 1).padStart(2, '0'), day = String(d.getDate()).padStart(2, '0');
  return y + '-' + m + '-' + day;
}

function ocrSetIfPresent(id, value) {
  if (value === null || value === undefined || value === '') return;
  var el = document.getElementById(id);
  if (el) el.value = value;
}

function applyOcrToForm() {
  if (!ocrExtractedResult) return;
  var r = ocrExtractedResult;

  var filled = [];
  function set(id, value) {
    if (value === null || value === undefined || value === '') return;
    var el = document.getElementById(id);
    if (!el) return;
    el.value = value;
    filled.push(id);
  }

  // Partner vs CSPC (2026-09-19, automatic map location): the extractor reports
  // `institution` as CSPC's OWN side of the agreement whenever it can tell
  // (OUR_INSTITUTION_RE in services/extractionService.js) and `partner` as the
  // counterparty. This form's "Institution Name" — and the map location worked
  // out from it — is the PARTNER, so when OCR identified both and `institution`
  // is CSPC, use the counterparty. In every other case behavior is unchanged
  // (and a CSPC-only name is never pinned to CSPC's campus: the server treats
  // it as a country-level location).
  var useCounterparty = !!(r.partner && r.institution && OUR_INSTITUTION_RE_CLIENT.test(r.institution));
  set('f-inst', useCounterparty ? r.partner : r.institution);
  set('f-partner-email', r.email);
  // Country is a closed <select> — only ever auto-select an exact (or known-alias) match; an unrecognized
  // extracted value is left for manual selection instead of guessed at (see setCountryField above).
  if (r.country && setCountryField('f', r.country)) filled.push('f-country');
  set('f-region', r.region);
  set('f-cat', r.category);

  if (r.documentType) {
    if (/agreement/i.test(r.documentType)) set('f-type', 'MOA');
    else if (/understanding/i.test(r.documentType)) set('f-type', 'MOU');
  }
  // NATURE_OPTIONS doesn't cover every value inferNature() can produce (e.g.
  // Technology Transfer, Community Outreach) — only apply an exact,
  // unambiguous match rather than forcing an incorrect one. OCR always
  // proposes a single best-guess value, so this sets it as the combo's only
  // selection rather than adding to whatever (if anything) was already there.
  if (r.nature) {
    var natureOpt = NATURE_OPTIONS.find(function (o) { return o.toLowerCase() === r.nature.toLowerCase(); });
    if (natureOpt) { fNatureCombo.setValues([natureOpt]); filled.push('f-nature-input'); }
  }
  // Responsible CSPC Unit — extracted server-side (inferUnit(), extractionService.js) whenever the document
  // literally names one of the unit acronyms, but this required field was never actually applied to the form
  // (unlike applyRequestToForm()'s equivalent request-conversion path just below, which already does this).
  if (r.unit) {
    var unitOpt = UNIT_OPTIONS.find(function (o) { return o.toLowerCase() === r.unit.toLowerCase(); });
    if (unitOpt) { fUnitCombo.setValues([unitOpt]); filled.push('f-unit-input'); }
  }

  var startIso = ocrIsoDate(r.startDate);
  var endIso = ocrIsoDate(r.endDate);
  if (startIso) set('f-start', startIso);
  if (endIso) set('f-end', endIso);
  if (endIso) computeStatus();

  if (window.IDP) filled.forEach(IDP.markFilled);

  // Fields with no dedicated input on this form are folded into Remarks so
  // nothing extracted gets silently discarded \u2014 the user can trim/edit freely.
  var extras = [];
  if (useCounterparty) extras.push('CSPC party: ' + r.institution);
  else if (r.partner) extras.push('Partner: ' + r.partner);
  if (r.title) extras.push('Title: ' + r.title);
  if (r.duration) extras.push('Duration: ' + r.duration);
  if (r.address) extras.push('Address: ' + r.address);
  if (r.contactNumber) extras.push('Contact: ' + r.contactNumber);
  if (r.signatories && r.signatories.length) extras.push('Signatories: ' + r.signatories.join('; '));
  if (r.purpose) extras.push('Purpose: ' + r.purpose);
  if (r.objectives) extras.push('Objectives: ' + r.objectives);
  if (r.scope) extras.push('Scope: ' + r.scope);
  if (extras.length) {
    var remarksEl = document.getElementById('f-remarks');
    var prefix = remarksEl.value ? remarksEl.value + '\n\n' : '';
    remarksEl.value = prefix + '[From OCR] ' + extras.join(' | ');
  }

  var firstTab = document.getElementById('add-step1-tab');
  if (firstTab) new bootstrap.Tab(firstTab).show();
  scheduleLocationPreview('f');
  showToast('Suggested values applied \u2014 please review every field before saving.');
}

function dismissOcrResult() {
  discardOcrJob();
  ocrExtractedResult = null;
  ocrShow('ocr-result-box', false);
  ocrShow('ocr-error-box', false);
  var input = document.getElementById('ocr-file-input');
  if (input) input.value = '';
  if (window._monitoringOcrDropzone && typeof window._monitoringOcrDropzone.reset === 'function') {
    window._monitoringOcrDropzone.reset();
  }
}

// ── Approved-Request → Registry conversion ──────────────────────────────────
// "Approve" on a pending Partnership Request (partnership_requests.ejs)
// redirects here as /registry?fromRequest=<id> instead of flipping the
// request's status directly — the request is only marked Approved once the
// reviewer actually saves a partnership from this same Add New Partnership
// form (see submitPartnership() below and POST /api/partnerships).
function hideFromRequestBanner() {
  var banner = document.getElementById('from-request-banner');
  // Bootstrap's d-flex utility is !important — toggle it off along with
  // adding d-none rather than setting style.display, or d-flex would win.
  if (banner) { banner.classList.remove('d-flex'); banner.classList.add('d-none'); }
  var instEl = document.getElementById('from-request-inst');
  if (instEl) instEl.textContent = '';
}

function clearFromRequestParam() {
  if (window.location.search.indexOf('fromRequest=') === -1) return;
  var url = new URL(window.location.href);
  url.searchParams.delete('fromRequest');
  window.history.replaceState({}, '', url.pathname + url.search + url.hash);
}

// Mirrors applyOcrToForm()'s field-by-field, only-apply-if-recognized
// approach — request field options don't perfectly overlap the Registry
// form's own option lists (e.g. Nature of Partnership), so anything that
// doesn't match exactly is simply left for the reviewer to pick themselves
// rather than forcing a wrong value in.
function applyRequestToForm(r) {
  function set(id, value) {
    if (!value) return;
    var el = document.getElementById(id);
    if (el) el.value = value;
  }

  set('f-inst', r.institution);
  setCountryField('f', r.country);
  set('f-region', r.region);
  set('f-cat', r.category);

  if (r.type === 'MOA' || r.type === 'MOU') set('f-type', r.type);

  if (r.nature) {
    var natureOpt = NATURE_OPTIONS.find(function (o) { return o.toLowerCase() === r.nature.toLowerCase(); });
    if (natureOpt) fNatureCombo.setValues([natureOpt]);
  }

  var startIso = ocrIsoDate(r.startDate);
  var endIso = ocrIsoDate(r.endDate);
  if (startIso) set('f-start', startIso);
  if (endIso) { set('f-end', endIso); computeStatus(); }

  if (r.unit) fUnitCombo.setValues(r.unit);

  var remarksParts = [r.isCollegeReport
    ? '[Reported by ' + (r.requestedBy || 'the College Dean') + (r.unit ? ' (' + r.unit + ')' : '') + ' — College Partnership Report #REQ-' + String(r.id).padStart(3, '0') + ']'
    : '[From Partnership Request #REQ-' + String(r.id).padStart(3, '0') + ']'];
  if (r.notes) remarksParts.push(r.notes);
  document.getElementById('f-remarks').value = remarksParts.join(' ');

  var banner = document.getElementById('from-request-banner');
  if (banner) { banner.classList.remove('d-none'); banner.classList.add('d-flex'); }
  var instEl = document.getElementById('from-request-inst');
  if (instEl) instEl.textContent = r.institution ? (' — ' + r.institution) : '';

  var firstTab = document.getElementById('add-step1-tab');
  if (firstTab) new bootstrap.Tab(firstTab).show();
  scheduleLocationPreview('f');
}

// Runs once on page load. Reuses the existing /api/requests endpoint (already
// returns every request to Administrator/Staff — see REQUEST_REVIEWER_ROLES
// in cirl.js) rather than adding a new single-request route.
function checkFromRequestParam() {
  var params = new URLSearchParams(window.location.search);
  var raw = params.get('fromRequest');
  if (!raw) return;
  var reqId = parseInt(raw, 10);
  if (!reqId) return;

  fetch('/api/requests')
    .then(function (r) { return r.json(); })
    .then(function (list) {
      var match = Array.isArray(list) ? list.find(function (x) { return x.id === reqId; }) : null;
      if (!match) {
        showToast('Could not open the source partnership request — it may have been removed.');
        clearFromRequestParam();
        return;
      }
      if (match.linkedPartnershipId) {
        showToast('This request has already been converted to a Registry partnership.');
        clearFromRequestParam();
        return;
      }
      if (match.status !== 'Pending' && match.status !== 'Under Review') {
        showToast('This request is no longer available for conversion (status: ' + match.status + ').');
        clearFromRequestParam();
        return;
      }

      pendingRequestConversion = reqId;
      var modalEl = document.getElementById('addPartnershipModal');
      if (!modalEl) return;
      var modal = new bootstrap.Modal(modalEl);
      modalEl.addEventListener('shown.bs.modal', function onShown() {
        modalEl.removeEventListener('shown.bs.modal', onShown);
        applyRequestToForm(match);
      });
      modal.show();
    })
    .catch(function () {
      showToast('Could not load the source partnership request. Please try Approve again.');
      clearFromRequestParam();
    });
}

function highlight(id,on){var el=document.getElementById(id);if(!el)return;el.style.borderColor=on?'#dc2626':'';el.addEventListener('input',function(){el.style.borderColor='';},{once:true});}

var fUnitCombo = createUnitCombo('f');
var fNatureCombo = createNatureCombo('f');

function submitPartnership(){
  var inst=document.getElementById('f-inst').value.trim(),type=document.getElementById('f-type').value,
      start=document.getElementById('f-start').value,end=document.getElementById('f-end').value,
      units=fUnitCombo.getValues(),region=document.getElementById('f-region').value;
  if(!inst)highlight('f-inst',true);if(!type)highlight('f-type',true);
  if(!start)highlight('f-start',true);if(!end)highlight('f-end',true);if(!units.length)fUnitCombo.markInvalid();
  if(!inst||!type||!start||!end||!units.length)return;
  var fmt=function(v){return new Date(v).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'});};
  var d=Math.ceil((new Date(end)-new Date())/86400000);
  var status=document.getElementById('f-status').value||(d<0?'Expired':d<=90?'Expiring Soon':'Active');
  var payload={inst:inst,country:document.getElementById('f-country').value.trim()||'—',
    region:region||'—',type:type,nature:fNatureCombo.getValues(),
    cat:document.getElementById('f-cat').value||'International',unit:units,
    coordinator:document.getElementById('f-coordinator').value.trim(),
    partnerEmail:document.getElementById('f-partner-email').value.trim(),
    docLink:document.getElementById('f-doc-link').value.trim(),
    startYear:new Date(start).getFullYear(),endYear:new Date(end).getFullYear(),
    start:fmt(start),end:fmt(end),status:status,remarks:document.getElementById('f-remarks').value.trim()};
  if(pendingRequestConversion) payload.sourceRequestId=pendingRequestConversion;
  // Captured now, before the partnership save — see submitPartnership()'s own doc comment above
  // ocrExtractedResult/ocrJobId for the root cause this closes (confirm only on an actual save).
  var jobIdToConfirm = ocrJobId;
  return runOnce('#addPartnershipModal .btn-primary.ms-auto','Saving...',function(){
    return CIPRMS.api('/api/partnerships',{method:'POST',json:payload,quiet:true}).then(function(res){
      var data=res.data;
      if(res.ok&&data&&data.success){
        // If this was already converted by an earlier attempt, the returned
        // partnership may already be in the list - avoid a visible duplicate row.
        if(!partnerships.some(function(p){return p.id===data.partnership.id;})){
          data.partnership.days = computeDays(data.partnership.end);
          partnerships.push(data.partnership);
        }
        filtered=partnerships.slice();applyFilter();
        pendingRequestConversion=null;
        bootstrap.Modal.getInstance(document.getElementById('addPartnershipModal'))?.hide();
        showToast(data.alreadyConverted
          ? '"'+inst+'" was already converted to a Registry partnership.'
          : '"'+inst+'" added to the registry.'+locationNote(data.partnership));
        // The partnership itself is already saved and shown to the user at this point regardless of what
        // happens below — archiving its supporting document is a trailing step, never something that can
        // make a successful partnership save look like it failed.
        if (jobIdToConfirm) {
          ocrJobId = null; // claimed — hidden.bs.modal's own discardOcrJob() must not also touch this job
          confirmOcrDocument(jobIdToConfirm, inst, type, data.partnership.id);
        }
      } else {
        showToast(res.error||'Error saving partnership. Please try again.');
      }
    });
  });
}

// ── DOMContentLoaded ─────────────────────────────────────────────────────────
// Note: buildGrid() is called by the fetch().then() above
document.addEventListener('DOMContentLoaded', function() {
  document.querySelectorAll('.nexttab').forEach(function(btn){
    btn.addEventListener('click',function(){var t=document.getElementById(this.getAttribute('data-nexttab'));if(t)new bootstrap.Tab(t).show();});
  });
  document.querySelectorAll('.previestab').forEach(function(btn){
    btn.addEventListener('click',function(){var t=document.getElementById(this.getAttribute('data-previous'));if(t)new bootstrap.Tab(t).show();});
  });
  // Map-location preview fires when the institution/country field is LEFT with
  // a changed value (`change`), never on each keystroke — see the block above.
  ['f','e'].forEach(function(prefix){
    ['inst','country'].forEach(function(k){
      var el=document.getElementById(prefix+'-'+k);
      if(el) el.addEventListener('change',function(){scheduleLocationPreview(prefix);});
    });
  });
  var addModal=document.getElementById('addPartnershipModal');
  if(addModal) addModal.addEventListener('show.bs.modal',function(){
    var ft=document.getElementById('add-step1-tab');if(ft)new bootstrap.Tab(ft).show();
    document.getElementById('addPartnershipForm').reset();
    fUnitCombo.clear();
    fNatureCombo.clear();
    locPreviewSeq.f++; clearTimeout(locPreviewTimer.f);
    var fLoc=document.getElementById('f-location-status'); if(fLoc) fLoc.innerHTML='';
    dismissOcrResult();
    ocrShow('ocr-progress-wrap', false);
    hideFromRequestBanner();
  });
  if(addModal) addModal.addEventListener('hidden.bs.modal',function(){
    // Fires on every close — a successful save (already cleared above), a
    // cancelled request-conversion, or a plain manual Add — so a stale
    // sourceRequestId never leaks into an unrelated later save.
    pendingRequestConversion=null;
    hideFromRequestBanner();
    clearFromRequestParam();
    // Closed (X / backdrop / Cancel) with an extracted-but-never-saved upload still pending — discard its
    // temp file now rather than leaving it for the 10-minute job TTL to eventually clean up. A no-op if
    // submitPartnership() already confirmed (and nulled) it, or if there was never a pending job.
    discardOcrJob();
  });

  checkFromRequestParam();
});

