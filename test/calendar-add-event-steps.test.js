// Calendar > Add Event is a two-step flow (1: event details, 2: recipients). The wizard itself is client code —
// checked here at source level and verified in a real browser for Administrator and CIRL Staff at desktop and 390px —
// while the create API it relies on is unchanged, and its contract (recipients attached, one event per
// clientRequestId, past events refused, RBAC) is asserted for real below.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const src = fs.readFileSync(path.join(__dirname, '..', 'views', 'administrator', 'calendar.ejs'), 'utf8');
const block = (start, len) => src.slice(src.indexOf(start), src.indexOf(start) + len);

describe('Add Event wizard — markup', () => {
  test('a step indicator names both steps', () => {
    expect(src).toContain('id="cal-steps"');
    expect(src).toContain('Step 1: Event Details');
    expect(src).toContain('Step 2: Recipients');
  });

  test('the footer has Back, Next and Save, and Next/Back start hidden', () => {
    expect(src).toMatch(/id="btn-back">[^<]*<i[^>]*><\/i>Back/);
    expect(src).toMatch(/class="btn btn-primary d-none" id="btn-next">Next/);
    expect(src).toContain('id="btn-save"');
  });

  test('step 2 has a search field, a results list, group chips, a selected list and a count', () => {
    for (const id of ['step-recipients', 'rcp-search', 'rcp-results', 'rcp-groups', 'rcp-selected', 'rcp-count']) expect(src).toContain(`id="${id}"`);
    expect(src).toContain('Search recipients by email address');
  });

  test('the modal is slightly wider on desktop through CSS only (the existing modal-lg markup is kept)', () => {
    expect(src).toMatch(/@media \(min-width: 992px\) \{ #event-modal \.modal-dialog \{ --vz-modal-width: 920px; \} \}/);
    expect(src).toMatch(/id="event-modal" tabindex="-1">\s*<div class="modal-dialog modal-dialog-centered modal-dialog-scrollable modal-lg"/);
    expect(src).toMatch(/#rcp-results \{ max-height: 240px; overflow-y: auto;/);
  });

  test('there is still exactly one event modal (no duplicate modal is created for step 2)', () => {
    expect((src.match(/id="event-modal"/g) || []).length).toBe(1);
    expect(src).not.toMatch(/new bootstrap\.Modal\(document\.getElementById\('step/);
  });
});

describe('Add Event wizard — behavior in the page script', () => {
  test('adding hides the recipients field on step 1 and resets the wizard; editing still shows it', () => {
    const add = block('function showAdd(', 2200);
    expect(add).toContain("document.getElementById('f-recipients-wrap').classList.add('d-none')");
    expect(add).toContain('selectedRecipients = [];');
    expect(add).toContain('showStep(1)');
    const edit = block('function showEdit(', 2600);
    expect(edit).toContain("document.getElementById('f-recipients-wrap').classList.remove('d-none')");
    expect(edit).toContain('leaveWizard()');
    expect(block('function showView(', 300)).toContain('leaveWizard()');
  });

  test('Next validates and switches panels only — it never calls the API', () => {
    const next = block("document.getElementById('btn-next').addEventListener('click'", 200);
    expect(next).toContain('readEventDetails()');
    expect(next).toContain('showStep(2)');
    expect(next).not.toMatch(/apiPost|calApi|fetch\(/);
  });

  test('Back only switches panels (the step-1 fields are hidden, not rebuilt, so nothing is lost) and never calls the API', () => {
    const back = block("document.getElementById('btn-back').addEventListener('click'", 160);
    expect(back).toContain('showStep(1)');
    expect(back).not.toMatch(/apiPost|calApi|fetch\(/);
    expect(block('function showStep(', 900)).toContain("classList.toggle('d-none', two)");
  });

  test('Save is the only create call: same in-flight guard, same clientRequestId, recipients from the step-2 selection', () => {
    const save = block("document.getElementById('btn-save').addEventListener('click'", 6000);
    expect(save).toContain('if(saving) return;');
    expect(save).toContain('saving = true; saveBtn.disabled = true;');
    expect(save).toContain('selectedRecipients.map(function(r){ return r.value; })');
    expect(save).toContain('clientRequestId: pendingRequestId');
    expect(save.match(/apiPost\(/g).length).toBe(1);   // exactly one create call inside Save
    for (const fn of ['function showStep(', 'function renderRecipients(', 'function readEventDetails(', 'function toggleRecipient(']) {
      expect(block(fn, 2600)).not.toMatch(/apiPost\(|calApi\(|fetch\(/);   // no wizard step ever talks to the server
    }
  });

  test('a problem found at the final Save sends the person back to the details step', () => {
    expect(block("document.getElementById('btn-save').addEventListener('click'", 600)).toContain('if(!d){ if(isAdding) showStep(1); return; }');
  });

  test('recipient search runs on the already-loaded /api/users list (Administrator/Staff only) — no new endpoint', () => {
    expect(src).toContain("allUsers = Array.isArray(users) ? users : [];");
    expect(src).toContain("fetch('/api/users')");
    expect(src).toContain("addEventListener('input', renderRecipients)");
    expect(src).toContain('u.email.toLowerCase().indexOf(q) >= 0');
  });

  test('results show name, email and role, and every value is escaped before it reaches the page', () => {
    const render = block('function renderRecipients()', 2600);
    expect(render).toContain("esc(u.name || u.email)");
    expect(render).toContain('esc(u.email)');
    expect(render).toContain('ROLE_LABELS[u.role]');
    expect(render).not.toMatch(/innerHTML\s*=\s*[^;]*\bu\.(name|email)\b(?![^;]*esc\()/);
  });

  test('the existing role/group recipients (All Users, Administrators, College Dean, Partner, CIRL Staff) are still offered', () => {
    const groups = block('var RECIPIENT_GROUPS', 320);
    for (const v of ["'all'", "'Administrator'", "'Auth. Personnel'", "'potential_partner'", "'Staff'"]) expect(groups).toContain(v);
  });
});

describe('Add Event — the create API contract the wizard depends on (unchanged)', () => {
  let admin, staff, rcpA, rcpB;
  const stamp = Date.now();
  const ids = [];
  const today = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
  let db;

  beforeAll(async () => {
    db = await connectDB();
    admin = request.agent(app); await loginAs(admin, await createTestUser({ role: 'Administrator' }));
    staff = request.agent(app); await loginAs(staff, await createTestUser({ role: 'Staff' }));
    rcpA = await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' });
    rcpB = await createTestUser({ role: 'potential_partner' });
  });
  afterAll(async () => {
    if (ids.length) await db.collection('calendarevents').deleteMany({ id: { $in: ids } });
    await cleanupAll();
    await closeDB();
  });
  const create = async (agent, body) => {
    const res = await agent.post('/api/calendarevents').send({ allDay: true, className: 'bg-primary-subtle', start: today(), ...body });
    if (res.body && res.body.event) ids.push(res.body.event.id);
    return res;
  };

  test.each([['Administrator', () => admin], ['CIRL Staff', () => staff]])('%s: the recipients picked on step 2 are attached to the created event', async (label, who) => {
    const res = await create(who(), { title: `jesttest Steps ${label} ${stamp}`, recipients: [rcpA.email, rcpB.email], clientRequestId: `steps-${label}-${stamp}`.replace(/\s/g, '-') });
    expect(res.status).toBe(200);
    const doc = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    const attached = [...(doc.recipientEmails || []), ...(doc.participantEmails || [])];
    expect(attached).toEqual(expect.arrayContaining([rcpA.email, rcpB.email]));
    expect(doc.googleAttendeeEmails).toEqual(expect.arrayContaining([rcpA.email, rcpB.email]));
  });

  test('an event with no recipients is still allowed (step 2 is optional)', async () => {
    const res = await create(admin, { title: `jesttest Steps NoRcp ${stamp}`, recipients: [] });
    expect(res.status).toBe(200);
  });

  test('the same clientRequestId (a double-click on Save) creates exactly one event', async () => {
    const clientRequestId = `steps-dedupe-${stamp}`;
    const title = `jesttest Steps Dedupe ${stamp}`;
    const [a, b] = await Promise.all([create(admin, { title, recipients: [rcpA.email], clientRequestId }), create(admin, { title, recipients: [rcpA.email], clientRequestId })]);
    expect(a.status).toBe(200); expect(b.status).toBe(200);
    expect(await db.collection('calendarevents').countDocuments({ title })).toBe(1);
  });

  test('a past event is still refused by the server, whatever the client did', async () => {
    const res = await admin.post('/api/calendarevents').send({ title: `jesttest Steps Past ${stamp}`, start: '2020-01-01', allDay: true });
    expect(res.status).toBe(400);
    expect(await db.collection('calendarevents').countDocuments({ title: `jesttest Steps Past ${stamp}` })).toBe(0);
  });

  test('College Dean and Partner still cannot create events (RBAC unchanged)', async () => {
    for (const role of ['Auth. Personnel', 'potential_partner']) {
      const agent = request.agent(app); await loginAs(agent, await createTestUser({ role, unit: role === 'Auth. Personnel' ? 'CCS' : '' }));
      const res = await agent.post('/api/calendarevents').send({ title: `jesttest Steps Denied ${stamp}`, start: today(), allDay: true });
      expect([301, 302, 401, 403]).toContain(res.status);
    }
    expect(await db.collection('calendarevents').countDocuments({ title: `jesttest Steps Denied ${stamp}` })).toBe(0);
  });
});
