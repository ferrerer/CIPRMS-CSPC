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

// Gemini AI gate (2026-11 audit fix, test hygiene #15). This deployment's real .env has
// INSTITUTIONAL_AI_DATA_APPROVED=true, and before this fix nothing reset it for tests — every individual
// AI-related test file had to defensively save/delete/restore it itself (several already did; nothing
// enforced it for a new file that forgot to). Forced here, before any test file's `require('../cirl')`
// runs dotenv.config() — same "set it so dotenv can't override it" trick as MONGO_URI above (dotenv never
// touches a variable that is already defined, and an empty string counts as defined, so this also wins
// over a real key ever being added to .env, not just over today's absent one). isRealDataApprovedForGemini()
// only ever treats the exact string 'true' as approved, so 'false' here fails closed unconditionally.
process.env.INSTITUTIONAL_AI_DATA_APPROVED = 'false';
process.env.GEMINI_API_KEY = '';
