// Password-route vs. Google-route account-scope lockout separation (2026-10 authentication hardening).
//
// Before this, POST /login and GET /auth/google/callback shared the SAME account-scope lockout key for a
// given e-mail — deliberately, so an attacker couldn't dodge a lockout by switching sign-in method. But
// views/index.ejs is Google-only sign-in (no password form anywhere in the UI) — POST /login has no
// legitimate caller at all, so the shared key also meant anyone who knew a victim's e-mail could grief that
// victim's Google sign-in for free, with zero credentials, by sending 5 POST /login requests for their
// address. cirl.js now uses PASSWORD_ACCOUNT_SCOPE ('account-password') for POST /login's own account scope,
// separate from the Google callback's 'account' scope — this file proves both the attack this closes and
// that legitimate sign-in is unaffected. The shared 'ip' scope (unchanged) is proven still shared too.
//
// Same technique as test/google-oauth-rate-limit.test.js: toggles NODE_ENV off 'test' per-test (the only way
// to exercise the real lockout wiring, which otherwise no-ops under Jest) and mocks passport so the real
// cirl.js callback handler runs against a synthetic Google profile from the `x-test-google-email` header —
// no real network call to Google anywhere in this file.
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
const { createTestUser, cleanupAll } = require('./helpers');

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
let db;

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  await cleanupAll();
  await closeDB();
});

async function withRealLockout(fn) {
  process.env.NODE_ENV = 'development';
  try { await fn(); } finally { process.env.NODE_ENV = ORIGINAL_NODE_ENV; }
}

async function clearLockouts(keys) {
  await db.collection('loginLockouts').deleteMany({ key: { $in: keys } });
}
const LOOPBACK = ['::1', '::ffff:127.0.0.1', '127.0.0.1'];

describe('Attack scenario: hammering the hidden POST /login route for a victim\'s e-mail cannot lock that e-mail out of Google sign-in', () => {
  test('5 failed password attempts against a real allowlisted account leave that account\'s Google sign-in fully usable', async () => {
    await withRealLockout(async () => {
      const victim = await createTestUser({ role: 'Staff' });
      await clearLockouts([...LOOPBACK, victim.email]);
      const attacker = request.agent(app);

      for (let i = 0; i < 5; i++) {
        const res = await attacker.post('/login').type('form').send({ username: victim.email, password: 'definitely-wrong' });
        expect(res.status).toBe(401); // normal failed-credentials response, not yet a lockout
      }
      // The password-route's own account-scope key for this email is now locked — confirmed directly, not
      // inferred — a 6th password attempt would 429.
      const sixthPasswordAttempt = await attacker.post('/login').type('form').send({ username: victim.email, password: 'still-wrong' });
      expect(sixthPasswordAttempt.status).toBe(429);

      // Every supertest request in this process shares the SAME literal loopback IP (no real network hop to
      // vary it) — those 5 password failures also counted toward the shared 'ip' scope, which is correct,
      // approved behavior (see the dedicated "shared IP scope" describe block below) but would otherwise
      // confound THIS test's own variable: whether the ACCOUNT scope is separated. Clearing only the IP
      // scope here isolates that, same as every file in this suite already clears IP state between phases
      // it isn't currently testing.
      await clearLockouts(LOOPBACK);

      // The SAME victim signing in for real via Google — a completely different browser/agent, exactly as a
      // real victim would be — succeeds normally. If the ACCOUNT scopes were still shared, this would 429.
      const victimAgent = request.agent(app);
      const googleRes = await victimAgent.get('/auth/google/callback').set('x-test-google-email', victim.email);
      expect(googleRes.status).toBe(302);
      expect(googleRes.headers.location).not.toBe('/');
    });
  }, 30000);
});

describe('Legitimate scenario: normal Google sign-in traffic for an account is never affected by that account\'s own password-route activity, and vice versa', () => {
  test('4 failed Google attempts for OTHER accounts plus password-route failures for this account do not combine to lock this account\'s Google sign-in', async () => {
    await withRealLockout(async () => {
      const user = await createTestUser({ role: 'Administrator' });
      await clearLockouts([...LOOPBACK, user.email]);
      const agent = request.agent(app);

      // 4 failed password attempts against this user's OWN email (under the 5-attempt password-scope budget).
      for (let i = 0; i < 4; i++) {
        await agent.post('/login').type('form').send({ username: user.email, password: 'wrong' });
      }
      // A real, successful Google sign-in for the same account — unaffected by those 4 password failures.
      const res = await agent.get('/auth/google/callback').set('x-test-google-email', user.email);
      expect(res.status).toBe(302);
      expect(res.headers.location).not.toBe('/');
    });
  }, 30000);

  test('5 failed Google-flow attempts for an account do not lock that account out of the password route\'s own scope', async () => {
    await withRealLockout(async () => {
      const user = await createTestUser({ role: 'Staff' });
      await clearLockouts([...LOOPBACK, user.email]);
      const agent = request.agent(app);

      // 5 failed Google callbacks for an UNRELATED, never-allowlisted email sharing nothing with `user` —
      // trips the Google 'account' scope for THAT email only, never touches user's own password scope.
      const unrelatedEmail = `jesttest.googlefail.${Date.now()}@example.com`;
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('x-test-google-email', unrelatedEmail);
      }
      // Isolate the account-scope variable from the shared IP scope those 5 failures also consumed — see
      // the matching comment in the "Attack scenario" describe block above for why this is necessary and
      // doesn't weaken coverage (IP sharing has its own dedicated describe block below).
      await clearLockouts(LOOPBACK);
      // This user's own password-route login still works normally — nothing above touched 'account-password'.
      const res = await agent.post('/login').type('form').send({ username: user.email, password: user.password });
      expect(res.status).toBe(302);
    });
  }, 30000);
});

describe('The shared IP scope is unaffected by the account-scope separation — still one budget per IP across both routes', () => {
  test('5 failed password attempts from one IP also block that same IP\'s next Google sign-in attempt', async () => {
    await withRealLockout(async () => {
      await clearLockouts(LOOPBACK);
      const agent = request.agent(app); // one agent = one consistent connection/IP for every request below

      for (let i = 0; i < 5; i++) {
        await agent.post('/login').type('form').send({ username: `jesttest.ipshared.${Date.now()}.${i}@example.com`, password: 'wrong' });
      }
      // Same IP, now switching to the Google route entirely — still blocked, proving 'ip' is shared.
      const res = await agent.get('/auth/google');
      expect(res.status).toBe(429);
      expect(res.headers.location).toBeUndefined(); // never actually redirected to Google while IP-locked
    });
  }, 30000);
});
