// Yearly Target dashboard card (2026-11, "Decision Support & Insights" — replaces "Expansion
// Opportunity"). Real DOM check against the actual, unmodified views/administrator/admin_dashboard.ejs
// — no server, no real network: window.CIPRMS.api is stubbed so this proves the CLIENT behavior
// (which endpoint+payload Set/Edit Target and Get AI suggestion send) independent of whatever the
// server actually returns. Server-side behavior is covered by test/yearly-target-card.test.js.
const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'views', 'administrator', 'admin_dashboard.ejs');
const BOOTSTRAP_PATH = path.join(__dirname, '..', '..', 'assets', 'libs', 'bootstrap', 'js', 'bootstrap.bundle.min.js');
// Loaded in addition to the JS bundle (unlike the other offline specs this one is modeled on) — this
// suite asserts on real CSS-driven visibility (Bootstrap's .d-none utility, and a modal's .show state),
// which page.setContent()'s <link> tags never resolve without a running server.
const BOOTSTRAP_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'css', 'bootstrap.min.css');

function renderPage(overrides = {}) {
  const base = {
    user: { role: 'Administrator', name: 'Test Admin', email: 'admin@test.com' }, activePage: 'dashboard',
    dashActive: 1, dashExpiring: 1, dashExpired: 1, dashTotal: 3, activePartnerships: [],
    insightRenewal: 'x', insightOptimization: 'y',
    yearlyTargetYear: 2026, yearlyTarget: null, yearlyTargetProgress: null, yearlyTargetStatus: null, yearlyTargetDays: null,
    ...overrides
  };
  // get-only Proxy (no `has` trap) — see test/e2e/duplicate-warning-modal-offline.spec.js's identical
  // note: a `has` trap that always returns true breaks EJS's own internal __append/with() machinery.
  const locals = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !k.startsWith('_') && k !== 'constructor' ? '' : undefined))
  });
  const html = ejs.render(fs.readFileSync(TEMPLATE_PATH, 'utf8'), locals, { filename: TEMPLATE_PATH });
  // The map widget's leaflet/maplibre <script> tags, and the footer's `document.write(currentYear)`,
  // are irrelevant to the Yearly Target card and actively hostile to an offline render: under
  // page.setContent() (unlike a real streamed page load), a document.write() call — even this
  // trivial one — can throw and leave the document in a state that later navigates to about:blank,
  // destroying every stub this suite injected. Stripped from the rendered string only (the real
  // template file is never touched).
  return html
    .replace(/<(script|link)[^>]*unpkg\.com[^>]*>(<\/script>)?/g, '')
    .replace(/<script>document\.write\(new Date\(\)\.getFullYear\(\)\)<\/script>/, new Date().getFullYear());
}

// Stubs window.CIPRMS.api AFTER the page's own inline scripts have already run once — page.setContent
// has no equivalent of addInitScript that reliably fires before a setContent-created document's own
// inline scripts run (see esign-modal-offline.spec.js's identical note). Harmless here: nothing this
// suite does depends on the page's own startup data fetches succeeding.
async function setup(page, overrides) {
  await page.setContent(renderPage(overrides));
  await page.addStyleTag({ path: BOOTSTRAP_CSS_PATH });
  await page.addScriptTag({ path: BOOTSTRAP_PATH });
  await page.evaluate(() => {
    window.__apiCalls = [];
    window.__apiResponder = () => ({ ok: true, status: 200, data: [] });
    window.CIPRMS = window.CIPRMS || {};
    window.CIPRMS.api = (url, opts) => {
      window.__apiCalls.push({ url: url, method: (opts && opts.method) || 'GET', json: opts && opts.json });
      return Promise.resolve(window.__apiResponder(url, opts));
    };
    window.CIPRMS.toast = () => {};
  });
}

// On a successful save, saveTargetModal() calls location.reload() — which this offline page (loaded
// via page.setContent(), with no real URL) cannot survive: Location.prototype.reload cannot be
// stubbed (it is non-writable), so the real call fires and navigates the page to about:blank,
// destroying every injected stub before this suite can inspect what was sent. Used only for the two
// "save succeeds" tests below: the mocked response records the call into __apiCalls (synchronously,
// before any reload could happen) and then never resolves, so saveTargetModal()'s .then() — and the
// reload() inside it — is simply never reached.
async function stubApiNeverResolving(page) {
  await page.evaluate(() => {
    window.CIPRMS.api = (url, opts) => {
      window.__apiCalls.push({ url: url, method: (opts && opts.method) || 'GET', json: opts && opts.json });
      return new Promise(() => {});
    };
  });
}

// Sets a form field's value directly via the DOM rather than Playwright's fill() — the latter was
// found to hang indefinitely on a <textarea> inside one of this page's several simultaneously-present
// Bootstrap modals (none of them are actually display:none here, since this offline render never
// loads Bootstrap's CSS, only its JS). The app's own JS only ever reads .value, so this is equivalent
// for what this suite verifies and sidesteps Playwright's actionability engine entirely.
async function setValue(page, selector, value) {
  await page.evaluate(({ selector, value }) => {
    const el = document.querySelector(selector);
    el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, { selector, value });
}

test.describe('Yearly Target card (admin_dashboard.ejs)', () => {
  test('no target set: shows "No target set" and only a Set Target button', async ({ page }) => {
    await setup(page);
    await expect(page.locator('#yearly-target-card')).toContainText('No target set for 2026');
    await expect(page.locator('#yearly-target-card')).toContainText('Set Target');
    await expect(page.locator('#yearly-target-card')).not.toContainText('Edit Target');
  });

  test('a target in progress shows the progress bar, status badge and Get AI suggestion link', async ({ page }) => {
    await setup(page, {
      yearlyTarget: { id: 7, targetCount: 20, notes: 'jesttest note' },
      yearlyTargetProgress: { current: 6, lacking: 14, percentage: 30, rawPercentage: 30 },
      yearlyTargetStatus: 'Behind pace', yearlyTargetDays: 42
    });
    const card = page.locator('#yearly-target-card');
    await expect(card).toContainText('6 of 20 new partnerships');
    await expect(card).toContainText('Behind pace');
    await expect(card).toContainText('Edit Target');
    await expect(card).toContainText('Get AI suggestion');
    await expect(page.locator('.progress-bar')).toHaveAttribute('style', /width:\s*30%/);
  });

  test('Set Target: opening the modal with no target pre-fills the current year and an empty count, and POSTs a new target', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => { openTargetModal(); });
    await expect(page.locator('#target-modal-title')).toHaveText('Set Yearly Target');
    await expect(page.locator('#target-modal-year')).toHaveValue('2026');
    await expect(page.locator('#target-modal-count')).toHaveValue('');

    await setValue(page, '#target-modal-count', '25');
    await setValue(page, '#target-modal-notes', 'jesttest focus on CBA');
    await stubApiNeverResolving(page);
    await page.locator('#target-modal-save-btn').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'POST' && c.url === '/api/targets'));

    const call = await page.evaluate(() => window.__apiCalls.find((c) => c.method === 'POST' && c.url === '/api/targets'));
    expect(call.json).toEqual({ type: 'yearly', year: 2026, targetCount: 25, notes: 'jesttest focus on CBA' });
  });

  test('Edit Target: opening the modal with an existing target pre-fills its values, and PATCHes by id', async ({ page }) => {
    await setup(page, {
      yearlyTarget: { id: 7, targetCount: 20, notes: 'jesttest note' },
      yearlyTargetProgress: { current: 6, lacking: 14, percentage: 30, rawPercentage: 30 },
      yearlyTargetStatus: 'Behind pace', yearlyTargetDays: 42
    });
    await page.evaluate(() => { openTargetModal(); });
    await expect(page.locator('#target-modal-title')).toHaveText('Edit Yearly Target');
    await expect(page.locator('#target-modal-count')).toHaveValue('20');
    await expect(page.locator('#target-modal-notes')).toHaveValue('jesttest note');

    await setValue(page, '#target-modal-count', '30');
    await stubApiNeverResolving(page);
    await page.locator('#target-modal-save-btn').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'PATCH' && c.url === '/api/targets/7'));

    const call = await page.evaluate(() => window.__apiCalls.find((c) => c.method === 'PATCH' && c.url === '/api/targets/7'));
    expect(call.json.targetCount).toBe(30);
  });

  test('Save shows a server error (e.g. a duplicate year) without closing the modal', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.__apiResponder = () => ({ ok: false, status: 409, data: { error: 'A target for this period already exists.' } });
    });
    await page.evaluate(() => { openTargetModal(); });
    await setValue(page, '#target-modal-count', '5');
    await page.locator('#target-modal-save-btn').click();
    await expect(page.locator('#target-modal-error')).toBeVisible();
    await expect(page.locator('#target-modal-error')).toContainText('A target for this period already exists.');
    await expect(page.locator('#target-modal')).toBeVisible();
  });

  test('Get AI suggestion: a successful response shows the suggestion and hides the link; aiBlocked hides the link with nothing shown', async ({ page }) => {
    await setup(page, {
      yearlyTarget: { id: 7, targetCount: 20, notes: '' },
      yearlyTargetProgress: { current: 6, lacking: 14, percentage: 30, rawPercentage: 30 },
      yearlyTargetStatus: 'Behind pace', yearlyTargetDays: 42
    });
    await page.evaluate(() => {
      window.__apiResponder = (url) => url === '/api/targets/7/ai-suggestion'
        ? { ok: true, status: 200, data: { suggestion: 'Focus outreach on CBA to close the gap before year end.' } }
        : { ok: true, status: 200, data: [] };
    });
    await page.locator('#yearly-target-ai-btn').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'POST' && c.url === '/api/targets/7/ai-suggestion'));
    await expect(page.locator('#yearly-target-ai-suggestion')).toBeVisible();
    await expect(page.locator('#yearly-target-ai-suggestion')).toContainText('Focus outreach on CBA');
    await expect(page.locator('#yearly-target-ai-btn')).toBeHidden();
  });

  test('Get AI suggestion: an aiBlocked response hides the link and shows no suggestion text (card still works without AI)', async ({ page }) => {
    await setup(page, {
      yearlyTarget: { id: 7, targetCount: 20, notes: '' },
      yearlyTargetProgress: { current: 6, lacking: 14, percentage: 30, rawPercentage: 30 },
      yearlyTargetStatus: 'Behind pace', yearlyTargetDays: 42
    });
    await page.evaluate(() => {
      window.__apiResponder = (url) => url === '/api/targets/7/ai-suggestion'
        ? { ok: true, status: 200, data: { aiBlocked: true, reason: 'Pending institutional data-sharing approval' } }
        : { ok: true, status: 200, data: [] };
    });
    await page.locator('#yearly-target-ai-btn').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'POST' && c.url === '/api/targets/7/ai-suggestion'));
    await expect(page.locator('#yearly-target-ai-btn')).toBeHidden();
    await expect(page.locator('#yearly-target-ai-suggestion')).toBeHidden();
  });
});
