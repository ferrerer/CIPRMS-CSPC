// Loaded by Jest before every test file (jest.config.js -> setupFiles).

// Test-database isolation (2026-10 authentication hardening, Phase 0). The suites used to run against the
// REAL shared database (whatever MONGO_URI in .env pointed at). Every test process is now pointed at a
// dedicated local test database instead — TEST_MONGO_URI if set, otherwise the local Docker container
// started by `npm run test:db:up` — and refuses to start at all if that URI is not a loopback mongodb://
// address whose database name ends in "_test". Setting MONGO_URI here, before any test file loads db.js,
// also wins over .env: dotenv never overrides a variable that is already set. db.js re-checks the same rule
// on its own, so even a test that bypassed this file could not reach a real database.
const { resolveTestDatabaseUri } = require('../services/testDatabaseGuard');
process.env.MONGO_URI = resolveTestDatabaseUri(process.env);

// The Google integration services are pointed at throw-away collections for the whole test process. (This
// predates the separate test database above, from when the suites shared the real one and a test once wiped
// the organization's real Google Calendar connection; kept as defense in depth.)
process.env.GOOGLE_CALENDAR_INTEGRATION_COLLECTION = 'jesttest_googleCalendarIntegration';
// Same protection for the Google Docs connection (services/googleDocsService.js).
process.env.GOOGLE_DOCS_INTEGRATION_COLLECTION = 'jesttest_googleDocsIntegration';
