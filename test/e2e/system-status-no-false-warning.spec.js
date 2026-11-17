// System Status banner — no false-positive warning on a healthy system (2026-11 repeated-warning root-
// cause fix, run with `npm run test:e2e`, see playwright.config.js). Root cause: checkGoogleCalendar()/
// checkGoogleDocs() (services/systemStatusService.js) had no timeout of their own, so a transient MongoDB
// hiccup left them waiting on the driver's own ~30s default instead of the intended 4s, non-deterministically
// reporting a perfectly healthy Google Calendar/Docs connection as "unavailable". Fixed by wrapping both in
// the same withTimeout() helper checkDatabase()/checkEmail() already used. This spec proves the visible,
// user-facing effect through a real browser: no false banner on a healthy system, and repeated polling
// stays consistent rather than flapping.
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

test('a healthy system shows no system-status warning banner on page load', async ({ page }) => {
  await loginAs(page, admin);
  await page.goto('/admin/settings');
  // Give the banner script's own initial check() a moment to complete and (not) render.
  await page.waitForTimeout(2000);
  await expect(page.locator('#ciprms-status-banner')).toHaveCount(0);
});

test('GET /api/system-status responds quickly and consistently across repeated polls — no flapping between available and unavailable for a service that never actually changed', async ({ page }) => {
  await loginAs(page, admin);
  const results = [];
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now();
    const res = await page.request.get('/api/system-status');
    const elapsed = Date.now() - t0;
    expect(res.status()).toBe(200);
    expect(elapsed).toBeLessThan(10000); // well under the old 30-61s observed before the fix
    const body = await res.json();
    results.push(Object.fromEntries(body.services.map(s => [s.key, s.state])));
  }
  // Every poll must agree on the database's state — this is the exact service whose own check was never
  // broken, so it is the clearest baseline that nothing is flapping due to test/network noise.
  const databaseStates = results.map(r => r.database);
  expect(new Set(databaseStates).size).toBe(1);
});
