// Google OAuth cross-account rate limiting + audit trail (2026-11 investigation).
//
// Root cause of the reported bypass ("five different Google accounts... continued past the expected
// five-attempt limit"): services/loginLockoutService.js's recordFailure() used to read the current
// failCount with one findOne(), then write failCount+1 back with a SEPARATE updateOne() — a classic
// read-then-write race. Two failures arriving close together (exactly what trying several Google accounts
// in quick succession produces) could both read the same pre-increment count and each write back count+1,
// silently losing one of the two real failures. Reproduced directly against the OLD code: 5 truly
// concurrent recordFailure() calls for one key left failCount at 1, not 5, and none reported locked. Fixed
// by making the whole read-decide-write a single atomic MongoDB aggregation-pipeline findOneAndUpdate() —
// see that file's own comment on recordFailure() for the full explanation. test/login-lockout.test.js's own
// "concurrent failures never lose an increment" block proves the fix at the service level, deterministically
// and without real network latency.
//
// THIS file proves the fix through the REAL HTTP routes (POST-fix wiring, not just the service) — the one
// thing NODE_ENV=test normally hides (checkSignInLockout/recordSignInFailure/recordSignInSuccess all
// no-op under NODE_ENV=test, for the same reason the old flat limiters did: this suite's many independent
// per-test logins, all sharing one supertest "IP", would otherwise trip a real, persisted lockout mid-suite
// and spuriously fail unrelated tests). That bypass is checked fresh on every call (`process.env.NODE_ENV
// === 'test'` read inside the function body, not baked in at module load the way the OLDER
// makeRateLimiter()-built limiters are), so it can be toggled off for exactly the tests in this file and
// safely restored afterward — unlike the older limiters, which decide once at cirl.js's own require() time
// and are therefore unaffected either way by anything this file does to process.env.NODE_ENV.
//
// No real Google network call anywhere in this file — passport itself is mocked (same technique
// test/oauth-allowlist.test.js already uses) so the REAL cirl.js callback handler runs against a synthetic
// Google profile built from the `x-test-google-email` test header; only the network round-trip to Google
// is replaced.
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
      // verified: true by default (2026-10 authentication hardening added this requirement to the real
      // callback) — every test in this file is about rate-limiting/escalation, not verification, and none
      // of them sets this header, so they must keep getting a verified profile unchanged.
      return callback(null, { id: 'test-google-id-' + testEmail, displayName: 'Test Google User', emails: [{ value: testEmail, verified: true }] }, null);
    };
  }
}));

const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB, getDb } = require('../db');
const { createTestUser, loginAs, cleanupAll, uniqueEmail, TEST_TAG } = require('./helpers');

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;
let db;

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  process.env.NODE_ENV = ORIGINAL_NODE_ENV; // must run even if a test above throws — restored unconditionally
  await cleanupAll();
  await closeDB();
});

// Every test below needs the REAL lockout to engage; wrap each one (not just this file as a whole) so a
// single failing test can never leave process.env.NODE_ENV permanently changed for files that load later
// in this same --runInBand process.
async function withRealLockout(fn) {
  process.env.NODE_ENV = 'development';
  try {
    await fn();
  } finally {
    process.env.NODE_ENV = ORIGINAL_NODE_ENV;
  }
}

async function clearLockouts(keys) {
  await db.collection('loginLockouts').deleteMany({ key: { $in: keys } });
}

describe('Five different Google accounts from one IP trip the SHARED IP lockout (the reported bypass)', () => {
  test('5 failed attempts using 5 different, never-before-seen Google accounts from one supertest agent lock out the 6th', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app); // one agent = one consistent connection/IP for every request below
      const emails = Array.from({ length: 5 }, () => uniqueEmail('oauthratelimit'));
      await clearLockouts(['::1', '::ffff:127.0.0.1', '127.0.0.1']);

      const results = [];
      for (const email of emails) {
        results.push((await agent.get('/auth/google/callback').set('x-test-google-email', email)).status);
      }
      // None of the 5 individual attempts should themselves be a 429 — each is a fresh, never-seen account,
      // nowhere near its OWN 5-attempt budget; it's the SHARED ip scope that should be at its limit by #5.
      expect(results.every((s) => s !== 429)).toBe(true);

      const sixthEmail = uniqueEmail('oauthratelimit-sixth');
      const sixth = await agent.get('/auth/google/callback').set('x-test-google-email', sixthEmail);
      expect(sixth.status).toBe(429);
      expect(sixth.text).toContain('Too many sign-in attempts');
      // Never reveals the scope, the limit, or whether any particular account exists — scoped to the
      // actual rendered error message, not the whole page (which legitimately contains CSS/JS text that
      // happens to match these words/digits incidentally, e.g. color variables).
      const errorMsg = sixth.text.match(/<strong>Error<\/strong>\s*–\s*([^<]*)/)?.[1] || '';
      expect(errorMsg).not.toMatch(/\bip\b|\baccount\b|\b5\b/i);
    });
  });

  test('switching to yet another Google account while that IP is locked does not bypass the block', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      await clearLockouts(['::1', '::ffff:127.0.0.1', '127.0.0.1']);
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthswitch'));
      }
      const anotherNewEmail = uniqueEmail('oauthswitch-another');
      const res = await agent.get('/auth/google/callback').set('x-test-google-email', anotherNewEmail);
      expect(res.status).toBe(429);
    });
  });

  test('restarting OAuth (GET /auth/google again) while locked is also blocked, not just the callback', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      await clearLockouts(['::1', '::ffff:127.0.0.1', '127.0.0.1']);
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthrestart'));
      }
      const restart = await agent.get('/auth/google');
      expect(restart.status).toBe(429);
      expect(restart.headers.location).toBeUndefined(); // never actually redirected to Google while locked
    });
  });

  test('a brand-new agent (different session, same supertest connection) does not get a fresh IP budget — refreshing/opening a new session cannot reset it', async () => {
    await withRealLockout(async () => {
      const agentA = request.agent(app);
      await clearLockouts(['::1', '::ffff:127.0.0.1', '127.0.0.1']);
      for (let i = 0; i < 5; i++) {
        await agentA.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthnewsession'));
      }
      // A fresh agent = a fresh session/cookie jar, same as a real user opening a new browser session —
      // but supertest's agents against the same in-process app share no real network identity, so this is
      // really exercising the same thing a page refresh does: a clean client-side slate with the SAME
      // underlying IP scope still locked server-side.
      const agentB = request.agent(app);
      const res = await agentB.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthnewsession-b'));
      expect(res.status).toBe(429);
    });
  });
});

describe('A legitimate successful Google sign-in is never itself counted as a failure, and only clears its OWN account', () => {
  // 30s, not the file-wide 15s default: this test makes 7 sequential real HTTP+MongoDB round trips, and
  // Jest's default per-test timeout left no margin when this file runs alongside others in the same
  // --runInBand process (observed: reliably under 15s alone, intermittently over it once real network/DB
  // latency compounds with another suite's own connection churn in the same process).
  test('a real allowlisted account signing in successfully does not trip or contribute to the IP lockout', async () => {
    await withRealLockout(async () => {
      const user = await createTestUser({ role: 'Staff' });
      const agent = request.agent(app);
      await clearLockouts(['::1', '::ffff:127.0.0.1', '127.0.0.1', user.email]);

      // 4 failures (under the 5-attempt threshold)...
      for (let i = 0; i < 4; i++) {
        await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthsuccessnocount'));
      }
      // ...then a real success.
      const success = await agent.get('/auth/google/callback').set('x-test-google-email', user.email);
      expect(success.status).toBe(302); // redirected to the real landing page, not blocked or re-rendered with an error
      expect(success.headers.location).not.toBe('/');

      // One more failure should be failure #5 for the IP scope (4 earlier + this 1), NOT #1 — success must
      // never have cleared the IP's own count. If success HAD cleared it, this 5th call would still be under
      // threshold. The 5th failing attempt itself still gets its own natural (non-429) response — the lockout
      // check runs BEFORE each request is processed, so only the attempt AFTER the one that crosses the
      // threshold ever sees 429 (matching the real password-login behavior verified earlier this session:
      // attempts 1-5 fail normally, attempt 6 is blocked).
      const fifth = await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthsuccessnocount-5'));
      expect(fifth.status).not.toBe(429);

      // Now the IP is locked from that 5th failure. A 6th attempt — even with a brand-new account email —
      // must be blocked. If the earlier success HAD cleared the IP's count, this would still be under
      // threshold and would NOT be blocked.
      const sixth = await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthsuccessnocount-6'));
      expect(sixth.status).toBe(429);
    });
  }, 30000);
});

describe('Audit Trail — Google sign-in events are recorded completely and exactly once', () => {
  async function latestFor(action, email) {
    return db.collection('activitylogs').find({ action, 'details.method': 'google', targetId: email }).sort({ id: -1 }).limit(1).toArray();
  }

  test('a failed Google sign-in (account not on the allowlist) writes exactly one LOGIN_FAILED row, never a password/token', async () => {
    const email = uniqueEmail('oauthaudit');
    const agent = request.agent(app);
    const res = await agent.get('/auth/google/callback').set('x-test-google-email', email);
    expect(res.status).toBe(200); // re-rendered sign-in page with the "not authorized" error — not a redirect/crash

    const rows = await db.collection('activitylogs').find({ action: 'LOGIN_FAILED', targetId: email, 'details.method': 'google' }).toArray();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('failure');
    expect(rows[0].details.reason).toBe('account_not_found');
    expect(rows[0].category).toBe('Authentication');
    expect(JSON.stringify(rows[0])).not.toMatch(/password|accessToken|refreshToken|clientSecret|authorization.?code/i);
  });

  test('GOOGLE_AUTH_CALLBACK is recorded for every callback received, success or failure alike', async () => {
    const email = uniqueEmail('oauthaudit2');
    const before = await db.collection('activitylogs').countDocuments({ action: 'GOOGLE_AUTH_CALLBACK' });
    await request.agent(app).get('/auth/google/callback').set('x-test-google-email', email);
    const after = await db.collection('activitylogs').countDocuments({ action: 'GOOGLE_AUTH_CALLBACK' });
    expect(after).toBe(before + 1);
  });

  test('GOOGLE_AUTH_INITIATED is recorded when the flow starts, with no password/token/credential anywhere in it', async () => {
    const before = await db.collection('activitylogs').countDocuments({ action: 'GOOGLE_AUTH_INITIATED' });
    await request.agent(app).get('/auth/google');
    const after = await db.collection('activitylogs').countDocuments({ action: 'GOOGLE_AUTH_INITIATED' });
    expect(after).toBe(before + 1);
    const row = await db.collection('activitylogs').find({ action: 'GOOGLE_AUTH_INITIATED' }).sort({ id: -1 }).limit(1).toArray();
    expect(JSON.stringify(row[0])).not.toMatch(/password|accessToken|refreshToken|clientSecret/i);
  });

  test('a successful Google sign-in writes exactly one LOGIN_SUCCESS row with the real actor identified', async () => {
    const user = await createTestUser({ role: 'Administrator' });
    const before = await db.collection('activitylogs').countDocuments({ action: 'LOGIN_SUCCESS', targetId: user.email });
    const res = await request.agent(app).get('/auth/google/callback').set('x-test-google-email', user.email);
    expect(res.status).toBe(302);
    const rows = await db.collection('activitylogs').find({ action: 'LOGIN_SUCCESS', targetId: user.email }).toArray();
    expect(rows).toHaveLength(before + 1);
    const latest = rows[rows.length - 1];
    // createTestUser() returns no `name` field (only id/email/password/role) — the real stored name
    // follows helpers.js's own convention, `${TEST_TAG} ${role}`.
    expect(latest.by).toBe(`${TEST_TAG} ${user.role}`);
    expect(latest.email).toBe(user.email);
    expect(latest.details.method).toBe('google');
  });

  test('an Inactive account is rejected AND recorded as LOGIN_FAILED (account_disabled), with the real account identified (unlike account_not_found)', async () => {
    const user = await createTestUser({ role: 'Staff' });
    await db.collection('users').updateOne({ id: user.id }, { $set: { status: 'Inactive' } });
    const res = await request.agent(app).get('/auth/google/callback').set('x-test-google-email', user.email);
    expect(res.status).toBe(200);
    const rows = await db.collection('activitylogs').find({ action: 'LOGIN_FAILED', targetId: user.email, 'details.method': 'google' }).toArray();
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[rows.length - 1].details.reason).toBe('account_disabled');
    // a real, known actor — unlike account_not_found's null actor. See the matching comment above on why
    // this isn't user.name (createTestUser() never sets one).
    expect(rows[rows.length - 1].by).toBe(`${TEST_TAG} ${user.role}`);
  });

  test('a callback with no test identity (simulating denied consent / failed OAuth) is recorded once, as oauth_denied_or_failed, never as account_not_found', async () => {
    const before = await db.collection('activitylogs').countDocuments({ action: 'LOGIN_FAILED', 'details.reason': 'oauth_denied_or_failed' });
    const res = await request.agent(app).get('/auth/google/callback'); // no x-test-google-email header at all
    expect(res.status).toBe(302);
    const after = await db.collection('activitylogs').countDocuments({ action: 'LOGIN_FAILED', 'details.reason': 'oauth_denied_or_failed' });
    expect(after).toBe(before + 1);
  });
});

describe('IP extraction depends on exactly one trusted hop in front of this process — a real, documented deployment assumption, not a code bug', () => {
  // app.set('trust proxy', 1) (cirl.js ~line 240) tells Express to trust exactly ONE reverse-proxy hop and
  // to read the client's real address out of X-Forwarded-For accordingly. Empirically verified here: against
  // a DIRECT connection (no real reverse proxy in front, which is exactly what supertest's in-process
  // connection is, and exactly what an attacker would have if they could ever reach the Express process
  // directly), Express's own req.ip resolution takes the CLIENT-SUPPLIED X-Forwarded-For value at face
  // value — each spoofed header below gets its OWN fresh lockout budget, proven by inspecting
  // loginLockouts directly, not by asserting a 429 that this configuration does not actually produce.
  //
  // This is correct, standard behavior for trust-proxy=1 — it is only as safe as the deployment's own
  // network guarantee that nothing can reach this Express process directly except Render's one trusted
  // proxy hop (i.e. the app's port is never exposed to the public Internet in parallel with Render's own
  // edge). That guarantee is a platform/network-configuration fact, not something expressible in this
  // app's own code, and it was NOT independently verified against Render's infrastructure during this task
  // — flagged explicitly in the final report as a deployment assumption to confirm, not fixed here.
  test('a direct connection\'s own client-supplied X-Forwarded-For is trusted as-is (no real proxy in front) — each spoofed value gets its own fresh budget', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      const spoofedIps = ['203.0.113.10', '203.0.113.11', '203.0.113.12'];
      await clearLockouts(['::1', '::ffff:127.0.0.1', '127.0.0.1', ...spoofedIps]);
      for (const spoofedIp of spoofedIps) {
        const res = await agent.get('/auth/google/callback').set('X-Forwarded-For', spoofedIp).set('x-test-google-email', uniqueEmail('spoofip'));
        expect(res.status).not.toBe(429); // one failure each — nowhere near any one key's own 5-attempt budget
      }
      const docs = await db.collection('loginLockouts').find({ scope: 'ip', key: { $in: spoofedIps } }).toArray();
      expect(docs).toHaveLength(spoofedIps.length); // each spoofed value was tracked as its own distinct key
      docs.forEach((doc) => expect(doc.recentFailures).toHaveLength(1));
    });
  });

  // 30s — see the matching comment on the previous describe block's own test for why (6 sequential real
  // HTTP+MongoDB round trips; this test was the one observed to intermittently exceed the 15s default
  // when this file runs alongside other suites in the same --runInBand process).
  test('with no forwarding header at all (the normal case for every other test in this file), requests consistently resolve to the same real connection identity', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      await clearLockouts(['::1', '::ffff:127.0.0.1', '127.0.0.1']);
      for (let i = 0; i < 4; i++) {
        await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('noproxyheader'));
      }
      const res = await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('noproxyheader-5'));
      expect(res.status).not.toBe(429); // 5th failure itself still gets its own natural response
      const sixth = await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('noproxyheader-6'));
      expect(sixth.status).toBe(429); // but the 6th is blocked — all 5 shared one real, consistent identity
    });
  }, 30000);
});

// IPv4-mapped-IPv6 normalization (2026-10 lockout-bypass fix). Root cause: Node/Express can represent the
// SAME real client as either "1.2.3.4" or "::ffff:1.2.3.4" depending on connection-level details outside
// this app's control (already proven in this project's own environment — see test/helpers.js's
// TEST_LOOPBACK_IPS, which lists all 3 forms observed for ONE loopback connection). getClientIp() (cirl.js)
// now rewrites the mapped form down to plain IPv4 before it is ever used as a lockout key, so both forms of
// the same real address always share one lockout — reproduced directly beforehand: 5 failures recorded
// under "127.0.0.1" left "::ffff:127.0.0.1" reporting not-locked under the old, unnormalized code.
// X-Forwarded-For spoofing (same technique as the describe block above) is how these tests control exactly
// what Express resolves req.ip to, since this is a direct, no-real-proxy-in-front test connection.
describe('getClientIp() normalizes the IPv4-mapped-IPv6 form so both representations of one real address share a lockout', () => {
  test('5 failures under plain IPv4 also lock the IPv4-mapped-IPv6 form of the SAME address', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      await clearLockouts(['127.0.0.1', '::ffff:127.0.0.1']);
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('X-Forwarded-For', '127.0.0.1').set('x-test-google-email', uniqueEmail('normA'));
      }
      const sixth = await agent.get('/auth/google/callback').set('X-Forwarded-For', '::ffff:127.0.0.1').set('x-test-google-email', uniqueEmail('normA-6'));
      expect(sixth.status).toBe(429);

      // The stored key is the NORMALIZED form — confirms getClientIp() rewrote it before ever reaching the
      // service, not merely that the two happen to collide some other way.
      const docs = await db.collection('loginLockouts').find({ scope: 'ip', key: { $in: ['127.0.0.1', '::ffff:127.0.0.1'] } }).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0].key).toBe('127.0.0.1');
    });
  }, 30000);

  test('reverse direction: 5 failures under the IPv4-mapped-IPv6 form also lock the plain IPv4 form', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      await clearLockouts(['127.0.0.1', '::ffff:127.0.0.1']);
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('X-Forwarded-For', '::ffff:127.0.0.1').set('x-test-google-email', uniqueEmail('normB'));
      }
      const sixth = await agent.get('/auth/google/callback').set('X-Forwarded-For', '127.0.0.1').set('x-test-google-email', uniqueEmail('normB-6'));
      expect(sixth.status).toBe(429);

      const docs = await db.collection('loginLockouts').find({ scope: 'ip', key: { $in: ['127.0.0.1', '::ffff:127.0.0.1'] } }).toArray();
      expect(docs).toHaveLength(1);
      expect(docs[0].key).toBe('127.0.0.1'); // normalized even though every failure arrived in the mapped form
    });
  }, 30000);

  test('native (non-mapped) IPv4 addresses are never rewritten and continue to be tracked independently', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      const ipA = '203.0.113.21', ipB = '203.0.113.22';
      await clearLockouts([ipA, ipB]);
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('X-Forwarded-For', ipA).set('x-test-google-email', uniqueEmail('nativeA'));
      }
      // A different real IPv4 address must NOT be caught up in ipA's lockout — proves normalization only
      // rewrites the mapped form, never collapses genuinely distinct addresses together.
      const otherIpAttempt = await agent.get('/auth/google/callback').set('X-Forwarded-For', ipB).set('x-test-google-email', uniqueEmail('nativeB'));
      expect(otherIpAttempt.status).not.toBe(429);

      const docA = await db.collection('loginLockouts').findOne({ scope: 'ip', key: ipA });
      expect(docA.key).toBe(ipA); // stored exactly as submitted, not altered
    });
  }, 30000);

  test('a genuine (non-mapped) IPv6 address is never rewritten and is tracked on its own', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      const genuineIpv6 = '2001:db8::4a2b';
      await clearLockouts([genuineIpv6]);
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('X-Forwarded-For', genuineIpv6).set('x-test-google-email', uniqueEmail('ipv6'));
      }
      const doc = await db.collection('loginLockouts').findOne({ scope: 'ip', key: genuineIpv6 });
      expect(doc).toBeTruthy();
      expect(doc.key).toBe(genuineIpv6); // untouched — not mistaken for the IPv4-mapped form
      expect(doc.lockedUntil).toBeTruthy();
    });
  }, 30000);

});

describe('Progressive escalation is preserved end to end through the real route (not just the service in isolation)', () => {
  // 30s — 10 sequential real HTTP+MongoDB round trips plus two direct DB operations; same cross-suite
  // timing margin as the two tests above.
  test('a second lockout for the same IP, after the first expires, is the 01:45 tier — not reset back to 00:45', async () => {
    await withRealLockout(async () => {
      const agent = request.agent(app);
      await clearLockouts(['::1', '::ffff:127.0.0.1', '127.0.0.1']);
      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthescalate'));
      }
      // Simulate the first (00:45) lockout having already expired, the same safe technique
      // test/login-lockout.test.js uses — no real wait needed to prove the schedule.
      await db.collection('loginLockouts').updateMany({ scope: 'ip', key: { $in: ['::1', '::ffff:127.0.0.1', '127.0.0.1'] } }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });

      for (let i = 0; i < 5; i++) {
        await agent.get('/auth/google/callback').set('x-test-google-email', uniqueEmail('oauthescalate2'));
      }
      const doc = await db.collection('loginLockouts').findOne({ scope: 'ip', key: { $in: ['::1', '::ffff:127.0.0.1', '127.0.0.1'] }, lockedUntil: { $ne: null } });
      expect(doc).toBeTruthy();
      const seconds = Math.round((new Date(doc.lockedUntil).getTime() - Date.now()) / 1000);
      expect(seconds).toBe(105);
    });
  }, 30000);
});
