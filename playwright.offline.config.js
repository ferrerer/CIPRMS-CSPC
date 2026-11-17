// Offline Playwright config (2026-11) — no webServer, no MongoDB. Used for specs that render the real
// EJS markup via page.setContent() and mock window.CIPRMS.api, to verify pure client-side behavior
// without depending on the Docker test-database container. Run with:
//   npx playwright test --config=playwright.offline.config.js test/e2e/<name>-offline.spec.js
// Does not replace playwright.config.js (which `npm run test:e2e` still uses for every DB-backed spec).
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './test/e2e',
  testMatch: /-offline\.spec\.js$/,
  timeout: 30000,
  fullyParallel: false,
  workers: 1,
  reporter: [['list']]
});
