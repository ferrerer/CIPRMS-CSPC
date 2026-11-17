// Partner "List of Activities" with PDF Export — OFFLINE variant.
//
// Renders the real EJS template (views/administrator/monitoring.ejs) and runs the real
// assets/js/pages/registry-gridjs.init.js via page.setContent() — no server, no login, no MongoDB — with
// window.CIPRMS.api, window.bootstrap and a minimal window.gridjs stub (gridjs.umd.js itself never loads
// here; nothing under test touches it beyond rendering the page's OTHER table, which this spec never reads)
// so it verifies the actual DOM/JS for: opening the modal (swapped in from View Details, never stacked),
// adding an activity, and triggering a PDF export. Run with:
//   npx playwright test --config=playwright.offline.config.js test/e2e/partner-activities-offline.spec.js
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

const BOOTSTRAP_CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'css', 'bootstrap.min.css'), 'utf8');
const BOOTSTRAP_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'libs', 'bootstrap', 'js', 'bootstrap.bundle.min.js'), 'utf8');
// registry-gridjs.init.js is an external <script src> in the page — never resolves here (no server), so
// the real file's own code (openViewModal, openActivitiesModal, the whole Activities feature under test)
// is inlined directly rather than reimplemented.
const REGISTRY_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'js', 'pages', 'registry-gridjs.init.js'), 'utf8');

// A literal "</script" anywhere inside embedded source text ends the HTML parser's <script> element right
// there (regardless of JS string/comment context) — splits the inlined code in two and the back half fails
// to parse. Escaping it is purely an HTML-embedding concern, harmless to the JS itself once parsed.
function forInlineScript(src) { return src.replace(/<\/script/gi, '<\\/script'); }

const SAMPLE_PARTNERSHIP = {
  id: 301, inst: 'Zeta Activities University', country: 'Vietnam', region: 'Asia', type: 'MOA',
  nature: ['Research'], cat: 'International', unit: ['CCS'], start: '2021-01-01', end: '2026-01-01',
  status: 'Active', days: 100
};

function renderMonitoringPage() {
  const file = path.join(__dirname, '..', '..', 'views', 'administrator', 'monitoring.ejs');
  let html = ejs.render(fs.readFileSync(file, 'utf8'), {
    user: { role: 'Administrator', name: 'Test Admin', email: 'admin@test.com' },
    activePage: 'lifecycle'
  }, { filename: file });
  const stub = `<style>${BOOTSTRAP_CSS}</style><script>${forInlineScript(BOOTSTRAP_JS)}</script><script>
    window.__apiCalls = [];
    window.__fetchCalls = [];
    window.fetch = function (url, opts) {
      window.__fetchCalls.push({ url: url, opts: opts });
      return Promise.resolve({ ok: true, blob: function () { return Promise.resolve(new Blob(['%PDF-fake'], { type: 'application/pdf' })); } });
    };
    window.URL.createObjectURL = function () { return 'blob:fake'; };
    window.URL.revokeObjectURL = function () {};
    // country-options.js never loads here (no server) — registry-gridjs.init.js references this global
    // directly in a couple of guarded spots unrelated to what this spec checks.
    window.COUNTRY_OPTIONS = ['Vietnam', 'Japan', 'Philippines', 'Testland'];
    // responsible-units.js never loads here either, same reasoning.
    window.UNIT_OPTIONS = ['CCS', 'CILS', 'CETE', 'CNAS', 'CAMS', 'CIRL'];
    // gridjs.umd.js never loads here (no server) — this page's own registry table is unrelated to what
    // this spec checks, so a minimal stand-in that never throws is enough.
    window.gridjs = {
      html: function (s) { return s; },
      Grid: function () {
        var self = this;
        self.render = function () { return self; };
        self.updateConfig = function () { return self; };
        self.forceRender = function () {};
        return self;
      }
    };
    window.CIPRMS = {
      api: function (url, opts) {
        window.__apiCalls.push({ url: url, opts: opts });
        if (url === '/api/partnerships') return Promise.resolve({ ok: true, data: [${JSON.stringify(SAMPLE_PARTNERSHIP)}] });
        if (/\\/activities$/.test(url) && (!opts || !opts.method)) {
          return Promise.resolve({ ok: true, data: { activities: window.__seedActivities || [] } });
        }
        if (/\\/activities$/.test(url) && opts && opts.method === 'POST') {
          return Promise.resolve({ ok: true, data: { activity: Object.assign({ id: 999, partnershipId: 301, createdBy: 'Test Admin' }, opts.json) } });
        }
        return Promise.resolve({ ok: true, data: [] });
      },
      busy: function (btn, fn) { return fn(); }
    };
  </script>`;
  html = html.replace('<head>', '<head>' + stub);
  html = html.replace(
    '<script src="/velzon/assets/js/pages/registry-gridjs.init.js"></script>',
    `<script>${forInlineScript(REGISTRY_JS)}</script>`
  );
  return html;
}

test('View Details -> List of Activities opens the separate Activities modal (swapped, not stacked)', async ({ page }) => {
  await page.setContent(renderMonitoringPage(), { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray(window.partnerships) && window.partnerships.length > 0);
  await page.evaluate(() => window.openViewModal(301));
  await expect(page.locator('#viewPartnershipModal')).toBeVisible();

  await page.click('#viewPartnershipModal button:has-text("List of Activities")');
  await expect(page.locator('#activitiesModal')).toBeVisible();
  await expect(page.locator('#viewPartnershipModal')).toBeHidden();
  await expect(page.locator('.modal-backdrop')).toHaveCount(1);
  await expect(page.locator('#activities-partner-info')).toContainText('Zeta Activities University');
  await expect(page.locator('#activities-partner-info')).toContainText('Vietnam');
});

test('adding an activity appends it to the table', async ({ page }) => {
  await page.setContent(renderMonitoringPage(), { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray(window.partnerships) && window.partnerships.length > 0);
  await page.evaluate(() => window.openActivitiesModal(301));
  await expect(page.locator('#activitiesModal')).toBeVisible();

  await page.fill('#act-date', '2025-06-15');
  await page.fill('#act-activity', 'Conducted MOU Signing');
  await page.fill('#act-nature', 'Signing Ceremony');
  await page.click('#activities-add-btn');

  const tbody = page.locator('#activities-tbody');
  await expect(tbody).toContainText('Conducted MOU Signing');
  await expect(tbody).toContainText('Signing Ceremony');
  await expect(page.locator('#activities-empty')).toBeHidden();

  const addCalls = await page.evaluate(() => window.__apiCalls.filter(c => c.opts && c.opts.method === 'POST'));
  expect(addCalls.length).toBe(1);
  expect(addCalls[0].opts.json.activityConducted).toBe('Conducted MOU Signing');
});

test('incomplete entry is rejected client-side before any API call', async ({ page }) => {
  await page.setContent(renderMonitoringPage(), { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray(window.partnerships) && window.partnerships.length > 0);
  await page.evaluate(() => window.openActivitiesModal(301));
  await page.fill('#act-activity', 'Missing date and nature');
  await page.click('#activities-add-btn');
  await expect(page.locator('#activities-add-error')).toBeVisible();
  const postCalls = await page.evaluate(() => window.__apiCalls.filter(c => c.opts && c.opts.method === 'POST'));
  expect(postCalls.length).toBe(0);
});

test('"Export PDF" POSTs to the export endpoint for the current partnership and triggers a download', async ({ page }) => {
  await page.setContent(renderMonitoringPage(), { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray(window.partnerships) && window.partnerships.length > 0);
  await page.evaluate(() => window.openActivitiesModal(301));
  await page.click('#activities-export-btn');
  await page.waitForFunction(() => window.__fetchCalls.some(c => /activities\/export$/.test(c.url)));
  const calls = await page.evaluate(() => window.__fetchCalls.filter(c => /activities\/export$/.test(c.url)));
  expect(calls.length).toBe(1);
  expect(calls[0].url).toBe('/api/partnerships/301/activities/export');
  expect(calls[0].opts.method).toBe('POST');
});

test('"Back to Details" returns to View Details, and closing Activities normally does not reopen it', async ({ page }) => {
  await page.setContent(renderMonitoringPage(), { waitUntil: 'load' });
  await page.waitForFunction(() => Array.isArray(window.partnerships) && window.partnerships.length > 0);
  await page.evaluate(() => window.openViewModal(301));
  await page.click('#viewPartnershipModal button:has-text("List of Activities")');
  await expect(page.locator('#activitiesModal')).toBeVisible();

  await page.click('#activitiesModal .modal-footer button:has-text("Back to Details")');
  await expect(page.locator('#viewPartnershipModal')).toBeVisible();
  await expect(page.locator('#activitiesModal')).toBeHidden();
  await expect(page.locator('.modal-backdrop')).toHaveCount(1);

  await page.click('#viewPartnershipModal button:has-text("List of Activities")');
  await expect(page.locator('#activitiesModal')).toBeVisible();
  await page.click('#activitiesModal .modal-footer button:has-text("Close")');
  await expect(page.locator('#activitiesModal')).toBeHidden();
  await expect(page.locator('#viewPartnershipModal')).toBeHidden();
  await expect(page.locator('.modal-backdrop')).toHaveCount(0);
});
