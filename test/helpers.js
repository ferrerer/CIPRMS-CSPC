// Shared test utilities. Tests run against a dedicated local test database
// (test/setup-env.js + services/testDatabaseGuard.js; start it with
// `npm run test:db:up`) — never the real MONGO_URI. Helpers still create with
// a unique, clearly-marked identity and clean up in the calling test's
// afterAll, so tests stay independent of each other within one run.
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const bcrypt = require('bcrypt');
const { connectDB, getDb } = require('../db');

const TEST_TAG = 'jesttest';

// loginLockouts/activitylogs rows created by an IP-scope lockout attempt have no account identity to carry
// a TEST_TAG — the attempt is, by definition, pre-identification (brute-force-protection.test.js,
// google-oauth-rate-limit.test.js). This is the COMPLETE, closed set of IP values the test suite's own
// source is grepped to ever produce, not a "looks like a test IP" guess:
//   - TEST_LOOPBACK_IPS: what Express's req.ip resolves to for an in-process supertest connection (confirmed
//     against every file that calls request(app) directly) — a real client, routed through Render's actual
//     proxy chain (app.set('trust proxy', 1)), can never present as one of these.
//   - TEST_SPOOFED_IPS: the exact 3 literal addresses test/google-oauth-rate-limit.test.js's own "IP
//     extraction depends on exactly one trusted hop" describe block spoofs via X-Forwarded-For — drawn from
//     RFC 5737 TEST-NET-3 (203.0.113.0/24), reserved by IANA specifically for documentation/example use and
//     never routable as a real address anywhere.
// Matching on this exact, finite list — combined with restricting to the specific auth-flow action types
// below — is an exact-value correlation to code that only exists in this test suite, not a resemblance
// heuristic on `by`/`email`/IP shape.
const TEST_LOOPBACK_IPS = ['::1', '::ffff:127.0.0.1', '127.0.0.1'];
const TEST_SPOOFED_IPS = ['203.0.113.10', '203.0.113.11', '203.0.113.12'];
const TEST_IPS = [...TEST_LOOPBACK_IPS, ...TEST_SPOOFED_IPS];
const TEST_AUTH_FLOW_ACTIONS = ['GOOGLE_AUTH_INITIATED', 'GOOGLE_AUTH_CALLBACK', 'LOGIN_FAILED', 'LOGIN_BLOCKED', 'LOGIN_SUCCESS'];

function uniqueEmail(label) {
  return `${TEST_TAG}.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

/**
 * Inserts a user directly into the DB (bypassing the signup form) so tests
 * can get a ready-to-login account of any role without exercising signup.
 */
async function createTestUser({ role = 'Staff', unit = '', password = 'TestPass123' } = {}) {
  const db = await connectDB();
  const email = uniqueEmail(role.toLowerCase().replace(/[^a-z]/g, ''));
  const last = await db.collection('users').find({}).sort({ id: -1 }).limit(1).toArray();
  const nextId = last.length ? last[0].id + 1 : 1;
  const hash = await bcrypt.hash(password, 10);
  await db.collection('users').insertOne({
    id: nextId,
    name: `${TEST_TAG} ${role}`,
    email,
    role,
    unit,
    login: 'Never',
    status: 'Active',
    password: hash,
    createdAt: TEST_TAG
  });
  return { id: nextId, email, password, role };
}

/** Logs a supertest agent in as the given user; the agent then carries the session cookie for subsequent requests. */
async function loginAs(agent, user) {
  const res = await agent.post('/login').type('form').send({ username: user.email, password: user.password });
  return res;
}

/**
 * Deletes every test-created user, and any partnerships/requests/activitylogs/
 * documents/notifications tagged with the jest test marker.
 *
 * documents and notifications were missing here entirely until this health-
 * check audit (2026-09-12) found ~295 orphaned `documents` records (101 with
 * a real file still on disk in uploads/documents/, plus 335 further orphaned
 * files with no DB record at all — a separate leak from tests that delete
 * their own document record but never unlink the underlying file) and ~800+
 * stray `notifications`, both accumulated silently across every previous test
 * run in this project's history since neither collection was ever swept by
 * this shared helper. Every OCR/document-library test creates its documents
 * through a real `uploadedByEmail` matching TEST_TAG (see createTestUser()'s
 * uniqueEmail()), so that field is a safe, reliable filter — and deleting the
 * physical file before the DB record (mirroring archiveToDocumentLibrary's
 * own directory) closes the second leak at its root for every caller of this
 * helper, regardless of whether that test's own cleanup already tried.
 *
 * The file deletions below are explicitly awaited (fs.promises.unlink, via
 * Promise.all) rather than the fire-and-forget fs.unlink(path, callback)
 * style used elsewhere in this codebase (e.g. ocrService.js) — that pattern
 * is fine in a long-running server process, but in a short-lived Jest
 * process this async function's caller (a test's afterAll) typically calls
 * closeDB() and returns immediately after, and the Node process can exit
 * before an un-awaited unlink's callback ever fires. Found live: 4 files
 * from a single test run stayed orphaned even though cleanupAll() logged
 * that it "deleted" them, because the unlink callbacks simply never got a
 * chance to run before the process terminated.
 */
async function cleanupAll() {
  const db = await connectDB();
  await db.collection('users').deleteMany({ createdAt: TEST_TAG });
  await db.collection('partnerships').deleteMany({ remarks: { $regex: TEST_TAG } });
  await db.collection('requests').deleteMany({ notes: { $regex: TEST_TAG } });
  // `record` alone misses logs whose actor was a jesttest user but whose
  // record text describes a differently-named fixture (e.g. "Partnership
  // added: Jest Report Filter University" — no literal "jesttest" substring
  // in the record text itself, only in `by`/`email`) — found via this same
  // health-check audit leaving 177 such logs behind after a full clean run.
  await db.collection('activitylogs').deleteMany({
    $or: [
      { record: { $regex: TEST_TAG, $options: 'i' } }, { by: { $regex: TEST_TAG, $options: 'i' } }, { email: { $regex: TEST_TAG, $options: 'i' } },
      // Pre-identification IP-scope rows (no account known yet, so none of the fields above ever match) —
      // see TEST_IPS's own comment above for why this exact-value match is reliable, not a resemblance guess.
      // Also requires a recognized auth-flow action, so this can never reach into an unrelated collection row
      // that happens to share one of these IPs for some other reason.
      { ip: { $in: TEST_IPS }, action: { $in: TEST_AUTH_FLOW_ACTIONS } }
    ]
  });

  // loginLockouts has no TEST_TAG-bearing field at all for an IP-scope entry (the key IS the IP), and was
  // never swept by this helper before (2026-10 Phase 0 baseline audit) — found 47 stray rows surviving a
  // fully clean, all-passing auth test run. Account-scope entries use uniqueEmail()'s own jesttest-prefixed
  // key, same as every other TEST_TAG-bearing field elsewhere in this function; IP-scope entries match the
  // same closed, exhaustively-enumerated TEST_IPS list as the activitylogs clause above.
  await db.collection('loginLockouts').deleteMany({
    $or: [
      { key: { $regex: '^' + TEST_TAG + '\\.', $options: 'i' } },
      { key: { $in: TEST_IPS } }
    ]
  });

  const testDocs = await db.collection('documents').find({ uploadedByEmail: { $regex: TEST_TAG, $options: 'i' } }).toArray();
  const documentsDir = path.join(__dirname, '..', 'uploads', 'documents');
  await Promise.all(testDocs.map((doc) => {
    if (!doc.fileLink || !doc.fileLink.startsWith('/uploads/documents/')) return null;
    const filePath = path.join(documentsDir, path.basename(doc.fileLink));
    return fsp.unlink(filePath).catch(() => {}); // best-effort — a missing file is not an error here
  }));
  await db.collection('documents').deleteMany({ uploadedByEmail: { $regex: TEST_TAG, $options: 'i' } });

  await db.collection('notifications').deleteMany({
    $or: [{ title: { $regex: TEST_TAG, $options: 'i' } }, { desc: { $regex: TEST_TAG, $options: 'i' } }, { targetEmail: { $regex: TEST_TAG, $options: 'i' } }]
  });
}

module.exports = { TEST_TAG, TEST_LOOPBACK_IPS, TEST_SPOOFED_IPS, TEST_IPS, TEST_AUTH_FLOW_ACTIONS, uniqueEmail, createTestUser, loginAs, cleanupAll, getDb, connectDB };
