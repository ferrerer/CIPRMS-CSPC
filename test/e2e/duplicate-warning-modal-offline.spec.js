// Duplicate-warning box — "Upload anyway" / "Cancel" (2026-11, "Warn on Duplicates and Let the User
// Accept or Cancel"). Real DOM check against the actual, unmodified views/administrator/documents.ejs
// (the Document Library's own upload page) — no server, no real network: window.fetch is stubbed so this
// proves the CLIENT behavior (which button does what, and with which request body) independent of
// whatever the server actually returns. Server-side enforcement itself is covered by
// test/duplicate-warning.test.js (Jest/supertest against the real route).
const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'views', 'administrator', 'documents.ejs');

function renderPage() {
  const base = { user: { role: 'Administrator', name: 'Test Admin', email: 'admin@test.com' }, activePage: 'documents' };
  // get-only Proxy (no `has` trap) — a `has` trap that always returns true breaks EJS's own internal
  // __append helper when the template is rendered via a `with()`-backed Proxy; get-only lets EJS's real
  // internals resolve normally while still defaulting any other missing local to '' instead of throwing.
  const locals = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !k.startsWith('_') && k !== 'constructor' ? '' : undefined))
  });
  return ejs.render(fs.readFileSync(TEMPLATE_PATH, 'utf8'), locals, { filename: TEMPLATE_PATH });
}

// Puts the page into "OCR just succeeded, nothing saved yet" state — same as a real upload would, minus
// the actual network round trip to /api/ocr/extract+status.
async function startFakeOcrJob(page) {
  await page.evaluate(() => {
    window.__fetchCalls = [];
    docOcrSucceed({ title: 'ZZ Test Doc', documentType: 'MOA', institution: 'ZZ Test University', confidence: 92 }, 'fake-job-id');
  });
}

test.describe('Duplicate-warning box (documents.ejs)', () => {
  test('an exact-duplicate response shows the right heading and nothing is archived until a choice is made', async ({ page }) => {
    await page.setContent(renderPage());
    await startFakeOcrJob(page);

    await page.evaluate(() => {
      window.fetch = (url, opts) => {
        window.__fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
        return Promise.resolve({
          json: () => Promise.resolve({
            success: true, duplicateFound: true, matchLevel: 'exact',
            matches: [{ title: 'ZZ Test Existing Doc', type: 'MOA', institution: 'ZZ Test University', reason: 'Identical file content (exact SHA-256 hash match)', fileLink: '/uploads/documents/existing.pdf' }],
            genericOnly: false
          })
        });
      };
      saveDocument();
    });
    await page.waitForFunction(() => document.getElementById('duplicate-warning-box').style.display === 'block');

    await expect(page.locator('#duplicate-warning-heading')).toHaveText('This file already exists in the Document Library.');
    await expect(page.locator('#duplicate-matches-container')).toContainText('ZZ Test Existing Doc');
    await expect(page.locator('#btn-continue-duplicate')).toHaveText(/Upload anyway/i);
    await expect(page.locator('#btn-discard-duplicate')).toHaveText(/Cancel/i);
  });

  test('a possible-duplicate, privacy-scoped response (no match details) shows the generic sentence only', async ({ page }) => {
    await page.setContent(renderPage());
    await startFakeOcrJob(page);

    await page.evaluate(() => {
      window.fetch = () => Promise.resolve({
        json: () => Promise.resolve({ success: true, duplicateFound: true, matchLevel: 'possible', matches: [], genericOnly: true })
      });
      saveDocument();
    });
    await page.waitForFunction(() => document.getElementById('duplicate-warning-box').style.display === 'block');

    await expect(page.locator('#duplicate-warning-heading')).toHaveText('This document looks similar to existing documents.');
    await expect(page.locator('#duplicate-matches-container')).toContainText('A similar document may already exist.');
  });

  test('"Upload anyway" re-calls confirm with acknowledgeDuplicate: true — the ONLY way archiving happens', async ({ page }) => {
    await page.setContent(renderPage());
    await startFakeOcrJob(page);

    await page.evaluate(() => {
      window.fetch = (url, opts) => {
        const body = opts && opts.body ? JSON.parse(opts.body) : null;
        window.__fetchCalls.push({ url, body });
        if (body && body.acknowledgeDuplicate) {
          return Promise.resolve({ json: () => Promise.resolve({ success: true, documentId: 42, fileLink: '/uploads/documents/new.pdf' }) });
        }
        return Promise.resolve({ json: () => Promise.resolve({ success: true, duplicateFound: true, matchLevel: 'exact', matches: [], genericOnly: true }) });
      };
      saveDocument(); // 1st call: no acknowledgeDuplicate -> server (mock) returns duplicateFound
    });
    await page.waitForFunction(() => document.getElementById('duplicate-warning-box').style.display === 'block');

    // Nothing archived after the first call.
    let calls = await page.evaluate(() => window.__fetchCalls);
    expect(calls).toHaveLength(1);
    expect(calls[0].body.acknowledgeDuplicate).toBe(false);

    await page.locator('#btn-continue-duplicate').click(); // "Upload anyway"
    await page.waitForFunction(() => window.__fetchCalls.length === 2);

    calls = await page.evaluate(() => window.__fetchCalls);
    expect(calls[1].body.acknowledgeDuplicate).toBe(true); // this is what actually tells the server to archive
  });

  test('"Cancel" discards the upload and never re-sends acknowledgeDuplicate', async ({ page }) => {
    await page.setContent(renderPage());
    await startFakeOcrJob(page);

    await page.evaluate(() => {
      window.fetch = (url, opts) => {
        window.__fetchCalls.push({ url, body: opts && opts.body ? JSON.parse(opts.body) : null });
        return Promise.resolve({ json: () => Promise.resolve({ success: true, duplicateFound: true, matchLevel: 'possible', matches: [], genericOnly: true }) });
      };
      saveDocument();
    });
    await page.waitForFunction(() => document.getElementById('duplicate-warning-box').style.display === 'block');

    await page.locator('#btn-discard-duplicate').click(); // "Cancel"
    await page.waitForFunction(() => window.__fetchCalls.length === 2);

    const calls = await page.evaluate(() => window.__fetchCalls);
    expect(calls[1].url).toBe('/api/ocr/discard'); // deletes the temp file, archives nothing
    expect(calls.some((c) => c.body && c.body.acknowledgeDuplicate)).toBe(false);
  });
});
