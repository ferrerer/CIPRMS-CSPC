// "Low confidence" label removal (2026-11) — real DOM check against the actual, unmodified
// assets/js/pages/idp-ocr-widget.js (no server, no EJS: this widget is pure DOM manipulation shared by
// every OCR-autofill form — partner_requests.ejs, partnership_requests.ejs, monitoring.ejs). Confirms both
// call paths that used to insert the text are now silent, while the confidence VALUE itself (what this
// task was explicit about keeping) still reaches the DOM via the confidence badges.
const { test, expect } = require('@playwright/test');
const fs = require('fs');
const path = require('path');

const WIDGET_JS = fs.readFileSync(path.join(__dirname, '..', '..', 'assets', 'js', 'pages', 'idp-ocr-widget.js'), 'utf8');

function pageHtml() {
  return `<!doctype html><html><head></head><body>
    <input id="f-inst" value="">
    <div id="result-panel"></div>
    <script>${WIDGET_JS}</script>
  </body></html>`;
}

test('markFilled() with a low confidence no longer inserts a "Low confidence" text node, but still applies the border-highlight class', async ({ page }) => {
  await page.setContent(pageHtml());
  await page.evaluate(() => window.IDP.markFilled('f-inst', 30)); // well under the 70% threshold
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/low confidence/i);
  const hasHighlightClass = await page.evaluate(() => document.getElementById('f-inst').classList.contains('ocr-low-confidence'));
  expect(hasHighlightClass).toBe(true); // the visual cue this task said to keep
});

test('renderResult() with a low document-type confidence no longer shows the "Low confidence — please verify" note, but still shows the confidence score itself', async ({ page }) => {
  await page.setContent(pageHtml());
  await page.evaluate(() => {
    window.IDP.renderResult('result-panel', {
      documentType: 'Other', documentTypeConfidence: 25,
      institution: 'Test University', institutionConfidence: 40
    });
  });
  const bodyText = await page.locator('body').innerText();
  expect(bodyText).not.toMatch(/low confidence/i);
  expect(bodyText).toMatch(/Detected:\s*25%/); // the confidence score is still shown
  expect(bodyText).toMatch(/Institution Name:\s*40%/);
});
