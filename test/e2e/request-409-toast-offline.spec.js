// 409 handling on the request-decision routes (2026-11 Batch 1 follow-up): a 409 means someone else's
// Approve/Reject/Accept/Return won the race (see cirl.js's conditional updateOne, Batch 1 Critical #1) —
// the UI must show a specific, friendly toast ("This request was already updated by someone else.
// Refreshing…") and reload rather than the server's generic error text. Real DOM check against the
// actual, unmodified views/administrator/college_requests.ejs — no server, no real network: window.fetch
// is stubbed so this proves the CLIENT behavior independent of whatever the server actually returns.
// Server-side behavior (the 409 itself) is covered by test/college-dean-requests.test.js,
// test/request-endpoint-rbac.test.js and test/document-request-status-workflow.test.js.
const { test, expect } = require('@playwright/test');
const ejs = require('ejs');
const fs = require('fs');
const path = require('path');

const TEMPLATE_PATH = path.join(__dirname, '..', '..', 'views', 'administrator', 'college_requests.ejs');
const BOOTSTRAP_PATH = path.join(__dirname, '..', '..', 'assets', 'libs', 'bootstrap', 'js', 'bootstrap.bundle.min.js');
const BOOTSTRAP_CSS_PATH = path.join(__dirname, '..', '..', 'assets', 'css', 'bootstrap.min.css');

function renderPage() {
  // id must be a real number, not the Proxy's usual '' fallback — the page's own window.CIPRMS_USER
  // script embeds it unquoted (`id: <%= user.id %>`), so an empty-string substitution there is a
  // genuine JS syntax error (found live via this exact spec) that breaks every later <script> block too.
  const base = { user: { role: 'Administrator', name: 'Test Admin', email: 'admin@test.com', id: 1 }, activePage: 'college-requests' };
  // get-only Proxy (no `has` trap) — see esign-modal-offline.spec.js's identical note: a `has` trap that
  // always returns true breaks EJS's own internal __append/with() machinery.
  const locals = new Proxy(base, {
    get: (t, k) => (k in t ? t[k] : (typeof k === 'string' && !k.startsWith('_') && k !== 'constructor' ? '' : undefined))
  });
  return ejs.render(fs.readFileSync(TEMPLATE_PATH, 'utf8'), locals, { filename: TEMPLATE_PATH });
}

const FAKE_REQUEST = {
  id: 42, title: 'jesttest Accreditation', requestType: 'Accreditation', status: 'Submitted',
  assignedDeanName: 'jesttest Dean', assignedCollege: 'CCS', requiredDocuments: [], referenceDocuments: [],
  submittedDocuments: [], statusHistory: []
};

async function setup(page) {
  await page.setContent(renderPage());
  await page.addStyleTag({ path: BOOTSTRAP_CSS_PATH });
  await page.addScriptTag({ path: BOOTSTRAP_PATH });
  await page.evaluate((fakeRequest) => {
    window.__fetchCalls = [];
    window.__patchResponder = () => ({ status: 409, body: { error: 'This request was already updated. Please refresh.' } });
    const realFetch = window.fetch.bind(window);
    window.fetch = (url, opts) => {
      const method = (opts && opts.method) || 'GET';
      window.__fetchCalls.push({ url, method });
      if (url === '/api/users') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      if (url === '/api/college-requests') return Promise.resolve({ ok: true, json: () => Promise.resolve([]) });
      if (url === '/api/college-requests/42' && method === 'GET') {
        return Promise.resolve({ ok: true, json: () => Promise.resolve(fakeRequest) });
      }
      if (url === '/api/college-requests/42' && method === 'PATCH') {
        const r = window.__patchResponder();
        return Promise.resolve({ ok: r.status < 400, status: r.status, json: () => Promise.resolve(r.body) });
      }
      return realFetch(url, opts);
    };
  }, FAKE_REQUEST);
}

test.describe('College Request decision 409 (college_requests.ejs)', () => {
  test('a 409 on Accept shows the specific toast, hides the modal, and reloads the list', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => cdrOpenDetail(42));
    await expect(page.locator('#cdr-detail-modal')).toBeVisible();
    // Counted as a BEFORE/AFTER delta, not an absolute total — the page's own DOMContentLoaded-triggered
    // initial cdrLoadList() call races against this spec's own fetch stub installation (page.setContent()
    // has no reliable "before inline scripts run" hook), so whether that very first call gets captured at
    // all is inherently timing-dependent; the one call this test actually cares about proving is the
    // RE-load cdrDecide() triggers after the 409, which this still catches either way.
    const listCallsBefore = await page.evaluate(() => window.__fetchCalls.filter((c) => c.url === '/api/college-requests' && c.method === 'GET').length);

    await page.locator('#cdr-detail-modal button:has-text("Accept")').click();
    await page.waitForFunction(() => window.__fetchCalls.some((c) => c.method === 'PATCH'));

    await expect(page.locator('#cdr-toast')).toContainText('This request was already updated by someone else. Refreshing…');
    await expect(page.locator('#cdr-detail-modal')).not.toBeVisible();
    await page.waitForFunction(
      (before) => window.__fetchCalls.filter((c) => c.url === '/api/college-requests' && c.method === 'GET').length > before,
      listCallsBefore
    );
  });

  test('a non-409 failure (e.g. a genuine validation error) shows the server\'s own message instead, and keeps the modal open', async ({ page }) => {
    await setup(page);
    await page.evaluate(() => {
      window.__patchResponder = () => ({ status: 400, body: { error: 'A comment is required when returning for revision.' } });
    });
    await page.evaluate(() => cdrOpenDetail(42));
    await expect(page.locator('#cdr-detail-modal')).toBeVisible();

    await page.locator('#cdr-detail-modal button:has-text("Accept")').click();
    await page.waitForFunction(() => window.__fetchCalls.some((c) => c.method === 'PATCH'));

    await expect(page.locator('#cdr-toast')).toContainText('A comment is required when returning for revision.');
    await expect(page.locator('#cdr-toast')).not.toContainText('already updated by someone else');
    await expect(page.locator('#cdr-detail-modal')).toBeVisible();
  });
});
