// test/helpers.js's cleanupAll() — IP-scope lockout/audit coverage (2026-10 Phase 0 follow-up). Root cause:
// a fully clean, all-passing run of the auth test suite still left 47 loginLockouts rows and dozens of
// pre-identification activitylogs rows (GOOGLE_AUTH_CALLBACK/INITIATED with no account known yet) behind in
// the isolated ciprms_test database, because neither collection was ever covered by cleanupAll() for an
// IP-scope entry (no TEST_TAG-bearing field exists before an account is identified). See helpers.js's own
// comment on TEST_IPS for why matching that exact, closed set of IP values (not `by`/`email`/IP-shape
// heuristics) is a reliable correlation to this test suite's own code, not a guess.
//
// Inserts synthetic documents directly (not through real HTTP/OAuth round trips) for determinism and speed —
// the shapes mirror exactly what services/loginLockoutService.js and cirl.js's logActivity() calls actually
// produce. Runs against the real, guarded ciprms_test database (same technique as test/login-lockout.test.js)
// — never production, verified below before any write.
const { connectDB, closeDB } = require('../db');
const { isSafeTestDatabaseUri } = require('../services/testDatabaseGuard');
const { cleanupAll, TEST_IPS, TEST_LOOPBACK_IPS, TEST_SPOOFED_IPS } = require('./helpers');

let db;

beforeAll(async () => {
  // Isolation re-check, same spirit as test/test-database-guard.test.js's own final describe block — this
  // file is write-enabled (inserts synthetic loginLockouts/activitylogs rows), so it re-proves the guard
  // immediately before doing so rather than only trusting setup-env.js ran correctly.
  expect(isSafeTestDatabaseUri(process.env.MONGO_URI)).toBe(true);
  db = await connectDB();
});

afterAll(async () => {
  await cleanupAll();
  await closeDB();
});

afterEach(async () => {
  // Belt-and-suspenders: remove anything this file itself inserted that cleanupAll() was never meant to
  // touch (the "unrelated, must survive" control rows), so one test's fixtures can never leak into another.
  await db.collection('loginLockouts').deleteMany({ key: { $in: ['198.51.100.5', 'realattacker@notatest.example'] } });
  await db.collection('activitylogs').deleteMany({ requestId: { $in: ['helpers-cleanup-control-1', 'helpers-cleanup-control-2'] } });
});

describe('cleanupAll() removes test-generated loginLockouts records, both account- and IP-scope', () => {
  test('an account-scope jesttest-tagged key and both IP-scope closed-set keys are deleted; unrelated keys survive', async () => {
    await db.collection('loginLockouts').insertMany([
      { scope: 'account', key: 'jesttest.helperscleanup.acct@example.com', failCount: 1, tier: 0, lockedUntil: null },
      { scope: 'ip', key: TEST_LOOPBACK_IPS[1], failCount: 1, tier: 0, lockedUntil: null }, // '::ffff:127.0.0.1'
      { scope: 'ip', key: TEST_SPOOFED_IPS[0], failCount: 1, tier: 0, lockedUntil: null }, // '203.0.113.10'
      // Controls — must NOT be touched: a non-tagged account key, and an IP outside the closed TEST_IPS set
      // (a different RFC 5737 block, 198.51.100.0/24, deliberately chosen to prove this isn't a broad
      // "looks like a documentation IP" match but the exact enumerated list).
      { scope: 'account', key: 'realattacker@notatest.example', failCount: 1, tier: 0, lockedUntil: null },
      { scope: 'ip', key: '198.51.100.5', failCount: 1, tier: 0, lockedUntil: null }
    ]);

    await cleanupAll();

    const remainingKeys = (await db.collection('loginLockouts').find({
      key: { $in: ['jesttest.helperscleanup.acct@example.com', TEST_LOOPBACK_IPS[1], TEST_SPOOFED_IPS[0], 'realattacker@notatest.example', '198.51.100.5'] }
    }).toArray()).map((d) => d.key);

    expect(remainingKeys).not.toContain('jesttest.helperscleanup.acct@example.com');
    expect(remainingKeys).not.toContain(TEST_LOOPBACK_IPS[1]);
    expect(remainingKeys).not.toContain(TEST_SPOOFED_IPS[0]);
    expect(remainingKeys).toContain('realattacker@notatest.example');
    expect(remainingKeys).toContain('198.51.100.5');
  });
});

describe('cleanupAll() removes test-generated, pre-identification IP-scope activitylogs rows', () => {
  test('rows with a closed-set test IP AND a recognized auth-flow action are deleted; everything else survives', async () => {
    // activitylogs carries db.js's id_unique index (2026-11 sequential-id race remediation) — each synthetic
    // row below needs its own distinct `id`, same as any real insert, rather than going through the real
    // insertWithNextId() helper (unnecessary here; these rows are never read by anything that cares about
    // sequential ordering).
    const baseId = -1 * Date.now(); // guaranteed never to collide with a real, positive sequential id
    await db.collection('activitylogs').insertMany([
      { id: baseId - 1, action: 'GOOGLE_AUTH_CALLBACK', record: 'Google OAuth callback received', by: 'Unknown', role: 'Unknown', email: null,
        category: 'Authentication', targetType: 'login_attempt', targetId: null, ip: TEST_LOOPBACK_IPS[1], requestId: 'helpers-cleanup-will-be-deleted-1' },
      { id: baseId - 2, action: 'LOGIN_BLOCKED', record: 'Sign-in rate-limited', by: 'Unknown', role: 'Unknown', email: null,
        category: 'Authentication', targetType: 'login_attempt', targetId: null, ip: TEST_SPOOFED_IPS[1], requestId: 'helpers-cleanup-will-be-deleted-2' },
      // Control 1 — same action/shape, but an IP OUTSIDE the closed set: must survive.
      { id: baseId - 3, action: 'GOOGLE_AUTH_CALLBACK', record: 'Google OAuth callback received', by: 'Unknown', role: 'Unknown', email: null,
        category: 'Authentication', targetType: 'login_attempt', targetId: null, ip: '198.51.100.9', requestId: 'helpers-cleanup-control-1' },
      // Control 2 — a test-set IP, but an action NOT in the recognized auth-flow list: must survive. Proves
      // the action-type restriction is actually doing work, not just the IP match alone.
      { id: baseId - 4, action: 'EDIT', record: 'Unrelated record that happens to share a test IP', by: 'Someone', role: 'Administrator', email: 'someone@example.com',
        category: 'User Management', targetType: 'user', targetId: null, ip: TEST_LOOPBACK_IPS[0], requestId: 'helpers-cleanup-control-2' }
    ]);

    await cleanupAll();

    const remaining = await db.collection('activitylogs').find({
      requestId: { $in: ['helpers-cleanup-will-be-deleted-1', 'helpers-cleanup-will-be-deleted-2', 'helpers-cleanup-control-1', 'helpers-cleanup-control-2'] }
    }).toArray();
    const remainingIds = remaining.map((d) => d.requestId);

    expect(remainingIds).not.toContain('helpers-cleanup-will-be-deleted-1');
    expect(remainingIds).not.toContain('helpers-cleanup-will-be-deleted-2');
    expect(remainingIds).toContain('helpers-cleanup-control-1');
    expect(remainingIds).toContain('helpers-cleanup-control-2');
  });
});

describe('cleanupAll() never touches the application\'s own seed data', () => {
  test('all 6 responsibleunits documents (and their exact identities) survive untouched', async () => {
    const before = await db.collection('responsibleunits').find({}).toArray();
    expect(before.length).toBe(6); // the app's own one-time bootstrap seed (db.js) — not test-created

    await cleanupAll();

    const after = await db.collection('responsibleunits').find({}).toArray();
    expect(after.length).toBe(6);
    expect(after.map((d) => d._id.toString()).sort()).toEqual(before.map((d) => d._id.toString()).sort());
  });
});

describe('cleanupAll() is idempotent', () => {
  test('calling it twice in a row deletes the same rows once and never throws on the second, now-empty pass', async () => {
    await db.collection('loginLockouts').insertOne({ scope: 'ip', key: TEST_SPOOFED_IPS[2], failCount: 1, tier: 0, lockedUntil: null }); // '203.0.113.12'

    await expect(cleanupAll()).resolves.toBeUndefined();
    const afterFirst = await db.collection('loginLockouts').countDocuments({ key: TEST_SPOOFED_IPS[2] });
    expect(afterFirst).toBe(0);

    // Second call against an already-clean state — must not error and must not affect unrelated data (spot
    // check: responsibleunits still exactly 6).
    await expect(cleanupAll()).resolves.toBeUndefined();
    const stillZero = await db.collection('loginLockouts').countDocuments({ key: TEST_SPOOFED_IPS[2] });
    expect(stillZero).toBe(0);
    expect(await db.collection('responsibleunits').countDocuments()).toBe(6);
  });
});
