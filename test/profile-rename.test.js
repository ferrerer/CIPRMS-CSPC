// Renaming an account in Settings must stick and must also rename the requestor on the account's own requests —
// the name is copied into each request when it is created, so without this every request already submitted (and its
// request form / print / PDF) kept showing the old name.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb, uniqueEmail } = require('./helpers');

beforeAll(async () => { await connectDB(); });
// cleanupAll() does not sweep the documentrequests collection, so the ones created here are deleted explicitly.
const docRequestIds = [];
afterAll(async () => {
  if (docRequestIds.length) await getDb().collection('documentrequests').deleteMany({ id: { $in: docRequestIds } });
  await getDb().collection('profiles').deleteMany({ email: { $regex: '^jesttest\\.', $options: 'i' } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

describe('Settings rename → requestor name on requests', () => {
  test('College Dean: the new name shows on the request form page and on their existing Document Requests', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const made = await agent.post('/api/document-requests').send({ institution: 'jesttest College', documentTypes: ['jesttest doc'], notes: 'jesttest rename' });
    expect(made.status).toBe(200);
    docRequestIds.push(made.body.request.id);
    const oldName = made.body.request.requestedBy;
    expect(oldName).not.toBe('Renamed College Person');

    const save = await agent.post('/api/personnel/profile').send({ name: 'Renamed College Person', dept: 'CCS', position: 'Coordinator', institution: 'CSPC' });
    expect(save.status).toBe(200);

    // the request form's "Name of Requestor" is rendered from the account name
    const form = await agent.get('/personnel/requests');
    expect(form.text).toContain('Renamed College Person');
    expect(form.text).not.toContain(`<div class="dr-readonly">${oldName}</div>`);

    // ...and the request they already submitted now carries it too
    const mine = (await agent.get('/api/document-requests/mine')).body.find(r => r.id === made.body.request.id);
    expect(mine.requestedBy).toBe('Renamed College Person');
  });

  test('Partner: renaming the contact person renames the requestor on their Partnership Requests', async () => {
    const { agent } = await agentFor('potential_partner');
    const made = await agent.post('/api/requests').send({ institution: 'jesttest Rename Org', country: 'Japan', type: 'MOA', nature: 'Research', notes: 'jesttest rename partner' });
    expect(made.status).toBe(200);

    const save = await agent.post('/api/partner/profile').send({ organization: 'jesttest Rename Org', contactName: 'Renamed Partner Person' });
    expect(save.status).toBe(200);

    const mine = (await agent.get('/api/requests/mine')).body.find(r => r.id === made.body.request.id);
    expect(mine.requestedBy).toBe('Renamed Partner Person');
  });

  test('another account\'s requests are never renamed', async () => {
    const { agent: a } = await agentFor('Auth. Personnel');
    const { agent: b } = await agentFor('Auth. Personnel');
    const other = await b.post('/api/document-requests').send({ institution: 'jesttest Other', documentTypes: ['jesttest doc'], notes: 'jesttest other' });
    docRequestIds.push(other.body.request.id);
    const before = other.body.request.requestedBy;

    await a.post('/api/personnel/profile').send({ name: 'Somebody Else Entirely', dept: 'CCS', position: 'Coordinator', institution: 'CSPC' });

    const stillMine = (await b.get('/api/document-requests/mine')).body.find(r => r.id === other.body.request.id);
    expect(stillMine.requestedBy).toBe(before);
  });
});

describe('Department / Institution / Position are fixed at registration', () => {
  const REGISTERED = { unit: 'CCS', institution: 'Camarines Sur Polytechnic Colleges', position: 'Coordinator' };

  async function registeredAgent(role) {
    const { agent, user } = await agentFor(role);
    await getDb().collection('users').updateOne({ email: user.email }, { $set: REGISTERED });
    return { agent, user };
  }

  test.each([
    ['College Dean', 'Auth. Personnel', '/api/personnel/profile']   // Administrator / CIRL Staff may edit them (see below)
  ])('%s: Settings shows the registered values and ignores any attempt to change them', async (_label, role, url) => {
    const { agent, user } = await registeredAgent(role);

    const before = (await agent.get(url)).body;
    expect(before).toMatchObject({ dept: 'CCS', institution: REGISTERED.institution, position: 'Coordinator', email: user.email });

    const save = await agent.post(url).send({ name: 'Only The Name Changes', dept: 'CIRL', position: 'Hacked Position', institution: 'Hacked School' });
    expect(save.status).toBe(200);
    expect(save.body.profile).toMatchObject({ name: 'Only The Name Changes', dept: 'CCS', institution: REGISTERED.institution, position: 'Coordinator' });

    const stored = await getDb().collection('users').findOne({ email: user.email });
    expect(stored.name).toBe('Only The Name Changes');
    expect(stored.unit).toBe('CCS');
    expect(stored.institution).toBe(REGISTERED.institution);
    expect(stored.position).toBe('Coordinator');
    expect((await agent.get(url)).body).toMatchObject({ dept: 'CCS', institution: REGISTERED.institution, position: 'Coordinator' });
  });

  test('a save with no name is rejected — the name is the only thing Settings edits', async () => {
    const { agent } = await registeredAgent('Auth. Personnel');
    expect((await agent.post('/api/personnel/profile').send({ name: '   ' })).status).toBe(400);
    expect((await agent.post('/api/personnel/profile').send({ dept: 'CIRL' })).status).toBe(400);
  });

  test('the three fields are read-only on every Settings page', async () => {
    for (const [role, path] of [['Auth. Personnel', '/personnel/settings'], ['Staff', '/staff/settings'], ['Administrator', '/admin/settings']]) {
      const { agent } = await agentFor(role);
      const html = (await agent.get(path)).text;
      for (const id of ['s-dept', 's-position', 's-institution']) {
        const tag = html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'));
        expect(tag).not.toBeNull();
        expect(tag[0]).toContain(' readonly ');
      }
      expect(html).not.toContain('<select class="form-select" id="s-dept"');
      expect(html).toContain("body: JSON.stringify({ name })");
    }
  });

  test('every Settings page still builds the profile card in updateCard() — typing a name must not throw (regression: "initials is not defined")', async () => {
    for (const [role, path] of [['Auth. Personnel', '/personnel/settings'], ['Staff', '/staff/settings'], ['Administrator', '/admin/settings']]) {
      const { agent } = await agentFor(role);
      const html = (await agent.get(path)).text;
      const start = html.indexOf('function updateCard()');
      expect(start).toBeGreaterThan(-1);
      const body = html.slice(start, html.indexOf('function applyPhoto', start));
      // every variable the function reads must be declared inside it (pos is deliberately double-spaced in
      // the source — `const pos  =` — to line up the `=` signs with the other, longer variable names)
      for (const v of ['name', 'dept', 'inst', 'phone', 'parts', 'initials']) expect(body).toContain(`const ${v} =`);
      expect(body).toContain('const pos  =');
      expect(body).toContain('av.textContent = initials');
      expect(body).toContain("document.getElementById('info-phone').textContent = phone");
    }
  });

  test('College Dean Settings: Cancel is hidden until something is changed, and the save button reads "Saved Changes" after saving', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const html = (await agent.get('/personnel/settings')).text;
    const cancel = html.match(/<button[^>]*id="cancel-btn"[^>]*>/);
    expect(cancel).not.toBeNull();
    expect(cancel[0]).toContain('display:none');                      // not visible on a clean form
    expect(html).toContain('oninput="onNameInput()"');                // editing the name is what reveals it
    expect(html).toContain('function syncButtons');
    expect(html).toContain('Saved Changes');
    expect(html).toContain('justSaved = true;');                      // set only after the server accepted the save
  });

  test('User Management registers them: Add User stores all three and Edit User can correct them', async () => {
    const { agent: admin } = await agentFor('Administrator');
    const email = `jesttest.reg.${Date.now()}@example.com`;
    const created = await admin.post('/api/users').send({ name: 'jesttest Registered', email, role: 'Auth. Personnel', password: 'TestPass123', unit: 'CAS', institution: 'CSPC Main', position: 'Faculty' });
    expect(created.status).toBe(200);
    expect(created.body.user).toMatchObject({ unit: 'CAS', institution: 'CSPC Main', position: 'Faculty' });

    const edited = await admin.patch('/api/users/' + created.body.user.id).send({ unit: 'CEA', institution: ' CSPC Naga ', position: 'Dean' });
    expect(edited.status).toBe(200);
    expect(edited.body.user).toMatchObject({ unit: 'CEA', institution: 'CSPC Naga', position: 'Dean' });
  });
});

describe('Administrator and CIRL Staff can edit every account detail in Settings', () => {
  test.each([
    ['Administrator', 'Administrator', '/api/admin/profile', '/admin/settings'],
    ['CIRL Staff', 'Staff', '/api/staff/profile', '/staff/settings']
  ])('%s: saves name, department, designation, institution, contact number and website (validated like account setup)', async (_label, role, url, page) => {
    const { agent, user } = await agentFor(role);
    const html = (await agent.get(page)).text;
    for (const id of ['s-contact', 's-dept', 's-position', 's-institution', 's-website']) {
      expect(html.match(new RegExp('<input[^>]*id="' + id + '"[^>]*>'))[0]).not.toContain(' readonly');
    }
    const ok = await agent.post(url).send({ name: 'jesttest Full Edit', unit: 'CCS', position: 'Coordinator', institution: 'CSPC', contactNumber: '0917-555-1234', website: 'www.cspc.edu.ph' });
    expect(ok.status).toBe(200);
    expect(ok.body.profile).toMatchObject({ name: 'jesttest Full Edit', dept: 'CCS', position: 'Coordinator', institution: 'CSPC', contactNumber: '0917-555-1234', website: 'https://www.cspc.edu.ph' });
    const saved = await getDb().collection('users').findOne({ email: user.email });
    expect(saved).toMatchObject({ unit: 'CCS', position: 'Coordinator', institution: 'CSPC', contactNumber: '0917-555-1234' });
    expect((await agent.post(url).send({ name: 'x', unit: 'CCS', position: 'P', institution: 'I', contactNumber: 'abc' })).status).toBe(400);
    expect((await agent.post(url).send({ name: 'x', unit: 'CCS', position: 'P', institution: 'I', contactNumber: '0917-555-1234', website: 'not a site' })).status).toBe(400);
  });
});

describe('Contact Number is fixed at registration (College Dean)', () => {
  const CASES = [
    ['College Dean', 'Auth. Personnel', '/api/personnel/profile', '/personnel/settings']
  ];
  const REGISTERED_NUMBER = '0917-123-4567';

  test.each(CASES)('%s: Settings shows the registered number and ignores any attempt to change it', async (_label, role, url) => {
    const { agent, user } = await agentFor(role);
    expect((await agent.get(url)).body.contactNumber).toBe('');                       // registered without one
    await getDb().collection('users').updateOne({ email: user.email }, { $set: { contactNumber: REGISTERED_NUMBER } });
    expect((await agent.get(url)).body.contactNumber).toBe(REGISTERED_NUMBER);

    const save = await agent.post(url).send({ name: 'Only The Name Changes', contactNumber: '0999-999-9999' });
    expect(save.status).toBe(200);
    expect(save.body.profile).toMatchObject({ name: 'Only The Name Changes', contactNumber: REGISTERED_NUMBER });
    expect((await getDb().collection('users').findOne({ email: user.email })).contactNumber).toBe(REGISTERED_NUMBER);
    expect((await agent.get(url)).body.contactNumber).toBe(REGISTERED_NUMBER);
  });

  test.each(CASES)('%s Settings page shows the number read-only, on the profile card too, and never sends it on save', async (_label, role, _url, page) => {
    const { agent } = await agentFor(role);
    const html = (await agent.get(page)).text;
    const tag = html.match(/<input[^>]*id="s-contact"[^>]*>/);
    expect(tag).not.toBeNull();
    expect(tag[0]).toContain(' readonly ');                                            // like department / position / institution
    expect(html).toContain('id="info-phone"');
    expect(html).toContain("data.contactNumber || ''");
    expect(html).not.toContain('onContactInput');                                      // nothing to type here any more
    expect(html).not.toContain('savedContact');
  });

  test('User Management: Add User registers the number (trimmed) and Edit User can correct it', async () => {
    const { agent: admin } = await agentFor('Administrator');
    const email = `jesttest.phone.${Date.now()}@example.com`;
    const created = await admin.post('/api/users').send({ name: 'jesttest Phone', email, role: 'Auth. Personnel', password: 'TestPass123', unit: 'CAS', contactNumber: '  0917-123-4567 ' });
    expect(created.status).toBe(200);
    expect(created.body.user.contactNumber).toBe('0917-123-4567');
    expect((await getDb().collection('users').findOne({ email })).contactNumber).toBe('0917-123-4567');

    const edited = await admin.patch('/api/users/' + created.body.user.id).send({ contactNumber: '+63 917 555 0000' });
    expect(edited.status).toBe(200);
    expect(edited.body.user.contactNumber).toBe('+63 917 555 0000');

    // an edit that does not mention it leaves it alone; an empty one clears it
    expect((await admin.patch('/api/users/' + created.body.user.id).send({ unit: 'CEA' })).body.user.contactNumber).toBe('+63 917 555 0000');
    expect((await admin.patch('/api/users/' + created.body.user.id).send({ contactNumber: '' })).body.user.contactNumber).toBe('');

    // registered without one
    const bare = await admin.post('/api/users').send({ name: 'jesttest No Phone', email: `jesttest.nophone.${Date.now()}@example.com`, role: 'Auth. Personnel', password: 'TestPass123' });
    expect(bare.body.user.contactNumber).toBe('');
  });

  test.each([['letters', '0917-ABC-4567'], ['too short', '12345'], ['script', '<script>1234567</script>'], ['too long', '1'.repeat(30)]])(
    'User Management refuses a %s number with a plain message and saves nothing', async (_why, bad) => {
      const { agent: admin } = await agentFor('Administrator');
      const email = `jesttest.badphone.${Date.now()}@example.com`;
      const add = await admin.post('/api/users').send({ name: 'jesttest Bad Phone', email, role: 'Auth. Personnel', password: 'TestPass123', contactNumber: bad });
      expect(add.status).toBe(400);
      expect(add.body.error).toMatch(/valid contact number/i);
      expect(await getDb().collection('users').findOne({ email })).toBeNull();

      const ok = await admin.post('/api/users').send({ name: 'jesttest Ok Phone', email: `jesttest.okphone.${Date.now()}@example.com`, role: 'Auth. Personnel', password: 'TestPass123', contactNumber: '0917-123-4567' });
      const patch = await admin.patch('/api/users/' + ok.body.user.id).send({ contactNumber: bad });
      expect(patch.status).toBe(400);
      expect((await getDb().collection('users').findOne({ id: ok.body.user.id })).contactNumber).toBe('0917-123-4567');
    });

  test('the Add / Edit User form has the Contact Number field, sends it, and warns about letters', async () => {
    const { agent: admin } = await agentFor('Administrator');
    const html = (await admin.get('/users')).text;
    expect(html).toContain('id="u-contact"');
    expect(html).toContain('id="u-contact-warn"');
    expect(html).toContain('contactNumber });');                                        // both payloads carry it
    expect(html).toContain("u.contactNumber || ''");                                    // Edit User loads it
  });
});

describe('Changing the password ends the session — the person signs in again with the new password', () => {
  test.each([
    ['Administrator', 'Administrator', '/api/admin/password'],
    ['CIRL Staff', 'Staff', '/api/staff/password'],
    ['College Dean', 'Auth. Personnel', '/api/personnel/password'],
    ['Partner', 'potential_partner', '/api/partner/password']
  ])('%s: the session is ended, the old password stops working and the new one signs in', async (_label, role, url) => {
    const { agent, user } = await agentFor(role);
    expect((await agent.get('/api/me')).status).toBe(200);            // signed in before

    const res = await agent.post(url).send({ oldPassword: user.password, newPassword: 'BrandNew123' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: true, reloginRequired: true });

    // this browser is signed out now: an authenticated route sends it back to the login page
    const after = await agent.get('/api/me');
    expect(after.status).toBe(302);
    expect(after.headers.location).toBe('/');

    // the old password no longer signs in, the new one does
    const oldLogin = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    expect(oldLogin.status).toBe(401);                                // the login page again, not a redirect (2026-10-28: a real failure status, not 200)
    expect(oldLogin.text).toContain('Invalid email or password.');
    const fresh = request.agent(app);
    const newLogin = await fresh.post('/login').type('form').send({ username: user.email, password: 'BrandNew123' });
    expect(newLogin.status).toBe(302);
    expect((await fresh.get('/api/me')).status).toBe(200);
  });

  test('a wrong current password does NOT end the session', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const res = await agent.post('/api/personnel/password').send({ oldPassword: 'not-my-password', newPassword: 'BrandNew123' });
    expect(res.status).toBe(400);
    expect((await agent.get('/api/me')).status).toBe(200);
  });

  // 2026-11 UI update: the Change Password section (and its client-side "please log in again" redirect)
  // was removed from every Settings page — self-service password changes now exist only as the backend
  // routes exercised directly above (accounts sign in with Google instead). The server-rendered
  // ?passwordChanged=1 banner on the login page itself is unrelated UI, still reachable, and still tested.
  test('no Settings page shows a Change Password section, field, or control any more', async () => {
    for (const [role, path] of [['Administrator', '/admin/settings'], ['Staff', '/staff/settings'], ['Auth. Personnel', '/personnel/settings'], ['potential_partner', '/partner/settings']]) {
      const { agent } = await agentFor(role);
      const html = (await agent.get(path)).text;
      expect(html).not.toContain('Change Password');
      expect(html).not.toMatch(/id="(old|new|confirm)passwordInput"|id="pw-(old|new|confirm)"/);
      expect(html).not.toContain('tab-password');
      expect(html).not.toMatch(/\/api\/(admin|staff|personnel|partner)\/password/);
    }
  });

  test('the ?passwordChanged=1 login-page banner (reachable from any client that calls the password-change routes directly) still shows and resets correctly', async () => {
    const login = await request(app).get('/?passwordChanged=1');
    expect(login.status).toBe(200);
    expect(login.text).toContain('Please log in again with your new password.');
    expect((await request(app).get('/')).text).not.toContain('Please log in again with your new password.');
  });
});

// 2026-11 UI update: Add New User / Edit User no longer collect a password — new accounts sign in with
// Google (matched by email; see GET /auth/google/callback), so User Management never needs to set one.
describe('User Management: Add/Edit User no longer set a password — accounts authenticate via Google instead', () => {
  test('Add New User has no password field, and creating a user without sending any password field still succeeds', async () => {
    const { agent } = await agentFor('Administrator');
    const html = (await agent.get('/users')).text;
    expect(html).not.toMatch(/id="u-password"|id="u-pwd-(required|hint|eye)"/);

    const email = uniqueEmail('nopassword');
    const res = await agent.post('/api/users').send({ name: 'jesttest No Password', email, role: 'Staff' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    // The server still stores SOME bcrypt hash (so no account is ever left with an unusable/empty
    // credential field) — it is just never the point of entry; Google sign-in never reads it.
    const stored = await getDb().collection('users').findOne({ email });
    expect(typeof stored.password).toBe('string');
    expect(stored.password.length).toBeGreaterThan(0);
  });

  test('Edit User has no password field, and editing a user never changes their stored credential', async () => {
    const { agent } = await agentFor('Administrator');
    const target = await createTestUser({ role: 'Staff' });
    const before = await getDb().collection('users').findOne({ id: target.id });

    const html = (await agent.get('/users')).text;
    expect(html).not.toMatch(/id="u-password"|id="u-pwd-(required|hint|eye)"/);

    const res = await agent.patch(`/api/users/${target.id}`).send({ name: 'jesttest Renamed By Edit', email: target.email, role: 'Staff' });
    expect(res.status).toBe(200);
    const after = await getDb().collection('users').findOne({ id: target.id });
    expect(after.password).toBe(before.password); // unchanged — Edit User sent no password field at all
  });

  test('a direct API request cannot sneak a password through unexpected/removed fields on profile self-update routes', async () => {
    const { agent, user } = await agentFor('Staff');
    const before = await getDb().collection('users').findOne({ id: user.id });
    // saveOwnName() only ever reads+stores req.body.name — an attacker-supplied password field alongside it
    // must be silently ignored, never reaching the stored credential.
    const res = await agent.post('/api/staff/profile').send({ name: 'jesttest Still Me', password: 'HackedPass123' });
    expect(res.status).toBe(200);
    const after = await getDb().collection('users').findOne({ id: user.id });
    expect(after.password).toBe(before.password);
  });
});
