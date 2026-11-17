// Password-management UI removal (2026-11) — real-browser coverage (run with `npm run test:e2e`, see
// playwright.config.js). Confirms, across every applicable role and at both a desktop and a mobile
// viewport, that the Change Password section is gone from Settings and that Add/Edit User no longer
// collects a password — matching the Jest/Supertest-level HTML assertions in test/profile-rename.test.js,
// test/partner-requests-cleanup.test.js and test/personnel-restrictions.test.js, but exercised here through
// a real rendered page (layout, tab switching, modal visibility) rather than raw HTML text.
const { test, expect } = require('@playwright/test');
const path = require('path');
// Must run before dotenv/db.js (2026-11 data-safety fix) — see partner-activities-real.spec.js's own
// comment on this exact pattern for why: without it, this file's direct connectDB() call was silently
// connecting to production instead of the local test DB the webServer child process actually uses.
const { resolveTestDatabaseUri } = require(path.join(__dirname, '..', '..', 'services', 'testDatabaseGuard'));
process.env.MONGO_URI = resolveTestDatabaseUri(process.env);
require('dotenv').config();
const { connectDB, closeDB, getDb } = require(path.join(__dirname, '..', '..', 'db'));
const { createTestUser, cleanupAll, uniqueEmail, TEST_TAG } = require(path.join(__dirname, '..', 'helpers'));

test.describe.configure({ mode: 'serial' });

let admin, staff, dean, partner;
const DESKTOP = { width: 1280, height: 800 };
const MOBILE = { width: 390, height: 844 };

async function loginAs(page, user) {
  const res = await page.request.post('/login', { form: { username: user.email, password: user.password } });
  expect(res.status()).toBeLessThan(400);
}

test.beforeAll(async () => {
  await connectDB();
  admin = await createTestUser({ role: 'Administrator' });
  staff = await createTestUser({ role: 'Staff' });
  dean = await createTestUser({ role: 'Auth. Personnel' });
  partner = await createTestUser({ role: 'potential_partner' });
});

test.afterAll(async () => {
  await cleanupAll();
  await closeDB();
});

const SETTINGS_PAGES = [
  ['Administrator', () => admin, '/admin/settings'],
  ['CIRL Staff', () => staff, '/staff/settings'],
  ['College Dean', () => dean, '/personnel/settings'],
  ['Partner', () => partner, '/partner/settings']
];

for (const viewportLabel of ['desktop', 'mobile']) {
  const viewport = viewportLabel === 'desktop' ? DESKTOP : MOBILE;

  test.describe(`Settings pages — no Change Password section (${viewportLabel})`, () => {
    test.use({ viewport });

    for (const [label, getUser, path_] of SETTINGS_PAGES) {
      test(`${label}: ${path_} has no Change Password tab, no password fields, and the kept tabs still work`, async ({ page }) => {
        await loginAs(page, getUser());
        await page.goto(path_);
        await expect(page.getByText('Change Password', { exact: true })).toHaveCount(0);
        expect(await page.locator('#tab-password').count()).toBe(0);
        expect(await page.locator('input[type="password"]').count()).toBe(0);

        // The page's other tab(s) must still be intact and clickable — removal must not have broken layout.
        const personalTab = page.locator('a[href="#tab-personal"], a[href="#tab-profile"]');
        await expect(personalTab).toBeVisible();
        await personalTab.click();
        await expect(page.locator('#tab-personal, #tab-profile')).toBeVisible();

        // No horizontal scroll from a leftover wide element where the password tab used to sit — measured
        // on the tab/card chrome itself, not the whole document: the Partner card's #display-email span has
        // a pre-existing, unrelated overflow-wrap gap that only a very long address (like this fixture's
        // long jesttest.* email) trips, nothing to do with removing the password tab.
        const hasOverflow = await page.locator('.nav-tabs-custom').first().evaluate(
          el => el.scrollWidth > el.clientWidth + 1
        );
        expect(hasOverflow).toBe(false);
      });
    }
  });
}

for (const viewportLabel of ['desktop', 'mobile']) {
  const viewport = viewportLabel === 'desktop' ? DESKTOP : MOBILE;

  test.describe(`User Management — Add/Edit User has no password field (${viewportLabel})`, () => {
    test.use({ viewport });

    test(`Add New User opens with no password field, and a user can be created without one (${viewportLabel})`, async ({ page }) => {
      await loginAs(page, admin);
      await page.goto('/users');
      await page.click('[onclick="openAddUser()"]');
      await expect(page.locator('#usr-modal')).toBeVisible();
      expect(await page.locator('#u-password').count()).toBe(0);
      expect(await page.locator('#usr-modal input[type="password"]').count()).toBe(0);

      const email = uniqueEmail('e2enopwd');
      await page.fill('#u-name', `${TEST_TAG} E2E No Password`);
      await page.fill('#u-email', email);
      await page.click('#usr-modal button:has-text("Save")');
      await expect(page.locator('#usr-modal')).toBeHidden();

      const created = await getDb().collection('users').findOne({ email });
      expect(created).toBeTruthy();
      expect(typeof created.password).toBe('string'); // server auto-generated a throwaway hash; never user-entered
      await getDb().collection('users').deleteOne({ email });
    });

    test(`Edit User opens with no password field, and saving an edit never touches the stored credential (${viewportLabel})`, async ({ page }) => {
      const target = await createTestUser({ role: 'Staff' });
      const before = await getDb().collection('users').findOne({ id: target.id });

      await loginAs(page, admin);
      await page.goto('/users');
      await page.fill('#usr-filter-email', target.email);
      await page.click(`[onclick="openEditUser(${target.id})"]`);
      await expect(page.locator('#usr-modal')).toBeVisible();
      expect(await page.locator('#u-password').count()).toBe(0);

      await page.fill('#u-name', `${TEST_TAG} E2E Edited`);
      await page.click('#usr-modal button:has-text("Save")');
      await expect(page.locator('#usr-modal')).toBeHidden();

      const after = await getDb().collection('users').findOne({ id: target.id });
      expect(after.password).toBe(before.password);
    });
  });
}
