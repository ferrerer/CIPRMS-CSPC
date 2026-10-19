// services/loginLockoutService.js — the progressive sign-in lockout behind POST /login and the Google
// OAuth routes, and the 2026-10 authentication hardening rolling-15-minute-window redesign of it.
//
// cirl.js's own wiring (checkSignInLockout/recordSignInFailure/recordSignInSuccess) is bypassed entirely
// under NODE_ENV=test — the same reason the old flat limiters were (this suite's many independent logins,
// all sharing one supertest "IP", would otherwise trip a real, persisted lockout mid-suite and spuriously
// fail unrelated tests; see test/brute-force-protection.test.js's own header comment). That bypass means
// the real HTTP route can never be used to test the lockout's actual trip/escalate/expire/decay behavior
// inside this process. This file tests the SERVICE directly instead — no HTTP, no cirl.js, no NODE_ENV
// bypass — against the real guarded test database, with time-sensitive states (an already-expired lockout,
// a decayed tier, a failure that has aged out of the rolling window) created by writing the stored
// timestamps/arrays directly rather than waiting real wall-clock minutes.
const { connectDB, closeDB, getDb } = require('../db');
const svc = require('../services/loginLockoutService');

const SCOPE = 'account';
let db;

function uniqueKey(label) {
  return `jesttest.lockout.${label}.${Date.now()}.${Math.floor(Math.random() * 1e6)}@example.com`;
}

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  await db.collection('loginLockouts').deleteMany({ key: { $regex: '^jesttest\\.lockout\\.' } });
  await closeDB();
});

describe('Reaching the limit triggers a lockout; staying under it never does', () => {
  test(`fewer than MAX_ATTEMPTS (${svc.MAX_ATTEMPTS}) failures never locks the key`, async () => {
    const key = uniqueKey('under-limit');
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS - 1; i++) {
      result = await svc.recordFailure(db, SCOPE, key);
      expect(result.locked).toBe(false);
    }
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(false);
  });

  test(`the MAX_ATTEMPTS-th (${svc.MAX_ATTEMPTS}th) consecutive failure locks the key for the first tier's duration (00:45)`, async () => {
    const key = uniqueKey('fifth-fail');
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBe(45);
    const status = await svc.getLockoutStatus(db, SCOPE, key);
    expect(status.locked).toBe(true);
    expect(status.retryAfterSeconds).toBe(45);
  });
});

describe('A sixth attempt while locked is still blocked, and the lockout expires exactly when its duration ends', () => {
  test('getLockoutStatus keeps reporting locked for every check made before lockedUntil', async () => {
    const key = uniqueKey('still-locked');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key);
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(true);
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(true); // a second check, same still-locked answer — checking does not itself clear it
  });

  test('once lockedUntil has passed, the very next check reports unlocked — expiry is based on real elapsed time, not a client timer', async () => {
    const key = uniqueKey('expired');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key);
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(true);
    // Simulates real time having passed, the same way a live 45-second wait would — no fake timer needed
    // since the service always re-reads the stored timestamp rather than caching anything in memory.
    await db.collection('loginLockouts').updateOne({ scope: SCOPE, key }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(false);
  });
});

describe('Only failures within a rolling 15-minute window count toward the threshold (2026-10 authentication hardening)', () => {
  test('4 failures older than the 15-minute window plus 1 fresh one do NOT lock — the stale ones have aged out', async () => {
    const key = uniqueKey('rolling-stale');
    const staleTimestamp = new Date(Date.now() - svc.ROLLING_WINDOW_MS - 60000); // 16 minutes ago
    // Seed the document with 4 failures that are already outside the window, as if they happened long ago —
    // written directly (not via 4 real recordFailure() calls) so the test controls their age precisely.
    await db.collection('loginLockouts').updateOne(
      { scope: SCOPE, key },
      { $set: { recentFailures: [staleTimestamp, staleTimestamp, staleTimestamp, staleTimestamp], tier: 0, lockedUntil: null, lastFailureAt: staleTimestamp } },
      { upsert: true }
    );
    const result = await svc.recordFailure(db, SCOPE, key); // the 5th failure overall, but only the 2nd within the window
    expect(result.locked).toBe(false);
    const doc = await db.collection('loginLockouts').findOne({ scope: SCOPE, key });
    expect(doc.recentFailures).toHaveLength(1); // the 4 stale entries were filtered out, only the fresh one remains
  });

  test('4 failures still inside the window plus 1 fresh one DOES lock — they have not aged out', async () => {
    const key = uniqueKey('rolling-fresh');
    const recentTimestamp = new Date(Date.now() - 10 * 60 * 1000); // 10 minutes ago — inside the 15-minute window
    await db.collection('loginLockouts').updateOne(
      { scope: SCOPE, key },
      { $set: { recentFailures: [recentTimestamp, recentTimestamp, recentTimestamp, recentTimestamp], tier: 0, lockedUntil: null, lastFailureAt: recentTimestamp } },
      { upsert: true }
    );
    const result = await svc.recordFailure(db, SCOPE, key); // the 5th, and all 5 are within the window
    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBe(45);
  });

  test('boundary (2026-10 Phase 1.1, made explicit): a failure just OUTSIDE 15 minutes ago does not count, one just INSIDE does', async () => {
    // Deterministic via controlled timestamps, not a real 15-minute wait — no injectable clock exists on the
    // service (recordFailure always calls `new Date()` internally), so a literal millisecond-exact boundary
    // isn't reachable without one; a tight, fixed 500ms margin on each side of ROLLING_WINDOW_MS is enough to
    // prove the documented half-open-interval decision (now-15m, now] without being racy against real DB
    // round-trip latency the way testing at exactly 0ms margin would be.
    const justOutsideKey = uniqueKey('boundary-outside');
    const justOutsideTimestamp = new Date(Date.now() - svc.ROLLING_WINDOW_MS - 500); // 15:00.5 ago — expired
    await db.collection('loginLockouts').updateOne(
      { scope: SCOPE, key: justOutsideKey },
      { $set: { recentFailures: [justOutsideTimestamp, justOutsideTimestamp, justOutsideTimestamp, justOutsideTimestamp], tier: 0, lockedUntil: null, lastFailureAt: justOutsideTimestamp } },
      { upsert: true }
    );
    const outsideResult = await svc.recordFailure(db, SCOPE, justOutsideKey);
    expect(outsideResult.locked).toBe(false); // only the 1 fresh failure remains after the 4 stale ones are trimmed

    const justInsideKey = uniqueKey('boundary-inside');
    const justInsideTimestamp = new Date(Date.now() - svc.ROLLING_WINDOW_MS + 500); // 14:59.5 ago — still inside
    await db.collection('loginLockouts').updateOne(
      { scope: SCOPE, key: justInsideKey },
      { $set: { recentFailures: [justInsideTimestamp, justInsideTimestamp, justInsideTimestamp, justInsideTimestamp], tier: 0, lockedUntil: null, lastFailureAt: justInsideTimestamp } },
      { upsert: true }
    );
    const insideResult = await svc.recordFailure(db, SCOPE, justInsideKey);
    expect(insideResult.locked).toBe(true); // all 5 (4 still-valid + 1 fresh) count
  });

  test('5 truly concurrent failures for one key lock it exactly once, with no lost increments — the atomicity the rolling-window redesign must not regress', async () => {
    // Same reproduction technique the service's own header comment describes for the original failCount
    // race: fire every call before any of them has resolved.
    const key = uniqueKey('concurrent');
    const results = await Promise.all(Array.from({ length: 5 }, () => svc.recordFailure(db, SCOPE, key)));
    const lockedCount = results.filter((r) => r.locked).length;
    expect(lockedCount).toBe(1); // exactly one call observes crossing the threshold, never zero, never more than one
    expect((await svc.getLockoutStatus(db, SCOPE, key)).locked).toBe(true);
  });
});

describe('Repeated lockouts escalate: 00:45 → 01:45 → 03:45 → 07:45 → 15:45, then capped', () => {
  async function expireCurrentLockout(key) {
    await db.collection('loginLockouts').updateOne({ scope: SCOPE, key }, { $set: { lockedUntil: new Date(Date.now() - 1000) } });
  }

  test('a second lockout for the same key is 01:45 (105s), not 00:45 again — the escalation actually carries over', async () => {
    const key = uniqueKey('escalate-2');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key);
    await expireCurrentLockout(key);
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBe(105);
  });

  test('the full approved schedule — 45, 105, 225, 465, then 945 seconds and capped there for every lockout after', async () => {
    const key = uniqueKey('escalate-full');
    const expectedSeconds = [45, 105, 225, 465, 945, 945, 945]; // two extra rounds past the cap, to prove it never grows further
    const actualSeconds = [];
    for (const _ of expectedSeconds) {
      let result;
      for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
      expect(result.locked).toBe(true);
      actualSeconds.push(result.retryAfterSeconds);
      await expireCurrentLockout(key);
    }
    expect(actualSeconds).toEqual(expectedSeconds);
  });
});

describe('The escalation tier decays after a quiet period, but a lone success never launders it', () => {
  test('a success clears the current rolling-window failures and any lockout, but leaves the escalation tier exactly where it was', async () => {
    const key = uniqueKey('success-no-launder');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key); // tier -> 1, now locked
    await svc.recordSuccess(db, SCOPE, key);
    const docAfterSuccess = await db.collection('loginLockouts').findOne({ scope: SCOPE, key });
    expect(docAfterSuccess.recentFailures).toEqual([]);
    expect(docAfterSuccess.lockedUntil).toBeNull();
    expect(docAfterSuccess.tier).toBe(1); // NOT reset by the success

    // Prove the tier really did carry over: the next lockout for this key is still the 2nd-tier duration
    // (105s), not back down to the 1st (45s) — a success never "launders" the escalation.
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(result.retryAfterSeconds).toBe(105);
  });

  test(`${svc.TIER_DECAY_MS / 3600000} hours with no failure resets the tier back to the start — a lone old incident can never compound forever`, async () => {
    const key = uniqueKey('decay');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key); // tier -> 1
    await db.collection('loginLockouts').updateOne({ scope: SCOPE, key }, {
      $set: { lockedUntil: new Date(Date.now() - 1000), lastFailureAt: new Date(Date.now() - svc.TIER_DECAY_MS - 1000) }
    });
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(result.locked).toBe(true);
    expect(result.retryAfterSeconds).toBe(45); // back to the first tier's duration, not the 2nd
  });

  test('a quiet period just UNDER the decay window does NOT reset the tier', async () => {
    const key = uniqueKey('no-premature-decay');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, SCOPE, key); // tier -> 1
    await db.collection('loginLockouts').updateOne({ scope: SCOPE, key }, {
      $set: { lockedUntil: new Date(Date.now() - 1000), lastFailureAt: new Date(Date.now() - svc.TIER_DECAY_MS + 60000) }
    });
    let result;
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) result = await svc.recordFailure(db, SCOPE, key);
    expect(result.retryAfterSeconds).toBe(105); // still escalated, decay had not actually elapsed yet
  });
});

describe('IP scope and account scope are tracked completely independently', () => {
  test('locking one account does not touch a different account, and locking an account does not touch an IP', async () => {
    const accountA = uniqueKey('account-a');
    const accountB = uniqueKey('account-b');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, 'account', accountA);
    expect((await svc.getLockoutStatus(db, 'account', accountA)).locked).toBe(true);
    expect((await svc.getLockoutStatus(db, 'account', accountB)).locked).toBe(false);
    expect((await svc.getLockoutStatus(db, 'ip', accountA)).locked).toBe(false); // same string, different scope — never cross-read
  });

  test('the password route\'s own scope label is independent of the Google route\'s "account" scope for the SAME e-mail (2026-10 authentication hardening)', async () => {
    const email = uniqueKey('cross-route');
    for (let i = 0; i < svc.MAX_ATTEMPTS; i++) await svc.recordFailure(db, 'account-password', email);
    expect((await svc.getLockoutStatus(db, 'account-password', email)).locked).toBe(true);
    expect((await svc.getLockoutStatus(db, 'account', email)).locked).toBe(false); // the Google-flow scope for this same email is untouched
  });
});

describe('normalizeAccountKey matches the real login lookup\'s own normalization exactly', () => {
  test('trims and lower-cases', () => {
    expect(svc.normalizeAccountKey('  Someone@Example.COM  ')).toBe('someone@example.com');
  });
  test('non-string input never throws — returns an empty, falsy key instead', () => {
    expect(svc.normalizeAccountKey(undefined)).toBe('');
    expect(svc.normalizeAccountKey(null)).toBe('');
    expect(svc.normalizeAccountKey({ $ne: null })).toBe('');
  });
});

describe('lockoutMessage is an exact MM:SS countdown, and never reveals the scope, the attempt threshold, or any account-existence signal', () => {
  test('the approved policy\'s own example value renders exactly as specified: "00:45"', () => {
    expect(svc.lockoutMessage(45)).toBe('Too many sign-in attempts. Please try again in 00:45.');
  });
  test('sub-10-second and sub-10-minute values are zero-padded on both sides of the colon', () => {
    expect(svc.lockoutMessage(5)).toBe('Too many sign-in attempts. Please try again in 00:05.');
    expect(svc.lockoutMessage(65)).toBe('Too many sign-in attempts. Please try again in 01:05.');
  });
  test('the full escalation schedule\'s own values render exactly: 01:45, 03:45, 07:45, 15:45', () => {
    expect(svc.lockoutMessage(105)).toBe('Too many sign-in attempts. Please try again in 01:45.');
    expect(svc.lockoutMessage(225)).toBe('Too many sign-in attempts. Please try again in 03:45.');
    expect(svc.lockoutMessage(465)).toBe('Too many sign-in attempts. Please try again in 07:45.');
    expect(svc.lockoutMessage(945)).toBe('Too many sign-in attempts. Please try again in 15:45.');
  });
  test('never mentions "account", "ip", a specific attempt count, or the word "scope"', () => {
    const msg = svc.lockoutMessage(900);
    expect(msg).not.toMatch(/account|\bip\b|scope|\b5\b/i);
  });
});

describe('A lookup/write failure fails open rather than becoming a second outage', () => {
  const brokenDb = { collection() { throw new Error('simulated DB failure'); } };
  test('getLockoutStatus reports not-locked rather than throwing', async () => {
    await expect(svc.getLockoutStatus(brokenDb, SCOPE, 'whoever')).resolves.toEqual({ locked: false });
  });
  test('recordFailure reports not-locked rather than throwing — a DB hiccup never itself blocks a real sign-in attempt', async () => {
    await expect(svc.recordFailure(brokenDb, SCOPE, 'whoever')).resolves.toEqual({ locked: false });
  });
  test('recordSuccess never throws either', async () => {
    await expect(svc.recordSuccess(brokenDb, SCOPE, 'whoever')).resolves.toBeUndefined();
  });
});
