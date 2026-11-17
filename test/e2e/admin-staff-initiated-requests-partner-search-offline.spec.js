// Admin/Staff-Initiated Partnership Requests — searchable Target Partner field, OFFLINE variant.
//
// The DB-backed spec (admin-staff-initiated-requests-partner-search.spec.js, run via the normal
// `npm run test:e2e` / playwright.config.js) exercises this through a real login and a real MongoDB
// container. This offline variant renders the SAME real EJS template (views/administrator/
// partnership_requests.ejs) and runs the SAME real inline client-side script via page.setContent() —
// no server, no login, no MongoDB — with window.CIPRMS.api and window.bootstrap stubbed out, so it can
// verify the combobox's actual DOM/JS behavior (typing filters, keyboard nav, selection, submit-blocked)
// even when the Docker test database is unavailable or unhealthy. Run with:
//   npx playwright test --config=playwright.offline.config.js test/e2e/admin-staff-initiated-requests-partner-search-offline.spec.js
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

function renderPage() {
  const file = path.join(__dirname, '..', '..', 'views', 'administrator', 'partnership_requests.ejs');
  let html = ejs.render(fs.readFileSync(file, 'utf8'), {
    user: { role: 'Administrator', name: 'Test Admin', email: 'admin@test.com' },
    unreadCount: 0
  }, { filename: file });
  // Stub window.CIPRMS.api/busy and window.bootstrap.Modal BEFORE the page's own inline <script> block
  // runs (script tags execute in document order) — the real external bundles (bootstrap.bundle.min.js,
  // ciprms-rt.js, etc.) never load here, there is no server to serve them from.
  const stub = `<script>
    window.__apiCalls = [];
    // Minimal stand-in for idp-ocr-widget.js (never loads here — no server) — just enough of
    // mapDocumentType's real exact-match behavior for 'MOA'/'MOU' to exercise priApplyOcrToForm().
    window.IDP = {
      mapDocumentType: function (detected, valid) { return (detected && valid && valid.indexOf(detected) !== -1) ? detected : null; },
      renderResult: function () {}
    };
    window.bootstrap = { Modal: {
      getOrCreateInstance: function (el) { return { show: function () { el.classList.add('show'); el.style.display = 'block'; }, hide: function () { el.classList.remove('show'); el.style.display = 'none'; } }; },
      getInstance: function (el) { return { hide: function () { el.classList.remove('show'); el.style.display = 'none'; } }; }
    } };
    window.CIPRMS = {
      api: function (url, opts) {
        window.__apiCalls.push({ url: url, opts: opts });
        if (url === '/api/users/partner-options') {
          return Promise.resolve({ ok: true, data: [{ id: 101, name: 'Alpha Partner Co' }, { id: 102, name: 'Beta Partner Co' }] });
        }
        if (url === '/api/requests' && opts && opts.method === 'POST') {
          return Promise.resolve({ ok: true, data: { success: true, request: Object.assign({ id: 999 }, opts.json) } });
        }
        if (url === '/api/ocr/confirm') {
          return Promise.resolve({ ok: true, data: { success: true, documentId: 555, fileLink: '/uploads/documents/mock-ocr.pdf' } });
        }
        return Promise.resolve({ ok: true, data: [] });
      },
      busy: function (btn, fn) { return fn(); },
      live: function () {}
    };
  </script>`;
  html = html.replace('<head>', '<head>' + stub);
  return html;
}

test('typing filters the partner list by name, selecting fills the hidden id, "No partners found" shows for a non-match, and keyboard nav/Esc work', async ({ page }) => {
  await page.setContent(renderPage(), { waitUntil: 'load' });
  await page.click('#pr-initiate-btn');
  await expect(page.locator('#pr-initiate-modal')).toBeVisible();

  const search = page.locator('#pri-partner-search');
  const dropdown = page.locator('#pri-partner-dropdown');

  await search.click();
  await expect(dropdown).toBeVisible();
  await expect(dropdown).toContainText('Alpha Partner Co');
  await expect(dropdown).toContainText('Beta Partner Co');

  await search.fill('Alpha');
  await expect(dropdown).toContainText('Alpha Partner Co');
  await expect(dropdown).not.toContainText('Beta Partner Co');

  await dropdown.locator('.pri-partner-option', { hasText: 'Alpha Partner Co' }).click();
  await expect(search).toHaveValue('Alpha Partner Co');
  await expect(page.locator('#pri-partner-id')).toHaveValue('101');
  await expect(dropdown).toBeHidden();

  // Typing again clears the stale selection.
  await search.fill('zzz-no-such-partner-zzz');
  await expect(dropdown).toContainText('No partners found');
  await expect(page.locator('#pri-partner-id')).toHaveValue('');

  // Keyboard: ArrowDown highlights, Enter selects.
  await search.fill('');
  await search.press('ArrowDown');
  await expect(page.locator('.pri-partner-option.is-active')).toHaveCount(1);
  await search.press('Enter');
  await expect(page.locator('#pri-partner-id')).not.toHaveValue('');
  await expect(dropdown).toBeHidden();

  // Esc closes without selecting.
  await search.click();
  await expect(dropdown).toBeVisible();
  await search.press('Escape');
  await expect(dropdown).toBeHidden();
});

test('submitting without selecting a partner is blocked — typed text alone is not enough, and no request call is made', async ({ page }) => {
  await page.setContent(renderPage(), { waitUntil: 'load' });
  await page.click('#pr-initiate-btn');

  await page.fill('#pri-partner-search', 'Alpha Partner Co'); // typed, never actually selected from the list
  await page.fill('#pri-inst', 'Unselected Partner Co');
  await page.fill('#pri-country', 'Testland');
  await page.selectOption('#pri-type', 'MOA');
  await page.selectOption('#pri-nature', 'Research');
  await page.click('#pri-submit-btn');

  await expect(page.locator('#pr-initiate-modal')).toBeVisible(); // still open — blocked before any API call
  // loadPR()'s own background GET to /api/requests fires on every page load regardless (same as the real
  // app) — only a POST (an actual submission) is what this test must prove never happened.
  const calls = await page.evaluate(() => window.__apiCalls.filter(c => c.url === '/api/requests' && c.opts && c.opts.method === 'POST'));
  expect(calls.length).toBe(0);
});

test('a real selection submits successfully with the correct targetPartnerId, and the modal closes', async ({ page }) => {
  await page.setContent(renderPage(), { waitUntil: 'load' });
  await page.click('#pr-initiate-btn');

  await page.fill('#pri-partner-search', 'Beta');
  await page.click('.pri-partner-option', { timeout: 5000 });
  await expect(page.locator('#pri-partner-id')).toHaveValue('102');

  await page.fill('#pri-inst', 'Searchable Combo University');
  await page.fill('#pri-country', 'Testland');
  await page.selectOption('#pri-type', 'MOA');
  await page.selectOption('#pri-nature', 'Research');
  await page.click('#pri-submit-btn');

  await expect(page.locator('#pr-initiate-modal')).toBeHidden();
  const calls = await page.evaluate(() => window.__apiCalls.filter(c => c.url === '/api/requests' && c.opts && c.opts.method === 'POST'));
  expect(calls.length).toBe(1);
  expect(calls[0].opts.json.targetPartnerId).toBe(102);
  expect(calls[0].opts.json.initiatedBy).toBe('institution');
  expect(calls[0].opts.json.institution).toBe('Searchable Combo University');
});

test('dark mode: the dropdown is visible and themed, not invisible-on-invisible', async ({ page }) => {
  await page.setContent(renderPage(), { waitUntil: 'load' });
  // views/partials/ui-state-init.ejs's own inline script resets data-bs-theme to 'light' on load when no
  // saved per-user preference exists (there is none in this fresh, unauthenticated context) — so the
  // theme switch has to happen AFTER that script has already run, same as a real dark-mode toggle click
  // would, rather than by baking the attribute into the initial HTML string.
  await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
  await page.click('#pr-initiate-btn');
  await page.click('#pri-partner-search');
  const dropdown = page.locator('#pri-partner-dropdown');
  await expect(dropdown).toBeVisible();
  const bg = await dropdown.evaluate(el => getComputedStyle(el).backgroundColor);
  expect(bg).not.toBe('rgb(255, 255, 255)'); // the [data-bs-theme="dark"] override actually applied
});

test('mobile viewport: the combobox and its dropdown stay within the viewport width', async ({ page }) => {
  // Note: page.setContent() has no server, so the external Bootstrap/app CSS bundles (which govern the
  // rest of the page's own responsive table/sidebar layout) never load here — only this file's own
  // inline <style> block does. So this checks what this task actually touched (the combobox markup/CSS
  // added in this task), not the whole page's pre-existing responsive behavior, which needs the real
  // stylesheet and is instead covered by the DB-backed spec's equivalent mobile test.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.setContent(renderPage(), { waitUntil: 'load' });
  await page.click('#pr-initiate-btn');
  await expect(page.locator('#pr-initiate-modal')).toBeVisible();
  await page.click('#pri-partner-search');
  const dropdown = page.locator('#pri-partner-dropdown');
  await expect(dropdown).toBeVisible();

  const searchBox = await page.locator('#pri-partner-search').boundingBox();
  const dropdownBox = await dropdown.boundingBox();
  expect(searchBox.x + searchBox.width).toBeLessThanOrEqual(390 + 1);
  expect(dropdownBox.x + dropdownBox.width).toBeLessThanOrEqual(390 + 1);
  expect(dropdownBox.x).toBeGreaterThanOrEqual(-1);
});

test('(2026-11 follow-up) "Request Partnership" sits in the search row next to the count, not in the tabs row, and the modal is modal-xl', async ({ page }) => {
  const html = renderPage();
  await page.setContent(html, { waitUntil: 'load' });
  expect(html.indexOf('id="pr-count"')).toBeLessThan(html.indexOf('id="pr-initiate-btn"'));
  expect(html.lastIndexOf('class="filter-row"', html.indexOf('id="pr-initiate-btn"')))
    .toBeGreaterThan(html.indexOf('class="section-tabs"'));
  await expect(page.locator('#pr-initiate-btn')).toBeVisible();
  await page.click('#pr-initiate-btn');
  await expect(page.locator('#pr-initiate-modal .modal-dialog')).toHaveClass(/modal-xl/);
});

test('OCR autofill fills the modal\'s fields from a mocked extraction result, but never the Target Partner field', async ({ page }) => {
  await page.setContent(renderPage(), { waitUntil: 'load' });
  await page.click('#pr-initiate-btn');
  await expect(page.locator('#pr-initiate-modal')).toBeVisible();

  // Mirrors the Partner form's own applyOcrToForm() input shape — same field names
  // (institution/country/category/region/nature/documentType/startDate/endDate).
  await page.evaluate(() => {
    window.priOcrSucceed('fake-job-1', {
      institution: 'Gamma Research Institute',
      country: 'Japan',
      category: 'International',
      region: 'Asia',
      nature: 'Research',
      documentType: 'MOA',
      startDate: 'March 3, 2026',
      endDate: 'March 3, 2031'
    });
  });

  await expect(page.locator('#pri-inst')).toHaveValue('Gamma Research Institute');
  await expect(page.locator('#pri-country')).toHaveValue('Japan');
  await expect(page.locator('#pri-cat')).toHaveValue('International');
  await expect(page.locator('#pri-region')).toHaveValue('Asia');
  await expect(page.locator('#pri-nature')).toHaveValue('Research');
  await expect(page.locator('#pri-type')).toHaveValue('MOA');
  await expect(page.locator('#pri-start')).toHaveValue('2026-03-03');
  await expect(page.locator('#pri-end')).toHaveValue('2031-03-03');

  // Target Partner is never touched by autofill — it still must be picked from the list.
  await expect(page.locator('#pri-partner-search')).toHaveValue('');
  await expect(page.locator('#pri-partner-id')).toHaveValue('');

  // The result box reflects a (mocked) successful archive — confirm/documentId round-tripped.
  const confirmCalls = await page.evaluate(() => window.__apiCalls.filter(c => c.url === '/api/ocr/confirm'));
  expect(confirmCalls.length).toBe(1);
  expect(confirmCalls[0].opts.json.jobId).toBe('fake-job-1');
});

test('OCR autofill only sets fields OCR actually found a value for — it never blanks a field OCR had nothing for', async ({ page }) => {
  await page.setContent(renderPage(), { waitUntil: 'load' });
  await page.click('#pr-initiate-btn');
  await page.fill('#pri-notes', 'Pre-existing note the user already typed');
  await page.evaluate(() => { window.priOcrSucceed('fake-job-2', { institution: 'Delta University' }); });
  await expect(page.locator('#pri-inst')).toHaveValue('Delta University');
  // documentType/country/etc. were absent from this result — those fields (and the untouched notes field)
  // stay exactly as they were, never cleared to blank.
  await expect(page.locator('#pri-notes')).toHaveValue('Pre-existing note the user already typed');
  await expect(page.locator('#pri-country')).toHaveValue('');
});
