// Welcome e-mail on new account creation (2026-11, Account Email / Document Library investigation).
// Under Jest, services/emailService.js never connects to a mail server — every message is captured in
// emailService.sentForTests, which these tests read. See test/email-notifications.test.js for the same
// convention used elsewhere.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, uniqueEmail, getDb } = require('./helpers');
const emailService = require('../services/emailService');

const createdEmails = [];
beforeAll(async () => { await connectDB(); });
afterAll(async () => {
  // Accounts made through POST /api/users carry a real createdAt date, so cleanupAll() would not sweep them.
  if (createdEmails.length) await getDb().collection('users').deleteMany({ email: { $in: createdEmails } });
  await cleanupAll();
  await closeDB();
});

const settle = () => new Promise((r) => setTimeout(r, 150));
const mailTo = (email) => emailService.sentForTests.filter((m) => m.to === email);

async function adminAgent() {
  const admin = await createTestUser({ role: 'Administrator' });
  const agent = request.agent(app);
  await loginAs(agent, admin);
  return agent;
}

describe('Welcome e-mail on new account creation', () => {
  test('creating an account e-mails the new user, with no password anywhere in the message', async () => {
    const admin = await adminAgent();
    const email = uniqueEmail('welcome');
    createdEmails.push(email);
    // No password sent — the admin didn't type one, so the server auto-generates a tempPassword and
    // returns it once in the response. That value must never leak into the e-mail body.
    const res = await admin.post('/api/users').send({ name: 'jesttest Welcome', email, role: 'Staff' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.emailWarning).toBeFalsy();
    expect(typeof res.body.tempPassword).toBe('string');
    await settle();

    const mail = mailTo(email).find((m) => /Welcome to CIPRMS/.test(m.subject));
    expect(mail).toBeDefined();
    expect(mail.text).toContain('jesttest Welcome');
    expect(mail.text).toContain('Staff');
    // the system's own web address is printed as visible text (not only behind the button)
    expect(mail.text).toContain('CIPRMS web address: ');
    expect(mail.html).toContain('CIPRMS web address:');
    // Never the temp password the response hands the admin out-of-band — not the raw value, not the word.
    expect(mail.text).not.toContain(res.body.tempPassword);
    expect(mail.text.toLowerCase()).not.toContain('password');
    expect(mail.html.toLowerCase()).not.toContain('password');
  });

  test('a welcome e-mail that fails to send still lets the account be created, with a warning in the response', async () => {
    const admin = await adminAgent();
    const email = uniqueEmail('welcome-fail');
    createdEmails.push(email);

    const spy = jest.spyOn(emailService, 'sendNotificationEmails').mockResolvedValueOnce({
      sent: [], failed: [{ email, error: 'simulated SMTP failure' }], skipped: null
    });
    const res = await admin.post('/api/users').send({ name: 'jesttest Welcome Fail', email, role: 'Staff', password: 'TestPass123' });
    spy.mockRestore();

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.user.email).toBe(email);
    expect(res.body.emailWarning).toBeTruthy();

    const inDb = await getDb().collection('users').findOne({ email });
    expect(inDb).not.toBeNull();
  });
});
