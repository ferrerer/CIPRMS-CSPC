// Head of CIRL E-Signature modal (2026-11, "Add E-Sign" on the Document Requests tab). Real DOM check
// against the actual, unmodified views/administrator/partnership_requests.ejs — no server, no real
// network: window.CIPRMS.api is stubbed so this proves the CLIENT behavior (upload/draw/remove wiring,
// and which endpoint+payload each button sends) independent of whatever the server actually returns.
// Server-side behavior itself is covered by test/document-signature.test.js (Jest/supertest).
const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'views', 'administrator', 'partnership_requests.ejs');
const BOOTSTRAP_PATH = path.join(__dirname, '..', '..', 'assets', 'libs', 'bootstrap', 'js', 'bootstrap.bundle.min.js');

// A real, valid, decodable 1x1 PNG — a broken/invalid image collapses to a zero-size box in Chromium,
// which fails Playwright's toBeVisible() (it requires a non-empty bounding box), so the data: URIs and
// uploaded file bytes below must decode to an actual image, not just start with the PNG signature.
const VALID_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const VALID_PNG_BYTES = Buffer.from(VALID_PNG_BASE64, 'base64');

function renderPage() {
  const base = { user: { role: 'Administrator', name: 'Test Admin', email: 'admin@test.com' }, activePage: 'access-requests' };
  // get-only Proxy (no `has` trap) — see test/e2e/duplicate-warning-modal-offline.spec.js's identical note:
  // a `has` trap that always returns true breaks EJS's own internal __append/with() machinery.
  const locals = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !k.startsWith('_') && k !== 'constructor' ? '' : undefined))
  });
  return ejs.render(fs.readFileSync(TEMPLATE_PATH, 'utf8'), locals, { filename: TEMPLATE_PATH });
}

// Stubs window.CIPRMS.api AFTER the page's own inline script has already run once (page.setContent has
// no equivalent of addInitScript that reliably fires before it — the page's own initial PR/DR list
// loads hit a real ReferenceError and are silently ignored; harmless, since this suite never depends on
// that startup data). Every function under test here is invoked explicitly, after this stub is in place.
async function setup(page) {
  await page.setContent(renderPage());
  await page.addScriptTag({ path: BOOTSTRAP_PATH });
  await page.evaluate(() => {
    window.__apiCalls = [];
    window.__apiResponder = () => ({ ok: true, status: 200, data: [] });
    window.CIPRMS = window.CIPRMS || {};
    window.CIPRMS.api = (url, opts) => {
      window.__apiCalls.push({ url, method: (opts && opts.method) || 'GET', isFormData: !!(opts && opts.body instanceof FormData) });
      return Promise.resolve(window.__apiResponder(url, opts));
    };
    window.CIPRMS.toast = () => {};
  });
}

test.describe('Head of CIRL E-Signature modal (partnership_requests.ejs)', () => {
  test('the "Add E-Sign" button lives only in the Document Requests panel', async ({ page }) => {
    await setup(page);
    const btn = page.locator('#dr-esign-btn');
    await expect(btn).toHaveCount(1);
    const inDrPanel = await page.evaluate(() => !!document.querySelector('#panel-dr #dr-esign-btn'));
    const inPrPanel = await page.evaluate(() => !!document.querySelector('#panel-pr #dr-esign-btn'));
    expect(inDrPanel).toBe(true);
    expect(inPrPanel).toBe(false);
  });

  test('opening the modal loads and shows the current signature', async ({ page }) => {
    await setup(page);
    await page.evaluate((pngBase64) => {
      window.__apiResponder = (url) => url === '/api/settings/signature'
        ? { ok: true, status: 200, data: { success: true, hasSignature: true, dataUri: 'data:image/png;base64,' + pngBase64, uploadedBy: 'jesttest Staff', uploadedAt: '2026-11-01T00:00:00.000Z' } }
        : { ok: true, status: 200, data: [] };
      openEsignModal();
    }, VALID_PNG_BASE64);
    await page.waitForFunction(() => document.getElementById('esign-modal').classList.contains('show'));

    await expect(page.locator('#esign-current-img')).toBeVisible();
    await expect(page.locator('#esign-current-meta')).toContainText('jesttest Staff');
  });

  test('Upload tab: choosing a file previews it, and Save POSTs it as FormData to /api/settings/signature', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.__apiResponder = (url, opts) => url === '/api/settings/signature' && (!opts || opts.method !== 'POST')
        ? { ok: true, status: 200, data: { success: true, hasSignature: false } }
        : { ok: true, status: 200, data: { success: true } };
      openEsignModal();
    });
    await page.waitForFunction(() => document.getElementById('esign-modal').classList.contains('show'));

    await page.setInputFiles('#esign-file-input', { name: 'sig.png', mimeType: 'image/png', buffer: VALID_PNG_BYTES });
    await expect(page.locator('#esign-upload-preview')).toBeVisible();

    await page.locator('#esign-save-btn').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'POST' && c.url === '/api/settings/signature'));

    const postCall = await page.evaluate(() => window.__apiCalls.find((c) => c.method === 'POST' && c.url === '/api/settings/signature'));
    expect(postCall.isFormData).toBe(true);
  });

  test('Draw tab: Save is blocked with no strokes, and sends a drawn PNG blob once the canvas has been drawn on', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.__apiResponder = () => ({ ok: true, status: 200, data: { success: true, hasSignature: false } });
      openEsignModal();
    });
    await page.waitForFunction(() => document.getElementById('esign-modal').classList.contains('show'));
    await page.locator('a[href="#esign-tab-draw"]').click();

    // No strokes yet — Save must refuse without calling the API.
    await page.locator('#esign-save-btn').click();
    await expect(page.locator('#esign-error')).toBeVisible();
    await expect(page.locator('#esign-error')).toContainText('Draw a signature first');
    let calls = await page.evaluate(() => window.__apiCalls.filter((c) => c.method === 'POST'));
    expect(calls).toHaveLength(0);

    const canvas = page.locator('#esign-draw-canvas');
    const box = await canvas.boundingBox();
    await page.mouse.move(box.x + 10, box.y + 10);
    await page.mouse.down();
    await page.mouse.move(box.x + 60, box.y + 40);
    await page.mouse.up();

    await page.locator('#esign-save-btn').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'POST' && c.url === '/api/settings/signature'));
    const postCall = await page.evaluate(() => window.__apiCalls.find((c) => c.method === 'POST' && c.url === '/api/settings/signature'));
    expect(postCall.isFormData).toBe(true);
  });

  test('Remove asks for confirmation and sends DELETE only once confirmed', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.__apiResponder = () => ({ ok: true, status: 200, data: { success: true, hasSignature: true, dataUri: 'data:image/png;base64,AA==' } });
      openEsignModal();
    });
    await page.waitForFunction(() => document.getElementById('esign-modal').classList.contains('show'));

    page.once('dialog', (d) => d.dismiss());
    await page.locator('#esign-remove-btn').click();
    let deleteCalls = await page.evaluate(() => window.__apiCalls.filter((c) => c.method === 'DELETE'));
    expect(deleteCalls).toHaveLength(0);

    page.once('dialog', (d) => d.accept());
    await page.locator('#esign-remove-btn').click();
    await page.waitForFunction(() => window.__apiCalls.some((c) => c.method === 'DELETE'));
    deleteCalls = await page.evaluate(() => window.__apiCalls.filter((c) => c.method === 'DELETE'));
    expect(deleteCalls).toHaveLength(1);
  });
});
