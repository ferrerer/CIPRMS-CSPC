// Admin/Staff-Initiated Partnership Requests to Partners (2026-11) — Administrator and Staff can START a
// Partnership Request addressed to a chosen partner (POST /api/requests with initiatedBy:'institution',
// targetPartnerId). From that point on it is stored in the SAME requests collection and flows through the
// exact same Admin/Staff review/approval workflow as a partner-submitted request — the target partner
// becomes its owner of record (requestedBy/submittedByEmail), sees it in their own Requests/Monitoring
// views, and can upload supporting documents to it until approved, exactly as if they had started it
// themselves. The partner never approves anything; LAU reviews stay hidden from them; the post-approval
// upload lock still applies. See cirl.js's requireRequesterOrInstitutionInitiator and the institutionInitiated
// branch inside POST /api/requests.
const request = require('supertest');
const fs = require('fs');
const os = require('os');
const path = require('path');
const sharp = require('sharp');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

let db;
const requestIds = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  await db.collection('requests').deleteMany({ id: { $in: requestIds } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(user) {
  const agent = request.agent(app);
  await loginAs(agent, user);
  return agent;
}

let institutionCounter = 0;
function basePayload(overrides) {
  institutionCounter += 1;
  return {
    institution: `${TEST_TAG} Initiated University ${institutionCounter}`,
    country: 'Testland',
    type: 'MOA',
    nature: 'Research',
    notes: TEST_TAG,
    ...overrides
  };
}

describe('Admin/Staff-Initiated Partnership Requests to Partners', () => {
  let admin, staff, partnerA, partnerB, deanAuthPersonnel, lau;

  beforeAll(async () => {
    admin = await createTestUser({ role: 'Administrator' });
    staff = await createTestUser({ role: 'Staff' });
    partnerA = await createTestUser({ role: 'potential_partner' });
    partnerB = await createTestUser({ role: 'potential_partner' });
    deanAuthPersonnel = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    lau = await createTestUser({ role: 'LAU' });
  });

  test('(a) Administrator can create a request addressed to a partner — stored with initiatedBy/targetPartnerId and the partner as owner', async () => {
    const agent = await agentFor(admin);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerA.id }));
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const entry = res.body.request;
    requestIds.push(entry.id);
    expect(entry.initiatedBy).toBe('institution');
    expect(entry.targetPartnerId).toBe(partnerA.id);
    expect(entry.initiatorId).toBe(admin.id);
    expect(entry.submittedByEmail).toBe(partnerA.email);
    expect(entry.requestedBy).toContain(TEST_TAG);
    expect(entry.unit).toBe('CIRL');
    expect(entry.status).toBe('Pending');

    const stored = await db.collection('requests').findOne({ id: entry.id });
    expect(stored.submittedByEmail).toBe(partnerA.email);
    expect(stored.initiatedBy).toBe('institution');
  });

  test('(a) Staff can also create a request addressed to a partner', async () => {
    const agent = await agentFor(staff);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerA.id }));
    expect(res.status).toBe(200);
    requestIds.push(res.body.request.id);
    expect(res.body.request.initiatorId).toBe(staff.id);
    expect(res.body.request.submittedByEmail).toBe(partnerA.email);
  });

  test('(a) a Partner sending the same institution-initiated shape cannot impersonate another partner — it is just filed as their own request', async () => {
    const agent = await agentFor(partnerA);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerB.id }));
    expect(res.status).toBe(200);
    requestIds.push(res.body.request.id);
    // institutionInitiated requires the ACTOR to be Administrator/Staff — a partner's own role never
    // qualifies, so the request is filed as a normal self-submitted request, not attributed to partnerB.
    expect(res.body.request.initiatedBy).toBeUndefined();
    expect(res.body.request.submittedByEmail).toBe(partnerA.email);
  });

  test('missing targetPartnerId is rejected for an institution-initiated submission', async () => {
    const agent = await agentFor(admin);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution' }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/target partner/i);
  });

  test('a nonexistent targetPartnerId is rejected', async () => {
    const agent = await agentFor(admin);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: 999999 }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('targetPartnerId pointing at the acting user (an Administrator) is rejected — not a potential_partner', async () => {
    const agent = await agentFor(admin);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: admin.id }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('targetPartnerId pointing at an Administrator (not the actor) is rejected', async () => {
    const otherAdmin = await createTestUser({ role: 'Administrator' });
    const agent = await agentFor(staff);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: otherAdmin.id }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('targetPartnerId pointing at a Staff account is rejected', async () => {
    const otherStaff = await createTestUser({ role: 'Staff' });
    const agent = await agentFor(admin);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: otherStaff.id }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('targetPartnerId pointing at an LAU account is rejected', async () => {
    const agent = await agentFor(admin);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: lau.id }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('targetPartnerId pointing at an Inactive partner account is rejected', async () => {
    const inactivePartner = await createTestUser({ role: 'potential_partner' });
    await db.collection('users').updateOne({ id: inactivePartner.id }, { $set: { status: 'Inactive' } });
    const agent = await agentFor(admin);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: inactivePartner.id }));
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/not found/i);
  });

  test('Auth. Personnel (Dean) cannot use initiatedBy:institution — not Administrator/Staff, and is blocked by the pre-existing College-Dean Partnership Request restriction regardless', async () => {
    const agent = await agentFor(deanAuthPersonnel);
    const res = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerA.id }));
    // denyCollegeStaffPartnershipRequests (pre-existing, unchanged) blocks any Auth. Personnel Partnership
    // Request that isn't isCollegeReport:true — institutionInitiated never reaches that far for this role.
    expect(res.status).toBe(403);
    expect(res.body.error).toMatch(/College Dean cannot submit/i);
  });

  test('(b) only the target partner sees the institution-initiated request in GET /api/requests/mine', async () => {
    const agent = await agentFor(admin);
    const create = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerA.id }));
    const id = create.body.request.id;
    requestIds.push(id);

    const mineA = await (await agentFor(partnerA)).get('/api/requests/mine');
    expect(mineA.body.some(r => r.id === id)).toBe(true);

    const mineB = await (await agentFor(partnerB)).get('/api/requests/mine');
    expect(mineB.body.some(r => r.id === id)).toBe(false);
  });

  test('(c) only Administrator/Staff can approve it — the target partner cannot', async () => {
    const agent = await agentFor(admin);
    const create = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerA.id }));
    const id = create.body.request.id;
    requestIds.push(id);

    const partnerAgent = await agentFor(partnerA);
    const denied = await partnerAgent.patch(`/api/requests/${id}`).send({ status: 'Approved' });
    expect([301, 302, 401, 403]).toContain(denied.status);

    const approve = await agent.patch(`/api/requests/${id}`).send({ status: 'Approved' });
    expect(approve.status).toBe(200);
    const stored = await db.collection('requests').findOne({ id });
    expect(stored.status).toBe('Approved');
  });

  test('(d) LAU review data stays hidden from the target partner on an institution-initiated request', async () => {
    const agent = await agentFor(admin);
    const create = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerA.id }));
    const id = create.body.request.id;
    requestIds.push(id);

    const lauAgent = await agentFor(lau);
    const lauRes = await lauAgent.post(`/api/requests/${id}/lau-review`).send({ note: `${TEST_TAG} internal note` });
    expect(lauRes.status).toBe(200);

    const partnerAgent = await agentFor(partnerA);
    const mine = await partnerAgent.get('/api/requests/mine');
    const seen = mine.body.find(r => r.id === id);
    expect(seen).toBeTruthy();
    expect(seen.lauReviews).toBeUndefined();

    const adminView = await agent.get('/api/requests');
    const seenByAdmin = adminView.body.find(r => r.id === id);
    expect(Array.isArray(seenByAdmin.lauReviews)).toBe(true);
    expect(seenByAdmin.lauReviews.length).toBeGreaterThan(0);
  });

  test('(e) the post-approval upload lock applies to an institution-initiated request for every role, including the target partner', async () => {
    const agent = await agentFor(admin);
    const create = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerA.id }));
    const id = create.body.request.id;
    requestIds.push(id);
    await agent.patch(`/api/requests/${id}`).send({ status: 'Approved' });

    const partnerAgent = await agentFor(partnerA);
    const partnerUpload = await partnerAgent.post(`/api/requests/${id}/documents`).send({ note: `${TEST_TAG} should be blocked` });
    expect(partnerUpload.status).toBe(400);

    const adminUpload = await agent.post(`/api/requests/${id}/documents`).send({ note: `${TEST_TAG} should be blocked` });
    expect(adminUpload.status).toBe(400);
  });

  test('(f) the target partner can upload supporting documents before approval, exactly as an owner', async () => {
    const agent = await agentFor(admin);
    const create = await agent.post('/api/requests').send(basePayload({ initiatedBy: 'institution', targetPartnerId: partnerA.id }));
    const id = create.body.request.id;
    requestIds.push(id);

    const partnerAgent = await agentFor(partnerA);
    const upload = await partnerAgent.post(`/api/requests/${id}/documents`).send({ note: `${TEST_TAG} supporting doc note` });
    expect(upload.status).toBe(200);
  });

  test('(f) only the #pr-status dropdown is gone from the Admin Partnership Requests page — the quick-filter pills stay (minus Rejected/Withdrawn), and the per-request status changer (PATCH) still works', async () => {
    const agent = await agentFor(admin);
    const pageRes = await agent.get('/partnership-requests');
    expect(pageRes.status).toBe(200);
    expect(pageRes.text).not.toContain('id="pr-status"');
    // The quick-filter pills (and their JS) were restored (2026-11 follow-up) — only the dropdown was
    // supposed to be removed. Rejected and Withdrawn pills were then removed again (2026-11 cleanup) —
    // those statuses still appear under "All"; only the pills themselves are gone.
    expect(pageRes.text).toContain('id="pr-filter-tabs"');
    expect(pageRes.text).toContain('setPRStatusFilter');
    expect(pageRes.text).not.toMatch(/setPRStatusFilter\('Rejected'/);
    expect(pageRes.text).not.toMatch(/setPRStatusFilter\('Withdrawn'/);
    expect(pageRes.text).toMatch(/setPRStatusFilter\('Pending'/);
    expect(pageRes.text).toMatch(/setPRStatusFilter\('Under Review'/);
    expect(pageRes.text).toMatch(/setPRStatusFilter\('Approved'/);
    // The dashboard's ?status=Pending deep-link still works through the pills.
    expect(pageRes.text).toContain('applyStatusFromQuery');
    // The Request Management Center header card is gone; the breadcrumb/page title stay.
    expect(pageRes.text).not.toContain('Request Management Center');
    expect(pageRes.text).toContain('id="page-breadcrumb"');
    expect(pageRes.text).toContain('id="cnt-pr-total"'); // a stat card
    // The "Request Partnership" button/modal is present for Administrator — its exact position (moved
    // into the search row next to the count, 2026-11 follow-up) is covered by its own dedicated test below.
    expect(pageRes.text).toContain('id="pr-initiate-modal"');
    expect(pageRes.text).toContain('Request Partnership');
    // The searchable Target Partner field replaces the plain <select>.
    expect(pageRes.text).toContain('id="pri-partner-search"');
    expect(pageRes.text).toContain('id="pri-partner-dropdown"');
    expect(pageRes.text).toContain('id="pri-partner-id"');
    expect(pageRes.text).not.toContain('id="pri-partner"><option'); // the old <select> markup is gone

    const create = await agent.post('/api/requests').send(basePayload());
    const id = create.body.request.id;
    requestIds.push(id);
    const changed = await agent.patch(`/api/requests/${id}`).send({ status: 'Under Review' });
    expect(changed.status).toBe(200);
    const stored = await db.collection('requests').findOne({ id });
    expect(stored.status).toBe('Under Review');
  });

  test('Staff also sees the "Request Partnership" button on their own Requests page, and the #pr-status dropdown is gone there too (pills stay, minus Rejected/Withdrawn)', async () => {
    const agent = await agentFor(staff);
    const res = await agent.get('/staff/requests');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="pr-initiate-modal"');
    expect(res.text).toContain('Request Partnership');
    expect(res.text).not.toContain('id="pr-status"');
    expect(res.text).toContain('id="pr-filter-tabs"');
    expect(res.text).not.toMatch(/setPRStatusFilter\('Rejected'/);
    expect(res.text).not.toMatch(/setPRStatusFilter\('Withdrawn'/);
    expect(res.text).not.toContain('Request Management Center');
    expect(res.text).toContain('id="pri-partner-search"');
  });

  test('GET /api/users/partner-options returns only {id, name} for active partners, guarded by requireStaffAccess', async () => {
    const inactivePartner = await createTestUser({ role: 'potential_partner' });
    await db.collection('users').updateOne({ id: inactivePartner.id }, { $set: { status: 'Inactive' } });

    const agent = await agentFor(admin);
    const res = await agent.get('/api/users/partner-options');
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const row = res.body.find(r => r.id === partnerA.id);
    expect(row).toBeTruthy();
    expect(Object.keys(row).sort()).toEqual(['id', 'name']);
    expect(res.body.some(r => r.id === inactivePartner.id)).toBe(false);
    expect(res.body.some(r => r.id === admin.id || r.id === staff.id || r.id === lau.id)).toBe(false);

    const partnerAgent = await agentFor(partnerA);
    const denied = await partnerAgent.get('/api/users/partner-options');
    expect([301, 302, 401, 403]).toContain(denied.status);
  });

  test('LAU (read-only) does not see the "Request Partnership" button on the shared page template', async () => {
    const agent = await agentFor(lau);
    const res = await agent.get('/lau/monitoring');
    expect(res.status).toBe(200);
    expect(res.text).not.toContain('id="pr-initiate-modal"');
  });

  test('a Partner cannot reach the Admin/Staff Partnership Requests page at all (pre-existing RBAC, unchanged)', async () => {
    const agent = await agentFor(partnerA);
    const res = await agent.get('/partnership-requests');
    expect([301, 302, 401, 403]).toContain(res.status);
  });

  test('(2026-11 follow-up) "Request Partnership" moved into the search row (next to the count), and the modal is modal-xl', async () => {
    const agent = await agentFor(admin);
    const res = await agent.get('/partnership-requests');
    expect(res.status).toBe(200);
    // It now sits after #pr-count, inside the same filter-row (after the tabs row, not inside it).
    expect((res.text.match(/id="pr-initiate-btn"/g) || []).length).toBe(1);
    const countIdx = res.text.indexOf('id="pr-count"');
    const btnIdx = res.text.indexOf('id="pr-initiate-btn"');
    const filterRowIdx = res.text.lastIndexOf('class="filter-row"', btnIdx);
    const sectionTabsIdx = res.text.indexOf('class="section-tabs"');
    expect(btnIdx).toBeGreaterThan(countIdx);
    expect(filterRowIdx).toBeGreaterThan(sectionTabsIdx);
    // Bigger modal.
    const modalIdx = res.text.indexOf('id="pr-initiate-modal"');
    expect(res.text.slice(modalIdx, modalIdx + 200)).toMatch(/modal-xl/);
    // OCR upload section and the IDP widget script are present.
    expect(res.text).toContain('id="pri-ocr-file-input"');
    expect(res.text).toContain('id="pri-ocr-idp-panel"');
    expect(res.text).toContain('idp-ocr-widget.js');
  });

  test('bad file type and oversized file are rejected on /api/ocr/extract for Admin/Staff, same as for a Partner', async () => {
    const agent = await agentFor(admin);
    const fakePath = path.join(os.tmpdir(), `${TEST_TAG}-fake.png`);
    fs.writeFileSync(fakePath, 'not a real png, just text pretending to be one');
    try {
      const res = await agent.post('/api/ocr/extract').attach('document', fakePath);
      expect(res.status).toBe(400);
      expect(res.body.success).toBeFalsy();
    } finally {
      fs.unlinkSync(fakePath);
    }

    const bigPath = path.join(os.tmpdir(), `${TEST_TAG}-big.png`);
    fs.writeFileSync(bigPath, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(11 * 1024 * 1024)]));
    try {
      const res = await agent.post('/api/ocr/extract').attach('document', bigPath);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/too large/i);
    } finally {
      fs.unlinkSync(bigPath);
    }
  });

  test('a real OCR-confirmed document becomes the new request\'s attachmentLink, and the request stays visible only to the target partner', async () => {
    const agent = await agentFor(admin);
    const file = path.join(os.tmpdir(), `${TEST_TAG}-ocr.png`);
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="900" height="200"><rect width="100%" height="100%" fill="white"/><text x="20" y="60" font-size="28" font-family="sans-serif" fill="black">MOA with Beta University, Testland</text></svg>');
    await sharp(svg).png().toFile(file);
    let documentId = null;
    try {
      const start = await agent.post('/api/ocr/extract').attach('document', file);
      expect(start.status).toBe(202);
      let status, tries = 0;
      do {
        await new Promise(r => setTimeout(r, 500));
        status = await agent.get('/api/ocr/status/' + start.body.jobId);
        tries++;
      } while (status.body.status === 'processing' && tries < 20);
      expect(status.body.status).toBe('done');

      const confirm = await agent.post('/api/ocr/confirm').send({ jobId: start.body.jobId, documentType: 'MOA' });
      expect(confirm.status).toBe(200);
      expect(confirm.body.fileLink).toBeTruthy();
      documentId = confirm.body.documentId;

      const create = await agent.post('/api/requests').send(basePayload({
        initiatedBy: 'institution', targetPartnerId: partnerA.id, attachmentLink: confirm.body.fileLink
      }));
      expect(create.status).toBe(200);
      requestIds.push(create.body.request.id);
      expect(create.body.request.attachmentLink).toBe(confirm.body.fileLink);

      const mineA = await (await agentFor(partnerA)).get('/api/requests/mine');
      const seenByOwner = mineA.body.find(r => r.id === create.body.request.id);
      expect(seenByOwner).toBeTruthy();
      expect(seenByOwner.attachmentLink).toBe(confirm.body.fileLink);

      const mineB = await (await agentFor(partnerB)).get('/api/requests/mine');
      expect(mineB.body.some(r => r.id === create.body.request.id)).toBe(false);
    } finally {
      fs.unlinkSync(file);
      if (documentId) await db.collection('documents').deleteOne({ id: documentId });
    }
  }, 30000);

  test('Submitted By badge data: a College Dean (Auth. Personnel) submission is distinguishable from a Partner and an Admin/Staff-initiated one', async () => {
    const dean2 = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    const agent = await agentFor(dean2);
    const create = await agent.post('/api/requests').send({
      institution: `${TEST_TAG} Dean Report University`, country: 'Japan', type: 'MOA', nature: 'Research', isCollegeReport: true,
      startDate: '2026-01-01', endDate: '2027-01-01'
    });
    expect(create.status).toBe(200);
    requestIds.push(create.body.request.id);
    expect(create.body.request.submittedByEmail).toBe(dean2.email);
    expect(create.body.request.initiatedBy).toBeUndefined();

    // The client resolves this request's badge via USERS_BY_EMAIL[submittedByEmail] -> ROLE_LABEL — confirm
    // the server data a College Dean report actually needs for that lookup to work is present, and that the
    // existing ROLE_LABEL display-name map (reused, not duplicated) is the one shipped on the page.
    const adminAgent = await agentFor(admin);
    const usersRes = await adminAgent.get('/api/users');
    const deanUser = usersRes.body.find(u => u.email === dean2.email);
    expect(deanUser.role).toBe('Auth. Personnel');

    const pageRes = await adminAgent.get('/partnership-requests');
    expect(pageRes.text).toContain("'Auth. Personnel': 'College Dean'");
    expect(pageRes.text).toContain('function submittedByBadge');
  });
});
