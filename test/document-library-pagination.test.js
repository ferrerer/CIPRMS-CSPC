// Document Library server-side pagination (2026-11 panel recommendation). GET /api/documents is backward
// compatible by construction: omitting `page` still returns the exact plain array every existing caller
// (the Document Library's own facet fetch, the Select Existing Documents picker's scope=all fetch) already
// relies on — confirmed by the full regression pass in test/document-access.test.js and
// test/document-request-link-existing.test.js still passing unmodified. This file covers the NEW,
// strictly opt-in paginated shape: page/pageSize/totalCount, and that every existing filter dimension
// (type, nature tag, folder/archived, search) is preserved when relocated server-side.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { DOCUMENTS_DIR } = require('../services/documentLibraryService');

let db, agent, ownerEmail;
const seededDocIds = [];
const seededFiles = [];

function seedDoc(overrides) {
  const fname = `zztest-docpage-${Date.now()}-${Math.floor(Math.random() * 1e6)}.pdf`;
  const fpath = path.join(DOCUMENTS_DIR, fname);
  fs.writeFileSync(fpath, 'ZZ Test pagination fixture content');
  seededFiles.push(fpath);
  return (async () => {
    const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
    const id = last.length ? last[0].id + 1 : 1;
    await db.collection('documents').insertOne(Object.assign({
      id, title: 'ZZ Test Doc ' + id, type: 'MOA', institution: 'Testland Institute', partner: 'Testland Institute',
      fileLink: '/uploads/documents/' + fname, uploadedByEmail: ownerEmail, uploadedBy: 'Fixture',
      uploadedAt: new Date().toISOString(), archived: false, folderId: null, nature: 'Academic Exchange'
    }, overrides || {}));
    seededDocIds.push(id);
    return id;
  })();
}

beforeAll(async () => {
  db = await connectDB();
  const user = await createTestUser({ role: 'Staff' });
  ownerEmail = user.email;
  agent = request.agent(app);
  await loginAs(agent, user);

  // 15 plain records (for page-math) + a few distinct ones for filter checks.
  for (let i = 0; i < 15; i++) await seedDoc({ title: 'ZZ Test Bulk Doc ' + i });
  await seedDoc({ title: 'ZZ Test Archived Doc', archived: true });
  await seedDoc({ title: 'ZZ Test MOU Doc', type: 'MOU', nature: 'Research Collaboration' });
  await seedDoc({ title: 'ZZ Test Searchable Kyushu Doc', ocrText: 'Agreement with Kyushu University' });
});

afterAll(async () => {
  if (seededDocIds.length) await db.collection('documents').deleteMany({ id: { $in: seededDocIds } });
  seededFiles.forEach((p) => { if (fs.existsSync(p)) fs.unlinkSync(p); });
  await cleanupAll();
  await closeDB();
});

describe('Backward compatibility — omitting `page` changes nothing', () => {
  test('GET /api/documents with no page param still returns a plain array of everything in scope', async () => {
    const res = await agent.get('/api/documents');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body.length).toBeGreaterThanOrEqual(18); // all 18 seeded docs belong to this same owner
  });
});

describe('Paginated shape and page math', () => {
  test('page=1&pageSize=10 returns 10 records and the correct totalCount', async () => {
    const res = await agent.get('/api/documents?page=1&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.records.length).toBe(10);
    // 18 seeded, minus the 1 archived one — the default (no `folder` param) view excludes archived,
    // exactly like the original client-side filter's "anything but the literal 'archived' folder" rule.
    expect(res.body.totalCount).toBeGreaterThanOrEqual(17);
    expect(res.body.page).toBe(1);
    expect(res.body.pageSize).toBe(10);
  });

  test('page=2 returns the next slice, with no overlap against page=1', async () => {
    const p1 = await agent.get('/api/documents?page=1&pageSize=10');
    const p2 = await agent.get('/api/documents?page=2&pageSize=10');
    const ids1 = new Set(p1.body.records.map((d) => d.id));
    const ids2 = new Set(p2.body.records.map((d) => d.id));
    expect([...ids2].some((id) => ids1.has(id))).toBe(false);
  });

  test('an invalid pageSize falls back to the default (25) rather than erroring', async () => {
    const res = await agent.get('/api/documents?page=1&pageSize=999');
    expect(res.status).toBe(200);
    expect(res.body.pageSize).toBe(25);
  });

  test('a page past the end returns zero records, not an error', async () => {
    const res = await agent.get('/api/documents?page=9999&pageSize=10');
    expect(res.status).toBe(200);
    expect(res.body.records.length).toBe(0);
    expect(res.body.totalCount).toBeGreaterThan(0); // the collection isn't empty, this page just is
  });
});

describe('Filters preserved — same dimensions, now applied server-side', () => {
  test('type filter', async () => {
    const res = await agent.get('/api/documents?page=1&pageSize=50&type=MOU');
    expect(res.status).toBe(200);
    expect(res.body.records.every((d) => d.type === 'MOU')).toBe(true);
    expect(res.body.records.some((d) => d.title === 'ZZ Test MOU Doc')).toBe(true);
  });

  test('nature tag filter (MOA/MOU only)', async () => {
    const res = await agent.get('/api/documents?page=1&pageSize=50&tag=Research Collaboration');
    expect(res.status).toBe(200);
    expect(res.body.records.some((d) => d.title === 'ZZ Test MOU Doc')).toBe(true);
    expect(res.body.records.every((d) => d.nature === 'Research Collaboration')).toBe(true);
  });

  test('archived folder filter excludes non-archived, and vice versa', async () => {
    const archivedRes = await agent.get('/api/documents?page=1&pageSize=50&folder=archived');
    expect(archivedRes.body.records.every((d) => d.archived === true)).toBe(true);
    expect(archivedRes.body.records.some((d) => d.title === 'ZZ Test Archived Doc')).toBe(true);

    const defaultRes = await agent.get('/api/documents?page=1&pageSize=50&folder=all');
    expect(defaultRes.body.records.some((d) => d.title === 'ZZ Test Archived Doc')).toBe(false);
  });

  test('search matches title and OCR text, same as the client filter used to', async () => {
    const byTitle = await agent.get('/api/documents?page=1&pageSize=50&search=Searchable');
    expect(byTitle.body.records.some((d) => d.title === 'ZZ Test Searchable Kyushu Doc')).toBe(true);

    const byOcrText = await agent.get('/api/documents?page=1&pageSize=50&search=Kyushu');
    expect(byOcrText.body.records.some((d) => d.title === 'ZZ Test Searchable Kyushu Doc')).toBe(true);
  });
});

describe('Role scoping is applied before pagination, not bypassed by it', () => {
  test("a different Staff user's paginated fetch never includes this owner's documents", async () => {
    const otherAgent = request.agent(app);
    await loginAs(otherAgent, await createTestUser({ role: 'Staff' }));
    const res = await otherAgent.get('/api/documents?page=1&pageSize=50');
    expect(res.status).toBe(200);
    expect(res.body.records.some((d) => d.uploadedByEmail === ownerEmail)).toBe(false);
    expect(res.body.totalCount).toBe(0);
  });
});
