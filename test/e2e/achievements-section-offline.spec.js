// Institutional Achievements dashboard section (2026-11 — moved out of the header-triggered modal to the
// bottom of the Dashboard, below Executive Briefing). Real DOM check against the actual, unmodified
// views/administrator/admin_dashboard.ejs — no server, no real network: window.CIPRMS.api is stubbed so
// this proves the CLIENT behavior (capping at 4, "See more" threshold, filter pills, thumbnail vs icon,
// Add/Edit/Delete wiring from the SECTION specifically) independent of whatever the server returns.
// Server-side archiving behavior is covered by test/achievements-document-library.test.js.
const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'views', 'administrator', 'admin_dashboard.ejs');
const BOOTSTRAP_PATH = path.join(__dirname, '..', '..', 'assets', 'libs', 'bootstrap', 'js', 'bootstrap.bundle.min.js');
const BOOTSTRAP_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'css', 'bootstrap.min.css');
const ICONS_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'css', 'icons.min.css');

function renderPage() {
  // id must be a real number, not the Proxy's usual '' fallback — the page's own window.CIPRMS_USER
  // script embeds it unquoted, so an empty-string substitution there is a genuine JS syntax error that
  // breaks every later <script> block too (found live via this exact kind of spec in this session).
  const base = {
    user: { role: 'Administrator', name: 'Test Admin', email: 'admin@test.com', id: 1 }, activePage: 'dashboard',
    dashActive: 1, dashExpiring: 1, dashExpired: 1, dashTotal: 3, activePartnerships: [],
    insightRenewal: 'x', insightOptimization: 'y',
    yearlyTargetYear: 2026, yearlyTarget: null, yearlyTargetProgress: null, yearlyTargetStatus: null, yearlyTargetDays: null
  };
  const locals = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !k.startsWith('_') && k !== 'constructor' ? '' : undefined))
  });
  const html = ejs.render(fs.readFileSync(TEMPLATE_PATH, 'utf8'), locals, { filename: TEMPLATE_PATH });
  // The map widget's leaflet/maplibre <script> tags are irrelevant here and are actively hostile to an
  // offline render (see yearly-target-card-offline.spec.js's identical note): with no real network, they
  // eventually trigger a late document.write() that wipes the whole page once it has already loaded.
  // page.setContent() does not run Playwright's addInitScript() (that only fires on real navigation),
  // so the only way to have a stub ready before the page's OWN scripts run is to inject it into the HTML
  // string itself, right after <head>. Needed because the page's single giant inline <script> sets up the
  // Leaflet partnership map (L.map(...), etc.) BEFORE the achievements code further down in that same
  // tag; with no real Leaflet loaded offline, `L` would be undefined and that first line would throw,
  // aborting the rest of the script — including the achievements section's own `var` initializers and
  // its eager achLoadList() call. A universal chainable stub (any property access/call returns another
  // stub) satisfies every L.* shape the map code uses without having to enumerate them.
  const leafletStub = '<script>(function () {' +
    'function stub() { var t = function () { return stub(); }; return new Proxy(t, { get: function (o, p) { return p === "then" ? undefined : function () { return stub(); }; } }); }' +
    'window.L = stub();' +
    '})();</script>';
  return html
    .replace(/<(script|link)[^>]*unpkg\.com[^>]*>(<\/script>)?/g, '')
    .replace(/<script>document\.write\(new Date\(\)\.getFullYear\(\)\)<\/script>/, String(new Date().getFullYear()))
    .replace('<head>', '<head>' + leafletStub);
}

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
function fakeAchievement(id, title, category, fileType) {
  return {
    id, title, category, organization: 'jesttest Org', description: 'jesttest description', dateAchieved: '2026-01-15',
    fileLink: fileType ? ('/uploads/documents/jesttest-' + id + '.bin') : null,
    originalFilename: fileType ? ('file-' + id) : null,
    fileType: fileType || null,
    documentId: fileType ? (100 + id) : null
  };
}
// Order is "newest first", matching what the server would return — the first 4 are what the capped
// section shows, so they're deliberately one of each thumbnail case (image / pdf / docx / no-file); the
// other QS Ranking entry and the Award are pushed past the cap, only visible via "See more".
const SIX_ACHIEVEMENTS = [
  fakeAchievement(2, 'jesttest QS Ranking B', 'QS Ranking', 'image/png'),
  fakeAchievement(3, 'jesttest TUV Cert', 'TUV Certification', 'application/pdf'),
  fakeAchievement(4, 'jesttest PQA Accred', 'PQA', DOCX_MIME),
  fakeAchievement(5, 'jesttest Accreditation', 'Accreditation', null),
  fakeAchievement(1, 'jesttest QS Ranking A', 'QS Ranking', null),
  fakeAchievement(6, 'jesttest Award', 'Award', null)
];

async function setup(page, achievements) {
  await page.setContent(renderPage());
  await page.addStyleTag({ path: BOOTSTRAP_CSS_PATH });
  // Without the remixicon class rules, an icon-only button's <i> (e.g. the delete button, which has no
  // text) has no ::before content and collapses to a 0x0 box — Playwright then waits forever for it to
  // become "visible". Loading the real icons stylesheet gives every .ri-* element its glyph box, even
  // though the actual webfont file itself still fails to load offline (irrelevant — only the box size
  // matters here, not the rendered glyph).
  await page.addStyleTag({ path: ICONS_CSS_PATH });
  await page.addScriptTag({ path: BOOTSTRAP_PATH });
  await page.evaluate((list) => {
    window.__apiCalls = [];
    window.CIPRMS = window.CIPRMS || {};
    window.CIPRMS.api = (url, opts) => {
      window.__apiCalls.push({ url, method: (opts && opts.method) || 'GET' });
      if (url === '/api/achievements' && (!opts || !opts.method || opts.method === 'GET')) {
        return Promise.resolve({ ok: true, status: 200, data: list });
      }
      return Promise.resolve({ ok: true, status: 200, data: { success: true } });
    };
    window.CIPRMS.toast = () => {};
    window.CIPRMS.busy = (btn, fn) => fn(); // no-op double-click guard for this offline render
    // A fileLink like '/uploads/documents/...' can't resolve against this offline page's document (set
    // via page.setContent(), so it has no real origin) — the <img> fails before any request even reaches
    // Playwright's network layer, firing achImgError(this) (swap to the no-file placeholder) sooner than
    // any assertion could run. That's the real, correct behavior for an actually-missing file; here it
    // would just mask what achCardHtml() decided to render, so it's turned into a no-op for this suite.
    window.achImgError = function () {};
  }, achievements);
  // The page's own eager achLoadList() call (added so the section populates on real page load) fires
  // DURING page.setContent(), before this stub is installed — page.setContent() has no reliable "before
  // inline scripts run" hook (same finding as yearly-target-card-offline.spec.js). Re-triggered here,
  // now that window.CIPRMS.api actually resolves to this spec's fake data.
  await page.evaluate(() => achLoadList());
  await page.waitForFunction(() => !document.getElementById('ach-section-list').textContent.includes('Loading'));
}

test.describe('Institutional Achievements dashboard section (admin_dashboard.ejs)', () => {
  test('0 achievements: empty state with an Add button, no "See more"', async ({ page }) => {
    await setup(page, []);
    const section = page.locator('#ach-section-card');
    await expect(section).toContainText('No achievements yet');
    await expect(section.locator('.ach-card')).toHaveCount(0);
    await expect(page.locator('#ach-section-see-more')).toBeHidden();
  });

  test('3 achievements: all 3 shown, no "See more"', async ({ page }) => {
    await setup(page, SIX_ACHIEVEMENTS.slice(0, 3));
    await expect(page.locator('#ach-section-list .ach-card')).toHaveCount(3);
    await expect(page.locator('#ach-section-see-more')).toBeHidden();
  });

  test('6 achievements: only 4 shown (newest-first order from the server is preserved), "See more" appears and opens the full list modal', async ({ page }) => {
    await setup(page, SIX_ACHIEVEMENTS);
    await expect(page.locator('#ach-section-list .ach-card')).toHaveCount(4);
    const seeMore = page.locator('#ach-section-see-more');
    await expect(seeMore).toBeVisible();

    await seeMore.locator('button').click();
    await expect(page.locator('#achievements-modal')).toBeVisible();
    await expect(page.locator('#ach-list .ach-card')).toHaveCount(6); // the modal shows the full, uncapped list
  });

  test('filter pills narrow both the section and the "see more" modal to one category, and stay in sync', async ({ page }) => {
    await setup(page, SIX_ACHIEVEMENTS);
    await page.locator('#ach-section-filter-tabs .ach-filter-tab[data-category="QS Ranking"]').click();
    await expect(page.locator('#ach-section-list .ach-card')).toHaveCount(2);
    // "See more" is now hidden — only 2 of the 6 match this filter, under the cap.
    await expect(page.locator('#ach-section-see-more')).toBeHidden();
    // Both the section's own pill AND the (not-yet-opened) modal's matching pill reflect the new filter.
    await expect(page.locator('#ach-section-filter-tabs .ach-filter-tab[data-category="QS Ranking"]')).toHaveClass(/active/);
    await expect(page.locator('#ach-filter-tabs .ach-filter-tab[data-category="QS Ranking"]')).toHaveClass(/active/);
  });

  test('thumbnail: an image file shows a real <img> preview; PDF/DOCX show their own icon, never an empty placeholder', async ({ page }) => {
    await setup(page, SIX_ACHIEVEMENTS);
    const cards = page.locator('#ach-section-list .ach-card');
    // Scoped to .ach-card-image-placeholder specifically — the same file-type icon also appears a second
    // time in the card's "View File" button, so an unscoped count would be 2, not 1, for any file type.
    await expect(cards.nth(0).locator('img.ach-card-image')).toHaveCount(1); // QS Ranking B, image/png
    await expect(cards.nth(1).locator('.ach-card-image-placeholder .ri-file-pdf-2-line')).toHaveCount(1); // TUV Cert, application/pdf
    await expect(cards.nth(2).locator('.ach-card-image-placeholder .ri-file-word-2-line')).toHaveCount(1); // PQA Accred, docx
    await expect(cards.nth(3).locator('.ach-card-image-placeholder .ri-trophy-line')).toHaveCount(1); // Accreditation, no file at all — generic placeholder, not empty
  });

  test('Add from the section opens the form modal directly, without first popping open the full-list modal', async ({ page }) => {
    await setup(page, SIX_ACHIEVEMENTS);
    await page.locator('#ach-section-card button:has-text("Add Achievement")').click();
    await expect(page.locator('#achievement-form-modal')).toBeVisible();
    await expect(page.locator('#achievements-modal')).toBeHidden();

    await page.locator('#achievement-form-modal button:has-text("Cancel")').click();
    await expect(page.locator('#achievement-form-modal')).toBeHidden();
    await expect(page.locator('#achievements-modal')).toBeHidden(); // stays closed — it was never the opener
  });

  test('Edit from the section pre-fills the form and saves via PATCH; the section re-renders without the list modal appearing', async ({ page }) => {
    await setup(page, SIX_ACHIEVEMENTS);
    await page.locator('#ach-section-list .ach-card').first().locator('button:has-text("Edit")').click();
    await expect(page.locator('#achievement-form-modal')).toBeVisible();
    await expect(page.locator('#ach-f-title')).toHaveValue('jesttest QS Ranking B');

    await page.locator('#ach-f-save-btn').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'PATCH'));
    await expect(page.locator('#achievement-form-modal')).toBeHidden();
    await expect(page.locator('#achievements-modal')).toBeHidden();
  });

  test('Delete from the section asks for confirmation and sends DELETE, without the list modal appearing', async ({ page }) => {
    await setup(page, SIX_ACHIEVEMENTS);
    await page.locator('#ach-section-list .ach-card').first().locator('button .ri-delete-bin-line').click();
    await expect(page.locator('#achievement-delete-modal')).toBeVisible();

    await page.locator('#achievement-delete-modal button:has-text("Yes, Delete It")').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'DELETE'));
    await expect(page.locator('#achievement-delete-modal')).toBeHidden();
    await expect(page.locator('#achievements-modal')).toBeHidden();
  });
});
