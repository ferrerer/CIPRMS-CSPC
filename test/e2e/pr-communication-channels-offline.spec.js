// Partnership Request Communication Channels (2026-11) — the two labeled sections in the draft modal:
// "Shared with Partner" (supportingDocuments, unchanged mechanics) and "Internal: Admin/Staff/LAU only"
// (lauReviews, now a two-way conversation — Administrator/Staff can post too, not just LAU). Real DOM
// check against the actual, unmodified EJS — no server, no real network. Server-side guard/scoping/
// notification routing is covered by test/lau-internal-review.test.js and
// test/communication-channels-and-email.test.js.
const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'views', 'administrator', 'partnership_requests.ejs');
const BOOTSTRAP_PATH = path.join(__dirname, '..', '..', 'assets', 'libs', 'bootstrap', 'js', 'bootstrap.bundle.min.js');
const BOOTSTRAP_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'css', 'bootstrap.min.css');

function renderPage(role) {
  const base = { user: { role, name: 'Test ' + role, email: role.toLowerCase() + '@test.com', id: 1 }, activePage: 'requests' };
  const locals = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !k.startsWith('_') && k !== 'constructor' ? '' : undefined))
  });
  return ejs.render(fs.readFileSync(TEMPLATE_PATH, 'utf8'), locals, { filename: TEMPLATE_PATH });
}

const FAKE_REQUEST = {
  id: 42, institution: 'jesttest Comms University', type: 'MOA', status: 'Pending',
  requestedBy: 'jesttest Partner', submittedByEmail: 'partner@test.com', date: 'Jan 1, 2026',
  attachmentLink: '', supportingDocuments: [
    { documentId: 1, fileLink: '/uploads/documents/1.png', originalFilename: 'shared.png', uploadedBy: 'jesttest Partner', uploaderRole: 'potential_partner', visibility: 'shared', uploadedAt: '2026-01-01T00:00:00.000Z', note: 'jesttest shared note' }
  ],
  lauReviews: [
    { documentId: 2, fileLink: '/uploads/documents/2.png', originalFilename: 'internal.png', submittedBy: 'jesttest LAU User', submittedByEmail: 'lau@test.com', authorRole: 'LAU', visibility: 'internal', submittedAt: '2026-01-02T00:00:00.000Z', note: 'jesttest internal note', status: 'Approve' },
    { documentId: null, fileLink: null, originalFilename: null, fileSize: 0, submittedBy: 'jesttest Admin', submittedByEmail: 'admin@test.com', authorRole: 'Administrator', visibility: 'internal', submittedAt: '2026-01-03T00:00:00.000Z', note: 'jesttest admin reply', status: null }
  ]
};

async function setup(page, role) {
  await page.setContent(renderPage(role));
  await page.addStyleTag({ path: BOOTSTRAP_CSS_PATH });
  await page.addScriptTag({ path: BOOTSTRAP_PATH });
  await page.evaluate((fakeRequest) => {
    window.CIPRMS = window.CIPRMS || {};
    window.CIPRMS.api = () => Promise.resolve({ ok: true, status: 200, data: { success: true } });
    prData = [fakeRequest];
  }, FAKE_REQUEST);
  await page.evaluate(() => openDraftModal('42'));
  await expect(page.locator('#pr-draft-modal')).toBeVisible();
}

test.describe('Partnership Request Communication Channels — two sections (partnership_requests.ejs)', () => {
  test('Administrator sees both sections, with the Internal entries author-labeled, and can post (status dropdown hidden)', async ({ page }) => {
    await setup(page, 'Administrator');

    // "Shared with Partner" section
    await expect(page.locator('#pr-draft-timeline')).toContainText('shared.png');

    // "Internal: Admin/Staff/LAU only" section — both entries visible, each labeled by author
    const lauList = page.locator('#pr-lau-review-list');
    await expect(lauList).toContainText('jesttest LAU User');
    await expect(lauList).toContainText('jesttest Admin');
    await expect(lauList.locator('.badge:has-text("LAU")')).toHaveCount(1);
    await expect(lauList.locator('.badge:has-text("Admin/Staff")')).toHaveCount(1);

    // The submit form is visible for Administrator (two-way), but the Approve/Not Approve verdict stays LAU-only.
    await expect(page.locator('#pr-lau-review-form')).toBeVisible();
    await expect(page.locator('#pr-lau-status-wrap')).toBeHidden();
  });

  test('LAU sees both sections too, with its own status dropdown visible', async ({ page }) => {
    await setup(page, 'LAU');
    await expect(page.locator('#pr-draft-timeline')).toContainText('shared.png');
    await expect(page.locator('#pr-lau-review-list')).toContainText('jesttest Admin');
    await expect(page.locator('#pr-lau-review-form')).toBeVisible();
    await expect(page.locator('#pr-lau-status-wrap')).toBeVisible();
  });

  test('Staff sees both sections, same as Administrator', async ({ page }) => {
    await setup(page, 'Staff');
    await expect(page.locator('#pr-lau-review-wrap')).toBeVisible();
    await expect(page.locator('#pr-lau-review-form')).toBeVisible();
    await expect(page.locator('#pr-lau-status-wrap')).toBeHidden();
  });
});
