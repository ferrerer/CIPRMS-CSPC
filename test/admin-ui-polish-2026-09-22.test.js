// Source-content checks for the Administrator/CIRL Staff UI fixes that are pure markup/CSS/client-JS and don't have
// a meaningful server-side behavior to assert on their own (the behavior each one depends on — RBAC, AJAX responses,
// realtime events — is covered elsewhere: calendar-past-event-guard.test.js, realtime.test.js, search-api.test.js).
// Same technique already used by ajax-live-ui.test.js and idp-extraction.test.js for the OCR-fix regression above.
const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

describe('Calendar: Add Event modal is no longer cramped, and the past-date guard exists client-side too', () => {
  const src = read('views', 'administrator', 'calendar.ejs');
  test('the modal is a wide, scrollable dialog (was a bare modal-dialog-centered)', () => {
    expect(src).toMatch(/id="event-modal" tabindex="-1">\s*<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg"/);
  });
  test('Event Type and Date are paired into one responsive row instead of stacking full-width', () => {
    expect(src).toMatch(/col-md-7[\s\S]{0,120}Event Type[\s\S]{0,1200}col-md-5[\s\S]{0,120}Date/);
  });
  // 2026-11 follow-up: Edit now shares Add's own two-step wizard (step 2: recipients), so the cramped
  // `<select multiple size="8">` this test originally covered was replaced outright by that search-and-chips
  // picker — not merely resized. There is no fixed "visible rows" count left to assert on; the real
  // "not cramped" property of today's picker is that it shows a scrollable, unbounded results list instead
  // of a fixed-height multi-select at all.
  test('the recipients/attendees picker is the shared, non-cramped step-2 search UI (not a fixed-height multi-select)', () => {
    expect(src).toContain('id="step-recipients"');
    expect(src).toContain('id="rcp-search"');
    expect(src).toContain('id="rcp-results"');
    expect(src).not.toContain('id="f-recipients"');
  });
  test('every existing field is still present (title, type, date, start/end time, description, attendees)', () => {
    for (const id of ['f-type', 'f-title', 'f-date', 'f-start', 'f-end', 'f-location', 'f-desc', 'rcp-search']) {
      expect(src).toContain(`id="${id}"`);
    }
  });
  test('Join/attendance/invitation UI is untouched', () => {
    expect(src).toContain('btn-attendance');
    expect(src).toContain("include('../partials/meeting_join')");
    expect(src).toContain('v-invite-summary');
  });
  test('a client-side check rejects a brand-new past event before ever calling the API, but only for ADD, never EDIT', () => {
    expect(src).toContain('function isPastNewEvent(dateStr, startStr)');
    expect(src).toContain("if(isAdding && isPastNewEvent(date, st))");
    expect(src).not.toMatch(/currentEv && !isAdding[\s\S]{0,50}isPastNewEvent/);
  });
});

describe('Calendar: server-side past-event guard (cirl.js)', () => {
  const src = read('cirl.js');
  test('isNewEventInThePast exists and is only wired into POST (create), never PATCH (edit)', () => {
    expect(src).toContain('function isNewEventInThePast(fields)');
    const postBlock = src.slice(src.indexOf("app.post('/api/calendarevents', requireStaffAccess"), src.indexOf("app.patch('/api/calendarevents/:id', requireStaffAccess"));
    const patchBlock = src.slice(src.indexOf("app.patch('/api/calendarevents/:id', requireStaffAccess"), src.indexOf("app.delete('/api/calendarevents/:id'"));
    expect(postBlock).toContain('isNewEventInThePast(fields)');
    expect(patchBlock).not.toContain('isNewEventInThePast');
  });
  test('all-day events are compared by calendar date, not exact instant (so "today" is always allowed)', () => {
    const fn = src.slice(src.indexOf('function isNewEventInThePast'), src.indexOf('function validateCalendarEventFields'));
    expect(fn).toContain('eventDateOnly');
    expect(fn).toContain('meetingTime.appTimeZone()');
  });
});

describe('Document Request Details modal (Requests page) is wider and text wraps', () => {
  const src = read('views', 'administrator', 'partnership_requests.ejs');
  test('#dr-modal is a wide, scrollable dialog (was a bare modal-dialog-centered)', () => {
    expect(src).toMatch(/id="dr-modal"[\s\S]{0,60}modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg/);
  });
  test('long values wrap instead of overflowing the modal', () => {
    expect(src).toContain('overflow-wrap: anywhere');
  });
  test('existing draft/review/status functionality is untouched', () => {
    expect(src).toContain('openDRDraftModal()');
    expect(src).toContain('dr-status-select');   // the status control now lives in the table row (was the modal's dr-status-update)
    expect(src).toContain('dr-modal-footer');
  });
});

describe('Document Library: Nature of Partnership filters are dynamic, built from real MOA/MOU records', () => {
  const src = read('views', 'administrator', 'documents.ejs');
  test('the old fixed 5-button list is gone', () => {
    for (const label of ["filterTag('Research'", "filterTag('Student Exchange'", "filterTag('Foreign Exchange'", "filterTag('Training'", "filterTag('Conference'"]) {
      expect(src).not.toContain(label);
    }
  });
  test('pills are rebuilt from allDocs whenever the library loads', () => {
    expect(src).toContain('function renderNaturePills()');
    expect(src).toContain('renderNaturePills();');
    expect(src).toMatch(/function loadDocuments\(\)[\s\S]{0,200}renderNaturePills/);
  });
  test('a pill only exists for a nature actually present on an MOA/MOU record, scoped away from other document types', () => {
    expect(src).toMatch(/doc\.type !== 'MOA' && doc\.type !== 'MOU'\)\s*return;/);
    expect(src).toContain("const nature = doc.nature || 'Other';");
  });
  test('the filter itself checks the real doc.nature field, not the old (always-false) tags/type check', () => {
    expect(src).toContain("(doc.type === 'MOA' || doc.type === 'MOU') && (doc.nature || 'Other') === currentTag");
    expect(src).not.toMatch(/doc\.tags\.includes\(currentTag\)/);
  });
  test('a stale selection with no remaining matches falls back to All instead of showing an unexplained empty grid', () => {
    expect(src).toContain("if (currentTag !== 'All' && !natures.includes(currentTag)) currentTag = 'All';");
  });
  test('live updates refresh the library (and therefore the pills) without a full reload, own-uploads-scoped', () => {
    expect(src).toContain("CIPRMS.live(['document.updated'], loadDocuments");
  });
});

describe('Registry search box exists and actually feeds the existing filter (was referenced by JS but missing from the page)', () => {
  const src = read('views', 'administrator', 'monitoring.ejs');
  test('#reg-search is present', () => {
    expect(src).toContain('id="reg-search"');
  });
  const script = read('assets', 'js', 'pages', 'registry-gridjs.init.js');
  test('applyFilter already reads #reg-search by id — this was previously a phantom reference', () => {
    expect(script).toContain("document.getElementById('reg-search')");
  });
  test('a Partnerships search result deep-links here with ?q=, and the page reads it back into the (now real) search box', () => {
    expect(script).toContain('function applyQueryPrefill()');
    expect(script).toContain("loadPartnerships(false).then(applyQueryPrefill);");
  });
});

describe('Audit Trail and User Management search bars are no longer thin', () => {
  test('Grid.js search input (Audit Trail + every other Grid.js table) is widened/restyled globally', () => {
    const css = read('assets', 'css', 'ciprms-bridge.css');
    expect(css).toContain('.gridjs-search-input.gridjs-input');
    expect(css).toMatch(/\.gridjs-search-input\.gridjs-input\s*\{[^}]*max-width:\s*360px/);
  });
  test('User Management email/role filters are full-height controls, not form-control-sm in a fixed 220px box', () => {
    const src = read('views', 'users.ejs');
    expect(src).toContain('id="usr-filter-email"');
    expect(src).not.toMatch(/form-control form-control-sm" id="usr-filter-email"/);
    expect(src).not.toContain('style="width:220px;"');
    expect(src).toContain('search-box');
  });
  test('existing role labels (CIRL Staff / College Dean / Partner) are unchanged', () => {
    // "College Staff" was renamed to "College Dean" repo-wide after this test was first written
    // (see test/role-display-name.test.js) — updated here to match, not a behavior change of its own.
    const src = read('views', 'users.ejs');
    expect(src).toContain('>College Dean<');
    expect(src).toContain('>CIRL Staff<');
  });
});

describe('Dashboard: Top Partner Countries uses real data and live updates', () => {
  const src = read('views', 'administrator', 'admin_dashboard.ejs');
  test('countries are counted from the real /api/partnerships response, not a static/fake list', () => {
    expect(src).toContain('function renderTopCountries(partnerships)');
    expect(src).toMatch(/fetch\('\/api\/partnerships'/);
    expect(src).not.toMatch(/const\s+top\s*=\s*\[\s*\{\s*country:/); // no hardcoded country array
  });
  test('a blank/missing country is skipped, never counted as a fake entry', () => {
    expect(src).toContain("if (!raw) return;");
  });
  test('a long country name is truncated with a full-name tooltip instead of breaking the row layout', () => {
    expect(src).toContain('text-truncate" title="${esc(country)}"');
  });
  test('live partnership changes refresh the widget without a full page reload, reusing the existing CIPRMS.live infrastructure', () => {
    expect(src).toContain("CIPRMS.live(['partnership.updated', 'partnership.statusChanged']");
    expect(src).toContain('loadDashboardData(true)');
  });
});
