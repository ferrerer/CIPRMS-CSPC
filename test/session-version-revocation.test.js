// Session-version revocation (2026-10 authentication hardening). A password change, an administrator's
// password reset, or an administrator's e-mail change previously ended only the ONE session making that
// specific request (endSessionAfterPasswordChange()) — any OTHER already-open session for the same account
// (a different device, a stolen cookie) stayed valid until it happened to expire on its own. Every user
// document now carries a `sessionVersion` (defaulting to 0 when absent, for full backward compatibility with
// accounts/sessions that predate this field), bumped on each of those three actions; the existing 15-second
// session-revalidation middleware (which already re-fetches the real user document on a throttle — reduced
// to 0 under NODE_ENV=test, see cirl.js's own comment on REVALIDATE_INTERVAL_MS) now also compares the
// session's own stored version against the account's current one and destroys the session on a mismatch,
// the same way it already destroys one for a deactivated account.
// Mocked once, at the top, for the whole file — the password-change tests never touch Google at all, and
// the one Google-reauthentication test at the bottom needs it. Same technique as
// test/lockout-scope-separation.test.js: no real network call to Google anywhere in this file.
jest.mock('passport', () => ({
  initialize: () => (req, res, next) => next(),
  session: () => (req, res, next) => next(),
  use: () => {},
  serializeUser: () => {},
  deserializeUser: () => {},
  authenticate: (strategy, optionsOrCallback, maybeCallback) => {
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    return (req, res, next) => {
      if (!callback) return res.redirect('/');
      const testEmail = req.headers['x-test-google-email'];
      if (!testEmail) return callback(null, false, { message: 'no test identity supplied' });
      return callback(null, { id: 'test-google-id-' + testEmail, displayName: 'Test Google User', emails: [{ value: testEmail, verified: true }] }, null);
    };
  }
}));

const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db;
beforeAll(async () => { db = await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

describe('Backward compatibility: no field means version 0 on both sides, never spuriously revoked', () => {
  test('a user document with no sessionVersion field at all keeps its session alive across the revalidation check', async () => {
    const user = await createTestUser({ role: 'Staff' });
    await db.collection('users').updateOne({ id: user.id }, { $unset: { sessionVersion: '' } }); // simulates an account that predates this field
    const agent = request.agent(app);
    await loginAs(agent, user);

    const first = await agent.get('/api/me');
    expect(first.status).toBe(200);
    const second = await agent.get('/api/me'); // a second request re-runs the (now un-throttled, under test) revalidation check
    expect(second.status).toBe(200);
    expect(second.body.user.email).toBe(user.email);
  });
});

describe('Self-service password change revokes every OTHER open session for the same account, but no one else\'s', () => {
  test('changing your own password via Settings kills a second, already-open session for the same account; an unrelated account is untouched', async () => {
    const user = await createTestUser({ role: 'Administrator' });
    const otherUser = await createTestUser({ role: 'Staff' });

    const deviceA = request.agent(app); // the device making the password change
    const deviceB = request.agent(app); // a second, already-open session for the SAME account (e.g. another browser)
    const unrelatedAgent = request.agent(app); // a different account entirely

    await loginAs(deviceA, user);
    await loginAs(deviceB, user);
    await loginAs(unrelatedAgent, otherUser);

    // Confirm all three sessions are alive before the change.
    expect((await deviceA.get('/api/me')).status).toBe(200);
    expect((await deviceB.get('/api/me')).status).toBe(200);
    expect((await unrelatedAgent.get('/api/me')).status).toBe(200);

    const changeRes = await deviceA.post('/api/admin/password').send({ oldPassword: user.password, newPassword: 'NewPass456' });
    expect(changeRes.status).toBe(200);
    expect(changeRes.body.reloginRequired).toBe(true); // deviceA's OWN session — already known, unchanged behavior

    // deviceB never made this request at all — its only way to learn the account changed is the
    // sessionVersion mismatch caught on its next request.
    const deviceBAfter = await deviceB.get('/api/me');
    expect(deviceBAfter.status).toBe(302); // session destroyed, redirected to sign in again

    // The unrelated account's own session is completely unaffected.
    const unrelatedAfter = await unrelatedAgent.get('/api/me');
    expect(unrelatedAfter.status).toBe(200);
    expect(unrelatedAfter.body.user.email).toBe(otherUser.email);
  });
});

describe('An administrator resetting ANOTHER user\'s password or e-mail revokes that other user\'s existing sessions', () => {
  test('an admin password reset via User Management kills the target\'s already-open session', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const target = await createTestUser({ role: 'Staff' });
    const adminAgent = request.agent(app);
    const targetAgent = request.agent(app);
    await loginAs(adminAgent, admin);
    await loginAs(targetAgent, target);
    expect((await targetAgent.get('/api/me')).status).toBe(200);

    const patchRes = await adminAgent.patch(`/api/users/${target.id}`).send({ password: 'AdminReset789' });
    expect(patchRes.status).toBe(200);

    const targetAfter = await targetAgent.get('/api/me');
    expect(targetAfter.status).toBe(302);

    // The admin's OWN session (the one making the change) is untouched — only the TARGET was revoked.
    expect((await adminAgent.get('/api/me')).status).toBe(200);
  });

  test('an admin changing the target\'s e-mail to a GENUINELY DIFFERENT address revokes the target\'s already-open session', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const target = await createTestUser({ role: 'Staff' });
    const adminAgent = request.agent(app);
    const targetAgent = request.agent(app);
    await loginAs(adminAgent, admin);
    await loginAs(targetAgent, target);
    expect((await targetAgent.get('/api/me')).status).toBe(200);

    const newEmail = `jesttest.emailchanged.${Date.now()}@example.com`;
    const patchRes = await adminAgent.patch(`/api/users/${target.id}`).send({ email: newEmail });
    expect(patchRes.status).toBe(200);

    const targetAfter = await targetAgent.get('/api/me');
    expect(targetAfter.status).toBe(302);
  });

  // Finding 1 (2026-10 Phase 1.1 independent-review fix): the real "Edit User" form (views/users.ejs) always
  // resends the account's CURRENT email on every single save, pre-filled from the record being edited —
  // `const payload = { name, email, role, unit, institution, position, contactNumber };` — regardless of
  // whether the admin actually changed it. The four tests below reproduce that REAL payload shape (always
  // including email) rather than testing the server in isolation with a payload the real UI never sends, and
  // prove the server now decides based on whether the value actually changed, not merely whether the field
  // was present.
  test('resubmitting the SAME email alongside an unrelated field change (the real UI\'s actual payload shape) does NOT revoke the target\'s session', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const target = await createTestUser({ role: 'Staff' });
    const adminAgent = request.agent(app);
    const targetAgent = request.agent(app);
    await loginAs(adminAgent, admin);
    await loginAs(targetAgent, target);
    expect((await targetAgent.get('/api/me')).status).toBe(200);

    // Exactly what views/users.ejs's saveUser() actually sends: every field, including the CURRENT,
    // unchanged email — only `unit` is a real change here.
    const patchRes = await adminAgent.patch(`/api/users/${target.id}`).send({
      name: target.name, email: target.email, role: target.role, unit: 'CCS', institution: '', position: '', contactNumber: ''
    });
    expect(patchRes.status).toBe(200);

    const targetAfter = await targetAgent.get('/api/me');
    expect(targetAfter.status).toBe(200); // still alive — the email value never actually changed
  });

  test('a genuinely different email, even submitted alongside other fields the same way the real UI does, still revokes', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const target = await createTestUser({ role: 'Staff' });
    const adminAgent = request.agent(app);
    const targetAgent = request.agent(app);
    await loginAs(adminAgent, admin);
    await loginAs(targetAgent, target);

    const newEmail = `jesttest.realchange.${Date.now()}@example.com`;
    const patchRes = await adminAgent.patch(`/api/users/${target.id}`).send({
      name: target.name, email: newEmail, role: target.role, unit: 'CCS', institution: '', position: '', contactNumber: ''
    });
    expect(patchRes.status).toBe(200);

    const targetAfter = await targetAgent.get('/api/me');
    expect(targetAfter.status).toBe(302); // revoked — the email really did change
  });

  test('resubmitting the same email in a DIFFERENT case/with whitespace still counts as unchanged (normalized comparison, not a literal string match)', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const target = await createTestUser({ role: 'Staff' });
    const adminAgent = request.agent(app);
    const targetAgent = request.agent(app);
    await loginAs(adminAgent, admin);
    await loginAs(targetAgent, target);

    const patchRes = await adminAgent.patch(`/api/users/${target.id}`).send({ email: `  ${target.email.toUpperCase()}  `, unit: 'CCS' });
    expect(patchRes.status).toBe(200);

    const targetAfter = await targetAgent.get('/api/me');
    expect(targetAfter.status).toBe(200); // same normalized address — not a real change
  });

  test('a real password reset still revokes even when the (unchanged) email is also present in the same payload', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const target = await createTestUser({ role: 'Staff' });
    const adminAgent = request.agent(app);
    const targetAgent = request.agent(app);
    await loginAs(adminAgent, admin);
    await loginAs(targetAgent, target);

    const patchRes = await adminAgent.patch(`/api/users/${target.id}`).send({ email: target.email, password: 'AdminReset999' });
    expect(patchRes.status).toBe(200);

    const targetAfter = await targetAgent.get('/api/me');
    expect(targetAfter.status).toBe(302); // the password change alone is enough, independent of the email comparison
  });

  test('an unrelated field-only edit sent WITHOUT email at all does NOT revoke the target\'s session', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const target = await createTestUser({ role: 'Staff' });
    const adminAgent = request.agent(app);
    const targetAgent = request.agent(app);
    await loginAs(adminAgent, admin);
    await loginAs(targetAgent, target);

    const patchRes = await adminAgent.patch(`/api/users/${target.id}`).send({ unit: 'CCS' });
    expect(patchRes.status).toBe(200);

    const targetAfter = await targetAgent.get('/api/me');
    expect(targetAfter.status).toBe(200); // still alive — nothing session-sensitive changed
  });
});

// Requirement C's own instruction: verify req.session.regenerate() already correctly handles successful
// reauthentication BEFORE adding any new code for it. It does — proven directly below by signing in as two
// DIFFERENT accounts on the SAME browser/cookie jar (a shared/public computer) and confirming the second
// sign-in's session carries ONLY the second account's identity, nothing left over from the first. No
// additional code was written for this; this is purely a regression test confirming existing behavior.
describe('req.session.regenerate() already correctly discards a prior sign-in\'s session state (verified, not duplicated)', () => {
  test('signing in as a second, different account on the same cookie jar leaves no trace of the first account', async () => {
    const userA = await createTestUser({ role: 'Administrator' });
    const userB = await createTestUser({ role: 'Staff' });
    const sharedAgent = request.agent(app); // one cookie jar, like one shared/public browser

    await loginAs(sharedAgent, userA);
    const asA = await sharedAgent.get('/api/me');
    expect(asA.body.user.email).toBe(userA.email);
    expect(asA.body.user.role).toBe('Administrator');

    await loginAs(sharedAgent, userB);
    const asB = await sharedAgent.get('/api/me');
    expect(asB.body.user.email).toBe(userB.email);
    expect(asB.body.user.role).toBe('Staff');
    expect(asB.body.user.email).not.toBe(userA.email); // no leftover identity from the first sign-in
    expect(JSON.stringify(asB.body.user)).not.toContain(userA.email);
  });

  test('the same holds for Google sign-in: a second account on the same cookie jar fully replaces the first', async () => {
    const userA = await createTestUser({ role: 'Administrator' });
    const userB = await createTestUser({ role: 'Staff' });
    const sharedAgent = request.agent(app);

    await sharedAgent.get('/auth/google/callback').set('x-test-google-email', userA.email);
    const asA = await sharedAgent.get('/api/me');
    expect(asA.body.user.email).toBe(userA.email);

    await sharedAgent.get('/auth/google/callback').set('x-test-google-email', userB.email);
    const asB = await sharedAgent.get('/api/me');
    expect(asB.body.user.email).toBe(userB.email);
    expect(JSON.stringify(asB.body.user)).not.toContain(userA.email);
  });
});
