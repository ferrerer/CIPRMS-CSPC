// Read-only test-data count script (2026-11, production-exposure audit follow-up, proposal 4).
//
// Counts — NEVER deletes, NEVER writes anything, not even an index — every record matching the exact same
// "jesttest"-tag filters test/helpers.js's cleanupAll() uses to DELETE them, across every collection that
// function sweeps, plus partnershipactivities (a newer collection cleanupAll() itself does not yet cover).
// Exists so stray test data left behind by a misconfigured test run (see the 2026-11 audit that found six
// Playwright specs had been silently reaching the real database) can be found and reviewed WITHOUT
// touching anything, including against the real production database if that is what --uri names.
//
// Deliberately bypasses db.js entirely: that module creates indexes as a side effect of every connection
// and, as of this same audit, refuses to connect to a non-local URI without NODE_ENV=production — both
// wrong for a script whose whole point is a safe, read-only look at ANY database the caller explicitly
// names. This file talks to the driver directly instead, and only ever calls countDocuments().
//
// Usage:
//   node scripts/count-test-data.js --uri "mongodb://127.0.0.1:27018/ciprms_test"
//   node scripts/count-test-data.js --uri "<a real production connection string, if you choose to>"
//
// Refuses to run at all without an explicit --uri — there is no implicit MONGO_URI/.env fallback of any
// kind, so this can never accidentally run against whatever happens to be configured in the environment
// it's invoked from. The URI itself is never printed, only the resolved database name.
const { MongoClient } = require('mongodb');

const TEST_TAG = 'jesttest';
// Same closed, exhaustively-enumerated IP list test/helpers.js's cleanupAll() uses for pre-identification
// (no account yet) lockout/audit-log rows — see that file's own comment for exactly why these are safe:
// RFC 5737/RFC 3849/RFC 1918 reserved ranges this test suite's own source is the only thing that ever
// produces, never a real client's address.
const TEST_LOOPBACK_IPS = ['::1', '::ffff:127.0.0.1', '127.0.0.1'];
const TEST_SPOOFED_IPS = ['203.0.113.10', '203.0.113.11', '203.0.113.12', '203.0.113.21', '203.0.113.22', '2001:db8::4a2b'];
const TEST_MULTIHOP_IPS = ['203.0.113.50', '10.255.0.1', '10.255.0.2', '10.255.0.3', '10.255.0.9'];
const TEST_IPS = [...TEST_LOOPBACK_IPS, ...TEST_SPOOFED_IPS, ...TEST_MULTIHOP_IPS];
const TEST_AUTH_FLOW_ACTIONS = ['GOOGLE_AUTH_INITIATED', 'GOOGLE_AUTH_CALLBACK', 'LOGIN_FAILED', 'LOGIN_BLOCKED', 'LOGIN_SUCCESS'];

function parseUriArg(argv) {
  const idx = argv.indexOf('--uri');
  if (idx === -1 || !argv[idx + 1]) return null;
  return argv[idx + 1];
}

// Mirrors test/helpers.js's cleanupAll() filter-for-filter (kept in the same order/shape so the two are
// easy to diff against each other if cleanupAll() is ever changed) — the only difference is these are
// only ever passed to countDocuments(), never deleteMany().
function buildFilters() {
  return {
    users: { createdAt: TEST_TAG },
    partnerships: { remarks: { $regex: TEST_TAG } },
    requests: { notes: { $regex: TEST_TAG } },
    activitylogs: {
      $or: [
        { record: { $regex: TEST_TAG, $options: 'i' } },
        { by: { $regex: TEST_TAG, $options: 'i' } },
        { email: { $regex: TEST_TAG, $options: 'i' } },
        { ip: { $in: TEST_IPS }, action: { $in: TEST_AUTH_FLOW_ACTIONS } }
      ]
    },
    documents: { uploadedByEmail: { $regex: TEST_TAG, $options: 'i' } },
    notifications: {
      $or: [
        { title: { $regex: TEST_TAG, $options: 'i' } },
        { desc: { $regex: TEST_TAG, $options: 'i' } },
        { targetEmail: { $regex: TEST_TAG, $options: 'i' } }
      ]
    },
    // Not covered by cleanupAll() itself (added after that function was last updated) — included here
    // anyway since this script's job is to find everything that might be stray test data, not only what
    // cleanupAll() currently knows to delete. createdByEmail mirrors documents.uploadedByEmail's own
    // convention for "who, as a test fixture, wrote this".
    partnershipactivities: { createdByEmail: { $regex: TEST_TAG, $options: 'i' } }
  };
}

async function main() {
  const uri = parseUriArg(process.argv.slice(2));
  if (!uri) {
    console.error('Usage: node scripts/count-test-data.js --uri "<mongodb connection string>"');
    console.error('Refuses to run without an explicit --uri — there is no MONGO_URI/.env fallback.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(`Connected. Database: ${db.databaseName} (the URI itself is never printed)`);
    console.log('Counting records matching the "jesttest" tag cleanupAll() uses — read-only; nothing is written or deleted.\n');

    const filters = buildFilters();
    let total = 0;
    for (const [collection, filter] of Object.entries(filters)) {
      const count = await db.collection(collection).countDocuments(filter);
      total += count;
      console.log(`${collection.padEnd(22)} ${count}`);
    }
    console.log(`\nTotal matching records: ${total}`);
    if (total > 0) {
      console.log('\nThese are candidates for manual review before any cleanup. This script never deletes anything — if');
      console.log('any of these need to be removed, do that deliberately, not by assuming they are all safe to sweep.');
    }
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Count failed:', err.message);
  process.exit(1);
});
