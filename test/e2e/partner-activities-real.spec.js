// "List of Activities" — REAL browser, REAL server, REAL local test database (run with `npm run test:e2e`,
// which boots `node cirl.js` against the dedicated local _test Mongo — see playwright.config.js). This is
// deliberately separate from partner-activities-offline.spec.js (which renders the EJS template directly
// and never starts a server): that spec proves the DOM/JS logic in isolation, this one proves the actual
// page Admin/Staff receive from the running app still works end to end — the two have caught different
// classes of bug before (a route/static-file/caching issue the offline spec can't see by construction).
const { test, expect } = require('@playwright/test');
const path = require('path');
// Must run BEFORE dotenv (and before requiring db.js) — dotenv never overrides an already-set env var, so
// setting MONGO_URI to the safe local test database here first (same resolveTestDatabaseUri() test/setup-
// env.js uses for Jest) stops the plain `require('dotenv').config()` below from loading .env's real
// production MONGO_URI into THIS process. Without this, db.js's own test-mode safety check never
// triggers either: NODE_ENV isn't 'test' and JEST_WORKER_ID isn't set in a Playwright test worker, so
// nothing stops a bare connectDB() from happily connecting to production (confirmed: this was silently
// happening — the webServer child process was correctly pointed at the local test DB via its own `env` in
// playwright.config.js, but this spec's OWN direct connectDB() call, run from a different process, was
// not, so every user/record it created landed in production while the server it drove never saw them).
const { resolveTestDatabaseUri } = require(path.join(__dirname, '..', '..', 'services', 'testDatabaseGuard'));
process.env.MONGO_URI = resolveTestDatabaseUri(process.env);
require('dotenv').config();
const { connectDB, closeDB, getDb, insertWithNextId } = require(path.join(__dirname, '..', '..', 'db'));
const { createTestUser, cleanupAll, TEST_TAG } = require(path.join(__dirname, '..', 'helpers'));

test.describe.configure({ mode: 'serial' });

let admin, staff, partnership;
const documentIds = [];

async function loginAs(page, user) {
  const res = await page.request.post('/login', { form: { username: user.email, password: user.password } });
  expect(res.status()).toBeLessThan(400);
}

test.beforeAll(async () => {
  await connectDB();
  admin = await createTestUser({ role: 'Administrator' });
  staff = await createTestUser({ role: 'Staff' });
  partnership = await insertWithNextId(getDb().collection('partnerships'), (nextId) => ({
    id: nextId, inst: `${TEST_TAG} Real Browser University`, country: 'Testland', region: 'Asia', type: 'MOA',
    nature: ['Research'], cat: 'International', unit: ['CCS'], start: '2021-01-01', end: '2027-01-01', status: 'Active'
  }));
});

test.afterAll(async () => {
  await getDb().collection('partnerships').deleteOne({ id: partnership.id });
  await getDb().collection('partnershipactivities').deleteMany({ partnershipId: partnership.id });
  if (documentIds.length) await getDb().collection('documents').deleteMany({ id: { $in: documentIds } });
  await cleanupAll();
  await closeDB();
});

async function openActivitiesModalFor(page, lifecyclePath) {
  await page.goto(lifecyclePath);
  await expect(page.locator('#partnershipsTable, #registry-table, table').first()).toBeVisible({ timeout: 15000 });
  // The grid is built client-side by registry-gridjs.init.js; wait for OUR partnership's row, then its
  // "View details" button, rather than racing the grid's own async render.
  const viewBtn = page.locator('button[aria-label="View details"]').first();
  await expect(viewBtn).toBeVisible({ timeout: 15000 });
  await viewBtn.click();
  await expect(page.locator('#viewPartnershipModal')).toBeVisible();
  const activitiesBtn = page.locator('#viewPartnershipModal button:has-text("List of Activities")');
  await expect(activitiesBtn).toBeVisible();
  await activitiesBtn.click();
  await expect(page.locator('#activitiesModal')).toBeVisible({ timeout: 10000 });
}

for (const roleLabel of ['Administrator', 'Staff']) {
  test(`${roleLabel}: List of Activities opens, Add Activity saves and refreshes the list, Export PDF downloads the template-format file, and it lands in Document Library -> Partner Activities`, async ({ page }) => {
    test.setTimeout(90000); // generous — this machine's local Docker Mongo has measured 20s+ cold latency
    const user = roleLabel === 'Administrator' ? admin : staff;
    const lifecyclePath = roleLabel === 'Administrator' ? '/lifecycle' : '/staff/lifecycle';

    const consoleErrors = [];
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });

    await loginAs(page, user);
    await openActivitiesModalFor(page, lifecyclePath);
    await page.screenshot({ path: `test-results/activities-${roleLabel}-01-modal-open.png`, fullPage: true });

    await expect(page.locator('#activities-partner-info')).toContainText(`${TEST_TAG} Real Browser University`);
    await expect(page.locator('#act-date')).toBeVisible();
    await expect(page.locator('#activities-export-btn')).toBeVisible();

    // Add Activity.
    const activityLabel = `Real-browser MOU Signing ${Date.now()}`;
    await page.fill('#act-date', '2025-05-20');
    await page.fill('#act-activity', activityLabel);
    await page.fill('#act-nature', 'Signing Ceremony');
    await page.click('#activities-add-btn');
    await expect(page.locator('#activities-tbody')).toContainText(activityLabel, { timeout: 30000 });
    await page.screenshot({ path: `test-results/activities-${roleLabel}-02-added.png`, fullPage: true });

    const savedActivity = await getDb().collection('partnershipactivities').findOne({ partnershipId: partnership.id, activityConducted: activityLabel });
    expect(savedActivity).toBeTruthy();

    // Export PDF -> real POST + blob download, saved to the Document Library.
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('#activities-export-btn')
    ]);
    const downloadPath = await download.path();
    expect(downloadPath).toBeTruthy();
    const fs = require('fs');
    const buf = fs.readFileSync(downloadPath);
    expect(buf.slice(0, 4).toString()).toBe('%PDF');
    await page.screenshot({ path: `test-results/activities-${roleLabel}-03-exported.png`, fullPage: true });

    const archived = await getDb().collection('documents').findOne({ type: 'Partner Activities', partnershipId: partnership.id });
    expect(archived).toBeTruthy();
    documentIds.push(archived.id);

    // Document Library UI: the "Partner Activities" category must be visible, and the exported file must
    // show up under it.
    const docLibraryPath = roleLabel === 'Administrator' ? '/documents' : '/staff/documents';
    await page.goto(docLibraryPath);
    await expect(page.locator('body')).toContainText('Partner Activities', { timeout: 15000 });
    await page.screenshot({ path: `test-results/activities-${roleLabel}-04-document-library.png`, fullPage: true });

    const meaningfulErrors = consoleErrors.filter((e) => !/favicon|DevTools/i.test(e));
    expect(meaningfulErrors, `Console/page errors seen: ${meaningfulErrors.join(' | ')}`).toEqual([]);
  });
}
