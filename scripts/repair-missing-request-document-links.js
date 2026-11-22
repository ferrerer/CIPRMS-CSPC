// One-time repair (2026-11, "first uploaded file goes missing" investigation): a Partnership Request's
// initial attachment is archived to the Document Library via POST /api/ocr/confirm BEFORE the request
// itself exists (it has no id yet), then retroactively tagged with {requestId, requestType} once the
// request is created — but only on the two paths that actually run that retro-tag step (POST /api/requests
// when NOT a draft, and PATCH /api/requests/:id/edit when attachmentLink changes). POST
// /api/requests/:id/submit — submitting a previously-saved DRAFT whose attachmentLink was set at creation
// and never edited afterward — has NO equivalent step, so that one Document Library entry is left
// untagged forever: it still exists (nothing was deleted), it is still reachable by its own direct
// fileLink, but it never shows up grouped under its request in anything that queries `documents` by
// requestId.
//
// This finds every request whose attachmentLink names a document that either doesn't exist in the
// `documents` collection at all (file may still be on disk/Drive, but its record is gone — report only,
// never fabricated) or exists but isn't tagged to this request — and, in --live mode, tags the ones that
// do still have a document record. Nothing is ever deleted, moved, or re-uploaded.
//
// 2026-11 follow-up, two more checks added to this same script:
//
// (1) Wrongly-superseded documents (REPAIRABLE in --live mode). Before the type-aware fix,
// supersedePreviousRequestDocuments(db, requestId, requestType, currentDocumentId) matched every OTHER
// document sharing {requestId, requestType} regardless of its own `type` — so a genuinely different
// document (e.g. an Accreditation uploaded to a request that already had an MOA) got marked
// superseded/hidden from Document Library browsing even though it was never actually replaced. Any
// existing {superseded:true, supersededBy:X} pair where the current document's own `type` differs from
// document X's `type` can only be a relic of that old bug — the new logic never produces one. This finds
// those pairs and, in --live mode, reverses the incorrect flag (unsets superseded/supersededBy/
// supersededAt — the document was never deleted either way, so there is nothing else to restore).
//
// (2) Lost held uploads (REPORT ONLY — nothing this script can act on). A duplicate-matched upload is held
// entirely in memory (services/pendingUploadService.js's `pending` Map, or an OCR job in
// services/ocrService.js's `jobs` Map) until accepted, cancelled, or its own TTL sweep deletes it — neither
// path ever writes a database row or a log line for the hold itself (confirmed by reading both files: no
// console.* call anywhere near either TTL sweep). An upload that expired unresolved before the client-side
// fix therefore left NO trace anywhere — not in `documents`, not in activitylogs, not in any log file — by
// the exact design of the bug this whole investigation is about. This script cannot enumerate those past
// losses, and says so rather than guessing. The only DB-queryable proxy even worth reporting is a
// `documents` row missing its own `fileLink` (a genuinely incomplete record, for whatever reason) — listed
// below as a best-effort signal, not a confirmed count of lost uploads.
//
// SAFE BY DESIGN (same convention as scripts/backfill-achievements-to-document-library.js):
//   - --dry-run is the DEFAULT. Pass --live to actually write; otherwise this only reports counts/samples.
//   - Never touches a request's own fields, never touches a document's fileLink/file, never deletes
//     anything. The only writes this script ever makes are: setting documents.requestId/requestType on an
//     EXISTING document record that already matches the request's own attachmentLink exactly, and
//     unsetting superseded/supersededBy/supersededAt on a document wrongly superseded by the old
//     type-blind bug.
//   - Skips (not errors) anything already correct — safe to re-run.
//   - Bypasses db.js on purpose, so this can be pointed at ANY database, including production, without
//     ever connecting there on its own — it only runs when explicitly given --uri. The URI itself is
//     never printed.
//
// Usage:
//   node scripts/repair-missing-request-document-links.js --uri "mongodb://127.0.0.1:27018/ciprms_test"
//   node scripts/repair-missing-request-document-links.js --uri "<a real production connection string, if you choose to>" --live
const { MongoClient } = require('mongodb');

function parseArgs(argv) {
  const uriIdx = argv.indexOf('--uri');
  return { uri: uriIdx !== -1 ? argv[uriIdx + 1] : null, live: argv.includes('--live') };
}

async function main() {
  const { uri, live } = parseArgs(process.argv.slice(2));
  if (!uri) {
    console.error('Usage: node scripts/repair-missing-request-document-links.js --uri "<mongodb connection string>" [--live]');
    console.error('Refuses to run without an explicit --uri — there is no MONGO_URI/.env fallback. Defaults to a dry run; pass --live to actually write.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(`Connected. Database: ${db.databaseName} (the URI itself is never printed)`);
    console.log(live ? 'LIVE RUN — matching documents will be re-tagged.\n' : 'DRY RUN (default) — nothing will be written. Pass --live to actually repair.\n');

    const requests = await db.collection('requests')
      .find({ attachmentLink: { $exists: true, $ne: '' } })
      .toArray();

    let missingRecord = 0; // attachmentLink set, but no documents row has that fileLink at all
    let needsTag = 0;      // documents row exists, fileLink matches, but requestId isn't this request
    let alreadyFine = 0;
    const missingSamples = [], tagSamples = [];

    for (const r of requests) {
      const doc = await db.collection('documents').findOne({ fileLink: r.attachmentLink });
      if (!doc) {
        missingRecord++;
        if (missingSamples.length < 10) missingSamples.push(`#${r.id} "${r.institution}" (${r.attachmentLink})`);
        continue;
      }
      if (doc.requestId === r.id && doc.requestType === 'partnership') {
        alreadyFine++;
        continue;
      }
      needsTag++;
      if (tagSamples.length < 10) tagSamples.push(`#${r.id} "${r.institution}" -> documents #${doc.id}`);
      if (live) {
        await db.collection('documents').updateOne({ id: doc.id }, { $set: { requestId: r.id, requestType: 'partnership' } });
      }
    }

    console.log(`Requests with an attachment: ${requests.length}`);
    console.log(`  Already correctly tagged: ${alreadyFine}`);
    console.log(`  Document record exists but untagged (repairable): ${needsTag}`);
    if (tagSamples.length) console.log('  Sample: ' + tagSamples.join(' | '));
    console.log(`  No document record found at all (report only — never fabricated): ${missingRecord}`);
    if (missingSamples.length) console.log('  Sample: ' + missingSamples.join(' | '));
    if (!live && needsTag) console.log('  (dry run — re-run with --live to actually tag these)');
    else if (live) console.log(`  Re-tagged ${needsTag} document(s).`);

    // (1) Wrongly-superseded documents — repairable.
    console.log('\n--- Wrongly-superseded documents (old type-blind supersede bug) ---');
    const supersededDocs = await db.collection('documents').find({ superseded: true, supersededBy: { $exists: true, $ne: null } }).toArray();
    let wronglySuperseded = 0;
    const superSamples = [];
    for (const doc of supersededDocs) {
      const by = await db.collection('documents').findOne({ id: doc.supersededBy });
      if (!by) continue; // the document that supposedly superseded this one no longer exists — can't judge, skip
      if (by.type === doc.type) continue; // same type — a genuine version, correctly superseded
      wronglySuperseded++;
      if (superSamples.length < 10) superSamples.push(`#${doc.id} "${doc.title || doc.originalFilename || ''}" (${doc.type}) wrongly hidden by #${by.id} (${by.type})`);
      if (live) {
        await db.collection('documents').updateOne({ id: doc.id }, { $unset: { superseded: '', supersededBy: '', supersededAt: '' } });
      }
    }
    console.log(`Wrongly superseded (different type than what superseded them): ${wronglySuperseded}`);
    if (superSamples.length) console.log('  Sample: ' + superSamples.join(' | '));
    if (!live && wronglySuperseded) console.log('  (dry run — re-run with --live to un-supersede these)');
    else if (live) console.log(`  Un-superseded ${wronglySuperseded} document(s).`);

    // (2) Lost held uploads — report only, see the file-header comment for why this can't be a real count.
    console.log('\n--- Lost held uploads (report only — nothing to repair) ---');
    console.log('A duplicate hold lives only in memory (pendingUploadService/ocrService) until accepted,');
    console.log('cancelled, or its own TTL deletes it — neither path writes a database row or a log line,');
    console.log('so a past expired-and-never-resolved hold leaves NO trace to search for, by design.');
    const incompleteDocs = await db.collection('documents').find({ $or: [{ fileLink: { $exists: false } }, { fileLink: null }, { fileLink: '' }] }).toArray();
    console.log(`Best-effort proxy — document records missing their own fileLink (not a confirmed lost-upload count): ${incompleteDocs.length}`);
    if (incompleteDocs.length) console.log('  Sample: ' + incompleteDocs.slice(0, 10).map((d) => `#${d.id} "${d.title || ''}"`).join(' | '));

    if (!live && (needsTag || wronglySuperseded)) console.log('\nDry run only — re-run with --live to apply the repairable fixes above.');
    else if (live) console.log(`\nDone. Retagged ${needsTag}, un-superseded ${wronglySuperseded}. Nothing was moved, copied, or deleted.`);
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Repair failed:', err.message);
  process.exit(1);
});
