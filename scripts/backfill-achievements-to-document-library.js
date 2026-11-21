// One-time back-fill (2026-11, Institutional Achievements → Document Library archiving): every
// achievement created BEFORE this change has its file on uploads/achievements/ (or Google Drive) with no
// corresponding `documents` collection entry at all — new achievements get one automatically now (see
// POST/PATCH /api/achievements in cirl.js), but these legacy ones were never backfilled. This creates
// that missing Document Library entry for each one, WITHOUT touching the achievement's own existing
// file/storage in any way.
//
// SAFE BY DESIGN:
//   - --dry-run is the DEFAULT. Pass --live to actually write; otherwise this only reports counts and a
//     sample, like scripts/count-document-library-duplicates.js does.
//   - Never touches, moves, renames, or deletes the achievement's own file. The new `documents` entry's
//     fileLink points at the achievement's EXISTING fileLink (whatever path/host already serves it —
//     uploads/achievements/<name> or the Drive-backed route) — nothing is copied or re-uploaded.
//   - Only ever INSERTS a new `documents` row and sets achievements.documentId on the matching record;
//     never updates/deletes an existing `documents` row.
//   - Skips (not errors) any achievement that already has a documentId — safe to re-run.
//   - Bypasses db.js on purpose (same pattern as scripts/count-document-library-duplicates.js) so this
//     can be pointed at ANY database, including production, without ever connecting there on its own —
//     it only runs when explicitly given --uri. The URI itself is never printed.
//
// Usage:
//   node scripts/backfill-achievements-to-document-library.js --uri "mongodb://127.0.0.1:27018/ciprms_test"
//   node scripts/backfill-achievements-to-document-library.js --uri "<a real production connection string, if you choose to>" --live
const { MongoClient } = require('mongodb');

function parseArgs(argv) {
  const uriIdx = argv.indexOf('--uri');
  return {
    uri: uriIdx !== -1 ? argv[uriIdx + 1] : null,
    live: argv.includes('--live')
  };
}

// Mirrors documentLibraryService.shortDocType's own 'Achievements' branch and archiveToDocumentLibrary's
// buildDoc shape closely enough for this one-off use — intentionally NOT importing documentLibraryService
// directly, since archiveToDocumentLibrary expects a local temp file to move, which doesn't apply here
// (the achievement's file is left exactly where it already is).
async function nextDocumentId(db) {
  const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
  return last.length ? last[0].id + 1 : 1;
}

async function main() {
  const { uri, live } = parseArgs(process.argv.slice(2));
  if (!uri) {
    console.error('Usage: node scripts/backfill-achievements-to-document-library.js --uri "<mongodb connection string>" [--live]');
    console.error('Refuses to run without an explicit --uri — there is no MONGO_URI/.env fallback. Defaults to a dry run; pass --live to actually write.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(`Connected. Database: ${db.databaseName} (the URI itself is never printed)`);
    console.log(live ? 'LIVE RUN — missing Document Library entries will be created.\n' : 'DRY RUN (default) — nothing will be written. Pass --live to actually back-fill.\n');

    const candidates = await db.collection('achievements')
      .find({ fileLink: { $exists: true, $ne: null }, documentId: { $exists: false } })
      .toArray();

    console.log(`Achievements with a file but no Document Library entry: ${candidates.length}`);
    if (candidates.length) {
      console.log('Sample (up to 10): ' + candidates.slice(0, 10).map((a) => `#${a.id} "${a.title}" (${a.category})`).join(' | '));
    }
    if (!candidates.length) {
      console.log('\nNothing to back-fill.');
      return;
    }

    if (!live) {
      console.log('\nDry run only — re-run with --live to actually create these Document Library entries.');
      return;
    }

    let created = 0, errored = 0;
    for (const a of candidates) {
      try {
        const id = await nextDocumentId(db);
        const doc = {
          id,
          title: `${a.title} – ${a.category}`,
          type: 'Achievements',
          institution: null,
          partner: 'Unknown',
          validity: null,
          date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
          status: 'Active',
          fileLink: a.fileLink,
          driveFileId: a.driveFileId || null,
          tags: ['Achievements'],
          uploadedBy: a.createdBy || 'Unknown',
          uploadedByEmail: a.createdByEmail || null,
          uploadedAt: a.createdAt || new Date().toISOString(),
          originalFilename: a.originalFilename || null,
          fileType: a.fileType || null,
          achievementId: a.id
        };
        await db.collection('documents').insertOne(doc);
        await db.collection('achievements').updateOne({ id: a.id }, { $set: { documentId: id } });
        console.log(`  #${a.id} "${a.title}" -> documents #${id}`);
        created++;
      } catch (err) {
        console.error(`  ❌ #${a.id} "${a.title}": ${err.message}`);
        errored++;
      }
    }
    console.log(`\nDone. Created ${created} Document Library entries, ${errored} errored. No achievement file was moved, copied, or deleted.`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Back-fill failed:', err.message);
  process.exit(1);
});
