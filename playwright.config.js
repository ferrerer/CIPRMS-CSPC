// Playwright browser tests (2026-11 Dynamic College/Unit Dropdowns) — separate from the Jest/Supertest
// suite (`npm test`), which never touches a real browser. Run with `npm run test:e2e`.
//
// Drives a disposable server on its own port (3999, matching this project's established safe pattern for
// throwaway test servers — never the real dev server on 3000) against the same dedicated local TEST database
// the Jest suite uses (2026-10 authentication hardening, Phase 0 — this used to inherit the real MONGO_URI
// from .env). resolveTestDatabaseUri() throws before any server starts if that URI is not a loopback
// mongodb:// database whose name ends in "_test", and db.js refuses it again on its own under NODE_ENV=test.
// Specs still tag and clean up whatever they create, the same discipline test/helpers.js's cleanupAll()
// enforces for the Jest suite.
const path = require('path');
const { defineConfig } = require('@playwright/test');
const { resolveTestDatabaseUri } = require('./services/testDatabaseGuard');

// Central guard (2026-11, production-exposure audit follow-up) — see test/guard-preload.js's own comment
// for the full rationale. Appending to any NODE_OPTIONS already set (rather than overwriting) so this
// still composes if something else in the environment also sets it. Set before Playwright spawns
// anything below, so every worker and the webServer child both inherit it.
const GUARD_PRELOAD = path.join(__dirname, 'test', 'guard-preload.js');
process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ? process.env.NODE_OPTIONS + ' ' : ''}--require ${GUARD_PRELOAD}`;

const PORT = 3999;
const TEST_MONGO_URI = resolveTestDatabaseUri(process.env);

module.exports = defineConfig({
  testDir: './test/e2e',
  timeout: 45000,
  fullyParallel: false, // every spec shares the same real DB/server — sequential avoids cross-test races
  workers: 1,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure'
  },
  webServer: {
    command: 'node cirl.js',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: false,
    // 60s, not 30s (2026-11): connectDB() in db.js runs ~40+ sequential createIndex/duplicate-check round
    // trips before the DB-readiness gate opens — measured at ~20-22s end to end against this machine's
    // Docker Desktop Mongo container, which left the old 30s timeout flaky (timed out outright on several
    // consecutive runs while investigating an unrelated bug report).
    timeout: 60000,
    env: {
      PORT: String(PORT),
      NODE_ENV: 'test',
      MONGO_URI: TEST_MONGO_URI,
      // Same safe-collection convention test/setup-env.js enforces for the Jest suite — this server must
      // never read/write the organization's real Google Calendar/Docs connection.
      GOOGLE_CALENDAR_INTEGRATION_COLLECTION: 'jesttest_googleCalendarIntegration',
      GOOGLE_DOCS_INTEGRATION_COLLECTION: 'jesttest_googleDocsIntegration'
    }
  }
});
