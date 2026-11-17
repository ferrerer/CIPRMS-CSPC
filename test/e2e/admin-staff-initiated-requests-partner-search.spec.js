// Admin/Staff-Initiated Partnership Requests — searchable Target Partner field (2026-11 UI cleanup).
// Real-browser coverage (run with `npm run test:e2e`) for the custom combobox that replaced the plain
// <select id="pri-partner"> in the "Request Partnership" modal (views/administrator/partnership_requests.ejs):
// typing filters the GET /api/users/partner-options list by name, Enter/click selects a partner and fills
// the hidden #pri-partner-id, and submitting without a selection is blocked client-side. UI only — no
// endpoint, request logic, or targetPartnerId server-side validation changed by this task.
const { test, expect } = require('@playwright/test');
const path = require('path');
require('dotenv').config();
const { connectDB, closeDB, getDb } = require(path.join(__dirname, '..', '..', 'db'));
const { createTestUser, cleanupAll, TEST_TAG } = require(path.join(__dirname, '..', 'helpers'));

test.describe.configure({ mode: 'serial' });

let admin, partnerAlpha, partnerBeta;
const createdRequestIds = [];

async function loginAs(page, user) {
  const res = await page.request.post('/login', { form: { username: user.email, password: user.password } });
  expect(res.status()).toBeLessThan(400);
}

test.beforeAll(async () => {
  await connectDB();
  admin = await createTestUser({ role: 'Administrator' });
  partnerAlpha = await createTestUser({ role: 'potential_partner' });
  partnerBeta = await createTestUser({ role: 'potential_partner' });
  // Give them distinguishable, searchable names (createTestUser names everyone "<TEST_TAG> potential_partner").
  await getDb().collection('users').updateOne({ id: partnerAlpha.id }, { $set: { name: `${TEST_TAG} Alpha Partner ${Date.now()}` } });
  await getDb().collection('users').updateOne({ id: partnerBeta.id }, { $set: { name: `${TEST_TAG} Beta Partner ${Date.now()}` } });
  partnerAlpha.name = (await getDb().collection('users').findOne({ id: partnerAlpha.id })).name;
  partnerBeta.name = (await getDb().collection('users').findOne({ id: partnerBeta.id })).name;
});

test.afterAll(async () => {
  if (createdRequestIds.length) await getDb().collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  await cleanupAll();
  await closeDB();
});

async function openModal(page) {
  await page.goto('/partnership-requests');
  await page.click('#pr-initiate-btn');
  await expect(page.locator('#pr-initiate-modal')).toBeVisible();
}

test('typing filters the partner list by name, selecting fills the hidden id, and the "No partners found" state shows for a non-match', async ({ page }) => {
  await loginAs(page, admin);
  await openModal(page);

  const search = page.locator('#pri-partner-search');
  const dropdown = page.locator('#pri-partner-dropdown');

  await search.click();
  await expect(dropdown).toBeVisible();
  await expect(dropdown).toContainText(partnerAlpha.name);
  await expect(dropdown).toContainText(partnerBeta.name);

  await search.fill('Alpha Partner');
  await expect(dropdown).toContainText(partnerAlpha.name);
  await expect(dropdown).not.toContainText(partnerBeta.name);

  // Selecting a result fills the search box and the hidden targetPartnerId.
  await dropdown.locator('.pri-partner-option', { hasText: partnerAlpha.name }).click();
  await expect(search).toHaveValue(partnerAlpha.name);
  await expect(page.locator('#pri-partner-id')).toHaveValue(String(partnerAlpha.id));
  await expect(dropdown).toBeHidden();

  // Typing again (even without submitting) clears the stale selection.
  await search.fill('zzz-no-such-partner-zzz');
  await expect(dropdown).toContainText('No partners found');
  await expect(page.locator('#pri-partner-id')).toHaveValue('');
});

test('keyboard: ArrowDown highlights, Enter selects', async ({ page }) => {
  await loginAs(page, admin);
  await openModal(page);

  const search = page.locator('#pri-partner-search');
  await search.click();
  await expect(page.locator('#pri-partner-dropdown')).toBeVisible();
  await search.press('ArrowDown');
  await expect(page.locator('.pri-partner-option.is-active')).toHaveCount(1);
  await search.press('Enter');
  await expect(page.locator('#pri-partner-id')).not.toHaveValue('');
  await expect(page.locator('#pri-partner-dropdown')).toBeHidden();
});

test('Esc closes the dropdown without selecting', async ({ page }) => {
  await loginAs(page, admin);
  await openModal(page);
  const search = page.locator('#pri-partner-search');
  await search.click();
  await expect(page.locator('#pri-partner-dropdown')).toBeVisible();
  await search.press('Escape');
  await expect(page.locator('#pri-partner-dropdown')).toBeHidden();
});

test('submitting without selecting a partner is blocked — typed text alone is not enough', async ({ page }) => {
  await loginAs(page, admin);
  await openModal(page);

  await page.fill('#pri-partner-search', partnerAlpha.name); // typed, but never actually selected from the list
  await page.fill('#pri-inst', `${TEST_TAG} Unselected Partner Co`);
  await page.fill('#pri-country', 'Testland');
  await page.selectOption('#pri-type', 'MOA');
  await page.selectOption('#pri-nature', 'Research');
  await page.click('#pri-submit-btn');

  // Still open — the client blocked submission before any request call.
  await expect(page.locator('#pr-initiate-modal')).toBeVisible();
  const stray = await getDb().collection('requests').findOne({ institution: `${TEST_TAG} Unselected Partner Co` });
  expect(stray).toBeNull();
});

test('a real selection submits successfully and the new request is stored', async ({ page }) => {
  await loginAs(page, admin);
  await openModal(page);

  await page.fill('#pri-partner-search', 'Beta Partner');
  await page.click('#pri-partner-dropdown .pri-partner-option', { timeout: 5000 });
  await expect(page.locator('#pri-partner-id')).toHaveValue(String(partnerBeta.id));

  const institution = `${TEST_TAG} Searchable Combo University`;
  await page.fill('#pri-inst', institution);
  await page.fill('#pri-country', 'Testland');
  await page.selectOption('#pri-type', 'MOA');
  await page.selectOption('#pri-nature', 'Research');
  await page.click('#pri-submit-btn');

  await expect(page.locator('#pr-initiate-modal')).toBeHidden({ timeout: 10000 });
  const stored = await getDb().collection('requests').findOne({ institution });
  expect(stored).toBeTruthy();
  expect(stored.targetPartnerId).toBe(partnerBeta.id);
  createdRequestIds.push(stored.id);
});

test('dark mode: the dropdown is visible and themed, not invisible-on-invisible', async ({ page }) => {
  await loginAs(page, admin);
  await page.goto('/partnership-requests');
  await page.evaluate(() => document.documentElement.setAttribute('data-bs-theme', 'dark'));
  await page.click('#pr-initiate-btn');
  await expect(page.locator('#pr-initiate-modal')).toBeVisible();
  await page.click('#pri-partner-search');
  const dropdown = page.locator('#pri-partner-dropdown');
  await expect(dropdown).toBeVisible();
  const bg = await dropdown.evaluate(el => getComputedStyle(el).backgroundColor);
  // Dark theme's dropdown background (#2a2f3c) must differ from the light one (#fff) — proves the
  // [data-bs-theme="dark"] override actually applied, not just the light-mode default.
  expect(bg).not.toBe('rgb(255, 255, 255)');
});

test('mobile viewport: modal and combobox render without horizontal page scroll, and the tabs-row button still works', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await loginAs(page, admin);
  await page.goto('/partnership-requests');
  const hasHorizontalScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(hasHorizontalScroll).toBe(false);

  await page.click('#pr-initiate-btn');
  await expect(page.locator('#pr-initiate-modal')).toBeVisible();
  await page.click('#pri-partner-search');
  await expect(page.locator('#pri-partner-dropdown')).toBeVisible();
  const modalScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  expect(modalScroll).toBe(false);
});
