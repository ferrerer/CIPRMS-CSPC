// Partner Monitoring / Partnership Request form (2026-09-21):
//   * a Partner only ever sees, and can only ever act on, its OWN requests and registry rows — enforced by
//     the server (checked here with direct API calls between two Partners), not by page filtering;
//   * the Agreement Type on a NEW request is MOA or MOU only, while older records that carry another
//     type are left exactly as they are;
//   * the Approval Progress panel shows Pending / In Progress / Approved / Closed (never "Rejected" as a
//     stand-in for Pending) and its buckets partition the Partner's requests.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, agents, users;
const requestIds = [], docRequestIds = [];

beforeAll(async () => {
  db = await connectDB();
  agents = {}; users = {};
  for (const [key, role, unit] of [['admin', 'Administrator', ''], ['staff', 'Staff', ''], ['college', 'Auth. Personnel', 'CCS'], ['partnerA', 'potential_partner', ''], ['partnerB', 'potential_partner', ''], ['partnerC', 'potential_partner', '']]) {
    users[key] = await createTestUser({ role, unit });
    agents[key] = request.agent(app);
    await loginAs(agents[key], users[key]);
  }
});
afterAll(async () => {
  if (requestIds.length) await db.collection('requests').deleteMany({ id: { $in: requestIds } });
  if (docRequestIds.length) await db.collection('documentrequests').deleteMany({ id: { $in: docRequestIds } });
  await db.collection('documents').deleteMany({ $or: [{ requestType: 'partnership', requestId: { $in: requestIds } }, { requestType: 'document', requestId: { $in: docRequestIds } }] });
  await cleanupAll();
  await closeDB();
});

async function newRequest(key, overrides) {
  const res = await agents[key].post('/api/requests').send({ institution: `jesttest Org ${key} ${Math.random().toString(36).slice(2, 8)}`, country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest', ...overrides });
  if (res.body && res.body.request) requestIds.push(res.body.request.id);
  return res;
}
// a request already in a given state, inserted directly (approval through the API has side effects — role changes, registry hand-off — that are not under test here)
async function insertRequest(key, fields) {
  const last = await db.collection('requests').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = (last[0] ? last[0].id : 0) + 1;
  await db.collection('requests').insertOne({ id, institution: 'jesttest inserted', country: 'Testland', type: 'MOA', nature: 'Research', notes: 'jesttest', requestedBy: `jesttest ${key}`, submittedByEmail: users[key].email, status: 'Pending', date: 'Sep 21, 2026', updatedAt: new Date().toISOString(), ...fields });
  requestIds.push(id);
  return id;
}

describe('a Partner sees only its own requests — enforced server-side', () => {
  let aReq, bReq, aDoc;
  beforeAll(async () => {
    aReq = (await newRequest('partnerA')).body.request.id;
    bReq = (await newRequest('partnerB')).body.request.id;
    const dr = await agents.partnerA.post('/api/document-requests').send({ institution: 'jesttest A MOA/MOU', documentTypes: ['MOA/MOU Submission'], notes: 'jesttest' });
    aDoc = dr.body.request.id; docRequestIds.push(aDoc);
  });

  test.each(['/api/requests', '/api/requests/mine'])('%s returns each Partner only its own requests', async (url) => {
    const a = (await agents.partnerA.get(url)).body.map(r => r.id), b = (await agents.partnerB.get(url)).body.map(r => r.id), c = (await agents.partnerC.get(url)).body.map(r => r.id);
    expect(a).toContain(aReq); expect(a).not.toContain(bReq);
    expect(b).toContain(bReq); expect(b).not.toContain(aReq);
    expect(c).not.toContain(aReq); expect(c).not.toContain(bReq);
    expect(a).toEqual([aReq]); expect(b).toEqual([bReq]); expect(c).toEqual([]);   // fresh accounts: nothing but their own
  });

  test('Administrator and CIRL Staff still see every Partner\'s request (unchanged)', async () => {
    for (const key of ['admin', 'staff']) {
      const ids = (await agents[key].get('/api/requests')).body.map(r => r.id);
      expect(ids).toEqual(expect.arrayContaining([aReq, bReq]));
    }
  });

  test('Partner B cannot act on Partner A\'s Partnership Request by calling the API directly', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
    expect((await agents.partnerB.post(`/api/requests/${aReq}/documents`).field('note', 'x').attach('document', png, 'x.png')).status).toBe(403);
    expect((await agents.partnerB.post(`/api/requests/${aReq}/withdraw`)).status).toBe(403);
    expect((await agents.partnerB.post(`/api/requests/${aReq}/submit`)).status).toBe(403);
    expect((await agents.partnerB.patch(`/api/requests/${aReq}/edit`).send({ notes: 'hijack' })).status).toBe(403);
    expect((await agents.partnerB.delete(`/api/requests/${aReq}`)).status).toBe(403);
    expect((await agents.partnerB.patch(`/api/requests/${aReq}`).send({ status: 'Approved' })).status).toBe(302);   // review is reviewer-only
    const still = await db.collection('requests').findOne({ id: aReq });
    expect(still.status).toBe('Pending');
    expect(still.notes).toBe('jesttest');
  });

  test('Partner B cannot read or act on Partner A\'s MOA/MOU submission (document request) either', async () => {
    expect((await agents.partnerB.get(`/api/document-requests/${aDoc}/pdf`)).status).toBe(403);
    expect((await agents.partnerB.get(`/document-requests/${aDoc}/print`)).status).toBe(403);
    expect((await agents.partnerB.delete(`/api/document-requests/${aDoc}`)).status).toBe(403);
    expect((await agents.partnerB.post(`/api/document-requests/${aDoc}/documents`).field('note', 'x')).status).toBe(403);
    expect((await agents.partnerB.get('/api/document-requests/mine')).body.some(r => r.id === aDoc)).toBe(false);
    expect((await agents.partnerA.get('/api/document-requests/mine')).body.some(r => r.id === aDoc)).toBe(true);
  });

  test('Partner A can still see and use its own', async () => {
    expect((await agents.partnerA.get('/api/requests/mine')).body.find(r => r.id === aReq).status).toBe('Pending');
    expect((await agents.partnerA.get(`/api/document-requests/${aDoc}/pdf`)).status).toBe(200);
  });
});

describe('the partnership registry feed is scoped for a Partner', () => {
  let instA, instB, pA, pB;
  beforeAll(async () => {
    instA = `jesttest Registry Org A ${Date.now()}`; instB = `jesttest Registry Org B ${Date.now()}`;
    const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
    pA = last[0].id + 1; pB = last[0].id + 2;
    await db.collection('partnerships').insertMany([
      { id: pA, inst: instA, country: 'Testland', type: 'MOA', start: '2026-01-01', end: '2031-01-01', status: 'Active', remarks: 'jesttest' },
      { id: pB, inst: instB, country: 'Testland', type: 'MOU', start: '2026-01-01', end: '2031-01-01', status: 'Active', remarks: 'jesttest' }
    ]);
    await insertRequest('partnerA', { institution: instA, status: 'Approved' });
    await insertRequest('partnerB', { institution: instB, status: 'Approved' });
  });
  afterAll(async () => { await db.collection('partnerships').deleteMany({ id: { $in: [pA, pB] } }); });

  test('GET /api/partnerships (the whole registry) gives a Partner only the rows tied to its own approved requests', async () => {
    const a = (await agents.partnerA.get('/api/partnerships')).body, b = (await agents.partnerB.get('/api/partnerships')).body, c = (await agents.partnerC.get('/api/partnerships')).body;
    expect(a.map(p => p.id)).toEqual([pA]);
    expect(b.map(p => p.id)).toEqual([pB]);
    expect(c).toEqual([]);
    expect((await agents.partnerA.get('/api/partnerships/mine')).body.map(p => p.id)).toEqual([pA]);
  });

  test('Administrator, CIRL Staff and College Dean keep the full registry feed (unchanged)', async () => {
    for (const key of ['admin', 'staff', 'college']) {
      const ids = (await agents[key].get('/api/partnerships')).body.map(p => p.id);
      expect(ids).toEqual(expect.arrayContaining([pA, pB]));
    }
  });

  test('Partner B cannot request a renewal of Partner A\'s partnership', async () => {
    const res = await agents.partnerB.post(`/api/partnerships/${pA}/renew-request`).send({ proposedEndDate: '2033-01-01' });
    expect(res.status).toBe(403);
  });

  test('no query string, id or institution name widens a Partner\'s feed — and the other Partner\'s data never appears in it', async () => {
    const probes = ['', `?inst=${encodeURIComponent(instB)}`, `?id=${pB}`, `?institution=${encodeURIComponent(instB)}`, '?all=true', '?email=' + encodeURIComponent(users.partnerB.email), '?limit=1000&skip=0', '?inst[$ne]=x', '?role=Administrator', '?page=1'];
    for (const q of probes) {
      const res = await agents.partnerA.get('/api/partnerships' + q);
      expect({ q, status: res.status }).toEqual({ q, status: 200 });
      expect({ q, ids: res.body.map(p => p.id) }).toEqual({ q, ids: [pA] });
      expect(JSON.stringify(res.body)).not.toContain(instB);
      const other = await agents.partnerB.get('/api/partnerships' + q.replace(instB, instA).replace(String(pB), String(pA)));
      expect({ q, ids: other.body.map(p => p.id) }).toEqual({ q, ids: [pB] });
      expect(JSON.stringify(other.body)).not.toContain(instA);
    }
  });

  test('only a Partner\'s APPROVED requests count — a Pending or Rejected request naming another org opens nothing', async () => {
    await insertRequest('partnerC', { institution: instA, status: 'Pending' });
    await insertRequest('partnerC', { institution: instB, status: 'Rejected' });
    await insertRequest('partnerC', { institution: instA.toUpperCase(), status: 'Draft' });
    expect((await agents.partnerC.get('/api/partnerships')).body).toEqual([]);
    expect((await agents.partnerC.get('/api/partnerships/mine')).body).toEqual([]);
  });

  test('a signed-out caller gets no registry, and a Partner cannot write to it', async () => {
    const anon = request(app);
    const res = await anon.get('/api/partnerships');
    expect(res.status).toBe(302);
    expect(Array.isArray(res.body)).toBe(false);
    const before = await db.collection('partnerships').findOne({ id: pA });
    expect((await agents.partnerA.post('/api/partnerships').send({ inst: 'jesttest partner write', country: 'Testland', type: 'MOA', start: '2026-01-01', end: '2031-01-01' })).status).toBe(302);
    expect((await agents.partnerA.patch(`/api/partnerships/${pA}`).send({ remarks: 'changed' })).status).toBe(302);
    expect((await agents.partnerA.patch(`/api/partnerships/${pB}`).send({ remarks: 'changed' })).status).toBe(302);
    expect((await agents.partnerA.delete(`/api/partnerships/${pB}`)).status).toBe(302);
    expect(await db.collection('partnerships').findOne({ id: pA })).toEqual(before);
    expect(await db.collection('partnerships').countDocuments({ id: pB })).toBe(1);
    expect(await db.collection('partnerships').countDocuments({ inst: 'jesttest partner write' })).toBe(0);
  });
});

describe('Agreement Type: MOA / MOU only', () => {
  test('the Partner form offers exactly MOA and MOU', async () => {
    const html = (await agents.partnerA.get('/partner/requests')).text;
    const select = html.match(/<select class="form-select" id="f-type">([\s\S]*?)<\/select>/)[1];
    const options = [...select.matchAll(/<option[^>]*>([^<]*)<\/option>/g)].map(m => m[1]);
    expect(options).toEqual(['Select…', 'MOA', 'MOU']);
    expect(html).toContain("IDP.mapDocumentType(r.documentType, ['MOA', 'MOU'])");
    expect(html).not.toMatch(/<option>(LOI|JVA)<\/option>/);
  });

  test('the server accepts MOA and MOU and refuses any other type on a new request or draft', async () => {
    expect((await newRequest('partnerA', { type: 'MOA' })).status).toBe(200);
    expect((await newRequest('partnerA', { type: 'MOU' })).status).toBe(200);
    for (const type of ['LOI', 'JVA', 'Other', 'moa ', 'MOA; DROP']) {
      const res = await newRequest('partnerA', { type });
      expect({ type, status: res.status }).toEqual({ type, status: 400 });
      expect(res.body.error).toMatch(/MOA, MOU/);
    }
    expect((await newRequest('partnerA', { type: 'LOI', isDraft: true })).status).toBe(400);
  });

  test('editing or submitting a draft enforces it too — but an older draft saved with LOI is not rewritten, just cannot be submitted until a supported type is chosen', async () => {
    const legacy = await insertRequest('partnerA', { institution: `jesttest legacy LOI ${Date.now()}`, type: 'LOI', status: 'Draft' });
    expect((await agents.partnerA.patch(`/api/requests/${legacy}/edit`).send({ type: 'JVA' })).status).toBe(400);
    expect((await db.collection('requests').findOne({ id: legacy })).type).toBe('LOI');      // untouched by the refused edit
    const submit = await agents.partnerA.post(`/api/requests/${legacy}/submit`);
    expect(submit.status).toBe(400);
    expect(submit.body.error).toMatch(/MOA or MOU/);
    expect((await agents.partnerA.patch(`/api/requests/${legacy}/edit`).send({ type: 'MOU' })).status).toBe(200);
    expect((await agents.partnerA.post(`/api/requests/${legacy}/submit`)).status).toBe(200);
  });

  test('historical records with other agreement types stay exactly as they are and stay visible to reviewers', async () => {
    const id = await insertRequest('partnerB', { institution: `jesttest historical JVA ${Date.now()}`, type: 'JVA', status: 'Approved' });
    const before = await db.collection('requests').findOne({ id });
    const adminList = (await agents.admin.get('/api/requests')).body;
    expect(adminList.find(r => r.id === id).type).toBe('JVA');
    expect((await agents.partnerB.get('/api/requests/mine')).body.find(r => r.id === id).type).toBe('JVA');
    expect(await db.collection('requests').findOne({ id })).toEqual(before);
  });
});

describe('Partner Monitoring: Approval Progress', () => {
  test('the Approval Progress panel was removed (it repeated the stat cards); the counters still use requestBuckets', async () => {
    const html = (await agents.partnerA.get('/partner/monitoring')).text;
    expect(html).toContain('function requestBuckets(list)');
    expect(html).not.toContain('id="approval-progress-body"');
    expect(html).not.toContain('<small class="text-muted">Rejected</small>');
    // the counters read the buckets
    expect(html).toContain("setCount('cnt-progress', b.review);");
    expect(html).toContain("setCount('cnt-approved', b.approved);");
  });

  test('every request status falls in exactly one bucket: the four buckets add up to the Total', () => {
    // the same logic the page runs (views/potential_partner/partner_monitoring.ejs -> requestBuckets)
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'views', 'potential_partner', 'partner_monitoring.ejs'), 'utf8');
    const body = src.match(/function requestBuckets\(list\) \{([\s\S]*?)\n    \}/)[1];
    const requestBuckets = new Function('list', body);
    const statuses = ['Pending', 'Pending', 'Under Review', 'Approved', 'Approved', 'Approved', 'Rejected', 'Withdrawn', 'Withdrawn'];
    const b = requestBuckets(statuses.map(status => ({ status })));
    expect(b).toEqual({ pending: 2, review: 1, approved: 3, closed: 3 });
    expect(b.pending + b.review + b.approved + b.closed).toBe(statuses.length);
    expect(requestBuckets([])).toEqual({ pending: 0, review: 0, approved: 0, closed: 0 });
  });
});
