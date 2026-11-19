// Covers the 2026-07-28 IDP upgrade's duplicate-document detection
// (findPossibleDuplicates in services/documentLibraryService.js). Seeds real
// documents directly into the `documents` collection (same disposable-test
// pattern as test/document-library-workflow.test.js) rather than going
// through the OCR pipeline itself, since running real Tesseract OCR in every
// test run would be slow and this function only needs a DB + plain objects.
const { connectDB, closeDB } = require('../db');
const { findPossibleDuplicates } = require('../services/documentLibraryService');

let db;
let seededIds = [];

async function nextId() {
  const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
  return last.length ? last[0].id + 1 : 1;
}

beforeAll(async () => {
  db = await connectDB();
});

afterAll(async () => {
  if (seededIds.length) await db.collection('documents').deleteMany({ id: { $in: seededIds } });
  await closeDB();
});

test('flags a likely duplicate when institution and document type both match an existing record', async () => {
  const id = await nextId();
  await db.collection('documents').insertOne({
    id, title: 'ZZ Test MOA – Duplicate Detection University', type: 'MOA',
    institution: 'ZZ Test Duplicate Detection University', partner: 'ZZ Test Duplicate Detection University',
    fileLink: '/uploads/documents/zztest-existing.pdf', uploadedAt: new Date().toISOString(), originalFilename: 'zztest-existing.pdf'
  });
  seededIds.push(id);

  const result = await findPossibleDuplicates(db, {
    institution: 'ZZ Test Duplicate Detection University',
    partner: 'ZZ Test Duplicate Detection University',
    documentType: 'Memorandum of Agreement (MOA)'
  }, { originalName: 'a-completely-different-filename.pdf' });

  expect(result.found).toBe(true);
  expect(result.matches.length).toBeGreaterThan(0);
  expect(result.matches[0].id).toBe(id);
  expect(result.matches[0].reason).toMatch(/institution/);
});

test('does not flag an unrelated institution as a duplicate', async () => {
  const result = await findPossibleDuplicates(db, {
    institution: 'ZZ Test Totally Unrelated Institution That Does Not Exist',
    documentType: 'Memorandum of Agreement (MOA)'
  }, {});
  expect(result.found).toBe(false);
  expect(result.matches).toEqual([]);
});

test('a filename match alone (secondary signal) is not enough to flag a duplicate', async () => {
  const id = await nextId();
  await db.collection('documents').insertOne({
    id, title: 'ZZ Test Filename-Only Record', type: 'MOU',
    institution: 'ZZ Test Institution That Wont Match On Name',
    fileLink: '/uploads/documents/zztest-shared-name.pdf', uploadedAt: new Date().toISOString(),
    originalFilename: 'zztest-shared-name.pdf'
  });
  seededIds.push(id);

  const result = await findPossibleDuplicates(db, {
    institution: 'ZZ Test A Completely Different Institution Name'
  }, { originalName: 'zztest-shared-name.pdf' });

  expect(result.found).toBe(false);
});

test('returns no match when the extraction has neither institution/partner nor filename to compare', async () => {
  const result = await findPossibleDuplicates(db, { documentType: 'MOA' }, {});
  expect(result).toEqual({ found: false, matches: [] });
});

test('returns no match when extraction itself is null (OCR failed)', async () => {
  const result = await findPossibleDuplicates(db, null, { originalName: 'whatever.pdf' });
  expect(result).toEqual({ found: false, matchLevel: null, matches: [] });
});
