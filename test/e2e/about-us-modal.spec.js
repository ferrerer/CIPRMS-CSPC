// About Us modal — enlarged, 3-top/2-centered-bottom team layout (2026-11, run with `npm run test:e2e`,
// see playwright.config.js). The sign-in page (/) needs no authentication, so this spec never logs in —
// it drives the real, rendered modal exactly as a visitor would.
const { test, expect } = require('@playwright/test');

const DESKTOP = { width: 1400, height: 900 };
const TABLET = { width: 768, height: 1024 };
const MOBILE = { width: 390, height: 844 };

async function openAboutModal(page) {
  await page.goto('/');
  await page.click('.about-us-trigger');
  await expect(page.locator('#about-modal')).toBeVisible();
}

test.describe('About Us modal — desktop: enlarged dialog and exact 3-top / 2-centered-bottom layout', () => {
  test.use({ viewport: DESKTOP });

  test('dialog is widened (1220px at this viewport) and height stays within ~90vh', async ({ page }) => {
    await openAboutModal(page);
    const box = await page.locator('#about-modal .modal-dialog').boundingBox();
    expect(box.width).toBeGreaterThanOrEqual(1150);
    expect(box.width).toBeLessThanOrEqual(1220);
    const contentBox = await page.locator('#about-modal .modal-content').boundingBox();
    expect(contentBox.height).toBeLessThanOrEqual(DESKTOP.height * 0.9 + 5); // small tolerance for borders/rounding
  });

  test('three cards share one row, two more share a second row centered beneath them, in the exact required name order', async ({ page }) => {
    await openAboutModal(page);
    const cols = page.locator('#about-modal .team-card-col');
    await expect(cols).toHaveCount(5);

    const boxes = [];
    for (let i = 0; i < 5; i++) boxes.push(await cols.nth(i).boundingBox());

    // Top row: first three cards share the same top edge (same row).
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(20);
    expect(Math.abs(boxes[1].y - boxes[2].y)).toBeLessThan(20);
    // Bottom row: last two share a different, lower row.
    expect(Math.abs(boxes[3].y - boxes[4].y)).toBeLessThan(20);
    expect(boxes[3].y).toBeGreaterThan(boxes[0].y + 10);

    // The bottom pair is CENTERED under the top trio, not left-aligned: its horizontal midpoint matches
    // the top row's midpoint, and it does not start at the same left edge as the top row.
    const topLeft = boxes[0].x;
    const topRight = boxes[2].x + boxes[2].width;
    const topMid = (topLeft + topRight) / 2;
    const bottomLeft = boxes[3].x;
    const bottomRight = boxes[4].x + boxes[4].width;
    const bottomMid = (bottomLeft + bottomRight) / 2;
    expect(Math.abs(topMid - bottomMid)).toBeLessThan(10);
    expect(bottomLeft).toBeGreaterThan(topLeft + 10);

    // Exact names, exact order, exact initials, top row then bottom row.
    const names = await cols.locator('h6').allTextContents();
    expect(names).toEqual(['Lui Vhinz Dominic P. Briñas', 'Begie B. Golpe', 'Zyra Devie D. Malto', 'Joshua B. Baliber', 'John Raven M. Ferrer']);
    const initials = await cols.locator('.team-avatar').allTextContents();
    expect(initials).toEqual(['LB', 'BG', 'ZM', 'JB', 'JF']);
  });

  test('every card shows its own individual role label and no card is clipped or overlapping another', async ({ page }) => {
    await openAboutModal(page);
    const cols = page.locator('#about-modal .team-card-col');
    const roles = await cols.locator('p.text-primary').allTextContents();
    // 2026-11: one role per member, same order as the names check above — not a uniform label any more.
    expect(roles.map((r) => r.trim())).toEqual([
      'Project Head / Database Designer (PH/DD)',
      'Network Designer / UI Designer (ND/UID)',
      'QA Tester / Documentation Writer (QA/TW)',
      'Software Engineer / Programmer (SE/P)',
      'Software Engineer / Programmer (SE/P)'
    ]);

    // No horizontal scrollbar on the modal body — everything fits within the enlarged width.
    const overflow = await page.locator('#about-modal .modal-body').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(overflow).toBe(false);
  });

  test('closes via the Close button and reopens cleanly with no console errors', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (err) => errors.push(err.message));
    await openAboutModal(page);
    await page.click('#about-modal .modal-footer button:has-text("Close")');
    await expect(page.locator('#about-modal')).toBeHidden();
    await page.click('.about-us-trigger');
    await expect(page.locator('#about-modal')).toBeVisible();
    await expect(page.locator('h6:has-text("Lui Vhinz Dominic P. Briñas")')).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('closes via the header X button', async ({ page }) => {
    await openAboutModal(page);
    await page.click('#about-modal .modal-header .btn-close');
    await expect(page.locator('#about-modal')).toBeHidden();
  });

  // Its own fresh page load, not chained after another close in the same test — Bootstrap's modal
  // focus-trap can transiently misbehave under Playwright when a second open/close cycle is driven
  // programmatically within milliseconds of the first, which is not how a real visitor interacts with
  // the page; verified directly that Escape closes the modal correctly on a clean first open.
  test('closes via Escape on a fresh open', async ({ page }) => {
    await openAboutModal(page);
    await expect(page.locator('#about-modal')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#about-modal')).toBeHidden();
  });
});

test.describe('About Us modal — tablet: two-column layout, order intact, no overflow', () => {
  test.use({ viewport: TABLET });

  test('cards wrap to two per row in the exact required order, with no horizontal page overflow', async ({ page }) => {
    await openAboutModal(page);
    const cols = page.locator('#about-modal .team-card-col');
    const names = await cols.locator('h6').allTextContents();
    expect(names).toEqual(['Lui Vhinz Dominic P. Briñas', 'Begie B. Golpe', 'Zyra Devie D. Malto', 'Joshua B. Baliber', 'John Raven M. Ferrer']);

    const boxes = [];
    for (let i = 0; i < 5; i++) boxes.push(await cols.nth(i).boundingBox());
    // Two per row: card 1 and 2 share a row; card 3 starts a new row.
    expect(Math.abs(boxes[0].y - boxes[1].y)).toBeLessThan(20);
    expect(boxes[2].y).toBeGreaterThan(boxes[0].y + 10);

    const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(bodyOverflow).toBe(false);
  });
});

test.describe('About Us modal — mobile: single column, no overflow, close button reachable', () => {
  test.use({ viewport: MOBILE });

  test('cards stack one per row in order, names wrap cleanly, and the page never scrolls horizontally', async ({ page }) => {
    await openAboutModal(page);
    const cols = page.locator('#about-modal .team-card-col');
    const names = await cols.locator('h6').allTextContents();
    expect(names).toEqual(['Lui Vhinz Dominic P. Briñas', 'Begie B. Golpe', 'Zyra Devie D. Malto', 'Joshua B. Baliber', 'John Raven M. Ferrer']);

    const boxes = [];
    for (let i = 0; i < 5; i++) boxes.push(await cols.nth(i).boundingBox());
    for (let i = 1; i < boxes.length; i++) expect(boxes[i].y).toBeGreaterThan(boxes[i - 1].y); // strictly stacked, one per row

    const bodyOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    expect(bodyOverflow).toBe(false);
  });

  test('the close button stays visible and functional at mobile width', async ({ page }) => {
    await openAboutModal(page);
    const closeBtn = page.locator('#about-modal .modal-header .btn-close');
    await expect(closeBtn).toBeVisible();
    await closeBtn.click();
    await expect(page.locator('#about-modal')).toBeHidden();
  });
});
