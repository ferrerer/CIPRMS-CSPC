// Brute-force protection (2026-10-28 investigation; superseded 2026-11 by the Google-only sign-in /
// progressive rate limiting task).
//
// The 2026-10-28 fix (every login outcome answers a real, distinguishable status code, not always 200) is
// still exactly as it was and is verified below unchanged. What changed 2026-11: the IP-keyed and
// account-keyed express-rate-limit instances this file used to test (loginLimiter/loginIdentifierLimiter,
// flat 10-attempts/15-minute, in-memory, /login-only) were replaced by a single progressive, MongoDB-
// persisted lockout (services/loginLockoutService.js) shared by POST /login AND the Google OAuth routes
// (GET /auth/google, GET /auth/google/callback) — see cirl.js's checkSignInLockout/recordSignInFailure/
// recordSignInSuccess. The max before a lockout is now 5 attempts (was 10), and a repeat offender's next
// lockout is progressively longer (1/5/15/30/60 minutes) instead of always the same fixed window.
//
// What Jest in this process still CANNOT verify end to end through the real route: checkSignInLockout/
// recordSignInFailure/recordSignInSuccess are bypassed under NODE_ENV=test for the same reason the old
// limiters were — this suite's many independent per-test logins, all sharing one supertest "IP", would
// otherwise trip a real, persisted lockout mid-suite and spuriously fail unrelated tests. The underlying
// service's actual trip/escalate/expire/decay behavior is unit-tested directly, without that bypass, in
// test/login-lockout.test.js; the full real-HTTP trip-after-5-attempts/429/Google-routes-also-blocked
// behavior was verified live against a real (non-test-mode) server — see the chat response for that
// result. This file verifies the parts a test-mode bypass doesn't hide: the real status codes every login
// outcome returns, and that the lockout wiring in the source is what it claims to be.
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, cleanupAll, TEST_TAG } = require('./helpers');

const src = fs.readFileSync(path.join(__dirname, '..', 'cirl.js'), 'utf8');
const lockoutSrc = fs.readFileSync(path.join(__dirname, '..', 'services', 'loginLockoutService.js'), 'utf8');

afterAll(async () => { await cleanupAll(); await closeDB(); });

describe('Every login outcome still answers a real, distinguishable status code (not always 200)', () => {
  let user;
  beforeAll(async () => { await connectDB(); user = await createTestUser({ role: 'Staff' }); });

  test('success → 302 (unchanged — a real redirect, already < 400, already correctly "successful")', async () => {
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    expect(res.status).toBe(302);
  });

  test('wrong password → 401, not 200', async () => {
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: 'Wrong1' });
    expect(res.status).toBe(401);
  });

  test('unknown account → 401, identical status to wrong password (still no enumeration signal)', async () => {
    const res = await request(app).post('/login').type('form').send({ username: `${TEST_TAG}.bfp.nouser.${Date.now()}@example.com`, password: 'Whatever1' });
    expect(res.status).toBe(401);
  });

  test('disabled account → 401', async () => {
    const db = await connectDB();
    const disabled = await createTestUser();
    await db.collection('users').updateOne({ id: disabled.id }, { $set: { status: 'Inactive' } });
    const res = await request(app).post('/login').type('form').send({ username: disabled.email, password: disabled.password });
    expect(res.status).toBe(401);
  });

  test('Google-only account attempting a password login → 401', async () => {
    const db = await connectDB();
    const googleOnly = await createTestUser();
    await db.collection('users').updateOne({ id: googleOnly.id }, { $unset: { password: '' } });
    const res = await request(app).post('/login').type('form').send({ username: googleOnly.email, password: 'anything' });
    expect(res.status).toBe(401);
  });

  test('malformed request (missing password) → 400, not 401 — it never reached any account', async () => {
    const res = await request(app).post('/login').type('form').send({ username: user.email });
    expect(res.status).toBe(400);
  });
});

describe('Source-level: the progressive lockout is wired onto POST /login AND both Google OAuth routes', () => {
  // Bounded dynamically by the NEXT route declaration, not a guessed character count — robust to either
  // route growing over time.
  const loginStart = src.indexOf("app.post('/login', async (req, res) => {");
  const loginBlock = src.slice(loginStart, src.indexOf('app.get(', loginStart + 50));
  const callbackStart = src.indexOf("app.get('/auth/google/callback'");
  const callbackBlock = src.slice(callbackStart, src.indexOf("app.post('/login'", callbackStart));

  test('POST /login no longer carries the old flat express-rate-limit middleware — the lockout check now happens inside the handler', () => {
    expect(src).toContain("app.post('/login', async (req, res) => {");
    // The old identifiers only ever appear now in explanatory history comments, never as a real
    // declaration/usage — checked precisely rather than a blanket "the substring never appears anywhere",
    // which would also forbid legitimately documenting what this code replaced.
    expect(src).not.toMatch(/\bconst loginLimiter\b/);
    expect(src).not.toMatch(/\bconst loginIdentifierLimiter\b/);
    expect(src).not.toContain('function makeLoginBlockedHandler');
    expect(loginBlock).not.toMatch(/\bloginLimiter\b|\bloginIdentifierLimiter\b/);
  });

  test('both GET /auth/google and GET /auth/google/callback check the lockout before doing anything else — restarting the OAuth flow cannot bypass it', () => {
    const initBlock = src.slice(src.indexOf("app.get('/auth/google',"), callbackStart);
    // 2026-11 Google-OAuth-audit-trail fix: checkSignInLockout() grew two more (optional) params —
    // identifierForAudit and method — so the Google routes can tag their audit rows as 'google' rather
    // than silently defaulting to 'password'. Matched here with .toMatch(), not a hardcoded 4-arg
    // .toContain(), so this test keeps working if the call ever gains/reorders further optional args.
    expect(initBlock).toMatch(/checkSignInLockout\(req, res, 'ip', ip,\s*null,\s*'google'\)/);
    expect(callbackBlock).toMatch(/checkSignInLockout\(req, res, 'ip', ip,\s*null,\s*'google'\)/);
    expect(callbackBlock).toContain("checkSignInLockout(req, res, 'account', accountKey");
    // The ip-scope check must run before passport.authenticate is ever invoked — not after Google has
    // already been contacted — so a locked-out IP never even starts a token exchange.
    expect(callbackBlock.search(/checkSignInLockout\(req, res, 'ip', ip/)).toBeLessThan(callbackBlock.indexOf('passport.authenticate'));
  });

  test('the account-scope KEY normalization (trim + lowercase) is identical for both the password form and the Google profile e-mail, even though each route now has its own separate scope/budget (2026-10 authentication hardening)', () => {
    expect(src).toContain('loginLockoutService.normalizeAccountKey(username)');
    expect(src).toContain('loginLockoutService.normalizeAccountKey(googleEmail)');
    expect(lockoutSrc).toMatch(/email\.trim\(\)\.toLowerCase\(\)/);
  });

  test('invalid OAuth state / a failed callback / no Google profile all count as a failure (ip-scope) before any CIPRMS account is known', () => {
    expect(callbackBlock).toMatch(/if \(err\) \{[^}]*recordSignInFailure\('ip', ip\)/);
    expect(callbackBlock).toMatch(/if \(!googleUser\) \{[^}]*recordSignInFailure\('ip', ip\)/);
  });

  test('a password attempt against a Google-only account never counts toward the lockout — it is excluded by name, not just by accident', () => {
    expect(loginBlock).toMatch(/countableReasons\s*=\s*new Set\(\[[^\]]*\]\)/);
    const countableMatch = loginBlock.match(/countableReasons\s*=\s*new Set\(\[([^\]]*)\]\)/);
    expect(countableMatch[1]).not.toMatch(/google_account_only/);
    expect(countableMatch[1]).not.toMatch(/system_error/);
  });

  // 2026-11 cross-account rate-limiting fix: a successful sign-in clears ONLY the account scope, never the
  // IP scope. Clearing the IP's own failure count on any one account's success would let an attacker
  // credential-stuff a run of DIFFERENT accounts from a shared/NAT IP for free every time an unrelated,
  // legitimate colleague on that same IP happens to sign in — proving control of one account only ever
  // vouches for that account, never for the IP it came from.
  test('a successful sign-in clears the account scope only — never the shared IP scope', () => {
    // POST /login uses its OWN account scope (PASSWORD_ACCOUNT_SCOPE, 2026-10 authentication hardening) —
    // separate from the Google callback's 'account' scope, so a password attempt against an email can never
    // affect that same email's Google-sign-in lockout. See PASSWORD_ACCOUNT_SCOPE's own comment in cirl.js.
    expect(loginBlock).toContain("recordSignInSuccess(PASSWORD_ACCOUNT_SCOPE, accountKey)");
    expect(loginBlock).not.toContain("recordSignInSuccess('ip', ip)");
    expect(callbackBlock).toContain("recordSignInSuccess('account', accountKey)");
    expect(callbackBlock).not.toContain("recordSignInSuccess('ip', ip)");
  });

  test('a blocked request writes one LOGIN_BLOCKED row and never a password/token, and the client-facing message names neither scope, limit nor window', () => {
    expect(src).toContain('async function checkSignInLockout(');
    const start = src.indexOf('async function checkSignInLockout(');
    const fnEnd = src.indexOf('\n}', start);
    const fnBlock = src.slice(start, fnEnd);
    expect(fnBlock).toContain("'LOGIN_BLOCKED'");
    expect(fnBlock).toContain("status: 'blocked'");
    expect(fnBlock).toContain("reason: 'rate_limited'");
    // 2026-11: the `method` param's fallback label is the literal string 'password' (vs. 'google') — a
    // category name, never a credential — so the check below targets real secret-bearing identifiers
    // (an actual password/token VALUE being read or logged) rather than banning the word outright.
    expect(fnBlock).not.toMatch(/req\.body\.password|accessToken|refreshToken|clientSecret|authorization.?code/i);
    expect(fnBlock).not.toMatch(/\b5\b|\bip-based\b|\baccount-based\b/i);
  });

  test('the max attempts before a lockout is 5 (not the old 10), configured once in the service, not duplicated in cirl.js', () => {
    expect(lockoutSrc).toContain('const MAX_ATTEMPTS = 5;');
    expect(src).not.toMatch(/MAX_ATTEMPTS\s*=\s*\d/); // cirl.js never redefines its own copy of this number
  });

  test('the escalation schedule matches the 2026-10 approved policy exactly: 00:45, 01:45, 03:45, 07:45, 15:45, capped — never permanent, never unbounded', () => {
    expect(lockoutSrc).toContain('const LOCKOUT_DURATIONS_MS = [45 * 1000, 105 * 1000, 225 * 1000, 465 * 1000, 945 * 1000];');
  });

  test('a lockout only triggers from failures within a rolling 15-minute window, not simply "5 in a row no matter how spread out"', () => {
    expect(lockoutSrc).toContain('const ROLLING_WINDOW_MS = 15 * 60 * 1000;');
    expect(lockoutSrc).toMatch(/\$filter:\s*\{[\s\S]*?cond:\s*\{\s*\$gt:\s*\[\s*'\$\$ts',\s*\{\s*\$subtract:\s*\[now,\s*ROLLING_WINDOW_MS\]\s*\}\s*\]\s*\}/);
  });

  test('the escalation tier decays after a clearly defined quiet period, so a stale old incident can never compound forever', () => {
    expect(lockoutSrc).toContain('const TIER_DECAY_MS = 24 * 60 * 60 * 1000;');
  });
});

describe('The existing centralized Express error handler is unchanged and still the single fallback', () => {
  test('/login\'s own try/catch still answers safely, and the one global error handler is still the last-resort path (both untouched)', () => {
    expect(src).toContain("app.use((err, req, res, next) => {");
    expect(src.match(/app\.use\(\(err, req, res, next\) => \{/g)).toHaveLength(1); // still exactly one centralized handler, no duplicate added
    expect(src).toContain("'An unexpected server error occurred.'");
  });
});
