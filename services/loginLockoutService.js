// ── Progressive sign-in lockout (2026-11) ────────────────────────────────────────────────────────
// Shared by POST /login and the Google OAuth sign-in routes (GET /auth/google, GET /auth/google/callback)
// in cirl.js — one unified mechanism so an attacker cannot reset or bypass a lockout by switching between
// the password form and Google sign-in, or by restarting the OAuth flow, or by refreshing the page
// (nothing here is stored in the session/cookie — it is keyed by IP address or by the submitted/Google
// account e-mail and persisted in MongoDB, so it survives a page refresh, a new browser session, a new
// OAuth attempt, and a server restart, and is correct across multiple application instances since every
// instance reads/writes the same collection rather than an in-memory counter).
//
// Replaces the old flat, in-memory, 10-attempts/15-minute express-rate-limit pair that used to guard only
// POST /login (loginLimiter/loginIdentifierLimiter) — those never covered the Google routes at all, could
// not escalate, and reset on every process restart. This module is the single place attempts are counted;
// callers must call recordFailure()/recordSuccess() exactly once per real outcome (never from more than one
// place for the same request) to avoid double-counting one authentication event.
//
// Two independent scopes are tracked, each with its own document and its own escalation state:
//   'ip'      — keyed by the client's IP address (req's own getClientIp()). Always safe to escalate: the
//               only party ever punished by an IP's own lockout is whoever is actually making the requests.
//   'account' — keyed by the normalized e-mail that was attempted (trimmed, lower-cased), REGARDLESS of
//               whether that account exists — matching the already-existing pre-2026-11 account-scope
//               limiter's own behavior for /login. This is what stops a single account being brute-forced
//               from many different IPs, and what keeps a password-flow attempt and a Google-flow attempt
//               against the SAME account from each getting their own separate budget.
//
// Escalation policy (2026-10 authentication hardening, approved schedule): 5 qualifying failures within a
// ROLLING 15-minute window triggers a lockout — not simply "5 in a row no matter how spread out," which is
// what a plain incrementing counter gives you. Each time a key is locked out again, the NEXT lockout is
// longer, up to a defined cap — never permanent and never unbounded:
//   1st: 00:45   2nd: 01:45   3rd: 03:45   4th: 07:45   5th and later: 15:45 (cap)
// A key's escalation tier decays back to the start (next lockout is 00:45 again) once TIER_DECAY_MS has
// passed with no further failure — unchanged from the original policy, and a SEPARATE concept from the
// rolling window above: the window decides whether a given lockout triggers at all, the tier decay decides
// how severe the NEXT one is once it does.
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATIONS_MS = [45 * 1000, 105 * 1000, 225 * 1000, 465 * 1000, 945 * 1000];
const ROLLING_WINDOW_MS = 15 * 60 * 1000; // only failures within this trailing window count toward MAX_ATTEMPTS
const TIER_DECAY_MS = 24 * 60 * 60 * 1000; // 24 hours of no failures resets the escalation tier to 0
const COLLECTION = 'loginLockouts';

function lockoutDurationForTier(tier) {
  const idx = Math.max(0, Math.min(tier, LOCKOUT_DURATIONS_MS.length - 1));
  return LOCKOUT_DURATIONS_MS[idx];
}

function normalizeAccountKey(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

// Never throws — a lockout check must never itself become the reason sign-in breaks for everyone if the
// DB has a hiccup; callers get "not locked" on any read error (fails open, same spirit as every other
// best-effort check elsewhere in this app), and the real sign-in attempt that follows still goes through
// its own normal validation.
async function getLockoutStatus(db, scope, key) {
  if (!key) return { locked: false };
  try {
    const doc = await db.collection(COLLECTION).findOne({ scope, key });
    if (!doc || !doc.lockedUntil) return { locked: false };
    const lockedUntil = new Date(doc.lockedUntil);
    const remainingMs = lockedUntil.getTime() - Date.now();
    if (remainingMs <= 0) return { locked: false };
    return { locked: true, lockedUntil, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
  } catch (err) {
    console.error('❌ getLockoutStatus error (failing open):', err.message);
    return { locked: false };
  }
}

/**
 * Records one failed sign-in attempt for the given scope/key. If this is the MAX_ATTEMPTS-th failure to land
 * within the trailing ROLLING_WINDOW_MS, locks the key out for the current tier's duration and advances the
 * tier for next time.
 *
 * MUST be a single atomic MongoDB operation, never a separate findOne() followed by updateOne() — a 2026-11
 * live-testing report (5 different Google accounts from one IP "continued past the expected five-attempt
 * limit") traced to exactly that read-then-write gap: two concurrent failures (e.g. the account-not-found
 * rejection for account #3 arriving while account #2's own rejection was still being written) could both
 * read the SAME pre-update document and each write back their own version, silently losing one of the two
 * real failures — under concurrent load this can lose enough of them that the threshold is never reached at
 * all. Reproduced directly against the old read-then-write version: 5 truly concurrent calls for one key
 * left it with only 1 recorded failure, and none reported locked. Fixed by doing the entire read-decide-
 * write as one aggregation-pipeline findOneAndUpdate() — MongoDB applies a single update operation to a
 * document as one atomic unit regardless of how many concurrent callers target the same document, so
 * concurrent requests serialize into the document one at a time with no lost failures, no double lockouts,
 * and no risk of an attacker exploiting the gap by firing attempts in quick succession. The 2026-10 rolling-
 * window redesign below keeps this same atomicity guarantee: appending to, and trimming, the `recentFailures`
 * timestamp array happens inside the SAME single pipeline, not as a separate read-modify-write.
 * @returns {Promise<{locked:boolean, lockedUntil?:Date, retryAfterSeconds?:number}>}
 */
async function recordFailure(db, scope, key) {
  if (!key) return { locked: false };
  try {
    const now = new Date();
    // Stage 1: tier decay check — purely from the document's existing lastFailureAt (never a value read in
    // a separate round trip). Unchanged concept from before: 24h with no failure resets the escalation tier,
    // independent of the (much shorter) rolling window below.
    // Stage 2: append `now` to recentFailures, then filter the array down to only entries still inside the
    // trailing ROLLING_WINDOW_MS — both in the same $set, so a concurrent caller on this same key can never
    // observe (or race against) a half-updated array. Boundary decision (2026-10 Phase 1.1, made explicit):
    // a failure timestamped EXACTLY ROLLING_WINDOW_MS before `now` is treated as expired, not still inside
    // the window — `$gt` (strict), not `$gte`. "Within the trailing 15 minutes" is read as a half-open
    // interval (now-15m, now], and a failure sitting precisely on the open end has, at that exact instant,
    // already aged out of the 15-minute window rather than still being counted in it.
    // Stage 3: decide, from the TRIMMED array's own length, whether this failure is the one that crosses
    // MAX_ATTEMPTS within the window — if so, set lockedUntil from the tier the document already had
    // (BEFORE this operation bumps it), advance the tier, and reset recentFailures for the next cycle.
    const durationsExpr = { $arrayElemAt: [LOCKOUT_DURATIONS_MS, { $min: ['$tier', LOCKOUT_DURATIONS_MS.length - 1] }] };
    const pipeline = [
      { $set: {
          _tierDecayed: { $or: [
            { $eq: [{ $ifNull: ['$lastFailureAt', null] }, null] },
            { $gt: [{ $subtract: [now, '$lastFailureAt'] }, TIER_DECAY_MS] }
          ] }
      } },
      { $set: {
          tier: { $cond: ['$_tierDecayed', 0, { $ifNull: ['$tier', 0] }] },
          recentFailures: {
            $filter: {
              input: { $concatArrays: [{ $ifNull: ['$recentFailures', []] }, [now]] },
              as: 'ts',
              cond: { $gt: ['$$ts', { $subtract: [now, ROLLING_WINDOW_MS] }] }
            }
          }
      } },
      { $set: { _justLocked: { $gte: [{ $size: '$recentFailures' }, MAX_ATTEMPTS] } } },
      { $set: {
          lockedUntil: { $cond: ['$_justLocked', { $add: [now, durationsExpr] }, { $ifNull: ['$lockedUntil', null] }] },
          tier: { $cond: ['$_justLocked', { $add: ['$tier', 1] }, '$tier'] },
          recentFailures: { $cond: ['$_justLocked', [], '$recentFailures'] },
          lastFailureAt: now
      } },
      { $unset: ['_tierDecayed', '_justLocked'] }
    ];
    const doc = await db.collection(COLLECTION).findOneAndUpdate(
      { scope, key },
      pipeline,
      { upsert: true, returnDocument: 'after' }
    );
    const result = doc && doc.value !== undefined ? doc.value : doc; // driver-version-proofs: some return {value}, some return the doc directly
    if (result && result.lockedUntil && new Date(result.lockedUntil).getTime() > now.getTime()) {
      const lockedUntil = new Date(result.lockedUntil);
      return { locked: true, lockedUntil, retryAfterSeconds: Math.ceil((lockedUntil.getTime() - now.getTime()) / 1000) };
    }
    return { locked: false };
  } catch (err) {
    console.error('❌ recordFailure error (failing open):', err.message);
    return { locked: false };
  }
}

/**
 * Records a successful sign-in: clears the CURRENT attempt cycle (so one slip-up right after a success
 * doesn't carry over a near-miss count) and clears any lockout that may have just expired. Deliberately
 * does NOT reset `tier` — a key's escalation history only decays through TIER_DECAY_MS of no failures,
 * never through a single success, so an attacker cannot "launder" their escalation level by occasionally
 * succeeding against an unrelated account from the same IP.
 */
async function recordSuccess(db, scope, key) {
  if (!key) return;
  try {
    await db.collection(COLLECTION).updateOne(
      { scope, key },
      { $set: { recentFailures: [], lockedUntil: null } }
    );
  } catch (err) {
    console.error('❌ recordSuccess error (non-fatal):', err.message);
  }
}

// MM:SS — the approved policy's own durations include odd, sub-minute and ":45"-second values (00:45 up to
// 15:45), where the previous whole-minutes-rounded-up wording ("in 2 minutes" for a 1:45 lockout) would be
// measurably imprecise. Never exposes the scope (ip vs account), the attempt threshold, or any
// account-existence signal — matches the plain-language, information-minimal style every other client-facing
// auth message in this file already uses.
function formatMMSS(totalSeconds) {
  const s = Math.max(0, Math.ceil(totalSeconds));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  return `${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
}
function lockoutMessage(retryAfterSeconds) {
  return `Too many sign-in attempts. Please try again in ${formatMMSS(retryAfterSeconds)}.`;
}

module.exports = {
  MAX_ATTEMPTS,
  LOCKOUT_DURATIONS_MS,
  ROLLING_WINDOW_MS,
  TIER_DECAY_MS,
  lockoutDurationForTier,
  normalizeAccountKey,
  getLockoutStatus,
  recordFailure,
  recordSuccess,
  formatMMSS,
  lockoutMessage
};
