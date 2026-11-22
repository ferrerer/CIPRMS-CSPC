// "The first uploaded file goes missing" fix — Admin/Staff Partnership Request draft-upload duplicate
// warning (views/administrator/partnership_requests.ejs's uploadDraftDocument()). Before this fix, a held
// duplicate (duplicateWarningGate's {success:true, duplicateFound:true, pendingId, ...} response, with no
// `request` field) was silently treated as success — "New draft version uploaded." showed even though the
// file was never archived or attached, and nothing in the page ever called POST /api/uploads/pending/:id/
// accept or .../cancel. Real DOM check against the actual, unmodified EJS — no server, no real network:
// window.CIPRMS.api is stubbed so this proves the CLIENT behavior independent of whatever the server
// returns. Server-side hold/accept/cancel mechanics are covered by test/duplicate-warning.test.js and
// test/first-upload-goes-missing-fix.test.js.
const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'views', 'administrator', 'partnership_requests.ejs');
const BOOTSTRAP_PATH = path.join(__dirname, '..', '..', 'assets', 'libs', 'bootstrap', 'js', 'bootstrap.bundle.min.js');
const BOOTSTRAP_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'css', 'bootstrap.min.css');

function renderPage() {
  const base = { user: { role: 'Administrator', name: 'Test Admin', email: 'admin@test.com', id: 1 }, activePage: 'requests' };
  const locals = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !k.startsWith('_') && k !== 'constructor' ? '' : undefined))
  });
  return ejs.render(fs.readFileSync(TEMPLATE_PATH, 'utf8'), locals, { filename: TEMPLATE_PATH });
}

const FAKE_REQUEST = {
  id: 42, institution: 'jesttest Draft Dup University', type: 'MOA', status: 'Pending',
  requestedBy: 'jesttest Partner', submittedByEmail: 'partner@test.com', date: 'Jan 1, 2026',
  attachmentLink: '', supportingDocuments: []
};

const DUPLICATE_RESPONSE = {
  success: true, duplicateFound: true, pendingId: 'pending-abc123', matchLevel: 'similar',
  matches: [{ title: 'jesttest Existing MOA', institution: 'jesttest Draft Dup University' }], genericOnly: false
};

async function setup(page) {
  await page.setContent(renderPage());
  await page.addStyleTag({ path: BOOTSTRAP_CSS_PATH });
  await page.addScriptTag({ path: BOOTSTRAP_PATH });
  await page.evaluate((fakeRequest) => {
    window.__apiCalls = [];
    window.CIPRMS = window.CIPRMS || {};
    window.CIPRMS.api = (url, opts) => {
      window.__apiCalls.push({ url, method: (opts && opts.method) || 'GET' });
      return Promise.resolve({ ok: true, status: 200, data: { success: true } });
    };
    prData = [fakeRequest];
  }, FAKE_REQUEST);
  await page.evaluate(() => openDraftModal('42'));
  await expect(page.locator('#pr-draft-modal')).toBeVisible();
}

test.describe('Partnership Request draft-upload duplicate warning (partnership_requests.ejs)', () => {
  test('a held duplicate shows the warning box instead of a false "uploaded" toast, and never calls accept/cancel on its own', async ({ page }) => {
    await setup(page);
    await page.evaluate((dupResponse) => {
      window.CIPRMS.api = (url, opts) => {
        window.__apiCalls.push({ url, method: (opts && opts.method) || 'GET' });
        if (/\/documents$/.test(url) && opts && opts.method === 'POST') {
          return Promise.resolve({ ok: true, status: 200, data: dupResponse });
        }
        return Promise.resolve({ ok: true, status: 200, data: { success: true } });
      };
    }, DUPLICATE_RESPONSE);

    // A note is enough to pass the "file or note" guard — the file input itself can't be filled
    // programmatically in this offline render without a real file, and isn't needed to prove the response
    // handling this test targets.
    await page.fill('#pr-draft-note', 'jesttest note');
    await page.click('#pr-draft-upload-btn');

    await expect(page.locator('#pr-draft-duplicate-box')).toBeVisible();
    await expect(page.locator('#pr-draft-duplicate-heading')).toContainText('looks similar');
    await expect(page.locator('#pr-draft-duplicate-matches')).toContainText('jesttest Existing MOA');
    // The old bug's symptom: a false success toast instead of the warning.
    await expect(page.locator('#pr-toast')).not.toContainText('New draft version uploaded');
    expect(await page.evaluate(() => window.__apiCalls.some((c) => /\/uploads\/pending\//.test(c.url)))).toBe(false);
  });

  test('"Upload Anyway" calls the pending-upload accept route and refreshes the timeline', async ({ page }) => {
    await setup(page);
    await page.evaluate((dupResponse) => {
      window.CIPRMS.api = (url, opts) => {
        window.__apiCalls.push({ url, method: (opts && opts.method) || 'GET' });
        if (/\/documents$/.test(url) && opts && opts.method === 'POST') {
          return Promise.resolve({ ok: true, status: 200, data: dupResponse });
        }
        if (/\/uploads\/pending\/pending-abc123\/accept$/.test(url)) {
          return Promise.resolve({
            ok: true, status: 200,
            data: { success: true, documentId: 99, fileLink: '/uploads/documents/99.png', updated: { id: 42, supportingDocuments: [{ documentId: 99, originalFilename: 'resolved.png' }] } }
          });
        }
        return Promise.resolve({ ok: true, status: 200, data: { success: true } });
      };
    }, DUPLICATE_RESPONSE);

    await page.fill('#pr-draft-note', 'jesttest note');
    await page.click('#pr-draft-upload-btn');
    await expect(page.locator('#pr-draft-duplicate-box')).toBeVisible();

    await page.click('#pr-draft-duplicate-box button:has-text("Upload Anyway")');
    await expect(page.locator('#pr-draft-duplicate-box')).toBeHidden();
    expect(await page.evaluate(() => window.__apiCalls.some((c) => c.url === '/api/uploads/pending/pending-abc123/accept' && c.method === 'POST'))).toBe(true);
    // prData's cached copy of the request was refreshed from the accept response's `updated` field.
    expect(await page.evaluate(() => prData[0].supportingDocuments.length)).toBe(1);
  });

  test('"Cancel" calls the pending-upload cancel route and clears the warning without attaching anything', async ({ page }) => {
    await setup(page);
    await page.evaluate((dupResponse) => {
      window.CIPRMS.api = (url, opts) => {
        window.__apiCalls.push({ url, method: (opts && opts.method) || 'GET' });
        if (/\/documents$/.test(url) && opts && opts.method === 'POST') {
          return Promise.resolve({ ok: true, status: 200, data: dupResponse });
        }
        return Promise.resolve({ ok: true, status: 200, data: { success: true } });
      };
    }, DUPLICATE_RESPONSE);

    await page.fill('#pr-draft-note', 'jesttest note');
    await page.click('#pr-draft-upload-btn');
    await expect(page.locator('#pr-draft-duplicate-box')).toBeVisible();

    await page.click('#pr-draft-duplicate-box button:has-text("Cancel")');
    await expect(page.locator('#pr-draft-duplicate-box')).toBeHidden();
    expect(await page.evaluate(() => window.__apiCalls.some((c) => c.url === '/api/uploads/pending/pending-abc123/cancel' && c.method === 'POST'))).toBe(true);
    expect(await page.evaluate(() => prData[0].supportingDocuments.length)).toBe(0);
  });
});
