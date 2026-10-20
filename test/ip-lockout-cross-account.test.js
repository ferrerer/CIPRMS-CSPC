// Cross-account IP lockout enforcement (2026-10 investigation). A bug report described an authorized Gmail
// account signing in immediately after 5 failed attempts with an unauthorized address from the same IP —
// i.e. the shared IP-scope lockout not actually blocking a different, legitimate account. Investigated
// directly against the current codebase (not assumed): the exact scenario, restarting the OAuth flow, and
// switching to the password endpoint were all reproduced by hand first and found to ALREADY be blocked
// correctly (checkSignInLockout('ip', ip, ...) at the top of GET /auth/google, GET /auth/google/callback,
// and POST /login all read the same shared 'ip' scope key). This file turns that investigation into
// permanent regression coverage — closing a real gap: nothing in the existing suite combined "unauthorized
// attempts trip the IP lock" with "a DIFFERENT, real, allowlisted account from the same IP is then also
// blocked" in one scenario, even though the underlying pieces were each tested separately.
//
// Same technique as every other real-HTTP lockout test in this suite: toggles NODE_ENV off 'test' (the only
// way to exercise the real lockout wiring, which otherwise no-ops under Jest) and mocks passport so the real
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
const { createTestUser, uniqueEmail, cleanupAll, TEST_MULTIHOP_IPS } = require('./helpers');

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
async function fiveUnauthorizedAttempts(agent, label) {
  for (let i = 0; i < 5; i++) {
    await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail(label + i));
  }
}
const LOOPBACK = ['::1', '::ffff:127.0.0.1', '127.0.0.1'];

describe('5 unauthorized Google attempts trip the shared IP lockout', () => {
  test('the 5th attempt locks the IP; the lockout document is set for the first tier (00:45)', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      await clearLockouts(LOOPBACK);
      await fiveUnauthorizedAttempts(agent, 'triplock');
      const doc = await db.collection('loginLockouts').findOne({ scope: 'ip', key: { $in: LOOPBACK } });
      expect(doc).toBeTruthy();
      expect(doc.lockedUntil).toBeTruthy();
      expect(new Date(doc.lockedUntil).getTime()).toBeGreaterThan(Date.now());
    });
  }, 30000);
});

describe('An authorized account from the same IP is blocked while that IP lockout is active', () => {
  test('a real allowlisted account cannot sign in via the direct callback while the IP is locked, and no session is created', async () => {
    await withRealLockout(async () => {
      const authorized = await createTestUser({ role: 'Staff' });
      const agent = request.agent(app);
      await clearLockouts([...LOOPBACK, authorized.email]);
      await fiveUnauthorizedAttempts(agent, 'crossacct');

      const res = await agent.get('/auth/google/callback').set('x-test-google-email', authorized.email);
      expect(res.status).toBe(429);

      const meRes = await agent.get('/api/me');
      expect(meRes.status).toBe(302); // no session — blocked before the allowlist was ever consulted
    });
  }, 30000);

  // 2026-10 lockout-bypass fix: this is the exact production scenario — the unauthorized attempts and the
  // authorized attempt resolve to DIFFERENT string representations of the SAME real IP (plain IPv4 vs. the
  // IPv4-mapped-IPv6 form), which getClientIp() (cirl.js) now normalizes before either is ever used as a
  // lockout key. X-Forwarded-For spoofing (same technique test/google-oauth-rate-limit.test.js's own IP
  // normalization tests use) is how this test controls exactly which representation each request resolves
  // to, since this is a direct, no-real-proxy-in-front test connection.
  test('an authorized account is still blocked even when its attempt resolves to a DIFFERENT representation of the same real IP (the exact reported production scenario)', async () => {
    await withRealLockout(async () => {
      const authorized = await createTestUser({ role: 'Staff' });
      const agent = request.agent(app);
      await clearLockouts(['127.0.0.1', '::ffff:127.0.0.1', authorized.email]);

      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('X-Forwarded-For', '127.0.0.1').set('x-test-google-email', uniqueEmail('reprod' + i));
      }
      // The authorized account's attempt arrives via the OTHER representation of the identical real address.
      const res = await agent.get('/auth/google/callback').set('X-Forwarded-For', '::ffff:127.0.0.1').set('x-test-google-email', authorized.email);
      expect(res.status).toBe(429);

      const meRes = await agent.get('/api/me');
      expect(meRes.status).toBe(302);
    });
  }, 30000);

  test('restarting the OAuth flow (GET /auth/google) does not let the authorized account through either', async () => {
    await withRealLockout(async () => {
      const authorized = await createTestUser({ role: 'Staff' });
      const agent = request.agent(app);
      await clearLockouts([...LOOPBACK, authorized.email]);
      await fiveUnauthorizedAttempts(agent, 'restart');

      const restart = await agent.get('/auth/google');
      expect(restart.status).toBe(429);
      expect(restart.headers.location).toBeUndefined(); // never actually redirected to Google while locked

      const callbackAfterRestart = await agent.get('/auth/google/callback').set('x-test-google-email', authorized.email);
      expect(callbackAfterRestart.status).toBe(429);

      const meRes = await agent.get('/api/me');
      expect(meRes.status).toBe(302);
    });
  }, 30000);

  test('switching to the password endpoint does not let the authorized account through either', async () => {
    await withRealLockout(async () => {
      const authorized = await createTestUser({ role: 'Staff' });
      const agent = request.agent(app);
      await clearLockouts([...LOOPBACK, authorized.email]);
      await fiveUnauthorizedAttempts(agent, 'pwswitch');

      const passwordRes = await agent.post('/login').type('form').send({ username: authorized.email, password: authorized.password });
      expect(passwordRes.status).toBe(429);

      const meRes = await agent.get('/api/me');
      expect(meRes.status).toBe(302);
    });
  }, 30000);

  test('the error message never reveals whether the attempted e-mail is authorized, or anything about scope/limit', async () => {
    await withRealLockout(async () => {
      const authorized = await createTestUser({ role: 'Staff' });
      const agent = request.agent(app);
      await clearLockouts([...LOOPBACK, authorized.email]);
      await fiveUnauthorizedAttempts(agent, 'silent');

      const res = await agent.get('/auth/google/callback').set('x-test-google-email', authorized.email);
      const errorMsg = res.text.match(/<strong>Error<\/strong>\s*–\s*([^<]*)/)?.[1] || '';
      expect(errorMsg).toMatch(/Too many sign-in attempts/);
      expect(errorMsg).not.toMatch(/\bip\b|\baccount\b|\b5\b|authorized|not found/i);
    });
  }, 30000);
});

describe('Production scenario: Cloudflare + Render multi-hop X-Forwarded-For (2026-10 CF-Connecting-IP fix)', () => {
  // Reproduces a captured production log's structure (not its literal addresses — see TEST_MULTIHOP_IPS'
  // own comment in helpers.js for why real ones aren't used here): the SAME real client (CF-Connecting-IP,
  // set and verified by Cloudflare's own edge, unspoofable past it) made 5 unauthorized attempts and then 1
  // authorized attempt, but trust proxy:1's resolution of X-Forwarded-For (req.ip) came back as a DIFFERENT
  // Render-internal private address on nearly every single request — because Render's own internal routing
  // hop, not just Cloudflare's edge, appends itself to X-Forwarded-For, making req.ip alone useless as a
  // stable lockout key on this platform. getClientIp() now prefers CF-Connecting-IP over req.ip for exactly
  // this reason.
  const [REAL_CLIENT_CF_IP, ...RENDER_INTERNAL_HOPS] = TEST_MULTIHOP_IPS; // ['203.0.113.50', '10.255.0.1', '10.255.0.2', '10.255.0.3', '10.255.0.9']

  test('5 unauthorized attempts + 1 authorized attempt from the same CF-Connecting-IP are all blocked under one shared key, even though req.ip (X-Forwarded-For) differs on almost every request', async () => {
    await withRealLockout(async () => {
      const authorized = await createTestUser({ role: 'Staff' });
      const agent = request.agent(app);
      await clearLockouts([...TEST_MULTIHOP_IPS, authorized.email]);

      // The middle entry stands in for Cloudflare's own edge node — never read by getClientIp() (it reads
      // CF-Connecting-IP directly, not this header position) or asserted on below, so an arbitrary
      // TEST-NET-2 (RFC 5737, 198.51.100.0/24) placeholder is enough; it varies per request only to mirror
      // the real capture's shape (a different Cloudflare PoP per request is normal, not the bug).
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback')
          .set('CF-Connecting-IP', REAL_CLIENT_CF_IP)
          .set('X-Forwarded-For', `${REAL_CLIENT_CF_IP}, 198.51.100.${i + 1}, ${RENDER_INTERNAL_HOPS[i % RENDER_INTERNAL_HOPS.length]}`)
          .set('x-test-google-email', uniqueEmail('cfhop' + i));
      }

      // Authorized attempt arrives via yet another internal hop address — would have missed a req.ip-keyed
      // lockout entirely, which is exactly the bug this reproduces.
      const res = await agent.get('/auth/google/callback')
        .set('CF-Connecting-IP', REAL_CLIENT_CF_IP)
        .set('X-Forwarded-For', `${REAL_CLIENT_CF_IP}, 198.51.100.6, ${RENDER_INTERNAL_HOPS[RENDER_INTERNAL_HOPS.length - 1]}`)
        .set('x-test-google-email', authorized.email);
      expect(res.status).toBe(429);

      const meRes = await agent.get('/api/me');
      expect(meRes.status).toBe(302);

      // The lockout is keyed on the stable CF-Connecting-IP, not any of the unstable internal addresses.
      const doc = await db.collection('loginLockouts').findOne({ scope: 'ip', key: REAL_CLIENT_CF_IP });
      expect(doc).toBeTruthy();
      expect(new Date(doc.lockedUntil).getTime()).toBeGreaterThan(Date.now());
      for (const hop of RENDER_INTERNAL_HOPS) {
        const hopDoc = await db.collection('loginLockouts').findOne({ scope: 'ip', key: hop });
        expect(hopDoc).toBeNull();
      }
    });
  }, 30000);
});

describe('The authorized account can sign in once the IP lockout genuinely expires, provided nothing else is still active', () => {
  test('after the stored lockedUntil has passed, the same authorized account succeeds', async () => {
    await withRealLockout(async () => {
      const authorized = await createTestUser({ role: 'Staff' });
      const agent = request.agent(app);
      await clearLockouts([...LOOPBACK, authorized.email]);
      await fiveUnauthorizedAttempts(agent, 'expire');

      const stillLocked = await agent.get('/auth/google/callback').set('x-test-google-email', authorized.email);
      expect(stillLocked.status).toBe(429);

      // Simulates real elapsed time the same way every other test in this suite does — no real 45s wait.
      await db.collection('loginLockouts').updateMany({ scope: 'ip', key: { $in: LOOPBACK } }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });

      const afterExpiry = await agent.get('/auth/google/callback').set('x-test-google-email', authorized.email);
      expect(afterExpiry.status).toBe(302);
      expect(afterExpiry.headers.location).not.toBe('/');

      const meRes = await agent.get('/api/me');
      expect(meRes.status).toBe(200);
      expect(meRes.body.user.email).toBe(authorized.email);
    });
  }, 30000);
});

describe('A successful sign-in never clears the IP-level failure history or escalation tier (re-confirmed in this exact cross-account scenario)', () => {
  test('after the authorized account succeeds post-expiry, the IP escalation tier is still advanced, not reset', async () => {
    await withRealLockout(async () => {
      const authorized = await createTestUser({ role: 'Administrator' });
      const agent = request.agent(app);
      await clearLockouts([...LOOPBACK, authorized.email]);
      await fiveUnauthorizedAttempts(agent, 'tiercheck'); // tier -> 1
      await db.collection('loginLockouts').updateMany({ scope: 'ip', key: { $in: LOOPBACK } }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });

      const success = await agent.get('/auth/google/callback').set('x-test-google-email', authorized.email);
      expect(success.status).toBe(302);

      const docAfterSuccess = await db.collection('loginLockouts').findOne({ scope: 'ip', key: { $in: LOOPBACK } });
      expect(docAfterSuccess.tier).toBe(1); // not reset by the success

      // A fresh round of 5 failures now locks at tier 1's duration (01:45 = 105s), not tier 0's (00:45) —
      // proves the success never laundered the IP's own escalation history.
      await fiveUnauthorizedAttempts(agent, 'tiercheck2');
      const doc2 = await db.collection('loginLockouts').findOne({ scope: 'ip', key: { $in: LOOPBACK } });
      const retryAfterSeconds = Math.round((new Date(doc2.lockedUntil).getTime() - Date.now()) / 1000);
      expect(retryAfterSeconds).toBe(105);
    });
  }, 30000);
});
