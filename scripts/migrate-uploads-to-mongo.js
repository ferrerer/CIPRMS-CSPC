// One-time migration (2026-11 audit fix, Critical/High #3): copies existing Head-of-CIRL e-signature
// files (uploads/signatures/*) and profile avatar files (uploads/avatars/*) into MongoDB, where the app
// now reads and writes them exclusively (services/signatureService.js, cirl.js's avatar routes) —
// local disk is wiped on every Render redeploy, so any file left only there is eventually lost.
//
// SAFE BY DESIGN:
//   - Never deletes, moves, or modifies anything under uploads/ — every source file is left exactly
//     where it is. Re-run as many times as you like: a file whose MongoDB document already exists
//     (same _id = filename) is skipped, not overwritten.
//   - Bypasses db.js on purpose (same pattern as scripts/count-document-library-duplicates.js) so this
//     can be pointed at ANY database, including production, without ever connecting there on its own —
//     it only runs when explicitly given --uri. The URI itself is never printed.
//   - Pass --dry-run to see exactly what WOULD be inserted without writing anything.
//
// Usage:
//   node scripts/migrate-uploads-to-mongo.js --uri "mongodb://127.0.0.1:27018/ciprms_test" --dry-run
//   node scripts/migrate-uploads-to-mongo.js --uri "<a real production connection string, if you choose to>"
const fs = require('fs');
const path = require('path');
const { MongoClient, Binary } = require('mongodb');

const SIGNATURE_DIR = path.join(__dirname, '..', 'uploads', 'signatures');
const AVATAR_DIR = path.join(__dirname, '..', 'uploads', 'avatars');

const EXT_MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg' };

function parseArgs(argv) {
  const uriIdx = argv.indexOf('--uri');
  return {
    uri: uriIdx !== -1 ? argv[uriIdx + 1] : null,
    dryRun: argv.includes('--dry-run')
  };
}

function listUploadFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((name) => EXT_MIME[path.extname(name).toLowerCase()]);
}

// Signatures: the one file the `headsignature` pointer calls "current" has its real uploader/date on
// that document already — every OTHER file under uploads/signatures/ is an older, no-longer-current
// snapshot (still referenced by some Document Request's signatureFileIdAtCompletion) with no metadata
// beyond the file itself, so its mtime is used as the closest available uploadedAt.
async function migrateSignatures(db, dryRun) {
  const files = listUploadFiles(SIGNATURE_DIR);
  const current = await db.collection('headsignature').findOne({ _id: 'current' });
  let migrated = 0, skipped = 0, errored = 0;

  for (const filename of files) {
    try {
      const existing = await db.collection('signatureversions').findOne({ _id: filename }, { projection: { _id: 1 } });
      if (existing) { skipped++; continue; }

      const filePath = path.join(SIGNATURE_DIR, filename);
      const mimetype = EXT_MIME[path.extname(filename).toLowerCase()];
      const isCurrent = current && current.fileId === filename;
      const doc = {
        _id: filename,
        data: new Binary(fs.readFileSync(filePath)),
        mimetype,
        uploadedBy: isCurrent ? current.uploadedBy : 'Migrated from disk (uploader unknown — not the current signature at migration time)',
        uploadedByEmail: isCurrent ? current.uploadedByEmail : null,
        uploadedAt: isCurrent ? current.uploadedAt : fs.statSync(filePath).mtime.toISOString()
      };
      console.log(`  signatures/${filename} -> signatureversions${isCurrent ? ' (current)' : ''}${dryRun ? ' [dry run, not written]' : ''}`);
      if (!dryRun) await db.collection('signatureversions').insertOne(doc);
      migrated++;
    } catch (err) {
      console.error(`  ❌ ${filename}: ${err.message}`);
      errored++;
    }
  }
  return { found: files.length, migrated, skipped, errored };
}

// Avatars: find which user (if any) currently points its avatarUrl at this exact filename, to carry
// over a real uploadedBy email — an avatar whose owning user has since changed photos (or been
// deleted) just gets no uploadedBy, same as a signature snapshot with no known uploader.
async function migrateAvatars(db, dryRun) {
  const files = listUploadFiles(AVATAR_DIR);
  const users = await db.collection('users').find({ avatarUrl: { $regex: '^/uploads/avatars/' } }, { projection: { avatarUrl: 1, email: 1 } }).toArray();
  const ownerByFilename = new Map(users.map((u) => [u.avatarUrl.split('/').pop(), u.email]));
  let migrated = 0, skipped = 0, errored = 0;

  for (const filename of files) {
    try {
      const existing = await db.collection('avatars').findOne({ _id: filename }, { projection: { _id: 1 } });
      if (existing) { skipped++; continue; }

      const filePath = path.join(AVATAR_DIR, filename);
      const mimetype = EXT_MIME[path.extname(filename).toLowerCase()];
      const doc = {
        _id: filename,
        data: new Binary(fs.readFileSync(filePath)),
        mimetype,
        uploadedBy: ownerByFilename.get(filename) || null,
        uploadedAt: fs.statSync(filePath).mtime.toISOString()
      };
      console.log(`  avatars/${filename} -> avatars${dryRun ? ' [dry run, not written]' : ''}`);
      if (!dryRun) await db.collection('avatars').insertOne(doc);
      migrated++;
    } catch (err) {
      console.error(`  ❌ ${filename}: ${err.message}`);
      errored++;
    }
  }
  return { found: files.length, migrated, skipped, errored };
}

async function main() {
  const { uri, dryRun } = parseArgs(process.argv.slice(2));
  if (!uri) {
    console.error('Usage: node scripts/migrate-uploads-to-mongo.js --uri "<mongodb connection string>" [--dry-run]');
    console.error('Refuses to run without an explicit --uri — there is no MONGO_URI/.env fallback.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  try {
    await client.connect();
    const db = client.db();
    console.log(`Connected. Database: ${db.databaseName} (the URI itself is never printed)`);
    console.log(dryRun ? 'DRY RUN — nothing will be written.\n' : 'Live run — existing documents are skipped, nothing already migrated is overwritten, and no source file is ever deleted.\n');

    console.log('Signatures (uploads/signatures/):');
    const sig = await migrateSignatures(db, dryRun);
    console.log(`  found ${sig.found}, migrated ${sig.migrated}, already present (skipped) ${sig.skipped}, errored ${sig.errored}`);

    console.log('\nAvatars (uploads/avatars/):');
    const av = await migrateAvatars(db, dryRun);
    console.log(`  found ${av.found}, migrated ${av.migrated}, already present (skipped) ${av.skipped}, errored ${av.errored}`);

    console.log('\nDone. Source files under uploads/ were left untouched — safe to delete them yourself once you have confirmed the app reads correctly from MongoDB.');
  } finally {
    await client.close();
  }
}

main().catch((err) => {
  console.error('Migration failed:', err.message);
  process.exit(1);
});
