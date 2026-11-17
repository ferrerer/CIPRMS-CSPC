// Lifecycle stored-XSS regression (2026-11 Phase 1 security remediation, run with `npm run test:e2e`, see
// playwright.config.js). Root cause: assets/js/pages/lifecycle-gridjs.init.js built renderUrgentList(),
// renderDssAlerts() and openViewModal() by string-concatenating partnership fields (inst/type/cat/start/
// end) straight into .innerHTML, with zero escaping anywhere in the file — unlike the sibling
// registry-gridjs.init.js, which already escaped the identical data. inst has no character restriction at
// all server-side (sanitizePartnershipFields only requires non-empty), and start/end are validated only as
// non-empty strings, never as real dates, so any of them could carry a real payload.
//
// This spec exercises the REAL, unmodified page functions against a REAL DOM in a real browser — not a
// source-text check for escapeHtml() — by driving them directly with controlled test data instead of via
// the real create-partnership API. Two of the audited fields (type, cat) are enum-validated server-side
// (VALID_PARTNERSHIP_TYPES/VALID_PARTNERSHIP_CATEGORIES) and genuinely cannot carry a payload through that
// API today, but the brief is explicit that rendering must not assume validation holds (defense in depth —
// a legacy row, a future relaxed enum, or any other write path could still produce one), so they are
// exercised the same way as inst/start/end. These are plain global functions/variables with no module
// system (same technique partnerships itself is populated by after the real fetch('/api/partnerships')),
// so overwriting `partnerships` and re-invoking the real render functions runs the exact same code a real
// visitor's browser runs, just with a deterministic fixture instead of whatever is currently in the shared
// dev database — avoiding any dependency on sort-order among other real records.
const { test, expect } = require('@playwright/test');
const path = require('path');
// Must run before dotenv/db.js (2026-11 data-safety fix) — see partner-activities-real.spec.js's own
// comment on this exact pattern for why: without it, this file's direct connectDB() call was silently
// connecting to production instead of the local test DB the webServer child process actually uses.
const { resolveTestDatabaseUri } = require(path.join(__dirname, '..', '..', 'services', 'testDatabaseGuard'));
process.env.MONGO_URI = resolveTestDatabaseUri(process.env);
require('dotenv').config();
const { connectDB, closeDB } = require(path.join(__dirname, '..', '..', 'db'));
const { createTestUser, cleanupAll } = require(path.join(__dirname, '..', 'helpers'));

test.describe.configure({ mode: 'serial' });

let admin;

async function loginAs(page, user) {
  const res = await page.request.post('/login', { form: { username: user.email, password: user.password } });
  expect(res.status()).toBeLessThan(400);
}

test.beforeAll(async () => {
  await connectDB();
  admin = await createTestUser({ role: 'Administrator' });
});

test.afterAll(async () => {
  await cleanupAll();
  await closeDB();
});

// window.__xssFired is set by every payload's event handler — the single, unambiguous signal that an
// injected attribute/element was actually created and actually ran, as opposed to rendering as inert text.
const MARK = 'window.__xssFired = (window.__xssFired || []).concat([TAG])';
function payload(tag) {
  return `<img src=x onerror="${MARK.replace('TAG', `'${tag}'`)}">${tag}-MARKER`;
}

const MALICIOUS = {
  id: 999001,
  inst: payload('INST'),
  type: payload('TYPE'),
  cat: payload('CAT'),
  start: payload('START'),
  end: payload('END'),
  status: 'Expired',
  days: -5
};

// A second, more realistic fixture: no tags, just the characters escaping must get right in both
// directions — present legitimate data must still read correctly, not literally show "&amp;" etc.
const SPECIAL_CHARS = {
  id: 999002,
  inst: 'Smith & Jones "International" <Partners> Institute',
  type: 'MOA',
  cat: 'International',
  start: 'Jan 1, 2026',
  end: 'Dec 31, 2026',
  status: 'Active',
  days: 400
};

test.describe('Lifecycle page — stored XSS is neutralized in Urgent List, DSS Alerts, and the View modal', () => {
  test('renderUrgentList(): malicious fields render as inert text, no injected element/handler ever executes', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/personnel/lifecycle');
    await page.waitForFunction(() => typeof renderUrgentList === 'function' && typeof partnerships !== 'undefined');

    await page.evaluate((fixture) => {
      window.__xssFired = [];
      partnerships = [fixture];
      renderUrgentList();
    }, MALICIOUS);

    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toEqual([]); // no onerror handler from inst or type ever ran

    const html = await page.locator('#urgent-list').innerHTML();
    expect(html).not.toContain('<img'); // the payload's <img> tag itself was never parsed as an element
    expect(await page.locator('#urgent-list img').count()).toBe(0);
    const text = await page.locator('#urgent-list').innerText();
    expect(text).toContain('INST-MARKER'); // the text content is still readable, just inert
    expect(text).toContain('TYPE-MARKER');
  });

  test('renderDssAlerts(): the same two text blocks (Action Required / Review Suggested) are safe for both inst and type', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/personnel/lifecycle');
    await page.waitForFunction(() => typeof renderDssAlerts === 'function' && typeof partnerships !== 'undefined');

    // Expiring Soon drives the "Action Required" block; Expired drives "Review Suggested" — both use inst/type.
    const expiringSoonFixture = { ...MALICIOUS, id: 999003, status: 'Expiring Soon', days: 3 };
    await page.evaluate(([a, b]) => {
      window.__xssFired = [];
      partnerships = [a, b];
      renderDssAlerts();
    }, [expiringSoonFixture, MALICIOUS]);

    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toEqual([]);

    const actionHtml = await page.locator('#dss-action-text').innerHTML();
    const reviewHtml = await page.locator('#dss-review-text').innerHTML();
    expect(actionHtml).not.toContain('<img');
    expect(reviewHtml).not.toContain('<img');
    expect(await page.locator('#dss-action-text img, #dss-review-text img').count()).toBe(0);
    const actionText = await page.locator('#dss-action-text').innerText();
    const reviewText = await page.locator('#dss-review-text').innerText();
    expect(actionText).toContain('INST-MARKER');
    expect(reviewText).toContain('INST-MARKER');
  });

  test('openViewModal(): every field in the modal (institution, type badge, category, status badge, start, end) is safe', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/personnel/lifecycle');
    await page.waitForFunction(() => typeof openViewModal === 'function' && typeof partnerships !== 'undefined');

    await page.evaluate((fixture) => {
      window.__xssFired = [];
      partnerships = [fixture];
      openViewModal(fixture.id);
    }, MALICIOUS);

    await expect(page.locator('#viewPartnershipModal')).toBeVisible();
    const fired = await page.evaluate(() => window.__xssFired);
    expect(fired).toEqual([]); // inst, type (via typeBadgeHtml), cat, start, end all failed to execute anything

    const bodyHtml = await page.locator('#view-body').innerHTML();
    expect(bodyHtml).not.toContain('<img');
    expect(await page.locator('#view-body img, #view-body svg').count()).toBe(0);
    const bodyText = await page.locator('#view-body').innerText();
    for (const marker of ['INST-MARKER', 'TYPE-MARKER', 'CAT-MARKER', 'START-MARKER', 'END-MARKER']) {
      expect(bodyText).toContain(marker);
    }
  });

  test('legitimate special characters (&, <, >, ", \') still render correctly, not double-escaped or garbled', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/personnel/lifecycle');
    await page.waitForFunction(() => typeof openViewModal === 'function' && typeof partnerships !== 'undefined');

    await page.evaluate((fixture) => {
      partnerships = [fixture];
      openViewModal(fixture.id);
    }, SPECIAL_CHARS);

    await expect(page.locator('#viewPartnershipModal')).toBeVisible();
    const instText = await page.locator('#view-body').innerText();
    // The real characters are what's visible — never literal "&amp;" or "&lt;" entity text.
    expect(instText).toContain('Smith & Jones "International" <Partners> Institute');
    expect(instText).not.toContain('&amp;');
    expect(instText).not.toContain('&lt;');
  });

  test('Urgent List also renders the same special-character institution name correctly', async ({ page }) => {
    await loginAs(page, admin);
    await page.goto('/personnel/lifecycle');
    await page.waitForFunction(() => typeof renderUrgentList === 'function' && typeof partnerships !== 'undefined');

    const urgentSpecial = { ...SPECIAL_CHARS, status: 'Expiring Soon', days: 10 };
    await page.evaluate((fixture) => {
      partnerships = [fixture];
      renderUrgentList();
    }, urgentSpecial);

    const text = await page.locator('#urgent-list').innerText();
    expect(text).toContain('Smith & Jones "International" <Partners> Institute');
    expect(text).not.toContain('&amp;');
  });
});
