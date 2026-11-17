// Partner "List of Activities" with PDF Export and Document Library Archiving (2026-11).
// Admin/Staff can record activities conducted with a partner (own collection,
// `partnershipactivities` — never embedded on `partnerships`, which many other roles can already read
// unprojected) and export them as a PDF that is archived to the Document Library under its own
// 'Partner Activities' type, replacing (never duplicating) the previous export for that same partnership.
jest.setTimeout(30000);

const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, insertWithNextId } = require('../db');
const { createTestUser, loginAs, cleanupAll, TEST_TAG } = require('./helpers');

// The project's own tmp/ folder (gitignored) — path reported at the end of the run and in the task report.
const SAMPLE_PDF_DIR = process.env.CIPRMS_SAMPLE_PDF_DIR || path.join(__dirname, '..', 'tmp');
fs.mkdirSync(SAMPLE_PDF_DIR, { recursive: true });

let db;
const partnershipIds = [];
const documentIds = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  await db.collection('partnerships').deleteMany({ id: { $in: partnershipIds } });
  await db.collection('partnershipactivities').deleteMany({ partnershipId: { $in: partnershipIds } });
  if (documentIds.length) await db.collection('documents').deleteMany({ id: { $in: documentIds } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(user) {
  const agent = request.agent(app);
  await loginAs(agent, user);
  return agent;
}

async function makePartnership(overrides) {
  const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = (last.length ? last[0].id : 0) + 1;
  await db.collection('partnerships').insertOne({
    id, inst: `${TEST_TAG} Activities University`, country: 'Testland', region: 'Asia', type: 'MOA',
    nature: ['Research', 'Student Exchange'], cat: 'International', unit: ['CCS', 'CILS'],
    start: '2021-01-01', end: '2026-01-01', status: 'Active', ...overrides
  });
  partnershipIds.push(id);
  return id;
}

async function pdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return (parsed.pages || []).map(p => p.text || '').join('\n\n');
  } finally {
    await parser.destroy();
  }
}

describe('Activities: add + list, RBAC', () => {
  let admin, staff, partner, lau, dean, pid;

  beforeAll(async () => {
    admin = await createTestUser({ role: 'Administrator' });
    staff = await createTestUser({ role: 'Staff' });
    partner = await createTestUser({ role: 'potential_partner' });
    lau = await createTestUser({ role: 'LAU' });
    dean = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    pid = await makePartnership();
  });

  test('Administrator can add an activity and list it back, sorted by date', async () => {
    const agent = await agentFor(admin);
    const add1 = await agent.post(`/api/partnerships/${pid}/activities`).send({
      dateConducted: '2025-06-01', activityConducted: 'Conducted MOU Signing', natureOfActivity: 'Signing Ceremony'
    });
    expect(add1.status).toBe(200);
    expect(add1.body.activity.createdBy).toBe(admin.name || `${TEST_TAG} Administrator`);

    const add2 = await agent.post(`/api/partnerships/${pid}/activities`).send({
      dateConducted: '2025-01-01', activityConducted: 'Kickoff meeting', natureOfActivity: 'Meeting'
    });
    expect(add2.status).toBe(200);

    const list = await agent.get(`/api/partnerships/${pid}/activities`);
    expect(list.status).toBe(200);
    expect(list.body.activities.length).toBe(2);
    expect(list.body.activities[0].dateConducted).toBe('2025-01-01'); // sorted earliest first
    expect(list.body.activities[1].dateConducted).toBe('2025-06-01');
  });

  test('Staff can also add and list activities', async () => {
    const agent = await agentFor(staff);
    const res = await agent.post(`/api/partnerships/${pid}/activities`).send({
      dateConducted: '2025-09-01', activityConducted: 'Follow-up visit', natureOfActivity: 'Site Visit'
    });
    expect(res.status).toBe(200);
  });

  test('Partner, LAU and Auth. Personnel all get 403 on list, add, and export', async () => {
    for (const user of [partner, lau, dean]) {
      const agent = await agentFor(user);
      const list = await agent.get(`/api/partnerships/${pid}/activities`);
      expect([301, 302, 401, 403]).toContain(list.status);
      const add = await agent.post(`/api/partnerships/${pid}/activities`).send({ dateConducted: '2025-01-01', activityConducted: 'x', natureOfActivity: 'y' });
      expect([301, 302, 401, 403]).toContain(add.status);
      const exp = await agent.post(`/api/partnerships/${pid}/activities/export`);
      expect([301, 302, 401, 403]).toContain(exp.status);
    }
  });

  test('validation rejects an incomplete entry (missing fields, one at a time)', async () => {
    const agent = await agentFor(admin);
    const cases = [
      { activityConducted: 'x', natureOfActivity: 'y' }, // missing date
      { dateConducted: '2025-01-01', natureOfActivity: 'y' }, // missing activityConducted
      { dateConducted: '2025-01-01', activityConducted: 'x' }, // missing natureOfActivity
      { dateConducted: 'not-a-date', activityConducted: 'x', natureOfActivity: 'y' } // invalid date
    ];
    for (const body of cases) {
      const res = await agent.post(`/api/partnerships/${pid}/activities`).send(body);
      expect(res.status).toBe(400);
    }
  });

  test('a nonexistent partnership id returns 404', async () => {
    const agent = await agentFor(admin);
    const res = await agent.get('/api/partnerships/999999/activities');
    expect(res.status).toBe(404);
  });
});

describe('PDF export and Document Library archiving', () => {
  let admin, pid;

  beforeAll(async () => {
    admin = await createTestUser({ role: 'Administrator' });
    pid = await makePartnership({ inst: `${TEST_TAG} Export University` });
    const agent = await agentFor(admin);
    await agent.post(`/api/partnerships/${pid}/activities`).send({
      dateConducted: '2025-03-15', activityConducted: 'Conducted MOU Signing', natureOfActivity: 'Signing Ceremony', remarks: 'jesttest remark'
    });
    await agent.post(`/api/partnerships/${pid}/activities`).send({
      dateConducted: '2025-09-01', activityConducted: 'Faculty exchange visit', natureOfActivity: 'Site Visit'
    });
  });

  test('export (POST) returns a valid PDF with one row for the partner, not one row per activity', async () => {
    const agent = await agentFor(admin);
    const res = await agent.post(`/api/partnerships/${pid}/activities/export`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    const pdfBuffer = Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body);
    expect(pdfBuffer.slice(0, 4).toString()).toBe('%PDF');

    const text = await pdfText(pdfBuffer);
    expect(text).toMatch(/LIST OF INTERNATIONAL PARTNERS AND ACTIVITIES CONDUCTED/i);
    expect(text).toMatch(/CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES/i);
    expect(text).toMatch(/Bridging Excellence, Engaging the World, Transforming Lives/i);
    // Plain hyphen, not an en-dash, matching the real template's literal "YYYY-YYYY".
    expect(text).toMatch(/\b\d{4}-\d{4}\b/);
    expect(text).not.toMatch(/\d{4}–\d{4}/);
    expect(text).toMatch(new RegExp(`${TEST_TAG} Export University`));
    expect(text).toMatch(/Testland/);
    expect(text).toMatch(/Conducted MOU Signing/);
    expect(text).toMatch(/Signing Ceremony/);
    expect(text).toMatch(/Faculty exchange\s+visit/); // may line-wrap inside the Activities Conducted column
    expect(text).toMatch(/Site Visit/);

    // One row per partner: the institution name (and country) appear exactly once on the page, even
    // though two activities were logged for it.
    const instOccurrences = text.split(`${TEST_TAG} Export University`).length - 1;
    expect(instOccurrences).toBe(1);
    const countryOccurrences = text.split('Testland').length - 1;
    expect(countryOccurrences).toBe(1);

    const archived = await db.collection('documents').findOne({ type: 'Partner Activities', partnershipId: pid });
    expect(archived).toBeTruthy();
    documentIds.push(archived.id);
    expect(archived.fileLink).toBeTruthy();
    expect(archived.uploadedByEmail).toBe(admin.email);

    const fileOnDisk = path.join(__dirname, '..', 'uploads', 'documents', path.basename(archived.fileLink));
    expect(fs.existsSync(fileOnDisk)).toBe(true);
  });

  test('exporting again replaces the previous archive instead of creating a duplicate', async () => {
    const before = await db.collection('documents').countDocuments({ type: 'Partner Activities', partnershipId: pid });
    expect(before).toBe(1);
    const firstDoc = await db.collection('documents').findOne({ type: 'Partner Activities', partnershipId: pid });
    const oldFilePath = path.join(__dirname, '..', 'uploads', 'documents', path.basename(firstDoc.fileLink));

    const agent = await agentFor(admin);
    const res = await agent.post(`/api/partnerships/${pid}/activities/export`);
    expect(res.status).toBe(200);

    const after = await db.collection('documents').find({ type: 'Partner Activities', partnershipId: pid }).toArray();
    expect(after.length).toBe(1); // still exactly one — replaced, not duplicated
    documentIds.push(after[0].id);
    // The old physical file is cleaned up (best-effort) once replaced.
    expect(fs.existsSync(oldFilePath)).toBe(false);
  });

  test('a previous archive that is still linked from elsewhere is kept, not deleted, on re-export', async () => {
    const before = await db.collection('documents').findOne({ type: 'Partner Activities', partnershipId: pid });
    expect(before).toBeTruthy();
    const beforeFilePath = path.join(__dirname, '..', 'uploads', 'documents', path.basename(before.fileLink));

    // Simulate the duplicate-detection signal the route also checks: another document record whose
    // possibleDuplicateIds names this exact Partner Activities document.
    const probe = await insertWithNextId(db.collection('documents'), (nextId) => ({
      id: nextId, type: 'Other', title: `${TEST_TAG} probe`, possibleDuplicateIds: [before.id]
    }));

    const agent = await agentFor(admin);
    const res = await agent.post(`/api/partnerships/${pid}/activities/export`);
    expect(res.status).toBe(200);

    // The old record and file must both still exist — kept, not deleted, because something links to it.
    const stillThere = await db.collection('documents').findOne({ id: before.id });
    expect(stillThere).toBeTruthy();
    expect(fs.existsSync(beforeFilePath)).toBe(true);
    // A second Partner Activities record now exists for this partnership — the sanctioned exception.
    const allForPartner = await db.collection('documents').find({ type: 'Partner Activities', partnershipId: pid }).toArray();
    expect(allForPartner.length).toBe(2);
    allForPartner.forEach(d => documentIds.push(d.id));

    // Clean up back to a single record (docA, still kept) so later tests in this file see the normal
    // one-record-per-partnership state again, rather than leaving an extra record for them to stumble
    // through non-deterministically.
    const freshDoc = allForPartner.find(d => d.id !== before.id);
    await db.collection('documents').deleteOne({ id: probe.id });
    if (freshDoc) {
      await db.collection('documents').deleteOne({ id: freshDoc.id });
      if (freshDoc.fileLink) {
        fs.unlink(path.join(__dirname, '..', 'uploads', 'documents', path.basename(freshDoc.fileLink)), () => {});
      }
    }
  });

  test('saves one exported sample PDF for template comparison in the project tmp/ folder', async () => {
    const agent = await agentFor(admin);
    const res = await agent.post(`/api/partnerships/${pid}/activities/export`);
    expect(res.status).toBe(200);
    const outPath = path.join(SAMPLE_PDF_DIR, 'sample-list-of-activities.pdf');
    fs.writeFileSync(outPath, Buffer.isBuffer(res.body) ? res.body : Buffer.from(res.body));
    // eslint-disable-next-line no-console
    console.log('Sample PDF saved to:', outPath);
    expect(fs.existsSync(outPath)).toBe(true);
    const archived = await db.collection('documents').findOne({ type: 'Partner Activities', partnershipId: pid });
    if (archived) documentIds.push(archived.id);
  });
});

describe('EJS render check: the List of Activities button/modal renders for Admin and Staff', () => {
  test('Administrator sees it on /lifecycle', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = await agentFor(admin);
    const res = await agent.get('/lifecycle');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="activitiesModal"');
    expect(res.text).toContain('List of Activities');
  });

  test('Staff sees it on /staff/lifecycle', async () => {
    const staff = await createTestUser({ role: 'Staff' });
    const agent = await agentFor(staff);
    const res = await agent.get('/staff/lifecycle');
    expect(res.status).toBe(200);
    expect(res.text).toContain('id="activitiesModal"');
  });
});
