require('dotenv').config();

const express = require('express');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const net = require('net');
const session = require('express-session');
const passport = require('passport');
const bcrypt = require('bcrypt');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const { connectDB, getDb, insertWithNextId, insertManyWithNextId } = require('./db');
const ocrRoutes = require('./routes/ocrRoutes');
const { updateDocument, archiveToDocumentLibrary, archiveRequestRecordToLibrary } = require('./services/documentLibraryService');
const googleCalendarService = require('./services/googleCalendarService');
const googleDocsService = require('./services/googleDocsService');
const emailService = require('./services/emailService');
const systemStatusService = require('./services/systemStatusService');
const loginLockoutService = require('./services/loginLockoutService');
const notificationService = require('./services/notificationService');
const realtime = require('./services/realtime');
const searchService = require('./services/searchService');
const geocoding = require('./services/geocodingService');
const uploadAvatar = require('./middleware/avatarUploadMiddleware');
const uploadDoc = require('./middleware/uploadMiddleware');
const verifyMagicBytes = require('./middleware/verifyMagicBytes');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;

// ── SECURITY HEADERS (F-01, F-02) ────────────────────────────────────────────
// helmet sets CSP, X-Frame-Options, X-Content-Type-Options, Referrer-Policy,
// Permissions-Policy and others. x-powered-by is explicitly disabled so the
// framework identity is never disclosed even if helmet is later overridden.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "accounts.google.com", "unpkg.com"],
      // helmet's own CSP defaults (applied underneath whatever this object overrides — see
      // https://github.com/helmetjs/helmet#content-security-policy) set script-src-attr to 'none'
      // regardless of scriptSrc above, which disables every inline onclick="..." attribute in the
      // app (almost every button site-wide uses that pattern) even though inline <script> tags
      // (governed by scriptSrc, 'unsafe-inline' already allowed there) kept working. Confirmed live
      // in a real browser: "Executing inline event handler violates ... 'script-src-attr 'none''"
      // on every onclick click. Explicitly matching scriptSrc's existing 'unsafe-inline' here closes
      // that gap without loosening anything the directive above didn't already allow.
      scriptSrcAttr: ["'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'", "fonts.googleapis.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com", "unpkg.com"],
      fontSrc: ["'self'", "fonts.gstatic.com", "cdn.jsdelivr.net", "cdnjs.cloudflare.com"],
      // tile.openstreetmap.org: the dashboard map's OSM raster-tile fallback loads actual <img> tiles
      // (Leaflet's L.tileLayer), governed by img-src, not connect-src. flagcdn.com: the Top Partner
      // Countries flag icons (admin_dashboard.ejs) — a plain <img src>, also img-src.
      imgSrc: ["'self'", "data:", "lh3.googleusercontent.com", "blob:", "tile.openstreetmap.org", "flagcdn.com"],
      // tiles.openfreemap.org: the dashboard map's normal vector basemap (MapLibre GL) fetches its style
      // JSON, vector tiles (.pbf) and font glyphs via fetch()/XHR, governed by connect-src.
      connectSrc: ["'self'", "unpkg.com", "tiles.openfreemap.org"],
      // MapLibre GL runs its own tile/style processing on a Worker it spins up from a blob: URL — with no
      // worker-src directive this falls back to script-src, which doesn't allow blob:, so every worker
      // creation was silently rejected (confirmed live: "Creating a worker from 'blob:...' violates ...
      // script-src") and the map never finished loading. A dedicated worker-src covers exactly that case.
      workerSrc: ["'self'", "blob:"],
      // 'self' (not 'none'): the Document Library's in-page preview modal (views/partials/document_viewer.ejs)
      // embeds an uploaded file's own same-origin URL (/uploads/documents/...) in an <iframe> so PDFs render
      // with the browser's built-in viewer — 'none' blocked that iframe outright (confirmed live: the preview
      // modal showed a blank/blocked frame while "Open in New Tab" and "Download", plain navigation rather
      // than framing, worked fine). 'self' still refuses to frame any other origin.
      frameSrc: ["'self'"],
      objectSrc: ["'none'"]
    }
  },
  hsts: { maxAge: 31536000, includeSubDomains: true, preload: false },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' }
}));
app.disable('x-powered-by');

// ── PASSWORD SECURITY HELPERS ─────────────────────────────────────────────────
const BCRYPT_SALT_ROUNDS = 12;
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // 2 hours

function hashPassword(plain) {
  return bcrypt.hash(plain, BCRYPT_SALT_ROUNDS);
}

/**
 * A hash always starts with $2a$/$2b$/$2y$ — used to tell a bcrypt hash
 * apart from a legacy plain-text password still sitting in the DB.
 */
function isBcryptHash(value) {
  return typeof value === 'string' && /^\$2[aby]\$\d{2}\$/.test(value);
}

async function verifyPassword(plain, stored) {
  if (!stored) return false;
  if (!isBcryptHash(stored)) return false; // legacy plain-text accounts must be migrated, not compared directly
  return bcrypt.compare(plain, stored);
}

function isStrongPassword(pw) {
  return typeof pw === 'string'
    && pw.length >= 8
    && /[a-z]/.test(pw)
    && /[A-Z]/.test(pw)
    && /[0-9]/.test(pw);
}

const PASSWORD_POLICY_MESSAGE =
  'Password must be at least 8 characters and include an uppercase letter, a lowercase letter, and a number.';

function generateTempPassword() {
  // Guaranteed to satisfy isStrongPassword(): fixed upper/lower/digit anchors + random body.
  const body = crypto.randomBytes(9).toString('base64').replace(/[+/=]/g, 'x');
  return `Tp${body}9`;
}

// Bypassed only under the automated test suite (NODE_ENV=test) — the suite's
// many independent logins would otherwise trip this shared, IP-keyed, in-memory
// limiter and spuriously fail unrelated tests. Never bypassed in production.
//
// Each named limiter below is its OWN rateLimit() instance (own counter per
// IP), not one shared object reused across routes — express-rate-limit keys
// solely by IP by default, so reusing a single instance across multiple
// routes means they'd all draw down the same shared counter, letting heavy
// legitimate traffic on one route (e.g. the institutions-search proxy) starve
// out an unrelated route (e.g. a password change) from the same IP. Caught
// live during Roadmap v2 Phase G2 verification: probing /api/institutions to
// confirm its limiter worked left zero budget for a same-IP admin password
// change moments later, using an earlier draft that shared one instance.
// `extraOptions` (2026-10-28 brute-force-protection investigation) merges straight into the rateLimit()
// config — no limiter built by this factory currently passes it (the two login limiters that originally
// motivated it, loginLimiter/loginIdentifierLimiter, were replaced 2026-11 by the MongoDB-backed
// progressive lockout in services/loginLockoutService.js, which this factory has no part in). Kept as a
// supported parameter for whichever limiter needs it next: an omitted 3rd argument spreads as {}.
function makeRateLimiter(jsonMessage, htmlHandler, extraOptions) {
  if (process.env.NODE_ENV === 'test') return (req, res, next) => next();
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: jsonMessage },
    ...(htmlHandler ? { handler: htmlHandler } : {}),
    ...(extraOptions || {})
  });
}

// ── Progressive sign-in lockout (2026-11 Google-only sign-in / progressive rate limiting) ───────────────
// Replaces the pair of flat, in-memory, 10-attempts/15-minute limiters that used to live here
// (loginLimiter/loginIdentifierLimiter) — those only ever guarded POST /login, could not escalate across
// repeat offenses, and reset on every process restart (express-rate-limit's default MemoryStore). See
// services/loginLockoutService.js for the full escalation policy (5 attempts → 1/5/15/30/60-minute
// lockouts, MongoDB-persisted so it survives a restart and is correct across multiple app instances) and
// the reasoning behind its IP-scope vs account-scope split. Shared by POST /login AND the Google OAuth
// routes below (GET /auth/google, GET /auth/google/callback) — one unified mechanism so an attacker cannot
// reset or dodge a lockout by switching sign-in method, restarting the OAuth flow, or refreshing the page.
//
// Bypassed under NODE_ENV=test for the same reason the old limiters were (the Jest suite's own many
// independent logins, all sharing one supertest "IP", would otherwise trip a real, persisted lockout mid
// suite and spuriously fail unrelated tests): the underlying service itself is unit-tested directly,
// without this bypass, in test/login-lockout.test.js, since that is the only way to exercise its actual
// trip/escalate/expire/decay behavior deterministically and quickly.
//
// `recordSignInFailure`/`recordSignInSuccess` must each be called EXACTLY ONCE per real outcome, from the
// single place in the route that already decides success/failure (the existing audit() closures' own call
// sites) — never inferred from the HTTP status code, and never called from more than one middleware layer,
// so one authentication event is never double-counted.
// POST /login has no UI entry point at all (views/index.ejs is Google-only sign-in) — a real user never
// reaches it, so any traffic there is either a direct API probe or an attacker. Before this (2026-10
// authentication hardening), its account-scope key was the SAME 'account' scope the Google callback uses,
// specifically so switching sign-in methods couldn't dodge a lockout — but that also meant anyone who knew a
// victim's e-mail could grief their Google sign-in for free, with zero credentials, by sending 5 POST /login
// requests for that address through a form nobody legitimately uses. A separate scope closes that griefing
// vector; the shared 'ip' scope (unchanged, used by both routes) still caps how much budget one attacker's
// own traffic gets regardless of which route they hit.
const PASSWORD_ACCOUNT_SCOPE = 'account-password';

async function checkSignInLockout(req, res, scope, key, identifierForAudit, method) {
  if (process.env.NODE_ENV === 'test') return false;
  const status = await loginLockoutService.getLockoutStatus(getDb(), scope, key);
  if (!status.locked) return false;
  const attemptedId = safeLoginIdentifier(identifierForAudit);
  await logActivity(getDb(), null, 'LOGIN_BLOCKED', `Sign-in rate-limited${attemptedId ? ' for ' + attemptedId : ''}`,
    { category: 'Authentication', status: 'blocked', targetType: 'login_attempt', targetId: attemptedId, ip: getClientIp(req), userAgent: getClientUserAgent(req), requestId: req.sessionID || null, details: { reason: 'rate_limited', scope, method: method || 'password' } });
  // attemptedIdentifier (2026-11, account-scope countdown fix): GET /api/login-lockout-status only ever
  // checked the 'ip' scope, because the live-countdown script that polls it never had any identifier to
  // also check an 'account'/'account-password' scope against — a gap that mattered because THIS block may
  // itself have come from the account scope rather than 'ip' (e.g. a heavily-retried e-mail whose own
  // escalation tier has climbed past the IP's). The result: a poll mid-countdown would report "unlocked"
  // from 'ip' alone and the client would remove the countdown and re-enable the button while the real
  // (account-scoped) lock was still active — reported directly in production. Embedding the identifier that
  // WAS just checked (whichever scope this call is for) lets the client ask the status endpoint the right
  // question going forward. Safe to always include, not just for account-scope blocks: the identifier is
  // either null (no identity known yet, e.g. the Google-flow's pre-OAuth 'ip' check) or something the person
  // looking at THIS page just typed/selected themselves — never another user's data, and the status endpoint
  // below still only ever answers with {locked, lockedUntil}, never whether the account itself exists.
  res.status(429).render('index', { activePage: '', error: loginLockoutService.lockoutMessage(status.retryAfterSeconds), lockedUntil: status.lockedUntil.toISOString(), attemptedIdentifier: attemptedId });
  return true;
}
async function recordSignInFailure(scope, key) {
  if (process.env.NODE_ENV === 'test') return;
  await loginLockoutService.recordFailure(getDb(), scope, key);
}
async function recordSignInSuccess(scope, key) {
  if (process.env.NODE_ENV === 'test') return;
  await loginLockoutService.recordSuccess(getDb(), scope, key);
}

// Closes S11 (Roadmap v2 Phase G2, docs/SYSTEM_AUDIT_2026-07-16.md) — /signup,
// the three password-change routes, and the public /api/institutions proxy
// previously had no rate limiting at all. /signup renders the 'signup' page
// template on every other validation error, so its 429 handler matches that
// (not loginLimiter's 'index' render, which is the wrong template here).
const signupLimiter = makeRateLimiter(
  'Too many signup attempts. Please wait 15 minutes and try again.',
  (req, res) => res.status(429).render('signup', {
    activePage: '', user: null,
    formData: { name: req.body.username || '', email: req.body.email || '' },
    error: 'Too many signup attempts. Please wait 15 minutes and try again.'
  })
);
const institutionsLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');
// Map-location preview (Add/Edit Partnership form). Its own instance, and a
// per-minute window rather than makeRateLimiter's 10-per-15-minutes: one
// person adding a few partnerships legitimately triggers several previews,
// while the geocoding service itself already caps outbound provider traffic
// at 1 request/second and caches repeats.
const geocodePreviewLimiter = process.env.NODE_ENV === 'test'
  ? (req, res, next) => next()
  : rateLimit({
    windowMs: 60 * 1000,
    limit: 20,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many location lookups. Please wait a minute and try again.' }
  });
// Global header search (Administrator/CIRL Staff). Per-minute like geocodePreviewLimiter above, not the 10-per-15-min
// makeRateLimiter shape — this is typed-search-with-debounce traffic from one person actively using the feature, not
// an occasional form action.
const searchLimiter = process.env.NODE_ENV === 'test'
  ? (req, res, next) => next()
  : rateLimit({
    windowMs: 60 * 1000,
    limit: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many searches. Please wait a moment and try again.' }
  });
// Live lockout-countdown polling (2026-10) — read-only, never an attempt, but still a public, unauthenticated
// endpoint an abusive client could otherwise hammer; per-minute like searchLimiter above, not the 10-per-15-
// min makeRateLimiter shape, since one real locked-out browser polls this every few seconds while counting
// down.
const lockoutStatusLimiter = process.env.NODE_ENV === 'test'
  ? (req, res, next) => next()
  : rateLimit({
    windowMs: 60 * 1000,
    limit: 30,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Too many requests. Please wait a moment and try again.' }
  });
const adminPasswordLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');
const personnelPasswordLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');
const partnerPasswordLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');
const staffPasswordLimiter = makeRateLimiter('Too many requests. Please wait 15 minutes and try again.');

// ── VIEW ENGINE ──────────────────────────────────────────────────────────────
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// ── MIDDLEWARE ────────────────────────────────────────────────────────────────
// Render (and most PaaS hosts) terminate TLS at a proxy in front of the app, so
// Express needs to trust its X-Forwarded-Proto header — otherwise req.protocol
// always reads "http" and secure (HTTPS-only) session cookies never get set,
// breaking login in production.
app.set('trust proxy', 1);
// 2026-09-22 perf fix: gzip every response (HTML pages, CSS/JS/JSON) — none of it was
// compressed before. GET /api/realtime/stream (the EventSource below) is explicitly
// excluded: it's a long-lived SSE connection that pushes events one at a time with no
// res.flush() after each write, so anything compression buffered would just sit there
// undelivered until the connection eventually closes instead of arriving live.
app.use(compression({
  filter: (req, res) => req.path === '/api/realtime/stream' ? false : compression.filter(req, res)
}));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
// 2026-09-22 perf fix: neither of these set a Cache-Control header before now, so a
// browser revalidated EVERY css/js/font/image on EVERY full-page navigation (this app
// has no client-side router — every sidebar click is a fresh page load) — dozens of
// round-trips per click on top of the page's own request, compounding the session-
// revalidation lag fixed above. /velzon/assets is the Velzon theme's vendor libraries,
// which never change day to day in this project, so it can cache long; /public is this
// app's own CSS/JS, touched far more often, so it gets a short cache just long enough to
// eliminate repeat round-trips within one browsing session without risking a stale asset
// surviving past the next deploy for very long.
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '10m' }));
app.use('/velzon/assets', express.static(path.join(__dirname, 'assets'), { maxAge: '1d' }));
if (!process.env.SESSION_SECRET) {
  console.warn('⚠️  SESSION_SECRET is not set in .env — using an insecure generated fallback for this run only.');
}
const sessionStore = new session.MemoryStore();
app.use(session({
  store: sessionStore,
  secret: process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'),
  resave: true,
  saveUninitialized: false,
  rolling: true,   // reset expiry on each request
  cookie: {
    maxAge: SESSION_IDLE_TIMEOUT_MS,
    httpOnly: true,
    sameSite: 'lax',
    // 2026-09-06 security hardening (Finding #8): was opt-in to secure
    // (only true on an exact NODE_ENV==='production' match) — a
    // misconfigured deploy where NODE_ENV is unset or misspelled would
    // silently send the session cookie over plain HTTP. A NODE_ENV-based
    // boolean here turned out to be the wrong tool regardless of which way
    // it defaulted — `npm start` (package.json) never sets NODE_ENV at all,
    // so a plain `secure: true`-by-default broke local HTTP development
    // outright (a real browser silently refuses to store a Secure cookie
    // over http://, confirmed live: login appeared to succeed server-side
    // but every following request had no session at all). 'auto' is
    // express-session's own built-in answer to exactly this: it sets
    // Secure per-request from the connection's actual security (req.secure,
    // which already respects `trust proxy`/X-Forwarded-Proto, set above) —
    // secure automatically once Render's real HTTPS termination is in
    // front of it, plain over any non-TLS connection (local dev, and
    // supertest's in-process test requests) with no environment-variable
    // guessing involved at all.
    secure: 'auto'
  }
}));
app.use(passport.initialize());
app.use(passport.session());

// ── SESSION LIVE-REVALIDATION ─────────────────────────────────────────────────
// req.session.user is a snapshot taken at login. Without this, deactivating,
// deleting, or demoting a user in User Management has no effect on a session
// that's already logged in — the old snapshot keeps granting access until it
// happens to expire or the user manually logs out. Re-check against the real
// users record so a revoked/changed account takes effect quickly, not up to
// 2 hours later.
//
// 2026-09-22 perf fix: this used to re-run on EVERY request, adding a full
// MongoDB round-trip (often the dominant cost of a page load on Atlas's
// network latency) to every single page navigation, noticeably laggy when
// clicking between pages. Throttled to once per REVALIDATE_INTERVAL_MS per
// session instead — still catches a revoked/edited account within a few
// seconds (nowhere near the old 2-hour session-expiry fallback), just not on
// literally every click.
// 0 under NODE_ENV=test (same precedent as the rate limiters above) — a real Jest run needs the
// session-version revocation check (2026-10 authentication hardening, added below) to be observable on the
// very next request, not after a real 15-second wait; production behavior (the throttle itself) is
// untouched.
const REVALIDATE_INTERVAL_MS = process.env.NODE_ENV === 'test' ? 0 : 15000;
app.use(async (req, res, next) => {
  if (!req.session || !req.session.user) return next();
  const now = Date.now();
  if (req.session.revalidatedAt && now - req.session.revalidatedAt < REVALIDATE_INTERVAL_MS) return next();
  try {
    const db = getDb();
    const dbUser = await db.collection('users').findOne(
      { id: req.session.user.id },
      { projection: { password: 0 } }
    );
    if (!dbUser || dbUser.status === 'Inactive') {
      return req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/');
      });
    }
    // Session-version revocation (2026-10 authentication hardening): a password change / admin password
    // reset / admin email change bumps the user document's sessionVersion, but has no way to reach any
    // OTHER already-open session for that account directly (express-session's MemoryStore has no index by
    // user id to look sessions up by). This revalidation cycle — which already re-fetches the real user
    // document on a short interval for the role/status checks below — is reused as that reach: a session
    // whose own stored version no longer matches the account's current one is stale and gets the same
    // destroy-and-redirect treatment as a deactivated account. Both sides default to 0 when absent, so a
    // session/account created before this field existed is never spuriously treated as revoked.
    const currentSessionVersion = dbUser.sessionVersion || 0;
    if ((req.session.user.sessionVersion || 0) !== currentSessionVersion) {
      return req.session.destroy(() => {
        res.clearCookie('connect.sid');
        res.redirect('/');
      });
    }
    // Keep the session in sync with any admin-side edits (role, name, unit)
    // instead of only refreshing them at the next login.
    req.session.user.role = dbUser.role;
    req.session.user.name = dbUser.name;
    req.session.user.unit = dbUser.unit || '';
    req.session.user.activated = isActivated(dbUser);
    req.session.user.avatarUrl = avatarUrlFor(dbUser);
    req.session.revalidatedAt = now;
    next();
  } catch (err) {
    next(err);
  }
});

// ── ACCOUNT ACTIVATION GATE ───────────────────────────────────────────────────
// An account created through User Management starts with activated: false. Until its owner fills in the
// activation form (Department/College, Institution, Designation, Contact Number) the session can reach only the
// activation page and the few routes it needs — every other page redirects there and every other API call is
// refused, so nothing in the system is visible yet. Accounts created before this gate existed have no
// `activated` field at all and are treated as already activated.
const ACTIVATION_OPEN_PATHS = new Set(['/activate', '/api/activate', '/logout', '/api/me']);
app.use((req, res, next) => {
  const user = req.session && req.session.user;
  if (!user || user.activated !== false || ACTIVATION_OPEN_PATHS.has(req.path)) return next();
  if (req.path.startsWith('/api/') || req.get('X-Requested-With') === 'ciprms') {
    return res.status(403).json({ error: 'Please activate your account first.', code: 'ACTIVATION_REQUIRED' });
  }
  return res.redirect('/activate');
});

// Where the "CIPRMS" breadcrumb (and any other "home" link) of the signed-in user goes: Administrator → /dashboard,
// CIRL Staff → /staff/dashboard, College Dean and Partner → their Monitoring page. Several page templates are shared
// between roles (the Administrator's own views also render for Staff and College Dean), so a link written into the
// template can only be right for one of them — the page reads this instead.
app.use((req, res, next) => {
  res.locals.homeHref = req.session && req.session.user ? homeForRole(req.session.user.role) : '/';
  // The signed-in user's profile picture for the header / sidebar user box (the default picture until they upload one).
  res.locals.userAvatarUrl = avatarUrlFor(req.session && req.session.user);
  next();
});

// ── PASSPORT CONFIG ───────────────────────────────────────────────────────────
// `state: true` (2026-11 Google OAuth audit trail / cross-account rate-limiting investigation) — real,
// significant finding: this was NOT previously set, anywhere. passport-oauth2 decides its state-store
// ONCE, here at strategy construction, regardless of anything passed to passport.authenticate() later per
// route — with no `state` option here, it silently used NullStore, whose verify() unconditionally calls
// back `(null, true)` for ANY state value or none at all (confirmed by reading
// node_modules/passport-oauth2/lib/state/null.js). In practice this meant the Google sign-in flow had NO
// real CSRF/state protection: nothing tied a callback's `code` to the specific browser session that
// started that specific OAuth flow, leaving the door open to a login-CSRF attack (tricking a victim's
// browser into completing an attacker-initiated OAuth flow, binding the victim's session to the attacker's
// own Google identity). `state: true` switches this to passport-oauth2's own session-backed NonceStore: a
// random value is generated and stored in `req.session` when /auth/google redirects to Google, and the
// callback's own `state` query param must match it exactly — already express-session-backed, since this
// app already requires a session for everything else.
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  state: true
},
  function (accessToken, refreshToken, profile, done) {
    return done(null, profile);
  }
));

passport.serializeUser(function (user, done) {
  done(null, user);
});

passport.deserializeUser(function (user, done) {
  done(null, user);
});

// ── RBAC MIDDLEWARE ───────────────────────────────────────────────────────────

/**
 * A guard that turns a request away normally redirects (to the login page, or to the caller's own home). A page script
 * that called the API with fetch() would then be handed that HTML page and fail to parse it, so scripts identify
 * themselves with X-Requested-With: ciprms (views' CIPRMS.api helper) and get a JSON 401/403 they can show instead.
 * Every other caller — page navigation, tests, anything else — keeps the redirect exactly as before.
 */
function denyAccess(req, res, status, redirectTo) {
  // Audit only the 403 (logged in, but this role is not allowed to do this) case, not every plain 401 — a 401
  // fires on ANY visit to a protected URL before signing in at all (a bookmark, a stale tab, a session that
  // expired during normal use), which is routine and would flood the Audit Trail with noise rather than
  // security-relevant signal (see the 2026-10-21 audit-logging investigation: "do not audit every harmless
  // request"). A 403 is a signed-in account actually attempting something its role forbids — the genuinely
  // actionable "forbidden RBAC action" case the Audit Trail should surface. Fire-and-forget: this guard runs
  // on the hot path of nearly every request, and must never add a database round-trip to an already-denied
  // request's latency or make the deny itself depend on the audit write succeeding.
  if (status === 403 && req.session && req.session.user) {
    // Extra try/catch beyond logActivity's own (rather than relying on it alone): denyAccess is a hot path hit
    // by nearly every forbidden request app-wide, and getDb() itself — called here, not inside logActivity —
    // throws synchronously if the DB handle somehow isn't ready; that must never propagate out of a guard
    // whose only job is to finish denying the request.
    try {
      const user = req.session.user;
      logActivity(getDb(), user, 'FORBIDDEN', `Forbidden: ${user.email} (${user.role}) attempted ${req.method} ${req.originalUrl}`,
        { category: 'Security', status: 'blocked', targetType: 'route', targetId: req.originalUrl, ip: getClientIp(req), userAgent: getClientUserAgent(req), requestId: req.sessionID || null, details: { method: req.method } });
    } catch (e) { console.error('denyAccess audit error:', e.message); }
  }
  if (req.get('X-Requested-With') === 'ciprms') {
    return res.status(status).json(status === 401
      ? { error: 'Your session has expired. Please sign in again.', code: 'UNAUTHENTICATED' }
      : { error: 'You do not have permission to do this.', code: 'FORBIDDEN' });
  }
  return res.redirect(redirectTo);
}

/**
 * Requires ANY authenticated user (any role).
 */
function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();
  return denyAccess(req, res, 401, '/');
}

/**
 * Requires Administrator OR Auth. Personnel role.
 */
function requirePersonnel(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAccess(req, res, 401, '/');
  if (user.role === 'Administrator' || user.role === 'Auth. Personnel') return next();
  return denyAccess(req, res, 403, homeForRole(user.role));
}

/**
 * College Dean (backend role "Auth. Personnel") has a deliberately
 * reduced UI: Monitoring, Requests (Document Requests only) and Calendar.
 * This guard sits behind requirePersonnel on the pages that role does not
 * get — the Document Library (the Notifications page was reopened 2026-09-26) — and bounces ONLY an
 * Auth. Personnel session to its Monitoring home. (Settings/Profile and the
 * header Notifications bell ARE available to this role; there is no Dashboard
 * page at all — /personnel/dashboard is a plain redirect.)
 * Administrator still passes (requirePersonnel admits both roles) and every
 * shared API those pages call (notifications, profile, documents) is left
 * untouched, since Administrator/Staff/potential_partner use them too.
 */
function denyDepartmentPage(req, res, next) {
  const user = req.session && req.session.user;
  if (user && user.role === 'Auth. Personnel') return denyAccess(req, res, 403, homeForRole(user.role));
  return next();
}

/**
 * Requires Administrator, Auth. Personnel, or potential_partner — the roles
 * allowed to submit/edit/withdraw their own Partnership or Document
 * Requests. Staff is intentionally excluded: as of 2026-08-27 Staff no
 * longer submits requests at all (matching Administrator, who also only
 * reviews) — Staff's request authority is entirely on the reviewer side
 * (REQUEST_REVIEWER_ROLES / requireStaffAccess on the Approve/Reject/
 * Fulfill routes below), not the submitter side gated here.
 */
function requireRequester(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAccess(req, res, 401, '/');
  if (['Administrator', 'Auth. Personnel', 'potential_partner'].includes(user.role)) return next();
  return denyAccess(req, res, 403, homeForRole(user.role));
}

/**
 * Chained AFTER requireRequester on the Partnership Request routes (/api/requests: create, edit a draft,
 * submit a draft, delete a draft, withdraw). requireRequester also admits College Dean (backend role
 * "Auth. Personnel") because the Document Request routes share it — but College Dean no longer has a
 * Partnership Request workflow (its page and form were removed; Document Requests are all it submits), so
 * the API is closed to it here on the server rather than left to a hidden button. A JSON 403, not a
 * redirect: this is an API refusal. Administrator and Partner pass unchanged; Staff never reaches this
 * (requireRequester already redirects it).
 *
 * One exception (2026-09-26): a College Dean may CREATE a College Partnership Report — a copy of an MOA/MOU its
 * college already signed with another institution without going through CIRL (POST /api/requests with
 * isCollegeReport: true). Every other Partnership Request route stays closed to it.
 */
function denyCollegeStaffPartnershipRequests(req, res, next) {
  const user = req.session && req.session.user;
  if (user && user.role === 'Auth. Personnel') {
    if (req.method === 'POST' && req.path === '/api/requests' && req.body && req.body.isCollegeReport === true) return next();
    return res.status(403).json({ error: 'College Dean cannot submit Partnership Requests. Use a Document Request instead.' });
  }
  return next();
}

/**
 * Requires Administrator role only.
 */
function requireAdmin(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAccess(req, res, 401, '/');
  if (user.role === 'Administrator') return next();
  // Non-admin users get redirected to their own dashboard
  return denyAccess(req, res, 403, homeForRole(user.role));
}

/**
 * Requires the potential_partner role only (external orgs applying for partnership).
 */
function requirePartner(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAccess(req, res, 401, '/');
  if (user.role === 'potential_partner') return next();
  return denyAccess(req, res, 403, homeForRole(user.role));
}

/**
 * Requires Administrator, Auth. Personnel, potential_partner, OR Staff — i.e.
 * anyone allowed to upload/OCR a document, each scoped to their own uploads
 * (see OWN_SCOPE_ROLES/SELF_UPLOAD_ONLY_ROLES below).
 */
function requireUploader(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAccess(req, res, 401, '/');
  if (['Administrator', 'Auth. Personnel', 'potential_partner', 'Staff'].includes(user.role)) return next();
  return denyAccess(req, res, 403, homeForRole(user.role));
}

/**
 * Requires Administrator OR Staff role. Mirrors requirePersonnel's
 * dual-role convention: Staff gets its own full `/staff/*` page namespace
 * reusing the same shared Administrator templates (dashboard/registry/
 * reports/calendar/lifecycle/documents/notifications/users/requests) via
 * the sidebarPartial override, the same pattern already used for Auth.
 * Personnel. As of the 2026-08-27 full-parity revision this gates most
 * mutation routes too (Partnerships, Requests, Users) — Administrator and
 * Staff are equals everywhere except: Calendar create/edit/delete (stays
 * requireAdmin — Staff is explicitly view-only there, unchanged by this
 * revision), plus, as of the 2026-09-14 Staff-Calendar-parity change, Staff
 * now shares full Calendar create/edit/delete with Administrator too (see
 * POST/PATCH/DELETE /api/calendarevents below) — the org-wide Google
 * Calendar integration config (requireAdmin — connecting/disconnecting the
 * shared account) remains Administrator-only, and any operation targeting
 * an Administrator account or granting the Administrator role (explicit
 * in-handler checks in the Users routes — a privilege-escalation guard,
 * not a gap) is unaffected.
 */
function requireStaffAccess(req, res, next) {
  const user = req.session && req.session.user;
  if (!user) return denyAccess(req, res, 401, '/');
  if (user.role === 'Administrator' || user.role === 'Staff') return next();
  return denyAccess(req, res, 403, homeForRole(user.role));
}

// ── HELPER: role → home URL ───────────────────────────────────────────────────
function homeForRole(role) {
  if (role === 'Administrator') return '/dashboard';
  if (role === 'Auth. Personnel') return '/personnel/monitoring';
  if (role === 'potential_partner') return '/partner/monitoring'; // Partner has no Dashboard — Monitoring is its home
  return '/staff/dashboard';
}

// ── HELPER: account activation ────────────────────────────────────────────────
// Only an explicit `activated: false` (set by POST /api/users) means "not yet activated" — older accounts
// never had the field and keep full access.
function isActivated(userDoc) {
  return !!userDoc && userDoc.activated !== false;
}
// ── HELPER: profile picture ───────────────────────────────────────────────────
// Which picture an account shows, in order: the photo its owner uploaded here (Settings → click the photo), else the
// profile photo of their Google account (googleAvatarUrl — saved at every "Continue with Google" sign-in, so it also
// shows after later email/password logins), else the default avatar from /images/default-avatar.jpg.
const DEFAULT_AVATAR_URL = '/images/default-avatar.jpg';
function avatarUrlFor(userDoc) {
  if (!userDoc) return DEFAULT_AVATAR_URL;
  if (userDoc.avatarUrl) return userDoc.avatarUrl;
  if (userDoc.googleAvatarUrl) return userDoc.googleAvatarUrl;
  return DEFAULT_AVATAR_URL;
}
// The profile photo URL from a Google sign-in, or null when the account has none. Only an https URL on Google's own
// photo host is accepted, since it is written into <img src> on every page. Google hands out a 96px thumbnail
// ("…=s96-c"); a 256px one is requested instead so it stays sharp on the Settings page.
function googlePhotoUrlFrom(googleProfile) {
  if (!googleProfile) return null;
  const raw = (Array.isArray(googleProfile.photos) && googleProfile.photos[0] && googleProfile.photos[0].value)
    || (googleProfile._json && googleProfile._json.picture)
    || (googleProfile._json && googleProfile._json.avatar_url)
    || (typeof googleProfile.picture === 'string' ? googleProfile.picture : null);
  if (typeof raw !== 'string') return null;
  let url;
  try { url = new URL(raw); } catch (e) { return null; }
  if (url.protocol !== 'https:') return null;
  if (!/(^|\.)(googleusercontent\.com|ggpht\.com|google\.com|gravatar\.com)$/i.test(url.hostname)) return null;

  let str = url.toString();
  if (/=s\d+(-c)?$/i.test(url.pathname)) {
    return url.origin + url.pathname.replace(/=s\d+(-c)?$/i, '=s256-c') + url.search;
  }
  if (/=s\d+(-c)?$/i.test(str)) {
    return str.replace(/=s\d+(-c)?$/i, '=s256-c');
  }
  if (url.searchParams.has('sz')) {
    url.searchParams.set('sz', '256');
    return url.toString();
  }
  return str;
}
// Where a freshly signed-in user lands: the activation form until the account is activated, their home after.
function landingFor(userDoc) {
  return isActivated(userDoc) ? homeForRole(userDoc.role) : '/activate';
}

// ── HELPER: role → user-visible label ──────────────────────────────────────────
// The stored / RBAC role VALUES never change — sessions, the users collection, every
// permission check, API payloads, <option value="…"> and role filters keep "Staff",
// "Auth. Personnel" and "potential_partner". Only what people SEE is renamed:
//   Staff             → "CIRL Staff"
//   Auth. Personnel   → "College Dean"   (shown earlier as "Department/Colleges")
//   potential_partner → "Partner"
const ROLE_LABELS = { 'Staff': 'CIRL Staff', 'Auth. Personnel': 'College Dean', 'potential_partner': 'Partner' };
const PREVIOUS_COLLEGE_STAFF_LABEL = 'Department/Colleges'; // stored in some audit text written between the two renames
const EARLIER_COLLEGE_LABEL = 'College Staff';               // what the role was called before "College Dean" — may be in older stored text
function displayRoleName(role) {
  return Object.prototype.hasOwnProperty.call(ROLE_LABELS, role) ? ROLE_LABELS[role] : role;
}
// Free text that already embeds a role name — e.g. an audit-trail entry such as
// "User created: X (Auth. Personnel)" or "User updated: X — role: Staff, status: …".
// Display-time only: the stored text is never rewritten. Idempotent.
function displayRoleText(text) {
  if (typeof text !== 'string') return text;
  return text
    .split('Auth. Personnel').join(ROLE_LABELS['Auth. Personnel'])
    .split(PREVIOUS_COLLEGE_STAFF_LABEL).join(ROLE_LABELS['Auth. Personnel'])
    .split(EARLIER_COLLEGE_LABEL).join(ROLE_LABELS['Auth. Personnel'])
    .replace(/\(Staff\)/g, '(' + ROLE_LABELS['Staff'] + ')')
    .replace(/\brole: Staff\b/g, 'role: ' + ROLE_LABELS['Staff']);
}
function formatRole(role) {
  return displayRoleName(role) || '';
}

// ── PUBLIC ROUTES ─────────────────────────────────────────────────────────────
app.get('/', async (req, res) => {
  // Already logged in → bounce to appropriate dashboard
  if (req.session && req.session.user) {
    return res.redirect(homeForRole(req.session.user.role));
  }
  // Passive IP-lockout check (2026-10 live countdown) — a plain page view is never an attempt, so this reads
  // status only (getLockoutStatus, never checkSignInLockout's audit log / recordFailure side effects). Keeps
  // the live countdown visible across a refresh or a new tab: without this, only the render that FIRST
  // tripped the lockout ever carried lockedUntil, and a refreshed bare login page would look fully normal
  // even while still locked, inviting another attempt that would just 429 again. Bypassed under
  // NODE_ENV=test for the same reason every other lockout check already is.
  let lockedUntil;
  if (process.env.NODE_ENV !== 'test') {
    const ip = getClientIp(req);
    const status = await loginLockoutService.getLockoutStatus(getDb(), 'ip', ip);
    if (status.locked) lockedUntil = status.lockedUntil.toISOString();
  }
  res.render('index', {
    activePage: '',
    error: lockedUntil ? loginLockoutService.lockoutMessage(Math.ceil((new Date(lockedUntil).getTime() - Date.now()) / 1000)) : undefined,
    lockedUntil,
    // set by the Settings pages after a password change, which ends the session
    notice: req.query.passwordChanged === '1' ? 'Your password was changed. Please log in again with your new password.' : undefined
  });
});

app.get('/signup', (req, res) => {
  res.render('signup', { activePage: '', user: null, formData: { name: '', email: '' } });
});

// ── GOOGLE AUTH ROUTES ────────────────────────────────────────────────────────

// Builds this route's own public callback URL. 2026-10 authentication hardening: previously derived entirely
// from the incoming request's own Host header (and X-Forwarded-Proto) — a value a direct, un-proxied client
// can set to anything, including when trust-proxy's one trusted hop isn't actually what's in front of this
// process in some future deployment topology. APP_BASE_URL (already defined in render.yaml and already used
// by services/emailService.js for the exact same "the one trustworthy public address of this deployment"
// purpose) is the only source trusted for it.
//
// Corrected 2026-10 Phase 1.1: the original version fell back to Host-derived logic whenever APP_BASE_URL
// was simply unset, with no check on WHERE that was happening — a misconfigured production deploy that
// forgot to set it would silently keep accepting attacker-controlled Host/X-Forwarded-Proto headers to build
// a real OAuth callback URL. In production (NODE_ENV=production), a missing or invalid APP_BASE_URL now
// fails the request instead of falling back to those headers; local development may still use the existing
// Host-derived fallback (see the NODE_ENV check further below for exactly which value gates this, and why).
// Never logs the actual header/URL values — only that configuration is missing or malformed.
function publicBaseUrl(req) {
  const configured = process.env.APP_BASE_URL;
  if (configured) {
    const trimmed = configured.replace(/\/+$/, '');
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return trimmed;
    } catch (e) { /* falls through to the invalid-configuration error below */ }
    console.error('❌ APP_BASE_URL is set but is not a valid absolute http(s) URL — refusing to fall back to request headers.');
    throw new Error('Public base URL is misconfigured.');
  }
  // Deny-lists 'production' rather than allow-listing 'development'/'test' (the pattern db.js's own
  // MONGO_URI fallback uses) — confirmed directly that this project's actual local `node cirl.js` runs have
  // NODE_ENV UNSET (not 'development'): render.yaml is the only place NODE_ENV=production is ever set, so
  // an allow-list would misidentify a normal local run as "production" and break local OAuth testing
  // whenever APP_BASE_URL happens to be unset, the exact opposite of this requirement. db.js's allow-list
  // gets away with the stricter shape only because its fallback is rarely exercised in practice (this
  // project's .env always carries a real MONGO_URI); this one is hit on every single OAuth attempt, so
  // getting the local-dev case wrong here is immediately disruptive, not a rare edge case.
  if (process.env.NODE_ENV === 'production') {
    console.error('❌ APP_BASE_URL is not set and NODE_ENV is production — refusing to derive a public URL from request headers in production.');
    throw new Error('Public base URL is not configured.');
  }
  // Local dev/test fallback only — unreachable once APP_BASE_URL is correctly set, and never reached at all
  // when NODE_ENV=production regardless of APP_BASE_URL's state.
  const host = req.get('host') || 'localhost:3000';
  if (host.includes('localhost') || host.includes('127.0.0.1')) return `http://${host}`;
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  return `${protocol}://${host}`;
}

function getCallbackUrl(req) {
  return `${publicBaseUrl(req)}/auth/google/callback`;
}

// Shares the exact same progressive lockout as POST /login (checkSignInLockout/recordSignInFailure/
// recordSignInSuccess, services/loginLockoutService.js) — 2026-11 Google-only sign-in / progressive rate
// limiting. The IP scope is checked before Google is ever contacted (restarting the OAuth flow, or
// repeatedly invoking the callback, cannot bypass a lockout already in effect for that IP); the account
// scope — keyed by the Google profile's own e-mail, the SAME normalized key /login's account scope uses —
// is checked as soon as the callback has an e-mail to check, before the allowlist DB lookup even runs.
// Full Audit Trail coverage for Google sign-in (2026-11 Google OAuth audit trail / cross-account rate
// limiting fix) — this route previously called logActivity() nowhere at all: neither a successful nor a
// failed Google sign-in, nor a Google-triggered lockout, ever reached the Audit Trail, only
// console.log/warn/error. Every branch below now writes exactly one row, reusing the SAME action types
// (LOGIN_SUCCESS/LOGIN_FAILED/LOGIN_BLOCKED) the password flow already uses — so an Administrator reviewing
// "all failed logins" sees both methods together — distinguished by a new `details.method: 'google'` field,
// plus two new, purely informational action types (GOOGLE_AUTH_INITIATED/GOOGLE_AUTH_CALLBACK) for the two
// non-outcome events the brief also asks for. Never logs an authorization code, access/refresh token, or
// any other credential — only the already-public-to-the-attempt e-mail, IP, and user-agent, matching every
// other Authentication-category row in this file.
app.get('/auth/google', async (req, res, next) => {
  const ip = getClientIp(req);
  const userAgent = getClientUserAgent(req);
  const requestId = req.sessionID || null;
  if (await checkSignInLockout(req, res, 'ip', ip, null, 'google')) return;
  let callbackUrl;
  try {
    callbackUrl = getCallbackUrl(req);
  } catch (configErr) {
    // publicBaseUrl()'s own console.error already logged the sanitized specifics — this is the safe,
    // generic response for the person who clicked "Sign in with Google", never the config detail itself.
    return res.status(500).render('index', { activePage: '', error: 'Sign-in is temporarily unavailable. Please try again shortly or contact the CIRL Administrator.' });
  }
  console.log(`[AUTH] Redirecting to Google with callback URL: ${callbackUrl}`);
  await logActivity(getDb(), null, 'GOOGLE_AUTH_INITIATED', 'Google sign-in initiated',
    { category: 'Authentication', targetType: 'login_attempt', ip, userAgent, requestId, details: { method: 'google' } });
  passport.authenticate('google', {
    scope: ['profile', 'email'],
    callbackURL: callbackUrl
  })(req, res, next);
});

app.get('/auth/google/callback', async (req, res, next) => {
  const ip = getClientIp(req);
  const userAgent = getClientUserAgent(req);
  const requestId = req.sessionID || null;
  const db = getDb();
  if (await checkSignInLockout(req, res, 'ip', ip, null, 'google')) return;
  let callbackUrl;
  try {
    callbackUrl = getCallbackUrl(req);
  } catch (configErr) {
    return res.status(500).render('index', { activePage: '', error: 'Sign-in is temporarily unavailable. Please try again shortly or contact the CIRL Administrator.' });
  }
  await logActivity(db, null, 'GOOGLE_AUTH_CALLBACK', 'Google OAuth callback received',
    { category: 'Authentication', targetType: 'login_attempt', ip, userAgent, requestId, details: { method: 'google' } });

  passport.authenticate('google', {
    failureRedirect: '/',
    callbackURL: callbackUrl
  }, async function (err, googleUser, info) {
    // Invalid/expired OAuth state, a denied/failed token exchange, or any other passport-level failure —
    // counted the same as a failed password attempt (brief: "invalid OAuth state and failed callbacks").
    // No CIPRMS account is identified yet at this point, so only the IP scope can be charged, and the
    // audit row's targetId stays null — there is no attempted identifier to record, unlike every branch
    // below this one that at least has a submitted e-mail.
    if (err) {
      console.error('❌ OAuth Error:', err.message);
      await Promise.all([
        recordSignInFailure('ip', ip),
        logActivity(db, null, 'LOGIN_FAILED', 'Failed Google sign-in (invalid OAuth state or callback error)',
          { category: 'Authentication', status: 'failure', targetType: 'login_attempt', ip, userAgent, requestId, details: { method: 'google', reason: 'oauth_error' } })
      ]);
      return next(err);
    }
    if (!googleUser) {
      console.warn('⚠️  No user returned from OAuth');
      await Promise.all([
        recordSignInFailure('ip', ip),
        logActivity(db, null, 'LOGIN_FAILED', 'Failed Google sign-in (denied consent or no profile returned)',
          { category: 'Authentication', status: 'failure', targetType: 'login_attempt', ip, userAgent, requestId, details: { method: 'google', reason: 'oauth_denied_or_failed' } })
      ]);
      return res.redirect('/');
    }

    try {
      const googleEmail = (googleUser.emails && googleUser.emails[0])
        ? googleUser.emails[0].value.trim().toLowerCase()
        : null;

      if (!googleEmail) {
        await Promise.all([
          recordSignInFailure('ip', ip),
          logActivity(db, null, 'LOGIN_FAILED', 'Failed Google sign-in (Google profile has no e-mail)',
            { category: 'Authentication', status: 'failure', targetType: 'login_attempt', ip, userAgent, requestId, details: { method: 'google', reason: 'no_google_email' } })
        ]);
        return res.render('index', { activePage: '', error: 'Google account has no email. Please use a different login method.' });
      }

      const accountKey = loginLockoutService.normalizeAccountKey(googleEmail);
      if (await checkSignInLockout(req, res, 'account', accountKey, googleEmail, 'google')) return;

      // Google's own email_verified claim (2026-10 authentication hardening) — Google allows signing in
      // with an email address it has NOT itself confirmed belongs to this account (e.g. a freshly-added,
      // not-yet-confirmed secondary address). Trusting an unverified claim here would let someone assert an
      // email they don't actually control, including a real CIPRMS user's address, to try sliding through
      // the allowlist lookup below as that person. Counted the same as any other pre-allowlist Google
      // failure (ip AND account scope — this is a real, specific targeted email, not an anonymous probe).
      if (googleUser.emails[0].verified !== true) {
        await Promise.all([
          recordSignInFailure('ip', ip), recordSignInFailure('account', accountKey),
          logActivity(db, null, 'LOGIN_FAILED', `Failed Google sign-in for ${googleEmail} (email_not_verified)`,
            { category: 'Authentication', status: 'failure', targetType: 'login_attempt', targetId: googleEmail, ip, userAgent, requestId, details: { method: 'google', reason: 'email_not_verified' } })
        ]);
        return res.render('index', { activePage: '', error: 'Your Google account email could not be verified. Please use a verified Google account or contact the CIRL Administrator.' });
      }

      // Strict allowlist (2026-09-05): Google/CSPC authentication only proves
      // WHO the person is. It never determines WHETHER they may access
      // CIPRMS or WHAT role they hold — that authorization lives solely in
      // the CIPRMS `users` collection, created explicitly by an
      // Administrator/Staff via User Management. An authenticated identity
      // with no matching record here must be rejected outright: no account
      // is auto-created, no default role is assigned, and no session is
      // established.
      const dbUser = await db.collection('users').findOne({ email: googleEmail });

      if (!dbUser) {
        console.warn(`⚠️  Google login rejected — no authorized CIPRMS account for: ${googleEmail}`);
        await Promise.all([
          recordSignInFailure('ip', ip), recordSignInFailure('account', accountKey),
          logActivity(db, null, 'LOGIN_FAILED', `Failed Google sign-in for ${googleEmail} (account_not_found)`,
            { category: 'Authentication', status: 'failure', targetType: 'login_attempt', targetId: googleEmail, ip, userAgent, requestId, details: { method: 'google', reason: 'account_not_found' } })
        ]);
        return res.render('index', {
          activePage: '',
          error: 'Your account is not authorized to access CIPRMS. Please contact the CIRL Administrator to request an account.'
        });
      }

      if (dbUser.status === 'Inactive') {
        await Promise.all([
          recordSignInFailure('ip', ip), recordSignInFailure('account', accountKey),
          logActivity(db, dbUser, 'LOGIN_FAILED', `Failed Google sign-in for ${googleEmail} (account_disabled)`,
            { category: 'Authentication', status: 'failure', targetType: 'login_attempt', targetId: dbUser.email, ip, userAgent, requestId, details: { method: 'google', reason: 'account_disabled' } })
        ]);
        return res.render('index', { activePage: '', error: 'Your CIPRMS account is inactive. Please contact the CIRL Administrator.' });
      }

      // Update last login, and keep the Google profile photo current: saved when the Google account has one,
      // removed when it no longer does (so the account falls back to the default picture).
      const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const googleAvatarUrl = googlePhotoUrlFrom(googleUser);
      await db.collection('users').updateOne({ email: googleEmail }, googleAvatarUrl
        ? { $set: { login: today, googleAvatarUrl } }
        : { $set: { login: today }, $unset: { googleAvatarUrl: '' } });
      if (googleAvatarUrl) dbUser.googleAvatarUrl = googleAvatarUrl; else delete dbUser.googleAvatarUrl;
      console.log(`✓ Google login: ${dbUser.name} (${dbUser.role})`);

      // Regenerate session to prevent fixation, then store user data
      req.session.regenerate((regenErr) => {
        if (regenErr) return next(regenErr);
        req.session.user = {
          id: dbUser.id,
          name: dbUser.name,
          email: dbUser.email,
          role: dbUser.role,
          unit: dbUser.unit || '',
          activated: isActivated(dbUser),
          avatarUrl: avatarUrlFor(dbUser),
          sessionVersion: dbUser.sessionVersion || 0 // see the revalidation middleware's own comment
        };
        req.session.save(async (saveErr) => {
          if (saveErr) return next(saveErr);
          await Promise.all([
            // Account scope only — NOT 'ip'. A shared/NAT IP (plausible on a campus network) is used by many
            // people; clearing the IP's own failure count on anyone's successful sign-in would let an
            // attacker credential-stuff a run of DIFFERENT accounts from that IP for free every time an
            // unrelated, legitimate colleague on the same IP happens to sign in. Proving control of ONE
            // account only ever vouches for that account, never for the IP itself.
            recordSignInSuccess('account', accountKey),
            logActivity(db, dbUser, 'LOGIN_SUCCESS', `Successful Google sign-in: ${dbUser.email}`,
              { category: 'Authentication', status: 'success', targetType: 'login_attempt', targetId: dbUser.email, ip, userAgent, requestId, details: { method: 'google' } })
          ]);
          console.log(`✓ Google login: ${dbUser.name} (${dbUser.role})`);
          return res.redirect(landingFor(dbUser));
        });
      });

    } catch (dbErr) {
      console.error('❌ DB error during Google login:', dbErr);
      return next(dbErr);
    }
  })(req, res, next);
});

// ── FORM LOGIN ────────────────────────────────────────────────────────────────
// Login-attempt audit logging (2026-10-21 investigation): every branch below now writes exactly one
// LOGIN_SUCCESS/LOGIN_FAILED entry, server-side only — nothing client-side reports a login outcome, closing
// the actual root cause this was investigated for: this route previously called logActivity() precisely
// nowhere, so neither a successful nor a failed sign-in ever reached the Audit Trail at all. Three attempts
// (fail, fail, succeed) write three real rows — none of the branches below share state or short-circuit a
// later one, so there is nothing here that could coalesce or suppress a legitimate attempt. The category is
// always 'Authentication'; the `reason` in `details` uses the safe, non-enumerating categories this
// investigation's brief asked for — never a message that would tell an attacker whether a given email is
// actually registered (the *response* text already didn't; the audit `reason` below is for the Administrator
// reviewing the trail, not shown to the person attempting to log in).
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  const db = getDb();
  const ip = getClientIp(req);
  const userAgent = getClientUserAgent(req);
  const requestId = req.sessionID || null;
  const attemptedId = safeLoginIdentifier(username);
  const accountKey = loginLockoutService.normalizeAccountKey(username);
  const audit = (status, reason, user, extraDetails) => logActivity(db, user || null, status === 'success' ? 'LOGIN_SUCCESS' : 'LOGIN_FAILED',
    status === 'success' ? `Successful login: ${user.email}` : `Failed login attempt${attemptedId ? ' for ' + attemptedId : ''} (${reason})`,
    { category: 'Authentication', status, targetType: 'login_attempt', targetId: user ? user.email : attemptedId, ip, userAgent, requestId, details: { reason, ...extraDetails } });
  // Counts a failure toward BOTH the IP and (when a usable identifier was submitted) this route's OWN
  // account scope — except google_account_only, which must never count here (see PASSWORD_ACCOUNT_SCOPE's
  // own comment above), and system_error, which is the server's own fault, not a signal about the attempt.
  const countableReasons = new Set(['validation_error', 'account_not_found', 'account_disabled', 'legacy_account_needs_reset', 'invalid_credentials']);
  const recordOutcome = (reason) => {
    if (reason && !countableReasons.has(reason)) return Promise.resolve();
    const scopes = [recordSignInFailure('ip', ip)];
    if (accountKey) scopes.push(recordSignInFailure(PASSWORD_ACCOUNT_SCOPE, accountKey));
    return Promise.all(scopes);
  };

  if (await checkSignInLockout(req, res, 'ip', ip, username)) return;
  if (accountKey && await checkSignInLockout(req, res, PASSWORD_ACCOUNT_SCOPE, accountKey, username)) return;

  // F-04: reject non-string values (e.g. JSON objects with MongoDB operators)
  // before any string method (.trim, .toLowerCase) is called, preventing a
  // 500 crash and closing the NoSQL injection entry point simultaneously.
  // Real, non-200 status codes on every failure branch below (2026-10-28 brute-force-protection
  // investigation) — previously EVERY outcome of this route, success or failure, answered 200 (only a
  // successful login's res.redirect was ever <400, via its 302). That accidentally neutered
  // skipSuccessfulRequests on the limiters above: express-rate-limit decides "successful" purely by
  // response.statusCode < 400, so against an all-200 route it would have skipped counting FAILED attempts
  // too, not just real successes — the exact opposite of what brute-force protection needs. 400 for a
  // malformed request (not even a real attempt against any account), 401 for every "this did not
  // authenticate" outcome (never more specific than that to the client — see each branch's own audit `reason`
  // for the detail an Administrator can see), 500 for a genuine server-side failure after the password had
  // already verified correct.
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    await Promise.all([audit('failure', 'validation_error', null), recordOutcome('validation_error')]);
    return res.status(400).render('index', { activePage: '', error: 'Please enter your email and password.' });
  }

  try {
    // Look up user by email (the "username" field on the login form is the email)
    const user = await db.collection('users').findOne({
      email: username.trim().toLowerCase()
    });

    if (!user) {
      await Promise.all([audit('failure', 'account_not_found', null), recordOutcome('account_not_found')]);
      return res.status(401).render('index', { activePage: '', error: 'Invalid email or password.' });
    }

    if (user.status === 'Inactive') {
      await Promise.all([audit('failure', 'account_disabled', user), recordOutcome('account_disabled')]);
      return res.status(401).render('index', { activePage: '', error: 'Your CIPRMS account is inactive. Please contact the CIRL Administrator.' });
    }

    if (!user.password) {
      // Google-only account (no local password set) — must sign in via "Continue with Google".
      await Promise.all([audit('failure', 'google_account_only', user), recordOutcome('google_account_only')]);
      return res.status(401).render('index', { activePage: '', error: 'This account signs in with Google. Please use "Continue with Google".' });
    }

    if (!isBcryptHash(user.password)) {
      // Legacy plain-text account that predates the password migration.
      await Promise.all([audit('failure', 'legacy_account_needs_reset', user), recordOutcome('legacy_account_needs_reset')]);
      return res.status(401).render('index', { activePage: '', error: 'Your account needs a password reset. Please contact the Administrator.' });
    }

    const passwordMatches = await verifyPassword(password, user.password);
    if (!passwordMatches) {
      await Promise.all([audit('failure', 'invalid_credentials', user), recordOutcome('invalid_credentials')]);
      return res.status(401).render('index', { activePage: '', error: 'Invalid email or password.' });
    }

    // Regenerate session to prevent fixation, then store user data. Both callbacks below are async (and
    // awaited by nothing — express-session itself just invokes them) specifically so the audit write for
    // this attempt's final outcome can be awaited BEFORE the response is sent: login is exactly the one place
    // in this file where "the row must already be visible to anyone reading the Audit Trail immediately
    // after" matters more than saving a few milliseconds (see logActivity()'s own comment on this tradeoff).
    req.session.regenerate(async (regenErr) => {
      if (regenErr) {
        console.error('❌ Session regenerate error:', regenErr);
        await audit('failure', 'system_error', user, { stage: 'session_regenerate' });
        return res.status(500).render('index', { activePage: '', error: 'Session error. Please try again.' });
      }
      req.session.user = {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        unit: user.unit || '',
        activated: isActivated(user),
        avatarUrl: avatarUrlFor(user),
        sessionVersion: user.sessionVersion || 0 // see the revalidation middleware's own comment
      };

      req.session.save(async (saveErr) => {
        if (saveErr) {
          console.error('❌ Session save error:', saveErr);
          await audit('failure', 'system_error', user, { stage: 'session_save' });
          return res.status(500).render('index', { activePage: '', error: 'Session error. Please try again.' });
        }

        // Update last login timestamp (fire-and-forget — unaffected by this change: this is a convenience
        // field, not a security/accountability record, so it keeps its original non-blocking semantics).
        const loginDate = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
        getDb().collection('users').updateOne({ email: user.email }, { $set: { login: loginDate } }).catch(() => { });

        await audit('success', null, user);
        // Account scope only — NOT 'ip'; see the matching comment on the Google callback's own success
        // handler for why a shared/NAT IP's failure count must never be cleared by one account's success.
        await recordSignInSuccess(PASSWORD_ACCOUNT_SCOPE, accountKey);
        console.log(`✓ Login: ${user.name} (${user.role})`);
        res.redirect(landingFor(user));
      });
    });

  } catch (err) {
    console.error('❌ Login error:', err);
    await audit('failure', 'system_error', null);
    res.status(500).render('index', { activePage: '', error: 'A server error occurred. Please try again.' });
  }
});

// Live lockout countdown (2026-10): lets the login page's own JS (public/js/ciprms-login-lockout.js) confirm
// server-side whether a lockout has genuinely expired, instead of trusting its own 1-second display timer —
// the display timer is purely cosmetic (seeded from, and only ever a visual tick-down of, the authoritative
// lockedUntil this endpoint reports), never itself the thing that decides whether a retry is allowed. Never
// counts as an attempt (read-only getLockoutStatus, no recordFailure); never reveals which scope is active,
// the attempt threshold, or whether `email` belongs to a real account — returns only {locked, lockedUntil}
// for whichever of IP, the Google account scope, or the password account scope (when an email was supplied)
// is more restrictive.
//
// Checks BOTH account scopes, not just Google's (2026-11 fix): this endpoint used to check only 'account'
// (Google), while checkSignInLockout() itself can also block on 'account-password' (POST /login's own
// per-email scope — PASSWORD_ACCOUNT_SCOPE). A block render now embeds whichever identifier it just checked
// as data-attempted-identifier (see views/index.ejs), and the client includes it here as `email` — but
// since that identifier doesn't say which flow produced it, checking both account scopes (rather than
// guessing) is what actually matches checkSignInLockout()'s own two checks for a real sign-in attempt.
// Before this, a request with no `email` at all (the client's prior behavior) meant an account-scoped lock
// whose own escalation tier outlived the IP's could be reported here as unlocked while still genuinely
// active server-side — reported directly in production. Does not affect enforcement itself: a real sign-in
// attempt against a still-locked account is blocked by checkSignInLockout()'s own direct check regardless
// of what this read-only status endpoint ever reports.
app.get('/api/login-lockout-status', lockoutStatusLimiter, async (req, res) => {
  try {
    const ip = getClientIp(req);
    const ipStatus = await loginLockoutService.getLockoutStatus(getDb(), 'ip', ip);
    let googleAccountStatus = { locked: false };
    let passwordAccountStatus = { locked: false };
    if (typeof req.query.email === 'string' && req.query.email) {
      const accountKey = loginLockoutService.normalizeAccountKey(req.query.email);
      if (accountKey) {
        [googleAccountStatus, passwordAccountStatus] = await Promise.all([
          loginLockoutService.getLockoutStatus(getDb(), 'account', accountKey),
          loginLockoutService.getLockoutStatus(getDb(), PASSWORD_ACCOUNT_SCOPE, accountKey)
        ]);
      }
    }
    // Whichever expires LATER is the one actually still blocking a retry.
    const mostRestrictive = [ipStatus, googleAccountStatus, passwordAccountStatus]
      .filter((s) => s.locked)
      .sort((a, b) => new Date(b.lockedUntil).getTime() - new Date(a.lockedUntil).getTime())[0];
    if (!mostRestrictive) return res.json({ locked: false, lockedUntil: null });
    res.json({ locked: true, lockedUntil: mostRestrictive.lockedUntil.toISOString() });
  } catch (err) {
    console.error('❌ /api/login-lockout-status error:', err);
    res.json({ locked: false, lockedUntil: null }); // fails open, same spirit as the lockout service itself
  }
});

// Public self-registration is disabled (2026-09-05 strict allowlist policy):
// authenticating as *someone* (even with a real email/password of their own
// choosing) must never be enough to grant a CIPRMS account or session. The
// only path to an authorized account is an Administrator/Staff explicitly
// creating one via User Management → Add User (POST /api/users). This route
// is kept (rather than removed) only so the existing /signup URL still
// resolves to a clear, non-crashing rejection instead of a 404.
app.post('/signup', signupLimiter, async (req, res) => {
  const { username: name, email } = req.body;
  const formData = { name: name || '', email: email || '' };
  return res.render('signup', {
    activePage: '', user: null, formData,
    error: 'Self-registration is disabled. Please contact the CIRL Administrator to request an account.'
  });
});

// ── LOGOUT —————————————————————————————————————————————————
// POST-only (2026-09-06 security hardening, Finding #7): a GET route that
// destroys the session is reachable via top-level navigation even under
// sameSite=lax (e.g. an <img>/<a> on another site pointing here), a minor
// "logout CSRF" nuisance. Every logout link in the app now fires a real
// POST via fetch() (see views/partials/header.ejs and the sidebar_*
// partials) instead of navigating to a GET URL. Full CSRF-token protection
// for state-changing requests generally is a separate, larger effort
// (deliberately out of scope here — see the Phase 0 report) — this closes
// only the one concretely reachable gap.
app.post('/logout', (req, res) => {
  const endingSession = req.sessionID;
  // Captured before destroy() clears req.session.user — this is who is logging out, for the audit record below.
  // Not logged for an already-logged-out session (nothing meaningful happened) or for /logout hit with no
  // session at all; both leave `who` null/undefined.
  const who = req.session && req.session.user;
  const ip = getClientIp(req);
  const userAgent = getClientUserAgent(req);
  req.session.destroy(async (err) => {
    realtime.disconnectSession(endingSession);
    if (err) console.error('❌ Logout session destroy error:', err);
    if (who) {
      // Awaited, same reasoning as the login route above: a security/accountability record should already
      // be visible to anyone checking the Audit Trail the moment this response comes back.
      await logActivity(getDb(), who, 'LOGOUT', `Logout: ${who.email}`,
        { category: 'Authentication', status: 'success', targetType: 'session', targetId: who.email, ip, userAgent, requestId: endingSession });
    }
    // Clear the session cookie from the browser so it cannot reuse the old ID
    res.clearCookie('connect.sid', { path: '/' });
    res.json({ success: true });
  });
});

// ── SESSION USER API ──────────────────────────────────────────────────────────
app.get('/api/me', requireAuth, (req, res) => {
  res.json({ user: req.session.user });
});

// ── ACCOUNT ACTIVATION ────────────────────────────────────────────────────────
// First sign-in of an account made in User Management: its owner supplies their own Department/College,
// Institution, Designation and Contact Number here (User Management no longer asks for them on Add User).
// Until they do, the activation gate above keeps them on this page.
app.get('/activate', requireAuth, async (req, res) => {
  try {
    const userDoc = await getDb().collection('users').findOne({ id: req.session.user.id }, { projection: { password: 0 } });
    if (isActivated(userDoc)) return res.redirect(homeForRole(userDoc.role));
    res.render('activate', {
      activePage: '',
      account: { name: userDoc.name || '', email: userDoc.email || '', roleLabel: displayRoleName(userDoc.role) },
      profile: registeredProfile(userDoc)
    });
  } catch (err) {
    console.error('❌ Activation page error:', err);
    res.status(500).send('Unable to load the activation form right now. Please try again.');
  }
});

app.post('/api/activate', requireAuth, async (req, res) => {
  try {
    const text = (v) => (typeof v === 'string' ? v.trim() : '');
    const unit = text(req.body.unit);
    const institution = text(req.body.institution);
    const position = text(req.body.position);
    const contact = parseContactNumber(req.body.contactNumber);
    if (!unit || !institution || !position) {
      return res.status(400).json({ error: 'Please fill in your Department/College, Institution and Designation.' });
    }
    if (contact.error) return res.status(400).json({ error: contact.error });
    if (!contact.value) return res.status(400).json({ error: 'Contact number is required.' });

    const db = getDb();
    const userDoc = await db.collection('users').findOne({ id: req.session.user.id }, { projection: { password: 0 } });
    if (!userDoc) return res.status(404).json({ error: 'Account not found.' });
    if (isActivated(userDoc)) return res.json({ success: true, redirect: homeForRole(userDoc.role) });

    await db.collection('users').updateOne(
      { id: userDoc.id },
      { $set: { unit, institution, position, contactNumber: contact.value, activated: true, activatedAt: new Date() } }
    );
    req.session.user.unit = unit;
    req.session.user.activated = true;
    await logActivity(db, req.session.user, 'EDIT', `Account activated: ${userDoc.name} — ${userDoc.email}`);
    res.json({ success: true, redirect: homeForRole(userDoc.role) });
  } catch (err) {
    console.error('❌ Account activation error:', err);
    res.status(500).json({ error: 'Unable to activate your account right now. Please try again.' });
  }
});

// ── API ENDPOINTS FOR DYNAMIC DATA ───────────────────────────────────────────
app.get('/api/dashboard/stats', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const partnerships = await db.collection('partnerships').find({}).toArray();
    const requests = await db.collection('requests').find({}).toArray();

    const active = partnerships.filter(p => p.status === 'active').length;
    const expiring = partnerships.filter(p => p.status === 'expiring').length;
    const expired = partnerships.filter(p => p.status === 'expired').length;

    const pendingReqs = requests.filter(r => r.status === 'pending').length;
    const approvedReqs = requests.filter(r => r.status === 'approved').length;
    const rejectedReqs = requests.filter(r => r.status === 'rejected').length;

    const uniqueCountries = new Set(partnerships.map(p => p.country)).size;
    const uniqueInstitutions = new Set(partnerships.map(p => p.institution)).size;

    res.json({
      totalPartnerships: partnerships.length,
      activePartnerships: active,
      expiringPartnerships: expiring,
      expiredPartnerships: expired,
      totalRequests: requests.length,
      pendingRequests: pendingReqs,
      approvedRequests: approvedReqs,
      rejectedRequests: rejectedReqs,
      countries: uniqueCountries,
      institutions: uniqueInstitutions
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve dashboard stats' });
  }
});

// Partnership registry feed. Administrator and Staff (their Registry / Monitoring / DSS pages) and
// Auth. Personnel receive the full registry; a potential_partner receives ONLY the rows tied to its own
// approved requests (the same set as /mine below) — decided by the session role on the server, with no
// query parameter, id or institution name that can widen it. requireUploader (already used for the OCR
// upload routes) is reused here rather than requireAuth, keeping this to the four internal/uploading roles.
app.get('/api/partnerships', requireUploader, async (req, res) => {
  try {
    const db = getDb();
    // Newest registry record first by default (id is the auto-incrementing,
    // immutable creation-order field assigned once at insert — see the
    // `nextId`/`sort({id:-1})` pattern in POST /api/partnerships above —
    // there is no createdAt field on this collection and `start`/`end` are
    // user-editable signing dates, not registry-entry order). Every consumer
    // of this endpoint (Administrator/Staff Monitoring+Registry via
    // registry-gridjs.init.js, and Auth. Personnel's lifecycle page via
    // lifecycle-gridjs.init.js) renders rows in the order returned here with
    // no client-side re-sort, so this one server-side sort is what keeps all
    // of them consistently newest-first.
    // A Partner never receives other organizations' registry rows (this feed is the whole registry):
    // it is limited to the partnerships tied to that Partner's own approved requests — exactly the
    // /api/partnerships/mine set — enforced here on the server, not by what a page chooses to show.
    if (req.session.user.role === 'potential_partner') {
      return res.json(await partnershipsOwnedBy(db, req.session.user.email));
    }
    const docs = await db.collection('partnerships').find({}).sort({ id: -1 }).toArray();
    res.json(docs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve partnerships' });
  }
});

// Partnerships linked (by institution name, best-effort match) to the current
// user's own APPROVED requests only — used by the potential_partner Monitoring
// and Reports pages so they never receive other organizations' registry data,
// unlike the full /api/partnerships feed above.
async function partnershipsOwnedBy(db, email) {
  // A MOA/MOU submission is a file the partner sends CIRL, not a partnership — approving one never links a registry row.
  const myApproved = await db.collection('requests').find({ submittedByEmail: email, status: 'Approved', isSubmission: { $ne: true } }).toArray();
  const names = [...new Set(myApproved.map(r => r.institution).filter(Boolean))];
  if (names.length === 0) return [];
  const patterns = names.map(name => new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i'));
  return db.collection('partnerships').find({ inst: { $in: patterns } }).toArray();
}
app.get('/api/partnerships/mine', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    res.json(await partnershipsOwnedBy(db, email));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve partnerships' });
  }
});

// Administrator and Staff (2026-08-27 full-parity revision — Staff now
// manages every Partnership Request, not just its own) see every submitted
// request — this is what powers partnership_requests.ejs's org-wide review
// table for both roles. Every other role is scoped to only the requests
// they themselves submitted (same `submittedByEmail` filter as
// GET /api/requests/mine below).
const REQUEST_REVIEWER_ROLES = ['Administrator', 'Staff'];
app.get('/api/requests', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    const filter = req.session.user && REQUEST_REVIEWER_ROLES.includes(req.session.user.role) ? {} : { submittedByEmail: email };
    // Newest submission first by default. `id` (auto-incrementing, assigned
    // once at insert in POST /api/requests, never touched by either PATCH
    // route) is the authoritative submission-order field here — there is no
    // createdAt on this collection, `date` is a display-only formatted
    // string with day-only granularity, and `updatedAt` is deliberately NOT
    // used for this because it's overwritten on every admin/staff review
    // action (approve/reject/edit), which would reorder the list by "last
    // touched" instead of "newly submitted" every time a request is reviewed.
    const requests = await db.collection('requests').find(filter).sort({ id: -1 }).toArray();
    res.json(requests);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve requests' });
  }
});

// Request a renewal for a partnership tied to this user's own approved request.
// Creates a normal `requests` entry marked isRenewal — it's reviewed through the
// exact same admin queue as any other partnership request; approving it is what
// actually extends the underlying partnership record (see PATCH /api/requests/:id).
app.post('/api/partnerships/:id/renew-request', requireAuth, announce('request'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { proposedEndDate, notes } = req.body;
  if (!proposedEndDate || isNaN(new Date(proposedEndDate))) {
    return res.status(400).json({ error: 'A valid proposedEndDate is required.' });
  }
  try {
    const db = getDb();
    const partnership = await db.collection('partnerships').findOne({ id });
    if (!partnership) return res.status(404).json({ error: 'Partnership not found.' });

    // Ownership check — same institution-name match used by /api/partnerships/mine.
    const email = req.session.user ? req.session.user.email : '';
    const myApproved = await db.collection('requests').find({ submittedByEmail: email, status: 'Approved', isSubmission: { $ne: true } }).toArray();
    const myNames = new Set(myApproved.map(r => (r.institution || '').trim().toLowerCase()).filter(Boolean));
    const partnershipName = (partnership.inst || partnership.institution || '').trim().toLowerCase();
    if (!partnershipName || !myNames.has(partnershipName)) {
      return res.status(403).json({ error: 'You can only request renewal for your own partnership.' });
    }

    // Only one pending renewal request per partnership at a time.
    const existingRenewal = await db.collection('requests').findOne({
      renewalPartnershipId: id,
      status: { $in: ['Pending', 'Under Review'] }
    });
    if (existingRenewal) {
      return res.status(409).json({ error: 'A renewal request for this partnership is already pending.' });
    }

    const entry = await insertWithNextId(db.collection('requests'), (nextId) => ({
      id: nextId,
      institution: partnership.inst || partnership.institution || '',
      country: partnership.country || '',
      type: partnership.type || '',
      // partnership.nature can now be an array (multi-select) — the `requests`
      // collection's own `nature` field is unaffected by that change and stays
      // a plain string, so join for display here rather than storing an array
      // where a string has always been expected.
      nature: (Array.isArray(partnership.nature) ? partnership.nature.join(', ') : partnership.nature) || 'Renewal',
      category: partnership.cat || partnership.category || '',
      region: partnership.region || '',
      unit: partnership.unit || '',
      startDate: partnership.start || '',
      endDate: proposedEndDate,
      notes: notes || '',
      isRenewal: true,
      renewalPartnershipId: id,
      requestedBy: req.session.user ? req.session.user.name : 'Unknown',
      submittedByEmail: email,
      status: 'Pending',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      updatedAt: new Date().toISOString()
    }));

    await logActivity(db, req.session.user, 'SUBMIT',
      `Renewal request submitted: ${entry.institution} (${entry.type}) by ${entry.requestedBy}`);

    res.json({ success: true, request: entry });
  } catch (err) {
    console.error('❌ Renewal request submit error:', err);
    res.status(500).json({ error: 'Unable to submit the renewal request right now. Please try again.' });
  }
});

// Submit a new partnership request (any authenticated user).
// `isDraft: true` saves it as a Draft instead of submitting it for review —
// used by the potential_partner Partnership Request module so an applicant
// can start a request and finish it later (see the /edit and /submit routes
// below for the rest of the draft lifecycle).
app.post('/api/requests', requireRequester, denyCollegeStaffPartnershipRequests, announce('request'), async (req, res) => {
  const {
    institution, country, type, nature, notes, requestedBy, isDraft,
    category, region, unit, startDate, endDate, attachmentLink,
    isRenewal, renewalPartnershipId, isSubmission
  } = req.body;

  // "Submission Of MOA/MOU" (Partner only): the partner sends CIRL their MOA/MOU file/notes. It is filed as a Partnership
  // Request (so reviewers handle it under Partnership Requests/Submission, not Document Requests) but is not a request
  // to create a partnership — no country/type/nature, never a draft, and approving it never touches the registry.
  const submission = isSubmission === true && !!req.session.user && req.session.user.role === 'potential_partner';
  // College Partnership Report (College Dean only, 2026-09-26): the college already signed an MOA/MOU with another
  // institution on its own; the Dean sends CIRL the approved copy so it is on record. Filed as a Partnership Request so
  // CIRL reviews it in the same queue, and "approving" it records it in the Registry (same conversion as any request).
  // The approved copy itself is uploaded right after, through POST /api/requests/:id/documents.
  const collegeReport = req.body.isCollegeReport === true && !!req.session.user && req.session.user.role === 'Auth. Personnel';
  const draft = isDraft === true && !submission && !collegeReport;
  // Drafts are allowed to be incomplete — only a real submission requires the core fields.
  if (submission && !(institution || '').trim()) {
    return res.status(400).json({ error: 'Institution is required.' });
  }
  if (collegeReport) {
    const start = new Date(startDate), end = new Date(endDate);
    if (!startDate || !endDate || isNaN(start) || isNaN(end)) {
      return res.status(400).json({ error: 'The agreement\'s start and end dates are required.' });
    }
    if (end <= start) return res.status(400).json({ error: 'The end date must be after the start date.' });
  }
  if (!draft && !submission && (!institution || !country || !type || !nature)) {
    return res.status(400).json({ error: 'Missing required fields: institution, country, type, nature.' });
  }
  // The Partner form offers only MOA and MOU (the only agreement types the partnership registry accepts —
  // VALID_PARTNERSHIP_TYPES). Older requests/partnerships that carry another type are left exactly as they
  // are; only a NEW request is held to the two supported choices.
  if (type && !VALID_PARTNERSHIP_TYPES.includes(type)) {
    return res.status(400).json({ error: 'Agreement type must be one of: ' + VALID_PARTNERSHIP_TYPES.join(', ') + '.' });
  }
  try {
    const db = getDb();

    // Prevent duplicate active requests for the same institution (drafts and MOA/MOU submissions don't count — a
    // partner may send several files, and a pending submission must not block a real partnership request).
    if (!draft && !submission && institution) {
      const existing = await db.collection('requests').findOne({
        institution,
        status: { $in: ['Pending', 'Under Review'] },
        isSubmission: { $ne: true }
      });
      if (existing) {
        return res.status(409).json({ error: 'A pending request for this institution already exists.' });
      }
    }

    // A College Partnership Report belongs to the Dean's own college (from their account, never from the form).
    let reportUnit = '';
    if (collegeReport) {
      const me = await db.collection('users').findOne({ id: req.session.user.id }, { projection: { unit: 1 } });
      reportUnit = (me && me.unit) || req.session.user.unit || '';
    }

    const entry = await insertWithNextId(db.collection('requests'), (nextId) => ({
      id: nextId,
      institution: (institution || '').trim(),
      country: (country || '').trim(),
      type: type || '',
      nature: submission ? 'MOA/MOU Submission' : (nature || '').trim(),
      category: category || '',
      region: region || '',
      unit: collegeReport ? reportUnit : (partnerRequestUnit(req.session.user, { isSubmission: submission, isRenewal }) || unit || ''),
      startDate: startDate || '',
      endDate: endDate || '',
      attachmentLink: attachmentLink || '',
      notes: notes || '',
      requestedBy: requestedBy || (req.session.user ? req.session.user.name : 'Unknown'),
      submittedByEmail: req.session.user ? req.session.user.email : '',
      status: draft ? 'Draft' : 'Pending',
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      updatedAt: new Date().toISOString(),
      ...(submission ? { isSubmission: true } : {}),
      ...(collegeReport ? { isCollegeReport: true } : {}),
      ...(isRenewal && !collegeReport ? { isRenewal: true, renewalPartnershipId: renewalPartnershipId } : {})
    }));

    if (!draft) {
      const ref = `#REQ-${String(entry.id).padStart(3, '0')}`;
      await logActivity(db, req.session.user, 'SUBMIT',
        submission
          ? `MOA/MOU submission sent: ${entry.institution} by ${entry.requestedBy}`
          : collegeReport
            ? `College partnership reported: ${entry.institution} (${type}) by ${entry.requestedBy}${entry.unit ? ' — ' + entry.unit : ''}`
            : `Partnership request submitted: ${institution} (${type}) by ${entry.requestedBy}`);

      // Administrator and Staff — both review Partnership/Renewal Requests
      // (PATCH /api/requests/:id is requireStaffAccess-gated as of the
      // 2026-08-27 full-parity revision). Auth. Personnel was previously
      // broadcast an FYI alert for every submission by every user org-wide,
      // including other Auth. Personnel and potential_partner accounts they
      // have no relationship to — not "their own" notifications, and not
      // actionable by them. The submitter doesn't notify themselves.
      const reviewers = await db.collection('users')
        .find({ role: { $in: REQUEST_REVIEWER_ROLES } })
        .toArray();
      await notifyReviewers(db, reviewers, collegeReport
        ? {
          module: 'request',
          tag: 'College Partnership Report',
          icon: 'ri-government-line',
          color: 'success',
          title: `College partnership reported: ${entry.institution}`,
          desc: `${entry.requestedBy}${entry.unit ? ' (' + entry.unit + ')' : ''} sent a copy of an approved ${entry.type} with ${entry.institution}, ${entry.country} (${entry.startDate} to ${entry.endDate}). Review it and record it in the Registry.`
        }
        : {
          module: 'request',
          tag: isRenewal ? 'Renewal Request' : 'Partnership Request',
          icon: isRenewal ? 'ri-refresh-line' : 'ri-building-4-line',
          color: isRenewal ? 'info' : 'primary',
          title: submission ? `New MOA/MOU submission: ${entry.institution}`
            : isRenewal ? `Renewal initiated: ${entry.institution}` : `New request submitted: ${entry.institution}`,
          desc: submission
            ? `${entry.requestedBy} sent a MOA/MOU submission for ${entry.institution}.`
            : isRenewal
              ? `${entry.requestedBy} initiated a renewal request for ${entry.institution}.`
              : `${entry.requestedBy} submitted a new partnership request for ${entry.institution}.`
        }, role => prLinkForRole(role, entry.id));

      emailSubmissionReceipt(req.session.user, collegeReport
        ? {
          tag: 'College Partnership Report',
          title: `Partnership report received: ${entry.institution}`,
          desc: `CSPC-CIRL received your copy of the approved ${entry.type} with ${entry.institution} (reference ${ref}). You will be notified by e-mail once CIRL records it in the Partnership Registry.`,
          link: prLinkForRole(req.session.user.role, entry.id)
        }
        : {
          tag: submission ? 'MOA/MOU Submission' : isRenewal ? 'Renewal Request' : 'Partnership Request',
          title: submission ? `MOA/MOU submission received: ${entry.institution}` : `Request received: ${entry.institution}`,
          desc: submission
            ? `Your MOA/MOU submission for ${entry.institution} was sent to CSPC-CIRL (reference ${ref}). You will be notified by e-mail as it is reviewed.`
            : `Your ${isRenewal ? 'renewal' : 'partnership'} request for ${entry.institution}${entry.type ? ' (' + entry.type + ')' : ''} was submitted to CSPC-CIRL (reference ${ref}). You will be notified by e-mail as it is reviewed.`,
          link: prLinkForRole(req.session.user.role, entry.id)
        });

      // Give the submitter their own copy in the Document Library — skipped
      // when an OCR attachment already exists, since that upload was already
      // archived there (avoids a duplicate entry for one submission). A MOA/MOU
      // submission and a College Partnership Report archive the file attached to them instead of a request record.
      if (!submission && !collegeReport && ['Auth. Personnel', 'potential_partner'].includes(req.session.user.role) && !entry.attachmentLink) {
        await archiveRequestRecordToLibrary(db, {
          requestType: 'partnership', requestId: entry.id, institution: entry.institution,
          type: entry.type, submittedBy: entry.requestedBy, submittedByEmail: entry.submittedByEmail
        });
      }
    }

    res.json({ success: true, request: entry });
  } catch (err) {
    console.error('❌ Request submit error:', err);
    res.status(500).json({ error: 'Unable to submit the request right now. Please try again.' });
  }
});

// A Partner's new Partnership Request is always handled by CIRL, so its Responsible CSPC Unit is fixed to 'CIRL'
// (the Partner form no longer asks for it, and anything sent is overridden). MOA/MOU submissions and renewals keep
// their own unit handling. Returns the fixed unit, or null when the caller's value should be used.
const PARTNER_REQUEST_UNIT = 'CIRL';
function partnerRequestUnit(user, request) {
  if (!user || user.role !== 'potential_partner') return null;
  if (request && (request.isSubmission || request.isRenewal)) return null;
  return PARTNER_REQUEST_UNIT;
}

// Edit a request that is still a Draft — self-service, ownership-checked.
// Once a request is submitted (Pending/Under Review/etc.) it can no longer be
// edited this way, only withdrawn.
app.patch('/api/requests/:id/edit', requireRequester, denyCollegeStaffPartnershipRequests, announce('request'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('requests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.submittedByEmail !== email) {
      return res.status(403).json({ error: 'You can only edit your own request.' });
    }
    if (target.status !== 'Draft') {
      return res.status(400).json({ error: 'Only draft requests can be edited. Withdraw a submitted request instead.' });
    }

    if (req.body.type !== undefined && req.body.type !== '' && !VALID_PARTNERSHIP_TYPES.includes(req.body.type)) {
      return res.status(400).json({ error: 'Agreement type must be one of: ' + VALID_PARTNERSHIP_TYPES.join(', ') + '.' });
    }
    const allowed = ['institution', 'country', 'type', 'nature', 'category', 'region', 'unit', 'startDate', 'endDate', 'notes', 'attachmentLink'];
    const patch = { updatedAt: new Date().toISOString() };
    for (const key of allowed) {
      if (req.body[key] !== undefined) patch[key] = req.body[key];
    }
    const fixedUnit = partnerRequestUnit(req.session.user, target);
    if (fixedUnit) patch.unit = fixedUnit;
    await db.collection('requests').updateOne({ id }, { $set: patch });
    const updated = await db.collection('requests').findOne({ id });
    res.json({ success: true, request: updated });
  } catch (err) {
    console.error('❌ Request update error:', err);
    res.status(500).json({ error: 'Unable to update the request right now. Please try again.' });
  }
});

// Submit a previously-saved Draft for review — self-service, ownership-checked.
app.post('/api/requests/:id/submit', requireRequester, denyCollegeStaffPartnershipRequests, announce('request'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('requests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.submittedByEmail !== email) {
      return res.status(403).json({ error: 'You can only submit your own request.' });
    }
    if (target.status !== 'Draft') {
      return res.status(400).json({ error: 'Only draft requests can be submitted.' });
    }
    if (!target.institution || !target.country || !target.type || !target.nature) {
      return res.status(400).json({ error: 'Please complete institution, country, agreement type, and nature before submitting.' });
    }
    if (!VALID_PARTNERSHIP_TYPES.includes(target.type)) {
      // an older draft saved with a type the form no longer offers (LOI / JVA / Other): pick MOA or MOU, then submit
      return res.status(400).json({ error: 'Agreement type must be MOA or MOU. Edit the draft and choose one before submitting.' });
    }

    const existing = await db.collection('requests').findOne({
      institution: target.institution,
      status: { $in: ['Pending', 'Under Review'] },
      isSubmission: { $ne: true },
      id: { $ne: id }
    });
    if (existing) {
      return res.status(409).json({ error: 'A pending request for this institution already exists.' });
    }

    await db.collection('requests').updateOne({ id }, {
      $set: { status: 'Pending', date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }), updatedAt: new Date().toISOString() }
    });
    const updated = await db.collection('requests').findOne({ id });
    await logActivity(db, req.session.user, 'SUBMIT',
      `Partnership request submitted: ${updated.institution} (${updated.type}) by ${updated.requestedBy}`);

    // Same alerts as a request submitted directly (POST /api/requests): the reviewers, and a receipt to the submitter.
    const reviewers = await db.collection('users').find({ role: { $in: REQUEST_REVIEWER_ROLES } }).toArray();
    await notifyReviewers(db, reviewers, {
      module: 'request',
      tag: updated.isRenewal ? 'Renewal Request' : 'Partnership Request',
      icon: updated.isRenewal ? 'ri-refresh-line' : 'ri-building-4-line',
      color: updated.isRenewal ? 'info' : 'primary',
      title: `New request submitted: ${updated.institution}`,
      desc: `${updated.requestedBy} submitted a new partnership request for ${updated.institution}.`
    }, role => prLinkForRole(role, id));
    emailSubmissionReceipt(req.session.user, {
      tag: 'Partnership Request',
      title: `Request received: ${updated.institution}`,
      desc: `Your partnership request for ${updated.institution} (${updated.type}) was submitted to CSPC-CIRL (reference #REQ-${String(id).padStart(3, '0')}). You will be notified by e-mail as it is reviewed.`,
      link: prLinkForRole(req.session.user.role, id)
    });

    if (['Auth. Personnel', 'potential_partner'].includes(req.session.user.role) && !updated.attachmentLink) {
      await archiveRequestRecordToLibrary(db, {
        requestType: 'partnership', requestId: id, institution: updated.institution,
        type: updated.type, submittedBy: updated.requestedBy, submittedByEmail: updated.submittedByEmail
      });
    }

    res.json({ success: true, request: updated });
  } catch (err) {
    console.error('❌ Request update error:', err);
    res.status(500).json({ error: 'Unable to update the request right now. Please try again.' });
  }
});

// Delete a Draft outright — self-service, ownership-checked. Submitted
// requests must be withdrawn instead (see /withdraw below), not deleted.
app.delete('/api/requests/:id', requireRequester, denyCollegeStaffPartnershipRequests, announce('request'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('requests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.submittedByEmail !== email) {
      return res.status(403).json({ error: 'You can only delete your own draft.' });
    }
    if (target.status !== 'Draft') {
      return res.status(400).json({ error: 'Only draft requests can be deleted.' });
    }
    await db.collection('requests').deleteOne({ id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Request delete error:', err);
    res.status(500).json({ error: 'Unable to delete the request right now. Please try again.' });
  }
});

// Get partnership requests submitted by current user (by email)
app.get('/api/requests/mine', requireAuth, async (req, res) => {
  const email = req.session.user ? req.session.user.email : '';
  try {
    const db = getDb();
    const requests = await db.collection('requests')
      .find({ submittedByEmail: email })
      .sort({ id: -1 })
      .toArray();
    res.json(requests);
  } catch (err) {
    console.error('❌ Requests list error:', err);
    res.status(500).json({ error: 'Unable to load your requests right now. Please try again.' });
  }
});

// Prevents re-running side effects (duplicate partnership-extension updates,
// duplicate notifications, duplicate activity-log entries, duplicate
// role-promotions) by rejecting a decision PATCH unless the request is still
// in an undecided state — closes B4 (Roadmap v2 Phase C2,
// docs/SYSTEM_AUDIT_2026-07-16.md): previously a request could be approved
// twice, rejected after already being approved, or approved after being
// withdrawn, each re-run re-executing every side effect.
const UNDECIDED_REQUEST_STATUSES = ['Pending', 'Under Review'];

// Update partnership request status (approve / reject) — Administrator and
// Staff share this exact review authority as of 2026-08-27 (full parity).
app.patch('/api/requests/:id', requireStaffAccess, announce('request'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { status, notes } = req.body;
  const validStatuses = ['Pending', 'Under Review', 'Approved', 'Rejected'];
  if (!validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const db = getDb();
    // EVERY status change needs a request that is still open - not only a decision. Without this, a stale review dialog
    // (or a direct call) could move a Rejected / Withdrawn / Approved request back to Under Review or Pending.
    const current = await db.collection('requests').findOne({ id });
    if (!current) return res.status(404).json({ error: 'Request not found.' });
    if (current.status === 'Draft') {
      return res.status(400).json({ error: 'This request is still a draft that its owner has not submitted, so it cannot be reviewed yet.' });
    }
    if (!UNDECIDED_REQUEST_STATUSES.includes(current.status)) {
      return res.status(400).json({ error: `This request has already been decided (current status: ${current.status}) and cannot be changed.` });
    }
    await db.collection('requests').updateOne(
      { id },
      { $set: { status, notes: notes || '', updatedAt: new Date().toISOString(), decidedBy: req.session.user.name } }
    );
    const updated = await db.collection('requests').findOne({ id });
    if (!updated) return res.status(404).json({ error: 'Request not found.' });
    const action = status === 'Approved' ? 'APPROVE' : status === 'Rejected' ? 'REJECT' : 'EDIT';
    await logActivity(db, req.session.user, action,
      `Partnership request ${status.toLowerCase()}: ${updated.inst || updated.institution || 'ID #' + id} (${updated.type || ''})`);

    // Approving a renewal request doesn't just flip its own status — it actually
    // extends the linked partnership record (new expiry + recomputed status).
    if (status === 'Approved' && updated.isRenewal && updated.renewalPartnershipId) {
      // computeStatusFromEnd() (below) is the one authoritative status rule in the app — every other read of
      // it (Reports & Analytics, Dashboard, the hourly lifecycle job) already uses it; this used to call a
      // second, independently-written copy (computePartnershipStatus(), now removed) that disagreed with it
      // on the expiry date itself (treated day 0 as already Expired, instead of still Expiring Soon), so a
      // just-renewed partnership could show one status here and a contradictory one an hour later when the
      // lifecycle job recomputed it. `|| 'Active'` preserves that function's old fallback for an unparseable
      // date — can't happen today (the renewal request's own proposedEndDate is validated at creation), but
      // this is still a $set write and must never store a null status.
      const newStatus = computeStatusFromEnd(updated.endDate) || 'Active';
      const parsedEnd = new Date(updated.endDate);
      const formattedEnd = isNaN(parsedEnd)
        ? updated.endDate
        : parsedEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
      const setFields = { end: formattedEnd, status: newStatus };
      if (!isNaN(parsedEnd)) setFields.endYear = parsedEnd.getFullYear();
      await db.collection('partnerships').updateOne({ id: updated.renewalPartnershipId }, { $set: setFields });
      await logActivity(db, req.session.user, 'RENEW',
        `Partnership renewed: ${updated.institution} — new expiry ${formattedEnd}`);
    }

    // Notify the submitter directly (targeted — not part of the global staff
    // feed) so a potential_partner actually finds out their request moved.
    // Includes the 'Under Review' transition (previously silent) as the
    // "additional documents requested" signal — the Administrator has no
    // separate action for this, so re-using the existing status value avoids
    // adding a new field/workflow for what is still just a status change.
    if (['Approved', 'Rejected', 'Under Review'].includes(status) && updated.submittedByEmail) {
      const label = updated.isCollegeReport ? 'College Partnership Report' : updated.isRenewal ? 'Renewal Request' : 'Partnership Request';
      const submitter = await db.collection('users').findOne({ email: updated.submittedByEmail });
      const link = prLinkForRole(submitter && submitter.role, id);
      const what = updated.isSubmission ? 'MOA/MOU submission' : updated.isCollegeReport ? 'partnership report' : updated.isRenewal ? 'renewal request' : 'partnership request';
      let title, desc, icon, color;
      if (status === 'Under Review') {
        title = `Additional documents requested: ${updated.institution}`;
        desc = `The Administrator has requested additional documents or information for your ${what} (${updated.institution}).${notes ? ' Note: ' + notes : ''}`;
        icon = 'ri-file-add-line'; color = 'warning';
      } else {
        title = `${updated.isSubmission ? 'MOA/MOU Submission' : label} ${status}: ${updated.institution}`;
        icon = status === 'Approved' ? 'ri-checkbox-circle-line' : 'ri-close-circle-line';
        color = status === 'Approved' ? 'success' : 'danger';
        desc = status === 'Approved'
          ? (updated.isRenewal
            ? `Your renewal request for ${updated.institution} has been approved. The partnership has been extended.`
            : `Your ${what} for ${updated.institution} has been approved.`)
          : (updated.isRenewal
            ? `Your renewal request for ${updated.institution} was not approved.${notes ? ' Reason: ' + notes : ''}`
            : updated.isCollegeReport
              ? `CIRL did not record your partnership report for ${updated.institution} in the Registry.${notes ? ' Reason: ' + notes : ''}`
              : `Your ${what} for ${updated.institution} was not approved.${notes ? ' Reason: ' + notes : ''}`);
      }
      await notifyUsers(db, [updated.submittedByEmail], { module: 'request', tag: label, icon, color, title, desc, link });
    }

    res.json({ success: true, request: updated });
  } catch (err) {
    console.error('❌ Request decision error:', err);
    res.status(500).json({ error: 'Unable to process the request right now. Please try again.' });
  }
});

// Administrator or Staff uploads a supporting document while reviewing a
// Partnership Request draft/document collaboration timeline (2026-08-27
// revision). Either side of the conversation can add a new version here:
// Administrator/Staff (REQUEST_REVIEWER_ROLES, reviewing) or the request's
// own submitter (Auth. Personnel/potential_partner, revising their own
// draft) — never anyone else's request. Reuses the exact same secure
// upload workflow as everywhere else (uploadMiddleware's multer instance +
// verifyMagicBytes) and the Document Library's own archive function — the
// file is stored once, in the Document Library, and linked back from the
// request; it is not duplicated into a second, request-specific location.
// Ownership is always set to the requester's email (regardless of which
// side actually uploaded) so every version automatically appears in the
// requester's own Document Library view, and so the existing
// GET /uploads/documents/:filename ownership check already lets the true
// requester (and both reviewer roles) open any version — no changes needed
// there. Every version is pushed, never replaced — supportingDocuments is a
// running history, not a single current file.
app.post('/api/requests/:id/documents', requireAuth, announce('request'), (req, res) => {
  uploadDoc.single('document')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum size is 10MB.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (err) {
      // clientSafe (set by uploadMiddleware.js's fileFilter): a deliberate validation message, safe to
      // show as-is. Anything else here is an unexpected failure (disk I/O, etc.) and must not echo raw
      // internals to the client.
      if (!err.clientSafe) console.error('❌ Request document upload error:', err);
      return res.status(400).json({ error: err.clientSafe ? err.message : 'Upload failed. Please try again.' });
    }
    const note = (req.body.note || '').trim().slice(0, 1000);
    // File is now OPTIONAL (2026-09-19) — notes alone are a legitimate new
    // version/draft entry. Only reject when NEITHER is present; a file with
    // no note, or a note with no file, are both still valid on their own.
    if (!req.file && !note) {
      return res.status(400).json({ error: 'Provide a file, a note, or both to add a new version.' });
    }
    if (req.file && !verifyMagicBytes(req.file)) {
      fs.unlink(req.file.path, () => { });
      return res.status(400).json({ error: 'Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.' });
    }
    const id = parseInt(req.params.id);
    const actor = req.session.user;
    try {
      const db = getDb();
      const target = await db.collection('requests').findOne({ id });
      if (!target) {
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(404).json({ error: 'Request not found.' });
      }

      const isReviewer = REQUEST_REVIEWER_ROLES.includes(actor.role);
      const isOwner = target.submittedByEmail && target.submittedByEmail === actor.email;
      if (!isReviewer && !isOwner) {
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(403).json({ error: 'You are not authorized to upload documents to this request.' });
      }
      if (['Approved', 'Rejected', 'Withdrawn'].includes(target.status)) {
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: `This request has already been ${target.status.toLowerCase()} — no further documents can be added.` });
      }

      // Document Library attribution: a reviewer (Staff/Administrator)
      // uploading a new version FOR the requester must own that Document
      // Library entry themselves — not the requester — so it shows up in the
      // reviewer's own library (Document Library visibility is scoped by
      // uploadedByEmail; see OWN_SCOPE_ROLES/GET /api/documents). Previously
      // this always used target.submittedByEmail regardless of who actually
      // uploaded, so a reviewer's own upload silently never appeared in
      // their own Document Library. The request's own supportingDocuments
      // entry below already correctly used actor.email/actor.name for the
      // request-history record — only this separate Document Library archive
      // call had the bug. When the requester uploads their own revision
      // (isOwner), behavior is unchanged (actor IS the requester already).
      // A notes-only version has no file at all — skip the archive step
      // entirely rather than inventing a fake filename/Document Library
      // record for something that was never uploaded.
      let documentId = null, fileLink = null;
      if (req.file) {
        ({ documentId, fileLink } = await archiveToDocumentLibrary(req.file.path, req.file.originalname, {
          documentType: target.isSubmission ? 'MOA/MOU Submission' : expandDocTypeLabel(target.type),
          institution: target.institution,
          partner: target.institution,
          title: target.isCollegeReport
            ? `Approved ${target.type || 'Agreement'} – ${target.institution} (${target.unit ? target.unit + ' ' : ''}College Report #${id})`
            : `${target.isSubmission ? 'MOA/MOU Submission' : (target.type || 'Document')} – ${target.institution} (Request #${id})`
        }, {
          uploadedBy: isReviewer ? actor.name : (target.requestedBy || 'Unknown'),
          uploadedByEmail: isReviewer ? actor.email : target.submittedByEmail,
          requestId: id,
          requestType: 'partnership'
        }));
      }

      const docRecord = {
        documentId, fileLink,
        originalFilename: req.file ? req.file.originalname : null,
        uploadedAt: new Date().toISOString(), uploadedBy: actor.name,
        uploadedByEmail: actor.email, uploaderRole: actor.role,
        note, fileType: req.file ? req.file.mimetype : null, fileSize: req.file ? req.file.size : 0
      };
      const setFields = { updatedAt: new Date().toISOString() };
      // The file that goes with a brand-new MOA/MOU submission is part of the submission itself: it is not a "revised
      // draft", so it neither starts the review nor sends reviewers a second notification. Only the owner, only on a
      // submission that has no document yet, and only when the page says it is the initial attachment.
      // The same goes for the approved copy attached to a College Partnership Report.
      const initialSubmissionFile = !!(target.isSubmission || target.isCollegeReport) && isOwner && req.body.initial === '1'
        && !(Array.isArray(target.supportingDocuments) && target.supportingDocuments.length);
      // A new version puts the request back "in collaboration" — reuses the
      // existing Under Review status rather than inventing a new one (it
      // already means exactly this for Approve/Reject purposes too).
      if (target.status === 'Pending' && !initialSubmissionFile) setFields.status = 'Under Review';
      await db.collection('requests').updateOne({ id }, { $push: { supportingDocuments: docRecord }, $set: setFields });
      const updated = await db.collection('requests').findOne({ id });

      const fileLabel = req.file ? req.file.originalname : 'notes only';
      await logActivity(db, actor, 'EDIT',
        `Draft document uploaded for partnership request: ${target.institution} (${fileLabel})${note ? ' — "' + note + '"' : ''}`);

      // Reviewer uploaded → notify the requester. Requester uploaded a
      // revision → notify every reviewer (same broadcast set used for a
      // brand-new submission), not just Administrator.
      if (isReviewer && target.submittedByEmail) {
        const submitter = await db.collection('users').findOne({ email: target.submittedByEmail });
        await notifyUsers(db, [target.submittedByEmail], {
          module: 'request',
          tag: target.isRenewal ? 'Renewal Request' : 'Partnership Request',
          icon: 'ri-file-upload-line',
          color: 'info',
          title: `New draft uploaded: ${target.institution}`,
          desc: req.file
            ? `${actor.name} uploaded "${req.file.originalname}" for your request (${target.institution}).${note ? ' Note: ' + note : ''}`
            : `${actor.name} added new notes for your request (${target.institution}).${note ? ' Note: ' + note : ''}`,
          link: prLinkForRole(submitter && submitter.role, id),
          downloadLink: fileLink
        });
      } else if (isOwner && !initialSubmissionFile) {
        const reviewers = await db.collection('users').find({ role: { $in: REQUEST_REVIEWER_ROLES } }).toArray();
        await notifyReviewers(db, reviewers, {
          module: 'request',
          tag: target.isRenewal ? 'Renewal Request' : 'Partnership Request',
          icon: 'ri-file-upload-line',
          color: 'info',
          title: `Revised draft uploaded: ${target.institution}`,
          desc: req.file
            ? `${actor.name} uploaded a revised draft "${req.file.originalname}" for their request (${target.institution}).${note ? ' Note: ' + note : ''}`
            : `${actor.name} added new notes to their request (${target.institution}).${note ? ' Note: ' + note : ''}`
        }, role => prLinkForRole(role, id));
      }

      res.json({ success: true, documentId, fileLink, request: updated });
    } catch (e) {
      // 2026-09-06 security hardening (Finding #6, follow-up sweep): a
      // failure here is most often a filesystem/disk error on the just-
      // written upload — never echo that raw path/message to the client.
      console.error('❌ Partnership request draft upload error:', e);
      res.status(500).json({ error: 'Unable to save the uploaded document right now. Please try again.' });
    }
  });
});

// Withdrawing a submitted request is disabled: once submitted, a request stays with CIRL until it is decided.
// The route is kept only so a direct call gets a clear refusal instead of a 404. Requests withdrawn before this
// change keep their "Withdrawn" status and are still shown (and counted as closed) everywhere.
app.post('/api/requests/:id/withdraw', requireRequester, denyCollegeStaffPartnershipRequests, (req, res) => {
  res.status(403).json({ error: 'Withdrawing a submitted request is no longer allowed.' });
});

// ── Document Requests (Auth. Personnel + potential_partner) ─────────────
// Replaces Personnel's old "new partnership" submission — a separate
// workflow from Partnership Requests. "Document(s) Requested" is a
// free-form multi-select (2026-09-02): requesters can pick any number of
// these suggestions and/or type entirely custom document names — this list
// is shown in the combobox but never enforced server-side (see the
// validation below, which only requires a non-empty array of strings).
const DOCUMENT_TYPE_SUGGESTIONS = [
  'Compliance requirements for international linkages and consortia (MAN)',
  'Universitas Airlangga - MOA',
  'MOUs',
  'Photos/Docs - IMC Japan',
  'Terminal Reports (International Activity); Year end report of activities',
  'QS Star Rating result',
  'Handbook or manual regarding student participation on internationalization',
  'International Linkages; International students/faculty'
];
// Fixed institutional signatory shown on every Fulfilled Document Request's
// "Approved By" line — this is a real, unchanging office designation (CIRL
// Head), not tied to whichever Staff/Administrator account processed the
// request, so it is intentionally a constant rather than session data.
const DR_APPROVER_NAME = 'Filmor J. Murillo';
const DR_APPROVER_TITLE = 'Head, Center for International Relations and Linkages';

// Document Request workflow (2026-09-04): the granular, ordered pipeline a
// document request moves through after being submitted/received, replacing
// the old binary Pending/Under Review decision model. Rejected remains a
// separate, non-sequential outcome reachable from any non-terminal stage —
// it is not part of the ordered pipeline itself (see docs/SYSTEM_AUDIT).
const DR_WORKFLOW_STATUSES = ['Received', 'Preparing', 'Awaiting for Approval', 'Approved', 'Release', 'Completed'];
const DR_TERMINAL_STATUSES = ['Completed', 'Rejected'];
// Pre-2026-09-04 status names, mapped to their canonical successor in the
// new pipeline. Existing records keep their stored `status` value untouched
// until the next time it's actually changed — this map lets every other
// part of the system (transition validation, UI display, the printable
// form) treat a legacy record identically to its canonical equivalent, with
// no bulk data migration required.
const DR_LEGACY_STATUS_MAP = { 'Pending': 'Received', 'Under Review': 'Preparing', 'Fulfilled': 'Completed' };
function canonicalDrStatus(status) {
  return DR_LEGACY_STATUS_MAP[status] || status;
}
// The one legitimate forward move from a given canonical status — skipping
// ahead or moving backward is rejected by the PATCH handler below. Returns
// null once the pipeline's final stage (Completed) is reached.
function drNextStatus(canonicalStatus) {
  const idx = DR_WORKFLOW_STATUSES.indexOf(canonicalStatus);
  return (idx === -1 || idx === DR_WORKFLOW_STATUSES.length - 1) ? null : DR_WORKFLOW_STATUSES[idx + 1];
}
// Additive: exposes each request's normalized pipeline position as
// `canonicalStatus` without touching the stored `status` field, so every
// list-returning endpoint (reviewer queue + the requester's own "mine" view)
// can consistently drive dropdown pre-selection, badge color/label, and the
// requester-facing progress checklist off one normalized value.
function withDrCanonicalStatus(requests) {
  return requests.map(r => ({ ...r, canonicalStatus: canonicalDrStatus(r.status) }));
}

app.post('/api/document-requests', requireRequester, announce('documentRequest'), async (req, res) => {
  const { institution, notes, contactNumber, documentForm } = req.body;
  // Accept the new documentTypes array; fall back to the legacy singular
  // documentType string so older API callers/tests keep working unchanged.
  let documentTypes = Array.isArray(req.body.documentTypes)
    ? req.body.documentTypes
    : (req.body.documentType ? [req.body.documentType] : []);
  documentTypes = documentTypes
    .filter(t => typeof t === 'string')
    .map(t => t.trim().slice(0, 300))
    .filter(Boolean)
    .slice(0, 20);
  if (!institution || documentTypes.length === 0) {
    return res.status(400).json({ error: 'Missing required fields: institution, documentTypes.' });
  }
  try {
    const db = getDb();
    // A College Dean's contact number is the one entered when the account was registered — the request form shows it
    // read-only, and whatever the client sends is ignored here too. (An account registered without a number can still
    // type one on the request, as before.)
    let requestContactNumber = contactNumber || '';
    if (req.session.user && req.session.user.role === 'Auth. Personnel') {
      const me = await db.collection('users').findOne({ id: req.session.user.id }, { projection: { contactNumber: 1 } });
      if (me && me.contactNumber) requestContactNumber = me.contactNumber;
    }

    const entry = await insertWithNextId(db.collection('documentrequests'), (nextId) => ({
      id: nextId,
      institution: institution.trim(),
      documentTypes,
      // Joined display string kept for every place that already reads
      // documentType as free text (notifications, logs, table badges,
      // Document Library metadata) — avoids touching those call sites.
      documentType: documentTypes.join(', '),
      notes: notes || '',
      // Contact Number and Document Form (Printed/Digital Copy) exist solely to
      // populate the official CSPC-F-CIRL-04 printable form — no other part of
      // the app reads them.
      contactNumber: requestContactNumber,
      documentForm: documentForm || '',
      requestedBy: req.session.user ? req.session.user.name : 'Unknown',
      requestedByEmail: req.session.user ? req.session.user.email : '',
      status: 'Received', // pipeline's starting stage (see DR_WORKFLOW_STATUSES)
      date: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
      submittedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    }));

    await logActivity(db, req.session.user, 'SUBMIT',
      `Document request submitted: ${entry.documentType} for ${entry.institution} by ${entry.requestedBy}`);

    const reviewers = await db.collection('users').find({ role: { $in: REQUEST_REVIEWER_ROLES } }).toArray();
    await notifyReviewers(db, reviewers, {
      module: 'request',
      tag: 'Document Request',
      icon: 'ri-file-shield-2-line',
      color: 'secondary',
      title: `New document request submitted: ${entry.institution}`,
      desc: `${entry.requestedBy} requested a ${entry.documentType} document for ${entry.institution}.`
    }, role => drLinkForRole(role, entry.id));
    emailSubmissionReceipt(req.session.user, {
      tag: 'Document Request',
      title: `Document request received: ${entry.institution}`,
      desc: `Your request for ${entry.documentType} (${entry.institution}) was received by CSPC-CIRL. You will be notified by e-mail at each stage until it is completed.`,
      link: drLinkForRole(req.session.user.role, entry.id)
    });

    // Document Requests never have an upload step of their own, so this is
    // the only copy of the submission that ever lands in the requester's
    // Document Library — links to the existing printable form (built for the
    // print/PDF feature) rather than a fabricated file.
    if (['Auth. Personnel', 'potential_partner'].includes(req.session.user.role)) {
      await archiveRequestRecordToLibrary(db, {
        requestType: 'document', requestId: entry.id, institution: entry.institution,
        type: entry.documentType, submittedBy: entry.requestedBy, submittedByEmail: entry.requestedByEmail,
        viewLink: `/document-requests/${entry.id}/print`
      });
    }

    res.json({ success: true, request: entry });
  } catch (err) {
    console.error('❌ Document request submit error:', err);
    res.status(500).json({ error: 'Unable to submit the document request right now. Please try again.' });
  }
});

app.get('/api/document-requests/mine', requireRequester, async (req, res) => {
  const email = req.session.user ? req.session.user.email : '';
  try {
    const db = getDb();
    const requests = await db.collection('documentrequests')
      .find({ requestedByEmail: email })
      .sort({ id: -1 })
      .toArray();
    res.json(withDrCanonicalStatus(requests));
  } catch (err) {
    console.error('❌ Document requests list error:', err);
    res.status(500).json({ error: 'Unable to load your document requests right now. Please try again.' });
  }
});

// Cancel own document request — self-service, ownership-checked, allowed
// only at the pipeline's starting stage (Received, or its legacy equivalent
// Pending) before any reviewer has begun acting on it.
app.delete('/api/document-requests/:id', requireRequester, announce('documentRequest'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('documentrequests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Document request not found.' });

    const email = req.session.user ? req.session.user.email : '';
    if (target.requestedByEmail !== email) {
      return res.status(403).json({ error: 'You can only cancel your own document request.' });
    }
    if (canonicalDrStatus(target.status) !== 'Received') {
      return res.status(400).json({ error: 'Only newly-received document requests can be cancelled.' });
    }
    await db.collection('documentrequests').deleteOne({ id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Document request cancel error:', err);
    res.status(500).json({ error: 'Unable to cancel the document request right now. Please try again.' });
  }
});

// Get all document requests (admin review queue) — requireStaffAccess so
// Administrator and Staff manage every Document Request (full parity,
// 2026-08-27) via the shared Requests page's Document Requests tab. Same
// reviewer-role scoping as GET /api/requests above: any other role sees
// only their own — moot in practice since only Administrator/Auth.
// Personnel/potential_partner can submit these (requireRequester), but kept
// consistent/correct rather than relying on that being permanently true.
app.get('/api/document-requests', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    const filter = req.session.user && REQUEST_REVIEWER_ROLES.includes(req.session.user.role) ? {} : { requestedByEmail: email };
    const requests = await db.collection('documentrequests').find(filter).sort({ id: -1 }).toArray();
    res.json(withDrCanonicalStatus(requests));
  } catch (err) {
    console.error('❌ Document requests list error:', err);
    res.status(500).json({ error: 'Unable to load document requests right now. Please try again.' });
  }
});

// Notification copy per workflow stage — 'Received' is deliberately absent
// (it is the request's starting state at submission time, never something a
// reviewer transitions it INTO, so there is nothing new to tell the
// requester). Rejected keeps its own distinct branch below since it isn't
// part of the ordered pipeline these describe.
const DR_STATUS_NOTIFICATION_COPY = {
  'Preparing': { icon: 'ri-tools-line', color: 'info', verb: 'is now being prepared' },
  'Awaiting for Approval': { icon: 'ri-time-line', color: 'warning', verb: 'is awaiting approval' },
  'Approved': { icon: 'ri-checkbox-circle-line', color: 'success', verb: 'has been approved' },
  'Release': { icon: 'ri-file-transfer-line', color: 'primary', verb: 'is ready for release' },
  'Completed': { icon: 'ri-checkbox-circle-fill', color: 'success', verb: 'has been completed. Check the Document Library for the uploaded file' }
};

// Advance (or reject) a document request through the workflow — Administrator
// or Staff (full parity). `status` accepts both the current canonical stage
// names and any pre-2026-09-04 legacy name (Pending/Under Review/Fulfilled),
// which is normalized to its canonical equivalent before validation/storage
// so every write from here on uses only the canonical vocabulary.
app.patch('/api/document-requests/:id', requireStaffAccess, announce('documentRequest'), async (req, res) => {
  const id = parseInt(req.params.id);
  const { remark, receivedBy } = req.body;
  const status = canonicalDrStatus(req.body.status);
  const validTargets = [...DR_WORKFLOW_STATUSES, 'Rejected'];
  if (!validTargets.includes(status)) {
    return res.status(400).json({ error: 'Invalid status.' });
  }
  try {
    const db = getDb();
    const current = await db.collection('documentrequests').findOne({ id });
    if (!current) return res.status(404).json({ error: 'Document request not found.' });
    const currentCanonical = canonicalDrStatus(current.status);

    if (DR_TERMINAL_STATUSES.includes(currentCanonical)) {
      return res.status(400).json({ error: `This request has already been decided (current status: ${current.status}) and cannot be changed.` });
    }
    if (status !== 'Rejected') {
      // Reject is reachable from any non-terminal stage (handled above);
      // every other target must be exactly the next stage in the pipeline —
      // no skipping ahead, no moving backward.
      const expectedNext = drNextStatus(currentCanonical);
      if (status !== expectedNext) {
        return res.status(400).json({
          error: expectedNext
            ? `Invalid status transition: "${currentCanonical}" can only move to "${expectedNext}" next, not "${status}".`
            : `"${currentCanonical}" cannot be advanced further.`
        });
      }
    }

    const now = new Date().toISOString();
    // decidedBy/updatedAt track who last touched the status, for audit
    // purposes. The printable form's "Approved By" line is a fixed
    // institutional signatory (DR_APPROVER_NAME/DR_APPROVER_TITLE, rendered
    // in drFormFields below) and is never taken from this field.
    const setFields = { status, remark: remark || '', updatedAt: now, decidedBy: req.session.user.name };
    if (status === 'Approved') {
      setFields.approvedAt = now;
    }
    if (status === 'Release') {
      // Released By must reflect real data, never a hand-typed/hardcoded
      // name: it is always whoever is actually performing the release (the
      // authenticated actor), regardless of what the client sends.
      setFields.releasedBy = req.session.user.name;
      setFields.releasedAt = now;
    }
    if (status === 'Completed') {
      // Received By defaults to the request's own requester (the person the
      // documents were requested for) but a reviewer may override it — e.g.
      // when a different, named representative physically collects the
      // documents on the requester's behalf.
      setFields.receivedBy = (receivedBy && receivedBy.trim()) || current.requestedBy || '';
      setFields.receivedAt = now;
    }
    // Every transition — including automatic ones elsewhere in this file —
    // is appended to statusHistory, never overwritten, so the full audit
    // trail of who moved the request through which stages and when is
    // always reconstructable straight from the request document itself.
    const historyEntry = { from: current.status, to: status, at: now, by: req.session.user.name, byEmail: req.session.user.email, remark: remark || '' };

    await db.collection('documentrequests').updateOne(
      { id },
      { $set: setFields, $push: { statusHistory: historyEntry } }
    );
    const updated = await db.collection('documentrequests').findOne({ id });
    if (!updated) return res.status(404).json({ error: 'Document request not found.' });

    const action = status === 'Completed' ? 'APPROVE' : status === 'Rejected' ? 'REJECT' : 'EDIT';
    await logActivity(db, req.session.user, action,
      `Document request status changed to "${status}": ${updated.documentType} for ${updated.institution} (requested by ${updated.requestedBy})`);

    // Targeted notification to the requester only (Auth. Personnel or, since
    // 2026-07-22, potential_partner) — every stage except the starting
    // 'Received' state notifies, plus the separate Rejected outcome.
    if (updated.requestedByEmail && (status === 'Rejected' || DR_STATUS_NOTIFICATION_COPY[status])) {
      const requester = await db.collection('users').findOne({ email: updated.requestedByEmail });
      const link = drLinkForRole(requester && requester.role, id);
      let title, desc, icon, color;
      if (status === 'Rejected') {
        title = `Document Request Rejected: ${updated.documentType} for ${updated.institution}`;
        icon = 'ri-close-circle-line'; color = 'danger';
        desc = `Your request for a ${updated.documentType} document (${updated.institution}) was not fulfilled.${remark ? ' Reason: ' + remark : ''}`;
      } else {
        const copy = DR_STATUS_NOTIFICATION_COPY[status];
        title = `Document Request ${status}: ${updated.documentType} for ${updated.institution}`;
        icon = copy.icon; color = copy.color;
        desc = `Your request for a ${updated.documentType} document (${updated.institution}) ${copy.verb}.${remark ? ' Note: ' + remark : ''}`;
      }
      await notifyUsers(db, [updated.requestedByEmail], { module: 'request', tag: 'Document Request', icon, color, title, desc, link });
    }

    res.json({ success: true, request: updated });
  } catch (err) {
    console.error('❌ Document request decision error:', err);
    res.status(500).json({ error: 'Unable to update the document request right now. Please try again.' });
  }
});

// Document Request draft/document collaboration timeline (2026-08-27,
// mirrors POST /api/requests/:id/documents above exactly). Either side can
// add a new version: Administrator/Staff (REQUEST_REVIEWER_ROLES) or the
// request's own submitter (Auth. Personnel/potential_partner). Reuses the
// exact same secure upload workflow and Document Library archive function
// as everywhere else — the file is stored once and linked back from the
// request, never duplicated. Ownership is always set to the requester's
// email (regardless of who actually uploaded it) so the existing
// GET /uploads/documents/:filename ownership check already lets the true
// requester and both reviewer roles open any version — no changes needed
// there. Every version is pushed, never replaced.
app.post('/api/document-requests/:id/documents', requireAuth, announce('documentRequest'), (req, res) => {
  uploadDoc.single('document')(req, res, async (err) => {
    if (err instanceof multer.MulterError) {
      const message = err.code === 'LIMIT_FILE_SIZE' ? 'File is too large. Maximum size is 10MB.' : err.message;
      return res.status(400).json({ error: message });
    }
    if (err) {
      if (!err.clientSafe) console.error('❌ Document request upload error:', err);
      return res.status(400).json({ error: err.clientSafe ? err.message : 'Upload failed. Please try again.' });
    }
    const note = (req.body.note || '').trim().slice(0, 1000);
    // File is now OPTIONAL (2026-09-19) — same rule as the Partnership
    // Request draft upload above: reject only when neither a file nor a
    // note is present.
    if (!req.file && !note) {
      return res.status(400).json({ error: 'Provide a file, a note, or both to add a new version.' });
    }
    if (req.file && !verifyMagicBytes(req.file)) {
      fs.unlink(req.file.path, () => { });
      return res.status(400).json({ error: 'Unsupported file type. Only PDF, JPG, JPEG, and PNG are accepted.' });
    }
    const id = parseInt(req.params.id);
    const actor = req.session.user;
    try {
      const db = getDb();
      const target = await db.collection('documentrequests').findOne({ id });
      if (!target) {
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(404).json({ error: 'Document request not found.' });
      }

      const isReviewer = REQUEST_REVIEWER_ROLES.includes(actor.role);
      const isOwner = target.requestedByEmail && target.requestedByEmail === actor.email;
      // College Dean (role "Auth. Personnel") can submit a Document Request and track its drafts, but does not
      // upload new versions itself — only a reviewer (Administrator/Staff) or an owning potential_partner may.
      const canUpload = isReviewer || (isOwner && actor.role === 'potential_partner');
      if (!canUpload) {
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(403).json({ error: 'You are not authorized to upload documents to this request.' });
      }
      if (DR_TERMINAL_STATUSES.includes(canonicalDrStatus(target.status))) {
        if (req.file) fs.unlink(req.file.path, () => { });
        return res.status(400).json({ error: `This document request has already been ${target.status.toLowerCase()} — no further documents can be added.` });
      }

      // Same reviewer-attribution fix as POST /api/requests/:id/documents
      // above — a reviewer's own Document Library upload must be owned by
      // the reviewer (actor), not the requester, or it never appears in the
      // reviewer's own library. A notes-only version has no file at all —
      // skip the archive step entirely rather than inventing a fake
      // filename/Document Library record for something never uploaded.
      let documentId = null, fileLink = null;
      if (req.file) {
        ({ documentId, fileLink } = await archiveToDocumentLibrary(req.file.path, req.file.originalname, {
          documentType: expandDocTypeLabel(target.documentType),
          institution: target.institution,
          partner: target.institution,
          title: `${target.documentType || 'Document'} – ${target.institution} (Doc Request #${id})`
        }, {
          uploadedBy: isReviewer ? actor.name : (target.requestedBy || 'Unknown'),
          uploadedByEmail: isReviewer ? actor.email : target.requestedByEmail,
          requestId: id,
          requestType: 'document'
        }));
      }

      const docRecord = {
        documentId, fileLink,
        originalFilename: req.file ? req.file.originalname : null,
        uploadedAt: new Date().toISOString(), uploadedBy: actor.name,
        uploadedByEmail: actor.email, uploaderRole: actor.role,
        note, fileType: req.file ? req.file.mimetype : null, fileSize: req.file ? req.file.size : 0
      };
      const setFields = { updatedAt: new Date().toISOString() };
      // A reviewer's first draft upload signals work has actually begun —
      // auto-advance Received → Preparing (recorded in statusHistory like
      // every other transition) rather than requiring a separate manual
      // status click for what just happened anyway. Notes-only counts too —
      // it's still real review progress, not just a file drop.
      const pushOps = { supportingDocuments: docRecord };
      if (canonicalDrStatus(target.status) === 'Received') {
        setFields.status = 'Preparing';
        pushOps.statusHistory = { from: target.status, to: 'Preparing', at: setFields.updatedAt, by: actor.name, byEmail: actor.email, remark: 'Auto-advanced on first draft upload' };
      }
      await db.collection('documentrequests').updateOne({ id }, { $push: pushOps, $set: setFields });
      const updated = await db.collection('documentrequests').findOne({ id });

      const fileLabel = req.file ? req.file.originalname : 'notes only';
      await logActivity(db, actor, 'EDIT',
        `Draft document uploaded for document request: ${target.institution} (${fileLabel})${note ? ' — "' + note + '"' : ''}`);

      // Reviewer uploaded → notify the requester. Requester uploaded a
      // revision → notify every reviewer, same broadcast set used for a
      // brand-new submission.
      if (isReviewer && target.requestedByEmail) {
        const requester = await db.collection('users').findOne({ email: target.requestedByEmail });
        await notifyUsers(db, [target.requestedByEmail], {
          module: 'request',
          tag: 'Document Request',
          icon: 'ri-file-upload-line',
          color: 'info',
          title: `New draft uploaded: ${target.institution}`,
          desc: req.file
            ? `${actor.name} uploaded "${req.file.originalname}" for your document request (${target.institution}).${note ? ' Note: ' + note : ''}`
            : `${actor.name} added new notes for your document request (${target.institution}).${note ? ' Note: ' + note : ''}`,
          link: drLinkForRole(requester && requester.role, id),
          downloadLink: fileLink
        });
      } else if (isOwner) {
        const reviewers = await db.collection('users').find({ role: { $in: REQUEST_REVIEWER_ROLES } }).toArray();
        await notifyReviewers(db, reviewers, {
          module: 'request',
          tag: 'Document Request',
          icon: 'ri-file-upload-line',
          color: 'info',
          title: `Revised draft uploaded: ${target.institution}`,
          desc: req.file
            ? `${actor.name} uploaded a revised draft "${req.file.originalname}" for their document request (${target.institution}).${note ? ' Note: ' + note : ''}`
            : `${actor.name} added new notes to their document request (${target.institution}).${note ? ' Note: ' + note : ''}`
        }, role => drLinkForRole(role, id));
      }

      res.json({ success: true, documentId, fileLink, request: updated });
    } catch (e) {
      console.error('❌ Document request draft upload error:', e);
      res.status(500).json({ error: 'Unable to save the uploaded document right now. Please try again.' });
    }
  });
});

// ── Document Request — printable CSPC-F-CIRL-04 form (view/print/PDF) ───────
// Administrator and Staff (full parity, 2026-08-27) may access any request;
// every other role may only access their own — same ownership rule already
// enforced on DELETE /api/document-requests/:id above.
function canAccessDocumentRequest(user, target) {
  return REQUEST_REVIEWER_ROLES.includes(user.role) || target.requestedByEmail === user.email;
}

// Shared formatting so the HTML print view and the PDFKit download show
// identical values.
function drFormFields(r) {
  const dtSource = r.submittedAt || r.date;
  const dt = dtSource ? new Date(dtSource) : null;
  const dateTimeStr = dt && !isNaN(dt)
    ? dt.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
    : (r.date || '—');
  // New records store documentTypes as a free-form array (rendered as-is,
  // one line per item). Records created before 2026-09-02 only have the
  // legacy single documentType short code (MOA/MOU/Accreditation) — expand
  // that to its full label exactly as the form always displayed it, so
  // historical requests keep printing unchanged.
  const documentItems = (Array.isArray(r.documentTypes) && r.documentTypes.length)
    ? r.documentTypes
    : (r.documentType ? [`${expandDocTypeLabel(r.documentType)} (${r.documentType})`] : []);
  const fmtDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d) ? '' : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  };
  // The official approval section only appears once the request has actually
  // reached the Approved stage (or beyond — Release/Completed) in the
  // pipeline, or its legacy Fulfilled equivalent: a Received/Preparing/
  // Awaiting for Approval/Rejected request must not display a signature for
  // a decision that hasn't (or won't) happen. Released By / Received By
  // below print unconditionally from whatever is actually on the record
  // (blank until their own stage is reached) — no gating needed there.
  const canonical = canonicalDrStatus(r.status);
  const isFulfilled = ['Approved', 'Release', 'Completed'].includes(canonical);
  return {
    dateTimeStr, documentItems, fmtDate, isFulfilled,
    approverName: isFulfilled ? DR_APPROVER_NAME : '',
    approverTitle: isFulfilled ? DR_APPROVER_TITLE : '',
    approvedDateStr: isFulfilled ? fmtDate(r.approvedAt || r.updatedAt) : ''
  };
}

app.get('/document-requests/:id/print', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('documentrequests').findOne({ id });
    if (!target) return res.status(404).send('Document request not found.');
    if (!canAccessDocumentRequest(req.session.user, target)) {
      return res.status(403).send('You are not authorized to view this document request.');
    }
    res.render('print/document_request_print', { r: target, ...drFormFields(target) });
  } catch (err) {
    res.status(500).send('Failed to render the document request form.');
  }
});

app.get('/api/document-requests/:id/pdf', requireAuth, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('documentrequests').findOne({ id });
    if (!target) return res.status(404).json({ error: 'Document request not found.' });
    if (!canAccessDocumentRequest(req.session.user, target)) {
      return res.status(403).json({ error: 'You are not authorized to download this document request.' });
    }
    renderDocumentRequestPdf(res, target);
  } catch (err) {
    console.error('❌ Document request PDF error:', err);
    res.status(500).json({ error: 'Unable to generate the document right now. Please try again.' });
  }
});

// Administrator/Auth. Personnel are scoped to their own targeted notifications
// only, the same ownership model potential_partner already used — no role sees
// a cross-user shared feed. (Product decision 2026-07-18: previously this route
// returned every notification in the collection to Administrator/Auth.
// Personnel; see docs/SYSTEM_AUDIT_2026-07-16.md for the full rationale,
// including that system-wide lifecycle alerts, which carry no targetEmail,
// are no longer visible to anyone via this route as a result.)
const OWN_SCOPE_ROLES = ['Administrator', 'Auth. Personnel', 'potential_partner', 'Staff'];

// requireAuth (not requirePersonnel) as of 2026-08-27 — administrator/
// notifications.ejs is now also rendered for Staff (/staff/notifications,
// full-parity revision) and this is the one route that page calls to load
// its list. Safe to open to any authenticated role: the query below is
// already own-scoped by targetEmail, same protection GET
// /api/notifications/mine already relies on.
app.get('/api/notifications', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('notifications')
      .find({ targetEmail: req.session.user.email })
      .sort({ id: -1 })
      .toArray();
    res.json(withNotificationHref(docs, req.session.user.role));
  } catch (err) {
    console.error('❌ Notifications list error:', err);
    res.status(500).json({ error: 'Unable to load notifications right now. Please try again.' });
  }
});

// Every role's unread badge is scoped to their own targetEmail — there is no
// role for which a system-wide count is ever the right answer here (unlike
// OWN_SCOPE_ROLES above, which gates the unrelated Document Library feature —
// a separate concern for a different resource). Historical note: before the
// 2026-07-27 notification security pass, View-Only (now Staff) fell through
// to a global count with no targetEmail filter at all, exposing every user's
// unread total in their own badge — see docs/SYSTEM_AUDIT_2026-07-16.md.
app.get('/api/notifications/unread-count', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    const count = await db.collection('notifications').countDocuments({ targetEmail: email, unread: true });
    res.json({ count });
  } catch (err) {
    res.json({ count: 0 });
  }
});

// Same query as GET /api/notifications above — kept as a separate route
// because potential_partner's frontend calls it by this name.
app.get('/api/notifications/mine', requireAuth, async (req, res) => {
  const email = req.session.user ? req.session.user.email : '';
  try {
    const db = getDb();
    const docs = await db.collection('notifications')
      .find({ targetEmail: email })
      .sort({ id: -1 })
      .toArray();
    res.json(withNotificationHref(docs, req.session.user.role));
  } catch (err) {
    console.error('❌ Notifications list error:', err);
    res.status(500).json({ error: 'Unable to load notifications right now. Please try again.' });
  }
});

// Administrator-only audit view — every notification in the collection,
// regardless of recipient, for management/auditing purposes. Deliberately a
// separate route from GET /api/notifications (which stays own-scoped even for
// Administrator, so their personal feed/badge never silently expands to
// include other users' notifications). This is also the only place system-wide
// alerts with no targetEmail (e.g. the automatic partnership lifecycle check
// below) are visible to anyone — they were never matched by any per-user query.
app.get('/api/notifications/all', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('notifications').find({}).sort({ id: -1 }).toArray();
    res.json(docs.map(d => ({ ...d, priority: isPriorityNotification(d) })));
  } catch (err) {
    console.error('❌ Notifications list error:', err);
    res.status(500).json({ error: 'Unable to load notifications right now. Please try again.' });
  }
});

// requireUploader (not requireAuth) restricts this to the four internal/
// uploading roles — Administrator, Auth. Personnel, potential_partner, and
// Staff (added 2026-08-27, View-Only → Staff migration) — all four of which
// are also in OWN_SCOPE_ROLES, so the filter below always scopes to the
// caller's own uploads. (Historical: pre-2026-07-18, this route was
// reachable unscoped by an under-restricted role, exposing every
// organization's document metadata — residual S7, Roadmap v2 Phase B1, see
// docs/SYSTEM_AUDIT_2026-07-16.md.)
app.get('/api/documents', requireUploader, async (req, res) => {
  try {
    const db = getDb();
    const filter = OWN_SCOPE_ROLES.includes(req.session.user.role)
      ? { uploadedByEmail: req.session.user.email }
      : {};
    const docs = await db.collection('documents').find(filter).toArray();
    res.json(docs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve documents' });
  }
});

// Documents uploaded by the current user only — used by the potential_partner
// Document Library so an external organization never sees another org's files.
app.get('/api/documents/mine', requireAuth, async (req, res) => {
  const email = req.session.user ? req.session.user.email : '';
  try {
    const db = getDb();
    const docs = await db.collection('documents')
      .find({ uploadedByEmail: email })
      .sort({ id: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to retrieve documents' });
  }
});

// Lets a user correct any OCR-suggested metadata (title/type/institution/etc.)
// on a document that was already auto-archived to the library.
//
// 2026-09-06 security hardening (Finding #3): Administrator keeps full
// cross-user access — this route exists specifically so Administrator can
// correct metadata on any document, not just their own. Auth. Personnel is
// restricted to documents they uploaded, mirroring the existing
// SELF_UPLOAD_ONLY_ROLES allowlist pattern used by
// GET /uploads/documents/:filename below (same idea, scoped to this
// route's own role set instead of reusing that exact constant, since this
// route's gate — requirePersonnel — is Administrator + Auth. Personnel
// only, a different role set than that route's).
const DOCUMENT_METADATA_SELF_ONLY_ROLES = ['Auth. Personnel'];
app.patch('/api/documents/:id', requirePersonnel, announce('document'), async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('documents').findOne({ id: parseInt(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Not found.' });
    if (DOCUMENT_METADATA_SELF_ONLY_ROLES.includes(req.session.user.role) && doc.uploadedByEmail !== req.session.user.email) {
      return res.status(403).json({ error: 'You can only edit metadata for documents you uploaded.' });
    }
    const updated = await updateDocument(req.params.id, req.body);
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    res.json({ success: true, document: updated });
  } catch (err) {
    console.error('❌ Document metadata update error:', err);
    res.status(500).json({ error: 'Unable to update the document right now. Please try again.' });
  }
});

// ── DOCUMENT LIBRARY — FOLDERS ────────────────────────────────────────────────
// Personal, per-owner folders (Administrator/Auth. Personnel/potential_partner
// — the same three roles the Document Library itself already supports via
// requireUploader). Every route below is ownership-checked against the
// session email; there is no cross-user folder visibility or management,
// mirroring the existing /api/documents ownership model exactly.
app.get('/api/document-folders/mine', requireUploader, async (req, res) => {
  try {
    const db = getDb();
    const folders = await db.collection('documentfolders')
      .find({ ownerEmail: req.session.user.email })
      .sort({ name: 1 })
      .toArray();
    res.json(folders);
  } catch (err) {
    console.error('❌ Document folders list error:', err);
    res.status(500).json({ error: 'Unable to load document folders right now. Please try again.' });
  }
});

app.post('/api/document-folders', requireUploader, async (req, res) => {
  const name = (req.body.name || '').trim();
  if (!name) return res.status(400).json({ error: 'Folder name is required.' });
  try {
    const db = getDb();
    const folder = await insertWithNextId(db.collection('documentfolders'), (id) => ({
      id, name, ownerEmail: req.session.user.email, archived: false,
      createdAt: new Date().toISOString()
    }));
    res.json({ success: true, folder });
  } catch (err) {
    console.error('❌ Create document folder error:', err);
    res.status(500).json({ error: 'Unable to create the folder right now. Please try again.' });
  }
});

// Rename and/or archive/unarchive a folder — either field may be sent alone.
app.patch('/api/document-folders/:id', requireUploader, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const folder = await db.collection('documentfolders').findOne({ id });
    if (!folder) return res.status(404).json({ error: 'Folder not found.' });
    if (folder.ownerEmail !== req.session.user.email) {
      return res.status(403).json({ error: 'You can only manage your own folders.' });
    }
    const updates = {};
    if (req.body.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) return res.status(400).json({ error: 'Folder name cannot be empty.' });
      updates.name = name;
    }
    if (req.body.archived !== undefined) updates.archived = !!req.body.archived;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });
    await db.collection('documentfolders').updateOne({ id }, { $set: updates });
    res.json({ success: true, folder: await db.collection('documentfolders').findOne({ id }) });
  } catch (err) {
    console.error('❌ Update document folder error:', err);
    res.status(500).json({ error: 'Unable to update the folder right now. Please try again.' });
  }
});

// Move a document into (or out of, via folderId: null) a folder, and/or
// archive/unarchive it — the two actions the Document Library needs beyond
// the existing OCR-metadata-correction route above, kept separate from it so
// that route's Administrator/Auth. Personnel-only RBAC is never touched.
app.patch('/api/documents/:id/organize', requireUploader, announce('document'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const doc = await db.collection('documents').findOne({ id });
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.uploadedByEmail !== req.session.user.email) {
      return res.status(403).json({ error: 'You can only organize your own documents.' });
    }
    const updates = {};
    if (req.body.folderId !== undefined) {
      updates.folderId = req.body.folderId === null ? null : parseInt(req.body.folderId);
    }
    if (req.body.archived !== undefined) updates.archived = !!req.body.archived;
    if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update.' });
    await db.collection('documents').updateOne({ id }, { $set: updates });
    res.json({ success: true, document: await db.collection('documents').findOne({ id }) });
  } catch (err) {
    console.error('❌ Organize document error:', err);
    res.status(500).json({ error: 'Unable to update the document right now. Please try again.' });
  }
});

// DELETE /api/documents/:id — allows an uploader or Administrator to discard a document (e.g. duplicate or unneeded upload)
app.delete('/api/documents/:id', requireUploader, announce('document'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid document id.' });
  try {
    const db = getDb();
    const doc = await db.collection('documents').findOne({ id });
    if (!doc) return res.status(404).json({ error: 'Document not found.' });
    if (doc.uploadedByEmail !== req.session.user.email && req.session.user.role !== 'Administrator') {
      return res.status(403).json({ error: 'You can only delete your own documents.' });
    }
    if (doc.fileLink && doc.fileLink.startsWith('/uploads/documents/')) {
      const filename = path.basename(doc.fileLink);
      const filePath = path.join(__dirname, 'uploads', 'documents', filename);
      fs.unlink(filePath, () => {});
    }
    await db.collection('documents').deleteOne({ id });
    res.json({ success: true, message: 'Document deleted successfully.' });
  } catch (err) {
    console.error('❌ Delete document error:', err);
    res.status(500).json({ error: 'Unable to delete the document right now. Please try again.' });
  }
});

// ── PARTNERSHIPS (Registry) ───────────────────────────────────────────────────
// Canonical schema. `inst` is the ONLY accepted institution-name field — legacy
// code used to also fall back to `institution`/`partner`, but live data is 100%
// `inst` (confirmed against the full collection), so those aliases are dropped
// rather than perpetuated. Every field the Add/Edit forms actually send is
// listed here; anything else in the request body is rejected outright rather
// than silently written to a schemaless document.
// `nature` became a 'stringArray' (2026-09-19, multi-select Nature of
// Partnership) using the exact same generic array-field mechanism `unit`
// already established — unlike `unit`, it has no closed VALID_... allow-list
// (see the 'stringArray' branch below), because unrestricted free-text values
// were already accepted for `nature` as a plain string before this change
// (e.g. pre-existing records/OCR suggestions outside the Add form's 8-option
// list) and must keep working unmodified.
const PARTNERSHIP_FIELDS = {
  inst: 'string', country: 'string', region: 'string', type: 'string', nature: 'stringArray',
  cat: 'string', unit: 'stringArray', coordinator: 'string', partnerEmail: 'string', docLink: 'string',
  start: 'string', end: 'string', status: 'string', remarks: 'string',
  startYear: 'number', endYear: 'number'
};
const REQUIRED_PARTNERSHIP_FIELDS = ['inst', 'type', 'unit', 'start', 'end'];
const VALID_PARTNERSHIP_TYPES = ['MOA', 'MOU'];
const VALID_PARTNERSHIP_CATEGORIES = ['International', 'Local'];
const VALID_PARTNERSHIP_STATUSES = ['Active', 'Expiring Soon', 'Expired'];
// Responsible Unit (Registry → Add/Edit Partnership → CSPC-CIRL Details) — 2026-11 investigation: this used
// to be a closed set hardcoded here AND separately in assets/js/pages/registry-gridjs.init.js's own
// UNIT_OPTIONS, with no way for an Administrator/Staff user to add a unit that legitimately doesn't exist
// yet without a code change. Now backed by the `responsibleunits` collection (GET/POST
// /api/responsible-units below) — this constant survives only as the one-time seed list (db.js, so every
// existing unit keeps working with zero migration) and as the final fallback if that collection is
// ever somehow empty when validPartnershipUnitNames() runs. The set itself is no longer closed in the
// "nobody can ever add to it" sense, but a save is still validated against a real, authoritative list —
// never free text, unlike Document Request's combobox.
const VALID_PARTNERSHIP_UNITS = ['CCS', 'CILS', 'CETE', 'CNAS', 'CAMS', 'CIRL'];

// The current authoritative Responsible Unit list, read fresh on every save (not cached) — a Responsible
// Unit is added rarely enough that this one extra query per partnership save is not worth the staleness
// risk of a cache that could let someone else's brand-new unit "fail to validate" for a few minutes.
async function validPartnershipUnitNames(db) {
  const units = await db.collection('responsibleunits').find({}).toArray();
  return units.length ? units.map(u => u.name) : VALID_PARTNERSHIP_UNITS.slice();
}
// Country (2026-09-22): the Registry's Add/Edit Partnership form now presents Country as a closed <select> —
// see assets/js/pages/registry-gridjs.init.js's COUNTRY_OPTIONS for that list. Deliberately NOT enforced here
// as a matching server-side enum: the existing partnership test suite (partnerships.test.js's dashboard/
// country-aggregation tests, reports.test.js, search-api.test.js, and others) has long relied on posting
// arbitrary placeholder strings ("Testland", "Jesttest Wonderland", ...) directly to this API for test
// isolation, and this app has never restricted `country` to a closed set server-side (unlike type/cat/status/
// unit, which always were closed sets). Adding one now would break that established, load-bearing test
// pattern — "do not break existing API validation" wins over retroactively closing this field. What IS
// validated below is that a submitted value is a sane string, not that it's a member of any specific list —
// the same defense-in-depth the client dropdown itself already gives normal usage.
const PARTNERSHIP_COUNTRY_MAX_LENGTH = 100;

/**
 * Builds a MongoDB-safe field set from a request body: unknown keys must
 * already have been rejected by the caller (see the `unknown fields` checks
 * below) before this runs. Every accepted field is checked against its
 * declared type — a bracket/dot-notation-injected object or array can never
 * pass the `typeof` check, so it's simply reported as a type error rather
 * than ever reaching `$set`/`insertOne`.
 */
function sanitizePartnershipFields(body, { requireCore, validUnits }) {
  // Callers that don't pass validUnits (there are none left in this file, but kept defensive for any
  // future/test caller) still get real validation, just against the seed list rather than the live DB set.
  validUnits = validUnits || VALID_PARTNERSHIP_UNITS;
  const fields = {};
  const errors = [];
  for (const [field, type] of Object.entries(PARTNERSHIP_FIELDS)) {
    const value = body[field];
    if (value === undefined) continue;
    if (type === 'string') {
      if (typeof value !== 'string') { errors.push(`${field} must be a string.`); continue; }
      const trimmed = value.trim();
      if (field === 'inst' && !trimmed) { errors.push('inst must not be empty.'); continue; }
      if (field === 'country' && trimmed.length > PARTNERSHIP_COUNTRY_MAX_LENGTH) {
        errors.push(`country must be ${PARTNERSHIP_COUNTRY_MAX_LENGTH} characters or fewer.`); continue;
      }
      fields[field] = trimmed;
    } else if (type === 'number') {
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${field} must be a number.`); continue; }
      fields[field] = value;
    } else if (type === 'stringArray') {
      // Accepts a real array (the combobox's normal shape) or, for backward
      // compatibility with any caller still sending the pre-2026-09-03
      // single-value shape, a plain string wrapped into a one-item array.
      // Always stored as an array going forward.
      const raw = Array.isArray(value) ? value : (typeof value === 'string' ? [value] : null);
      if (raw === null) { errors.push(`${field} must be a string or an array of strings.`); continue; }
      const seen = new Set();
      const cleaned = [];
      let invalid = false;
      for (const v of raw) {
        if (typeof v !== 'string') { invalid = true; break; }
        const trimmed = v.trim();
        if (!trimmed) continue;
        if (field === 'unit' && !validUnits.includes(trimmed)) { invalid = true; break; }
        const key = trimmed.toLowerCase();
        if (seen.has(key)) continue; // de-dupe silently — the UI already prevents this, this is just defense-in-depth
        seen.add(key);
        cleaned.push(trimmed);
      }
      if (invalid) {
        errors.push(field === 'unit'
          ? 'unit must only contain: ' + validUnits.join(', ')
          : `${field} must be an array of strings.`);
        continue;
      }
      fields[field] = cleaned;
    }
  }
  if (fields.type !== undefined && !VALID_PARTNERSHIP_TYPES.includes(fields.type)) {
    errors.push('type must be one of: ' + VALID_PARTNERSHIP_TYPES.join(', '));
  }
  if (fields.cat !== undefined && !VALID_PARTNERSHIP_CATEGORIES.includes(fields.cat)) {
    errors.push('cat must be one of: ' + VALID_PARTNERSHIP_CATEGORIES.join(', '));
  }
  if (fields.status !== undefined && !VALID_PARTNERSHIP_STATUSES.includes(fields.status)) {
    errors.push('status must be one of: ' + VALID_PARTNERSHIP_STATUSES.join(', '));
  }
  if (requireCore) {
    for (const field of REQUIRED_PARTNERSHIP_FIELDS) {
      const v = fields[field];
      const missing = Array.isArray(v) ? v.length === 0 : !v;
      if (missing) errors.push(`${field} is required.`);
    }
  }
  return { fields, errors };
}

// ── RESPONSIBLE UNITS (2026-11) ───────────────────────────────────────────────
// The Add/Edit Partnership form's "Responsible Unit" field used to be a closed set hardcoded in two places
// (VALID_PARTNERSHIP_UNITS above and registry-gridjs.init.js's own UNIT_OPTIONS) with no way for an
// Administrator/Staff user to add a legitimately-missing unit without a code change. Backed by its own
// collection now — same requireStaffAccess gate as /api/partnerships itself, since this field is only ever
// edited from that same Administrator/Staff-only form; no new, more permissive access was introduced.
app.get('/api/responsible-units', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const units = await db.collection('responsibleunits').find({}).sort({ name: 1 }).toArray();
    res.json(units);
  } catch (err) {
    console.error('❌ Responsible units list error:', err);
    res.status(500).json({ error: 'Unable to load responsible units right now. Please try again.' });
  }
});

const RESPONSIBLE_UNIT_MAX_LENGTH = 100;
// Letters/digits/spaces and a short list of punctuation real CSPC unit names actually use (CIRL's own full
// name has a comma-free ampersand-free style, but e.g. "College of Arts & Sciences" or "Office of the VP
// for Academic Affairs (OVPAA)" are realistic) — rejects anything that looks like markup/script content
// rather than a department name, the same spirit as filename sanitization elsewhere in this app.
const RESPONSIBLE_UNIT_NAME_RE = /^[A-Za-z0-9 .,&'()\/-]+$/;

// No announce() here deliberately — that middleware's 'partnership' topic reads body.partnership to build
// its realtime broadcast, which this response doesn't have; reusing it would publish a misleading
// partnership.updated event with no real id attached. Adding a Responsible Unit isn't a collaborative
// live-edit scenario the way a partnership record is, so no realtime event is needed for it at all.
app.post('/api/responsible-units', requireStaffAccess, async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ error: 'Unit name is required.' });
    if (name.length > RESPONSIBLE_UNIT_MAX_LENGTH) {
      return res.status(400).json({ error: `Unit name must be ${RESPONSIBLE_UNIT_MAX_LENGTH} characters or fewer.` });
    }
    if (!RESPONSIBLE_UNIT_NAME_RE.test(name)) {
      return res.status(400).json({ error: 'Unit name may only contain letters, numbers, spaces, and basic punctuation.' });
    }
    const db = getDb();
    // Case-insensitive duplicate check (buildExactCaseInsensitiveMatch/escapeRegexLiteral — the exact same
    // helpers the Custom Report Builder's Country matching already uses for this identical "same value,
    // different casing" problem) — "CIRL" existing must block "cirl", "Cirl", etc., not just an exact
    // byte-for-byte match.
    const existing = await db.collection('responsibleunits').findOne({ name: buildExactCaseInsensitiveMatch(name) });
    if (existing) return res.status(409).json({ error: `"${existing.name}" already exists as a Responsible Unit.` });

    const unit = await insertWithNextId(db.collection('responsibleunits'), (id) => (
      { id, name, createdAt: new Date().toISOString(), createdByEmail: req.session.user.email }
    ));
    res.json({ success: true, unit });
  } catch (err) {
    // A unique-index race (two simultaneous adds of the same name) surfaces as a duplicate-key error here —
    // reported as the same friendly "already exists" message a sequential duplicate gets, not a raw DB error.
    if (err && err.code === 11000) {
      return res.status(409).json({ error: 'That Responsible Unit already exists.' });
    }
    console.error('❌ Create Responsible Unit error:', err);
    res.status(500).json({ error: 'Unable to create the Responsible Unit right now. Please try again.' });
  }
});

// Registry CRUD — Administrator and Staff share full authority (2026-08-27
// full-parity revision); every other role stays read-only or unauthenticated.
//
// `sourceRequestId` (optional, 2026-09-04): set when this save is the
// completion of the "Approve a Partnership Request" flow — Approve no
// longer flips the request straight to Approved (see PATCH /api/requests/:id
// history above); instead it opens this same Add New Partnership form,
// pre-filled, and the request is only marked Approved/linked once the
// reviewer actually saves a partnership here. This keeps ONE creation path
// (this endpoint) for both a manually-added partnership and a
// request-approval conversion — no second Registry-writing code path.
app.post('/api/partnerships', requireStaffAccess, announce('partnership'), async (req, res) => {
  try {
    const { sourceRequestId, ...partnershipBody } = req.body;
    const unknown = Object.keys(partnershipBody).filter(k => !(k in PARTNERSHIP_FIELDS));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown field(s): ' + unknown.join(', ') });
    }
    const db = getDb();
    const { fields, errors } = sanitizePartnershipFields(partnershipBody, { requireCore: true, validUnits: await validPartnershipUnitNames(db) });
    if (errors.length) {
      return res.status(400).json({ error: errors.join(' ') });
    }

    // ── Approved-Request → Registry conversion ──────────────────────────────
    // Resolved before the insert so a request that was already converted
    // (a duplicate Approve click, a re-opened tab, a retry after the
    // request-side update below failed) never creates a second partnership —
    // the existing one is simply returned instead. Checked by BOTH the
    // request's own linkedPartnershipId AND a reverse lookup by
    // sourceRequestId on `partnerships`, so this stays idempotent even if a
    // previous attempt inserted the partnership but crashed before the
    // request could be updated.
    let sourceRequest = null;
    if (sourceRequestId !== undefined && sourceRequestId !== null && sourceRequestId !== '') {
      const reqId = parseInt(sourceRequestId, 10);
      sourceRequest = await db.collection('requests').findOne({ id: reqId });
      if (!sourceRequest) {
        return res.status(404).json({ error: 'Source partnership request not found.' });
      }
      let existingPartnership = null;
      if (sourceRequest.linkedPartnershipId) {
        existingPartnership = await db.collection('partnerships').findOne({ id: sourceRequest.linkedPartnershipId });
      }
      if (!existingPartnership) {
        existingPartnership = await db.collection('partnerships').findOne({ sourceRequestId: reqId });
      }
      if (existingPartnership) {
        if (sourceRequest.status !== 'Approved' || sourceRequest.linkedPartnershipId !== existingPartnership.id) {
          await db.collection('requests').updateOne(
            { id: reqId },
            { $set: { status: 'Approved', linkedPartnershipId: existingPartnership.id, decidedBy: req.session.user.name, updatedAt: new Date().toISOString() } }
          );
        }
        return res.json({ success: true, partnership: existingPartnership, alreadyConverted: true });
      }
      if (!UNDECIDED_REQUEST_STATUSES.includes(sourceRequest.status)) {
        return res.status(409).json({ error: `This request is no longer available for conversion (current status: ${sourceRequest.status}).` });
      }
    }

    // Map location (2026-09-19): resolved from the PARTNER institution +
    // country, server-side, after the duplicate-conversion check above so an
    // already-converted request never triggers a lookup. Never throws and is
    // time-bounded — a geocoding problem degrades to a country-level or
    // unresolved location, it can never fail or stall the save. Clients cannot
    // supply lat/lng/location* themselves (not in PARTNERSHIP_FIELDS).
    const location = geocoding.buildLocationUpdate(
      await geocoding.resolveLocation({ institution: fields.inst, country: fields.country })
    );

    const entry = await insertWithNextId(db.collection('partnerships'), (nextId) => {
      const candidate = { id: nextId, ...fields, ...location.set };
      if (sourceRequest) candidate.sourceRequestId = sourceRequest.id;
      return candidate;
    });
    await logActivity(db, req.session.user, 'ADD', `Partnership added: ${entry.inst || 'Record #' + entry.id} (${entry.type || ''})`);

    if (sourceRequest) {
      await db.collection('requests').updateOne(
        { id: sourceRequest.id },
        { $set: { status: 'Approved', linkedPartnershipId: entry.id, decidedBy: req.session.user.name, updatedAt: new Date().toISOString() } }
      );
      await logActivity(db, req.session.user, 'APPROVE',
        `Partnership request approved and converted to Registry: ${sourceRequest.institution} (Record #${entry.id})`);
      if (sourceRequest.submittedByEmail) {
        const submitter = await db.collection('users').findOne({ email: sourceRequest.submittedByEmail });
        await notifyUsers(db, [sourceRequest.submittedByEmail], sourceRequest.isCollegeReport
          ? {
            module: 'request',
            tag: 'College Partnership Report',
            icon: 'ri-checkbox-circle-line',
            color: 'success',
            title: `Partnership recorded by CIRL: ${sourceRequest.institution}`,
            desc: `CIRL recorded your college's ${sourceRequest.type || 'agreement'} with ${sourceRequest.institution} in the Partnership Registry.`,
            link: prLinkForRole(submitter && submitter.role, sourceRequest.id)
          }
          : {
            module: 'request',
            tag: sourceRequest.isRenewal ? 'Renewal Request' : 'Partnership Request',
            icon: 'ri-checkbox-circle-line',
            color: 'success',
            title: `Partnership Request Approved: ${sourceRequest.institution}`,
            desc: `Your partnership request for ${sourceRequest.institution} has been approved and added to the Partnership Registry.`,
            link: prLinkForRole(submitter && submitter.role, sourceRequest.id)
          });
      }
    }

    res.json({ success: true, partnership: entry });
  } catch (err) {
    console.error('❌ Partnership create error:', err);
    res.status(500).json({ error: 'Unable to create the partnership right now. Please try again.' });
  }
});

app.patch('/api/partnerships/:id', requireStaffAccess, announce('partnership', { prior: priorPartnership }), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const unknown = Object.keys(req.body).filter(k => !(k in PARTNERSHIP_FIELDS));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown field(s): ' + unknown.join(', ') });
    }
    const db = getDb();
    const { fields, errors } = sanitizePartnershipFields(req.body, { requireCore: false, validUnits: await validPartnershipUnitNames(db) });
    if (errors.length) {
      return res.status(400).json({ error: errors.join(' ') });
    }
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }

    const existing = await db.collection('partnerships').findOne({ id });
    if (!existing) return res.status(404).json({ error: 'Not found.' });

    // Re-evaluate the map location ONLY when the institution or country
    // actually changed (see resolveForUpdate) — so an edit never leaves
    // coordinates that belong to the previous institution/country, while any
    // other edit leaves the record's existing location (legacy included)
    // exactly as it was.
    const location = await geocoding.resolveForUpdate(existing, fields);
    const update = { $set: { ...fields, ...(location ? location.set : {}) } };
    if (location && location.unset.length) {
      update.$unset = Object.fromEntries(location.unset.map(k => [k, '']));
    }
    await db.collection('partnerships').updateOne({ id }, update);
    const updated = await db.collection('partnerships').findOne({ id });
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    await logActivity(db, req.session.user, 'EDIT', `Partnership updated: ${updated.inst || 'Record #' + id} (${updated.type || ''})`);
    res.json({ success: true, partnership: updated });
  } catch (err) {
    console.error('❌ Partnership update error:', err);
    res.status(500).json({ error: 'Unable to update the partnership right now. Please try again.' });
  }
});

// Map-location preview for the Add/Edit Partnership form: tells the person
// what location a save would produce (exact / approximate / unresolved)
// BEFORE they save. Read-only — writes nothing to partnerships — and uses the
// exact same resolver (and cache) as the save itself, so the preview and the
// saved result agree. Administrator + Staff only, like the routes it serves.
// Callers must invoke this on commit (institution picked / field left), not
// per keystroke — the provider's usage policy forbids autocomplete-style use.
app.post('/api/geocode/preview', requireStaffAccess, geocodePreviewLimiter, async (req, res) => {
  const body = req.body || {};
  const institution = typeof body.institution === 'string' ? body.institution.trim().slice(0, 200) : '';
  const country = typeof body.country === 'string' ? body.country.trim().slice(0, 100) : '';
  const location = await geocoding.resolveLocation({ institution, country });
  res.json(geocoding.toPublicLocation(location));
});

app.delete('/api/partnerships/:id', requireStaffAccess, announce('partnership', { prior: priorPartnership }), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const target = await db.collection('partnerships').findOne({ id });
    await db.collection('partnerships').deleteOne({ id });
    await logActivity(db, req.session.user, 'DELETE', `Partnership deleted: ${target ? (target.inst || 'Record #' + id) : 'Record #' + id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Partnership delete error:', err);
    res.status(500).json({ error: 'Unable to delete the partnership right now. Please try again.' });
  }
});

// ── PARTNERSHIP STATS (for Reports DSS) ──────────────────────────────────────
app.get('/api/partnerships/stats', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const all = await db.collection('partnerships').find({}).toArray();
    // Recompute status live from each record's own end date — the same
    // authoritative computeStatusFromEnd() the Reports & Analytics engine
    // uses — rather than trusting the stored `status` field, which is only
    // refreshed by the hourly lifecycle job and can be stale by up to an
    // hour. Without this, the Reports page's own quick-export cards (Active
    // Partnerships List, Expiring Soon List, etc.) could show a live count
    // here that disagreed with what clicking that same card's PDF/Excel
    // button actually exports.
    all.forEach(p => {
      const calcStatus = computeStatusFromEnd(p.end);
      if (calcStatus) p.status = calcStatus;
    });
    const total = all.length;
    const active = all.filter(p => p.status === 'Active').length;
    const expiring = all.filter(p => p.status === 'Expiring Soon').length;
    const expired = all.filter(p => p.status === 'Expired').length;
    const byType = {};
    const byRegion = {};
    const byUnit = {};
    const byInstitutionCounts = {};
    const byCountryCounts = {};
    all.forEach(p => {
      byType[p.type] = (byType[p.type] || 0) + 1;
      byRegion[p.region] = (byRegion[p.region] || 0) + 1;
      // unit is an array on records created since the 2026-09-03 multi-unit
      // combobox (legacy records still hold a single string) — a partnership
      // with multiple responsible units counts toward each unit's tally.
      const units = Array.isArray(p.unit) ? p.unit : (p.unit ? [p.unit] : []);
      units.forEach(u => { byUnit[u] = (byUnit[u] || 0) + 1; });
      if (p.inst) byInstitutionCounts[p.inst] = (byInstitutionCounts[p.inst] || 0) + 1;
      // A blank/whitespace-only country is excluded entirely — same
      // "skip rather than fabricate a bucket" handling byInstitution already
      // uses for a missing `inst` — so the Dashboard's "Partnership by
      // Country" widget's percentages are always of records that actually
      // name a country, never silently diluted by an "Unspecified" slice.
      const country = (typeof p.country === 'string' ? p.country : '').trim();
      if (country) byCountryCounts[country] = (byCountryCounts[country] || 0) + 1;
    });
    // Top 8 institutions by count — an institution-by-institution breakdown can
    // have far more distinct values than the small, fixed set of CSPC units, so
    // this caps the chart the same way "Top Partner Countries" already does.
    const byInstitution = Object.fromEntries(
      Object.entries(byInstitutionCounts).sort((a, b) => b[1] - a[1]).slice(0, 8)
    );
    // byCountry is intentionally NOT capped (unlike byInstitution above) — the
    // Dashboard's "Partnership by Country" widget shows a percentage
    // distribution, which is only meaningful if it accounts for every country
    // on record; a small set of distinct countries is expected here anyway
    // (unlike the much larger, uncapped set of partner institutions).
    const byCountry = Object.fromEntries(
      Object.entries(byCountryCounts).sort((a, b) => b[1] - a[1])
    );
    res.json({ total, active, expiring, expired, byType, byRegion, byUnit, byInstitution, byCountry });
  } catch (err) {
    console.error('❌ Partnership stats error:', err);
    res.status(500).json({ error: 'Unable to load partnership statistics right now. Please try again.' });
  }
});

// ── REPORT EXPORTS (real PDF/Excel generation) ────────────────────────────────

function safeFilename(title) {
  return title.replace(/[^a-z0-9]+/gi, '_').replace(/^_+|_+$/g, '') || 'report';
}

// Only these five fields are ever filterable, and only as plain equality
// matches on a plain string. Express's query parser turns bracket/dot-notation
// input (e.g. ?status[$ne]=Approved, ?cat[$in][]=A) into a nested object or
// array rather than a string, so requiring `typeof value === 'string'` rejects
// every MongoDB-operator-injection shape in one check — there's no pattern to
// blacklist, because anything that isn't a plain string for an allowlisted key
// is simply never looked at. Unknown field names (not in this list) are
// likewise never read from `query` at all, injection-shaped or not.
const PARTNERSHIP_FILTER_FIELDS = ['status', 'type', 'cat', 'region', 'unit'];

function buildPartnershipFilter(query) {
  const filter = {};
  for (const field of PARTNERSHIP_FILTER_FIELDS) {
    const value = query[field];
    if (typeof value === 'string' && value.length > 0) {
      filter[field] = value;
    }
  }
  return filter;
}

/**
 * Parses a date input into a Date object representing the beginning or end of
 * that calendar day in local time, avoiding UTC timestamp shifts.
 * Handles bare "YYYY-MM-DD" date strings, Date instances, and formatted
 * display strings (e.g. "Sep 26, 2023" or "September 26, 2023").
 */
function parseLocalDate(input, isEndOfDay = false) {
  if (!input) return null;
  if (input instanceof Date) {
    if (isNaN(input.getTime())) return null;
    return isEndOfDay
      ? new Date(input.getFullYear(), input.getMonth(), input.getDate(), 23, 59, 59, 999)
      : new Date(input.getFullYear(), input.getMonth(), input.getDate(), 0, 0, 0, 0);
  }
  const str = String(input).trim();
  const isoMatch = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (isoMatch) {
    const y = parseInt(isoMatch[1], 10);
    const m = parseInt(isoMatch[2], 10) - 1;
    const d = parseInt(isoMatch[3], 10);
    return isEndOfDay
      ? new Date(y, m, d, 23, 59, 59, 999)
      : new Date(y, m, d, 0, 0, 0, 0);
  }
  const parsed = new Date(str);
  if (isNaN(parsed.getTime())) return null;
  return isEndOfDay
    ? new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 23, 59, 59, 999)
    : new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate(), 0, 0, 0, 0);
}

/**
 * Returns the relevant partnership date string for filtering purposes.
 * For expiration-centric report types / statuses (e.g. 'Expired Partnerships',
 * 'Expired List', 'Expiration', 'Expiring Soon'), the expiration date (end) is the primary relevant date.
 * For all other reports (e.g. 'Active Partnerships', 'Summary', etc.), the
 * date of signing/establishment (start) is the authoritative relevant date.
 * Falls back to the other date field if the primary is missing.
 */
function getRelevantPartnershipDate(doc, options = {}) {
  const reportType = options.reportType || '';
  const status = options.status || '';
  const isExpiryCentric = [
    'Expired Partnerships', 'Expired List', 'Expiration', 'Expiring Soon'
  ].includes(reportType) || ['Expired', 'Expiring Soon'].includes(status);

  if (isExpiryCentric) {
    return doc.end || doc.endDate || doc.start || doc.startDate || null;
  }
  return doc.start || doc.startDate || doc.end || doc.endDate || null;
}

/**
 * Custom Report Builder Date Range Filter:
 * Strict inclusive boundary filtering on the partnership's relevant date.
 *
 * 1. Date From only:
 *    - Include only partnerships whose relevant date falls ON or AFTER Date From (>= dateFrom).
 *    - Exclude anything before Date From.
 * 2. Date To only:
 *    - Include only partnerships whose relevant date falls ON or BEFORE Date To (<= dateTo).
 *    - Exclude anything after Date To.
 * 3. Date From + Date To:
 *    - Include ONLY partnerships whose relevant date falls between Date From and Date To, inclusive.
 *    - Exclude anything before Date From or after Date To.
 *
 * Boundaries are inclusive. Local calendar date semantics are strictly preserved.
 */
function filterByDateRange(docs, dateFrom, dateTo, options = {}) {
  if (!dateFrom && !dateTo) return docs;
  const from = dateFrom ? parseLocalDate(dateFrom, false) : null;
  const to = dateTo ? parseLocalDate(dateTo, true) : null;

  return docs.filter(d => {
    const rawDate = getRelevantPartnershipDate(d, options);
    if (!rawDate) return false;
    const targetDate = parseLocalDate(rawDate, false);
    if (!targetDate) return false;

    if (from && targetDate < from) return false;
    if (to && targetDate > to) return false;
    return true;
  });
}

// Mid-Year/Yearly Output Report ONLY — unlike filterByDateRange() above
// (deliberately an overlap filter: a partnership whose [start,end] range
// merely touches the window is included, correct for "what was active during
// X"), these two reports need "what was actually established/signed during
// X", so this checks only the partnership's own signing date (`start` — the
// same authoritative field Target Tracker's computeTargetAccomplishment()
// already uses for identical "was this partnership established in period Y"
// semantics). Using the overlap filter here was the bug: any still-active
// multi-year partnership signed long before the report's window overlaps
// every year in between and would otherwise leak into every Mid-Year/Yearly
// report for as long as it stays active.
function filterByStartDateInRange(docs, from, to) {
  return docs.filter(d => {
    const start = new Date(d.start);
    if (isNaN(start)) return false;
    return start >= from && start <= to;
  });
}

/**
 * Streams a simple paginated table as a landscape PDF — shared by every
 * PDF export route so pagination/header drawing isn't duplicated per report.
 */
function renderTablePdf(res, { title, filename, subtitle, columns, rows }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4', layout: 'landscape' });
  // A mid-stream failure (PDFKit internal error, or the client disconnecting
  // before the download finishes) fires as an 'error' event on these streams,
  // not a thrown exception — uncaught, that crashes the process. Closes S14
  // (Roadmap v2 Phase G5, docs/SYSTEM_AUDIT_2026-07-16.md).
  doc.on('error', (err) => {
    console.error('❌ PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => {
    console.error('❌ PDF response stream error:', err);
  });
  // A client disconnecting mid-download fires 'close' on the response, not
  // 'error' — confirmed empirically during this fix's own verification (a
  // throttled-then-aborted curl download produced no 'error' event, only
  // 'close'). writableEnded is false only when the stream was cut off before
  // res.end() was reached normally.
  res.on('close', () => {
    if (!res.writableEnded) console.error('❌ PDF download interrupted (client disconnected before completion)');
  });
  doc.pipe(res);

  // ── Full CSPC-CIRL Letterhead (matching the official template design) ──
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const cspcLogoPath = path.join(__dirname, 'public', 'images', 'cspc.PNG');
  const pqaLogoPath = path.join(__dirname, 'public', 'images', 'PQA.JPG');
  const tuvLogoPath = path.join(__dirname, 'public', 'images', 'TUV.png');
  const qsLogoPath = path.join(__dirname, 'public', 'images', 'QS.png');
  const LOGO_SIZE = 50;
  const headerTop = doc.page.margins.top;
  // Left: CSPC logo only
  try { doc.image(cspcLogoPath, left, headerTop, { width: LOGO_SIZE, height: LOGO_SIZE }); } catch (e) { /* optional */ }
  // Right: PQA, TUV, QS accreditation logos
  const rightLogoSize = 50;
  const rightLogoX = right - (rightLogoSize * 3 + 8);
  try { doc.image(pqaLogoPath, rightLogoX, headerTop + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
  try { doc.image(tuvLogoPath, rightLogoX + rightLogoSize + 4, headerTop + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
  try { doc.image(qsLogoPath, rightLogoX + (rightLogoSize + 4) * 2, headerTop + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
  // Center text block
  const centerX = left + LOGO_SIZE + 8;
  const centerW = rightLogoX - centerX - 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
    .text('CAMARINES SUR POLYTECHNIC COLLEGES', centerX, headerTop, { width: centerW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5)
    .text('Nabua, Camarines Sur', centerX, doc.y, { width: centerW, align: 'center' });
  doc.font('Helvetica').fontSize(8)
    .text('Telephone No. (054) 288-4421 to 23 local 206', centerX, doc.y, { width: centerW, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#0a58ca')
    .text('cspcinternational@cspc.edu.ph', centerX, doc.y, { width: centerW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
    .text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', centerX, doc.y, { width: centerW, align: 'center' });
  doc.y = Math.max(doc.y, headerTop + LOGO_SIZE) + 6;
  // Blue underline separator
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.moveDown(0.6);

  doc.fontSize(14).font('Helvetica-Bold').fillColor('#000').text(title, { align: 'center' });
  doc.moveDown(0.3);
  doc.fontSize(9).font('Helvetica').fillColor('#666')
    .text(subtitle, { align: 'center' });
  doc.moveDown(0.8);
  doc.fillColor('#000');

  const startX = doc.page.margins.left;
  let y = doc.y;

  function drawHeader() {
    let x = startX;
    doc.font('Helvetica-Bold').fontSize(9);
    columns.forEach(col => {
      doc.text(col.label, x, y, { width: col.width, lineBreak: false, ellipsis: true });
      x += col.width;
    });
    y += 16;
    doc.moveTo(startX, y - 4).lineTo(x, y - 4).strokeColor('#cccccc').stroke();
  }

  drawHeader();
  doc.font('Helvetica').fontSize(8.5);

  if (!rows.length) {
    doc.text('No records match this report.', startX, y + 4);
  }

  rows.forEach(row => {
    if (y > doc.page.height - doc.page.margins.bottom - 20) {
      doc.addPage();
      y = doc.page.margins.top;
      drawHeader();
      doc.font('Helvetica').fontSize(8.5);
    }
    let x = startX;
    columns.forEach(col => {
      const val = String(row[col.key] == null || row[col.key] === '' ? '—' : row[col.key]);
      doc.text(val, x, y, { width: col.width - 5, lineBreak: false, ellipsis: true });
      x += col.width;
    });
    y += 16;
  });

  doc.end();
}

/**
 * Streams the official CSPC-F-CIRL-04 "Documents Request Form" as a portrait
 * PDF, mirroring views/print/document_request_print.ejs field-for-field so
 * the browser print view and the downloaded PDF never drift apart.
 */
function renderDocumentRequestPdf(res, r) {
  const filename = `Document_Request_${r.id}`;
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}.pdf"`);

  const doc = new PDFDocument({ margin: 40, size: 'A4' });
  doc.on('error', (err) => {
    console.error('❌ Document Request PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => console.error('❌ Document Request PDF response stream error:', err));
  doc.pipe(res);

  const { dateTimeStr, documentItems, fmtDate, isFulfilled, approverName, approverTitle, approvedDateStr } = drFormFields(r);
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const cspcLogoPath2 = path.join(__dirname, 'public', 'images', 'cspc.PNG');

  // ── Full CSPC Letterhead ──
  const DR_LOGO_SIZE = 50;
  let headerTop = doc.y;
  // Left: CSPC logo only
  try { doc.image(cspcLogoPath2, left, headerTop, { width: DR_LOGO_SIZE, height: DR_LOGO_SIZE }); } catch (e) { /* optional */ }
  // Right: PQA, TUV, QS accreditation logos
  const drRightLogoSize = 30;
  const drRightLogoX = right - (drRightLogoSize * 3 + 8);
  try { doc.image(pqaLogoPath2, drRightLogoX, headerTop + 10, { width: drRightLogoSize, height: drRightLogoSize }); } catch (e) { /* optional */ }
  try { doc.image(tuvLogoPath2, drRightLogoX + drRightLogoSize + 4, headerTop + 10, { width: drRightLogoSize, height: drRightLogoSize }); } catch (e) { /* optional */ }
  try { doc.image(qsLogoPath2, drRightLogoX + (drRightLogoSize + 4) * 2, headerTop + 10, { width: drRightLogoSize, height: drRightLogoSize }); } catch (e) { /* optional */ }
  doc.font('Helvetica-Bold').fontSize(8).fillColor('#0a58ca').text('CSPC-F-CIRL-04', right - 100, headerTop, { width: 100, align: 'right' });
  // Center text block
  const drCenterX = left + DR_LOGO_SIZE + 8;
  const drCenterW = drRightLogoX - drCenterX - 8;
  doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
    .text('CAMARINES SUR POLYTECHNIC COLLEGES', drCenterX, headerTop, { width: drCenterW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5)
    .text('Nabua, Camarines Sur', drCenterX, doc.y, { width: drCenterW, align: 'center' });
  doc.font('Helvetica').fontSize(8)
    .text('Telephone No. (054) 288-4421 to 23 local 206', drCenterX, doc.y, { width: drCenterW, align: 'center' });
  doc.font('Helvetica').fontSize(8).fillColor('#0a58ca')
    .text('cspcinternational@cspc.edu.ph', drCenterX, doc.y, { width: drCenterW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
    .text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', drCenterX, doc.y, { width: drCenterW, align: 'center' });
  doc.fillColor('#000');

  doc.y = Math.max(doc.y, headerTop + DR_LOGO_SIZE) + 8;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(13).text('DOCUMENTS REQUEST FORM', left, doc.y, { width: contentWidth, align: 'center' });
  doc.moveDown(0.8);

  // ── Form table ──
  const labelW = 190;
  const valueW = contentWidth - labelW;
  let y = doc.y;

  function row(label, renderValue, height) {
    const rowTop = y;
    doc.rect(left, rowTop, labelW, height).stroke();
    doc.rect(left + labelW, rowTop, valueW, height).stroke();
    doc.font('Helvetica-Bold').fontSize(9.5).text(label, left + 6, rowTop + 6, { width: labelW - 12 });
    doc.font('Helvetica').fontSize(9.5);
    renderValue(left + labelW + 8, rowTop + 6, valueW - 16);
    y = rowTop + height;
  }

  // A plain-text row grows with its value (never shorter than `minHeight`, the
  // height the form has always used). Fixed-height boxes let a long institution
  // name, purpose or e-mail wrap past the bottom border and print over the next
  // row — the same measured-height approach the document list row below uses.
  const textRow = (label, value, minHeight) => {
    const v = String(value == null || value === '' ? '—' : value);
    doc.font('Helvetica').fontSize(9.5);
    const height = Math.max(minHeight, doc.heightOfString(v, { width: valueW - 16 }) + 12);
    row(label, (x, top, w) => doc.text(v, x, top, { width: w }), height);
  };

  textRow('Name of Requestor', r.requestedBy, 26);
  textRow('Office / College / Institution', r.institution, 26);
  textRow('Date / Time Submitted', dateTimeStr, 26);
  textRow('Contact No.', r.contactNumber, 26);

  // Document list can hold any number of free-form entries, some quite long,
  // so its row height (and each line's vertical position) is measured with
  // doc.heightOfString rather than assumed — a fixed-height row would let
  // wrapped/long items overlap the next row.
  doc.font('Helvetica').fontSize(9.5);
  const docItemLabels = documentItems.length > 1
    ? documentItems.map((item, i) => `${i + 1}. ${item}`)
    : [documentItems[0] || '—'];
  let docItemsHeight = 12;
  docItemLabels.forEach(label => { docItemsHeight += doc.heightOfString(label, { width: valueW - 16 }) + 3; });
  docItemsHeight = Math.max(40, docItemsHeight);
  row('Document/s to be Requested', (x, top, w) => {
    let cy = top;
    docItemLabels.forEach(label => {
      doc.text(label, x, cy, { width: w });
      cy += doc.heightOfString(label, { width: w }) + 3;
    });
  }, docItemsHeight);

  textRow('Purpose', r.notes, 48);
  row('Document Form', (x, top) => {
    const printedChecked = r.documentForm === 'Printed Copy';
    const digitalChecked = r.documentForm === 'Digital Copy';
    doc.rect(x, top + 1, 10, 10).stroke();
    if (printedChecked) doc.fontSize(8).text('X', x + 1.5, top + 1.5);
    doc.fontSize(9.5).text('Printed Copy', x + 16, top);
    const digitalX = x + 130;
    doc.rect(digitalX, top + 1, 10, 10).stroke();
    if (digitalChecked) doc.fontSize(8).text('X', digitalX + 1.5, top + 1.5);
    doc.fontSize(9.5).text('Digital Copy', digitalX + 16, top);
  }, 26);
  textRow('Email Address', r.requestedByEmail, 26);

  doc.y = y + 30;

  // ── Signature block ── Approved By is the fixed CIRL Head signatory
  // (never the processing Staff/Administrator); Released By/Received By are
  // populated dynamically from the actual fulfillment (see the PATCH
  // handler above) and only appear once the request is truly Fulfilled.
  const colW = contentWidth / 3;
  const sigCols = [
    { label: 'Approved By:', name: approverName, sub: approverTitle, date: approvedDateStr },
    { label: 'Released By:', name: r.releasedBy, date: fmtDate(r.releasedAt) },
    { label: 'Received By:', name: r.receivedBy, date: fmtDate(r.receivedAt) }
  ];
  // Layout per column (mirrors the browser print view): label, the signatory's
  // NAME sitting on the signature line, the signatory's TITLE under the line, then
  // the DATE under the title. The title used to be drawn at the same height as the
  // line and the DATE, so the Approver's two-line title ("Head, Center for
  // International Relations and Linkages") was struck through by the line and
  // printed on top of "DATE:". The name is kept on one line (shrunk, then
  // truncated, if it would not fit) so it can never wrap down onto the line.
  const sigTop = doc.y;
  const sigW = colW - 20;
  const sigLineY = sigTop + 50;
  sigCols.forEach((col, i) => {
    const x = left + i * colW;
    doc.font('Helvetica').fontSize(9).text(col.label, x, sigTop, { width: sigW });

    let name = col.name || ' ';
    let nameSize = 10;
    doc.font('Helvetica-Bold');
    while (nameSize > 7 && doc.fontSize(nameSize).widthOfString(name) > sigW) nameSize -= 0.5;
    doc.fontSize(nameSize);
    while (name.length > 1 && doc.widthOfString(name) > sigW) name = name.slice(0, -2) + '…';
    doc.text(name, x, sigTop + 34 + (10 - nameSize), { width: sigW, align: 'center', lineBreak: false });

    doc.moveTo(x, sigLineY).lineTo(x + sigW, sigLineY).stroke();

    let dateY = sigTop + 54;
    if (col.sub) {
      doc.font('Helvetica').fontSize(7.5).text(col.sub, x, sigLineY + 3, { width: sigW, align: 'center' });
      dateY = doc.y + 3;
    }
    doc.font('Helvetica').fontSize(8).text('DATE: ' + (col.date || ''), x, dateY, { width: sigW, align: 'center' });
  });

  // ── Footer ──
  const footerY = doc.page.height - doc.page.margins.bottom - 30;
  doc.moveTo(left, footerY).lineTo(right, footerY).lineWidth(2).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.font('Helvetica').fontSize(8).fillColor('#000')
    .text('Effectivity Date: February 2023', left, footerY + 6, { width: contentWidth / 3 })
    .text('Rev. 1', left + contentWidth / 3, footerY + 6, { width: contentWidth / 3, align: 'center' })
    .text('Page 1 of 1', left + (2 * contentWidth) / 3, footerY + 6, { width: contentWidth / 3, align: 'right' });

  doc.end();
}

const PARTNERSHIP_COLUMNS = [
  { key: 'inst', label: 'Institution', width: 150 },
  { key: 'country', label: 'Country', width: 85 },
  { key: 'type', label: 'Type', width: 40 },
  { key: 'cat', label: 'Category', width: 75 },
  { key: 'unit', label: 'Unit', width: 45 },
  { key: 'start', label: 'Start', width: 70 },
  { key: 'end', label: 'End', width: 70 },
  { key: 'status', label: 'Status', width: 80 }
];

// Columns actually printed in the official-style report — Category is dropped
// here because records are already grouped by Category (see groupPartnershipDocs
// below), so repeating it in every row would be redundant.
// Primary Custom Report PDF/Excel template — column structure mirrors the
// official CIRL "List of Active International Partners" reference document
// (No. | Name of Schools | Address/Country | Date of Signing | Date of
// Expiration) exactly; only the structure is templated — every value below
// is read live from the partnerships collection, nothing is hardcoded.
const PARTNERSHIP_REPORT_COLUMNS = [
  { key: 'inst', label: 'Name of Schools/Institutions', width: 180 },
  { key: 'country', label: 'Address/Country', width: 170 },
  { key: 'start', label: 'Date of Signing', width: 70 },
  { key: 'end', label: 'Date of Expiration', width: 75 }
];
const PARTNERSHIP_REPORT_NO_COL_WIDTH = 28;

/**
 * Groups partnership docs by Category (International/Local/etc.) for the
 * report's section headers — but only when the export actually spans more
 * than one category. A `cat` filter already narrows the export to a single
 * category, so grouping in that case would just produce one redundant
 * section header; skip it and print a flat list instead.
 */
function groupPartnershipDocs(docs) {
  const cats = [...new Set(docs.map(d => d.cat || 'Uncategorized'))];
  if (cats.length <= 1) return [{ label: null, docs }];
  const order = ['International', 'Local'];
  cats.sort((a, b) => {
    const ai = order.indexOf(a), bi = order.indexOf(b);
    if (ai === -1 && bi === -1) return a.localeCompare(b);
    if (ai === -1) return 1;
    if (bi === -1) return -1;
    return ai - bi;
  });
  return cats.map(cat => ({ label: cat, docs: docs.filter(d => (d.cat || 'Uncategorized') === cat) }));
}

/**
 * Renders the official-style "Partnership Registry Report" PDF: CIRL
 * letterhead, report period/generation meta, a summary strip, records grouped
 * by Category with shaded group headers and alternating row bands, repeating
 * column headers across pages (buffered so "Page X of Y" can be written once
 * the true page count is known), and a Prepared/Reviewed/Approved By
 * signature block after the last row.
 */
function renderPartnershipReportPdf(res, { title, docs, periodLabel, generatedBy, customReportData }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(title)}.pdf"`);

  const doc = new PDFDocument({ margin: 36, size: 'A4', bufferPages: true });
  doc.on('error', (err) => {
    console.error('❌ Partnership report PDF generation error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => console.error('❌ Partnership report PDF response stream error:', err));
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const now = new Date();
  const generatedStr = now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  // Logo paths for the full letterhead
  const cspcLogoPath = path.join(__dirname, 'public', 'images', 'cspc.PNG');
  const pqaLogoPath = path.join(__dirname, 'public', 'images', 'PQA.JPG');
  const tuvLogoPath = path.join(__dirname, 'public', 'images', 'TUV.png');
  const qsLogoPath = path.join(__dirname, 'public', 'images', 'QS.png');

  function drawLetterhead() {
    const top = doc.page.margins.top;
    doc.y = top;
    const LOGO_SIZE = 50;
    // Left: CSPC logo only
    try { doc.image(cspcLogoPath, left, top, { width: LOGO_SIZE, height: LOGO_SIZE }); } catch (e) { /* optional */ }
    // Right: PQA, TUV, QS accreditation logos
    const rightLogoSize = 30;
    const rightLogoX = right - (rightLogoSize * 3 + 8);
    try { doc.image(pqaLogoPath, rightLogoX, top + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
    try { doc.image(tuvLogoPath, rightLogoX + rightLogoSize + 4, top + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
    try { doc.image(qsLogoPath, rightLogoX + (rightLogoSize + 4) * 2, top + 10, { width: rightLogoSize, height: rightLogoSize }); } catch (e) { /* optional */ }
    // Center text block
    const centerX = left + LOGO_SIZE + 8;
    const centerW = rightLogoX - centerX - 8;
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
      .text('CAMARINES SUR POLYTECHNIC COLLEGES', centerX, top, { width: centerW, align: 'center' });
    doc.font('Helvetica').fontSize(8.5)
      .text('Nabua, Camarines Sur', centerX, doc.y, { width: centerW, align: 'center' });
    doc.font('Helvetica').fontSize(8)
      .text('Telephone No. (054) 288-4421 to 23 local 206', centerX, doc.y, { width: centerW, align: 'center' });
    doc.font('Helvetica').fontSize(8).fillColor('#0a58ca')
      .text('cspcinternational@cspc.edu.ph', centerX, doc.y, { width: centerW, align: 'center' });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#000')
      .text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', centerX, doc.y, { width: centerW, align: 'center' });
    doc.y = Math.max(doc.y, top + LOGO_SIZE) + 6;
    // Blue separator line
    doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
    doc.lineWidth(1).strokeColor('#000');
    doc.moveDown(0.7);

    doc.font('Helvetica-Bold').fontSize(15).text(title.toUpperCase(), left, doc.y, { width: contentWidth, align: 'center' });
    doc.moveDown(0.4);

    doc.font('Helvetica').fontSize(9).fillColor('#444')
      .text(periodLabel, left, doc.y, { width: contentWidth, align: 'center' })
      .text(`Generated ${generatedStr} by ${generatedBy}`, left, doc.y, { width: contentWidth, align: 'center' });
    doc.fillColor('#000');
    doc.moveDown(0.8);
  }

  const colStartX = left + PARTNERSHIP_REPORT_NO_COL_WIDTH;
  function drawColumnHeader() {
    const y = doc.y;
    doc.rect(left, y, contentWidth, 18).fillAndStroke('#0a58ca', '#0a58ca');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff');
    doc.text('No.', left + 4, y + 5, { width: PARTNERSHIP_REPORT_NO_COL_WIDTH - 8, lineBreak: false });
    let x = colStartX;
    PARTNERSHIP_REPORT_COLUMNS.forEach(col => {
      doc.text(col.label, x + 4, y + 5, { width: col.width - 8, lineBreak: false });
      x += col.width;
    });
    doc.fillColor('#000');
    doc.y = y + 18;
  }

  function drawGroupHeader(label, count) {
    const y = doc.y;
    doc.rect(left, y, contentWidth, 16).fillAndStroke('#dbe6fb', '#c9d6ea');
    doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#0a3d91')
      .text(`${label} (${count})`, left + 6, y + 4, { width: contentWidth - 12 });
    doc.fillColor('#000');
    doc.y = y + 16;
  }

  function ensureSpace(neededHeight) {
    if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      doc.y = doc.page.margins.top;
      drawColumnHeader();
    }
  }

  drawLetterhead();

  // Grouped reports (Group By / legacy "By [Dimension]" reportTypes, e.g. the
  // "Partnership by Country" fixed tile) render the SAME comparisonData
  // computed by computeCustomReportData — never a second, PDF-only
  // calculation — as a Group/Count/% table instead of the flat per-record
  // list below, exactly mirroring what Preview already shows for this same
  // report data.
  if (customReportData && customReportData.isComparison) {
    const rows = customReportData.comparisonData || [];
    const metrics = customReportData.metrics || [];
    const colWidth = contentWidth / metrics.length;

    function drawGroupedHeader() {
      const y = doc.y;
      doc.rect(left, y, contentWidth, 18).fillAndStroke('#0a58ca', '#0a58ca');
      doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff');
      metrics.forEach((label, i) => {
        doc.text(label, left + i * colWidth + 4, y + 5, { width: colWidth - 8, lineBreak: false });
      });
      doc.fillColor('#000');
      doc.y = y + 18;
    }

    function ensureGroupedSpace(neededHeight) {
      if (doc.y + neededHeight > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        drawGroupedHeader();
      }
    }

    drawGroupedHeader();
    doc.font('Helvetica').fontSize(8.5);
    if (!rows.length) {
      ensureGroupedSpace(16);
      doc.font('Helvetica-Oblique').fillColor('#888')
        .text('No records found matching the selected filters.', left + 6, doc.y + 3, { width: contentWidth - 12 });
      doc.fillColor('#000');
      doc.y += 16;
    } else {
      rows.forEach((row, idx) => {
        ensureGroupedSpace(16);
        const y = doc.y;
        if (idx % 2 === 1) doc.rect(left, y, contentWidth, 16).fillAndStroke('#f5f7fa', '#f5f7fa');
        doc.strokeColor('#e3e6eb').rect(left, y, contentWidth, 16).stroke();
        metrics.forEach((label, i) => {
          // `group` (the dimension value, e.g. a country name) can be an
          // array for College/Unit's multi-unit case — join for display.
          const raw = Array.isArray(row[label]) ? row[label].join(', ') : row[label];
          const val = String(raw == null || raw === '' ? '—' : raw);
          doc.fillColor('#000').text(val, left + i * colWidth + 4, y + 4, { width: colWidth - 8, lineBreak: false, ellipsis: true });
        });
        doc.strokeColor('#000');
        doc.y = y + 16;
      });
    }
    doc.moveDown(0.8);
    doc.font('Helvetica').fontSize(8.5).fillColor('#444')
      .text(`Total Partnerships in Report: ${customReportData.totalRecords}`, left, doc.y, { width: contentWidth, align: 'center' });
    doc.fillColor('#000');

    ensureGroupedSpace(90);
    doc.moveDown(1.2);
    const sigColW2 = contentWidth / 2;
    const sigTop2 = doc.y;
    [
      { label: 'Prepared by:', name: generatedBy },
      { label: 'Noted by:', name: '' }
    ].forEach((col, i) => {
      const x = left + i * sigColW2;
      doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(col.label, x, sigTop2, { width: sigColW2 - 20 });
      doc.font('Helvetica-Bold').fontSize(10).text(col.name || ' ', x, sigTop2 + 32, { width: sigColW2 - 20, align: 'center' });
      doc.moveTo(x, sigTop2 + 48).lineTo(x + sigColW2 - 20, sigTop2 + 48).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor('#666')
        .text('Name / Signature over Printed Name', x, sigTop2 + 51, { width: sigColW2 - 20, align: 'center' });
    });
    doc.fillColor('#000');

    const range2 = doc.bufferedPageRange();
    const savedBM2 = doc.page.margins.bottom;
    for (let i = range2.start; i < range2.start + range2.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      const footerY = doc.page.height - savedBM2 + 10;
      doc.font('Helvetica').fontSize(7.5).fillColor('#888')
        .text('CIPRMS — CSPC Center for International Relations and Linkages', left, footerY, { width: contentWidth / 2, lineBreak: false })
        .text(`Page ${i - range2.start + 1} of ${range2.count}`, left + contentWidth / 2, footerY, { width: contentWidth / 2, align: 'right', lineBreak: false });
      doc.page.margins.bottom = savedBM2;
    }
    doc.end();
    return;
  }

  const groups = groupPartnershipDocs(docs);
  drawColumnHeader();

  doc.font('Helvetica').fontSize(8);
  let rowIndex = 0;
  groups.forEach(group => {
    if (group.label) {
      ensureSpace(16 + 16);
      drawGroupHeader(group.label, group.docs.length);
    }
    if (!group.docs.length) {
      ensureSpace(16);
      doc.font('Helvetica-Oblique').fontSize(8).fillColor('#888')
        .text('No records in this category.', left + 6, doc.y + 3, { width: contentWidth - 12 });
      doc.fillColor('#000').font('Helvetica').fontSize(8);
      doc.y += 16;
      return;
    }
    group.docs.forEach(p => {
      ensureSpace(16);
      const y = doc.y;
      if (rowIndex % 2 === 1) doc.rect(left, y, contentWidth, 16).fillAndStroke('#f5f7fa', '#f5f7fa');
      doc.strokeColor('#e3e6eb');
      doc.rect(left, y, contentWidth, 16).stroke();
      doc.fillColor('#000').text(String(rowIndex + 1), left + 4, y + 4, { width: PARTNERSHIP_REPORT_NO_COL_WIDTH - 8, lineBreak: false });
      let x = colStartX;
      PARTNERSHIP_REPORT_COLUMNS.forEach(col => {
        const val = String(p[col.key] == null || p[col.key] === '' ? '—' : p[col.key]);
        doc.fillColor('#000').text(val, x + 4, y + 4, { width: col.width - 8, lineBreak: false, ellipsis: true });
        x += col.width;
      });
      doc.strokeColor('#000');
      doc.y = y + 16;
      rowIndex++;
    });
  });

  // ── Signature block — matches the reference document's two-column
  // "Prepared by / Noted by" footer. Prepared by is dynamically the
  // exporting Administrator; Noted by is left blank for a wet signature. ──
  ensureSpace(90);
  doc.moveDown(1.2);
  const sigColW = contentWidth / 2;
  const sigTop = doc.y;
  [
    { label: 'Prepared by:', name: generatedBy },
    { label: 'Noted by:', name: '' }
  ].forEach((col, i) => {
    const x = left + i * sigColW;
    doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(col.label, x, sigTop, { width: sigColW - 20 });
    doc.font('Helvetica-Bold').fontSize(10).text(col.name || ' ', x, sigTop + 32, { width: sigColW - 20, align: 'center' });
    doc.moveTo(x, sigTop + 48).lineTo(x + sigColW - 20, sigTop + 48).stroke();
    doc.font('Helvetica').fontSize(7.5).fillColor('#666')
      .text('Name / Signature over Printed Name', x, sigTop + 51, { width: sigColW - 20, align: 'center' });
  });
  doc.fillColor('#000');

  // ── Page numbering — written after all content so the true total is known.
  // Writing below the printable area normally makes pdfkit auto-insert a new
  // page mid-write (caught live: it was silently doubling the page count) —
  // the standard workaround is to zero the bottom margin just for this write
  // so text() doesn't treat the footer position as an overflow. ──
  const range = doc.bufferedPageRange();
  const savedBottomMargin = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - savedBottomMargin + 10;
    doc.font('Helvetica').fontSize(7.5).fillColor('#888')
      .text('CIPRMS — CSPC Center for International Relations and Linkages', left, footerY, { width: contentWidth / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, left + contentWidth / 2, footerY, { width: contentWidth / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBottomMargin;
  }

  doc.end();
}

/**
 * Custom Report & Comparison Data Engine (Administrator DSS Analytics)
 */
// Shared by the report/comparison engines below whenever a free-text filter
// (institution name) needs to become a safe, case-insensitive partial match
// instead of a literal regex injection.
function escapeRegexLiteral(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Country is a free-text field (unlike Region/Unit/Category/Agreement Type,
// which are fixed dropdowns already matching the DB's exact casing) — real
// data in this collection is entered with inconsistent casing, so a plain
// `filter.country = country` exact-string match silently returned zero
// results whenever the admin's typed casing didn't byte-for-byte match what
// was stored (e.g. "japan" vs "Japan"). This still requires the WHOLE field
// to match (unlike Institution's intentional partial search) — only the
// casing requirement is relaxed. Shared by both report engines so Country
// matching can never diverge between the Custom Report Builder and Compare.
function buildExactCaseInsensitiveMatch(value) {
  return { $regex: '^' + escapeRegexLiteral(value) + '$', $options: 'i' };
}

// The Report Builder's Report Type dropdown (e.g. "Active Partnerships")
// implies a status even though it is a separate control from the Status
// filter — used by BOTH computeCustomReportData (so Preview/PDF/Excel never
// silently include a status the Report Type didn't ask for) AND
// computeComparisonReport (so a comparison's "original report" — Group A —
// stays the exact same record set the admin was just looking at in Preview,
// rather than silently reverting to every status once Compare is opened).
const REPORT_TYPE_IMPLIED_STATUS = {
  'Active Partnerships': 'Active',
  'Active List': 'Active',
  'Inactive Partnerships': 'Inactive',
  'Expired Partnerships': 'Expired',
  'Expired List': 'Expired',
  'Expiring Soon': 'Expiring Soon'
};

// Report Types that already encode a specific partnership status in their name.
// When one of these is selected the implied status is AUTHORITATIVE — a
// client-supplied status filter (stale DOM value, bookmarked URL, or a
// manipulated query string) is ignored so it can never create a contradictory
// result (e.g. reportType=Active Partnerships & status=Expired returning
// zero records with a confusing "Active Partnerships" title).
// For Summary (and any other type not in this set) the explicit status filter
// is fully respected — the user controls which status subset to show.
const STATUS_TYPED_REPORT_TYPES = new Set(Object.keys(REPORT_TYPE_IMPLIED_STATUS));

async function computeCustomReportData(db, query, user) {
  const reportType = query.reportType || query.type || 'Summary';
  const cat = query.cat || '';
  const dateFrom = query.dateFrom || '';
  const dateTo = query.dateTo || '';
  const unit = query.unit || '';
  const agtype = query.agtype || query.typeFilter || query.type || '';
  const region = query.region || '';
  const statusFilter = query.status || '';
  const nature = query.nature || '';
  const country = query.country || '';
  const inst = query.inst || '';
  const compareByInput = query.compareBy || 'Country';
  // The Custom Report Builder's "Group By" dropdown (cr-groupby in
  // reports.ejs) — independent of `reportType`/`compareByInput` above, which
  // predate it and only ever drove the legacy, UI-unreachable "By Country"/
  // "Active vs Inactive"/etc. reportType values. `groupBy` lets any regular
  // report (e.g. "Active Partnerships", any status/date/unit filter) ALSO be
  // grouped by a dimension without hijacking the Report Type field to do it.
  const groupByInput = typeof query.groupBy === 'string' ? query.groupBy : '';
  const GROUPBY_FIELD_TO_LABEL = {
    country: 'Country', inst: 'Institution', unit: 'College / Unit', region: 'Region',
    type: 'Agreement Type', nature: 'Nature of Partnership', cat: 'Category'
  };

  // Build DB filter
  const filter = {};
  // typeof-guarded exactly like buildPartnershipFilter() elsewhere in this
  // file (2026-09-06 security hardening, Finding #5): Express's query
  // parser turns bracket-notation params like ?cat[$ne]=x into an object,
  // not a string — without this guard that object would be assigned
  // straight into the MongoDB filter as a live operator.
  if (typeof cat === 'string' && cat) filter.cat = cat;
  // `unit` can be stored as either a plain string (legacy records) or an
  // array of strings (multi-select Responsible Unit) — a plain equality
  // match here is intentional: MongoDB already treats `{unit: "CCS"}`
  // against an array field as "array contains CCS", so this one line is
  // backward-compatible with both shapes with no extra code.
  if (typeof unit === 'string' && unit) filter.unit = unit;
  if (agtype && ['MOA', 'MOU'].includes(agtype)) filter.type = agtype;
  if (typeof region === 'string' && region) filter.region = region;
  if (country) filter.country = buildExactCaseInsensitiveMatch(country);
  if (inst) filter.inst = { $regex: escapeRegexLiteral(inst), $options: 'i' };
  if (typeof nature === 'string' && nature) filter.nature = nature;

  let docs = await db.collection('partnerships').find(filter).sort({ id: 1 }).toArray();

  // Status resolution — two cases:
  // 1. Status-typed Report Type (Active Partnerships, Expired Partnerships, etc.):
  //    The implied status is AUTHORITATIVE. A client-supplied status value is
  //    ignored so a stale/manipulated filter cannot contradict the Report Type.
  // 2. Summary (or any non-status-typed type):
  //    The user's explicit Status filter is respected; no implied status exists.
  const effectiveStatusFilter = STATUS_TYPED_REPORT_TYPES.has(reportType)
    ? REPORT_TYPE_IMPLIED_STATUS[reportType]
    : (statusFilter || '');

  // Mid-Year/Yearly Output Report: strictly the CURRENT calendar year/half-
  // year, computed server-side from the server's own clock — a client-
  // supplied dateFrom/dateTo is intentionally ignored entirely for these two
  // report types (the Reports & Analytics tiles no longer send one at all;
  // see reports.ejs) so a manipulated query string can never smuggle in a
  // different year.
  let periodRangeLabel = null;
  if (reportType === 'Mid-Year' || reportType === 'Yearly') {
    const currentYear = new Date().getFullYear();
    const rangeStart = new Date(currentYear, 0, 1, 0, 0, 0);
    const rangeEnd = reportType === 'Mid-Year'
      ? new Date(currentYear, 5, 30, 23, 59, 59)
      : new Date(currentYear, 11, 31, 23, 59, 59);
    docs = filterByStartDateInRange(docs, rangeStart, rangeEnd);
    const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
    periodRangeLabel = { dateFrom: fmt(rangeStart), dateTo: fmt(rangeEnd) };
  } else if (dateFrom || dateTo) {
    docs = filterByDateRange(docs, dateFrom, dateTo, { reportType, status: effectiveStatusFilter });
  }

  // Recompute & standardize status for each doc
  docs.forEach(p => {
    const calcStatus = computeStatusFromEnd(p.end);
    if (calcStatus) p.status = calcStatus;
    p.isRenewed = Boolean(p.isRenewed || p.renewed || (p.remarks && /renew/i.test(p.remarks)) || p.nature === 'Renewal');
  });

  // Apply Status filter if specified (explicitly, or implied by Report Type)
  if (effectiveStatusFilter) {
    docs = docs.filter(p => {
      if (effectiveStatusFilter === 'Active') return p.status === 'Active';
      if (effectiveStatusFilter === 'Expiring Soon') return p.status === 'Expiring Soon';
      if (effectiveStatusFilter === 'Expired') return p.status === 'Expired';
      if (effectiveStatusFilter === 'Inactive') return p.status === 'Expired' || p.status === 'Inactive' || p.status === 'Expiring Soon';
      return p.status === effectiveStatusFilter;
    });
  }

  // Determine comparison mode and compareBy key. `groupBy` (Custom Report
  // Builder's Group By dropdown) triggers the same grouped-table computation
  // as the legacy "By [Dimension]" reportType values, independent of
  // whichever reportType/status is actually selected.
  const isComparison = [
    'Active vs Inactive', 'Active vs Expired', 'Active vs Expiring Soon',
    'Renewed vs Non-Renewed', 'Custom Comparison', 'By Institution',
    'By College / Unit', 'By Country', 'By Region', 'By Agreement Type', 'By Nature of Partnership'
  ].includes(reportType) || !!GROUPBY_FIELD_TO_LABEL[groupByInput];

  let compareBy = compareByInput;
  if (reportType === 'By Institution') compareBy = 'Institution';
  else if (reportType === 'By College / Unit') compareBy = 'College / Unit';
  else if (reportType === 'By Country') compareBy = 'Country';
  else if (reportType === 'By Region') compareBy = 'Region';
  else if (reportType === 'By Agreement Type') compareBy = 'Agreement Type';
  else if (reportType === 'By Nature of Partnership') compareBy = 'Nature of Partnership';
  else if (GROUPBY_FIELD_TO_LABEL[groupByInput]) compareBy = GROUPBY_FIELD_TO_LABEL[groupByInput];

  // Determine metric groups for comparison
  let metricGroups = ['Active', 'Inactive'];
  if (reportType === 'Active vs Expired') metricGroups = ['Active', 'Expired'];
  else if (reportType === 'Active vs Expiring Soon') metricGroups = ['Active', 'Expiring Soon'];
  else if (reportType === 'Renewed vs Non-Renewed') metricGroups = ['Renewed', 'Non-Renewed'];
  else if (reportType === 'Custom Comparison') {
    let custom = query.customStatuses;
    if (typeof custom === 'string') custom = custom.split(',').map(s => s.trim()).filter(Boolean);
    if (Array.isArray(custom) && custom.length > 0) metricGroups = custom;
    else metricGroups = ['Active', 'Inactive', 'Expired'];
  }
  // The six "By [Dimension]" grouped reports below previously fell through to
  // the generic ['Active','Inactive'] default above. That default's
  // 'Inactive' matcher only counts status === 'Expired'/'Inactive', so an
  // "Expiring Soon" partnership was included in each group's Total but
  // matched neither metric column (Active + Inactive < Total). Giving these
  // report types their own explicit three-way breakdown makes
  // Active + Expiring Soon + Inactive reconcile to Total for every group,
  // without touching the shared default relied on by 'Active vs Inactive'.
  else if ([
    'By Institution', 'By College / Unit', 'By Country',
    'By Region', 'By Agreement Type', 'By Nature of Partnership'
  ].includes(reportType) || !!GROUPBY_FIELD_TO_LABEL[groupByInput]) {
    metricGroups = ['Active', 'Expiring Soon', 'Inactive'];
  }

  // College / Unit is the one dimension that can be an array (a partnership
  // may have multiple responsible units) — every other dimension is always a
  // plain string, so this returns an array only for that one key.
  // A malformed country value (e.g. whitespace-only, "   ") is truthy in JS
  // and would otherwise form its own confusing blank-looking group instead of
  // safely folding into "Unspecified" alongside a genuinely missing country —
  // trimming here never merges two differently-spelled real country names
  // (Philippines/philipines stay distinct, per the no-silent-normalization
  // requirement), it only catches pure whitespace.
  function normalizeCountryGroupVal(rawCountry) {
    const c = (typeof rawCountry === 'string' ? rawCountry : '').trim();
    return c || 'Unspecified';
  }
  function getGroupVal(p, key) {
    if (key === 'Country') return normalizeCountryGroupVal(p.country);
    if (key === 'Institution') return p.inst || 'Unspecified';
    if (key === 'College / Unit') {
      if (Array.isArray(p.unit)) return p.unit.length ? p.unit : 'Unspecified';
      return p.unit || 'Unspecified';
    }
    if (key === 'Region') return p.region || 'Unspecified';
    if (key === 'Agreement Type') return p.type || 'Unspecified';
    if (key === 'Nature of Partnership') {
      if (Array.isArray(p.nature)) return p.nature.length ? p.nature : 'Unspecified';
      return p.nature || 'Unspecified';
    }
    if (key === 'Category') return p.cat || 'Unspecified';
    if (key === 'Year') return p.startYear ? String(p.startYear) : (p.start ? String(new Date(p.start).getFullYear()) : 'Unspecified');
    return normalizeCountryGroupVal(p.country);
  }

  const groupsMap = {};
  docs.forEach(p => {
    const gVal = getGroupVal(p, compareBy);
    // A multi-unit partnership counts once toward EACH of its units' groups
    // (same semantics as the /stats byUnit breakdown above) rather than
    // forming one combined group keyed by the whole array.
    const gVals = Array.isArray(gVal) ? gVal : [gVal];
    gVals.forEach(v => {
      if (!groupsMap[v]) {
        // `group` is the canonical key existing tests/consumers already read
        // (res.body.comparisonData[i].group). `[compareBy]` is an alias to
        // the SAME value (e.g. row.Country === row.group when compareBy is
        // "Country") — every renderer that iterates the `metrics` array
        // (Preview's grouped table, the PDF/Excel grouped table) looks up
        // each column generically via row[metricName], and metrics[0] is
        // always compareBy itself; without this alias that first column
        // read row[compareBy], which never existed, and rendered blank.
        groupsMap[v] = { group: v, Total: 0 };
        groupsMap[v][compareBy] = v;
        metricGroups.forEach(m => groupsMap[v][m] = 0);
      }
      groupsMap[v].Total += 1;

      // DSS audit finding (2026-10-10): 'Inactive' must FOLD IN Expiring Soon
      // records only when nothing else is already tracking them separately —
      // otherwise they'd be counted in both columns (the six "By [Dimension]"
      // types above, and the 'Custom Comparison' default, each already give
      // Expiring Soon/Expired their own column). The only metricGroups shape
      // where Expiring Soon has nowhere else to go is the plain two-column
      // ['Active', 'Inactive'] default used by reportType 'Active vs
      // Inactive' — without folding it in there, a group's Active + Inactive
      // silently summed to less than Total whenever it contained an Expiring
      // Soon record, AND it disagreed with the dedicated Comparison feature's
      // own 'Active vs Inactive', which already treats Expiring Soon as
      // Inactive (computeComparisonReport's matchStatus, same file).
      const inactiveHasNoOtherBucket = !metricGroups.includes('Expiring Soon') && !metricGroups.includes('Expired');
      metricGroups.forEach(m => {
        let match = false;
        if (m === 'Active') match = (p.status === 'Active');
        else if (m === 'Inactive') match = (p.status === 'Expired' || p.status === 'Inactive' || (inactiveHasNoOtherBucket && p.status === 'Expiring Soon'));
        else if (m === 'Expired') match = (p.status === 'Expired');
        else if (m === 'Expiring Soon') match = (p.status === 'Expiring Soon');
        else if (m === 'Renewed') match = p.isRenewed;
        else if (m === 'Non-Renewed') match = !p.isRenewed;
        else match = (p.status === m);
        if (match) groupsMap[v][m] += 1;
      });
    });
  });

  const comparisonData = Object.values(groupsMap).sort((a, b) => b.Total - a.Total);
  const primaryMetric = metricGroups[0];
  // `${primaryMetric} %` (e.g. "Active %") is a PER-GROUP status ratio —
  // what fraction of THIS group's own records are Active — and predates this
  // change. `% of Total` is a different, additive metric: this group's share
  // of every record in the whole filtered report dataset (docs.length), the
  // actual "Country Percentage = country count / total partnerships in the
  // report" the Reports & Analytics Country distribution feature needs.
  // Computed from `docs.length` (the exact same filtered population Preview/
  // PDF/Excel all already share via this one function), so it always reflects
  // the report's active filters, and every row's percentage sums to ~100%.
  comparisonData.forEach(row => {
    const cnt = row[primaryMetric] || 0;
    const pct = row.Total > 0 ? ((cnt / row.Total) * 100).toFixed(1) : '0.0';
    row[`${primaryMetric} %`] = `${pct}%`;
    const distPct = docs.length > 0 ? ((row.Total / docs.length) * 100).toFixed(1) : '0.0';
    row['% of Total'] = `${distPct}%`;
  });

  const totalActive = docs.filter(p => p.status === 'Active').length;
  const totalExpiring = docs.filter(p => p.status === 'Expiring Soon').length;
  const totalExpired = docs.filter(p => p.status === 'Expired').length;
  const totalInactive = docs.filter(p => p.status === 'Expired' || p.status === 'Inactive').length;

  const now = new Date();
  const generatedDate = now.toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  const title = query.title || `${reportType} Report`;

  // Single authoritative period label — reused as-is by both the PDF and
  // Excel export routes below instead of each recomputing it from raw
  // req.query (which would go stale for Mid-Year/Yearly now that those two
  // report types no longer receive a dateFrom/dateTo query param at all).
  const periodLabel = periodRangeLabel
    ? `Report Period: ${periodRangeLabel.dateFrom} to ${periodRangeLabel.dateTo}`
    : (dateFrom || dateTo)
      ? `Report Period: ${dateFrom || 'earliest'} to ${dateTo || 'present'}`
      : 'Report Period: All Records';

  return {
    title,
    generatedDate,
    generatedBy: (user && user.name) || 'Administrator',
    periodLabel,
    totalRecords: docs.length,
    isComparison,
    compareBy,
    metricGroups,
    primaryMetric,
    metrics: [compareBy, ...metricGroups, 'Total', `${primaryMetric} %`, '% of Total'],
    groupBy: groupByInput || null,
    comparisonData,
    summary: {
      activeCount: totalActive,
      expiringSoonCount: totalExpiring,
      expiredCount: totalExpired,
      inactiveCount: totalInactive,
      totalCount: docs.length
    },
    // Region, Nature of Partnership and Institution are deliberately omitted
    // here — they are not fields the Custom Report Builder exposes, so
    // surfacing them in this report's own metadata (Preview badges / Excel
    // "Applied Filters" sheet) would only ever show a permanent, meaningless
    // "All". College/Unit WAS omitted for the same reason but the Builder
    // re-gained a real College/Unit filter (2026-09-04), so it is echoed
    // again here. The underlying MongoDB filter capability for
    // unit/region/nature/inst above is untouched and still used when those
    // query params are supplied directly (e.g. by the Compare workflow's
    // separate engine).
    filters: {
      reportType,
      category: cat || 'All',
      dateFrom: (periodRangeLabel && periodRangeLabel.dateFrom) || dateFrom || 'Earliest',
      dateTo: (periodRangeLabel && periodRangeLabel.dateTo) || dateTo || 'Present',
      unit: unit || 'All',
      agreementType: agtype || 'All',
      country: country || 'All',
      status: effectiveStatusFilter || 'All',
      compareBy,
      groupBy: GROUPBY_FIELD_TO_LABEL[groupByInput] || 'None'
    },
    records: docs
  };
}

// ── Custom Report Preview API (Administrator-only) ──────────────────────────
app.get('/api/reports/custom/preview', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const result = await computeCustomReportData(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Generated Custom Report preview: ${result.title}`);
    res.json(result);
  } catch (err) {
    console.error('❌ Custom Report Preview error:', err);
    res.status(500).json({ error: 'Unable to generate the report preview right now. Please try again.' });
  }
});

app.get('/api/reports/partnerships/pdf', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const reportData = await computeCustomReportData(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported Custom Report PDF: ${reportData.title}`);

    renderPartnershipReportPdf(res, {
      title: reportData.title,
      docs: reportData.records,
      periodLabel: reportData.periodLabel,
      generatedBy: reportData.generatedBy,
      customReportData: reportData
    });
  } catch (err) {
    console.error('❌ Partnerships PDF export error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate the PDF export right now. Please try again.' });
    else if (!res.writableEnded) res.end();
  }
});

// Full-detail column set — used by the dedicated Comparison Excel export's
// per-group record sheets, where the extra attributes help cross-reference
// records between Group A and Group B.
const PARTNERSHIP_FULL_EXCEL_COLUMNS = [
  { header: 'Institution', key: 'inst', width: 32 },
  { header: 'Country', key: 'country', width: 18 },
  { header: 'Region', key: 'region', width: 14 },
  { header: 'Type', key: 'type', width: 8 },
  { header: 'Nature', key: 'nature', width: 18 },
  { header: 'Category', key: 'cat', width: 14 },
  { header: 'Unit', key: 'unit', width: 10 },
  { header: 'Coordinator', key: 'coordinator', width: 20 },
  { header: 'Start Date', key: 'start', width: 14 },
  { header: 'End Date', key: 'end', width: 14 },
  { header: 'Status', key: 'status', width: 16 },
  { header: 'Remarks', key: 'remarks', width: 30 }
];

// Primary Custom Report Excel template — mirrors the official CIRL "List of
// Active International Partners" reference document's column structure
// exactly (No. | Name of Schools | Address/Country | Date of Signing |
// Date of Expiration). "No." is a printed row index, not a stored field.
const INSTITUTIONAL_LIST_EXCEL_COLUMNS = [
  { header: 'No.', key: 'no', width: 6 },
  { header: 'Name of Schools/Institutions', key: 'inst', width: 38 },
  { header: 'Address/Country', key: 'country', width: 30 },
  { header: 'Date of Signing', key: 'start', width: 16 },
  { header: 'Date of Expiration', key: 'end', width: 18 }
];

function excelColLetter(index) {
  let n = index, s = '';
  while (n > 0) { const r = (n - 1) % 26; s = String.fromCharCode(65 + r) + s; n = Math.floor((n - 1) / 26); }
  return s;
}

const THIN_BORDER = { style: 'thin', color: { argb: 'FFB7C0CC' } };
const CELL_BORDERS = { top: THIN_BORDER, left: THIN_BORDER, bottom: THIN_BORDER, right: THIN_BORDER };

function buildPartnershipExcel({ title, docs, periodLabel, generatedBy, customReportData }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CIPRMS';
  workbook.created = new Date();

  // Sheet 1: Report Summary & Records
  const sheet1 = workbook.addWorksheet('Report Summary', {
    pageSetup: { orientation: 'portrait', fitToPage: true, fitToWidth: 1, fitToHeight: 0, margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 } }
  });

  // Grouped reports (Custom Report Builder's Group By, or a legacy "By
  // [Dimension]" reportType, e.g. the "Partnership by Country" fixed tile)
  // get a Group/Count/% table instead of the flat institutional-list table —
  // computed up front so the letterhead's merged banner width matches
  // whichever column count this export actually uses.
  const isGrouped = !!(customReportData && customReportData.isComparison);
  const metrics = isGrouped ? (customReportData.metrics || []) : [];
  const groupedRows = isGrouped ? (customReportData.comparisonData || []) : [];
  const colCount = isGrouped ? Math.max(metrics.length, 1) : INSTITUTIONAL_LIST_EXCEL_COLUMNS.length;
  const effectiveColCount = colCount;
  const lastCol = excelColLetter(colCount);
  sheet1.columns = isGrouped
    ? metrics.map((m, i) => ({ key: 'm' + i, width: 20 }))
    : INSTITUTIONAL_LIST_EXCEL_COLUMNS.map(c => ({ key: c.key, width: c.width }));

  function mergedRow(sheet, text, { bold = false, size = 11, color = 'FF000000', height = 18, align = 'center', endCol = lastCol } = {}) {
    const row = sheet.addRow([]);
    row.height = height;
    sheet.mergeCells(`A${row.number}:${endCol}${row.number}`);
    const cell = row.getCell(1);
    cell.value = text;
    cell.font = { bold, size, color: { argb: color } };
    cell.alignment = { horizontal: align, vertical: 'middle' };
    return row;
  }

  mergedRow(sheet1, 'Republic of the Philippines', { size: 9, color: 'FF444444' });
  mergedRow(sheet1, 'CAMARINES SUR POLYTECHNIC COLLEGES', { bold: true, size: 13 });
  mergedRow(sheet1, 'Nabua, Camarines Sur', { size: 9, color: 'FF444444' });
  mergedRow(sheet1, 'Telephone No. (054) 288-4421 to 23 local 206  |  cspcinternational@cspc.edu.ph', { size: 9, color: 'FF444444' });
  mergedRow(sheet1, 'CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', { bold: true, size: 11, color: 'FF0A3D91' });
  mergedRow(sheet1, title.toUpperCase(), { bold: true, size: 14, color: 'FF0A58CA', height: 22 });
  mergedRow(sheet1, periodLabel, { size: 9.5, color: 'FF444444' });
  const generatedRow = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  mergedRow(sheet1, `Generated ${generatedRow} by ${generatedBy}`, { size: 9.5, color: 'FF444444' });
  sheet1.addRow([]);

  if (customReportData && customReportData.summary) {
    const s = customReportData.summary;
    const sumRow = sheet1.addRow([
      `Total Records: ${s.totalCount}`,
      `Active: ${s.activeCount}`,
      `Inactive: ${s.inactiveCount}`,
      `Expiring Soon: ${s.expiringSoonCount}`,
      `Expired: ${s.expiredCount}`
    ]);
    sumRow.height = 18;
    sumRow.eachCell(c => {
      c.font = { bold: true, size: 9.5, color: { argb: 'FF0A3D91' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBE6FB' } };
      c.border = CELL_BORDERS;
      c.alignment = { horizontal: 'center', vertical: 'middle' };
    });
    sheet1.addRow([]);
  }

  // (isGrouped/metrics/groupedRows/effectiveColCount computed above, before
  // the letterhead, so the merged title banner's width already matches.)
  let headerRowNumber;

  if (isGrouped) {
    const headerRow = sheet1.addRow(metrics);
    headerRow.height = 20;
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = CELL_BORDERS;
    });
    headerRowNumber = headerRow.number;

    if (!groupedRows.length) {
      const emptyRow = sheet1.addRow(['No records found matching the selected filters.']);
      sheet1.mergeCells(emptyRow.number, 1, emptyRow.number, effectiveColCount);
      emptyRow.getCell(1).font = { italic: true, color: { argb: 'FF888888' } };
      emptyRow.getCell(1).alignment = { horizontal: 'center' };
    } else {
      groupedRows.forEach((row, idx) => {
        const values = metrics.map(m => {
          const raw = Array.isArray(row[m]) ? row[m].join(', ') : row[m];
          return (raw == null || raw === '') ? '—' : raw;
        });
        const excelRow = sheet1.addRow(values);
        const fill = idx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
        excelRow.eachCell({ includeEmpty: true }, cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
          cell.border = CELL_BORDERS;
          cell.alignment = { horizontal: 'center', vertical: 'middle' };
        });
      });
    }

    sheet1.columns.forEach((col, i) => {
      let max = String(metrics[i]).length;
      groupedRows.forEach(row => {
        const v = row[metrics[i]];
        if (v != null) max = Math.max(max, String(v).length);
      });
      col.width = Math.min(Math.max(max + 2, 14), 40);
    });
  } else {
    const groups = groupPartnershipDocs(docs);

    const headerRow = sheet1.addRow(INSTITUTIONAL_LIST_EXCEL_COLUMNS.map(c => c.header));
    headerRow.height = 20;
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = CELL_BORDERS;
    });
    headerRowNumber = headerRow.number;

    let rowIndex = 0;
    groups.forEach(group => {
      if (group.label) {
        const gRow = mergedRow(sheet1, `${group.label} (${group.docs.length})`, { bold: true, size: 10, color: 'FF0A3D91', align: 'left', height: 16 });
        gRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBE6FB' } };
      }
      group.docs.forEach(p => {
        const rowValues = INSTITUTIONAL_LIST_EXCEL_COLUMNS.reduce((acc, c) => {
          acc[c.key] = c.key === 'no' ? (rowIndex + 1) : p[c.key];
          return acc;
        }, {});
        const row = sheet1.addRow(rowValues);
        const fill = rowIndex % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
        row.eachCell({ includeEmpty: true }, cell => {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
          cell.border = CELL_BORDERS;
          cell.alignment = { vertical: 'middle' };
        });
        row.getCell('no').alignment = { vertical: 'middle', horizontal: 'center' };
        rowIndex++;
      });
    });

    sheet1.columns.forEach((col, i) => {
      const header = INSTITUTIONAL_LIST_EXCEL_COLUMNS[i].header;
      let max = header.length;
      docs.forEach(p => {
        const v = INSTITUTIONAL_LIST_EXCEL_COLUMNS[i].key === 'no' ? null : p[INSTITUTIONAL_LIST_EXCEL_COLUMNS[i].key];
        if (v != null) max = Math.max(max, String(v).length);
      });
      col.width = Math.min(Math.max(max + 2, INSTITUTIONAL_LIST_EXCEL_COLUMNS[i].width), 45);
    });
  }

  sheet1.addRow([]);
  const sigRow = sheet1.addRow([]);
  sigRow.height = 16;
  const half = Math.max(1, Math.floor(effectiveColCount / 2));
  const sigCols = [
    { label: 'Prepared by:', name: generatedBy, start: 1 },
    { label: 'Noted by:', name: '', start: half + 1 }
  ];
  sigCols.forEach(sc => {
    const end = Math.min(sc.start + half - 1, effectiveColCount);
    if (end > sc.start) sheet1.mergeCells(sigRow.number, sc.start, sigRow.number, end);
    const cell = sigRow.getCell(sc.start);
    cell.value = sc.label;
    cell.font = { bold: true, size: 9.5 };
  });
  const sigNameRow = sheet1.addRow([]);
  sigNameRow.height = 16;
  sigCols.forEach(sc => {
    const end = Math.min(sc.start + half - 1, effectiveColCount);
    if (end > sc.start) sheet1.mergeCells(sigNameRow.number, sc.start, sigNameRow.number, end);
    const cell = sigNameRow.getCell(sc.start);
    cell.value = sc.name || ' ';
    cell.font = { size: 10 };
    cell.alignment = { horizontal: 'center' };
    cell.border = { bottom: THIN_BORDER };
  });

  sheet1.views = [{ state: 'frozen', ySplit: headerRowNumber }];
  sheet1.pageSetup.printTitlesRow = `${headerRowNumber}:${headerRowNumber}`;

  // Sheet 2 — Applied Filters (the dedicated comparison-only "Comparison
  // Results" sheet was removed — comparison is now a separate, dedicated
  // export reachable only via Preview → Compare, per the Reports & Analytics
  // Round 2 requirements)
  const sheet3 = workbook.addWorksheet('Applied Filters');
  mergedRow(sheet3, 'APPLIED REPORT FILTERS & PARAMETERS', { bold: true, size: 12, color: 'FF0A3D91', endCol: 'B' });
  sheet3.addRow([]);

  const filterHeaderRow = sheet3.addRow(['Filter Parameter', 'Applied Value']);
  filterHeaderRow.height = 20;
  filterHeaderRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = CELL_BORDERS;
  });

  const filterObj = (customReportData && customReportData.filters) || {};
  // Mirrors the Custom Report Builder's actual filter set exactly — Region
  // and Nature of Partnership are not builder fields, so they're omitted
  // here. College/Unit was re-added to the Builder (2026-09-04) and Country
  // was previously missing here even though it IS a real, still-applied
  // builder filter (a genuine metadata gap: the sheet could show "Country:
  // All" for a report that was actually filtered to a single country).
  const filterLabels = {
    reportType: 'Report Type',
    category: 'Category',
    dateFrom: 'Date From',
    dateTo: 'Date To',
    unit: 'College / Unit',
    agreementType: 'Agreement Type',
    status: 'Status',
    country: 'Country'
  };

  Object.entries(filterLabels).forEach(([key, label], idx) => {
    const val = filterObj[key] || 'All';
    const row = sheet3.addRow([label, val]);
    const fill = idx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
    row.eachCell((cell, cIdx) => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = CELL_BORDERS;
      cell.alignment = { horizontal: cIdx === 1 ? 'left' : 'center', vertical: 'middle' };
    });
  });

  sheet3.getColumn(1).width = 25;
  sheet3.getColumn(2).width = 35;

  return workbook;
}

app.get('/api/reports/partnerships/excel', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const reportData = await computeCustomReportData(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported Custom Report Excel: ${reportData.title}`);

    const workbook = buildPartnershipExcel({
      title: reportData.title,
      docs: reportData.records,
      periodLabel: reportData.periodLabel,
      generatedBy: reportData.generatedBy,
      customReportData: reportData
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(reportData.title)}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('❌ Partnerships Excel export error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate the Excel export right now. Please try again.' });
    else if (!res.writableEnded) res.end();
  }
});

// ── Comparison Report Endpoints (Separate Section, Administrator-only) ──────
// These power the "Comparison Reports" cards and the Comparison Builder panel.
// They reuse computeCustomReportData() for all DB queries and status logic,
// then render a dedicated two-group comparison PDF and a 3-sheet Excel.

/**
 * Render a dedicated Comparison Report PDF with:
 *   - CSPC letterhead
 *   - Comparison Summary block (Group A vs Group B: count, difference, % diff)
 *   - Detailed records table for each group side-by-side
 */
function renderComparisonReportPdf(res, { title, groupA, groupB, groupADocs, groupBDocs, periodLabel, generatedBy, filters }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(title)}.pdf"`);

  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape', bufferPages: true });
  doc.on('error', (err) => {
    console.error('❌ Comparison Report PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate comparison PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => console.error('❌ Comparison Report PDF response stream error:', err));
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  const cspcLogoPath = path.join(__dirname, 'public', 'images', 'cspc.PNG');
  const pqaLogoPath = path.join(__dirname, 'public', 'images', 'PQA.JPG');
  const tuvLogoPath = path.join(__dirname, 'public', 'images', 'TUV.png');
  const qsLogoPath = path.join(__dirname, 'public', 'images', 'QS.png');

  // ── Letterhead ──
  const LOGO_SIZE = 48;
  const top = doc.page.margins.top;
  doc.y = top;
  try { doc.image(cspcLogoPath, left, top, { width: LOGO_SIZE, height: LOGO_SIZE }); } catch (e) { /* optional */ }
  const rLS = 28;
  const rLX = right - (rLS * 3 + 8);
  try { doc.image(pqaLogoPath, rLX, top + 10, { width: rLS, height: rLS }); } catch (e) { /* optional */ }
  try { doc.image(tuvLogoPath, rLX + rLS + 4, top + 10, { width: rLS, height: rLS }); } catch (e) { /* optional */ }
  try { doc.image(qsLogoPath, rLX + (rLS + 4) * 2, top + 10, { width: rLS, height: rLS }); } catch (e) { /* optional */ }

  const cX = left + LOGO_SIZE + 8;
  const cW = rLX - cX - 8;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('CAMARINES SUR POLYTECHNIC COLLEGES', cX, top, { width: cW, align: 'center' });
  doc.font('Helvetica').fontSize(8.5).text('Nabua, Camarines Sur', cX, doc.y, { width: cW, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).text('Telephone No. (054) 288-4421 to 23 local 206', cX, doc.y, { width: cW, align: 'center' });
  doc.font('Helvetica').fontSize(7.5).fillColor('#0a58ca').text('cspcinternational@cspc.edu.ph', cX, doc.y, { width: cW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000').text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', cX, doc.y, { width: cW, align: 'center' });
  doc.y = Math.max(doc.y, top + LOGO_SIZE) + 6;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(title.toUpperCase(), left, doc.y, { width: contentWidth, align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8.5).fillColor('#444')
    .text(periodLabel, left, doc.y, { width: contentWidth, align: 'center' })
    .text(`Generated ${now} by ${generatedBy}`, left, doc.y, { width: contentWidth, align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.8);

  // ── Comparison Summary Box ──
  const boxTop = doc.y;
  const boxH = 74;
  doc.rect(left, boxTop, contentWidth, boxH).fill('#EBF2FF').stroke('#0a58ca');
  doc.fill('#000');

  const totalA = groupADocs.length;
  const totalB = groupBDocs.length;
  const diff = Math.abs(totalA - totalB);
  const totalBoth = totalA + totalB;
  const pctA = totalBoth > 0 ? ((totalA / totalBoth) * 100).toFixed(1) : '0.0';
  const pctB = totalBoth > 0 ? ((totalB / totalBoth) * 100).toFixed(1) : '0.0';
  const pctDiff = totalBoth > 0 ? (Math.abs((totalA - totalB) / totalBoth) * 100).toFixed(1) : '0.0';

  const halfW = contentWidth / 2 - 8;

  // Group A column
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#0a3d91')
    .text(groupA.toUpperCase(), left + 10, boxTop + 8, { width: halfW });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#0a3d91')
    .text(String(totalA), left + 10, boxTop + 22, { width: halfW });
  doc.font('Helvetica').fontSize(9).fillColor('#333')
    .text(`${pctA}% of compared records`, left + 10, boxTop + 54, { width: halfW });

  // Group B column
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#b91c1c')
    .text(groupB.toUpperCase(), left + contentWidth / 2 + 4, boxTop + 8, { width: halfW });
  doc.font('Helvetica-Bold').fontSize(28).fillColor('#b91c1c')
    .text(String(totalB), left + contentWidth / 2 + 4, boxTop + 22, { width: halfW });
  doc.font('Helvetica').fontSize(9).fillColor('#333')
    .text(`${pctB}% of compared records`, left + contentWidth / 2 + 4, boxTop + 54, { width: halfW });

  // Center divider line
  doc.moveTo(left + contentWidth / 2, boxTop + 6).lineTo(left + contentWidth / 2, boxTop + boxH - 6)
    .lineWidth(1).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');

  doc.y = boxTop + boxH + 6;

  // Difference + % diff line
  doc.font('Helvetica').fontSize(9).fillColor('#444')
    .text(`Difference: ${diff} record${diff !== 1 ? 's' : ''} (${pctDiff}% gap)  |  Total compared: ${totalBoth}`,
      left, doc.y, { width: contentWidth, align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.8);

  // Applied Filters (compact)
  if (filters && Object.keys(filters).length > 0) {
    const fParts = Object.entries(filters)
      .filter(([, v]) => v && v !== 'All' && v !== 'All Units' && v !== 'Earliest' && v !== 'Present' && v !== 'All Natures')
      .map(([k, v]) => `${k}: ${v}`);
    if (fParts.length > 0) {
      doc.font('Helvetica').fontSize(8).fillColor('#666')
        .text('Filters applied: ' + fParts.join('  ·  '), left, doc.y, { width: contentWidth });
      doc.fillColor('#000');
      doc.moveDown(0.6);
    }
  }

  // ── Records Tables ──
  const COL_DEFS = [
    { key: 'inst', label: 'Institution', width: 175 },
    { key: 'country', label: 'Country', width: 80 },
    { key: 'region', label: 'Region', width: 65 },
    { key: 'type', label: 'Type', width: 45 },
    { key: 'nature', label: 'Nature', width: 110 },
    { key: 'unit', label: 'Unit', width: 50 },
    { key: 'start', label: 'Start', width: 75 },
    { key: 'end', label: 'End', width: 75 },
    { key: 'status', label: 'Status', width: 85 }
  ];

  function drawTableSection(sectionTitle, sectionColor, sectionDocs) {
    if (doc.y + 60 > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      doc.y = doc.page.margins.top;
    }
    // Section header
    const shY = doc.y;
    doc.rect(left, shY, contentWidth, 18).fillAndStroke(sectionColor, sectionColor);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff')
      .text(sectionTitle + ` (${sectionDocs.length} record${sectionDocs.length !== 1 ? 's' : ''})`, left + 6, shY + 5, { width: contentWidth - 12 });
    doc.fillColor('#000');
    doc.y = shY + 18;

    if (sectionDocs.length === 0) {
      const emY = doc.y;
      doc.rect(left, emY, contentWidth, 16).stroke();
      doc.font('Helvetica').fontSize(8.5).fillColor('#888')
        .text('No records found for this group.', left + 4, emY + 4, { width: contentWidth - 8 });
      doc.fillColor('#000');
      doc.y = emY + 16;
      doc.moveDown(0.4);
      return;
    }

    // Column headers
    const chY = doc.y;
    doc.rect(left, chY, contentWidth, 16).fillAndStroke('#1a56c4', '#1a56c4');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff');
    let cx = left;
    COL_DEFS.forEach(col => {
      doc.text(col.label, cx + 3, chY + 4, { width: col.width - 6, lineBreak: false });
      cx += col.width;
    });
    doc.fillColor('#000');
    doc.y = chY + 16;

    sectionDocs.forEach((p, idx) => {
      if (doc.y + 16 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        // Re-draw col headers on new page
        const chY2 = doc.y;
        doc.rect(left, chY2, contentWidth, 16).fillAndStroke('#1a56c4', '#1a56c4');
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff');
        let cx2 = left;
        COL_DEFS.forEach(col => {
          doc.text(col.label, cx2 + 3, chY2 + 4, { width: col.width - 6, lineBreak: false });
          cx2 += col.width;
        });
        doc.fillColor('#000');
        doc.y = chY2 + 16;
      }
      const rowY = doc.y;
      const fill = idx % 2 === 0 ? '#FFFFFF' : '#F5F7FA';
      doc.rect(left, rowY, contentWidth, 16).fill(fill).stroke('#ddd');
      doc.font('Helvetica').fontSize(7.5).fillColor('#222');
      let rx = left;
      COL_DEFS.forEach(col => {
        // 'unit' can be an array (multi-unit partnerships) — join for display
        // rather than let PDFKit stringify the array's default comma-join.
        const raw = Array.isArray(p[col.key]) ? p[col.key].join(', ') : p[col.key];
        const val = String(raw == null || raw === '' ? '—' : raw);
        doc.text(val, rx + 3, rowY + 4, { width: col.width - 6, lineBreak: false, ellipsis: true });
        rx += col.width;
      });
      doc.strokeColor('#000');
      doc.y = rowY + 16;
    });
    doc.moveDown(0.6);
  }

  drawTableSection(`Group A: ${groupA}`, '#0a3d91', groupADocs);
  drawTableSection(`Group B: ${groupB}`, '#991B1B', groupBDocs);

  // ── Signature block ──
  if (doc.y + 90 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); doc.y = doc.page.margins.top; }
  doc.moveDown(1);
  const sigColW = contentWidth / 3;
  const sigTop = doc.y;
  [{ label: 'Prepared By:', name: generatedBy }, { label: 'Reviewed By:', name: '' }, { label: 'Approved By:', name: '' }]
    .forEach((col, i) => {
      const x = left + i * sigColW;
      doc.font('Helvetica').fontSize(8.5).fillColor('#000').text(col.label, x, sigTop, { width: sigColW - 20 });
      doc.font('Helvetica-Bold').fontSize(10).text(col.name || ' ', x, sigTop + 32, { width: sigColW - 20, align: 'center' });
      doc.moveTo(x, sigTop + 48).lineTo(x + sigColW - 20, sigTop + 48).stroke();
      doc.font('Helvetica').fontSize(7.5).fillColor('#666')
        .text('Name / Signature over Printed Name', x, sigTop + 51, { width: sigColW - 20, align: 'center' });
    });
  doc.fillColor('#000');

  // ── Page numbering ──
  const range = doc.bufferedPageRange();
  const savedBM = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - savedBM + 10;
    doc.font('Helvetica').fontSize(7.5).fillColor('#888')
      .text('CIPRMS — CSPC Center for International Relations and Linkages', left, footerY, { width: contentWidth / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, left + contentWidth / 2, footerY, { width: contentWidth / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBM;
  }
  doc.end();
}

/**
 * Build a dedicated 3-sheet Comparison Report Excel workbook.
 *   Sheet 1 — Comparison Summary: header + summary table (group A vs B)
 *   Sheet 2 — Group A Records: full partnership columns
 *   Sheet 3 — Group B Records: full partnership columns
 */
function buildComparisonExcel({ title, groupA, groupB, groupADocs, groupBDocs, periodLabel, generatedBy, filters }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CIPRMS';
  workbook.created = new Date();

  const totalA = groupADocs.length;
  const totalB = groupBDocs.length;
  const diff = Math.abs(totalA - totalB);
  const totalBoth = totalA + totalB;
  const pctA = totalBoth > 0 ? ((totalA / totalBoth) * 100).toFixed(1) : '0.0';
  const pctB = totalBoth > 0 ? ((totalB / totalBoth) * 100).toFixed(1) : '0.0';
  const pctDiff = totalBoth > 0 ? (Math.abs((totalA - totalB) / totalBoth) * 100).toFixed(1) : '0.0';
  const generatedStr = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  // ── Sheet 1: Comparison Summary ──
  const s1 = workbook.addWorksheet('Comparison Summary');
  s1.columns = [{ width: 30 }, { width: 20 }, { width: 20 }, { width: 20 }];

  function s1MergedRow(text, opts = {}) {
    const row = s1.addRow([]);
    row.height = opts.height || 18;
    s1.mergeCells(`A${row.number}:D${row.number}`);
    const cell = row.getCell(1);
    cell.value = text;
    cell.font = { bold: opts.bold || false, size: opts.size || 10, color: { argb: opts.color || 'FF000000' } };
    cell.alignment = { horizontal: opts.align || 'center', vertical: 'middle' };
    return row;
  }

  s1MergedRow('Republic of the Philippines', { size: 9, color: 'FF444444' });
  s1MergedRow('CAMARINES SUR POLYTECHNIC COLLEGES', { bold: true, size: 13 });
  s1MergedRow('Nabua, Camarines Sur', { size: 9, color: 'FF444444' });
  s1MergedRow('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', { bold: true, size: 10, color: 'FF0A3D91' });
  s1MergedRow(title.toUpperCase(), { bold: true, size: 14, color: 'FF0A58CA', height: 22 });
  s1MergedRow(periodLabel, { size: 9, color: 'FF444444' });
  s1MergedRow(`Generated ${generatedStr} by ${generatedBy}`, { size: 9, color: 'FF444444' });
  s1.addRow([]);

  // Summary table
  const sumHeaderRow = s1.addRow(['', 'Count', '% of Total Compared', '']);
  sumHeaderRow.height = 18;
  ['A', 'B', 'C', 'D'].forEach((col, i) => {
    const cell = sumHeaderRow.getCell(i + 1);
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = CELL_BORDERS;
  });

  const groupARow = s1.addRow([`Group A: ${groupA}`, totalA, `${pctA}%`, '']);
  groupARow.height = 18;
  groupARow.getCell(1).font = { bold: true, color: { argb: 'FF0A3D91' } };
  groupARow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFDBE6FB' } };
  groupARow.eachCell(c => { c.border = CELL_BORDERS; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  groupARow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  const groupBRow = s1.addRow([`Group B: ${groupB}`, totalB, `${pctB}%`, '']);
  groupBRow.height = 18;
  groupBRow.getCell(1).font = { bold: true, color: { argb: 'FF991B1B' } };
  groupBRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
  groupBRow.eachCell(c => { c.border = CELL_BORDERS; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  groupBRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  const diffRow = s1.addRow([`Difference`, diff, `${pctDiff}% gap`, '']);
  diffRow.height = 18;
  diffRow.getCell(1).font = { bold: true };
  diffRow.eachCell(c => { c.border = CELL_BORDERS; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  diffRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  const totalRow = s1.addRow([`Total Compared`, totalBoth, '100%', '']);
  totalRow.height = 18;
  totalRow.getCell(1).font = { bold: true };
  totalRow.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F6F9' } };
  totalRow.eachCell(c => { c.border = CELL_BORDERS; c.alignment = { horizontal: 'center', vertical: 'middle' }; });
  totalRow.getCell(1).alignment = { horizontal: 'left', vertical: 'middle' };

  s1.addRow([]);
  if (filters) {
    const fRow = s1.addRow(['Applied Filters']);
    fRow.getCell(1).font = { bold: true, size: 10 };
    Object.entries(filters).forEach(([k, v]) => {
      if (v && v !== 'All' && v !== 'All Units' && v !== 'Earliest' && v !== 'Present' && v !== 'All Natures') {
        s1.addRow([k, v]);
      }
    });
  }

  // ── Sheet 2: Group A Records ──
  function buildRecordSheet(name, groupName, docList) {
    const sh = workbook.addWorksheet(name);
    sh.columns = PARTNERSHIP_FULL_EXCEL_COLUMNS.map(c => ({ key: c.key, width: c.width }));

    const hdr1 = sh.addRow([]);
    sh.mergeCells(`A${hdr1.number}:L${hdr1.number}`);
    const hdr1Cell = hdr1.getCell(1);
    hdr1Cell.value = `${title.toUpperCase()} — ${groupName.toUpperCase()}`;
    hdr1Cell.font = { bold: true, size: 12, color: { argb: 'FF0A3D91' } };
    hdr1Cell.alignment = { horizontal: 'center', vertical: 'middle' };
    hdr1.height = 20;

    const hdr2 = sh.addRow([]);
    sh.mergeCells(`A${hdr2.number}:L${hdr2.number}`);
    hdr2.getCell(1).value = `${docList.length} record${docList.length !== 1 ? 's' : ''}  |  ${generatedStr}  |  Prepared by: ${generatedBy}`;
    hdr2.getCell(1).font = { size: 9, color: { argb: 'FF444444' } };
    hdr2.getCell(1).alignment = { horizontal: 'center', vertical: 'middle' };
    hdr2.height = 15;
    sh.addRow([]);

    const headerRow = sh.addRow(PARTNERSHIP_FULL_EXCEL_COLUMNS.map(c => c.header));
    headerRow.height = 20;
    headerRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = CELL_BORDERS;
    });

    docList.forEach((p, idx) => {
      // 'unit' can be an array (multi-unit partnerships) — ExcelJS cell
      // values must be primitives, so join for display rather than pass the
      // array through.
      const row = sh.addRow(PARTNERSHIP_FULL_EXCEL_COLUMNS.reduce((acc, c) => {
        const v = p[c.key];
        acc[c.key] = Array.isArray(v) ? v.join(', ') : v;
        return acc;
      }, {}));
      const fill = idx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.border = CELL_BORDERS;
        cell.alignment = { vertical: 'middle' };
      });
    });

    sh.columns.forEach((col, i) => {
      const header = PARTNERSHIP_FULL_EXCEL_COLUMNS[i].header;
      let max = header.length;
      docList.forEach(p => {
        const v = p[PARTNERSHIP_FULL_EXCEL_COLUMNS[i].key];
        if (v != null) max = Math.max(max, String(v).length);
      });
      col.width = Math.min(Math.max(max + 2, PARTNERSHIP_FULL_EXCEL_COLUMNS[i].width), 45);
    });
  }

  buildRecordSheet('Group A Records', `Group A: ${groupA}`, groupADocs);
  buildRecordSheet('Group B Records', `Group B: ${groupB}`, groupBDocs);

  return workbook;
}

/**
 * Shared helper: parse comparison query params, pull docs from DB, split into
 * two groups (A and B), and return all data needed for PDF/Excel/JSON.
 */
async function computeComparisonReport(db, query, user) {
  const compType = query.compType || 'Active vs Inactive';
  const reportType = query.reportType || '';
  const dateFrom = query.dateFrom || '';
  const dateTo = query.dateTo || '';
  const unit = query.unit || '';
  const agtype = query.agtype || '';
  const nature = query.nature || '';
  const region = query.region || '';
  const country = query.country || '';
  const inst = query.inst || '';
  const cat = query.cat || '';
  const statusQ = query.status || '';
  const statusA = query.statusA || '';
  const statusB = query.statusB || '';

  // Build MongoDB base filter (indexed fields)
  // typeof-guarded exactly like buildPartnershipFilter() / the identical fix
  // in computeCustomReportData above (2026-09-06 security hardening,
  // Finding #5) — see that function's comment for why this is needed.
  const filter = {};
  if (typeof unit === 'string' && unit) filter.unit = unit;
  if (agtype && ['MOA', 'MOU'].includes(agtype)) filter.type = agtype;
  if (typeof nature === 'string' && nature) filter.nature = nature;
  if (typeof region === 'string' && region) filter.region = region;
  if (country) filter.country = buildExactCaseInsensitiveMatch(country);
  if (typeof cat === 'string' && cat) filter.cat = cat;
  if (inst) filter.inst = { $regex: escapeRegexLiteral(inst), $options: 'i' };

  let docs = await db.collection('partnerships').find(filter).sort({ id: 1 }).toArray();

  // Explicit Status filter always wins; otherwise fall back to whatever
  // status the ORIGINAL report's Report Type implied — this is what keeps
  // Group A (the "original, preserved report") identical to what Preview
  // just showed, instead of silently reverting to every status the moment
  // Compare is opened (see REPORT_TYPE_IMPLIED_STATUS).
  const effectiveStatusQ = statusQ || REPORT_TYPE_IMPLIED_STATUS[reportType] || '';

  // Date range filter
  if (dateFrom || dateTo) {
    docs = filterByDateRange(docs, dateFrom, dateTo, { reportType, status: effectiveStatusQ });
  }

  // Recompute status using lifecycle logic for every doc
  docs.forEach(p => {
    const calcStatus = computeStatusFromEnd(p.end);
    if (calcStatus) p.status = calcStatus;
    p.isRenewed = Boolean(p.isRenewed || p.renewed || (p.remarks && /renew/i.test(p.remarks)) || p.nature === 'Renewal');
  });

  // Optional single-status pre-filter (for narrowing scope before comparison)
  if (effectiveStatusQ) {
    docs = docs.filter(p => {
      if (effectiveStatusQ === 'Active') return p.status === 'Active';
      if (effectiveStatusQ === 'Expiring Soon') return p.status === 'Expiring Soon';
      if (effectiveStatusQ === 'Expired') return p.status === 'Expired';
      if (effectiveStatusQ === 'Inactive') return p.status === 'Expired' || p.status === 'Inactive';
      return p.status === effectiveStatusQ;
    });
  }

  // Determine the two groups
  let groupALabel, groupBLabel;
  let groupADocs, groupBDocs;

  function matchStatus(p, label) {
    if (label === 'Active') return p.status === 'Active';
    if (label === 'Inactive') return p.status === 'Expired' || p.status === 'Inactive' || p.status === 'Expiring Soon';
    if (label === 'Expired') return p.status === 'Expired';
    if (label === 'Expiring Soon') return p.status === 'Expiring Soon';
    if (label === 'Renewed') return p.isRenewed === true;
    if (label === 'Non-Renewed') return p.isRenewed === false;
    return p.status === label;
  }

  if (compType === 'Active vs Inactive') {
    groupALabel = 'Active'; groupBLabel = 'Inactive';
    groupADocs = docs.filter(p => matchStatus(p, 'Active'));
    groupBDocs = docs.filter(p => matchStatus(p, 'Inactive'));

  } else if (compType === 'Active vs Expired') {
    groupALabel = 'Active'; groupBLabel = 'Expired';
    groupADocs = docs.filter(p => matchStatus(p, 'Active'));
    groupBDocs = docs.filter(p => matchStatus(p, 'Expired'));

  } else if (compType === 'New vs Renewed') {
    groupALabel = 'New (Non-Renewed)'; groupBLabel = 'Renewed';
    groupADocs = docs.filter(p => !p.isRenewed);
    groupBDocs = docs.filter(p => p.isRenewed);

  } else if (compType === 'Custom Status Comparison') {
    // statusA and statusB from the form
    const sA = statusA || 'Active';
    const sB = statusB || 'Inactive';
    groupALabel = sA; groupBLabel = sB;
    groupADocs = docs.filter(p => matchStatus(p, sA));
    groupBDocs = docs.filter(p => matchStatus(p, sB));

  } else if (compType === 'Compare Against') {
    // Dimension-override comparison — the ONLY mode reachable from the
    // Custom Report Builder's Preview → Compare button. Group A is the
    // ORIGINAL report exactly as already filtered above ("docs"), never
    // rebuilt or narrowed — it is preserved verbatim, per the requirement
    // that the admin's original report must never be replaced or destroyed.
    // Group B re-runs the SAME base filters with exactly one dimension
    // overridden to the chosen comparison value.
    const dimFieldMap = { country: 'country', inst: 'inst', unit: 'unit', region: 'region', type: 'type', nature: 'nature', cat: 'cat' };
    const dimLabelMap = {
      country: 'Country', inst: 'Institution', unit: 'College / Unit', region: 'Region',
      type: 'Agreement Type', nature: 'Nature of Partnership', cat: 'Category',
      year: 'Year', status: 'Partnership Status'
    };
    const dimField = query.compareField || 'country';
    const dimValue = (query.compareValue || '').trim();
    const dimLabel = dimLabelMap[dimField] || dimField;

    groupALabel = query.title || 'Original Report';
    groupBLabel = dimValue ? `${dimLabel}: ${dimValue}` : 'No comparison value selected';
    groupADocs = docs;

    async function fetchOverrideGroup(overrideFilter, statusOverride) {
      let odocs = await db.collection('partnerships').find(overrideFilter).sort({ id: 1 }).toArray();
      if (dateFrom || dateTo) odocs = filterByDateRange(odocs, dateFrom, dateTo, { reportType, status: statusOverride || effectiveStatusQ });
      odocs.forEach(p => {
        const calcStatus = computeStatusFromEnd(p.end);
        if (calcStatus) p.status = calcStatus;
        p.isRenewed = Boolean(p.isRenewed || p.renewed || (p.remarks && /renew/i.test(p.remarks)) || p.nature === 'Renewal');
      });
      if (statusOverride) odocs = odocs.filter(p => matchStatus(p, statusOverride));
      return odocs;
    }

    if (!dimValue) {
      groupBDocs = [];
    } else if (dimField === 'year') {
      groupBDocs = (await fetchOverrideGroup(filter, effectiveStatusQ)).filter(p => {
        const y = p.startYear || (p.start ? new Date(p.start).getFullYear() : null);
        return String(y) === dimValue;
      });
    } else if (dimField === 'status') {
      groupBDocs = await fetchOverrideGroup(filter, dimValue);
    } else if (dimField === 'inst') {
      groupBDocs = await fetchOverrideGroup({ ...filter, inst: { $regex: escapeRegexLiteral(dimValue), $options: 'i' } }, effectiveStatusQ);
    } else if (dimField === 'country') {
      groupBDocs = await fetchOverrideGroup({ ...filter, country: buildExactCaseInsensitiveMatch(dimValue) }, effectiveStatusQ);
    } else if (dimFieldMap[dimField]) {
      groupBDocs = await fetchOverrideGroup({ ...filter, [dimFieldMap[dimField]]: dimValue }, effectiveStatusQ);
    } else {
      groupBDocs = [];
    }

  } else {
    // Fallback to Active vs Inactive
    groupALabel = 'Active'; groupBLabel = 'Inactive';
    groupADocs = docs.filter(p => matchStatus(p, 'Active'));
    groupBDocs = docs.filter(p => matchStatus(p, 'Inactive'));
  }

  const title = `${groupALabel} vs ${groupBLabel} Comparison Report`;
  const periodLabel = (dateFrom || dateTo)
    ? `Report Period: ${dateFrom || 'Earliest'} to ${dateTo || 'Present'}`
    : 'Report Period: All Records';

  const filters = {
    'Comparison Type': compType,
    'Category': cat || 'All',
    'Date From': dateFrom || 'Earliest',
    'Date To': dateTo || 'Present',
    'College / Unit': unit || 'All',
    'Agreement Type': agtype || 'All',
    'Nature': nature || 'All',
    'Region': region || 'All',
    'Country': country || 'All',
    'Institution': inst || 'All',
    'Status Filter': effectiveStatusQ || 'All'
  };

  return {
    title,
    groupA: groupALabel,
    groupB: groupBLabel,
    groupADocs,
    groupBDocs,
    totalA: groupADocs.length,
    totalB: groupBDocs.length,
    totalBoth: groupADocs.length + groupBDocs.length,
    diff: Math.abs(groupADocs.length - groupBDocs.length),
    periodLabel,
    generatedBy: (user && user.name) || 'Administrator',
    generatedDate: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    filters
  };
}

// Distinct real values for a given comparison dimension — powers the
// "Compare Against" picker in the Preview → Compare step. Never hardcoded;
// always read live from the partnerships collection.
const COMPARE_DIMENSION_DB_FIELDS = { country: 'country', inst: 'inst', unit: 'unit', region: 'region', type: 'type', nature: 'nature', cat: 'cat' };
app.get('/api/reports/dimension-values', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const field = req.query.field || 'country';
    if (field === 'status') {
      return res.json({ field, values: ['Active', 'Expiring Soon', 'Expired', 'Inactive'] });
    }
    if (field === 'year') {
      const docs = await db.collection('partnerships').find({}, { projection: { start: 1, startYear: 1 } }).toArray();
      const years = new Set();
      docs.forEach(p => {
        const y = p.startYear || (p.start ? new Date(p.start).getFullYear() : null);
        if (y) years.add(String(y));
      });
      return res.json({ field, values: Array.from(years).sort().reverse() });
    }
    const dbField = COMPARE_DIMENSION_DB_FIELDS[field];
    if (!dbField) return res.status(400).json({ error: 'Invalid comparison field.' });
    let values = await db.collection('partnerships').distinct(dbField);
    values = values.filter(Boolean).sort();
    res.json({ field, values });
  } catch (err) {
    console.error('❌ Dimension values error:', err);
    res.status(500).json({ error: 'Unable to load comparison values right now. Please try again.' });
  }
});

// Comparison Report: JSON preview
app.get('/api/reports/comparison/preview', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const data = await computeComparisonReport(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Generated Comparison Report preview: ${data.title}`);
    // Return JSON-serializable summary (omit full doc arrays for perf, just counts)
    res.json({
      title: data.title,
      groupA: data.groupA,
      groupB: data.groupB,
      totalA: data.totalA,
      totalB: data.totalB,
      totalBoth: data.totalBoth,
      diff: data.diff,
      periodLabel: data.periodLabel,
      generatedBy: data.generatedBy,
      generatedDate: data.generatedDate,
      filters: data.filters,
      // Include limited records for the preview table (max 100 per group)
      groupARecords: data.groupADocs.slice(0, 100),
      groupBRecords: data.groupBDocs.slice(0, 100)
    });
  } catch (err) {
    console.error('❌ Comparison Report preview error:', err);
    res.status(500).json({ error: 'Unable to generate the comparison report preview right now. Please try again.' });
  }
});

// Comparison Report: PDF
app.get('/api/reports/comparison/pdf', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const data = await computeComparisonReport(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported Comparison Report PDF: ${data.title}`);
    renderComparisonReportPdf(res, data);
  } catch (err) {
    console.error('❌ Comparison Report PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate the comparison report PDF right now. Please try again.' });
    else if (!res.writableEnded) res.end();
  }
});

// Comparison Report: Excel
app.get('/api/reports/comparison/excel', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const data = await computeComparisonReport(db, req.query, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported Comparison Report Excel: ${data.title}`);

    const workbook = buildComparisonExcel(data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(data.title)}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('❌ Comparison Report Excel error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate the comparison report Excel export right now. Please try again.' });
    else if (!res.writableEnded) res.end();
  }
});

// ── Multi-Configuration Comparison (2026-09-18) ──────────────────────────────
// The original Compare workflow above (computeComparisonReport) is hardcoded
// to exactly two groups (Group A / Group B) — kept fully intact above for
// backward compatibility (its own dedicated routes/tests are untouched). This
// section adds N-way comparison (2 to MAX_COMPARISON_CONFIGS configurations)
// as an ADDITIVE capability, not a parallel reporting system: each
// configuration is executed through the exact same computeCustomReportData()
// pipeline a single Custom Report Builder report already uses — same filter
// building, same status/date-range semantics, same Country/Unit/etc.
// handling — so no comparison-specific filter logic is duplicated per
// configuration. Configurations are a plain array, iterated over; there is no
// report1/report2-style hardcoding anywhere in this section.
const MAX_COMPARISON_CONFIGS = 5;

/**
 * Runs an array of independent report configurations (each the same shape
 * buildReportQueryParams() sends for a single Custom Report Builder report)
 * through computeCustomReportData(), then derives each configuration's share
 * of the combined total. Configurations never share state — each is passed
 * to computeCustomReportData as its own isolated object.
 */
async function computeMultiComparisonReport(db, configs, user) {
  if (!Array.isArray(configs) || configs.length === 0) {
    throw Object.assign(new Error('At least one comparison configuration is required.'), { status: 400 });
  }
  if (configs.length > MAX_COMPARISON_CONFIGS) {
    throw Object.assign(new Error(`A maximum of ${MAX_COMPARISON_CONFIGS} comparison configurations is supported.`), { status: 400 });
  }

  const results = await Promise.all(configs.map(async (config, idx) => {
    const safeConfig = (config && typeof config === 'object' && !Array.isArray(config)) ? config : {};
    const label = (typeof safeConfig.label === 'string' && safeConfig.label.trim()) || `Comparison ${idx + 1}`;
    const reportResult = await computeCustomReportData(db, safeConfig, user);
    return {
      id: idx,
      label,
      filters: reportResult.filters,
      count: reportResult.totalRecords,
      records: reportResult.records
    };
  }));

  const grandTotal = results.reduce((sum, r) => sum + r.count, 0);
  results.forEach(r => {
    r.percentage = grandTotal > 0 ? Number(((r.count / grandTotal) * 100).toFixed(1)) : 0;
  });

  return {
    title: 'Multi-Configuration Comparison Report',
    generatedBy: (user && user.name) || 'Administrator',
    generatedDate: new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' }),
    grandTotal,
    results
  };
}

/**
 * Parses the `configs` query param (a JSON-encoded array, matching the
 * simple window.open(...) GET-request pattern every other report export in
 * this file already uses) into a safe array of plain-object configurations.
 * Never trusts the parsed shape — a non-array, or a non-object entry, is
 * normalized away rather than allowed to reach computeCustomReportData's
 * query destructuring.
 */
function parseComparisonConfigs(req) {
  let raw = req.query.configs;
  if (typeof raw !== 'string' || !raw) {
    const err = new Error('A configs array is required.');
    err.status = 400;
    throw err;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    const err = new Error('Invalid comparison configuration payload — configs must be valid JSON.');
    err.status = 400;
    throw err;
  }
  if (!Array.isArray(parsed)) {
    const err = new Error('configs must be an array of comparison configurations.');
    err.status = 400;
    throw err;
  }
  return parsed.map(c => (c && typeof c === 'object' && !Array.isArray(c)) ? c : {});
}

// Distinct, cycling color per comparison slot — used by both the multi PDF
// and the frontend chart so a given comparison's color is visually
// consistent-looking across the feature, without hardcoding exactly two.
const MULTI_COMPARISON_COLORS = ['#0a3d91', '#991B1B', '#0ab39c', '#b45309', '#6d28d9'];

function renderMultiComparisonReportPdf(res, { title, results, periodLabel, generatedBy }) {
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(title)}.pdf"`);

  const doc = new PDFDocument({ margin: 36, size: 'A4', layout: 'landscape', bufferPages: true });
  doc.on('error', (err) => {
    console.error('❌ Multi-comparison PDF error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to generate comparison PDF.' });
    else if (!res.writableEnded) res.end();
  });
  res.on('error', (err) => console.error('❌ Multi-comparison PDF response stream error:', err));
  doc.pipe(res);

  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const contentWidth = right - left;
  const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });

  const cspcLogoPath = path.join(__dirname, 'public', 'images', 'cspc.PNG');
  const top = doc.page.margins.top;
  doc.y = top;
  try { doc.image(cspcLogoPath, left, top, { width: 48, height: 48 }); } catch (e) { /* optional */ }
  const cX = left + 48 + 8;
  const cW = contentWidth - 56;
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#000').text('CAMARINES SUR POLYTECHNIC COLLEGES', cX, top, { width: cW, align: 'center' });
  doc.font('Helvetica-Bold').fontSize(9.5).text('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', cX, doc.y, { width: cW, align: 'center' });
  doc.y = Math.max(doc.y, top + 48) + 6;
  doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(2.5).strokeColor('#0a58ca').stroke();
  doc.lineWidth(1).strokeColor('#000');
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(14).fillColor('#000').text(title.toUpperCase(), left, doc.y, { width: contentWidth, align: 'center' });
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8.5).fillColor('#444')
    .text(periodLabel || 'Report Period: All Records', left, doc.y, { width: contentWidth, align: 'center' })
    .text(`Generated ${now} by ${generatedBy}`, left, doc.y, { width: contentWidth, align: 'center' });
  doc.fillColor('#000');
  doc.moveDown(0.8);

  // ── Summary table: Comparison | Partnerships | Percentage — one row per
  // configuration, iterated dynamically (no fixed "Group A/Group B" columns).
  const summaryColW = [contentWidth * 0.5, contentWidth * 0.25, contentWidth * 0.25];
  const summaryHeaders = ['Comparison', 'Partnerships', 'Percentage'];
  const sumHeadY = doc.y;
  doc.rect(left, sumHeadY, contentWidth, 18).fillAndStroke('#0a58ca', '#0a58ca');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff');
  let sx = left;
  summaryHeaders.forEach((h, i) => { doc.text(h, sx + 4, sumHeadY + 5, { width: summaryColW[i] - 8 }); sx += summaryColW[i]; });
  doc.fillColor('#000');
  doc.y = sumHeadY + 18;

  results.forEach((r, idx) => {
    const rowY = doc.y;
    const fill = idx % 2 === 1 ? '#F5F7FA' : '#FFFFFF';
    doc.rect(left, rowY, contentWidth, 18).fill(fill).stroke('#ddd');
    const color = MULTI_COMPARISON_COLORS[idx % MULTI_COMPARISON_COLORS.length];
    let rx = left;
    doc.font('Helvetica-Bold').fontSize(9).fillColor(color).text(r.label, rx + 4, rowY + 4, { width: summaryColW[0] - 8, lineBreak: false, ellipsis: true });
    rx += summaryColW[0];
    doc.font('Helvetica').fillColor('#000').text(String(r.count), rx + 4, rowY + 4, { width: summaryColW[1] - 8 });
    rx += summaryColW[1];
    doc.text(`${r.percentage}%`, rx + 4, rowY + 4, { width: summaryColW[2] - 8 });
    doc.strokeColor('#000');
    doc.y = rowY + 18;
  });
  doc.moveDown(0.8);

  // ── Per-comparison record tables — one section per configuration.
  const COL_DEFS = [
    { key: 'inst', label: 'Institution', width: 175 },
    { key: 'country', label: 'Country', width: 80 },
    { key: 'type', label: 'Type', width: 45 },
    { key: 'unit', label: 'Unit', width: 60 },
    { key: 'start', label: 'Start', width: 75 },
    { key: 'end', label: 'End', width: 75 },
    { key: 'status', label: 'Status', width: 85 }
  ];

  results.forEach((r, idx) => {
    const color = MULTI_COMPARISON_COLORS[idx % MULTI_COMPARISON_COLORS.length];
    if (doc.y + 60 > doc.page.height - doc.page.margins.bottom) { doc.addPage(); doc.y = doc.page.margins.top; }
    const shY = doc.y;
    doc.rect(left, shY, contentWidth, 18).fillAndStroke(color, color);
    doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff')
      .text(`${r.label} (${r.records.length} record${r.records.length !== 1 ? 's' : ''})`, left + 6, shY + 5, { width: contentWidth - 12 });
    doc.fillColor('#000');
    doc.y = shY + 18;

    if (!r.records.length) {
      const emY = doc.y;
      doc.rect(left, emY, contentWidth, 16).stroke();
      doc.font('Helvetica').fontSize(8.5).fillColor('#888').text('No records found for this configuration.', left + 4, emY + 4, { width: contentWidth - 8 });
      doc.fillColor('#000');
      doc.y = emY + 16;
      doc.moveDown(0.4);
      return;
    }

    const chY = doc.y;
    doc.rect(left, chY, contentWidth, 16).fillAndStroke('#1a56c4', '#1a56c4');
    doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff');
    let cx = left;
    COL_DEFS.forEach(col => { doc.text(col.label, cx + 3, chY + 4, { width: col.width - 6, lineBreak: false }); cx += col.width; });
    doc.fillColor('#000');
    doc.y = chY + 16;

    r.records.forEach((p, ridx) => {
      if (doc.y + 16 > doc.page.height - doc.page.margins.bottom) {
        doc.addPage();
        doc.y = doc.page.margins.top;
        const chY2 = doc.y;
        doc.rect(left, chY2, contentWidth, 16).fillAndStroke('#1a56c4', '#1a56c4');
        doc.font('Helvetica-Bold').fontSize(7.5).fillColor('#fff');
        let cx2 = left;
        COL_DEFS.forEach(col => { doc.text(col.label, cx2 + 3, chY2 + 4, { width: col.width - 6, lineBreak: false }); cx2 += col.width; });
        doc.fillColor('#000');
        doc.y = chY2 + 16;
      }
      const rowY = doc.y;
      const fill = ridx % 2 === 0 ? '#FFFFFF' : '#F5F7FA';
      doc.rect(left, rowY, contentWidth, 16).fill(fill).stroke('#ddd');
      doc.font('Helvetica').fontSize(7.5).fillColor('#222');
      let rx = left;
      COL_DEFS.forEach(col => {
        const raw = Array.isArray(p[col.key]) ? p[col.key].join(', ') : p[col.key];
        doc.text(String(raw == null || raw === '' ? '—' : raw), rx + 3, rowY + 4, { width: col.width - 6, lineBreak: false, ellipsis: true });
        rx += col.width;
      });
      doc.strokeColor('#000');
      doc.y = rowY + 16;
    });
    doc.moveDown(0.6);
  });

  const range = doc.bufferedPageRange();
  const savedBM = doc.page.margins.bottom;
  for (let i = range.start; i < range.start + range.count; i++) {
    doc.switchToPage(i);
    doc.page.margins.bottom = 0;
    const footerY = doc.page.height - savedBM + 10;
    doc.font('Helvetica').fontSize(7.5).fillColor('#888')
      .text('CIPRMS — CSPC Center for International Relations and Linkages', left, footerY, { width: contentWidth / 2, lineBreak: false })
      .text(`Page ${i - range.start + 1} of ${range.count}`, left + contentWidth / 2, footerY, { width: contentWidth / 2, align: 'right', lineBreak: false });
    doc.page.margins.bottom = savedBM;
  }
  doc.end();
}

function buildMultiComparisonExcel({ title, results, periodLabel, generatedBy }) {
  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'CIPRMS';
  workbook.created = new Date();

  const summarySheet = workbook.addWorksheet('Comparison Summary');
  const mergedRow = (sheet, text, { bold = false, size = 11, color = 'FF000000', height = 18, endCol = 'C' } = {}) => {
    const row = sheet.addRow([]);
    row.height = height;
    sheet.mergeCells(`A${row.number}:${endCol}${row.number}`);
    const cell = row.getCell(1);
    cell.value = text;
    cell.font = { bold, size, color: { argb: color } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    return row;
  };
  mergedRow(summarySheet, 'CAMARINES SUR POLYTECHNIC COLLEGES', { bold: true, size: 13 });
  mergedRow(summarySheet, 'CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', { bold: true, size: 11, color: 'FF0A3D91' });
  mergedRow(summarySheet, title.toUpperCase(), { bold: true, size: 14, color: 'FF0A58CA', height: 22 });
  mergedRow(summarySheet, periodLabel || 'Report Period: All Records', { size: 9.5, color: 'FF444444' });
  const generatedRow = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  mergedRow(summarySheet, `Generated ${generatedRow} by ${generatedBy}`, { size: 9.5, color: 'FF444444' });
  summarySheet.addRow([]);

  const headerRow = summarySheet.addRow(['Comparison', 'Partnerships', 'Percentage']);
  headerRow.height = 20;
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
    cell.border = CELL_BORDERS;
  });
  results.forEach((r, idx) => {
    const row = summarySheet.addRow([r.label, r.count, `${r.percentage}%`]);
    const fill = idx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
    row.eachCell(cell => {
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = CELL_BORDERS;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
    });
  });
  summarySheet.addRow([]);
  summarySheet.getColumn(1).width = 30;
  summarySheet.getColumn(2).width = 16;
  summarySheet.getColumn(3).width = 16;

  // One dedicated records sheet per comparison configuration — iterated,
  // never hand-written per index, so a 3rd/4th/5th configuration gets a
  // sheet exactly like the 1st and 2nd.
  results.forEach((r, idx) => {
    const safeName = `Cfg ${idx + 1} Records`.slice(0, 31);
    const sheet = workbook.addWorksheet(safeName);
    sheet.columns = PARTNERSHIP_FULL_EXCEL_COLUMNS.map(c => ({ key: c.key, width: c.width }));
    mergedRow(sheet, `${r.label} — ${r.count} record${r.count !== 1 ? 's' : ''}`, { bold: true, size: 12, color: 'FF0A3D91', endCol: excelColLetter(PARTNERSHIP_FULL_EXCEL_COLUMNS.length) });
    sheet.addRow([]);
    const hRow = sheet.addRow(PARTNERSHIP_FULL_EXCEL_COLUMNS.map(c => c.header));
    hRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = CELL_BORDERS;
    });
    r.records.forEach((p, ridx) => {
      const rowValues = PARTNERSHIP_FULL_EXCEL_COLUMNS.reduce((acc, c) => {
        acc[c.key] = Array.isArray(p[c.key]) ? p[c.key].join(', ') : p[c.key];
        return acc;
      }, {});
      const row = sheet.addRow(rowValues);
      const fill = ridx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.border = CELL_BORDERS;
        cell.alignment = { vertical: 'middle' };
      });
    });
  });

  return workbook;
}

app.get('/api/reports/comparison/multi/preview', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const configs = parseComparisonConfigs(req);
    const data = await computeMultiComparisonReport(db, configs, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Generated multi-comparison report (${data.results.length} configurations)`);
    res.json({
      title: data.title,
      generatedBy: data.generatedBy,
      generatedDate: data.generatedDate,
      grandTotal: data.grandTotal,
      results: data.results.map(r => ({
        id: r.id, label: r.label, filters: r.filters, count: r.count, percentage: r.percentage,
        records: r.records.slice(0, 100)
      }))
    });
  } catch (err) {
    console.error('❌ Multi-comparison preview error:', err);
    // err.status === 400 only ever comes from parseComparisonConfigs()'s own deliberate validation
    // throws (see its definition) — those messages are safe and meaningful to show as-is. Anything else
    // is an unexpected failure and must not echo raw internals to the client.
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Unable to generate the multi-comparison report right now. Please try again.' });
  }
});

app.get('/api/reports/comparison/multi/pdf', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const configs = parseComparisonConfigs(req);
    const data = await computeMultiComparisonReport(db, configs, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported multi-comparison report PDF (${data.results.length} configurations)`);
    renderMultiComparisonReportPdf(res, data);
  } catch (err) {
    console.error('❌ Multi-comparison PDF export error:', err);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : 'Unable to generate the multi-comparison report PDF right now. Please try again.' });
    else if (!res.writableEnded) res.end();
  }
});

app.get('/api/reports/comparison/multi/excel', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const configs = parseComparisonConfigs(req);
    const data = await computeMultiComparisonReport(db, configs, req.session.user);
    await logActivity(db, req.session.user, 'VIEW', `Exported multi-comparison report Excel (${data.results.length} configurations)`);
    const workbook = buildMultiComparisonExcel(data);
    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="${safeFilename(data.title)}.xlsx"`);
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('❌ Multi-comparison Excel export error:', err);
    if (!res.headersSent) res.status(err.status || 500).json({ error: err.status ? err.message : 'Unable to generate the multi-comparison Excel export right now. Please try again.' });
    else if (!res.writableEnded) res.end();
  }
});

app.get('/api/reports/activitylog/pdf', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const logs = await db.collection('activitylogs').find(activityLogFilterFor(req.session.user)).sort({ id: -1 }).toArray();
    const now = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const isOwnTrailOnly = req.session.user && req.session.user.role === 'Staff';
    renderTablePdf(res, {
      title: isOwnTrailOnly ? 'My Activity Trail' : 'Activity / Audit Trail', filename: 'Activity_Audit_Log',
      subtitle: `Generated ${now} · ${logs.length} entries`,
      columns: [
        { key: 'action', label: 'Action', width: 50 },
        { key: 'category', label: 'Category', width: 70 },
        { key: 'status', label: 'Status', width: 55 },
        { key: 'record', label: 'Record / Details', width: 200 },
        { key: 'by', label: 'Performed By', width: 100 },
        { key: 'role', label: 'Role', width: 80 },
        { key: 'ip', label: 'IP Address', width: 75 },
        { key: 'date', label: 'Date & Time', width: 100 }
      ],
      rows: logs.map(l => ({ ...l, role: formatRole(l.role), record: displayRoleText(l.record) }))
    });
  } catch (err) {
    console.error('❌ Activity log PDF export error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate the audit trail PDF right now. Please try again.' });
    else if (!res.writableEnded) res.end();
  }
});

app.get('/api/reports/activitylog/excel', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const logs = await db.collection('activitylogs').find(activityLogFilterFor(req.session.user)).sort({ id: -1 }).toArray();
    const isOwnTrailOnly = req.session.user && req.session.user.role === 'Staff';

    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'CIPRMS';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Audit Trail', {
      pageSetup: { orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 }
    });
    const auditCols = 8;
    const auditLastCol = 'H';
    function auditMergedRow(text, { bold = false, size = 10, color = 'FF000000', height = 16, align = 'center' } = {}) {
      const r = sheet.addRow([]);
      r.height = height;
      sheet.mergeCells(`A${r.number}:${auditLastCol}${r.number}`);
      const cell = r.getCell(1);
      cell.value = text;
      cell.font = { bold, size, color: { argb: color } };
      cell.alignment = { horizontal: align, vertical: 'middle' };
      return r;
    }
    auditMergedRow('Republic of the Philippines', { size: 9, color: 'FF444444' });
    auditMergedRow('CAMARINES SUR POLYTECHNIC COLLEGES', { bold: true, size: 13 });
    auditMergedRow('Nabua, Camarines Sur', { size: 9, color: 'FF444444' });
    auditMergedRow('Telephone No. (054) 288-4421 to 23 local 206  |  cspcinternational@cspc.edu.ph', { size: 9, color: 'FF444444' });
    auditMergedRow('CENTER FOR INTERNATIONAL RELATIONS AND LINKAGES', { bold: true, size: 11, color: 'FF0A3D91' });
    auditMergedRow(isOwnTrailOnly ? 'MY ACTIVITY TRAIL' : 'ACTIVITY / AUDIT TRAIL', { bold: true, size: 14, color: 'FF0A58CA', height: 20 });
    const auditNow = new Date().toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
    auditMergedRow(`Generated ${auditNow}  ·  ${logs.length} entries`, { size: 9, color: 'FF444444' });
    sheet.addRow([]);
    sheet.columns = [
      { header: 'Action', key: 'action', width: 14 },
      { header: 'Category', key: 'category', width: 16 },
      { header: 'Status', key: 'status', width: 10 },
      { header: 'Record / Details', key: 'record', width: 48 },
      { header: 'Performed By', key: 'by', width: 20 },
      { header: 'Role', key: 'role', width: 16 },
      { header: 'IP Address', key: 'ip', width: 16 },
      { header: 'Date & Time', key: 'date', width: 20 }
    ];
    // Re-add merged header rows since setting sheet.columns resets row structure;
    // instead, manually set the column header row after the letterhead rows.
    const auditHeaderRow = sheet.addRow(['Action', 'Category', 'Status', 'Record / Details', 'Performed By', 'Role', 'IP Address', 'Date & Time']);
    auditHeaderRow.height = 18;
    auditHeaderRow.eachCell(cell => {
      cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF0A58CA' } };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      cell.border = { top: { style: 'thin', color: { argb: 'FFB7C0CC' } }, left: { style: 'thin', color: { argb: 'FFB7C0CC' } }, bottom: { style: 'thin', color: { argb: 'FFB7C0CC' } }, right: { style: 'thin', color: { argb: 'FFB7C0CC' } } };
    });
    // 2026-10-21: category/status/ip are absent on every pre-existing record — `|| ''` keeps those cells
    // blank (ExcelJS already renders an undefined cell value as blank) rather than printing the literal
    // string "undefined", exactly as every other optional field in this export already behaves.
    const auditDataKeys = ['action', 'category', 'status', 'record', 'by', 'role', 'ip', 'date'];
    logs.forEach((l, idx) => {
      const row = sheet.addRow(auditDataKeys.map(k => k === 'role' ? formatRole(l[k]) : k === 'record' ? displayRoleText(l[k]) : (l[k] || '')));
      const fill = idx % 2 === 1 ? 'FFF5F7FA' : 'FFFFFFFF';
      row.eachCell({ includeEmpty: true }, cell => {
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
        cell.border = { top: { style: 'thin', color: { argb: 'FFB7C0CC' } }, left: { style: 'thin', color: { argb: 'FFB7C0CC' } }, bottom: { style: 'thin', color: { argb: 'FFB7C0CC' } }, right: { style: 'thin', color: { argb: 'FFB7C0CC' } } };
        cell.alignment = { vertical: 'middle' };
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename="Activity_Audit_Log.xlsx"');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('❌ Activity log Excel export error:', err);
    if (!res.headersSent) res.status(500).json({ error: 'Unable to generate the audit trail Excel export right now. Please try again.' });
    else if (!res.writableEnded) res.end();
  }
});

// ── USERS ─────────────────────────────────────────────────────────────────────
// Administrator and Staff share full User Management CRUD (2026-08-27
// full-parity revision) — GET/POST/PATCH/DELETE /api/users are all
// requireStaffAccess. The one preserved boundary: Staff can never
// create/edit/delete an Administrator account or grant the Administrator
// role (see the explicit checks inside POST/PATCH/DELETE below) — a
// deliberate privilege-escalation guard, not an oversight.
app.get('/api/users', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    // Newest account first by default. `createdAt` does exist on this
    // collection, but it's a locale-formatted display string (e.g. "Sep 8,
    // 2026", day-only granularity) set once at account creation in
    // POST /api/users — sorting on it as a string would be chronologically
    // wrong across months/years (e.g. "Dec 1, 2025" would sort after
    // "Jan 1, 2026"). `id` is the auto-incrementing field actually assigned
    // in creation order (same `nextId` pattern as POST /api/users) and is
    // never included in PATCH /api/users/:id's update payload — editing a
    // profile can never move a user in this ordering, only creating a new
    // account can. This also drives users.ejs's User Management table
    // (Administrator + Staff, shared page) and calendar.ejs's recipient
    // picker; the latter had no defined order before this change either, so
    // this only replaces an incidental order with a deterministic one there.
    const docs = await db.collection('users').find({}, { projection: { password: 0 } }).sort({ id: -1 }).toArray();
    // Attach a resolved avatar URL for each user (uploaded → Google → default)
    docs.forEach(d => { d.displayAvatar = avatarUrlFor(d); });
    res.json(docs);
  } catch (err) {
    console.error('❌ Users list error:', err);
    res.status(500).json({ error: 'Unable to load users right now. Please try again.' });
  }
});

const VALID_USER_ROLES = ['Administrator', 'Auth. Personnel', 'Staff', 'potential_partner'];
const VALID_USER_STATUSES = ['Active', 'Inactive'];

// User Management — Administrator and Staff share full CRUD (2026-08-27
// full-parity revision), EXCEPT Staff may never create, edit, or delete an
// Administrator account, nor grant the Administrator role to anyone
// (privilege-escalation boundary — see the three checks below and in
// PATCH/DELETE below; this is the "genuinely security-sensitive" exception
// the spec calls out, preserved deliberately rather than relaxed).
app.post('/api/users', requireStaffAccess, async (req, res) => {
  try {
    const name = (req.body.name || '').trim();
    if (!name) {
      return res.status(400).json({ error: 'Name is required.' });
    }

    // Normalize the same way /signup and Google login do — otherwise an email typed
    // with different casing here silently can never match at login time.
    const email = (req.body.email || '').trim().toLowerCase();
    if (!email) {
      return res.status(400).json({ error: 'Email is required.' });
    }

    const role = req.body.role || 'Staff';
    if (!VALID_USER_ROLES.includes(role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (req.session.user.role === 'Staff' && role === 'Administrator') {
      return res.status(403).json({ error: 'CIRL Staff cannot create Administrator accounts.' });
    }
    const status = req.body.status || 'Active';
    if (!VALID_USER_STATUSES.includes(status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }
    // Optional; validated so a College Dean's request forms always carry a real number.
    const contact = parseContactNumber(req.body.contactNumber);
    if (contact.error) return res.status(400).json({ error: contact.error });

    const db = getDb();
    const existing = await db.collection('users').findOne({ email });
    if (existing) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }

    // Every new account gets its own randomly-generated temporary password unless
    // the admin explicitly typed one — never reuse a single shared default password.
    let tempPassword = null;
    let passwordToStore;
    if (req.body.password) {
      if (!isStrongPassword(req.body.password)) {
        return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
      }
      passwordToStore = await hashPassword(req.body.password);
    } else {
      tempPassword = generateTempPassword();
      passwordToStore = await hashPassword(tempPassword);
    }

    // Strip client-supplied id/_id before spreading req.body — otherwise a
    // caller could override the server-computed id and collide with (or hijack
    // the identity of) an existing user, which every edit/delete/password
    // route looks up by that same id.
    const { id: _clientId, _id: _clientMongoId, avatarUrl: _avatarUrl, googleAvatarUrl: _googleAvatarUrl, ...safeBody } = req.body; // avatarUrl: only via POST /api/profile/avatar; googleAvatarUrl: only via Google sign-in
    // Unit/Department, Institution, Position and Contact Number are no longer asked for on Add User — the account
    // owner supplies them on first sign-in through the activation form (/activate), so a new account always starts
    // with activated: false. They are still accepted here if sent, normalized to an empty string when blank; after
    // activation only User Management's Edit User can change them (not the owner's Settings).
    const entry = await insertWithNextId(db.collection('users'), (nextId) => ({
      id: nextId, ...safeBody, name, email, role, status, activated: false, unit: (req.body.unit || '').trim(),
      institution: typeof req.body.institution === 'string' ? req.body.institution.trim() : '',
      position: typeof req.body.position === 'string' ? req.body.position.trim() : '', contactNumber: contact.value || '', password: passwordToStore, createdAt: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    }));
    await logActivity(db, req.session.user, 'ADD', `User created: ${entry.name} (${entry.role}) — ${entry.email}`);
    await notifyUsers(db, [entry.email], {
      module: 'user',
      tag: 'Account',
      icon: 'ri-user-star-line',
      color: 'primary',
      title: 'Welcome to CIPRMS',
      desc: `Your CIPRMS account has been created with role "${entry.role}". You can now sign in and activate your account.`,
      link: '/activate'
    });
    const { password: _, ...safeEntry } = entry; // don't return the password hash
    // tempPassword is only ever returned this one time so the admin can relay it out-of-band.
    res.json({ success: true, user: safeEntry, tempPassword });
  } catch (err) {
    // The findOne check above is a courtesy, not a guarantee — two
    // near-simultaneous creates for the same email can both pass it before
    // either commits. The unique index on users.email (db.js) is the real
    // guard; code 11000 is Mongo's duplicate-key error, caught here so the
    // race still surfaces as the same clean 400 rather than a raw 500.
    if (err && err.code === 11000) {
      return res.status(400).json({ error: 'An account with this email already exists.' });
    }
    console.error('❌ Add user error:', err);
    res.status(500).json({ error: 'Unable to create the account right now. Please try again.' });
  }
});

app.patch('/api/users/:id', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    // Strip client-supplied id/_id — otherwise the request body could rename
    // this record's identity mid-edit, breaking every route that looks it up
    // by id (delete, password change, this same edit endpoint next time).
    // activated/activatedAt are likewise dropped: only the owner's own activation form (POST /api/activate) sets them, and avatarUrl only the owner's upload.
    const { id: _clientId, _id: _clientMongoId, activated: _activated, activatedAt: _activatedAt, avatarUrl: _avatarUrl, googleAvatarUrl: _googleAvatarUrl, ...updateData } = req.body;

    // Privilege-escalation boundary: Staff can manage every other account,
    // but never an Administrator's (regardless of which fields are being
    // changed — email/password/status edits on an admin account are just as
    // sensitive as a role change) and can never grant the Administrator
    // role to anyone, including themselves.
    if (req.session.user.role === 'Staff') {
      const target = await db.collection('users').findOne({ id });
      if (target && target.role === 'Administrator') {
        return res.status(403).json({ error: 'CIRL Staff cannot modify Administrator accounts.' });
      }
      if (updateData.role === 'Administrator') {
        return res.status(403).json({ error: 'CIRL Staff cannot grant the Administrator role.' });
      }
    }

    if (updateData.name !== undefined) {
      updateData.name = (updateData.name || '').trim();
      if (!updateData.name) {
        return res.status(400).json({ error: 'Name is required.' });
      }
    }
    if (updateData.role !== undefined && !VALID_USER_ROLES.includes(updateData.role)) {
      return res.status(400).json({ error: 'Invalid role.' });
    }
    if (updateData.status !== undefined && !VALID_USER_STATUSES.includes(updateData.status)) {
      return res.status(400).json({ error: 'Invalid status.' });
    }

    // Normalize the same way /signup and Google login do — otherwise an email typed
    // with different casing here silently can never match at login time.
    if (updateData.email !== undefined) {
      const email = (updateData.email || '').trim().toLowerCase();
      if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
      }
      const conflict = await db.collection('users').findOne({ email, id: { $ne: id } });
      if (conflict) {
        return res.status(400).json({ error: 'An account with this email already exists.' });
      }
      updateData.email = email;
    }

    // Unit/Department is optional — if the field was sent at all, normalize it
    // to a trimmed string (never leave it as undefined/null in the update).
    if (updateData.unit !== undefined) {
      updateData.unit = (updateData.unit || '').trim();
    }
    for (const field of ['institution', 'position']) {
      if (updateData[field] !== undefined) updateData[field] = typeof updateData[field] === 'string' ? updateData[field].trim() : '';
    }
    // Contact number: validated like at registration; a non-string is dropped rather than stored.
    if (updateData.contactNumber !== undefined) {
      const contact = parseContactNumber(updateData.contactNumber);
      if (contact.error) return res.status(400).json({ error: contact.error });
      if (contact.value === undefined) delete updateData.contactNumber; else updateData.contactNumber = contact.value;
    }

    // Never let an admin lock everyone out: block deactivating your own account,
    // and block demoting the last remaining Administrator.
    if (req.session.user.id === id && updateData.status === 'Inactive') {
      return res.status(400).json({ error: 'You cannot deactivate your own account.' });
    }
    if (updateData.role !== undefined && updateData.role !== 'Administrator') {
      const target = await db.collection('users').findOne({ id });
      if (target && target.role === 'Administrator') {
        const adminCount = await db.collection('users').countDocuments({ role: 'Administrator' });
        if (adminCount <= 1) {
          return res.status(400).json({ error: 'Cannot remove the last remaining Administrator.' });
        }
      }
    }

    // Only allow password update if explicitly provided (admin setting it via User Management)
    if (!updateData.password) {
      delete updateData.password;
    } else {
      if (!isStrongPassword(updateData.password)) {
        return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
      }
      updateData.password = await hashPassword(updateData.password);
    }
    // Session-version revocation (2026-10 authentication hardening; corrected 2026-10 Phase 1.1 — the real
    // "Edit User" form (views/users.ejs) always resends the account's CURRENT email on every single edit,
    // even when only role/unit/status/etc. changed, pre-filled from the record being edited. The original
    // "was `email` present in the request body" check therefore revoked the target's other sessions on
    // EVERY edit, not just a real email change — contradicts the approved "unrelated edits must not
    // increment it" requirement. Fixed by comparing the submitted (already-normalized, see above) email
    // against the document's OWN current `$email` field — not against a separately-read snapshot, which
    // would leave a race window for a concurrent write to change the email between that read and this
    // write. Doing the comparison inside the SAME aggregation-pipeline update MongoDB evaluates atomically
    // against the document's state at the moment of the write closes that window entirely; a real password
    // reset still always revokes, independent of whether email also changed.
    const newPasswordProvided = updateData.password !== undefined;
    const newEmailProvided = updateData.email !== undefined;
    const emailActuallyChangedExpr = newEmailProvided ? { $ne: ['$email', updateData.email] } : false;
    const sessionVersionExpr = {
      $cond: [
        { $or: [newPasswordProvided, emailActuallyChangedExpr] },
        { $add: [{ $ifNull: ['$sessionVersion', 0] }, 1] },
        { $ifNull: ['$sessionVersion', 0] }
      ]
    };
    await db.collection('users').updateOne({ id }, [
      { $set: { ...updateData, sessionVersion: sessionVersionExpr } }
    ]);
    const updated = await db.collection('users').findOne({ id }, { projection: { password: 0 } });
    if (!updated) return res.status(404).json({ error: 'Not found.' });
    await logActivity(db, req.session.user, 'EDIT', `User updated: ${updated.name} — role: ${updated.role}, status: ${updated.status}`);
    if (updateData.role !== undefined || updateData.status !== undefined) {
      await notifyUsers(db, [updated.email], {
        module: 'user',
        tag: 'Account',
        icon: 'ri-user-settings-line',
        color: 'info',
        title: 'CIPRMS Account Updated',
        desc: `Your account details were updated by an administrator (Role: ${updated.role}, Status: ${updated.status}).`,
        link: '/profile'
      });
    }
    res.json({ success: true, user: updated });
  } catch (err) {
    console.error('❌ Edit user error:', err);
    res.status(500).json({ error: 'Unable to update the account right now. Please try again.' });
  }
});

app.delete('/api/users/:id', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    // Never let an admin lock everyone out: block deleting your own account,
    // and block deleting the last remaining Administrator.
    if (req.session.user.id === id) {
      return res.status(400).json({ error: 'You cannot delete your own account.' });
    }
    const target = await db.collection('users').findOne({ id }, { projection: { password: 0 } });
    // Privilege-escalation boundary: Staff can never delete an Administrator
    // account, regardless of how many Administrators remain.
    if (target && target.role === 'Administrator' && req.session.user.role === 'Staff') {
      return res.status(403).json({ error: 'CIRL Staff cannot delete Administrator accounts.' });
    }
    if (target && target.role === 'Administrator') {
      const adminCount = await db.collection('users').countDocuments({ role: 'Administrator' });
      if (adminCount <= 1) {
        return res.status(400).json({ error: 'Cannot delete the last remaining Administrator.' });
      }
    }
    await db.collection('users').deleteOne({ id });
    deleteUploadedAvatar(target && target.avatarUrl); // their uploaded profile picture goes with the account
    await logActivity(db, req.session.user, 'DELETE', `User deleted: ${target ? target.name + ' (' + target.email + ')' : 'ID #' + id}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Delete user error:', err);
    res.status(500).json({ error: 'Unable to delete the account right now. Please try again.' });
  }
});

// ── ACTIVITY LOGS ─────────────────────────────────────────────────────────────

/**
 * logActivity — server-side helper to write an audit entry.
 *
 * `extra` (2026-10-21, login-attempt audit logging investigation) adds the richer, structured fields the
 * Authentication/Security events below need — category, status, machine-readable `details`, actor/target
 * separation for an attempt where the actor isn't (yet, or ever) a known account, IP and user-agent, and a
 * request-correlation id — WITHOUT changing the shape every existing call site already relies on (`action`,
 * `record`, `by`, `role`, `email`, `date` all stay exactly as they were; every pre-existing caller that omits
 * `extra` gets rows identical to before, and the Audit Trail UI/PDF/Excel exports keep reading those fields
 * unchanged). `timestamp` is new and unconditional: `date` is a locale-formatted STRING (by design, for
 * display), which cannot be sorted or range-filtered as a real date — every date-range filter in this app
 * (Custom Report Builder, Audit Trail) needs an actual Date field, and this collection never had one.
 * @param {object} db   - Mongo db handle
 * @param {object|null} user - req.session.user, or null when no account could be identified (e.g. a failed
 *   login attempt for an email that isn't registered) — never fabricate a user id/name/role for one.
 * @param {string} action - ADD | EDIT | DELETE | APPROVE | REJECT | RENEW | VIEW | LOGIN_SUCCESS | LOGIN_FAILED
 *   | LOGIN_BLOCKED | LOGOUT | FORBIDDEN | ...
 * @param {string} record - human-readable description (unchanged meaning/format from before this change)
 * @param {object} [extra]
 * @param {string} [extra.category] - Authentication | User Management | Partnership | Partnership Request |
 *   Document | Calendar | Report | Security | System
 * @param {string} [extra.status] - success | failure | blocked
 * @param {string} [extra.targetType] - what the action was done to, e.g. 'login_attempt' | 'user' | 'session'
 * @param {string|number} [extra.targetId] - the target's id/email/identifier; for an unresolved login attempt
 *   this is the raw e-mail/username the client submitted, which is safe to store (it's the attempt's own
 *   input, not a confirmation that the account exists) but is NEVER fabricated into a real account reference.
 * @param {object} [extra.details] - small structured context safe to store — e.g. { reason: 'invalid_credentials' }.
 *   NEVER a password, password hash, session secret, or OAuth/API token — nothing in this file ever passes one.
 * @param {string|null} [extra.ip] - see getClientIp(); null when it genuinely could not be determined.
 * @param {string|null} [extra.userAgent] - see getClientUserAgent().
 * @param {string|null} [extra.requestId] - req.sessionID when available; this app has no separate per-request
 *   correlation id, and the session id is already a stable, available way to tie together the few log lines
 *   (e.g. a failed attempt followed by the eventual successful one) one visit produces.
 */
async function logActivity(db, user, action, record, extra) {
  try {
    const e = extra || {};
    // 'System' (the pre-existing, unchanged fallback for every other null-actor call site — an automatic
    // process acted, not a person) would be actively misleading for an Authentication event with no resolved
    // account: nobody and nothing "System" did anything — an unidentified visitor's login attempt failed.
    // Display-only distinction; the real actor is still correctly absent (no id, email or role fabricated).
    const noActorLabel = e.category === 'Authentication' ? 'Unknown' : 'System';
    await insertWithNextId(db.collection('activitylogs'), (nextId) => ({
      id: nextId,
      action,
      record,
      by: user ? user.name : noActorLabel,
      role: user ? user.role : noActorLabel,
      // Added 2026-08-27 (View-Only → Staff migration) so the Audit Trail can
      // scope Staff to their own records by a stable identifier rather than
      // by display name (which is not guaranteed unique). Entries logged
      // before this change have no `email` field — left as-is, a legitimate
      // historical record, not migrated/backfilled.
      email: user ? user.email : null,
      date: new Date().toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric',
        hour: '2-digit', minute: '2-digit'
      }),
      timestamp: new Date(),
      // The fields below are only ever present when a caller passes `extra` — an existing call site that
      // doesn't is completely unaffected (every property here is simply undefined, which the MongoDB driver
      // never writes as a key at all).
      category: e.category,
      status: e.status,
      targetType: e.targetType,
      targetId: e.targetId,
      details: e.details,
      ip: e.ip,
      userAgent: e.userAgent,
      requestId: e.requestId
    }));
  } catch (err) {
    // Deliberately unchanged from the pre-existing behavior every one of the other ~30 call sites already
    // relies on: fail OPEN (console-logged, never thrown) so a transient audit-write hiccup can never block
    // the real user action it's describing — including, now, login itself. This is a considered tradeoff,
    // not an oversight: failing closed on a MongoDB blip would turn a logging outage into a full outage of
    // every login in the building, which is a worse security posture than an occasional missed audit row.
    // See the chat response for this tradeoff spelled out for login specifically.
    console.error('logActivity error:', err.message);
  }
}

// Client IP for audit records AND for every IP-scope lockout key (services/loginLockoutService.js). `app.set
// ('trust proxy', 1)` (see near the top of this file) tells Express to trust exactly the one hop in front of
// it and parse `X-Forwarded-For` only up to that hop — req.ip then already resolves to the real originating
// client address rather than a header any client could forge by sending their own X-Forwarded-For directly.
//
// CF-Connecting-IP preferred over req.ip (2026-10, production lockout-bypass investigation): this app's
// production traffic passes through Cloudflare in front of Render, and Render's own front door adds a
// SECOND, internal hop after Cloudflare before reaching this process — so the real chain is
// "client, cloudflare-edge, render-internal" (3 entries), not the 1 hop trust proxy:1 assumes. req.ip
// (trust proxy:1's resolution) therefore came back as Render's own internal routing address, which changes
// between requests — proven directly from production logs: the SAME browser's OAuth-initiate and
// OAuth-callback requests, seconds apart, resolved to two different private 10.x.x.x addresses, and the
// real client's public IP (consistent across both) was sitting one hop further left in the raw header both
// times. That instability is exactly why IP-scope lockout failures were scattering across multiple keys for
// one real client instead of accumulating against one. Cloudflare's CF-Connecting-IP header is the fix:
// Cloudflare sets it at its own edge from the real TCP connection and overwrites any client-supplied value,
// so unlike counting X-Forwarded-For hops (which breaks again if Render's internal hop count ever changes),
// it is both stable and cannot be spoofed past Cloudflare. net.isIP(...) !== 0 validates it's a real
// address (not some other string) before trusting it. Falls through to the pre-existing trust-proxy
// resolution — unchanged below — for any request that doesn't carry it (local dev, tests, direct access).
//
// Normalized to plain IPv4 when a resolved address is the IPv4-mapped-IPv6 form (2026-10 lockout-bypass
// fix): Node/Cloudflare can represent the SAME real client as either "1.2.3.4" or "::ffff:1.2.3.4" depending
// on connection-level details outside this app's control — proven directly in this project's own environment
// (test/helpers.js's TEST_LOOPBACK_IPS lists all 3 forms ['::1', '::ffff:127.0.0.1', '127.0.0.1'] observed
// for ONE loopback connection). Without normalizing, services/loginLockoutService.js would key the SAME real
// IP's failures under two different strings, splitting what should be one shared lockout — reproduced
// directly: 5 failures recorded under "127.0.0.1" left "::ffff:127.0.0.1" reporting not-locked. Only a
// well-formed IPv4-mapped form is rewritten (net.isIPv4 validates the extracted octets, not just the string
// shape) — a genuine IPv6 address, or a missing value, passes through unchanged. Applied uniformly to BOTH
// the CF-Connecting-IP and the trust-proxy-resolved branches below (not just the latter) — CF-Connecting-IP
// is normally a clean dotted-quad or standard IPv6 form, but nothing about the header's contract rules out
// the same mapped-form variance req.ip already demonstrated, and this is a one-line guard against that exact
// class of bug recurring in a new place. trust proxy itself is untouched; this only canonicalizes values
// Express/Cloudflare already resolved.
function normalizeIpv4MappedIpv6(ip) {
  if (typeof ip !== 'string' || !ip) return null;
  const match = /^::ffff:(.+)$/i.exec(ip);
  return (match && net.isIPv4(match[1])) ? match[1] : ip;
}

function getClientIp(req) {
  const cfConnectingIp = req && req.headers && req.headers['cf-connecting-ip'];
  if (typeof cfConnectingIp === 'string') {
    const trimmed = cfConnectingIp.trim();
    if (net.isIP(trimmed) !== 0) return normalizeIpv4MappedIpv6(trimmed);
  }
  return normalizeIpv4MappedIpv6(req && req.ip);
}

// Capped to a sane length — User-Agent is client-supplied and unbounded; a hostile or malformed client
// sending a huge one should not be able to bloat an audit record.
function getClientUserAgent(req) {
  const ua = req && req.get && req.get('user-agent');
  return typeof ua === 'string' && ua ? ua.slice(0, 300) : null;
}

// A login attempt's own submitted identifier is safe to store (it's the attempt's input, not proof an account
// exists), but must never be more than a short, plain string — never the object a NoSQL-injection attempt
// would submit instead of a string, and never unbounded.
function safeLoginIdentifier(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 200) : null;
}

// Audit Trail visibility boundary: Administrator sees every record
// (unfiltered); Staff sees ONLY their own — enforced here at the query
// level (not just hidden in the UI) and reused by every Audit Trail data
// source (JSON, PDF, Excel) so none of them can drift out of sync.
function activityLogFilterFor(user) {
  if (user && user.role === 'Staff') return { email: user.email };
  return {};
}

/**
 * notifyUsers — shared helper for inserting one targeted notification per
 * recipient. Every notification-producing route in this file (request
 * decisions, document uploads, new-submission alerts, calendar events) reuses
 * this instead of re-deriving the next `id` and repeating the same insertOne
 * shape at each call site.
 * @param {object} db
 * @param {string[]} emails - target recipient emails (deduped, falsy entries dropped)
 * @param {object} payload - { module, tag, icon, color, title, desc, link, downloadLink }
 */
async function notifyUsers(db, emails, payload) {
  return notificationService.createNotification(db, {
    recipients: emails,
    ...(payload || {})
  });
}

// E-mail receipt to the person who just submitted a request, at the address they signed in with — e-mail only (the
// submitter has always been left out of the in-app broadcast about their own submission). In the background, never
// blocking the submission.
function emailSubmissionReceipt(user, payload) {
  if (!user || !user.email) return;
  emailService.sendNotificationEmails([user.email], payload).catch(err => console.error('receipt e-mail failed:', err.message));
}

// Reviewer broadcasts (REQUEST_REVIEWER_ROLES = Administrator + Staff) can't
// share one `link` — Administrator's review queue is /partnership-requests,
// but Staff's is /staff/requests, a different route the Administrator-shaped
// link 403s on. Groups the mixed reviewer list by role and sends one
// notifyUsers batch per role, each with that role's own resolved link
// (via prLinkForRole/drLinkForRole).
async function notifyReviewers(db, reviewers, payloadBase, linkForRole) {
  const emailsByRole = new Map();
  for (const u of reviewers) {
    if (!u.email) continue;
    if (!emailsByRole.has(u.role)) emailsByRole.set(u.role, []);
    emailsByRole.get(u.role).push(u.email);
  }
  for (const [role, emails] of emailsByRole) {
    await notifyUsers(db, emails, { ...payloadBase, link: linkForRole(role) });
  }
}

// ── REALTIME (Server-Sent Events) ─────────────────────────────────────────────
// Routes below carry announce('<topic>'): once the handler has answered SUCCESSFULLY (so the database change is already
// committed) the change is published to exactly the connected users allowed to know about it. See services/realtime.js
// for the transport rules. Events are small hints ({ id, status, action }); a page re-reads the data it shows through the
// normal RBAC-checked endpoints, so this channel can never show anyone more than they could already fetch.
const REQUEST_EVENT_ACTIONS = {           // [action, is it a status transition?]
  'POST /api/requests': ['created', true],
  'PATCH /api/requests/:id/edit': ['edited', false],
  'POST /api/requests/:id/submit': ['submitted', true],
  'DELETE /api/requests/:id': ['draftDeleted', false],
  'PATCH /api/requests/:id': ['reviewed', true],
  'POST /api/requests/:id/documents': ['documentAdded', false],
  'POST /api/partnerships/:id/renew-request': ['renewalRequested', true]
};
const DOCUMENT_REQUEST_EVENT_ACTIONS = {
  'POST /api/document-requests': ['created', true],
  'DELETE /api/document-requests/:id': ['deleted', false],
  'PATCH /api/document-requests/:id': ['statusChanged', true],
  'POST /api/document-requests/:id/documents': ['documentAdded', false]
};
const PARTNERSHIP_EVENT_ACTIONS = { 'POST': 'created', 'PATCH': 'updated', 'DELETE': 'deleted' };

// Who may know about a partnership change: the reviewers/registry managers, plus the accounts whose own APPROVED request
// is tied to that institution — the same ownership rule as GET /api/partnerships/mine.
async function partnershipAudience(db, institution) {
  const staff = realtime.audience.roles(REQUEST_REVIEWER_ROLES);
  if (!institution) return staff;
  const pattern = new RegExp('^' + String(institution).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
  const owners = await db.collection('requests').find({ status: 'Approved', isSubmission: { $ne: true }, institution: pattern }).project({ submittedByEmail: 1 }).toArray();
  return realtime.audience.merge(staff, realtime.audience.emails(owners.map(o => o.submittedByEmail)));
}

// Mirrors GET /api/calendarevents: Administrator sees every event; CIRL Staff also see an event with no recipient list, one
// that names them, or one they created; College Dean and Partners only see an event that names them or is for "All Users".
function calendarAudience(ev) {
  if (!ev) return realtime.audience.roles(['Administrator']);
  if (ev.forEveryone) return realtime.audience.all();
  const invited = [...(ev.recipientEmails || []), ...(ev.participantEmails || []), ...(ev.googleAttendeeEmails || []), ev.createdByEmail];
  const staffRoles = Array.isArray(ev.recipientEmails) ? ['Administrator'] : ['Administrator', 'Staff'];
  return realtime.audience.merge(realtime.audience.roles(staffRoles), realtime.audience.emails(invited));
}

async function publishChange(topic, req, body, prior) {
  if (!realtime.hasClients()) return;
  const db = getDb();
  const actor = req.session && req.session.user;
  const key = req.method + ' ' + (req.route && req.route.path);
  const paramId = parseInt(req.params && req.params.id, 10);
  const reviewers = realtime.audience.roles(REQUEST_REVIEWER_ROLES);

  if (topic === 'request') {
    const [action, isStatus] = REQUEST_EVENT_ACTIONS[key] || ['updated', false];
    const doc = body && body.request ? body.request : null;
    const owner = doc ? doc.submittedByEmail : (actor && actor.email);
    realtime.publish(isStatus ? 'request.statusChanged' : 'request.updated',
      { id: doc ? doc.id : paramId, status: doc ? doc.status : null, action, renewal: !!(doc && doc.isRenewal) },
      realtime.audience.merge(reviewers, realtime.audience.emails([owner])));
    // approving a renewal request extends the linked partnership
    if (key === 'PATCH /api/requests/:id' && doc && doc.status === 'Approved' && doc.isRenewal && doc.renewalPartnershipId) {
      realtime.publish('partnership.statusChanged', { id: doc.renewalPartnershipId, action: 'renewed' }, await partnershipAudience(db, doc.institution));
    }
  } else if (topic === 'documentRequest') {
    const [action, isStatus] = DOCUMENT_REQUEST_EVENT_ACTIONS[key] || ['updated', false];
    const doc = body && body.request ? body.request : null;
    const owner = doc ? doc.requestedByEmail : (actor && actor.email);
    realtime.publish(isStatus ? 'documentRequest.statusChanged' : 'documentRequest.updated',
      { id: doc ? doc.id : paramId, status: doc ? doc.status : null, action },
      realtime.audience.merge(reviewers, realtime.audience.emails([owner])));
  } else if (topic === 'partnership') {
    const doc = (body && body.partnership) || prior;
    const action = PARTNERSHIP_EVENT_ACTIONS[req.method] || 'updated';
    realtime.publish('partnership.updated', { id: doc ? doc.id : paramId, action },
      realtime.audience.merge(await partnershipAudience(db, doc && doc.inst), prior && prior.inst !== (doc && doc.inst) ? await partnershipAudience(db, prior.inst) : null));
    // "Add to Registry" from an approved request also finalises that request
    if (req.method === 'POST' && req.body && req.body.sourceRequestId) {
      const src = await db.collection('requests').findOne({ id: parseInt(req.body.sourceRequestId, 10) });
      if (src) realtime.publish('request.statusChanged', { id: src.id, status: src.status, action: 'convertedToRegistry', renewal: !!src.isRenewal },
        realtime.audience.merge(reviewers, realtime.audience.emails([src.submittedByEmail])));
    }
  } else if (topic === 'calendar') {
    if (key === 'POST /api/calendarevents/:id/join') {
      realtime.publish('calendar.updated', { id: paramId, action: 'joined' }, realtime.audience.merge(reviewers, realtime.audience.emails([actor && actor.email])));
    } else if (req.method === 'DELETE') {
      realtime.publish('calendar.deleted', { id: paramId }, calendarAudience(prior));
    } else {
      const id = body && body.event ? body.event.id : paramId;
      const ev = await db.collection('calendarevents').findOne({ id });
      realtime.publish('calendar.updated', { id, action: req.method === 'POST' ? 'created' : 'updated' }, calendarAudience(ev));
    }
  } else if (topic === 'document') {
    // Document Library visibility is own-uploads-only even for Administrator/Staff (GET /api/documents scopes by
    // uploadedByEmail — see OWN_SCOPE_ROLES) — the live update follows the exact same boundary: only the uploader's
    // own open Library page needs to know one of ITS rows changed (e.g. a Nature-of-Partnership filter button that
    // should now appear/disappear). This never widens who can see a document, only keeps what a page already shows
    // in sync with the database, same as every other announce() topic.
    const doc = body && body.document;
    if (doc && doc.uploadedByEmail) {
      realtime.publish('document.updated', { id: doc.id, action: req.method === 'POST' ? 'created' : 'updated' }, realtime.audience.emails([doc.uploadedByEmail]));
    }
  } else if (topic === 'notificationState' && actor) {
    const mine = realtime.audience.emails([actor.email]);
    if (req.method === 'DELETE') realtime.publish('notification.deleted', { id: paramId }, mine);
    else realtime.publish('notification.read', Number.isInteger(paramId) ? { id: paramId } : { all: true }, mine);
  }
}

/**
 * Route middleware. Wraps res.json so that, only when the handler answered successfully, the change is announced. `prior`
 * (optional) loads the record BEFORE the handler runs — needed when the handler deletes it and the audience depends on it.
 */
function announce(topic, opts = {}) {
  return async (req, res, next) => {
    let prior = null;
    if (opts.prior) { try { prior = await opts.prior(req); } catch (_) { /* audience falls back to the safe default */ } }
    const send = res.json.bind(res);
    res.json = (body) => {
      const out = send(body);
      if (res.statusCode < 400 && !(body && body.success === false)) {
        publishChange(topic, req, body, prior).catch(err => console.error('realtime announce failed:', err.message));
      }
      return out;
    };
    next();
  };
}
function priorPartnership(req) { return getDb().collection('partnerships').findOne({ id: parseInt(req.params.id, 10) }); }
function priorCalendarEvent(req) { return getDb().collection('calendarevents').findOne({ id: parseInt(req.params.id, 10) }); }

// A user's own new notification goes to that user only, in the same shape /api/notifications/mine returns it.
async function publishNewNotifications(db, docs) {
  if (!realtime.hasClients() || !docs.length) return;
  const users = await db.collection('users').find({ email: { $in: docs.map(d => d.targetEmail) } }).project({ email: 1, role: 1 }).toArray();
  const roleOf = new Map(users.map(u => [String(u.email).toLowerCase(), u.role]));
  for (const d of docs) {
    const [view] = withNotificationHref([d], roleOf.get(String(d.targetEmail).toLowerCase()));
    realtime.publish('notification.created', { notification: view }, realtime.audience.emails([d.targetEmail]));
  }
}
notificationService.setPublishNotificationsHandler(publishNewNotifications);

// GET /api/realtime/stream — the browser's EventSource. Signed-in users only; it is bound to the account that opened it
// (and the page says which account it believes it is, so a stale tab of another login is refused). It only ever RECEIVES.
app.get('/api/realtime/stream', (req, res) => {
  const user = req.session && req.session.user;
  if (!user) return res.status(401).json({ error: 'Your session has expired. Please sign in again.', code: 'UNAUTHENTICATED' });
  if (req.query.uid !== undefined && String(req.query.uid) !== String(user.id)) {
    return res.status(409).json({ error: 'This page belongs to a different sign-in.', code: 'USER_MISMATCH' });
  }
  realtime.connect(req, res, user);
});
realtime.setRevalidator(async (client) => {
  const dbUser = await getDb().collection('users').findOne({ id: client.user.id }, { projection: { status: 1, role: 1, email: 1 } });
  if (!dbUser || dbUser.status === 'Inactive' || dbUser.role !== client.user.role || dbUser.email !== client.user.email) return false;
  const stored = await new Promise(resolve => sessionStore.get(client.sessionID, (err, sess) => resolve(err ? { user: true } : sess)));
  return !!(stored && stored.user);
});

// documentLibraryService.shortDocType() classifies by matching words like
// "agreement"/"understanding" in a free-form OCR guess — short codes like
// "MOA"/"MOU" don't contain those words, so this expands them to a
// descriptive phrase first, keeping the Document Library entry correctly
// typed instead of always falling through to "Other".
const DOC_TYPE_LABELS = {
  MOA: 'Memorandum of Agreement',
  MOU: 'Memorandum of Understanding',
  LOI: 'Letter of Intent',
  JVA: 'Joint Venture Agreement',
  Accreditation: 'Accreditation'
};
function expandDocTypeLabel(shortCode) {
  return DOC_TYPE_LABELS[shortCode] || shortCode;
}

/**
 * Picks the right "Request Details" destination for a Partnership Request
 * notification based on the submitter's own role — Administrator has the
 * shared review modal (deep-linkable by id), while potential_partner and
 * Staff each only have their own plain request-tracking list (no
 * per-request modal exists there today), so those link at the page level.
 */
// ── Where a notification click goes ─────────────────────────────────────────────────────────────────────────
// A notification stores the link that was right for its recipient's role WHEN IT WAS CREATED. Clicking that
// stored link later went wrong whenever the route no longer suited the reader: an old "/calendar" link opened
// by CIRL Staff (requirePersonnel bounces them to their home = the Dashboard), a removed page such as
// /viewonly/request-access (404), a College Dean "partnership request" link (that role has no Partnership
// Request page any more) or a Partner "document request" link (Monitoring has no such table any more, so the
// click just landed on the Monitoring home). notificationHref() re-resolves the destination for the role that is
// actually reading it, from the stored link/module/tag, and only ever returns a page that role can open. The
// stored `link` is left untouched. It is derived from the caller's own notification only and contains nothing
// but an allow-listed path plus a numeric id, so it can neither point off-site nor at another user's request
// (the destination pages still authorize every record they load).
const NOTIFICATION_PAGES = {
  'Administrator': { fallback: '/notifications', dashboard: '/dashboard', requests: '/partnership-requests', calendar: '/calendar', monitoring: '/lifecycle' },
  'Staff': { fallback: '/staff/notifications', dashboard: '/staff/dashboard', requests: '/staff/requests', calendar: '/staff/calendar', monitoring: '/staff/lifecycle' },
  'Auth. Personnel': { fallback: '/personnel/monitoring', requests: '/personnel/requests', calendar: '/personnel/calendar', monitoring: '/personnel/monitoring' },
  'potential_partner': { fallback: '/partner/monitoring', requests: '/partner/requests', calendar: '/partner/calendar', monitoring: '/partner/monitoring' }
};
const NOTIFICATION_LINK_KINDS = [
  [/^\/(?:staff\/|personnel\/|partner\/)?calendar$/, 'calendar'],
  [/^\/(?:partnership-requests|staff\/requests|personnel\/requests|partner\/requests|viewonly\/request-access)$/, 'requests'],
  [/^\/(?:lifecycle|registry|staff\/lifecycle|staff\/registry|personnel\/lifecycle|personnel\/monitoring|partner\/monitoring)$/, 'monitoring'],
  [/^\/(?:staff\/|personnel\/|partner\/)?dashboard$/, 'dashboard']
];
function notificationHref(role, n) {
  const pages = NOTIFICATION_PAGES[role];
  if (!pages || !n) return null;
  let path = '', params = new URLSearchParams();
  if (typeof n.link === 'string' && n.link.startsWith('/') && !n.link.startsWith('//') && !n.link.includes('\\')) {
    try { const u = new URL(n.link, 'http://internal.invalid'); path = u.pathname; params = u.searchParams; } catch (_) { /* unparseable: fall back to module/tag */ }
  }
  let kind = null;
  for (const [re, k] of NOTIFICATION_LINK_KINDS) if (re.test(path)) { kind = k; break; }
  // The notification's own module says what it is about. It fills in a missing/unknown link, and it also
  // overrides a link that points at a Dashboard (an old link, or another role's home) for a request/calendar item.
  const moduleKind = n.module === 'calendar' ? 'calendar'
    : (n.module === 'request' || n.module === 'requests') ? 'requests'
      : ['lifecycle', 'registry'].includes(n.module) ? 'monitoring'
        : n.module === 'dashboard' ? 'dashboard' : null;
  if (!kind || (kind === 'dashboard' && moduleKind && moduleKind !== 'dashboard')) kind = moduleKind || kind;
  const rawId = params.get('id');
  const id = rawId && /^\d+$/.test(rawId) ? rawId : null;
  if (kind === 'calendar') return pages.calendar + (id ? '?id=' + id : '');

  // Partnership (pr) vs Document (dr) request — from the link's own marker, else the notification's tag
  let reqKind = params.get('open') || params.get('type');
  if (reqKind !== 'pr' && reqKind !== 'dr') reqKind = /partnership/i.test(n.tag || '') ? 'pr' : /document/i.test(n.tag || '') ? 'dr' : null;
  if ((kind === 'requests' || kind === 'monitoring') && reqKind) {
    if ((role === 'Administrator' || role === 'Staff') && id) return pages.requests + '?open=' + reqKind + '&id=' + id;
    if (role === 'Auth. Personnel' && id) return reqKind === 'dr' ? pages.monitoring + '?type=dr&id=' + id : pages.monitoring;   // no Partnership Request page for College Dean
    if (role === 'potential_partner') {
      if (reqKind === 'dr') return pages.requests + '?tab=dr';                       // MOA/MOU submissions live on the Requests page itself
      if (id) return pages.monitoring + '?type=pr&id=' + id;
    }
  }
  if (kind === 'requests') return pages.requests;
  if (kind === 'monitoring') return pages.monitoring;
  // Administrator and CIRL Staff still have a real Dashboard; College Dean and Partner do not (Monitoring is their home)
  if (kind === 'dashboard') return pages.dashboard || pages.monitoring;
  return pages.fallback;
}
// Very important notifications are shown with a red flag (header bell and Notifications page), for every role:
// anything marked red ("danger": expired agreements, rejected / declined requests, cancelled events, critical items) and
// the "expiring soon" partnership reminders. Routine updates (new request, approved, awaiting approval…) are not
// flagged. A notification can also be flagged explicitly by saving it with `priority: true`.
function isPriorityNotification(n) {
  if (!n) return false;
  if (n.priority === true) return true;
  if (n.color === 'danger') return true;
  return n.module === 'lifecycle' && n.color === 'warning';
}

function withNotificationHref(docs, role) {
  return docs.map(d => ({ ...d, href: notificationHref(role, d), priority: isPriorityNotification(d) }));
}

function prLinkForRole(role, id) {
  if (role === 'Administrator') return '/partnership-requests?open=pr&id=' + id;
  // potential_partner's own request tracking moved from the Requests page onto
  // Monitoring (2026-07-23) — the Requests page now only holds the submission
  // forms, not a history table to highlight a row in. `type=pr` disambiguates
  // from a Document Request's `id`, since the two collections' ids are not
  // unique with respect to each other.
  if (role === 'potential_partner') return '/partner/monitoring?type=pr&id=' + id;
  // Staff can no longer submit new Partnership Requests (2026-08-27) but may
  // still have historical ones from before that change, and also reviews
  // everyone else's (REQUEST_REVIEWER_ROLES) — both land on the same
  // Administrator-shaped review page at a Staff-scoped route, so it needs
  // the same open=pr deep-link param or the modal never opens.
  if (role === 'Staff') return '/staff/requests?open=pr&id=' + id;
  // Auth. Personnel's tracking moved from the Requests page onto its own
  // Monitoring page (2026-07-25), matching the potential_partner convention
  // above — the Requests page now only holds the submission forms.
  if (role === 'Auth. Personnel') return '/personnel/monitoring?type=pr&id=' + id;
  return '/partnership-requests?open=pr&id=' + id;
}

// Same per-role deep-link resolution as prLinkForRole, for Document Request
// notifications. potential_partner gained Document Requests 2026-07-22, and
// its tracking also lives on Monitoring (never a page of its own).
function drLinkForRole(role, id) {
  if (role === 'Administrator') return '/partnership-requests?open=dr&id=' + id;
  // Partner document requests are MOA/MOU submissions, tracked nowhere but the Requests page itself
  if (role === 'potential_partner') return '/partner/requests?tab=dr';
  // Staff never submits Document Requests (requireRequester excludes Staff)
  // but does review them as a REQUEST_REVIEWER_ROLES member, same
  // Staff-scoped review route as prLinkForRole's Staff branch above.
  if (role === 'Staff') return '/staff/requests?open=dr&id=' + id;
  // Auth. Personnel is the only other role that submits Document Requests
  // — tracking lives on their Monitoring page (2026-07-25), matching the
  // potential_partner convention above.
  return '/personnel/monitoring?type=dr&id=' + id;
}

// ── LIFECYCLE AUTOMATION — status computation & notification generation ──────
const LIFECYCLE_EXPIRING_WINDOW_DAYS = 90;
const LIFECYCLE_CHECK_INTERVAL_MS = parseInt(process.env.LIFECYCLE_CHECK_INTERVAL_MS, 10) || 60 * 60 * 1000; // hourly by default

/**
 * Derives a partnership's status purely from its end date — the SINGLE authoritative rule for every part of
 * the app that computes a status rather than reading one already stored (Reports & Analytics, the Dashboard
 * widget, this file's hourly lifecycle job, and every client-side computeStatus/computeEditStatus/
 * computeRenewStatus in lifecycle-gridjs.init.js and registry-gridjs.init.js — all independently written but
 * all already using this same boundary; see the 2026-11 Phase 2 fix note below for the one place that didn't).
 *
 * Agreed day boundaries (days = ceil((end date) − (now), in days)):
 *   days > 90   → Active
 *   0 < days <= 90  → Expiring Soon   (includes the day before expiry, days === 1)
 *   days === 0  → Expiring Soon   (the expiry date itself — still counted as not yet expired for the
 *                                  whole of that day; it only becomes Expired once that date is in the past)
 *   days < 0    → Expired         (the day after expiry onward)
 */
function computeStatusFromEnd(endStr) {
  const end = new Date(endStr);
  if (isNaN(end)) return null; // unparseable/missing end date — leave the record alone
  const daysLeft = Math.ceil((end - new Date()) / 86400000);
  if (daysLeft < 0) return 'Expired';
  if (daysLeft <= LIFECYCLE_EXPIRING_WINDOW_DAYS) return 'Expiring Soon';
  return 'Active';
}

/**
 * Recomputes every partnership's status from its end date and creates a
 * notification the first time a record newly becomes Expiring Soon or Expired.
 * `lastNotifiedStatus` (stored on the partnership doc) prevents re-notifying on
 * every run for a record that's already been flagged and hasn't changed since —
 * it's cleared once the partnership returns to Active (e.g. after a renewal),
 * so a future re-expiry notifies again.
 */
async function recomputePartnershipStatuses(db) {
  const partnerships = await db.collection('partnerships').find({}).toArray();
  const toNotify = [];

  for (const p of partnerships) {
    const newStatus = computeStatusFromEnd(p.end);
    if (!newStatus) continue;

    const updates = {};
    if (newStatus !== p.status) updates.status = newStatus;

    if (newStatus === 'Active') {
      if (p.lastNotifiedStatus) updates.lastNotifiedStatus = null;
    } else if (p.lastNotifiedStatus !== newStatus) {
      updates.lastNotifiedStatus = newStatus;
      toNotify.push({ partnership: p, status: newStatus });
    }

    if (Object.keys(updates).length) {
      await db.collection('partnerships').updateOne({ id: p.id }, { $set: updates });
    }
  }

  if (toNotify.length) {
    const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

    // insertManyWithNextId() reserves the whole block in one round trip and this job's own batch is never
    // the only writer of this collection (notificationService.createNotification(), called a few lines below
    // for the reviewer broadcast, writes here independently and can interleave with it) — exactly the
    // partial-batch-collision case that helper's own retry handles by re-trying only whichever docs lost that
    // race, not the whole batch again.
    await insertManyWithNextId(db.collection('notifications'), toNotify.length, (id, i) => {
      const { partnership: p, status } = toNotify[i];
      const isExpired = status === 'Expired';
      return {
        id,
        module: 'lifecycle',
        tag: 'Lifecycle',
        unread: true,
        icon: isExpired ? 'ri-close-circle-line' : 'ri-alarm-warning-line',
        color: isExpired ? 'danger' : 'warning',
        title: isExpired ? `Partnership Expired: ${p.inst}` : `Partnership Expiring Soon: ${p.inst}`,
        desc: isExpired
          ? `The agreement with ${p.inst}${p.country ? ' (' + p.country + ')' : ''} expired on ${p.end}. Renewal or archival action is needed.`
          : `The agreement with ${p.inst}${p.country ? ' (' + p.country + ')' : ''} is expiring on ${p.end}. Consider initiating renewal.`,
        time: today
      };
    });

    for (const item of toNotify) {
      const isExpired = item.status === 'Expired';
      await notifyUsers(db, REQUEST_REVIEWER_ROLES, {
        module: 'lifecycle',
        tag: 'Lifecycle',
        icon: isExpired ? 'ri-close-circle-line' : 'ri-alarm-warning-line',
        color: isExpired ? 'danger' : 'warning',
        title: isExpired ? `Partnership Expired: ${item.partnership.inst}` : `Partnership Expiring Soon: ${item.partnership.inst}`,
        desc: isExpired
          ? `The agreement with ${item.partnership.inst}${item.partnership.country ? ' (' + item.partnership.country + ')' : ''} expired on ${item.partnership.end}. Renewal or archival action is needed.`
          : `The agreement with ${item.partnership.inst}${item.partnership.country ? ' (' + item.partnership.country + ')' : ''} is expiring on ${item.partnership.end}. Consider initiating renewal.`,
        link: '/lifecycle'
      });
    }

    const expiredCount = toNotify.filter(t => t.status === 'Expired').length;
    const expiringCount = toNotify.length - expiredCount;
    await logActivity(db, null, 'EDIT',
      `Automatic lifecycle check: ${toNotify.length} partnership(s) flagged (${expiringCount} newly expiring, ${expiredCount} newly expired)`);
  }

  return toNotify.length;
}

// ── PARTNERSHIP EXPIRATION EMAIL NOTIFICATION ENGINE ─────────────────────────
const EXPIRATION_MILESTONES = [90, 60, 30, 15];

function isExpirationNotificationDay(daysRemaining) {
  if (typeof daysRemaining !== 'number' || isNaN(daysRemaining)) return false;
  if (EXPIRATION_MILESTONES.includes(daysRemaining)) return true;
  if (daysRemaining >= 0 && daysRemaining <= 15) return true;
  return false;
}

function calculateDaysRemaining(endStr, now = new Date()) {
  const parsedEnd = parseLocalDate(endStr, false);
  if (!parsedEnd) return null;
  const todayMidnight = parseLocalDate(now, false);
  if (!todayMidnight) return null;
  return Math.round((parsedEnd.getTime() - todayMidnight.getTime()) / (24 * 60 * 60 * 1000));
}

async function getPartnershipEmailRecipients(db, partnership) {
  const reviewers = await db.collection('users').find({
    role: { $in: REQUEST_REVIEWER_ROLES },
    status: { $ne: 'Inactive' }
  }, { projection: { email: 1 } }).toArray();

  const recipientEmails = new Set(reviewers.map(u => u.email).filter(Boolean));

  if (partnership.partnerEmail) {
    recipientEmails.add(partnership.partnerEmail);
  }

  if (partnership.coordinator && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(partnership.coordinator.trim())) {
    recipientEmails.add(partnership.coordinator.trim());
  }

  if (partnership.inst) {
    const pattern = new RegExp('^' + String(partnership.inst).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    const owners = await db.collection('requests').find(
      { status: 'Approved', isSubmission: { $ne: true }, institution: pattern },
      { projection: { submittedByEmail: 1 } }
    ).toArray();
    for (const o of owners) {
      if (o.submittedByEmail) recipientEmails.add(o.submittedByEmail);
    }
  }

  return [...recipientEmails]
    .map(e => String(e).trim().toLowerCase())
    .filter(e => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e));
}

function formatExpirationEmailPayload(partnership, daysRemaining) {
  const instName = partnership.inst || 'Partnership';
  const type = partnership.type || 'MOA/MOU';
  const natures = Array.isArray(partnership.nature) ? partnership.nature.join(', ') : (partnership.nature || 'N/A');
  const endDate = partnership.end || 'N/A';

  let title = '';
  let desc = '';
  let urgency = 'Notice';

  if (daysRemaining === 0) {
    urgency = 'Final Notice';
    title = `[Final Notice] Partnership Expires Today: ${instName}`;
    desc = `The ${type} agreement with ${instName} (${partnership.country ? partnership.country + ' · ' : ''}Nature: ${natures}) reaches its final expiration date TODAY (${endDate}). Immediate action is required for renewal or archival.`;
  } else if (daysRemaining <= 15) {
    urgency = 'Daily Reminder';
    title = `[Urgent: ${daysRemaining} Day${daysRemaining === 1 ? '' : 's'} Remaining] Partnership Expiring: ${instName}`;
    desc = `The ${type} agreement with ${instName} (${partnership.country ? partnership.country + ' · ' : ''}Nature: ${natures}) will expire in ${daysRemaining} day${daysRemaining === 1 ? '' : 's'} on ${endDate}. Daily reminders are now active until renewal or expiration.`;
  } else {
    urgency = 'Milestone Alert';
    title = `[Milestone Alert: ${daysRemaining} Days Remaining] Partnership Expiring Soon: ${instName}`;
    desc = `The ${type} agreement with ${instName} (${partnership.country ? partnership.country + ' · ' : ''}Nature: ${natures}) is approaching expiration in ${daysRemaining} days on ${endDate}. Please review the agreement and initiate renewal discussions if applicable.`;
  }

  const link = '/lifecycle?q=' + encodeURIComponent(instName);

  return {
    title,
    desc,
    link,
    tag: `Partnership Expiration · ${urgency}`,
    institution: instName,
    partnershipId: partnership.id,
    type,
    nature: natures,
    expirationDate: endDate,
    daysRemaining,
    urgency
  };
}

async function checkPartnershipExpirationNotifications(db, nowOverride = null, filter = {}) {
  const now = nowOverride ? new Date(nowOverride) : new Date();
  const query = { status: { $ne: 'Inactive' }, ...filter };
  const partnerships = await db.collection('partnerships').find(query).toArray();

  let sentBatches = 0;
  const todayStr = parseLocalDate(now, false).toISOString().slice(0, 10);

  for (const p of partnerships) {
    if (!p.end) continue;
    const daysRemaining = calculateDaysRemaining(p.end, now);
    if (daysRemaining === null || daysRemaining < 0) continue;

    if (!isExpirationNotificationDay(daysRemaining)) continue;

    const endKey = String(p.end).trim();

    const existing = await db.collection('partnership_expiration_notifications').findOne({
      partnershipId: p.id,
      endKey,
      milestone: daysRemaining
    });

    if (existing) continue;

    const recipients = await getPartnershipEmailRecipients(db, p);
    if (!recipients.length) continue;

    const payload = formatExpirationEmailPayload(p, daysRemaining);

    await notifyUsers(db, recipients, {
      module: 'lifecycle',
      tag: payload.tag || 'Partnership Expiration',
      icon: daysRemaining === 0 ? 'ri-close-circle-line' : 'ri-alarm-warning-line',
      color: daysRemaining === 0 ? 'danger' : (daysRemaining <= 15 ? 'warning' : 'info'),
      title: payload.title,
      desc: payload.desc,
      link: payload.link
    });

    await db.collection('partnership_expiration_notifications').insertOne({
      partnershipId: p.id,
      endKey,
      milestone: daysRemaining,
      sentDate: todayStr,
      sentAt: new Date(),
      recipients,
      payload: {
        title: payload.title,
        desc: payload.desc,
        daysRemaining,
        link: payload.link
      }
    });

    sentBatches++;
  }

  return sentBatches;
}

app.checkPartnershipExpirationNotifications = checkPartnershipExpirationNotifications;
app.calculateDaysRemaining = calculateDaysRemaining;
app.isExpirationNotificationDay = isExpirationNotificationDay;
app.formatExpirationEmailPayload = formatExpirationEmailPayload;
app.getPartnershipEmailRecipients = getPartnershipEmailRecipients;

async function runLifecycleCheck() {
  try {
    const db = getDb();
    const count = await recomputePartnershipStatuses(db);
    if (count > 0) console.log(`✓ Lifecycle check: ${count} new notification(s) generated.`);
    const emailBatches = await checkPartnershipExpirationNotifications(db);
    if (emailBatches > 0) console.log(`✓ Expiration email check: ${emailBatches} notification batch(es) sent.`);
  } catch (err) {
    console.error('❌ Lifecycle check failed:', err.message);
  }
}

// Manual trigger (admin only) — lets an admin force a check immediately instead
// of waiting for the next scheduled run; also used to validate the feature.
app.post('/api/lifecycle/recompute', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const count = await recomputePartnershipStatuses(db);
    const emailBatches = await checkPartnershipExpirationNotifications(db);
    res.json({ success: true, notificationsCreated: count, expirationEmailsSent: emailBatches });
  } catch (err) {
    console.error('❌ Lifecycle recompute error:', err);
    res.status(500).json({ error: 'Unable to recompute partnership statuses right now. Please try again.' });
  }
});

app.get('/api/activitylogs', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const docs = await db.collection('activitylogs')
      .find(activityLogFilterFor(req.session.user))
      .sort({ _id: -1 })
      .toArray();
    res.json(docs);
  } catch (err) {
    console.error('❌ Activity logs list error:', err);
    res.status(500).json({ error: 'Unable to load the audit trail right now. Please try again.' });
  }
});

// ── NOTIFICATIONS ─────────────────────────────────────────────────────────────
// NOTE: the public POST /api/activitylogs and POST /api/notifications routes
// that used to live here were removed 2026-07-18 (Roadmap v2, Phase A1) — both
// were requireAuth-only, spread req.body into the inserted document with zero
// validation, and had zero frontend callers, making them pure forgery vectors
// (any authenticated user could fabricate audit-log entries or notifications
// targeted at anyone). Real activity-log writes still go through the trusted
// server-side logActivity() helper; real notification writes still go through
// the lifecycle/approval code paths. See docs/SYSTEM_AUDIT_2026-07-16.md.

// Marks only the current user's own targeted notifications as read. Every
// role uses this same route now — Administrator/Auth. Personnel's frontend
// (administrator/notifications.ejs) was repointed here from the old,
// unscoped /markallread (removed 2026-07-18, see docs/SYSTEM_AUDIT_2026-07-16.md).
app.patch('/api/notifications/markallread/mine', requireAuth, announce('notificationState'), async (req, res) => {
  try {
    const db = getDb();
    const email = req.session.user ? req.session.user.email : '';
    await db.collection('notifications').updateMany({ targetEmail: email }, { $set: { unread: false } });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Mark notifications read error:', err);
    res.status(500).json({ error: 'Unable to update notifications right now. Please try again.' });
  }
});

// Every role, including Administrator/Auth. Personnel, may only act on a
// notification actually addressed to them (targetEmail match) — no role gets
// a blanket-access exception.
function canActOnNotification(user, notif) {
  return !!notif && notif.targetEmail === user.email;
}

// Every real caller (admin/personnel/partner notification views) only ever
// sends { unread: false } — that's the entire canonical schema for this route.
const NOTIFICATION_PATCH_FIELDS = { unread: 'boolean' };

app.patch('/api/notifications/:id', requireAuth, announce('notificationState'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const unknown = Object.keys(req.body).filter(k => !(k in NOTIFICATION_PATCH_FIELDS));
    if (unknown.length) {
      return res.status(400).json({ error: 'Unknown field(s): ' + unknown.join(', ') });
    }
    if (req.body.unread !== undefined && typeof req.body.unread !== 'boolean') {
      return res.status(400).json({ error: 'unread must be a boolean.' });
    }

    const db = getDb();
    const notif = await db.collection('notifications').findOne({ id });
    if (!notif) return res.status(404).json({ error: 'Not found.' });
    if (!canActOnNotification(req.session.user, notif)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    const fields = {};
    if (req.body.unread !== undefined) fields.unread = req.body.unread;
    if (Object.keys(fields).length === 0) {
      return res.status(400).json({ error: 'No valid fields to update.' });
    }
    await db.collection('notifications').updateOne({ id }, { $set: fields });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Notification update error:', err);
    res.status(500).json({ error: 'Unable to update the notification right now. Please try again.' });
  }
});

app.delete('/api/notifications/:id', requireAuth, announce('notificationState'), async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const notif = await db.collection('notifications').findOne({ id });
    if (!notif) return res.status(404).json({ error: 'Not found.' });
    if (!canActOnNotification(req.session.user, notif)) {
      return res.status(403).json({ error: 'Forbidden.' });
    }
    await db.collection('notifications').deleteOne({ id });
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Notification delete error:', err);
    res.status(500).json({ error: 'Unable to delete the notification right now. Please try again.' });
  }
});

// ── CALENDAR EVENTS ───────────────────────────────────────────────────────────
// Explicit allowlist mirroring the real fields the calendar UI actually sends
// (views/administrator/calendar.ejs: the Add/Edit modal, drag-move, and
// drag-resize handlers) — closes the id-mass-assignment gap (Roadmap v2 Phase
// A2, docs/SYSTEM_AUDIT_2026-07-16.md) the same way PARTNERSHIP_FIELDS already
// does for partnerships: never spread req.body directly into an insert/$set.
const CALENDAR_EVENT_FIELDS = ['title', 'start', 'end', 'allDay', 'className', 'location', 'description'];
function pickCalendarEventFields(body) {
  const safe = {};
  for (const f of CALENDAR_EVENT_FIELDS) {
    if (body[f] !== undefined) safe[f] = body[f];
  }
  return safe;
}

// ── Calendar meetings: participants, invitations and attendance (2026-09-20) ──
// A CIPRMS calendar event of the "Meeting" type that has invited participants
// is a meeting people can JOIN. What is stored per event, beyond the fields
// the calendar UI has always saved:
//   participantEmails   every CIPRMS user invited (in-app notification +
//                       calendar visibility + the right to Join). Present
//                       only when someone was invited.
//   googleAttendeeEmails the subset with a valid address — the Google Calendar
//                       attendees. (Google rejects a whole event for one bad
//                       address, so invalid ones are reported and left out.)
//   inviteSkipped       who was NOT e-mailed and why, shown to the Administrator.
//   googleEventKey      a stable Google event id chosen up front, so a retried
//                       create can never produce a second Google event.
//   googleEventId / googleOrganizerEmail / googleSyncStatus — the sync result.
//   attendance[]        who actually joined, with the SERVER's join time.
const meetingTime = require('./services/meetingTime');

const CALENDAR_RECIPIENT_ROLES = ['Administrator', 'Auth. Personnel', 'potential_partner', 'Staff'];

function canManageCalendarRole(user) {
  return !!user && (user.role === 'Administrator' || user.role === 'Staff');
}

// Only the Meeting event type (the default) takes attendance — a "Renewal" or
// "Expiry / Deadline" marker with recipients is a reminder, not something to join.
function isMeetingEvent(ev) {
  return !ev.className || String(ev.className).includes('bg-primary-subtle');
}

function unionEmails(...lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const email of Array.isArray(list) ? list : []) {
      const key = meetingTime.emailKey(email);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(email);
    }
  }
  return out;
}

// Everyone invited to an event. Events created before this feature only have
// recipientEmails / googleAttendeeEmails, so those are honoured as a fallback.
function eventParticipantList(ev) {
  if (Array.isArray(ev.participantEmails)) return ev.participantEmails;
  return unionEmails(ev.recipientEmails, ev.googleAttendeeEmails);
}
function eventParticipantKeys(ev) {
  return new Set(eventParticipantList(ev).map(meetingTime.emailKey).filter(Boolean));
}

function attendanceRecordFor(ev, email) {
  const key = meetingTime.emailKey(email);
  return (Array.isArray(ev.attendance) ? ev.attendance : []).find(a => a.emailKey === key) || null;
}

// What the signed-in user needs to render the Join control. `startsAt`, `endsAt`
// and `serverNow` come from the server: the browser only shows Join while the
// meeting is on (start ≤ now < end, by the server's clock), and the server
// re-checks both bounds on the actual Join request, so a wrong device clock can
// neither unlock nor block a join. The Meet link itself is never in here — it
// is only handed out by the Join request, and only while the meeting is on.
// Administrator and CIRL Staff facilitate the meetings, so they can join any Meeting event even when they were not
// invited to it; everyone else must be an invited participant. `facilitator` marks a join allowed only by role.
function meetingJoinAccess(ev, user) {
  if (eventParticipantKeys(ev).has(meetingTime.emailKey(user.email))) return { allowed: true, facilitator: false };
  if (canManageCalendarRole(user)) return { allowed: true, facilitator: true };
  return { allowed: false, facilitator: false };
}

function buildMyInvite(ev, user, now) {
  if (!isMeetingEvent(ev)) return null;
  const access = meetingJoinAccess(ev, user);
  if (!access.allowed) return { invited: false };
  const win = meetingTime.eventJoinWindow(ev);
  const record = attendanceRecordFor(ev, user.email);
  return {
    invited: true,
    facilitator: access.facilitator,
    joined: !!record,
    joinedAt: record ? new Date(record.joinedAt).toISOString() : null,
    joinedAtDisplay: record ? meetingTime.formatDateTimeInTz(new Date(record.joinedAt)) : null,
    lastAccessAt: record ? new Date(record.lastAccessAt || record.joinedAt).toISOString() : null,
    startsAt: win ? win.start.toISOString() : null,
    endsAt: win ? win.end.toISOString() : null,
    serverNow: now.toISOString(),
    canJoinNow: !!win && now >= win.start && now < win.end,
    timeZone: meetingTime.appTimeZone()
  };
}

// Invitee lists, attendance and Google identifiers are only for the people who
// manage the calendar (Administrator/Staff). Everyone else gets the event plus
// their OWN invitation state — a Partner must not receive every other invited
// user's e-mail address just by loading the calendar.
const CALENDAR_EVENT_PRIVATE_FIELDS = [
  'recipientEmails', 'googleAttendeeEmails', 'participantEmails', 'attendance', 'inviteSkipped',
  'googleEventKey', 'googleSyncStatus', 'googleSyncError', 'googleOrganizerEmail', 'googleHtmlLink',
  'clientRequestId', 'createdByEmail'
];
function calendarEventView(ev, user, now) {
  const view = { ...ev, myInvite: buildMyInvite(ev, user, now) };
  // The Google Meet address is only released by the Join request while the meeting is on — the feed never carries it,
  // not even to the people who manage the calendar.
  delete view.googleMeetLink;
  if (canManageCalendarRole(user)) {
    view.participantCount = eventParticipantKeys(ev).size;
    // Invited people who joined — a facilitator who joined without an invitation is not counted against the invite list.
    const invitedKeys = eventParticipantKeys(ev);
    view.joinedCount = (Array.isArray(ev.attendance) ? ev.attendance : []).filter(a => invitedKeys.has(a.emailKey)).length;
    delete view.attendance;
    delete view.clientRequestId;
  } else {
    for (const f of CALENDAR_EVENT_PRIVATE_FIELDS) delete view[f];
  }
  return view;
}

// Visibility: Administrators see every event (full oversight). Every other
// role only sees events that either name them as a recipient or were never
// scoped to specific recipients in the first place — events predating this
// feature, and events created with no/"all" recipients, carry no
// `recipientEmails` field at all, so they stay visible to everyone exactly as
// before (closes the "existing calendar functionality unaffected" requirement).
//
// College Dean and Partners are stricter: an event with no recipient list is NOT for them. They only see an event that
// names them (recipient / participant / Google attendee) or one explicitly created for "All Users" (forEveryone).
const INVITE_ONLY_CALENDAR_ROLES = ['Auth. Personnel', 'potential_partner'];
function calendarFeedFilter(user) {
  if (user.role === 'Administrator') return {};
  if (INVITE_ONLY_CALENDAR_ROLES.includes(user.role)) {
    const mine = [...new Set([user.email, meetingTime.emailKey(user.email)].filter(Boolean))];
    return {
      $or: [
        { forEveryone: true },
        { recipientEmails: { $in: mine } },
        { participantEmails: { $in: mine } },
        { googleAttendeeEmails: { $in: mine } },
        { createdByEmail: { $in: mine } }
      ]
    };
  }
  // ...plus the events the caller CREATED. CIRL Staff manage the calendar but are not the recipients of a
  // meeting they scope to other people, so without this their own event vanished from their calendar the
  // moment the feed reloaded (paging to another month, or a refresh) — after showing as a phantom until then.
  // ...plus every Meeting event (isMeetingEvent: no type, or the Meeting type): CIRL Staff facilitate the meetings
  // and can join any of them, invited or not, so they must be able to see them to click Join.
  return {
    $or: [
      { recipientEmails: { $exists: false } }, { recipientEmails: user.email }, { createdByEmail: user.email },
      { className: { $in: [null, ''] } }, { className: { $regex: 'bg-primary-subtle' } }
    ]
  };
}
app.get('/api/calendarevents', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const user = req.session.user;
    const filter = calendarFeedFilter(user);
    const docs = await db.collection('calendarevents').find(filter).toArray();
    const now = new Date();
    res.json(docs.map(d => calendarEventView(d, user, now)));
  } catch (err) {
    console.error('❌ Calendar events list error:', err);
    res.status(500).json({ error: 'Unable to load calendar events right now. Please try again.' });
  }
});

/**
 * Resolves the "recipients" the Administrator picked when creating a
 * calendar event into the concrete people invited. `recipients` is an array
 * mixing role tokens (from CALENDAR_RECIPIENT_ROLES, or 'all') and/or
 * individual user emails — a user selected both by role and individually only
 * ends up once. Returns:
 *   users        the CIPRMS users invited (de-duplicated, case-insensitively)
 *   emails       their addresses — drives notifications, visibility and Join
 *   googleEmails the subset that is a valid address (lower-cased) — the Google
 *                Calendar attendees, so no invalid or duplicate entry is sent
 *   invalid      everyone who could NOT be e-mailed, with the reason, so the
 *                Administrator is told instead of it failing silently
 * Nothing the client sends is trusted as a person: an individual entry must
 * match a registered user, otherwise it is reported as invalid.
 */
async function resolveCalendarParticipants(db, recipients) {
  // mentionedEmails: valid addresses mentioned by the admin that are NOT registered
  // CIPRMS users — they still receive a Google Calendar invite and a direct e-mail
  // notification even though they have no in-app account.
  const result = { users: [], emails: [], googleEmails: [], mentionedEmails: [], invalid: [] };
  if (!Array.isArray(recipients) || !recipients.length) return result;
  let users = [];
  if (recipients.includes('all')) {
    // "All Users" only ever reaches active accounts — an Inactive/deactivated
    // user can't log in to see the notification anyway.
    users = await db.collection('users').find({ status: 'Active' }).toArray();
  } else {
    const roles = recipients.filter(r => CALENDAR_RECIPIENT_ROLES.includes(r));
    const requested = [...new Set(recipients
      .filter(r => typeof r === 'string' && !CALENDAR_RECIPIENT_ROLES.includes(r))
      .map(r => r.trim()).filter(Boolean))];
    // Only Active users receive in-app notifications — Inactive accounts cannot log in to see them.
    if (roles.length) users.push(...await db.collection('users').find({ role: { $in: roles }, status: 'Active' }).toArray());
    if (requested.length) {
      const lookup = [...new Set([...requested, ...requested.map(meetingTime.emailKey)])];
      const found = await db.collection('users').find({ email: { $in: lookup } }).toArray();
      users.push(...found);
      const foundKeys = new Set(found.map(u => meetingTime.emailKey(u.email)));
      for (const r of requested) {
        if (!foundKeys.has(meetingTime.emailKey(r))) {
          // If the admin typed a valid e-mail address for someone not yet in CIPRMS,
          // treat them as an external invitee: Google Calendar invite + direct e-mail.
          if (meetingTime.isValidEmail(r)) {
            const key = meetingTime.emailKey(r);
            if (!result.googleEmails.includes(key)) {
              result.mentionedEmails.push(r);
              result.emails.push(r);
              result.googleEmails.push(key);
            }
          } else {
            result.invalid.push({ name: null, email: r, role: null, reason: 'Not a registered CIPRMS user and not a valid e-mail address' });
          }
        }
      }
    }
  }
  const seen = new Set(result.googleEmails.map(k => k)); // pre-seed with external emails already added
  for (const u of users) {
    const key = meetingTime.emailKey(u.email);
    if (!key) {
      result.invalid.push({ name: u.name || null, email: '', role: u.role || null, reason: 'No email address on file' });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    result.users.push({ name: u.name, email: u.email, role: u.role });
    result.emails.push(u.email);
    if (meetingTime.isValidEmail(u.email)) result.googleEmails.push(key);
    else result.invalid.push({ name: u.name || null, email: u.email, role: u.role || null, reason: 'Email address is not valid, so no Google Calendar invitation can be sent to it' });
  }
  return result;
}

function newGoogleEventKey() {
  // Google event ids: 5–1024 chars, lowercase a–v and 0–9 only.
  return 'ciprms' + crypto.randomBytes(12).toString('hex');
}

function mergeSkipped(existing, added) {
  const seen = new Set();
  const out = [];
  for (const s of [...(Array.isArray(existing) ? existing : []), ...(Array.isArray(added) ? added : [])]) {
    const key = meetingTime.emailKey(s.email) || ('name:' + s.name);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

// Server-side validation of the fields the calendar UI sends. Only the fields
// actually present in the request are checked, so renaming a legacy event that
// already has a bad end time is not blocked.
// Only applied to POST (creating a brand-new event) — never to PATCH. Editing/dragging/resizing an ALREADY-EXISTING
// event (including one that has since become historical) keeps its existing, unrestricted business rules: an
// Administrator correcting a past event's notes, attendee list, or even its recorded time must still work exactly as
// before. A calendar-DATE comparison (not an exact instant) is used for all-day events, so "schedule an all-day
// event for today" is never rejected just because today's 00:00 has already gone by.
//
// "Already passed" means the event is OVER, not merely started: when an end time is given, only the END is checked
// against now — a meeting logged a few minutes after it actually began (start in the recent past, end still ahead)
// is a normal, legitimate thing to create (this is also how the existing "Join opens once a meeting has started"
// feature and its tests deliberately create a currently-in-progress meeting), and must not be rejected. Only a
// point-in-time entry with no end time at all falls back to comparing its start.
function isNewEventInThePast(fields) {
  const zone = meetingTime.appTimeZone();
  if (fields.allDay) {
    const startDateOnly = meetingTime.eventDateOnly(fields.start, zone);
    const todayOnly = meetingTime.eventDateOnly(new Date().toISOString(), zone);
    return !!(startDateOnly && todayOnly && startDateOnly < todayOnly);
  }
  const now = new Date();
  if (fields.end) {
    const end = meetingTime.eventEndInstant(fields, zone);
    return !!(end && end < now);
  }
  const start = meetingTime.eventStartInstant(fields, zone);
  return !!(start && start < now);
}

function validateCalendarEventFields(fields, merged) {
  if ('title' in fields && (typeof fields.title !== 'string' || !fields.title.trim())) return 'Event title is required.';
  if ('title' in fields && fields.title.length > 200) return 'Event title is too long (200 characters maximum).';
  if ('start' in fields || 'end' in fields || 'allDay' in fields) {
    const start = meetingTime.eventStartInstant(merged);
    if (!start) return 'A valid start date/time is required.';
    if (!merged.allDay && merged.end) {
      const end = meetingTime.eventEndInstant(merged);
      if (!end) return 'The end time is not valid.';
      if (end < start) return 'The end time cannot be before the start time.';
    }
  }
  return null;
}

// Deep-link straight to the event on whichever calendar page the recipient's
// role actually has (mirrors prLinkForRole's per-role navigation for
// Partnership Request notifications) so a click opens the event detail modal
// immediately instead of landing on a blank calendar.
async function notifyCalendarParticipants(db, entry, users, actorName, mentionedEmails) {
  const roleOfEmail = new Map(users.map(u => [u.email, u.role]));
  const CALENDAR_LINK_BY_ROLE = {
    'Administrator': '/calendar?id=' + entry.id,
    'Auth. Personnel': '/personnel/calendar?id=' + entry.id,
    'potential_partner': '/partner/calendar?id=' + entry.id,
    'Staff': '/staff/calendar?id=' + entry.id
  };
  const emailsByLink = new Map();
  for (const u of users) {
    const link = CALENDAR_LINK_BY_ROLE[roleOfEmail.get(u.email)] || '/calendar';
    if (!emailsByLink.has(link)) emailsByLink.set(link, []);
    emailsByLink.get(link).push(u.email);
  }
  const basePayload = {
    module: 'calendar',
    tag: 'Calendar',
    icon: 'ri-calendar-event-line',
    color: 'primary',
    title: `New event: ${entry.title}`,
    desc: `${actorName} scheduled "${entry.title}"${entry.location ? ' at ' + entry.location : ''}.`
  };
  for (const [link, emails] of emailsByLink) {
    await notifyUsers(db, emails, { ...basePayload, link });
  }
  // External invitees (mentioned by admin but not registered in CIPRMS) — e-mail only,
  // no in-app notification since they have no CIPRMS account.
  const external = Array.isArray(mentionedEmails) ? mentionedEmails.filter(Boolean) : [];
  if (external.length) {
    emailService.sendNotificationEmails(external, {
      ...basePayload,
      link: null,
      desc: `${actorName} scheduled "${entry.title}"${entry.location ? ' at ' + entry.location : ''}. This event was created in CIPRMS at Camarines Sur Polytechnic Colleges (CIRL).`
    }).catch(err => console.error('calendar external invite e-mail failed:', err.message));
  }
}

// Plain-language result of a Google Calendar attempt, returned to the UI so an
// Administrator sees whether invitation e-mails were actually requested.
function describeGoogleSync(sync) {
  if (sync.ok) return { google: 'sent', error: null };
  if (sync.error === 'not_connected') {
    return { google: 'not_connected', error: 'Google Calendar is not connected, so no invitation e-mails were sent. An Administrator can connect it under Settings → Integrations.' };
  }
  if (sync.error === 'invalid_start') return { google: 'failed', error: 'The event has no valid start time to send to Google Calendar.' };
  return { google: 'failed', error: sync.error || 'Google Calendar rejected the request.' };
}

async function recordGoogleSyncOnEvent(db, ev, sync) {
  const set = sync.ok
    ? { googleSyncStatus: 'sent', googleSyncError: null }
    : { googleSyncStatus: sync.error === 'not_connected' ? 'not_connected' : 'failed', googleSyncError: describeGoogleSync(sync).error };
  if (sync.ok && sync.googleEventId) set.googleEventId = sync.googleEventId;
  if (sync.ok && sync.organizerEmail) set.googleOrganizerEmail = sync.organizerEmail;
  if (sync.ok && sync.htmlLink) set.googleHtmlLink = sync.htmlLink;
  if (sync.ok && sync.meetLink) set.googleMeetLink = sync.meetLink;
  await db.collection('calendarevents').updateOne({ id: ev.id }, { $set: set });
  Object.assign(ev, set);
}

function invitationSummary(ev, extra) {
  return {
    invited: eventParticipantList(ev).length,
    googleAttendees: Array.isArray(ev.googleAttendeeEmails) ? ev.googleAttendeeEmails.length : 0,
    google: ev.googleSyncStatus || (ev.googleEventId ? 'sent' : 'not_attempted'),
    error: ev.googleSyncError || null,
    skipped: Array.isArray(ev.inviteSkipped) ? ev.inviteSkipped : [],
    ...(extra || {})
  };
}

// The calendar itself is a shared institutional calendar, viewable by every
// authenticated role (see GET above, requireAuth) — but only Administrator
// or Staff may create/edit/delete entries (requireStaffAccess on this route
// and PATCH/DELETE below; Auth. Personnel and potential_partner stay
// view-only). Corrected 2026-07-29 (RBAC matrix audit,
// docs/SYSTEM_AUDIT_2026-07-16.md): this comment previously said
// "Administrator/Auth. Personnel", which never matched the actual gate on
// any of the three routes. Broadened 2026-09-14 from requireAdmin to
// requireStaffAccess (Administrator OR Staff) so Staff gets full Calendar
// parity with Administrator, reusing the exact same create/edit/delete path
// and the same shared Google Calendar integration — no second implementation.
app.post('/api/calendarevents', requireStaffAccess, announce('calendar'), async (req, res) => {
  try {
    const db = getDb();
    const fields = pickCalendarEventFields(req.body);
    // A new event needs a title and a valid start; validate every time field.
    const invalid = validateCalendarEventFields({ title: fields.title === undefined ? '' : fields.title, start: null, end: null, allDay: null }, fields);
    if (invalid) return res.status(400).json({ error: invalid });
    // New meetings/events cannot be created in the past (Asia/Manila / APP_TIMEZONE) — server-side authoritative,
    // checked here regardless of what any client-side check already did. Never applied to PATCH (see
    // isNewEventInThePast's own comment) — an existing event that has since become historical stays fully editable.
    if (isNewEventInThePast(fields)) {
      return res.status(400).json({ error: 'This date/time has already passed. Please choose a future date and time.' });
    }

    // One token per Save / palette drop, generated by the browser. A repeated
    // request for the SAME action (double click, retry, a doubled callback)
    // returns the event already created instead of inserting a second one.
    const clientRequestId = typeof req.body.clientRequestId === 'string' && /^[\w-]{8,64}$/.test(req.body.clientRequestId)
      ? req.body.clientRequestId : null;
    const duplicateResponse = async () => {
      const prior = await db.collection('calendarevents').findOne(clientRequestId ? { clientRequestId } : naturalKeyFilter);
      return prior ? res.json({ success: true, duplicate: true, event: calendarEventView(prior, req.session.user, new Date()), invitations: invitationSummary(prior) }) : null;
    };
    // A caller that sends no token (a script, an older page) is still not allowed to create the very same
    // event twice in a burst: same creator + title + start within a few seconds is the same Save.
    const naturalKeyFilter = { createdByEmail: req.session.user.email, title: fields.title, start: fields.start, createdAt: { $gte: new Date(Date.now() - 5000).toISOString() } };
    if (await duplicateResponse()) return;

    // Recipients are only meaningful at creation time — only the users
    // selected here are notified, per the recipient-targeting requirement.
    // If no recipients are explicitly selected, fall back to notifying every
    // active user (equivalent to picking "All Users") so an event always
    // generates in-app notifications and the invite is never silently dropped.
    const rawRecipients = (Array.isArray(req.body.recipients) && req.body.recipients.length)
      ? req.body.recipients
      : ['all'];
    const participants = await resolveCalendarParticipants(db, rawRecipients);
    const targetEmails = participants.emails;
    // "All Users" (or no recipients picked at all) means the event is public/
    // system-wide — only a genuinely narrowed selection (specific roles
    // and/or specific individuals, not "all") restricts who can see it.
    const isScoped = Array.isArray(rawRecipients) && rawRecipients.length && !rawRecipients.includes('all');
    const base = {
      ...fields,
      ...(isScoped ? { recipientEmails: targetEmails } : {}),
      // Explicit "All Users" marker: College Dean and Partners only see unscoped events that carry it
      // (an event created with no recipients at all is internal, not for them).
      ...(Array.isArray(rawRecipients) && rawRecipients.includes('all') ? { forEveryone: true } : {}),
      // Every invited CIPRMS user (visibility for a scoped event is
      // recipientEmails; this is the always-populated "who was invited" list
      // that the Join control and the attendance view rely on).
      ...(targetEmails.length ? { participantEmails: targetEmails } : {}),
      // Separate from recipientEmails (which drives CIPRMS's own visibility
      // filter above, and is deliberately absent for "all users" events) —
      // this is the STABLE attendee list Google Calendar sync uses on every
      // future edit, captured once here regardless of whether the event was
      // scoped or public. Without this, an "All Users" event's Google
      // attendees would silently be wiped on its first edit, since
      // recipientEmails never existed on that doc to fall back to.
      ...(participants.googleEmails.length ? { googleAttendeeEmails: participants.googleEmails, googleEventKey: newGoogleEventKey() } : {}),
      ...(participants.invalid.length ? { inviteSkipped: participants.invalid } : {}),
      ...(clientRequestId ? { clientRequestId } : {}),
      createdByEmail: req.session.user.email,
      createdAt: new Date().toISOString()
    };

    let entry = null;
    for (let attempt = 0; attempt < 5 && !entry; attempt++) {
      const last = await db.collection('calendarevents').find({}).sort({ id: -1 }).limit(1).toArray();
      const candidate = { id: last.length ? (last[0].id || 0) + 1 : 1, ...base };
      try {
        await db.collection('calendarevents').insertOne(candidate);
        entry = candidate;
      } catch (err) {
        if (!err || err.code !== 11000) throw err;
        if (clientRequestId && await duplicateResponse()) return; // lost a race with the identical request
        // otherwise another event took this id in the same instant — retry with a fresh one
      }
    }
    if (!entry) throw new Error('Could not allocate an id for the new event.');

    await notifyCalendarParticipants(db, entry, participants.users, req.session.user.name, participants.mentionedEmails);

    // Google Calendar sync (2026-08-02) — best-effort, alongside (not instead
    // of) the in-app notification above. Only attempted when there's a real
    // recipient list to invite; never blocks or fails the event's own save —
    // if the org hasn't connected Google Calendar, or the API call fails, the
    // CIPRMS event still exists exactly as it did before this feature. Google
    // itself e-mails the invitation (sendUpdates: 'all'), from the connected
    // organizer account.
    let invitations;
    if (participants.googleEmails.length) {
      const sync = await googleCalendarService.createGoogleEvent(db, entry, participants.googleEmails);
      await recordGoogleSyncOnEvent(db, entry, sync);
      invitations = invitationSummary(entry);
    } else {
      if (targetEmails.length) {
        entry.googleSyncStatus = 'no_valid_attendees';
        await db.collection('calendarevents').updateOne({ id: entry.id }, { $set: { googleSyncStatus: 'no_valid_attendees' } });
      }
      invitations = invitationSummary(entry);
    }

    // Same shape as the calendar feed (adds participantCount/joinedCount/myInvite), so the page can show
    // the invitation panel for a just-created event without a reload.
    res.json({ success: true, event: calendarEventView(entry, req.session.user, new Date()), invitations });
  } catch (err) {
    console.error('❌ Calendar event create error:', err);
    res.status(500).json({ error: 'Unable to create the calendar event right now. Please try again.' });
  }
});

app.patch('/api/calendarevents/:id', requireStaffAccess, announce('calendar'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event id.' });
  try {
    const db = getDb();
    const existing = await db.collection('calendarevents').findOne({ id });
    if (!existing) return res.status(404).json({ error: 'Event not found.' });

    const fields = pickCalendarEventFields(req.body);
    const invalid = validateCalendarEventFields(fields, { ...existing, ...fields });
    if (invalid) return res.status(400).json({ error: invalid });
    const set = { ...fields };

    // Attendees can be ADDED to an existing meeting (never silently replaced):
    // the new people are notified, added to the Google event, and Google
    // e-mails them the invitation.
    let addedGoogleAttendees = false;
    let newlyInvited = [];
    let patchParticipants = null;
    const rawRecipients = Array.isArray(req.body.recipients) ? req.body.recipients : [];
    if (rawRecipients.length) {
      const p = await resolveCalendarParticipants(db, rawRecipients);
      patchParticipants = p;
      if (p.emails.length || p.invalid.length) {
        const already = eventParticipantKeys(existing);
        newlyInvited = p.users.filter(u => !already.has(meetingTime.emailKey(u.email)));
        set.participantEmails = unionEmails(eventParticipantList(existing), p.emails);
        if (Array.isArray(existing.recipientEmails)) set.recipientEmails = unionEmails(existing.recipientEmails, p.emails);
        const googleEmails = meetingTime.uniqueValidEmails([...(existing.googleAttendeeEmails || []), ...p.googleEmails]);
        if (googleEmails.length) set.googleAttendeeEmails = googleEmails;
        const before = new Set((existing.googleAttendeeEmails || []).map(meetingTime.emailKey));
        addedGoogleAttendees = p.googleEmails.some(e => !before.has(e));
        if (googleEmails.length && !existing.googleEventId && !existing.googleEventKey) set.googleEventKey = newGoogleEventKey();
        if (p.invalid.length) set.inviteSkipped = mergeSkipped(existing.inviteSkipped, p.invalid);
      }
    }
    if (!Object.keys(set).length) return res.status(400).json({ error: 'No valid fields to update.' });

    await db.collection('calendarevents').updateOne({ id }, { $set: set });
    const updated = await db.collection('calendarevents').findOne({ id });
    if (!updated) return res.status(404).json({ error: 'Event not found.' });
    // Notify newly-added CIPRMS users and newly-mentioned external emails
    const existingAttendeeKeys = new Set((existing.googleAttendeeEmails || []));
    const newMentioned = patchParticipants
      ? patchParticipants.mentionedEmails.filter(e => !existingAttendeeKeys.has(meetingTime.emailKey(e)))
      : [];
    if (newlyInvited.length || newMentioned.length) await notifyCalendarParticipants(db, updated, newlyInvited, req.session.user.name, newMentioned);

    // Notify existing participants if schedule details (title, start, end, location) changed
    const scheduleChanged = ['title', 'start', 'end', 'location'].some(k => k in fields);
    if (scheduleChanged) {
      const newlyInvitedSet = new Set((newlyInvited || []).map(u => meetingTime.emailKey(u.email)));
      const existingAttendees = eventParticipantList(existing).filter(e => !newlyInvitedSet.has(meetingTime.emailKey(e)));
      if (existingAttendees.length) {
        const actorName = req.session && req.session.user ? req.session.user.name : 'CIRL Staff';
        await notifyUsers(db, existingAttendees, {
          module: 'calendar',
          tag: 'Calendar',
          icon: 'ri-calendar-todo-line',
          color: 'warning',
          title: `Event Updated: ${updated.title}`,
          desc: `${actorName} updated the event "${updated.title}"${updated.start ? ' (Schedule: ' + updated.start + ')' : ''}${updated.location ? ' at ' + updated.location : ''}.`,
          link: '/calendar'
        });
      }
    }

    // Google Calendar sync — an edit or a drag updates the SAME Google event
    // (patched by its id, never re-inserted), and Google e-mails the attendees
    // the change (sendUpdates: 'all'). Uses googleAttendeeEmails (the stable
    // attendee list), never recipientEmails — the latter is absent entirely
    // for "all users" events and would otherwise silently wipe every attendee
    // off the Google event. Best-effort, same as create (see POST above).
    const googleRelevant = ['title', 'start', 'end', 'allDay', 'location', 'description'].some(k => k in fields) || addedGoogleAttendees;
    const attendees = updated.googleAttendeeEmails || [];
    if (googleRelevant && attendees.length && (updated.googleEventId || updated.googleEventKey)) {
      const sync = await googleCalendarService.syncGoogleEvent(db, updated, attendees);
      await recordGoogleSyncOnEvent(db, updated, sync);
    }

    res.json({ success: true, event: calendarEventView(updated, req.session.user, new Date()), invitations: invitationSummary(updated) });
  } catch (err) {
    console.error('❌ Calendar event update error:', err);
    res.status(500).json({ error: 'Unable to update the calendar event right now. Please try again.' });
  }
});

app.delete('/api/calendarevents/:id', requireStaffAccess, announce('calendar', { prior: priorCalendarEvent }), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event id.' });
  try {
    const db = getDb();
    const existing = await db.collection('calendarevents').findOne({ id });
    if (existing && existing.googleEventId) {
      await googleCalendarService.deleteGoogleEvent(db, existing.googleEventId);
    }
    await db.collection('calendarevents').deleteOne({ id });
    if (existing) {
      const attendees = eventParticipantList(existing);
      if (attendees.length) {
        const actorName = req.session && req.session.user ? req.session.user.name : 'CIRL Staff';
        await notifyUsers(db, attendees, {
          module: 'calendar',
          tag: 'Calendar',
          icon: 'ri-calendar-close-line',
          color: 'danger',
          title: `Event Cancelled: ${existing.title}`,
          desc: `${actorName} cancelled the event "${existing.title}"${existing.start ? ' originally scheduled for ' + existing.start : ''}.`,
          link: '/calendar'
        });
      }
    }
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Calendar event delete error:', err);
    res.status(500).json({ error: 'Unable to delete the calendar event right now. Please try again.' });
  }
});

// Join a meeting. Everything that matters comes from the server, never the
// request: who is joining (the session, re-read from the database), whether
// they were invited (the stored participant list), when the meeting starts
// (the stored event, in the application timezone) and WHEN they joined (the
// server clock at the moment of this call). The request body is ignored, so a
// tampered timestamp, user id, role or event time has nothing to act on.
app.post('/api/calendarevents/:id/join', requireAuth, announce('calendar'), async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event id.' });
  try {
    const db = getDb();
    const user = await db.collection('users').findOne({ email: req.session.user.email });
    if (!user) return res.status(403).json({ error: 'Account not found.' });
    const ev = await db.collection('calendarevents').findOne({ id });
    if (!ev || !isMeetingEvent(ev)) return res.status(404).json({ error: 'Meeting not found.' });

    const key = meetingTime.emailKey(user.email);
    if (!meetingJoinAccess(ev, user).allowed) {  // invited participants, plus Administrator / CIRL Staff as facilitators
      return res.status(403).json({ error: 'You are not an invited participant of this meeting.' });
    }
    const win = meetingTime.eventJoinWindow(ev);
    if (!win) return res.status(409).json({ error: 'This meeting has no valid start time.' });
    const now = new Date();
    if (now < win.start) {
      return res.status(403).json({
        error: 'This meeting has not started yet. You can join when it starts.',
        code: 'MEETING_NOT_STARTED',
        startsAt: win.start.toISOString(),
        endsAt: win.end.toISOString(),
        serverNow: now.toISOString()
      });
    }
    if (now >= win.end) {
      return res.status(403).json({
        error: 'This meeting has ended.',
        code: 'MEETING_ENDED',
        startsAt: win.start.toISOString(),
        endsAt: win.end.toISOString(),
        serverNow: now.toISOString()
      });
    }

    // Atomic and duplicate-proof: the filter only matches while nobody with
    // this address has an attendance entry yet, so any number of simultaneous
    // or repeated clicks record exactly one join — the first. `joinedAt` is
    // that first join and is never touched again; `lastAccessAt` starts equal
    // to it and is advanced below on every later click, so a person who opens
    // the meeting again hours later is reflected without ever duplicating or
    // moving their original join time. `source` records how this attendance
    // entry was created — today that is always this in-app button, the only
    // join event CIPRMS can actually observe (see the 2026-10-08 Google Meet
    // access tracking investigation: the integration's OAuth scope is
    // calendar.events only, so a participant who opens the meeting straight
    // from the Google Calendar invitation e-mail or the raw Meet link never
    // reaches this server at all and cannot be recorded here) — kept as its
    // own field rather than assumed so a future, separately-scoped detection
    // method can add its own value without reshaping this record.
    const result = await db.collection('calendarevents').updateOne(
      { id, 'attendance.emailKey': { $ne: key } },
      { $push: { attendance: { email: user.email, emailKey: key, userId: user.id, name: user.name, role: user.role, joinedAt: now, lastAccessAt: now, source: 'cirl-button' } } }
    );
    if (result.modifiedCount === 0) {
      // Already joined earlier: this is a later open of the same meeting, not a new join — advance only
      // lastAccessAt (arrayFilters targets this one attendee's entry so nobody else's record is touched).
      await db.collection('calendarevents').updateOne(
        { id },
        { $set: { 'attendance.$[a].lastAccessAt': now } },
        { arrayFilters: [{ 'a.emailKey': key }] }
      );
    }
    const fresh = await db.collection('calendarevents').findOne({ id });

    // The Google Meet room the person is sent to. Google can attach it a moment after the event is created, so when
    // none is stored yet it is read from the Google event now (and kept). No link is not an error: the attendance is
    // recorded either way and the page tells the person there is no Meet room to open.
    let meetLink = fresh.googleMeetLink || null;
    if (!meetLink && fresh.googleEventId) {
      meetLink = await googleCalendarService.getGoogleMeetLink(db, fresh.googleEventId);
      if (meetLink) await db.collection('calendarevents').updateOne({ id }, { $set: { googleMeetLink: meetLink } });
    }
    res.json({ success: true, alreadyJoined: result.modifiedCount === 0, meetLink, myInvite: buildMyInvite(fresh, user, new Date()) });
  } catch (err) {
    console.error('❌ Meeting join error:', err);
    res.status(500).json({ error: 'Unable to record your attendance right now. Please try again.' });
  }
});

// Administrator/Staff attendance view: every invited participant, with the
// server-recorded join time formatted in the application timezone (so it
// reads the same whatever the viewer's browser timezone is). "Invitation" and
// "Attendance" are separate columns on purpose — being invited (or e-mailed an
// invitation) is not the same as having joined.
app.get('/api/calendarevents/:id/attendance', requireStaffAccess, async (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid event id.' });
  try {
    const db = getDb();
    const ev = await db.collection('calendarevents').findOne({ id });
    if (!ev) return res.status(404).json({ error: 'Event not found.' });

    const invited = eventParticipantList(ev);
    const lookup = [...new Set([...invited, ...invited.map(meetingTime.emailKey)])];
    const users = lookup.length ? await db.collection('users').find({ email: { $in: lookup } }).toArray() : [];
    const userByKey = new Map(users.map(u => [meetingTime.emailKey(u.email), u]));
    const googleKeys = new Set((ev.googleAttendeeEmails || []).map(meetingTime.emailKey));
    const emailed = !!ev.googleEventId;

    const participants = invited.map(email => {
      const u = userByKey.get(meetingTime.emailKey(email));
      const record = attendanceRecordFor(ev, email);
      const joinedAt = record ? new Date(record.joinedAt) : null;
      // lastAccessAt falls back to joinedAt for attendance recorded before this field existed, so an older
      // record never reads as "last accessed" before it was even first joined.
      const lastAccessAt = record ? new Date(record.lastAccessAt || record.joinedAt) : null;
      return {
        name: u ? u.name : email,
        role: u ? displayRoleName(u.role) : '—',
        email,
        invitation: emailed && googleKeys.has(meetingTime.emailKey(email)) ? 'Emailed via Google Calendar' : 'In-app only',
        status: record ? 'Joined' : 'Not Joined',
        source: record ? (record.source || 'cirl-button') : null,
        joinedAt: joinedAt ? joinedAt.toISOString() : null,
        joinedAtDisplay: joinedAt ? meetingTime.formatTimeInTz(joinedAt) : null,
        joinedDateDisplay: joinedAt ? meetingTime.formatDateTimeInTz(joinedAt) : null,
        lastAccessAt: lastAccessAt ? lastAccessAt.toISOString() : null,
        // Only worth a second display string when it actually differs from the first join — a single click
        // has nothing new to say beyond "Time Joined".
        lastAccessDisplay: lastAccessAt && joinedAt && lastAccessAt.getTime() !== joinedAt.getTime() ? meetingTime.formatDateTimeInTz(lastAccessAt) : null
      };
    }).sort((a, b) => a.role.localeCompare(b.role) || a.name.localeCompare(b.name));

    // Administrator / CIRL Staff who joined as facilitators without being invited: listed after the invitees, and
    // not counted in the invited/joined summary.
    const invitedKeys = new Set(invited.map(meetingTime.emailKey));
    const facilitators = (Array.isArray(ev.attendance) ? ev.attendance : [])
      .filter(a => !invitedKeys.has(a.emailKey))
      .map(a => {
        const joinedAt = new Date(a.joinedAt);
        const lastAccessAt = new Date(a.lastAccessAt || a.joinedAt);
        return {
          name: a.name || a.email,
          role: displayRoleName(a.role) || '—',
          email: a.email,
          invitation: 'Facilitator (not invited)',
          status: 'Joined',
          source: a.source || 'cirl-button',
          facilitator: true,
          joinedAt: joinedAt.toISOString(),
          joinedAtDisplay: meetingTime.formatTimeInTz(joinedAt),
          joinedDateDisplay: meetingTime.formatDateTimeInTz(joinedAt),
          lastAccessAt: lastAccessAt.toISOString(),
          lastAccessDisplay: lastAccessAt.getTime() !== joinedAt.getTime() ? meetingTime.formatDateTimeInTz(lastAccessAt) : null
        };
      });

    const start = meetingTime.eventStartInstant(ev);
    res.json({
      event: {
        id: ev.id, title: ev.title, location: ev.location || '', isMeeting: isMeetingEvent(ev),
        startsAt: start ? start.toISOString() : null,
        startsAtDisplay: start ? meetingTime.formatDateTimeInTz(start) : null
      },
      timeZone: meetingTime.appTimeZone(),
      serverNow: new Date().toISOString(),
      summary: { invited: participants.length, joined: participants.filter(p => p.status === 'Joined').length },
      google: { status: ev.googleSyncStatus || (ev.googleEventId ? 'sent' : 'not_attempted'), error: ev.googleSyncError || null, organizerEmail: ev.googleOrganizerEmail || null },
      skipped: Array.isArray(ev.inviteSkipped) ? ev.inviteSkipped : [],
      participants: participants.concat(facilitators)
    });
  } catch (err) {
    console.error('❌ Meeting attendance error:', err);
    res.status(500).json({ error: 'Unable to load meeting details right now. Please try again.' });
  }
});

// ── GOOGLE CALENDAR INTEGRATION (2026-08-02) ───────────────────────────────────
// A single, org-wide Google account (connected once by an Administrator) is
// used to create/update/delete calendar events — see
// services/googleCalendarService.js for the full rationale and
// docs/SYSTEM_AUDIT_2026-07-16.md for the architecture writeup. All four
// routes below stay requireAdmin — connecting/disconnecting the org's shared
// Google account is org-wide system configuration, deliberately more
// sensitive than creating an event, and is intentionally NOT broadened by
// the 2026-09-14 change that gave Staff the same POST/PATCH/DELETE
// /api/calendarevents access as Administrator (requireStaffAccess) above:
// Staff creates/edits/deletes events through the same already-connected
// account without ever needing — or being able — to (dis)connect it. This is
// fully independent of the passport-google-oauth20 *login* flow above (which
// discards its tokens) — it talks to googleapis's own OAuth2Client directly
// so it can capture and persist a refresh token.
// 2026-10 authentication hardening: same APP_BASE_URL-preferred, Host-header-fallback construction as
// getCallbackUrl() above — see its own comment for the full reasoning.
function getGoogleCalendarCallbackUrl(req) {
  return `${publicBaseUrl(req)}/api/google-calendar/callback`;
}

// Settings → Integrations reads this. Only non-secret facts are ever returned:
// no access token, refresh token, authorization code or client secret. The
// redirect URI is included because it must be registered — character for
// character — under "Authorized redirect URIs" on the Google Cloud OAuth client,
// and it depends on the address the Administrator is browsing from.
function googleCalendarConfigured() {
  return !!(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET && process.env.GOOGLE_TOKEN_ENCRYPTION_KEY);
}

app.get('/api/google-calendar/status', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const integration = await googleCalendarService.getIntegration(db);
    const common = {
      configured: googleCalendarConfigured(),
      redirectUri: getGoogleCalendarCallbackUrl(req),
      timeZone: meetingTime.appTimeZone()
    };
    res.json(integration
      ? {
        ...common,
        connected: true,
        connectedByEmail: integration.connectedByEmail,
        connectedByName: integration.connectedByName,
        connectedAt: integration.connectedAt,
        googleAccountEmail: integration.googleAccountEmail || null,
        calendarTimeZone: integration.calendarTimeZone || null,
        verifiedAt: integration.verifiedAt || null,
        lastSyncOk: integration.lastSyncOk === undefined ? null : integration.lastSyncOk,
        lastSyncError: integration.lastSyncError || null,
        lastSyncAt: integration.lastSyncAt || null
      }
      : { ...common, connected: false });
  } catch (err) {
    console.error('❌ Google Calendar status error:', err);
    res.status(500).json({ error: 'Unable to check the Google Calendar connection right now. Please try again.' });
  }
});

app.get('/api/google-calendar/connect', requireAdmin, (req, res) => {
  if (!googleCalendarConfigured()) return res.redirect('/admin/settings?googleCalendar=error&reason=not_configured');
  // CSRF protection on the callback: a random state tied to this session,
  // checked (and consumed) below before any token exchange happens.
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleCalendarOAuthState = state;
  let callbackUrl;
  try {
    callbackUrl = getGoogleCalendarCallbackUrl(req);
  } catch (configErr) {
    return googleCalendarFailure(res, 'config'); // publicBaseUrl()'s own console.error already logged the sanitized specifics
  }
  const url = googleCalendarService.getAuthUrl(callbackUrl, state);
  res.redirect(url);
});

function sameOAuthState(expected, received) {
  if (typeof expected !== 'string' || typeof received !== 'string') return false;
  const x = Buffer.from(expected), y = Buffer.from(received);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Every failure lands back on the Integrations tab with a short reason code (never
// Google's raw message, which the Settings page must not have to trust).
function googleCalendarFailure(res, reason) {
  return res.redirect('/admin/settings?googleCalendar=error&reason=' + encodeURIComponent(reason));
}

app.get('/api/google-calendar/callback', requireAdmin, async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = req.session.googleCalendarOAuthState;
  delete req.session.googleCalendarOAuthState;

  if (error) return googleCalendarFailure(res, error === 'access_denied' ? 'denied' : 'google_error');
  if (typeof code !== 'string' || !code || !sameOAuthState(expectedState, state)) return googleCalendarFailure(res, 'state');

  try {
    const db = getDb();
    const { verification } = await googleCalendarService.handleOAuthCallback(db, code, getGoogleCalendarCallbackUrl(req), req.session.user);
    // Stored either way; a failed verification (e.g. Calendar API not enabled) is
    // shown on the Settings page instead of surfacing on the first meeting.
    res.redirect('/admin/settings?googleCalendar=' + (verification && verification.ok ? 'connected' : 'connected_unverified'));
  } catch (err) {
    const message = googleCalendarService.describeGoogleError(err);
    console.error('Google Calendar: OAuth callback failed:', message);
    let reason = 'exchange';
    if (/refresh token/i.test(message)) reason = 'no_refresh_token';
    else if (/redirect URI/i.test(message)) reason = 'redirect_uri';
    else if (/OAuth client ID\/secret/i.test(message)) reason = 'client';
    googleCalendarFailure(res, reason);
  }
});

// Re-runs the read-only connection check (refresh token → access token → Calendar API)
// so the Administrator can confirm the connection still works at any time.
app.post('/api/google-calendar/verify', requireAdmin, async (req, res) => {
  try {
    const result = await googleCalendarService.verifyConnection(getDb());
    if (result.ok) return res.json({ success: true, googleAccountEmail: result.accountEmail, calendarTimeZone: result.calendarTimeZone });
    res.json({ success: false, error: result.error === 'not_connected' ? 'Google Calendar is not connected.' : result.error });
  } catch (err) {
    console.error('❌ Google Calendar verify error:', err);
    res.status(500).json({ error: 'Unable to verify the Google Calendar connection right now. Please try again.' });
  }
});

app.post('/api/google-calendar/disconnect', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    await googleCalendarService.disconnect(db);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Google Calendar disconnect error:', err);
    res.status(500).json({ error: 'Unable to disconnect Google Calendar right now. Please try again.' });
  }
});

// ── GOOGLE DOCS — MOA/MOU agreement drafts (2026-09-26) ──────────────────────────
// Same org-wide model as Google Calendar above, as its own connection (services/googleDocsService.js). An
// Administrator connects it once in Settings → Integrations; Administrator/Staff then create a Google Doc draft for a
// Partnership Request, which is shared by e-mail with: every active Administrator and CIRL Staff (edit), the
// partner who submitted the request (comment) and the College Deans of the request's unit (view). Google enforces
// those permissions; CIPRMS only shows the link to the reviewers and the request's own submitter.
// 2026-10 authentication hardening: same APP_BASE_URL-preferred, Host-header-fallback construction as
// getCallbackUrl() above — see its own comment for the full reasoning.
function getGoogleDocsCallbackUrl(req) {
  return `${publicBaseUrl(req)}/api/google-docs/callback`;
}

function googleDocsFailure(res, reason) {
  return res.redirect('/admin/settings?googleDocs=error&reason=' + encodeURIComponent(reason));
}

app.get('/api/google-docs/status', requireAdmin, async (req, res) => {
  try {
    const integration = await googleDocsService.getIntegration(getDb());
    const common = { configured: googleCalendarConfigured(), redirectUri: getGoogleDocsCallbackUrl(req) };
    res.json(integration
      ? {
        ...common,
        connected: true,
        connectedByEmail: integration.connectedByEmail,
        connectedAt: integration.connectedAt,
        googleAccountEmail: integration.googleAccountEmail || null,
        verifiedAt: integration.verifiedAt || null,
        lastSyncOk: integration.lastSyncOk === undefined ? null : integration.lastSyncOk,
        lastSyncError: integration.lastSyncError || null,
        lastSyncAt: integration.lastSyncAt || null
      }
      : { ...common, connected: false });
  } catch (err) {
    console.error('❌ Google Docs status error:', err);
    res.status(500).json({ error: 'Unable to check the Google Docs connection right now. Please try again.' });
  }
});

// System Status (2026-11) — any signed-in user, not just Administrator: everyone benefits from knowing
// *which* feature is unavailable instead of guessing the whole app is broken. Deliberately returns only
// state + a plain-language message per service — none of the account-linking detail (connected-by email,
// OAuth redirect URI) that the admin-only /api/google-*/status routes above expose.
app.get('/api/system-status', requireAuth, async (req, res) => {
  try {
    const status = await systemStatusService.getSystemStatus();
    res.json(status);
  } catch (err) {
    // The status check itself failing is not the same claim as "CIPRMS is down" — report that the check
    // could not complete rather than fabricate a worse (or falsely reassuring) status.
    console.error('❌ /api/system-status error:', err);
    res.json({ coreAvailable: true, overall: 'unknown', services: [], checkedAt: new Date().toISOString() });
  }
});

app.get('/api/google-docs/connect', requireAdmin, (req, res) => {
  if (!googleCalendarConfigured()) return googleDocsFailure(res, 'not_configured');
  const state = crypto.randomBytes(16).toString('hex');
  req.session.googleDocsOAuthState = state;
  let callbackUrl;
  try {
    callbackUrl = getGoogleDocsCallbackUrl(req);
  } catch (configErr) {
    return googleDocsFailure(res, 'config'); // publicBaseUrl()'s own console.error already logged the sanitized specifics
  }
  res.redirect(googleDocsService.getAuthUrl(callbackUrl, state));
});

app.get('/api/google-docs/callback', requireAdmin, async (req, res) => {
  const { code, state, error } = req.query;
  const expectedState = req.session.googleDocsOAuthState;
  delete req.session.googleDocsOAuthState;
  if (error) return googleDocsFailure(res, error === 'access_denied' ? 'denied' : 'google_error');
  if (typeof code !== 'string' || !code || !sameOAuthState(expectedState, state)) return googleDocsFailure(res, 'state');
  try {
    const { verification } = await googleDocsService.handleOAuthCallback(getDb(), code, getGoogleDocsCallbackUrl(req), req.session.user);
    res.redirect('/admin/settings?googleDocs=' + (verification && verification.ok ? 'connected' : 'connected_unverified'));
  } catch (err) {
    const message = googleDocsService.describeGoogleError(err);
    console.error('Google Docs: OAuth callback failed:', message);
    let reason = 'exchange';
    if (/refresh token/i.test(message)) reason = 'no_refresh_token';
    else if (/redirect URI/i.test(message)) reason = 'redirect_uri';
    else if (/OAuth client ID\/secret/i.test(message)) reason = 'client';
    googleDocsFailure(res, reason);
  }
});

app.post('/api/google-docs/verify', requireAdmin, async (req, res) => {
  try {
    const result = await googleDocsService.verifyConnection(getDb());
    if (result.ok) return res.json({ success: true, googleAccountEmail: result.accountEmail });
    res.json({ success: false, error: result.error === 'not_connected' ? 'Google Docs is not connected.' : result.error });
  } catch (err) {
    console.error('❌ Google Docs verify error:', err);
    res.status(500).json({ error: 'Unable to verify the Google Docs connection right now. Please try again.' });
  }
});

app.post('/api/google-docs/disconnect', requireAdmin, async (req, res) => {
  try {
    await googleDocsService.disconnect(getDb());
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Google Docs disconnect error:', err);
    res.status(500).json({ error: 'Unable to disconnect Google Docs right now. Please try again.' });
  }
});

// Who a request's draft is shared with, and how. Reviewers edit; the submitter comments; College Deans of the
// request's unit view. One entry per e-mail (the strongest role wins), Inactive accounts left out.
async function agreementDocRecipients(db, request) {
  const active = { status: { $ne: 'Inactive' } };
  const reviewers = await db.collection('users').find({ role: { $in: REQUEST_REVIEWER_ROLES }, ...active }, { projection: { email: 1 } }).toArray();
  const units = (Array.isArray(request.unit) ? request.unit : String(request.unit || '').split(','))
    .map(u => u.trim()).filter(Boolean);
  const deans = units.length
    ? await db.collection('users').find({ role: 'Auth. Personnel', unit: { $in: units }, ...active }, { projection: { email: 1 } }).toArray()
    : [];
  const byEmail = new Map();
  const add = (email, role) => {
    const e = String(email || '').trim().toLowerCase();
    if (e && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && !byEmail.has(e)) byEmail.set(e, role);
  };
  reviewers.forEach(u => add(u.email, 'writer'));
  add(request.submittedByEmail, 'commenter');
  deans.forEach(u => add(u.email, 'reader'));
  return [...byEmail].map(([email, role]) => ({ email, role }));
}

function publicDoc(d) {
  return { id: d.id, kind: d.kind, title: d.title, url: d.url, createdByName: d.createdByName, createdAt: d.createdAt, sharing: d.sharing || [] };
}

// Linked drafts of one request — reviewers, and the request's own submitter.
app.get('/api/requests/:id/google-docs', requireAuth, async (req, res) => {
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const request = await db.collection('requests').findOne({ id });
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    const user = req.session.user;
    const isReviewer = REQUEST_REVIEWER_ROLES.includes(user.role);
    if (!isReviewer && request.submittedByEmail !== user.email) return res.status(403).json({ error: 'You do not have permission to do this.' });
    const docs = await googleDocsService.docsCollection(db).find({ requestId: id }).sort({ id: 1 }).toArray();
    res.json({
      connected: isReviewer ? !!(await googleDocsService.getIntegration(db)) : undefined,
      // Share results (who got which access, and failures) are only for reviewers.
      docs: docs.map(d => isReviewer ? publicDoc(d) : { id: d.id, kind: d.kind, title: d.title, url: d.url, createdAt: d.createdAt })
    });
  } catch (err) {
    console.error('❌ Google Docs drafts list error:', err);
    res.status(500).json({ error: 'Unable to load Google Docs drafts right now. Please try again.' });
  }
});

// Create an MOA/MOU draft for a request (Administrator / CIRL Staff).
app.post('/api/requests/:id/google-docs', requireStaffAccess, announce('request'), async (req, res) => {
  const kind = req.body && req.body.kind;
  if (!['MOA', 'MOU'].includes(kind)) return res.status(400).json({ error: 'kind must be MOA or MOU.' });
  try {
    const db = getDb();
    const id = parseInt(req.params.id);
    const request = await db.collection('requests').findOne({ id });
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    if (request.status === 'Draft') return res.status(400).json({ error: 'This request has not been submitted yet.' });

    const recipients = await agreementDocRecipients(db, request);
    let created;
    try {
      created = await googleDocsService.createAgreementDoc(db, request, kind, recipients);
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }
    const doc = await insertWithNextId(googleDocsService.docsCollection(db), (nextId) => ({
      id: nextId,
      requestId: id,
      kind,
      title: created.title,
      fileId: created.fileId,
      url: created.url,
      createdByEmail: req.session.user.email,
      createdByName: req.session.user.name,
      createdAt: new Date().toISOString(),
      sharing: created.sharing
    }));
    await logActivity(db, req.session.user, 'CREATE', `Google Docs ${kind} draft created for partnership request: ${request.institution} (#REQ-${String(id).padStart(3, '0')})`);

    if (request.submittedByEmail) {
      const submitter = await db.collection('users').findOne({ email: request.submittedByEmail });
      await notifyUsers(db, [request.submittedByEmail], {
        module: 'request',
        tag: request.isRenewal ? 'Renewal Request' : 'Partnership Request',
        icon: 'ri-file-word-2-line',
        color: 'info',
        title: `${kind} draft shared: ${request.institution}`,
        desc: `${req.session.user.name} started a ${kind} draft in Google Docs for your request (${request.institution}). You can open it and add comments from Monitoring.`,
        link: prLinkForRole(submitter && submitter.role, id)
      });
    }
    res.json({ success: true, doc: publicDoc(doc) });
  } catch (err) {
    console.error('❌ Google Docs draft create error:', err);
    res.status(500).json({ error: 'Unable to complete the Google Docs draft request right now. Please try again.' });
  }
});

// Re-share a draft with the request's current people (e.g. new staff, or a failed share to retry).
app.post('/api/google-docs/:docId/reshare', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const doc = await googleDocsService.docsCollection(db).findOne({ id: parseInt(req.params.docId) });
    if (!doc) return res.status(404).json({ error: 'Draft not found.' });
    const request = await db.collection('requests').findOne({ id: doc.requestId });
    if (!request) return res.status(404).json({ error: 'Request not found.' });
    let sharing;
    try {
      sharing = await googleDocsService.reshareDoc(db, doc.fileId, await agreementDocRecipients(db, request),
        `CIPRMS shared this ${doc.kind} draft for Partnership Request #REQ-${String(request.id).padStart(3, '0')} (${request.institution}).`);
    } catch (err) {
      return res.status(422).json({ error: err.message });
    }
    await googleDocsService.docsCollection(db).updateOne({ id: doc.id }, { $set: { sharing } });
    res.json({ success: true, doc: publicDoc({ ...doc, sharing }) });
  } catch (err) {
    console.error('❌ Google Docs reshare error:', err);
    res.status(500).json({ error: 'Unable to re-share the draft right now. Please try again.' });
  }
});

// Unlink a draft from its request. The Google Doc itself is kept in the connected account's Drive.
app.delete('/api/google-docs/:docId', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const doc = await googleDocsService.docsCollection(db).findOne({ id: parseInt(req.params.docId) });
    if (!doc) return res.status(404).json({ error: 'Draft not found.' });
    await googleDocsService.docsCollection(db).deleteOne({ id: doc.id });
    await logActivity(db, req.session.user, 'DELETE', `Google Docs ${doc.kind} draft unlinked from partnership request #REQ-${String(doc.requestId).padStart(3, '0')}`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Google Docs draft unlink error:', err);
    res.status(500).json({ error: 'Unable to remove the draft right now. Please try again.' });
  }
});

// ── MONGO-BACKED PROFILE STORES ───────────────────────────────────────────────
// A request stores the requestor's name when it is created, so renaming an account in Settings would leave every
// request they already submitted under the old name. Keep the account's own requests (matched by e-mail, the same
// ownership key the routes use) in step with the new name. Only the requestor field is touched — never a reviewer's.
async function propagateRequestorName(db, email, name) {
  if (!email || !name) return;
  await db.collection('requests').updateMany({ submittedByEmail: email }, { $set: { requestedBy: name } });
  await db.collection('documentrequests').updateMany({ requestedByEmail: email }, { $set: { requestedBy: name } });
}

// Department/College, Institution/School, Designation/Position and the Contact Number are set once, when the account is
// registered in User Management (users.unit / institution / position / contactNumber), and cannot be changed from
// Settings. The Settings profile endpoints therefore read them from the account itself and accept ONLY the person's
// own name.
function registeredProfile(userDoc) {
  if (!userDoc) return {};
  return {
    name: userDoc.name || '', email: userDoc.email || '',
    dept: userDoc.unit || '', position: userDoc.position || '', institution: userDoc.institution || '',
    contactNumber: userDoc.contactNumber || ''
  };
}

// The contact number entered when an account is registered / edited in User Management. Digits and the usual phone
// punctuation only, at least 7 digits when one is given; empty clears it. Returns { value } (undefined = not sent, so
// the stored number is left alone) or { error }.
const CONTACT_NUMBER_RE = /^[0-9+()\-\s]{1,25}$/;
function parseContactNumber(raw) {
  if (typeof raw !== 'string') return { value: undefined };
  const value = raw.trim();
  if (!value) return { value: '' };
  if (!CONTACT_NUMBER_RE.test(value) || value.replace(/\D/g, '').length < 7) {
    return { error: 'Enter a valid contact number — numbers only (spaces and + ( ) - are fine), at least 7 digits.' };
  }
  return { value };
}

async function readOwnProfile(req, res) {
  try {
    const db = getDb();
    const userDoc = await db.collection('users').findOne({ id: req.session.user.id }, { projection: { password: 0 } });
    res.json(registeredProfile(userDoc));
  } catch (err) {
    // Same convention as /api/admin/password etc. below: log the real error server-side, never echo raw
    // internals (Mongo driver messages, stack traces) back to the client — this previously did `error: err.message`.
    console.error('❌ readOwnProfile error:', err);
    res.status(503).json({ error: 'Unable to load your profile right now. Please try again.', code: 'SERVICE_UNAVAILABLE' });
  }
}

// Email is intentionally NOT accepted from the client (2026-09-06 security hardening): it is the authenticated
// identity, not an editable profile field, and almost every ownership check in this app is keyed on
// req.session.user.email. Any `email` — and any dept/position/institution/contact number — in the request body is
// ignored. Only the name is saved.
async function saveOwnName(req, res) {
  const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
  if (!name) return res.status(400).json({ error: 'Name is required.' });
  const email = req.session.user.email;
  try {
    const db = getDb();
    // The per-request session sync re-reads users.name, so the rename must be stored on the users document —
    // otherwise it reverts on the next page.
    await db.collection('users').updateOne({ id: req.session.user.id }, { $set: { name } });
    await propagateRequestorName(db, email, name);
    req.session.user.name = name;
    const userDoc = await db.collection('users').findOne({ id: req.session.user.id }, { projection: { password: 0 } });
    res.json({ success: true, profile: registeredProfile(userDoc) });
  } catch (err) {
    console.error('❌ saveOwnName error:', err);
    res.status(503).json({ error: 'Unable to save your name right now. Please try again.', code: 'SERVICE_UNAVAILABLE' });
  }
}

// After the password is changed the current session ends: the person has to sign in again with the new password.
// (Same teardown as POST /logout — the session is destroyed, its live connections closed and the cookie cleared.)
function endSessionAfterPasswordChange(req, res) {
  const endingSession = req.sessionID;
  req.session.destroy((err) => {
    realtime.disconnectSession(endingSession);
    if (err) console.error('❌ Session destroy after password change failed:', err);
    res.clearCookie('connect.sid', { path: '/' });
    res.json({ success: true, reloginRequired: true });
  });
}

// Admin profile GET / POST
app.get('/api/admin/profile', requireAdmin, readOwnProfile);
app.post('/api/admin/profile', requireAdmin, saveOwnName);

// Admin password POST
app.post('/api/admin/password', adminPasswordLimiter, requireAdmin, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDb();
    // Look up by the stable numeric id, not email — defense in depth even
    // though the profile form can no longer change session email at all
    // (2026-09-06 security hardening).
    const userId = req.session.user.id;
    const userDoc = await db.collection('users').findOne({ id: userId });
    const passwordMatches = await verifyPassword(oldPassword, userDoc && userDoc.password);
    if (!passwordMatches)
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!isStrongPassword(newPassword))
      return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
    // $inc sessionVersion (2026-10 authentication hardening): revokes every OTHER already-open session for
    // this same account (picked up by the revalidation middleware above) — endSessionAfterPasswordChange()
    // below only ever ends THIS one request's own session, never reaches any other device/browser.
    await db.collection('users').updateOne({ id: userId }, { $set: { password: await hashPassword(newPassword) }, $inc: { sessionVersion: 1 } });
    return endSessionAfterPasswordChange(req, res);
  } catch (err) {
    // 2026-09-06 security hardening (Finding #6): every real validation
    // failure already returns its own clean message above — this only
    // catches genuine unexpected errors, which must never echo raw
    // internals (Mongo driver messages, etc.) back to the client.
    console.error('❌ Admin password change error:', err);
    res.status(500).json({ error: 'Unable to update password right now. Please try again.' });
  }
});

// Personnel profile GET / POST — name only; see registeredProfile() above.
app.get('/api/personnel/profile', requirePersonnel, readOwnProfile);
app.post('/api/personnel/profile', requirePersonnel, saveOwnName);

// Personnel password POST
app.post('/api/personnel/password', personnelPasswordLimiter, requirePersonnel, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDb();
    // Look up by the stable numeric id, not email — defense in depth even
    // though the profile form can no longer change session email at all
    // (2026-09-06 security hardening).
    const userId = req.session.user.id;
    const userDoc = await db.collection('users').findOne({ id: userId });
    const passwordMatches = await verifyPassword(oldPassword, userDoc && userDoc.password);
    if (!passwordMatches)
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!isStrongPassword(newPassword))
      return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
    // $inc sessionVersion (2026-10 authentication hardening): revokes every OTHER already-open session for
    // this same account (picked up by the revalidation middleware above) — endSessionAfterPasswordChange()
    // below only ever ends THIS one request's own session, never reaches any other device/browser.
    await db.collection('users').updateOne({ id: userId }, { $set: { password: await hashPassword(newPassword) }, $inc: { sessionVersion: 1 } });
    return endSessionAfterPasswordChange(req, res);
  } catch (err) {
    console.error('❌ Personnel password change error:', err);
    res.status(500).json({ error: 'Unable to update password right now. Please try again.' });
  }
});

// Staff profile GET / POST — name only; see registeredProfile() above.
app.get('/api/staff/profile', requireStaffAccess, readOwnProfile);
app.post('/api/staff/profile', requireStaffAccess, saveOwnName);

// Staff password POST
app.post('/api/staff/password', staffPasswordLimiter, requireStaffAccess, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDb();
    // Look up by the stable numeric id, not email — defense in depth even
    // though the profile form can no longer change session email at all
    // (2026-09-06 security hardening).
    const userId = req.session.user.id;
    const userDoc = await db.collection('users').findOne({ id: userId });
    const passwordMatches = await verifyPassword(oldPassword, userDoc && userDoc.password);
    if (!passwordMatches)
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!isStrongPassword(newPassword))
      return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
    // $inc sessionVersion (2026-10 authentication hardening): revokes every OTHER already-open session for
    // this same account (picked up by the revalidation middleware above) — endSessionAfterPasswordChange()
    // below only ever ends THIS one request's own session, never reaches any other device/browser.
    await db.collection('users').updateOne({ id: userId }, { $set: { password: await hashPassword(newPassword) }, $inc: { sessionVersion: 1 } });
    return endSessionAfterPasswordChange(req, res);
  } catch (err) {
    console.error('❌ Staff password change error:', err);
    res.status(500).json({ error: 'Unable to update password right now. Please try again.' });
  }
});

// ── INSTITUTION API PROXY ─────────────────────────────────────────────────────
// 2026-09-06 security hardening (quick win): this was reachable with no
// session at all, unlike almost every other route in the app — requireAuth
// added so an unauthenticated caller can no longer use CIPRMS as a free
// relay against the third-party universities API. Every real caller
// (Add/Edit Partnership's institution autocomplete) is already logged in.
//
// 2026-09-23: the external universities.hipolabs.com dataset only covers universities — it has zero results for
// "TESDA", "DOST", or "Camarines" (confirmed live), yet this app's own real partnership history already has
// "TESDA Region V", "DOST Region V", and other government/training institutions that are exactly the kind of
// partner CIPRMS deals with. Rather than adding a second external dependency (or, worse, inventing placeholder
// institution data), this now ALSO searches this app's own previously-recorded partner institutions
// (`partnerships.inst` — genuinely real names/countries, never fabricated) and merges them ahead of the
// external results: a name this app has actually partnered with before is at least as trustworthy a suggestion
// as an unaffiliated worldwide university, and it is the only way something like "TESDA Region V" is ever
// findable here at all. Every result — internal or external — keeps the same {name, country} shape
// selectInstitution() already expects, so the client-side auto-fill logic needs no changes.
app.get('/api/institutions', requireAuth, institutionsLimiter, async (req, res) => {
  const name = req.query.name || '';
  const q = name.trim();
  if (!q || q.length < 2) {
    return res.json([]);
  }
  const RESULT_LIMIT = 15;
  let internal = [];
  try {
    const db = getDb();
    const pattern = { $regex: escapeRegexLiteral(q), $options: 'i' };
    const docs = await db.collection('partnerships')
      .find({ inst: pattern }, { projection: { inst: 1, country: 1, _id: 0 } })
      .limit(RESULT_LIMIT)
      .toArray();
    const seen = new Set();
    for (const d of docs) {
      if (!d.inst) continue;
      const key = d.inst.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      internal.push({ name: d.inst, country: d.country || '' });
    }
  } catch (_) { /* DB unavailable — external search below still works on its own */ }

  const remaining = RESULT_LIMIT - internal.length;
  if (remaining <= 0) return res.json(internal);

  try {
    const http = require('http');
    const url = `http://universities.hipolabs.com/search?name=${encodeURIComponent(q)}`;
    http.get(url, apiRes => {
      let data = '';
      apiRes.on('data', chunk => data += chunk);
      apiRes.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const seenNames = new Set(internal.map(u => u.name.toLowerCase()));
          const external = (Array.isArray(parsed) ? parsed : [])
            .filter(u => u && u.name && !seenNames.has(String(u.name).toLowerCase()))
            .slice(0, remaining);
          res.json(internal.concat(external));
        } catch {
          res.json(internal);
        }
      });
    }).on('error', () => res.json(internal));
  } catch {
    res.json(internal);
  }
});

// ── OCR (document upload → field extraction for the Partnership Registry) ────
// requireUploader (2026-09-14 correction — was requireAuth): OCR is one of
// the "upload" capabilities, exactly like the Document Library routes above,
// so it belongs on the same role gate as those rather than the broader
// "any authenticated role" check. requireUploader already covers every role
// that legitimately uses this pipeline today (Administrator, Auth.
// Personnel, potential_partner, and Staff's Partnership Request auto-fill
// upload), so this is a tightening for explicit, future-proof intent — not a
// behavior change for any current user — and closes the gap where a future
// authenticated-but-non-uploading role would otherwise inherit OCR access it
// was never meant to have. Every OCR job remains additionally per-uploader
// ownership-checked (see ocrController.status) regardless of role.
app.use('/api/ocr', requireUploader, ocrRoutes);

// ── GLOBAL SEARCH (header search bar) ─────────────────────────────────────────
// Administrator/CIRL Staff only (requireStaffAccess), matching exactly the two roles the header actually shows the
// search bar to (views/partials/header.ejs: `!reducedHeader`) and, not coincidentally, the two roles that already
// have full-registry/full-request-review access AND can already open any document regardless of who uploaded it
// (see the SELF_UPLOAD_ONLY_ROLES exemption on GET /uploads/documents/:filename above). Global search surfaces
// exactly that same reach through one search box instead of four separate pages — it does not grant either role
// anything they could not already reach through the app's other endpoints. College Staff and Partner never receive
// the client script that calls this, and this route itself refuses them regardless (requireStaffAccess), so a direct
// API call cannot bypass the restriction either.
//
// Response shape is intentionally plain data (id/title/subtitle/snippet/href) — the client is responsible for
// escaping before it ever touches innerHTML (see public/js/ciprms-search.js). `href` is built here, per the
// searching user's OWN role, from the exact same prLinkForRole/drLinkForRole helpers notifications already use, so a
// clicked result lands on the same page a notification about that record would.
app.get('/api/search', requireStaffAccess, searchLimiter, async (req, res) => {
  try {
    const db = getDb();
    const role = req.session.user.role;
    const result = await searchService.globalSearch(db, req.query.q, { full: req.query.full === '1' });
    result.partnerships.forEach(p => { p.href = (role === 'Staff' ? '/staff/lifecycle' : '/lifecycle') + '?q=' + encodeURIComponent(p.title); });
    result.requests.forEach(r => { r.href = prLinkForRole(role, r.id); });
    result.documentRequests.forEach(r => { r.href = drLinkForRole(role, r.id); });
    result.documents.forEach(d => { d.href = d.fileLink || null; delete d.fileLink; });
    res.json(result);
  } catch (err) {
    res.status(500).json({ error: 'Search is unavailable right now. Please try again.' });
  }
});

// Full search-results page — reached by pressing Enter in the header search box (public/js/ciprms-search.js) rather
// than the small dropdown. Same GET /api/search the dropdown uses, requested with a higher per-category limit.
app.get('/search', requireAdmin, (req, res) => {
  res.render('administrator/search_results', { activePage: '', user: req.session.user, q: req.query.q || '' });
});
app.get('/staff/search', requireStaffAccess, (req, res) => {
  res.render('administrator/search_results', { activePage: '', user: req.session.user, sidebarPartial: 'sidebar_staff', q: req.query.q || '' });
});

// Every file OCR'd is archived here automatically — auth-gated since these
// are institutional partnership documents, not public assets.
// Ownership-checked file serving (not a blanket express.static): same
// OWN_SCOPE_ROLES boundary as GET /api/documents above, EXCEPT Administrator
// and Staff, who are deliberately exempted here — that own-scoping exists
// for the *Document Library browsing* experience (each role's own "My
// Documents"), but both reviewer roles (REQUEST_REVIEWER_ROLES, full parity
// as of 2026-08-27) also need to open/download every supporting document
// attached to Partnership/Document Requests during review, regardless of
// who uploaded it. Including a reviewer role in the ownership check here
// made every such file return 403 whenever the requester wasn't the
// reviewer themselves — i.e. always, since requesters are Auth.
// Personnel/potential_partner, never Administrator/Staff.
const SELF_UPLOAD_ONLY_ROLES = ['Auth. Personnel', 'potential_partner'];
// 2026-09-14: a reviewer's own POST /api/requests|document-requests/:id/documents
// upload is now correctly attributed to the reviewer (uploadedByEmail =
// reviewer's own email — see that route's own comment), so a document
// attached to a requester's OWN request can legitimately have a DIFFERENT
// uploadedByEmail than the requester. The requester must still be able to
// open every file on their own request regardless of who actually uploaded
// it — this was silently true before only as a side effect of the old
// (buggy) attribution always matching the requester's email; this explicit
// request-ownership check is what actually preserves that access now that
// the attribution bug is fixed, without granting access to any OTHER
// request's documents.
async function isOwnerOfLinkedRequest(db, doc, email) {
  if (!doc || doc.requestId == null || !doc.requestType) return false;
  if (doc.requestType === 'document') {
    const target = await db.collection('documentrequests').findOne({ id: doc.requestId });
    return !!(target && target.requestedByEmail === email);
  }
  const target = await db.collection('requests').findOne({ id: doc.requestId });
  return !!(target && target.submittedByEmail === email);
}
app.get('/uploads/documents/:filename', requireUploader, async (req, res) => {
  const filename = path.basename(req.params.filename);
  try {
    const db = getDb();
    const doc = await db.collection('documents').findOne({ fileLink: '/uploads/documents/' + filename });
    if (SELF_UPLOAD_ONLY_ROLES.includes(req.session.user.role)) {
      const isUploader = !!doc && doc.uploadedByEmail === req.session.user.email;
      const ownsLinkedRequest = !isUploader && await isOwnerOfLinkedRequest(db, doc, req.session.user.email);
      if (!isUploader && !ownsLinkedRequest) {
        return res.status(403).send('Forbidden');
      }
    }
    res.sendFile(path.join(__dirname, 'uploads', 'documents', filename), (err) => {
      if (err && !res.headersSent) res.status(404).send('Not found');
    });
  } catch (err) {
    res.status(500).send('Server error');
  }
});
app.use('/uploads/avatars', requireAuth, express.static(path.join(__dirname, 'uploads', 'avatars')));
// A profile picture whose file is gone (e.g. the host's disk was reset by a redeploy — Render's free plan keeps no
// files between deploys) falls back to the default picture instead of a broken image. no-store, so the real photo
// shows again as soon as the user re-uploads (a re-upload gets a new file name anyway).
app.use('/uploads/avatars', requireAuth, (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.sendFile(path.join(__dirname, 'public', DEFAULT_AVATAR_URL));
});

// ── ADMIN ROUTES ──────────────────────────────────────────────────────────────
// Shared by /dashboard (Administrator) and /staff/dashboard (Staff, 2026-08-27
// migration) — both render this same set of live counters/DSS insights, just
// into their own template with their own sidebar. Kept as one function so the
// two dashboards can never silently drift out of sync with each other.
// ── MONTHLY/YEARLY TARGET TRACKER (2026-09-06) ──────────────────────────────
// Org-wide only (no per-unit/college dimension — confirmed with the user;
// the existing `unit` array field and its normalization pattern remain
// available if that's ever needed later, but inventing it now would be an
// unrequested dimension). Counts every partnership regardless of `nature`
// (New vs Renewal both count, per the same confirmation) — the only filter
// is the partnership's own signing date (`start`) falling inside the target
// period.
const TARGET_TYPES = ['monthly', 'yearly'];
const TARGET_YEAR_MIN = 2000;
const TARGET_YEAR_MAX = 2100;

/**
 * Deliberately NOT reusing Reports & Analytics' filterByDateRange() — that
 * function answers "was this partnership active during this window"
 * (start <= dateTo AND end >= dateFrom), a period-OVERLAP question. A
 * target asks "was this partnership newly accomplished (signed) in this
 * period" — an entirely different question that happens to share the same
 * `start` field. Reusing filterByDateRange here would silently count
 * partnerships that merely span the period without having been signed in
 * it (e.g. a 2021-2026 partnership would count toward every single year's
 * target in between), which is exactly the "January belongs to January"
 * kind of error the spec warned about.
 *
 * Both year and month are derived from parsing the SAME `start` string with
 * one `new Date()` call (never mixing a precomputed `startYear` field with a
 * freshly parsed month) so a monthly boundary can never disagree with the
 * year it's nested inside. `start` is a non-ISO display string ("Apr 12,
 * 2026"), so `new Date(start)` parses as local time — consistent with how
 * every other date-string comparison in this codebase already treats it
 * (see filterByDateRange's own comment on this exact point), so there is no
 * UTC/local timezone shift risk here.
 */
async function computeTargetAccomplishment(db, target) {
  const docs = await db.collection('partnerships').find({}, { projection: { start: 1, startYear: 1 } }).toArray();
  const current = docs.filter(p => {
    if (!p.start) return false;
    const d = new Date(p.start);
    if (isNaN(d)) return false;
    if (target.type === 'yearly') {
      // Falls back to the parsed year for legacy records that predate the
      // startYear helper field — same fallback Reports & Analytics already
      // uses for its own "Year" grouping (cirl.js computeCustomReportData).
      const y = p.startYear || d.getFullYear();
      return y === target.year;
    }
    return d.getFullYear() === target.year && (d.getMonth() + 1) === target.month;
  }).length;

  const lacking = Math.max(target.targetCount - current, 0);
  const rawPercentage = target.targetCount > 0 ? Math.round((current / target.targetCount) * 100) : 0;
  const percentage = Math.min(100, Math.max(0, rawPercentage));
  let status;
  if (current === 0) status = 'NOT_STARTED';
  else if (current < target.targetCount) status = 'IN_PROGRESS';
  else if (current === target.targetCount) status = 'TARGET_REACHED';
  else status = 'TARGET_EXCEEDED';

  return { current, lacking, percentage, rawPercentage, status };
}

async function withTargetProgress(db, targets) {
  return Promise.all(targets.map(async (t) => ({ ...t, progress: await computeTargetAccomplishment(db, t) })));
}

function validateTargetInput(body) {
  const type = body.type;
  if (!TARGET_TYPES.includes(type)) return { error: 'type must be "monthly" or "yearly".' };

  const year = parseInt(body.year, 10);
  if (!Number.isInteger(year) || year < TARGET_YEAR_MIN || year > TARGET_YEAR_MAX) {
    return { error: `year must be an integer between ${TARGET_YEAR_MIN} and ${TARGET_YEAR_MAX}.` };
  }

  let month = null;
  if (type === 'monthly') {
    month = parseInt(body.month, 10);
    if (!Number.isInteger(month) || month < 1 || month > 12) {
      return { error: 'month must be an integer between 1 and 12 for a monthly target.' };
    }
  } else if (body.month !== undefined && body.month !== null && body.month !== '') {
    return { error: 'month must not be provided for a yearly target.' };
  }

  const targetCount = parseInt(body.targetCount, 10);
  if (!Number.isInteger(targetCount) || targetCount < 1) {
    return { error: 'targetCount must be a positive integer.' };
  }

  return { value: { type, year, month, targetCount } };
}

// Viewing is Administrator+Staff (full dashboard parity, matching every
// other dashboard-adjacent read in this app) — Auth. Personnel and
// potential_partner get no target-management visibility, unchanged from
// their existing access policy. Mutations are requireAdmin-only below.
app.get('/api/targets', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const targets = await db.collection('targets').find({}).sort({ year: -1, month: -1 }).toArray();
    res.json(await withTargetProgress(db, targets));
  } catch (err) {
    console.error('❌ Failed to load targets:', err);
    res.status(500).json({ error: 'Failed to load targets.' });
  }
});

app.post('/api/targets', requireAdmin, async (req, res) => {
  const { error, value } = validateTargetInput(req.body);
  if (error) return res.status(400).json({ error });
  try {
    const db = getDb();
    const now = new Date().toISOString();
    const entry = await insertWithNextId(db.collection('targets'), (nextId) => ({
      id: nextId, ...value, active: true,
      createdBy: req.session.user.name, createdByEmail: req.session.user.email,
      createdAt: now, updatedAt: now
    }));
    await logActivity(db, req.session.user, 'ADD',
      `Target created: ${value.type === 'monthly' ? `${value.month}/${value.year}` : value.year} — ${value.targetCount} partnerships`);
    res.json({ success: true, target: { ...entry, progress: await computeTargetAccomplishment(db, entry) } });
  } catch (err) {
    // Duplicate-key from the unique (type, year, month) index — the
    // findOne-based race this catches is inherent to check-then-insert; a
    // concurrent duplicate attempt fails cleanly here instead of silently
    // creating two targets for the same period.
    if (err.code === 11000) {
      return res.status(409).json({ error: 'A target for this period already exists.' });
    }
    console.error('❌ Failed to create target:', err);
    res.status(500).json({ error: 'Failed to create target.' });
  }
});

app.patch('/api/targets/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const existing = await db.collection('targets').findOne({ id });
    if (!existing) return res.status(404).json({ error: 'Target not found.' });

    const targetCount = parseInt(req.body.targetCount, 10);
    if (!Number.isInteger(targetCount) || targetCount < 1) {
      return res.status(400).json({ error: 'targetCount must be a positive integer.' });
    }
    // Only targetCount (and active) are editable — type/year/month define the
    // record's identity and are covered by the unique index; changing them
    // would just be deleting one target and creating another.
    const setFields = { targetCount, updatedAt: new Date().toISOString() };
    if (req.body.active !== undefined) setFields.active = !!req.body.active;

    await db.collection('targets').updateOne({ id }, { $set: setFields });
    const updated = await db.collection('targets').findOne({ id });
    await logActivity(db, req.session.user, 'EDIT',
      `Target updated: ${updated.type === 'monthly' ? `${updated.month}/${updated.year}` : updated.year} — now ${updated.targetCount} partnerships`);
    res.json({ success: true, target: { ...updated, progress: await computeTargetAccomplishment(db, updated) } });
  } catch (err) {
    console.error('❌ Failed to update target:', err);
    res.status(500).json({ error: 'Failed to update target.' });
  }
});

app.delete('/api/targets/:id', requireAdmin, async (req, res) => {
  const id = parseInt(req.params.id);
  try {
    const db = getDb();
    const existing = await db.collection('targets').findOne({ id });
    if (!existing) return res.status(404).json({ error: 'Target not found.' });
    await db.collection('targets').deleteOne({ id });
    await logActivity(db, req.session.user, 'DELETE',
      `Target removed: ${existing.type === 'monthly' ? `${existing.month}/${existing.year}` : existing.year} — ${existing.targetCount} partnerships`);
    res.json({ success: true });
  } catch (err) {
    console.error('❌ Failed to delete target:', err);
    res.status(500).json({ error: 'Failed to delete target.' });
  }
});

async function computeDashboardStats(db) {
  const [allPartnerships, allRequests] = await Promise.all([
    db.collection('partnerships').find({}).toArray(),
    db.collection('requests').find({}).toArray()
  ]);

  // ── Stat counters ─────────────────────────────────────────────────────────
  const dashActive = allPartnerships.filter(p => p.status === 'Active').length;
  const dashExpiring = allPartnerships.filter(p => p.status === 'Expiring Soon').length;
  const dashExpired = allPartnerships.filter(p => p.status === 'Expired').length;
  const dashTotal = allPartnerships.length;

  // ── Active Partnerships table rows (up to 6, most recently started) ─────
  // 2026-09-19: this widget was "Expiring Partnerships" (Expiring Soon +
  // Expired, prioritized so Expiring Soon was never crowded out by Expired —
  // see git history for that fix). Replaced with an Active-only view per
  // request; Expiring/Expired records must never appear here.
  //
  // Status is recomputed live via computeStatusFromEnd() — the same
  // authoritative, date-derived status check the Reports & Analytics engine
  // and /api/partnerships/stats already use — rather than trusted from the
  // stored `status` field, which is only refreshed by the hourly lifecycle
  // job and can be stale by up to an hour. This is a read-only computation
  // for display purposes only: it never writes back to the partnership
  // record, so it cannot desync a record from the real lifecycle job.
  //
  // "Most relevant/recent" is the partnership's own authoritative `start`
  // date (the "Date of Signing" field used throughout Reports & Analytics
  // and the Target Tracker) sorted descending — the most recently signed
  // Active partnerships surface first, exactly mirroring how "recent" is
  // already defined everywhere else in this codebase.
  const activePartnerships = allPartnerships
    .filter(p => computeStatusFromEnd(p.end) === 'Active')
    .sort((a, b) => new Date(b.start || b.startDate || 0) - new Date(a.start || a.startDate || 0))
    .slice(0, 6);

  // ── DSS: High Renewal Priority ────────────────────────────────────────────
  const expiringSoon = allPartnerships.filter(p => p.status === 'Expiring Soon');
  let insightRenewal;
  if (expiringSoon.length) {
    const soonest = expiringSoon.slice().sort((a, b) => new Date(a.end || a.endDate || 0) - new Date(b.end || b.endDate || 0))[0];
    const instName = soonest.inst || soonest.institution || 'an institution';
    insightRenewal = `${expiringSoon.length} partnership${expiringSoon.length > 1 ? 's' : ''} (including ${instName}) ${expiringSoon.length > 1 ? 'are' : 'is'} expiring within 90 days. Immediate action is recommended to maintain program continuity.`;
  } else {
    insightRenewal = 'No partnerships are currently expiring within the next 90 days.';
  }

  // ── DSS: Expansion Opportunity ────────────────────────────────────────────
  const pendingRequests = allRequests.filter(r => r.status === 'Pending');
  let insightExpansion;
  if (pendingRequests.length) {
    const byCountry = {};
    pendingRequests.forEach(r => { const c = r.country || 'an unspecified country'; byCountry[c] = (byCountry[c] || 0) + 1; });
    const [topCountry, topCount] = Object.entries(byCountry).sort((a, b) => b[1] - a[1])[0];
    insightExpansion = `${topCount} pending request${topCount > 1 ? 's' : ''} target${topCount > 1 ? '' : 's'} partnerships in ${topCountry}. Consider prioritizing this region for new agreements.`;
  } else {
    insightExpansion = 'No pending partnership requests at this time.';
  }

  // ── DSS: Resource Optimization ────────────────────────────────────────────
  const expiredList = allPartnerships.filter(p => p.status === 'Expired');
  let insightOptimization;
  if (expiredList.length) {
    insightOptimization = `${expiredList.length} expired partnership${expiredList.length > 1 ? 's have' : ' has'} not yet been renewed or archived. Consider reviewing ${expiredList.length > 1 ? 'these agreements' : 'this agreement'} to optimize resource allocation.`;
  } else {
    insightOptimization = 'No expired partnerships currently require review.';
  }

  return { dashActive, dashExpiring, dashExpired, dashTotal, activePartnerships, insightRenewal, insightExpansion, insightOptimization };
}

app.get('/dashboard', requireAdmin, async (req, res) => {
  try {
    const db = getDb();
    const stats = await computeDashboardStats(db);
    res.render('administrator/admin_dashboard', {
      activePage: 'dashboard',
      user: req.session.user,
      ...stats
    });
  } catch (err) {
    console.error('Dashboard render error:', err);
    // Fallback: render with empty/safe defaults so the page still loads
    res.render('administrator/admin_dashboard', {
      activePage: 'dashboard',
      user: req.session.user,
      dashActive: 0, dashExpiring: 0, dashExpired: 0, dashTotal: 0,
      activePartnerships: [],
      insightRenewal: 'Could not load renewal data.',
      insightExpansion: 'Could not load expansion data.',
      insightOptimization: 'Could not load optimization data.'
    });
  }
});

// Registry — 2026-09-05: consolidated into Monitoring (see /lifecycle below)
// to remove the heavy overlap between the two pages (duplicate stat cards,
// duplicate Urgent/Overview panels, two separate partnership tables). This
// route is now a compatibility redirect only — nothing about the underlying
// Registry data, schema, or POST/PATCH/DELETE /api/partnerships changed;
// only the standalone page and its nav entry were removed. Administrator-only,
// matching the page it forwards to.
app.get('/registry', requireAdmin, (req, res) => {
  res.redirect('/lifecycle');
});

// Monitoring (Administrator) — the single consolidated partnership-management
// page: KPI cards, Overview, DSS Smart Alerts, Urgent, and the full
// Partnership Registry (filters/search/Add/Edit/Renew/Delete), all reading
// from the one /api/partnerships source of truth. Narrowed from
// requirePersonnel to requireAdmin as part of the 2026-09-05 consolidation —
// Auth. Personnel's own Monitoring experience is intentionally untouched and
// keeps living at /personnel/lifecycle (still the original, simpler
// administrator/lifecycle view), so this page's Add/Edit/Renew/Delete
// controls never became reachable to a role that shouldn't have them.
app.get('/lifecycle', requireAdmin, (req, res) => {
  res.render('administrator/monitoring', { activePage: 'lifecycle', user: req.session.user });
});

// Administrator's own Notifications/Document Library pages. Auth. Personnel,
// potential_partner, and Staff all have their own dedicated, correctly-scoped
// equivalents (/personnel/notifications, /personnel/documents,
// /partner/notifications, /partner/documents, /staff/notifications,
// /staff/documents) — these bare routes are not a shared fallback for other
// roles, so requireAdmin (not requireAuth) keeps Staff/partner from ever
// landing on the Administrator's own sidebar.
app.get('/notifications', requireAdmin, (req, res) => {
  res.render('administrator/notifications', { activePage: 'notifications', user: req.session.user });
});

app.get('/documents', requireAdmin, (req, res) => {
  res.render('administrator/documents', { activePage: 'documents', user: req.session.user });
});

app.get('/calendar', requirePersonnel, (req, res) => {
  res.render('administrator/calendar', { activePage: 'calendar', user: req.session.user });
});

// Auth. Personnel access removed 2026-07-23 — Reports & Audit Trails are
// Administrator-only now (personnel had their own /personnel/reports page,
// also removed in the same change).
app.get('/reports', requireAdmin, (req, res) => {
  res.render('administrator/reports', { activePage: 'reports', user: req.session.user });
});

app.get('/users', requireAdmin, (req, res) => {
  res.render('users', { activePage: 'users', user: req.session.user });
});

// ── UNIFIED PARTNERSHIP REQUESTS PAGE ────────────────────────────────────────
app.get('/partnership-requests', requireAdmin, (req, res) => {
  res.render('administrator/partnership_requests', {
    activePage: 'access-requests',
    user: req.session.user
  });
});

app.get('/admin/settings', requireAdmin, (req, res) => {
  res.render('administrator/admin_settings', {
    activePage: 'settings',
    user: req.session.user,
    userEmail: req.session.user ? req.session.user.email : ''
  });
});

// ── AUTH. PERSONNEL ROUTES ────────────────────────────────────────────────────
// College Dean (stored role "Auth. Personnel") sees Monitoring, Requests, Calendar and Settings/Profile
// (plus the header Notifications bell). It has NO Dashboard page (the
// personnel_dashboard view was deliberately removed), and the Notifications
// PAGE and Document Library below are closed to that role via
// denyDepartmentPage (see its definition above).
//
// /personnel/dashboard is kept ONLY as a safe redirect so an old bookmark or
// link can never hit a missing view (500): Auth. Personnel lands on its
// Monitoring home; Administrator (also admitted by requirePersonnel) goes to
// its own dashboard. Nothing renders here.
app.get('/personnel/dashboard', requirePersonnel, (req, res) => {
  res.redirect(homeForRole(req.session.user.role));
});

app.get('/personnel/requests', requirePersonnel, async (req, res) => {
  // The request form's Contact No. starts as the number saved in Settings (still editable for this one request).
  let contactNumber = '';
  try {
    const doc = await getDb().collection('users').findOne({ id: req.session.user.id }, { projection: { contactNumber: 1 } });
    contactNumber = (doc && doc.contactNumber) || '';
  } catch (err) {
    console.error('Request form: could not read the saved contact number:', err.message);
  }
  res.render('auth. personnel/personnel_requests', {
    activePage: 'requests',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user,
    contactNumber
  });
});

// Request tracking, moved off the Requests page (2026-07-25) to match the
// potential_partner Requests/Monitoring split — same /mine endpoints, no new
// backend routes needed.
app.get('/personnel/monitoring', requirePersonnel, (req, res) => {
  res.render('auth. personnel/personnel_monitoring', {
    activePage: 'monitoring',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/lifecycle', requirePersonnel, (req, res) => {
  res.render('administrator/lifecycle', {
    activePage: 'lifecycle',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/calendar', requirePersonnel, (req, res) => {
  res.render('administrator/calendar', {
    activePage: 'calendar',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

// Open to College Dean again (2026-09-26) so the header bell's "View All Notifications" works for it like for every
// other staff role. Every notification API it calls is already scoped to the signed-in user's own notifications.
app.get('/personnel/notifications', requirePersonnel, (req, res) => {
  res.render('administrator/notifications', {
    activePage: 'notifications',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/documents', requirePersonnel, denyDepartmentPage, (req, res) => {
  res.render('administrator/documents', {
    activePage: 'documents',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user
  });
});

app.get('/personnel/settings', requirePersonnel, (req, res) => {
  res.render('auth. personnel/personnel_settings', {
    activePage: 'settings',
    sidebarPartial: 'sidebar_personnel',
    user: req.session.user,
    userEmail: req.session.user ? req.session.user.email : ''
  });
});

// ── STAFF ROUTES (2026-08-27 View-Only → Staff migration) ────────────────────
// Staff gets the same major modules as Administrator, minus destructive/
// security-sensitive actions (enforced server-side, not just hidden in the
// UI — see requireAdmin-only mutation routes throughout this file). Most
// pages below reuse the exact same shared Administrator templates via the
// sidebarPartial override, the same pattern already used for Auth. Personnel
// (see the personnel routes above) — Dashboard, Requests, and Settings get
// their own Staff-specific views instead, mirroring Personnel's equivalents.
app.get('/staff', requireStaffAccess, (req, res) => res.redirect('/staff/dashboard'));

// Staff uses the exact same Dashboard implementation as Administrator
// (2026-08-27 full-parity revision — no more duplicate staff_dashboard.ejs)
// — only the sidebarPartial and role-aware links inside admin_dashboard.ejs
// (isStaffRole) differ per role.
app.get('/staff/dashboard', requireStaffAccess, async (req, res) => {
  try {
    const db = getDb();
    const stats = await computeDashboardStats(db);
    res.render('administrator/admin_dashboard', {
      activePage: 'dashboard',
      sidebarPartial: 'sidebar_staff',
      user: req.session.user,
      ...stats
    });
  } catch (err) {
    console.error('Staff dashboard render error:', err);
    res.render('administrator/admin_dashboard', {
      activePage: 'dashboard',
      sidebarPartial: 'sidebar_staff',
      user: req.session.user,
      dashActive: 0, dashExpiring: 0, dashExpired: 0, dashTotal: 0,
      activePartnerships: [],
      insightRenewal: 'Could not load renewal data.',
      insightExpansion: 'Could not load expansion data.',
      insightOptimization: 'Could not load optimization data.'
    });
  }
});

app.get('/staff/calendar', requireStaffAccess, (req, res) => {
  res.render('administrator/calendar', {
    activePage: 'calendar',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// "Monitoring" — same consolidated Partnership Registry + Overview + DSS +
// Urgent page Administrator's own sidebar labels "Monitoring" (2026-09-05
// consolidation of the former separate Registry page into this one).
app.get('/staff/lifecycle', requireStaffAccess, (req, res) => {
  res.render('administrator/monitoring', {
    activePage: 'lifecycle',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// Requests — the same Administrator review page (partnership_requests.ejs
// role-gates its own Approve/Reject/Review actions to Administrator only).
// Staff sees a read-only "View" mode of their own submitted requests — as of
// 2026-08-27, Staff can no longer submit new Partnership or Document
// Requests at all (the "+ New Partnership Request" button and the
// staff_request_access.ejs form were removed; see requireRequester below,
// which already excludes Staff from every request-mutating route).
app.get('/staff/requests', requireStaffAccess, (req, res) => {
  res.render('administrator/partnership_requests', {
    activePage: 'access-requests',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// Registry — 2026-09-05: consolidated into Monitoring, same as the
// Administrator /registry route above. Compatibility redirect only.
app.get('/staff/registry', requireStaffAccess, (req, res) => {
  res.redirect('/staff/lifecycle');
});

app.get('/staff/documents', requireStaffAccess, (req, res) => {
  res.render('administrator/documents', {
    activePage: 'documents',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// Reports & Analytics — Reports / Audit Trail / Strategic Insights (DSS) are
// all tabs within this one template. GET /api/activitylogs (the Audit Trail
// tab's data source) scopes Staff to their own records only — see that route.
app.get('/staff/reports', requireStaffAccess, (req, res) => {
  res.render('administrator/reports', {
    activePage: 'reports',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

// User Management — view-only for Staff (users.ejs role-gates Add User/Edit/
// Deactivate to Administrator only); POST/PATCH/DELETE /api/users stay
// requireAdmin-only regardless of what the UI shows.
app.get('/staff/users', requireStaffAccess, (req, res) => {
  res.render('users', {
    activePage: 'users',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

app.get('/staff/notifications', requireStaffAccess, (req, res) => {
  res.render('administrator/notifications', {
    activePage: 'notifications',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user
  });
});

app.get('/staff/settings', requireStaffAccess, (req, res) => {
  res.render('staff/staff_settings', {
    activePage: 'settings',
    sidebarPartial: 'sidebar_staff',
    user: req.session.user,
    userEmail: req.session.user ? req.session.user.email : ''
  });
});

// ── POTENTIAL PARTNER ROUTES ──────────────────────────────────────────────────
// External organizations applying for / managing an official partnership with CSPC.
// Partner has NO Dashboard, Document Library or Notifications page (removed from
// its UI; the header Notifications bell remains). Requests, Monitoring, Calendar
// and Settings are what's left, and Monitoring is the landing page (homeForRole).
// The three removed URLs are kept ONLY as safe redirects so an old bookmark or
// notification link can never 404/500. The shared notification system, its APIs
// and the document APIs are untouched — Administrator/Staff/Department use them.
app.get('/partner', requirePartner, (req, res) => res.redirect(homeForRole(req.session.user.role)));
for (const removedPartnerPage of ['/partner/dashboard', '/partner/documents', '/partner/notifications']) {
  app.get(removedPartnerPage, requirePartner, (req, res) => res.redirect(homeForRole(req.session.user.role)));
}

app.get('/partner/requests', requirePartner, (req, res) => {
  res.render('potential_partner/partner_requests', {
    activePage: 'requests', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/calendar', requirePartner, (req, res) => {
  res.render('potential_partner/partner_calendar', {
    activePage: 'calendar', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/monitoring', requirePartner, (req, res) => {
  res.render('potential_partner/partner_monitoring', {
    activePage: 'monitoring', sidebarPartial: 'sidebar_partner', user: req.session.user
  });
});

app.get('/partner/settings', requirePartner, (req, res) => {
  res.render('potential_partner/partner_settings', {
    activePage: 'settings', sidebarPartial: 'sidebar_partner', user: req.session.user,
    userEmail: req.session.user ? req.session.user.email : ''
  });
});

// ── PARTNER PROFILE / SETTINGS API ────────────────────────────────────────────
// Unlike the admin/personnel profile docs (keyed by `role` — shared by every
// user of that role), partner profiles are keyed by `email` since there can be
// many distinct partner organizations, each needing their own profile.
app.get('/api/partner/profile', requirePartner, async (req, res) => {
  try {
    const db = getDb();
    const doc = await db.collection('profiles').findOne({ email: req.session.user.email });
    const userDoc = await db.collection('users').findOne({ id: req.session.user.id }, { projection: { avatarUrl: 1, googleAvatarUrl: 1 } });
    res.json({ ...(doc ? doc.profile : {}), avatarUrl: avatarUrlFor(userDoc) });
  } catch (err) {
    console.error('❌ Partner profile load error:', err);
    res.status(500).json({ error: 'Unable to load your profile right now. Please try again.' });
  }
});

app.post('/api/partner/profile', requirePartner, async (req, res) => {
  const { organization, contactName, contactNumber, address, notifyRequestUpdates, notifyApprovals, notifyDocuments, notifyMeetings, notifyRenewals } = req.body;
  try {
    const db = getDb();
    const profile = {
      organization: organization || '',
      contactName: contactName || '',
      email: req.session.user.email,
      contactNumber: contactNumber || '',
      address: address || '',
      notifyRequestUpdates: notifyRequestUpdates !== false,
      notifyApprovals: notifyApprovals !== false,
      notifyDocuments: notifyDocuments !== false,
      notifyMeetings: notifyMeetings !== false,
      notifyRenewals: notifyRenewals !== false
    };
    await db.collection('profiles').updateOne(
      { email: req.session.user.email },
      { $set: { email: req.session.user.email, profile } },
      { upsert: true }
    );
    if (contactName) {
      req.session.user.name = contactName;
      await db.collection('users').updateOne({ email: req.session.user.email }, { $set: { name: contactName, organization: organization || '' } });
      await propagateRequestorName(db, req.session.user.email, contactName);
    }
    res.json({ success: true, profile });
  } catch (err) {
    console.error('❌ Partner profile save error:', err);
    res.status(500).json({ error: 'Unable to save your profile right now. Please try again.' });
  }
});

app.post('/api/partner/password', partnerPasswordLimiter, requirePartner, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const db = getDb();
    // Look up by the stable numeric id, not email, for the same reason as the
    // admin/personnel password routes — id never drifts from the session.
    const userId = req.session.user.id;
    const userDoc = await db.collection('users').findOne({ id: userId });
    const passwordMatches = await verifyPassword(oldPassword, userDoc && userDoc.password);
    if (!passwordMatches)
      return res.status(400).json({ error: 'Current password is incorrect.' });
    if (!isStrongPassword(newPassword))
      return res.status(400).json({ error: PASSWORD_POLICY_MESSAGE });
    // $inc sessionVersion (2026-10 authentication hardening): revokes every OTHER already-open session for
    // this same account (picked up by the revalidation middleware above) — endSessionAfterPasswordChange()
    // below only ever ends THIS one request's own session, never reaches any other device/browser.
    await db.collection('users').updateOne({ id: userId }, { $set: { password: await hashPassword(newPassword) }, $inc: { sessionVersion: 1 } });
    return endSessionAfterPasswordChange(req, res);
  } catch (err) {
    console.error('❌ Partner password change error:', err);
    res.status(500).json({ error: 'Unable to update password right now. Please try again.' });
  }
});

// ── PROFILE PICTURE (every role) ──────────────────────────────────────────────
// The photo lives on the user's own `users` record (avatarUrl) and is copied into the session, so the header and
// sidebar of every page can show it. An account with no photo shows DEFAULT_AVATAR_URL. Uploading replaces the
// previous file on disk. Before this, only Partners could upload (stored in `profiles`, and wiped by the next profile
// save, which rewrites that whole document) and the other roles' Settings kept the photo in browser storage only.
async function saveAvatarUpload(req, res) {
  uploadAvatar.single('avatar')(req, res, async (err) => {
    if (err) {
      if (!err.clientSafe) console.error('❌ Avatar upload error:', err);
      return res.status(400).json({ error: err.clientSafe ? err.message : 'Upload failed. Please try again.' });
    }
    if (!req.file) return res.status(400).json({ error: 'No image was uploaded.' });
    if (!verifyMagicBytes(req.file)) {
      return res.status(400).json({ error: 'Unsupported file type. Only JPG, JPEG, and PNG are accepted.' });
    }
    try {
      const db = getDb();
      const avatarUrl = `/uploads/avatars/${req.file.filename}`;
      const previous = await db.collection('users').findOne({ id: req.session.user.id }, { projection: { avatarUrl: 1 } });
      await db.collection('users').updateOne({ id: req.session.user.id }, { $set: { avatarUrl } });
      req.session.user.avatarUrl = avatarUrl;
      deleteUploadedAvatar(previous && previous.avatarUrl);
      res.json({ success: true, avatarUrl });
    } catch (e) {
      fs.unlink(req.file.path, () => { });
      console.error('❌ Avatar upload error:', e);
      res.status(500).json({ error: 'Unable to save the uploaded photo right now. Please try again.' });
    }
  });
}

// Only files this app stored under /uploads/avatars/ are ever deleted — never the default image or any other path.
function deleteUploadedAvatar(url) {
  const match = typeof url === 'string' && url.match(/^\/uploads\/avatars\/([A-Za-z0-9._-]+)$/);
  if (match) fs.unlink(path.join(__dirname, 'uploads', 'avatars', match[1]), () => { });
}

// Partner photos uploaded before avatarUrl moved onto the users record were kept in profiles.profile.avatarUrl.
// Copied over once at startup (idempotent: only users that have no avatarUrl yet are touched).
async function migrateLegacyPartnerAvatars() {
  const db = getDb();
  const legacy = await db.collection('profiles').find({ 'profile.avatarUrl': { $exists: true, $ne: '' } }, { projection: { email: 1, 'profile.avatarUrl': 1 } }).toArray();
  for (const doc of legacy) {
    await db.collection('users').updateOne(
      { email: doc.email, $or: [{ avatarUrl: { $exists: false } }, { avatarUrl: '' }] },
      { $set: { avatarUrl: doc.profile.avatarUrl } }
    );
  }
}

app.post('/api/profile/avatar', requireAuth, saveAvatarUpload);
app.post('/api/partner/avatar', requirePartner, saveAvatarUpload); // older URL used by Partner Settings; same handler

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
  res.status(404).send('<h2>404 — Page not found</h2><a href="/">Go home</a>');
});

// A failure reaching the global error handler whose root cause is "the database is not reachable" (the
// MongoDB driver's own error classes for a dropped/unreachable connection, a failed server-selection
// attempt, or an operation that timed out — plus getDb()'s own synchronous guard before connectDB() has
// ever completed). Deliberately narrow: only genuine connectivity failures qualify, never a validation or
// application-logic error that happens to come from a DB call, so this never masks a real bug as "DB is down".
const DB_DOWN_ERROR_NAMES = new Set([
  'MongoNetworkError', 'MongoServerSelectionError', 'MongoTimeoutError',
  'MongoNotConnectedError', 'MongoTopologyClosedError', 'MongoServerClosedError'
]);
function isDatabaseDownError(err) {
  if (!err) return false;
  if (err.message === 'Database not initialized. Call connectDB first.') return true;
  return !!(err.name && DB_DOWN_ERROR_NAMES.has(err.name));
}

// Self-contained — no layout/partials, no external stylesheet or font — so it still renders correctly even
// though the thing that just failed is the app's own data layer; the same copy/tone as the client-side
// system-status banner (public/js/ciprms-system-status.js), just as a full page for the case where the
// failure happened before that page (and its banner script) ever got to render at all.
function renderDatabaseDownPage(res) {
  res.status(503).send(`<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>CIPRMS — Temporarily Unavailable</title>
<style>
  body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;background:#f8f9fa;color:#212529;
    display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px;box-sizing:border-box;}
  .card{max-width:480px;background:#fff;border-top:4px solid #f06548;border-radius:6px;
    box-shadow:0 2px 10px rgba(0,0,0,.08);padding:32px;text-align:center;}
  .card h1{font-size:19px;margin:12px 0 8px;}
  .card p{font-size:14px;color:#495057;line-height:1.5;margin:0 0 20px;}
  .actions{display:flex;gap:10px;justify-content:center;}
  .btn{display:inline-block;padding:8px 18px;border-radius:4px;font-size:13.5px;text-decoration:none;cursor:pointer;border:1px solid #ced4da;}
  .btn-primary{background:#f06548;color:#fff;border-color:#f06548;}
  .btn-light{background:#fff;color:#212529;}
</style></head>
<body>
  <div class="card">
    <div style="font-size:32px;" role="img" aria-label="Warning">⚠️</div>
    <h1>CIPRMS is currently unavailable</h1>
    <p>The database is not responding, so most pages and actions will fail until it recovers. Please try again shortly.</p>
    <div class="actions">
      <button type="button" class="btn btn-primary" onclick="location.reload()">Retry</button>
      <a class="btn btn-light" href="/">Go home</a>
    </div>
  </div>
</body></html>`);
}

// ── GLOBAL ERROR HANDLER ────────────────────────────────────────────────────
// Last-resort fallback for anything not already caught by a route's own
// try/catch — every route here already handles its own expected failure
// modes (validation errors, etc.) and returns its own message, so this only
// fires for genuinely unexpected failures (a throw outside any try/catch, or
// — since Express 5 auto-forwards rejected promises from async handlers to
// error middleware — an unhandled async rejection). Logs the real error
// server-side but never leaks it to the client, regardless of NODE_ENV
// (S13, Roadmap v2 Phase G4, docs/SYSTEM_AUDIT_2026-07-16.md).
//
// A database-connectivity failure gets its own friendlier "service unavailable" response (matching the
// client-side status banner's look/copy) ahead of the generic 500 fallback below, since it's an expected,
// recoverable outage rather than an application bug — the plain 500 page remains the fallback for anything
// that isn't recognizably a DB-down condition.
app.use((err, req, res, next) => {
  console.error('❌ Unhandled error:', err);
  if (res.headersSent) return next(err);
  const wantsJson = req.path.startsWith('/api/') || req.xhr || (req.headers.accept || '').includes('application/json');
  const dbDown = isDatabaseDownError(err);
  if (wantsJson) {
    res.status(dbDown ? 503 : 500).json({
      error: dbDown ? 'The database is not responding. Please try again shortly.' : 'An unexpected server error occurred.',
      ...(dbDown ? { code: 'DB_UNAVAILABLE' } : {})
    });
  } else if (dbDown) {
    renderDatabaseDownPage(res);
  } else {
    res.status(500).send('<h2>500 — Something went wrong</h2><a href="/">Go home</a>');
  }
});

// ── START ─────────────────────────────────────────────────────────────────────
// Only actually bind/connect/open-a-browser when this file is run directly
// (`node cirl.js`) — not when required as a module (e.g. by the test suite),
// which just needs the bare `app` to drive with supertest against its own
// test-managed DB connection.
if (require.main === module) {
  app.listen(PORT, async () => {
    const url = `http://localhost:${PORT}`;
    console.log(`CIPRMS server running → ${url}`);
    try {
      await connectDB();
      console.log(emailService.isConfigured()
        ? '✅ Email notifications configured (MAIL_USER set).'
        : '⚠️  Email notifications NOT configured — set RESEND_API_KEY and MAIL_USER to enable e-mail delivery (see .env.example).');
      await migrateLegacyPartnerAvatars().catch(err => console.error('⚠️  Partner avatar migration skipped:', err.message));
      await runLifecycleCheck(); // catch up immediately on startup, don't wait for the first interval tick
      setInterval(runLifecycleCheck, LIFECYCLE_CHECK_INTERVAL_MS);
    } catch (err) {
      // 2026-09-08 Phase 5 production-readiness fix: this used to only log
      // and keep running — the HTTP server was already bound (app.listen's
      // callback runs before this try/catch), so a failed DB connection left
      // a "zombie" process silently accepting requests that would all fail
      // once they touched getDb(). Exiting lets the host's process
      // supervisor (Render, systemd, Docker, etc.) restart the service and
      // retry the connection, instead of an outage persisting until someone
      // notices the app is up but non-functional. Matches the same
      // fail-closed philosophy already applied to a missing MONGO_URI in
      // db.js — a real DB outage should surface as a restart, not silence.
      console.error('❌ Failed to connect to MongoDB on startup — exiting so the process can be restarted:', err);
      process.exit(1);
    }
    try {
      const { default: open } = await import('open');
      open(url);
    } catch (err) {
      console.log('Could not auto-open browser, but server is running');
    }
  });
}

module.exports = app;