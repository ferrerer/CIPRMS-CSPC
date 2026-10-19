const { MongoClient } = require('mongodb');

// 2026-09-06 security hardening (quick win): a missing MONGO_URI used to
// silently fall back to an unauthenticated local Mongo instance — a
// misconfigured deploy (env var never set, or NODE_ENV left unset/wrong)
// would fail open rather than fail loudly, potentially connecting to (or
// creating) the wrong database with no one noticing. The localhost fallback
// now requires an EXPLICIT local-dev/test declaration (NODE_ENV
// 'development' or 'test') — anything else, including NODE_ENV left unset
// entirely, refuses to start instead of guessing.
const NODE_ENV = process.env.NODE_ENV;
const LOCAL_FALLBACK_URI = 'mongodb://127.0.0.1:27017/ciprms';
let uri = process.env.MONGO_URI;
if (!uri) {
  if (NODE_ENV !== 'development' && NODE_ENV !== 'test') {
    throw new Error('MONGO_URI is not set. Refusing to start without an explicit database URI (set NODE_ENV=development locally to allow the localhost fallback).');
  }
  uri = LOCAL_FALLBACK_URI;
  console.warn(`⚠️  MONGO_URI is not set — using the local development fallback (${LOCAL_FALLBACK_URI}) because NODE_ENV=${NODE_ENV}.`);
}
// 2026-10 authentication hardening, Phase 0: an automated test run (Jest sets JEST_WORKER_ID; the Playwright
// server is started with NODE_ENV=test) may only ever touch a dedicated local test database. Before this, the
// suites simply inherited the real MONGO_URI from .env and wrote to the shared database. Fails closed: a test
// process with any other URI refuses to load this module at all. The URI itself is never printed.
if (NODE_ENV === 'test' || process.env.JEST_WORKER_ID) {
  const { isSafeTestDatabaseUri } = require('./services/testDatabaseGuard');
  if (!isSafeTestDatabaseUri(uri)) {
    throw new Error('Refusing to connect: test runs may only use a local MongoDB database whose name ends in "_test" (see services/testDatabaseGuard.js).');
  }
}
let client;
let db;

// Returns up to 20 { _id: <duplicated id value>, count } entries for a collection's `id` field — used to
// decide, before ever attempting a unique index on it, whether that collection can actually take one.
// MongoDB refuses to build a unique index over existing violations, so this is the check-first half of the
// 2026-11 sequential-id race-condition remediation below; kept as its own exported function so it can be
// proven correct against a throwaway collection without exercising all of connectDB()'s other startup work.
async function findDuplicateIds(db, collectionName) {
  return db.collection(collectionName).aggregate([
    { $group: { _id: '$id', count: { $sum: 1 } } },
    { $match: { count: { $gt: 1 } } },
    { $limit: 20 }
  ]).toArray();
}

async function connectDB() {
  if (db) return db;
  try {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db();
    console.log('✓ Connected to MongoDB successfully');
    // 2026-09-06 security hardening (Finding #4): every write path already
    // normalizes email to trim+lowercase before storing (login, signup,
    // /api/users), so a plain unique index is enough to close the
    // check-then-insert race between two near-simultaneous account
    // creations for the same email — confirmed clean against production
    // data before adding this (0 duplicates across existing users).
    // Non-fatal on failure (e.g. a transient disk-space/replica-set issue on
    // the MongoDB server) — the app must still start and serve traffic; the
    // findOne-based check in POST /api/users still catches the non-race
    // case either way. A failure here is logged loudly because it means
    // the race-condition guard from POST /api/users' duplicate-key handler
    // is not actually backed by an index until this succeeds.
    try {
      await db.collection('users').createIndex({ email: 1 }, { unique: true });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on users.email — duplicate-email race protection is NOT active:', indexErr.message);
    }
    // 2026-09-06 Monthly/Yearly Target Tracker: one target per (type, year,
    // month) — month is always explicitly null for a yearly target, so this
    // also enforces at most one yearly target per year. Same non-fatal
    // try/catch precedent as the users.email index above — the POST
    // /api/targets duplicate-key handler is the fallback if this can't be
    // created (e.g. the same disk-space constraint).
    try {
      await db.collection('targets').createIndex({ type: 1, year: 1, month: 1 }, { unique: true });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on targets — duplicate-target race protection is NOT active:', indexErr.message);
    }
    // 2026-09-19 automatic map location: cache of institution+country
    // geocoding answers (services/geocodingService.js), keyed so a repeated
    // lookup never hits the external provider twice. A brand-new collection —
    // this touches no existing record. Non-fatal on failure, same precedent as
    // above: without the unique index the cache still works (upserts by key),
    // it just can't guard against a duplicate-key race.
    try {
      await db.collection('geocodecache').createIndex({ key: 1 }, { unique: true });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on geocodecache.key:', indexErr.message);
    }
    // 2026-09-17 performance fix: every "get next sequential id" write path
    // in this app (partnerships, users, requests, documentrequests,
    // documentfolders, activitylogs, notifications, calendarevents, targets —
    // every `.find({}).sort({ id: -1 }).limit(1)` call in cirl.js) relied on
    // an unindexed full collection scan + in-memory sort to find the current
    // max id. Harmless while these collections were tiny, but activitylogs
    // (752 docs) and notifications (522 docs) have grown enough that this
    // was measurably slow over Atlas's network round-trip — reproduced as a
    // 15s Jest timeout on a test doing nothing more than 3 sequential
    // partnership inserts, each triggering a logActivity() call that
    // re-scanned the entire activitylogs collection. Same non-fatal
    // try/catch precedent as the indexes above: these are plain (non-unique)
    // indexes that only speed up the existing sort, so a failure to create
    // one just leaves that collection's writes at their current speed — it
    // never changes the nextId logic itself.
    for (const coll of ['partnerships', 'users', 'requests', 'documentrequests', 'documentfolders', 'activitylogs', 'notifications', 'calendarevents', 'targets', 'documents']) {
      try {
        await db.collection(coll).createIndex({ id: -1 });
      } catch (indexErr) {
        console.error(`⚠️  Could not create id index on ${coll} — nextId lookups on this collection remain unindexed:`, indexErr.message);
      }
    }
    // 2026-11 sequential-id race-condition remediation (Phase 2). Every "get next id" write path in cirl.js
    // — the same `.find({}).sort({ id: -1 }).limit(1)` pattern the perf indexes above speed up — is read-then-
    // insert: two requests that race each other can both read the same max id and both insert it. The
    // calendarevents fix below (2026-09-20) closed this for calendar events only, with a unique index plus a
    // retry-on-conflict loop at its one insert site; this extends the exact same pair (unique index here,
    // retry loop in cirl.js's new insertWithNextId()) to every other sequential-id collection.
    // A collection that already holds duplicate ids — from this very race, before this fix — cannot take a
    // unique index at all (MongoDB refuses to build one over existing violations), so each is checked first;
    // a dirty collection is skipped with a loud, specific warning rather than silently leaving the next
    // createIndex's generic failure as the only trace. (`requests`/`activitylogs`/`notifications` were
    // reconciled in a separate, approved, backed-up migration — see that migration's own report — and are
    // expected to pass this check cleanly now. `documents` (2026-11 Phase 3) was the one sequential-id
    // collection this list originally missed; confirmed zero existing duplicates before adding it here. A
    // collection skipped here is not retry-protected until its duplicates are resolved and the app restarts.)
    for (const coll of ['partnerships', 'requests', 'documentrequests', 'documentfolders', 'responsibleunits', 'users', 'activitylogs', 'notifications', 'googleDocs', 'targets', 'documents']) {
      try {
        const dupes = await findDuplicateIds(db, coll);
        if (dupes.length) {
          console.error(`⚠️  ${coll} already has ${dupes.length} duplicate id value(s) (${dupes.map(d => d._id).join(', ')}) — skipping its unique id index until these are resolved. Concurrent-insert protection for ${coll} is NOT active.`);
          continue;
        }
        await db.collection(coll).createIndex({ id: 1 }, { unique: true, name: 'id_unique' });
      } catch (indexErr) {
        console.error(`⚠️  Could not create unique index on ${coll}.id — concurrent-create duplicate protection is NOT active:`, indexErr.message);
      }
    }
    // 2026-09-20 calendar duplicate-event protection. Two writes that race
    // each other (a double-clicked Save, a retried request, two Administrators
    // creating an event in the same instant) used to be able to insert two
    // calendar events — the "next id" lookup above is read-then-insert, so both
    // saw the same max id. A unique `id` makes the second insert fail (the
    // route retries with a fresh id), and a unique `clientRequestId` (a token
    // the browser generates once per Save/drop) makes a repeated request for
    // the SAME action return the event it already created instead of a second
    // one. The clientRequestId index is partial: pre-existing events carry no
    // token and are not indexed. Verified free of duplicate ids beforehand;
    // same non-fatal precedent as the indexes above.
    try {
      await db.collection('calendarevents').createIndex({ id: 1 }, { unique: true, name: 'id_unique' });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on calendarevents.id — concurrent-create duplicate protection is NOT active:', indexErr.message);
    }
    try {
      await db.collection('calendarevents').createIndex(
        { clientRequestId: 1 },
        { unique: true, name: 'clientRequestId_unique', partialFilterExpression: { clientRequestId: { $type: 'string' } } }
      );
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on calendarevents.clientRequestId — repeated-request duplicate protection is NOT active:', indexErr.message);
    }
    // 2026-09-22 Administrator/CIRL Staff global search (services/searchService.js). `documents.ocrText` can run to
    // tens of thousands of characters per record (a whole scanned MOA/MOU) — a text index is what lets a keyword
    // search of that content use an actual index instead of a full collection scan of every stored document. The
    // short metadata fields are folded into the same index so a single $text query can also match on them; the
    // search service additionally runs a plain regex over those same short fields for substrings a stemmed word
    // index wouldn't catch ("Univ" -> "University") — the two result sets are merged, so this index only needs to
    // carry the "search the actual document content" half of the feature. Non-fatal on failure, same precedent as
    // every index above: without it, searchDocuments() falls back to its regex-only metadata match.
    try {
      await db.collection('documents').createIndex(
        { ocrText: 'text', title: 'text', originalFilename: 'text', institution: 'text', partner: 'text', type: 'text', country: 'text', nature: 'text', searchKeywords: 'text' },
        { name: 'documents_search_text', weights: { title: 5, originalFilename: 4, institution: 4, partner: 4, searchKeywords: 3, type: 2, country: 2, nature: 2, ocrText: 1 } }
      );
    } catch (indexErr) {
      console.error('⚠️  Could not create text index on documents — OCR-content search will fall back to metadata-only matching:', indexErr.message);
    }
    // 2026-10-21 Audit Trail / login-attempt logging investigation. `activitylogs` had only the generic
    // { id: -1 } index above (for the nextId lookup) — every one of its own real query patterns was an
    // unindexed collection scan. `email` is the most-hit of these: every single CIRL Staff page load of the
    // Audit Trail already filters by it (activityLogFilterFor()), which existed well before this change — not
    // a new query this feature introduces, just the first time anyone indexed it. `timestamp` is new with
    // this change (the collection previously had no real Date field to range-filter by at all — `date` is a
    // display-only locale string); `action`, `category` and `status` back the Audit Trail UI's filter
    // dropdowns, now including the new login/security events. Plain, non-unique, same non-fatal precedent as
    // every index above — a failure here only leaves these queries at their current (unindexed) speed.
    for (const spec of [{ timestamp: -1 }, { action: 1 }, { category: 1 }, { email: 1 }, { status: 1 }]) {
      try {
        await db.collection('activitylogs').createIndex(spec);
      } catch (indexErr) {
        console.error(`⚠️  Could not create index ${JSON.stringify(spec)} on activitylogs:`, indexErr.message);
      }
    }
    // 2026-11 Responsible Unit investigation: the Add/Edit Partnership form's "Responsible Unit" field used
    // to be a closed set hardcoded in cirl.js (VALID_PARTNERSHIP_UNITS) and separately in
    // registry-gridjs.init.js's own UNIT_OPTIONS — nobody could add a legitimately-missing unit without a
    // code change. Seeded here, once, with that exact original list, so every existing partnership's stored
    // `unit` value keeps validating with zero migration — this only ever runs when the collection is
    // genuinely empty (a brand-new deployment, or this feature's very first run against an existing one),
    // never overwrites or re-seeds an already-populated collection.
    try {
      const existingUnitCount = await db.collection('responsibleunits').countDocuments();
      if (existingUnitCount === 0) {
        const seedUnits = ['CCS', 'CILS', 'CETE', 'CNAS', 'CAMS', 'CIRL'];
        await db.collection('responsibleunits').insertMany(
          seedUnits.map((name, i) => ({ id: i + 1, name, createdAt: new Date().toISOString(), createdByEmail: null }))
        );
        console.log(`✓ Seeded ${seedUnits.length} default Responsible Units`);
      }
    } catch (seedErr) {
      console.error('⚠️  Could not seed default Responsible Units:', seedErr.message);
    }
    // Case-insensitive uniqueness at the DB level too (defense in depth under the application-level check
    // in POST /api/responsible-units) — a collation of strength 2 treats "CIRL"/"Cirl"/"cirl" as the same
    // key for this index's purposes without needing a separate lowercased field.
    try {
      await db.collection('responsibleunits').createIndex({ name: 1 }, { unique: true, collation: { locale: 'en', strength: 2 } });
    } catch (indexErr) {
      console.error('⚠️  Could not create unique index on responsibleunits.name — duplicate-name race protection is NOT active:', indexErr.message);
    }
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    throw error;
  }
}

function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call connectDB first.');
  }
  return db;
}

async function closeDB() {
  if (client) {
    await client.close();
    client = undefined;
    db = undefined;
  }
}

// 2026-11 sequential-id race-condition remediation (Phase 2). Every "get next id" write path across cirl.js
// and services/notificationService.js (partnerships, requests, documentrequests, documentfolders,
// responsibleunits, users, activitylogs, notifications, googleDocs, targets — every `.find({}).sort({id:-1})
// .limit(1)` call) used to read the current max id and insert right after it, with nothing stopping two
// near-simultaneous requests from both reading the same max and both inserting the same id. Same fix POST
// /api/calendarevents already used for its own insert (2026-09-20): a unique index on `id` (createIndex
// calls above) makes the LOSER of that race fail with a duplicate-key error instead of silently succeeding,
// and this retry loop is how it recovers — reread the (now higher) max id and try again. Lives here, not in
// cirl.js, because services/notificationService.js's createNotification() needs it too and this is the one
// module both already require. `collection` is the actual Collection object (not a name), so this also works
// for googleDocsService's docsCollection(db), whose name can differ in tests.
// maxAttempts=5 (this function's first version) sounded generous but wasn't: under genuine N-way concurrency
// (proved in test/sequential-id-race.test.js with 30 truly simultaneous inserts, and even just 8-10 over a
// real Atlas round trip) most callers are still in flight — reading the same "last id" — when the first one
// commits, so a whole batch can collide and re-collide within the same few milliseconds. 20 attempts plus a
// small random backoff before each retry (so losers don't all re-read and re-collide in lockstep again) is
// what actually converges at that scale; still bounded, never an infinite retry.
async function insertWithNextId(collection, buildEntry, { maxAttempts = 20 } = {}) {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 25) + 5));
    const last = await collection.find({}).sort({ id: -1 }).limit(1).toArray();
    const nextId = last.length ? (last[0].id || 0) + 1 : 1;
    const entry = buildEntry(nextId);
    try {
      await collection.insertOne(entry);
      return entry;
    } catch (err) {
      // Only an id collision is retryable by picking a fresh id — any other unique-index violation (email,
      // responsible-unit name, target period, calendarevents' own id) is the caller's own duplicate to
      // report, never ours to paper over by quietly trying a different id.
      const isIdCollision = err && err.code === 11000 && err.keyPattern && Object.prototype.hasOwnProperty.call(err.keyPattern, 'id');
      if (!isIdCollision) throw err;
    }
  }
  throw new Error(`Could not allocate an id for a new record in ${collection.collectionName} after ${maxAttempts} attempts — it may be under unusually heavy concurrent writes.`);
}

// Batch counterpart to insertWithNextId(), for a single call that inserts many docs at once — a real path in
// this app (POST /api/calendarevents with no specific recipients picked notifies every active user; measured
// against this project's own database at 58 users). A per-recipient loop calling insertWithNextId() once each
// is the simple fix and was tried first, but it means one find()+insertOne() round trip PER recipient — timed
// at ~9 extra seconds for that same 58-recipient broadcast, enough to blow a 15s test timeout and a real,
// user-facing delay on every "notify all users" calendar event. This reserves a whole block of ids and
// inserts it in ONE round trip instead; on a collision (another writer took part of the block first) it
// keeps whatever prefix already landed — ordered inserts stop at the first failure, so recovering from it
// means retrying only the stragglers that never made it in, not re-inserting everyone a second time.
// `buildDoc(id, index)` builds the doc for position `index` (0-based across the whole logical batch) once it
// has been assigned `id`.
async function insertManyWithNextId(collection, count, buildDoc, { maxAttempts = 20 } = {}) {
  if (count <= 0) return [];
  let startIndex = 0; // how many docs, counting from the front, have already been safely inserted
  const insertedDocs = [];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise(resolve => setTimeout(resolve, Math.floor(Math.random() * 25) + 5));
    const last = await collection.find({}).sort({ id: -1 }).limit(1).toArray();
    let nextId = last.length ? (last[0].id || 0) + 1 : 1;
    const batch = [];
    for (let i = startIndex; i < count; i++) batch.push(buildDoc(nextId++, i));
    try {
      await collection.insertMany(batch, { ordered: true });
      insertedDocs.push(...batch);
      return insertedDocs;
    } catch (err) {
      // An ordered insertMany stops at its first failing document, so there is ever only one entry in
      // writeErrors — its errmsg names the violated index (every id index created above is named
      // 'id_unique'). Anything else (a different unique index on this collection) is the caller's own
      // duplicate to report, never ours to paper over by retrying with different ids.
      const onlyIdIndexViolated = err && err.code === 11000 && err.result && typeof err.result.insertedCount === 'number' &&
        err.writeErrors && err.writeErrors.length === 1 && /\bid_unique\b/.test(err.writeErrors[0].errmsg || '');
      if (!onlyIdIndexViolated) throw err;
      insertedDocs.push(...batch.slice(0, err.result.insertedCount));
      startIndex += err.result.insertedCount;
    }
  }
  throw new Error(`Could not allocate ids for a batch insert into ${collection.collectionName} after ${maxAttempts} attempts — it may be under unusually heavy concurrent writes.`);
}

module.exports = { connectDB, getDb, closeDB, insertWithNextId, insertManyWithNextId, findDuplicateIds };
