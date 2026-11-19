// Read-only Document Library duplicate dry-run (2026-11, Document Library Duplicates investigation,
// revised for the supersede-not-delete dedup rewrite).
//
// Reports how many existing Partnership Request documents WOULD be marked superseded if
// supersedePreviousRequestDocuments() (services/documentLibraryService.js) were run over them — it never
// actually marks anything itself. NEVER deletes or modifies anything, not even an index. Same safe
// pattern as scripts/count-test-data.js: bypasses db.js (which refuses non-local URIs outside
// NODE_ENV=production) and talks to the driver directly so this can be pointed at ANY database, including
// production, without this script itself ever connecting there on its own — it only runs when explicitly
// invoked with --uri.
//
// Two distinct duplicate shapes are reported separately, because only one of them can be found by an
// exact query:
//   1. "Tagged" duplicates — more than one NON-superseded `documents` row sharing the same {requestId,
//      requestType: 'partnership'}. These predate the dedup fix (every upload path now marks every
//      earlier version superseded as soon as a new one is archived) — a dry run would keep the
//      highest-id row of each group as current and mark the rest superseded, same rule
//      supersedePreviousRequestDocuments() itself applies going forward. Nothing is ever deleted, in the
//      dry run or the real fix — a row already marked superseded is left out of this count entirely.
//   2. "Untagged" orphans — a `requests` row with an attachmentLink (the file OCR-confirmed before the
//      request itself existed) whose matching `documents` row has no requestId at all, because it was
//      archived before this fix added the retroactive-tagging step. These aren't "duplicates" of each
//      other by any exact field match (that's exactly the bug), so they're found by joining on fileLink
//      instead, and reported as a separate, smaller list — a cleanup would tag each one with its request's
//      id, not mark or delete anything.
//
// Usage:
//   node scripts/count-document-library-duplicates.js --uri "mongodb://127.0.0.1:27018/ciprms_test"
//   node scripts/count-document-library-duplicates.js --uri "<a real production connection string, if you choose to>"
const { MongoClient } = require('mongodb');

function parseUriArg(argv) {
  const idx = argv.indexOf('--uri');
  if (idx === -1 || !argv[idx + 1]) return null;
  return argv[idx + 1];
}

async function main() {
  const uri = parseUriArg(process.argv.slice(2));
  if (!uri) {
    console.error('Usage: node scripts/count-document-library-duplicates.js --uri "<mongodb connection string>"');
    console.error('Refuses to run without an explicit --uri — there is no MONGO_URI/.env fallback.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(`Connected. Database: ${db.databaseName} (the URI itself is never printed)`);
    console.log('Read-only — nothing is written, updated, or deleted.\n');

    // 1. Tagged duplicates: >1 NON-superseded documents row for the same {requestId, requestType:
    // 'partnership'}. A row already superseded is excluded from "would be marked" — it's already done.
    const taggedGroupsRaw = await db.collection('documents').aggregate([
      { $match: { requestType: 'partnership', requestId: { $ne: null }, superseded: { $ne: true } } },
      { $group: { _id: '$requestId', count: { $sum: 1 }, ids: { $push: '$id' } } },
      { $match: { count: { $gt: 1 } } },
      { $sort: { count: -1 } }
    ]).toArray();
    // Dry run of the exact rule supersedePreviousRequestDocuments() applies: within each group, the
    // highest id is kept as current; every other id in the group would be marked superseded.
    const taggedGroups = taggedGroupsRaw.map((g) => {
      const sortedIds = [...g.ids].sort((a, b) => b - a);
      return { requestId: g._id, current: sortedIds[0], wouldSupersede: sortedIds.slice(1) };
    });
    const wouldSupersedeTotal = taggedGroups.reduce((sum, g) => sum + g.wouldSupersede.length, 0);
    console.log(`Tagged duplicate groups (same requestId, >1 non-superseded Document Library row): ${taggedGroups.length}`);
    console.log(`  Rows a dry run would mark superseded (nothing deleted, kept the newest per group): ${wouldSupersedeTotal}`);
    if (taggedGroups.length) {
      console.log('  Sample (up to 10): ' + taggedGroups.slice(0, 10).map((g) => `request #${g.requestId} → keep ${g.current}, mark superseded ${g.wouldSupersede.join(',')}`).join(' | '));
    }

    // 2. Untagged orphans: requests.attachmentLink with no matching tagged documents row.
    const requestsWithAttachment = await db.collection('requests')
      .find({ attachmentLink: { $exists: true, $ne: null } }, { projection: { id: 1, attachmentLink: 1 } })
      .toArray();
    const orphans = [];
    for (const r of requestsWithAttachment) {
      const doc = await db.collection('documents').findOne({ fileLink: r.attachmentLink });
      if (doc && doc.requestId == null) orphans.push({ requestId: r.id, documentId: doc.id });
    }
    console.log(`\nUntagged orphans (request's attachment archived before it had a requestId tag): ${orphans.length}`);
    if (orphans.length) {
      console.log('  Sample (up to 10): ' + orphans.slice(0, 10).map(o => `request #${o.requestId} → document ${o.documentId}`).join(' | '));
    }

    console.log('\nCleanup proposal (not run by this script — a dry run only):');
    console.log('  - Tagged groups: for each, $set { superseded: true, supersededBy: <kept id>, supersededAt: now }');
    console.log('    on every id EXCEPT the one kept — nothing is ever deleted, so every version stays downloadable');
    console.log('    via its own existing fileLink and keeps working wherever it is already linked from.');
    console.log('  - Untagged orphans: just $set requestId/requestType on the matching documents row so future');
    console.log('    edits of that request can find it and mark it superseded in turn, instead of duplicating.');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Count failed:', err.message);
  process.exit(1);
});
