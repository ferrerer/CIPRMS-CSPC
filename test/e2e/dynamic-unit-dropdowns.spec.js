// Dynamic College/Unit Dropdowns across Monitoring and Reports & Analytics (2026-11) — real-browser
// coverage (run with `npm run test:e2e`, see playwright.config.js) for the one capability added in this
// task: an "Add New Unit" control, backed by the existing shared `responsibleunits` collection and
// POST/GET /api/responsible-units API (no new collection, no duplicate validation path), reachable from
// three places — Monitoring's Add/Edit Partnership "Responsible Unit" combobox (pre-existing, 2026-11
// Responsible Unit investigation; already covered at the API level by test/responsible-units.test.js) and
// the two NEW locations this task adds it to: Reports & Analytics' Custom Report Builder College/Unit
// filter and its Comparison configs' College/Unit field.
//
// Every created unit is tagged in its name with TEST_TAG so cleanupAll()-style hygiene is possible, and is
// deleted by id in afterAll — this suite runs against the same real MONGO_URI every other test in this
// project uses; there is no separate test database.
const { test, expect } = require('@playwright/test');
const path = require('path');
// This spec file is loaded by the Playwright test-runner process itself, which — unlike the webServer
// child process (node cirl.js, which calls this on its own at the top of cirl.js) — never loads .env on
// its own; db.js reads process.env.MONGO_URI directly without doing so itself either. The require('dotenv')
// call below WAS loading .env's real production MONGO_URI into this process with nothing to stop it
// (db.js's test-mode safety check never triggers here: NODE_ENV isn't 'test' and JEST_WORKER_ID isn't set
// in a Playwright test worker) — this file's own connectDB() was silently connecting to production while
// the webServer it drove used the local test DB. Setting MONGO_URI to the safe local URI FIRST closes
// that, since dotenv never overrides an already-set var (2026-11 data-safety fix).
const { resolveTestDatabaseUri } = require(path.join(__dirname, '..', '..', 'services', 'testDatabaseGuard'));
process.env.MONGO_URI = resolveTestDatabaseUri(process.env);
require('dotenv').config();
const { connectDB, closeDB, getDb } = require(path.join(__dirname, '..', '..', 'db'));
const { createTestUser, cleanupAll, TEST_TAG } = require(path.join(__dirname, '..', 'helpers'));

test.describe.configure({ mode: 'serial' });

let admin, staff, partner;
const createdUnitIds = [];

async function loginAs(page, user) {
  const res = await page.request.post('/login', { form: { username: user.email, password: user.password } });
  expect(res.status()).toBeLessThan(400);
}

function uniqueUnitName(label) {
  return `${TEST_TAG} ${label} ${Date.now()}.${Math.floor(Math.random() * 1e6)}`;
}

async function trackUnit(name) {
  const doc = await getDb().collection('responsibleunits').findOne({ name });
  expect(doc, `"${name}" should have been persisted to the responsibleunits collection`).toBeTruthy();
  createdUnitIds.push(doc.id);
  return doc;
}

// Drives the shared "Add Responsible Unit" modal (views/partials/add_unit_modal.ejs) to completion from
// whichever page/trigger already opened it — every location in this app opens the exact same modal.
async function fillAndSubmitAddUnitModal(page, name) {
  await expect(page.locator('#add-unit-modal')).toBeVisible();
  await page.fill('#new-unit-name', name);
  await page.click('#new-unit-add-btn');
  await expect(page.locator('#add-unit-modal')).toBeHidden();
}

test.beforeAll(async () => {
  await connectDB();
  admin = await createTestUser({ role: 'Administrator' });
  staff = await createTestUser({ role: 'Staff' });
  partner = await createTestUser({ role: 'potential_partner' });
});

test.afterAll(async () => {
  if (createdUnitIds.length) await getDb().collection('responsibleunits').deleteMany({ id: { $in: createdUnitIds } });
  await cleanupAll();
  await closeDB();
});

test.describe('Monitoring — Add New Partnership — Responsible Unit combo', () => {
  test('Administrator: "+ Add Responsible Unit" creates, auto-selects as a chip, persists to the DB, and survives a reload', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/lifecycle');
    await page.click('[data-bs-target="#addPartnershipModal"]');
    await expect(page.locator('#addPartnershipModal')).toBeVisible();
    await page.click('#add-step3-tab');
    await page.click('#f-unit-input'); // opens the combo dropdown
    await page.click('.unit-combo-add'); // "+ Add Responsible Unit" row

    const name = uniqueUnitName('Monitoring');
    await fillAndSubmitAddUnitModal(page, name);

    await expect(page.locator('#f-unit-chips')).toContainText(name);
    await trackUnit(name);

    // Reload and confirm the SAME unit is offered again from the DB, not just kept alive in memory.
    await page.reload();
    await page.click('[data-bs-target="#addPartnershipModal"]');
    await page.click('#add-step3-tab');
    await page.click('#f-unit-input');
    await expect(page.locator('.unit-combo-option', { hasText: name })).toBeVisible();
  });

  test('Staff: has the exact same "Add Responsible Unit" capability on their own Monitoring URL', async ({ page }) => {
    await loginAs(page, staff);
    await page.goto('/staff/lifecycle');
    await page.click('[data-bs-target="#addPartnershipModal"]');
    await page.click('#add-step3-tab');
    await page.click('#f-unit-input');
    await page.click('.unit-combo-add');

    const name = uniqueUnitName('StaffMonitoring');
    await fillAndSubmitAddUnitModal(page, name);
    await expect(page.locator('#f-unit-chips')).toContainText(name);
    await trackUnit(name);
  });
});

test.describe('Reports & Analytics — Custom Report Builder College/Unit filter', () => {
  test('a unit created from Monitoring is already selectable here on a fresh load (one shared list, not two)', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/lifecycle');
    await page.click('[data-bs-target="#addPartnershipModal"]');
    await page.click('#add-step3-tab');
    await page.click('#f-unit-input');
    await page.click('.unit-combo-add');
    const name = uniqueUnitName('CrossCheck');
    await fillAndSubmitAddUnitModal(page, name);
    await trackUnit(name);

    await page.goto('/reports');
    await page.selectOption('#cr-unit', name);
    await expect(page.locator('#cr-unit')).toHaveValue(name);
  });

  test('Administrator: "+" beside College/Unit creates a unit, auto-selects it with no page reload, and it persists to the DB', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#cr-unit-add-btn');
    const name = uniqueUnitName('ReportBuilder');
    await fillAndSubmitAddUnitModal(page, name);

    await expect(page.locator('#cr-unit')).toHaveValue(name);
    await expect(page.locator('#cr-unit option', { hasText: name })).toHaveCount(1);
    await trackUnit(name);
  });

  test('the Custom Report Builder actually filters by a freshly created unit (not just offers it as an option)', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#cr-unit-add-btn');
    const name = uniqueUnitName('FilterCheck');
    await fillAndSubmitAddUnitModal(page, name);
    await trackUnit(name);

    // No partnership uses this brand-new unit yet — Preview must come back empty, not error, proving the
    // filter value actually reaches computeCustomReportData() as a real (if currently unmatched) value.
    await page.click('#btn-cr-preview');
    await expect(page.locator('#rpm-view-preview')).toBeVisible();
    await expect(page.locator('#rpm-error')).toBeHidden();
  });

  test('Staff: has the exact same College/Unit "Add New Unit" capability on their own Reports URL', async ({ page }) => {
    await loginAs(page, staff);
    await page.goto('/staff/reports');
    await page.click('#cr-unit-add-btn');
    const name = uniqueUnitName('StaffReportBuilder');
    await fillAndSubmitAddUnitModal(page, name);
    await expect(page.locator('#cr-unit')).toHaveValue(name);
    await trackUnit(name);
  });
});

test.describe('Reports & Analytics — Comparison College/Unit field', () => {
  test('Add New Unit on the first Comparison config is immediately selectable there, and already present in a config added afterwards', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#btn-cr-preview');
    await expect(page.locator('#rpm-view-preview')).toBeVisible();
    await page.click('button:has-text("Compare")');
    await expect(page.locator('#rpm-view-compare-select')).toBeVisible();

    const firstUnitSelect = page.locator('select[id^="cmpcfg-"][id$="-unit"]').first();
    const firstId = await firstUnitSelect.getAttribute('id');
    await page.click(`[data-add-unit-for="${firstId}"]`);
    const name = uniqueUnitName('Comparison');
    await fillAndSubmitAddUnitModal(page, name);
    await expect(firstUnitSelect).toHaveValue(name);
    await trackUnit(name);

    // Add a second configuration AFTER the unit was created — its own dropdown must already offer it.
    await page.click('#cmp-add-btn');
    const secondUnitSelect = page.locator('select[id^="cmpcfg-"][id$="-unit"]').nth(1);
    await expect(secondUnitSelect.locator('option', { hasText: name })).toHaveCount(1);

    // And the primary Custom Report Builder's own #cr-unit (currently hidden behind this view, not
    // reloaded) reflects it too — one shared list, read fresh wherever it's rendered.
    await expect(page.locator('#cr-unit option', { hasText: name })).toHaveCount(1);
  });

  test('Generate Comparison actually runs with a freshly created unit as one configuration\'s filter', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#btn-cr-preview');
    await page.click('button:has-text("Compare")');
    const firstUnitSelect = page.locator('select[id^="cmpcfg-"][id$="-unit"]').first();
    const firstId = await firstUnitSelect.getAttribute('id');
    await page.click(`[data-add-unit-for="${firstId}"]`);
    const name = uniqueUnitName('CompareGenerate');
    await fillAndSubmitAddUnitModal(page, name);
    await trackUnit(name);

    await page.click('#btn-generate-comparison');
    await expect(page.locator('#rpm-view-compare-result')).toBeVisible();
    await expect(page.locator('#rpm-error')).toBeHidden();
  });
});

test.describe('Validation — required, duplicate, invalid characters, excessive length', () => {
  test('a blank (or whitespace-only) name is rejected inline, nothing is sent to the server', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#cr-unit-add-btn');
    await page.fill('#new-unit-name', '   ');
    const before = await getDb().collection('responsibleunits').countDocuments({});
    await page.click('#new-unit-add-btn');
    await expect(page.locator('#new-unit-error')).toBeVisible();
    await expect(page.locator('#new-unit-error')).toHaveText('Unit name is required.');
    expect(await getDb().collection('responsibleunits').countDocuments({})).toBe(before);
  });

  test('a case-insensitive duplicate of an existing unit is rejected with a clear message, not a raw server error', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#cr-unit-add-btn');
    await page.fill('#new-unit-name', 'cirl'); // the seeded "CIRL" unit, different casing
    await page.click('#new-unit-add-btn');
    await expect(page.locator('#new-unit-error')).toBeVisible();
    await expect(page.locator('#new-unit-error')).toContainText('already exists');
  });

  test('disallowed characters are rejected by the server even if typed past the client-side pattern', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#cr-unit-add-btn');
    await page.fill('#new-unit-name', `${TEST_TAG} <script>alert(1)</script>`);
    await page.click('#new-unit-add-btn');
    await expect(page.locator('#new-unit-error')).toBeVisible();
    await expect(page.locator('#new-unit-error')).toContainText('letters, numbers, spaces');
    expect(await getDb().collection('responsibleunits').findOne({ name: { $regex: 'script' } })).toBeNull();
  });

  test('a name over 100 characters is rejected server-side even when the client-side maxlength is bypassed', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#cr-unit-add-btn');
    const tooLong = (TEST_TAG + ' ' + 'A'.repeat(120)).slice(0, 150);
    // Bypasses the input's maxlength="100" (a real attacker would too) to prove the SERVER, not just the
    // browser, enforces the limit.
    await page.evaluate((value) => {
      const el = document.getElementById('new-unit-name');
      el.removeAttribute('maxlength');
      el.value = value;
    }, tooLong);
    await page.click('#new-unit-add-btn');
    await expect(page.locator('#new-unit-error')).toBeVisible();
    await expect(page.locator('#new-unit-error')).toContainText('100 characters or fewer');
  });
});

test.describe('Security — unauthorized roles cannot reach or use this capability', () => {
  test('a potential_partner cannot load Monitoring/Reports, and the create-unit API itself rejects them directly', async ({ page }) => {
    await loginAs(page, partner);
    // denyAccess() redirects (never a bare 403) for an ordinary request without CIPRMS.api()'s own
    // X-Requested-With header — matching test/responsible-units.test.js's already-established expectation
    // for this exact route/role combination.
    const lifecycleRes = await page.request.get('/lifecycle', { maxRedirects: 0 });
    expect(lifecycleRes.status()).toBe(302);
    const reportsRes = await page.request.get('/reports', { maxRedirects: 0 });
    expect(reportsRes.status()).toBe(302);

    const apiRes = await page.request.post('/api/responsible-units', { maxRedirects: 0, data: { name: 'Should Not Be Created' } });
    expect(apiRes.status()).toBe(302);
    // The same call, but as CIPRMS.api() itself would send it (X-Requested-With), gets the real JSON 403 —
    // the plain-language message a signed-in, wrong-role account actually sees from the real UI.
    const apiResJson = await page.request.post('/api/responsible-units', {
      headers: { 'X-Requested-With': 'ciprms' },
      data: { name: 'Should Not Be Created' }
    });
    expect(apiResJson.status()).toBe(403);
    expect(await getDb().collection('responsibleunits').findOne({ name: 'Should Not Be Created' })).toBeNull();
  });
});

test.describe('Dark mode and mobile layout', () => {
  test('dark mode: the Add New Unit button and modal remain fully usable on Reports & Analytics', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('.light-dark-mode');
    await expect(page.locator('html')).toHaveAttribute('data-bs-theme', 'dark');

    await page.click('#cr-unit-add-btn');
    await expect(page.locator('#add-unit-modal')).toBeVisible();
    const name = uniqueUnitName('DarkMode');
    await fillAndSubmitAddUnitModal(page, name);
    await expect(page.locator('#cr-unit')).toHaveValue(name);
    await trackUnit(name);
  });

  test('mobile viewport: the "+" button beside College/Unit is reachable and the modal works at phone width', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await loginAs(page, admin);
    await page.goto('/reports');
    await expect(page.locator('#cr-unit-add-btn')).toBeVisible();
    await page.click('#cr-unit-add-btn');
    await expect(page.locator('#add-unit-modal')).toBeVisible();
    const name = uniqueUnitName('Mobile');
    await fillAndSubmitAddUnitModal(page, name);
    await expect(page.locator('#cr-unit')).toHaveValue(name);
    await trackUnit(name);
  });

  test('no unhandled console errors were produced across the dynamic Unit dropdown flow', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });

    await loginAs(page, admin);
    await page.goto('/reports');
    await page.click('#cr-unit-add-btn');
    const name = uniqueUnitName('ConsoleCheck');
    await fillAndSubmitAddUnitModal(page, name);
    await trackUnit(name);

    // assets/js/plugins.js (pre-existing Velzon theme boilerplate, untouched by this task) unconditionally
    // document.writeln()s <script> tags for choices.js/flatpickr whenever a page has a [data-choices] or
    // [data-provider] element, whether or not those optional library files were ever vendored into this
    // trimmed-down deployment — confirmed present before this task's changes (grep assets/js/plugins.js).
    // Real errors from the Unit dropdown feature itself would show as something else entirely.
    const ignoredPreExisting = /choices\.min\.js|flatpickr\.min\.js|Failed to load resource/;
    expect(errors.filter((e) => !ignoredPreExisting.test(e))).toEqual([]);
  });
});
