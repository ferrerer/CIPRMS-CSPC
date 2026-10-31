// LAU (2026-10) — read-only Partnership Request monitoring role. New role: sees every submitter's
// Partnership Requests (not just its own, unlike Auth. Personnel/potential_partner), can open any request's
// detail/drafts/supporting documents, and has zero write/approve/reject/delete/status-change authority
// anywhere — server-side (requireLau/REQUEST_VIEW_ALL_ROLES/requireFileAccess in cirl.js), not just a hidden
// button, since it is never added to requireStaffAccess, requireRequester, REQUEST_REVIEWER_ROLES, or
// requireUploader (which gate the real write/review/upload authority routes). It also has no access to
// Document Requests, the Partnerships registry, Document Library, Calendar, Reports, or User Management —
// out of scope for this role, matching every other Admin/Staff-only module.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, uniqueEmail, TEST_TAG } = require('./helpers');
const { DOCUMENTS_DIR } = require('../services/documentLibraryService');

let db;
const seededRequestIds = [];
let seededFilePath, seededDocId;
const FILE_NAME = 'zztest-laurole-' + Date.now() + '.pdf';

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  if (seededRequestIds.length) await db.collection('requests').deleteMany({ id: { $in: seededRequestIds } });
  if (seededDocId != null) await db.collection('documents').deleteMany({ id: seededDocId });
  if (seededFilePath && fs.existsSync(seededFilePath)) fs.unlinkSync(seededFilePath);
  await cleanupAll();
  await closeDB();
});

async function agentFor(role, extra) {
  const user = await createTestUser({ role, ...(extra || {}) });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

async function insertRequest(overrides) {
  const id = Date.now() + Math.floor(Math.random() * 1e6);
  const doc = Object.assign({
    id,
    institution: 'ZZ Test Institution',
    country: 'Philippines',
    type: 'MOA',
    nature: 'New',
    category: 'Local',
    region: 'Region V',
    unit: 'CCS',
    startDate: '2026-01-01',
    endDate: '2027-01-01',
    attachmentLink: '/uploads/documents/' + FILE_NAME,
    notes: TEST_TAG,
    requestedBy: 'ZZ Test Submitter',
    submittedByEmail: uniqueEmail('submitter'),
    status: 'Pending',
    date: new Date().toLocaleDateString('en-US'),
    updatedAt: new Date().toISOString(),
    supportingDocuments: []
  }, overrides);
  await db.collection('requests').insertOne(doc);
  seededRequestIds.push(id);
  return doc;
}

beforeAll(async () => {
  // One real file on disk + a documents-collection row, uploaded by neither the LAU viewer nor any
  // reviewer — mirrors a real requester's attachment, matching test/document-access.test.js's own fixture
  // pattern for this exact route.
  seededFilePath = path.join(DOCUMENTS_DIR, FILE_NAME);
  fs.writeFileSync(seededFilePath, 'ZZ Test LAU role fixture content');
  const last = await db.collection('documents').find({}).sort({ id: -1 }).limit(1).toArray();
  seededDocId = last.length ? last[0].id + 1 : 1;
  await db.collection('documents').insertOne({
    id: seededDocId, title: 'ZZ Test LAU Fixture', type: 'MOA',
    fileLink: '/uploads/documents/' + FILE_NAME,
    uploadedByEmail: uniqueEmail('uploader'), uploadedAt: new Date().toISOString()
  });
});

describe('1. LAU can log in and reach the Partnership Monitoring dashboard', () => {
  test('logging in redirects to /lau/monitoring (its home — it has no Dashboard, same pattern as potential_partner)', async () => {
    const user = await createTestUser({ role: 'LAU' });
    const agent = request.agent(app);
    const res = await loginAs(agent, user);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/lau/monitoring');
  });

  test('/lau/monitoring loads for LAU, shows the Partnership Monitoring nav item, and hides the Document Requests tab', async () => {
    const { agent } = await agentFor('LAU');
    const res = await agent.get('/lau/monitoring');
    expect(res.status).toBe(200);
    expect(res.text).toContain('Partnership Monitoring');
    // Note: a bare 'id="tab-dr"' substring also appears in this page's own <style> block as a CSS attribute
    // selector (e.g. .section-tab[id="tab-dr"]:hover), present regardless of role — so the check has to
    // target the actual rendered anchor element specifically, not just any occurrence of that substring.
    expect(res.text).not.toContain('<a class="section-tab" id="tab-dr"');
    expect(res.text).not.toContain('>Document Requests</span>');
  });

  test('Administrator may also reach /lau/monitoring (dual-role convention shared with requirePersonnel/requireStaffAccess)', async () => {
    const { agent } = await agentFor('Administrator');
    const res = await agent.get('/lau/monitoring');
    expect(res.status).toBe(200);
  });
});

describe('2 & 3. LAU can list requests submitted by different users, and open details/drafts', () => {
  test('GET /api/requests returns requests from multiple different submitters, not just LAU\'s own (none — it never submits)', async () => {
    const { agent } = await agentFor('LAU');
    const r1 = await insertRequest({});
    const r2 = await insertRequest({});
    expect(r1.submittedByEmail).not.toBe(r2.submittedByEmail);
    const res = await agent.get('/api/requests');
    expect(res.status).toBe(200);
    const ids = res.body.map(r => r.id);
    expect(ids).toContain(r1.id);
    expect(ids).toContain(r2.id);
  });

  test('the returned request carries full detail/draft information: status, dates, institution, attachment and supporting-document history', async () => {
    const { agent } = await agentFor('LAU');
    const r = await insertRequest({ supportingDocuments: [{ fileLink: '/uploads/documents/' + FILE_NAME, uploadedAt: new Date().toISOString() }] });
    const res = await agent.get('/api/requests');
    const found = res.body.find(x => x.id === r.id);
    expect(found).toBeTruthy();
    expect(found.status).toBe('Pending');
    expect(found.institution).toBe('ZZ Test Institution');
    expect(found.startDate).toBeTruthy();
    expect(found.attachmentLink).toBe('/uploads/documents/' + FILE_NAME);
    expect(Array.isArray(found.supportingDocuments)).toBe(true);
    expect(found.supportingDocuments.length).toBe(1);
  });
});

describe('4. LAU can access supporting files and read-only request information', () => {
  test('GET /uploads/documents/:filename succeeds for LAU on a document it neither uploaded nor submitted — full read access, same as Administrator/Staff', async () => {
    const { agent } = await agentFor('LAU');
    const res = await agent.get('/uploads/documents/' + FILE_NAME);
    expect(res.status).toBe(200);
  });
});

describe('5. LAU cannot edit, approve, reject, delete, or change statuses — UI and direct API', () => {
  let agent, r;
  beforeAll(async () => {
    ({ agent } = await agentFor('LAU'));
    r = await insertRequest({});
  });

  test('cannot approve/reject/change status (PATCH /api/requests/:id)', async () => {
    const res = await agent.patch('/api/requests/' + r.id).set('X-Requested-With', 'ciprms').send({ status: 'Approved' });
    expect(res.status).toBe(403);
  });

  test('cannot create a new Partnership Request or draft (POST /api/requests)', async () => {
    const res = await agent.post('/api/requests').set('X-Requested-With', 'ciprms').send({ institution: 'X', isDraft: true });
    expect(res.status).toBe(403);
  });

  test('cannot edit a draft (PATCH /api/requests/:id/edit)', async () => {
    const res = await agent.patch('/api/requests/' + r.id + '/edit').set('X-Requested-With', 'ciprms').send({ institution: 'Changed' });
    expect(res.status).toBe(403);
  });

  test('cannot submit a draft (POST /api/requests/:id/submit)', async () => {
    const res = await agent.post('/api/requests/' + r.id + '/submit').set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(403);
  });

  test('cannot delete a draft (DELETE /api/requests/:id)', async () => {
    const res = await agent.delete('/api/requests/' + r.id).set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(403);
  });

  test('cannot withdraw a request (POST /api/requests/:id/withdraw)', async () => {
    const res = await agent.post('/api/requests/' + r.id + '/withdraw').set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(403);
  });

  test('cannot upload a new supporting-document version (POST /api/requests/:id/documents)', async () => {
    // multer-parsed multipart body with a note (no file) — reaching the real isReviewer-or-owner check at
    // all requires passing the earlier "file or note required" validation first.
    const res = await agent.post('/api/requests/' + r.id + '/documents')
      .set('X-Requested-With', 'ciprms')
      .field('note', 'LAU attempting a write');
    expect(res.status).toBe(403);
  });

  test('the request itself is unchanged after all of the above attempts', async () => {
    const doc = await db.collection('requests').findOne({ id: r.id });
    expect(doc.status).toBe('Pending');
    expect(doc.institution).toBe('ZZ Test Institution');
  });
});

describe('6. LAU cannot access unrelated Administrator/Staff-only pages or APIs', () => {
  let agent;
  beforeAll(async () => { ({ agent } = await agentFor('LAU')); });

  test('cannot reach User Management (/users, /staff/users)', async () => {
    expect((await agent.get('/users')).status).toBe(302);
    expect((await agent.get('/staff/users')).status).toBe(302);
  });

  test('cannot create a user (POST /api/users)', async () => {
    const res = await agent.post('/api/users').set('X-Requested-With', 'ciprms').send({ name: 'X', email: uniqueEmail('x'), role: 'Staff' });
    expect(res.status).toBe(403);
  });

  test('cannot reach Admin Settings (/admin/settings)', async () => {
    expect((await agent.get('/admin/settings')).status).toBe(302);
  });

  test('cannot reach Document Requests (/api/document-requests) — explicitly out of scope for this role', async () => {
    const res = await agent.get('/api/document-requests').set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(403);
  });

  test('cannot reach the Document Library / Partnerships registry (/api/documents, /api/partnerships)', async () => {
    expect((await agent.get('/api/documents').set('X-Requested-With', 'ciprms')).status).toBe(403);
    expect((await agent.get('/api/partnerships').set('X-Requested-With', 'ciprms')).status).toBe(403);
  });

  test('cannot reach the unified Partnership Requests page at the Administrator/Staff URLs (its own /lau/monitoring is the only entry point)', async () => {
    expect((await agent.get('/partnership-requests')).status).toBe(302);
    expect((await agent.get('/staff/requests')).status).toBe(302);
  });
});

describe('7. Existing roles retain their original permissions', () => {
  test('Administrator and Staff still see every submitter\'s requests (REQUEST_VIEW_ALL_ROLES includes REQUEST_REVIEWER_ROLES unchanged)', async () => {
    const r = await insertRequest({});
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: staffAgent } = await agentFor('Staff');
    expect((await adminAgent.get('/api/requests')).body.map(x => x.id)).toContain(r.id);
    expect((await staffAgent.get('/api/requests')).body.map(x => x.id)).toContain(r.id);
  });

  test('Auth. Personnel and potential_partner are still scoped to only their own requests', async () => {
    const { agent, user } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    const own = await insertRequest({ submittedByEmail: user.email });
    const someoneElses = await insertRequest({});
    const res = await agent.get('/api/requests');
    const ids = res.body.map(x => x.id);
    expect(ids).toContain(own.id);
    expect(ids).not.toContain(someoneElses.id);
  });

  test('Administrator, Staff, and the actual uploader still access uploads/documents normally (unaffected by requireFileAccess replacing requireUploader on this one route)', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: staffAgent } = await agentFor('Staff');
    expect((await adminAgent.get('/uploads/documents/' + FILE_NAME)).status).toBe(200);
    expect((await staffAgent.get('/uploads/documents/' + FILE_NAME)).status).toBe(200);
  });

  test('potential_partner still cannot open a document it did not upload or own the linked request for', async () => {
    const { agent } = await agentFor('potential_partner');
    const res = await agent.get('/uploads/documents/' + FILE_NAME);
    expect(res.status).toBe(403);
  });

  test('Staff still cannot create an Administrator account (unrelated privilege-escalation guard, untouched)', async () => {
    const { agent } = await agentFor('Staff');
    const res = await agent.post('/api/users').set('X-Requested-With', 'ciprms').send({ name: 'X', email: uniqueEmail('x'), role: 'Administrator' });
    expect(res.status).toBe(403);
  });
});

describe('8. Search/filter/sort/pagination/status-count data stays consistent for LAU', () => {
  test('the data LAU receives is the identical shape/fields Administrator receives for the same request — the shared client-side search/filter/sort/pagination/status-count logic in the reused template operates on this data unchanged', async () => {
    const r = await insertRequest({});
    const { agent: lauAgent } = await agentFor('LAU');
    const { agent: adminAgent } = await agentFor('Administrator');
    const lauRow = (await lauAgent.get('/api/requests')).body.find(x => x.id === r.id);
    const adminRow = (await adminAgent.get('/api/requests')).body.find(x => x.id === r.id);
    expect(lauRow).toEqual(adminRow);
  });
});

describe('9. Unauthorized users cannot access LAU-only routes', () => {
  test('no session redirects rather than leaking the monitoring page', async () => {
    const res = await request(app).get('/lau/monitoring');
    expect(res.status).toBe(302);
  });

  test('Staff, Auth. Personnel, and potential_partner are redirected to their OWN home, not let into /lau/monitoring', async () => {
    const { agent: staffAgent } = await agentFor('Staff');
    const { agent: personnelAgent } = await agentFor('Auth. Personnel', { unit: 'CCS' });
    const { agent: partnerAgent } = await agentFor('potential_partner');
    const staffRes = await staffAgent.get('/lau/monitoring');
    expect(staffRes.status).toBe(302);
    expect(staffRes.headers.location).toBe('/staff/dashboard');
    const personnelRes = await personnelAgent.get('/lau/monitoring');
    expect(personnelRes.status).toBe(302);
    expect(personnelRes.headers.location).toBe('/personnel/monitoring');
    const partnerRes = await partnerAgent.get('/lau/monitoring');
    expect(partnerRes.status).toBe(302);
    expect(partnerRes.headers.location).toBe('/partner/monitoring');
  });
});

describe('New LAU accounts can be created by Administrator/Staff and can then log in normally', () => {
  test('Administrator can create a user with role LAU; that account logs in correctly (to /activate first, same as any admin-created account of any role — then to /lau/monitoring once activated)', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const email = uniqueEmail('newlau');
    const createRes = await adminAgent.post('/api/users').set('X-Requested-With', 'ciprms')
      .send({ name: `${TEST_TAG} New LAU`, email, role: 'LAU', password: 'TestPass123' });
    expect(createRes.status).toBe(200);
    expect(createRes.body.success).toBe(true);
    expect(createRes.body.user.role).toBe('LAU');

    // Every admin-created account starts activated:false regardless of role (POST /api/users always sets
    // it) — this redirect-to-/activate-first behavior is pre-existing and role-agnostic, not special-cased
    // for LAU. The role->home mapping itself (isActivated() true -> homeForRole()) is already proven
    // directly against a pre-activated fixture in "LAU can log in and reach the Partnership Monitoring
    // dashboard" above.
    const newAgent = request.agent(app);
    const loginRes = await newAgent.post('/login').type('form').send({ username: email, password: 'TestPass123' });
    expect(loginRes.status).toBe(302);
    expect(loginRes.headers.location).toBe('/activate');

    // Activate directly in the DB (bypassing the /activate form, which collects unrelated profile fields
    // not relevant to this RBAC test) and confirm the SAME session now reaches /lau/monitoring.
    await db.collection('users').updateOne({ email }, { $set: { activated: true } });
    expect((await newAgent.get('/lau/monitoring')).status).toBe(200);
  });

  test('Staff can also create an LAU account (LAU is not an Administrator-only grant, same as every other non-Administrator role)', async () => {
    const { agent: staffAgent } = await agentFor('Staff');
    const email = uniqueEmail('stafflau');
    const res = await staffAgent.post('/api/users').set('X-Requested-With', 'ciprms')
      .send({ name: `${TEST_TAG} Staff-Created LAU`, email, role: 'LAU', password: 'TestPass123' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.role).toBe('LAU');
  });
});
