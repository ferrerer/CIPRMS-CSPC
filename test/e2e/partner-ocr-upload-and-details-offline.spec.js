// Partner: View Request Details and Draft, and Fix Lost OCR Uploads — OFFLINE variant.
//
// Renders the real EJS templates (partner_requests.ejs, partner_monitoring.ejs) and runs their real inline
// client-side scripts via page.setContent() — no server, no login, no MongoDB — with window.CIPRMS.api and
// window.bootstrap/IDP stubbed, so it verifies the actual DOM/JS behavior fixed and added in this task:
// (1) the upload-then-draft flow now calls /api/ocr/confirm and carries a real fileLink into
//     collectFormData()'s attachmentLink, and (2) the new read-only details panel in the "View" modal.
// Run with:
//   npx playwright test --config=playwright.offline.config.js test/e2e/partner-ocr-upload-and-details-offline.spec.js
const { test, expect } = require('@playwright/test');
const path = require('path');
const fs = require('fs');
const ejs = require('ejs');

function renderRequestsPage() {
  const file = path.join(__dirname, '..', '..', 'views', 'potential_partner', 'partner_requests.ejs');
  let html = ejs.render(fs.readFileSync(file, 'utf8'), {
    user: { name: 'Test Partner', email: 'partner@test.com' }
  }, { filename: file });
  const stub = `<script>
    window.__apiCalls = [];
    window.IDP = { mapDocumentType: function (d, v) { return (d && v && v.indexOf(d) !== -1) ? d : null; }, renderResult: function () {}, markFilled: function () {} };
    // country-options.js never loads here (no server) — the page's OWN matchCountryOption() (defined
    // later in its inline script) reads this global directly; a real list makes real country matching work.
    window.COUNTRY_OPTIONS = ['Vietnam', 'Japan', 'Philippines', 'Testland'];
    window.CIPRMS = {
      api: function (url, opts) {
        window.__apiCalls.push({ url: url, opts: opts });
        if (url === '/api/ocr/confirm') {
          return Promise.resolve({ ok: true, data: { success: true, documentId: 777, fileLink: '/uploads/documents/mock-partner-ocr.pdf' } });
        }
        if (url === '/api/requests' && opts && opts.method === 'POST') {
          return Promise.resolve({ ok: true, data: { success: true, request: Object.assign({ id: 888 }, opts.json) } });
        }
        return Promise.resolve({ ok: true, data: [] });
      },
      busy: function (btn, fn) { return fn(); }
    };
  </script>`;
  html = html.replace('<head>', '<head>' + stub);
  return html;
}

// This page's modal-swap tests check real Bootstrap modal visibility/backdrop state (show/hide classes,
// .modal-backdrop presence) — behavior governed entirely by bootstrap.min.css and the JS in
// bootstrap.bundle.min.js, neither of which loads here (no server for the page's own <link>/<script src>
// tags to resolve). Both are inlined directly instead of stubbed, so the real Bootstrap modal engine runs.
const BOOTSTRAP_CSS = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'css', 'bootstrap.min.css'), 'utf8');
const BOOTSTRAP_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'libs', 'bootstrap', 'js', 'bootstrap.bundle.min.js'), 'utf8');

function renderMonitoringPage(mineRequests) {
  const file = path.join(__dirname, '..', '..', 'views', 'potential_partner', 'partner_monitoring.ejs');
  let html = ejs.render(fs.readFileSync(file, 'utf8'), {
    user: { name: 'Test Partner', email: 'partner@test.com' }
  }, { filename: file });
  const stub = `<style>${BOOTSTRAP_CSS}</style><script>${BOOTSTRAP_JS}</script><script>
    window.CIPRMS = {
      api: function (url, opts) {
        if (url === '/api/requests/mine') return Promise.resolve({ ok: true, data: ${JSON.stringify(mineRequests)} });
        return Promise.resolve({ ok: true, data: [] });
      },
      busy: function (btn, fn) { return fn(); },
      live: function () {}
    };
  </script>`;
  html = html.replace('<head>', '<head>' + stub);
  return html;
}

test.describe('Upload-then-draft flow (partner_requests.ejs)', () => {
  test('OCR success calls /api/ocr/confirm and the resulting fileLink flows into the saved-draft payload', async ({ page }) => {
    await page.setContent(renderRequestsPage(), { waitUntil: 'load' });

    // Direct function invocation (same zero-network-risk technique used elsewhere in this app's test
    // suite) — simulates a completed extraction without a real file upload or real OCR.
    await page.evaluate(() => {
      window.ocrSucceed('fake-job-1', { institution: 'Zeta University', country: 'Vietnam', nature: 'Research' });
    });

    const confirmCalls = await page.evaluate(() => window.__apiCalls.filter(c => c.url === '/api/ocr/confirm'));
    expect(confirmCalls.length).toBe(1);
    expect(confirmCalls[0].opts.json.jobId).toBe('fake-job-1');

    await expect(page.locator('#f-inst')).toHaveValue('Zeta University');

    await page.fill('#f-country', 'Vietnam');
    await page.selectOption('#f-type', 'MOA');
    await page.selectOption('#f-nature', 'Research');
    await page.click('button:has-text("Submit Request")');

    const createCalls = await page.evaluate(() => window.__apiCalls.filter(c => c.url === '/api/requests' && c.opts && c.opts.method === 'POST'));
    expect(createCalls.length).toBe(1);
    // This is the bug this task fixed: before the /api/ocr/confirm call existed, this was always undefined.
    expect(createCalls[0].opts.json.attachmentLink).toBe('/uploads/documents/mock-partner-ocr.pdf');
  });

  test('reopening a draft that already has an attachment shows it, without needing to re-upload', async ({ page }) => {
    await page.setContent(renderRequestsPage(), { waitUntil: 'load' });
    await page.evaluate(() => {
      window.myRequests = [{ id: 42, institution: 'Eta Institute', country: 'Laos', attachmentLink: '/uploads/documents/existing.pdf' }];
      window.editDraft(42);
    });
    await expect(page.locator('#ocr-result-box')).toBeVisible();
    await expect(page.locator('#ocr-result-box')).toContainText('already attached');
  });
});

test.describe('Request Details and Draft — separate modals (partner_monitoring.ejs)', () => {
  const sampleRequest = {
    id: 55, institution: 'Theta Foundation', country: 'Thailand', type: 'MOA', nature: 'Research',
    category: 'International', status: 'Pending', startDate: '2026-02-01', endDate: '2029-02-01',
    notes: 'Sample note', date: 'Feb 1, 2026', initiatedBy: 'institution',
    attachmentLink: '/uploads/documents/theta-draft.pdf',
    supportingDocuments: [{ originalFilename: 'revised.pdf', fileLink: '/uploads/documents/theta-revised.pdf', uploadedBy: 'Jane Admin', uploaderRole: 'Administrator', uploadedAt: new Date().toISOString(), fileType: 'application/pdf', fileSize: 1024 }]
  };
  const noDraftRequest = {
    id: 57, institution: 'Iota Partners', country: 'Cambodia', type: 'MOU', nature: 'Research',
    category: 'International', status: 'Pending', startDate: '2026-03-01', endDate: '2029-03-01',
    notes: 'No file yet', date: 'Mar 1, 2026'
  };

  test('"View" opens the Details modal (not Draft) with institution/country/type/nature/category/dates/notes/status and who started it', async ({ page }) => {
    await page.setContent(renderMonitoringPage([sampleRequest]), { waitUntil: 'load' });
    await page.waitForSelector('[data-pr-id="55"]');
    await page.click('[data-pr-id="55"] button:has-text("View")');
    await expect(page.locator('#pr-details-modal')).toBeVisible();
    await expect(page.locator('#pr-draft-modal')).toBeHidden();

    await expect(page.locator('#pr-det-inst')).toHaveText('Theta Foundation');
    await expect(page.locator('#pr-det-country')).toHaveText('Thailand');
    await expect(page.locator('#pr-det-type')).toHaveText('MOA');
    await expect(page.locator('#pr-det-nature')).toHaveText('Research');
    await expect(page.locator('#pr-det-category')).toHaveText('International');
    await expect(page.locator('#pr-det-start')).toHaveText('2026-02-01');
    await expect(page.locator('#pr-det-end')).toHaveText('2029-02-01');
    await expect(page.locator('#pr-det-notes')).toHaveText('Sample note');
    await expect(page.locator('#pr-det-status')).toContainText('Pending');
    // Started by Admin/Staff — this request has initiatedBy: 'institution'.
    await expect(page.locator('#pr-det-initiator')).toContainText('CSPC-CIRL');

    // No LAU data anywhere in the Details modal — the server never sends it (scopeLauReviewsForViewer),
    // and the modal has no UI for it regardless.
    await expect(page.locator('#pr-details-modal')).not.toContainText('LAU');
  });

  test('a request submitted by the partner themselves (no initiatedBy) shows "You" as who started it', async ({ page }) => {
    const ownRequest = Object.assign({}, sampleRequest, { id: 56, initiatedBy: undefined });
    await page.setContent(renderMonitoringPage([ownRequest]), { waitUntil: 'load' });
    await page.waitForSelector('[data-pr-id="56"]');
    await page.click('[data-pr-id="56"] button:has-text("View")');
    await expect(page.locator('#pr-det-initiator')).toHaveText('You');
  });

  test('"View Draft" opens the separate Draft modal, closing Details first — no stacked/leftover backdrop', async ({ page }) => {
    await page.setContent(renderMonitoringPage([sampleRequest]), { waitUntil: 'load' });
    await page.waitForSelector('[data-pr-id="55"]');
    await page.click('[data-pr-id="55"] button:has-text("View")');
    await expect(page.locator('#pr-details-modal')).toBeVisible();

    await page.click('#pr-details-view-draft-btn');
    await expect(page.locator('#pr-draft-modal')).toBeVisible();
    await expect(page.locator('#pr-details-modal')).toBeHidden();
    // Exactly one backdrop — Details was closed, not stacked underneath.
    await expect(page.locator('.modal-backdrop')).toHaveCount(1);

    const timeline = page.locator('#pr-draft-timeline');
    await expect(timeline).toContainText('theta-draft.pdf');
    await expect(timeline).toContainText('revised.pdf');
    await expect(timeline.locator('a:has-text("Download")')).toHaveCount(2);
    await expect(page.locator('#pr-draft-modal')).not.toContainText('LAU');
  });

  test('"Back to Details" returns to the Details modal, and closing Draft normally does not reopen it', async ({ page }) => {
    await page.setContent(renderMonitoringPage([sampleRequest]), { waitUntil: 'load' });
    await page.waitForSelector('[data-pr-id="55"]');
    await page.click('[data-pr-id="55"] button:has-text("View")');
    await page.click('#pr-details-view-draft-btn');
    await expect(page.locator('#pr-draft-modal')).toBeVisible();

    await page.click('button:has-text("Back to Details")');
    await expect(page.locator('#pr-details-modal')).toBeVisible();
    await expect(page.locator('#pr-draft-modal')).toBeHidden();
    await expect(page.locator('.modal-backdrop')).toHaveCount(1);

    // Closing Draft a second time via its own Close button (not Back) must end the flow, not reopen Details.
    await page.click('#pr-details-view-draft-btn');
    await expect(page.locator('#pr-draft-modal')).toBeVisible();
    await page.click('#pr-draft-modal .modal-footer button:has-text("Close")');
    await expect(page.locator('#pr-draft-modal')).toBeHidden();
    await expect(page.locator('#pr-details-modal')).toBeHidden();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
  });

  test('"View Draft" is disabled, with a note, when nothing is attached', async ({ page }) => {
    await page.setContent(renderMonitoringPage([noDraftRequest]), { waitUntil: 'load' });
    await page.waitForSelector('[data-pr-id="57"]');
    await page.click('[data-pr-id="57"] button:has-text("View")');
    await expect(page.locator('#pr-details-modal')).toBeVisible();
    await expect(page.locator('#pr-details-view-draft-btn')).toBeDisabled();
    await expect(page.locator('#pr-details-no-draft-note')).toBeVisible();
  });

  test('closing the Details modal outright (no Draft ever opened) leaves no backdrop', async ({ page }) => {
    await page.setContent(renderMonitoringPage([sampleRequest]), { waitUntil: 'load' });
    await page.waitForSelector('[data-pr-id="55"]');
    await page.click('[data-pr-id="55"] button:has-text("View")');
    await expect(page.locator('#pr-details-modal')).toBeVisible();
    await page.click('#pr-details-modal .modal-footer button:has-text("Close")');
    await expect(page.locator('#pr-details-modal')).toBeHidden();
    await expect(page.locator('.modal-backdrop')).toHaveCount(0);
    await expect(page.locator('body')).not.toHaveClass(/modal-open/);
  });
});
