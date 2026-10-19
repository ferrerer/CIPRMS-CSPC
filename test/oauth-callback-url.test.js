// OAuth callback URL construction (2026-10 Phase 1.1 independent-review fix, Findings 2 & 3). cirl.js's
// publicBaseUrl() (shared by getCallbackUrl(), getGoogleCalendarCallbackUrl(), getGoogleDocsCallbackUrl())
// now prefers the configured APP_BASE_URL over the request's own Host/X-Forwarded-Proto headers, and — the
// actual fix — refuses to fall back to those headers at all when NODE_ENV=production, failing the request
// safely instead of silently trusting client-controllable headers to build a real OAuth redirect URL. The
// local-dev/test fallback remains available for every other NODE_ENV (including unset, which is what this
// project's own real local `node cirl.js` runs use — confirmed directly, see cirl.js's own comment on
// publicBaseUrl() for why this is a deny-list on 'production' rather than an allow-list on
// 'development'/'test').
//
// publicBaseUrl() itself is not exported (only `app` is) — observed indirectly through real HTTP responses:
// the Calendar/Docs "status" endpoints return their computed redirectUri directly in JSON (built for exactly
// this purpose — so an Administrator can copy it into Google Cloud Console), and the real (unmocked)
// passport-google-oauth20 strategy embeds the computed callback URL as the `redirect_uri` query parameter on
// its redirect to Google — no network call happens building that URL, so no mocking is needed for the
// sign-in route either.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db;
const LOOPBACK = ['::1', '::ffff:127.0.0.1', '127.0.0.1'];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

async function clearLockouts(keys) {
  await db.collection('loginLockouts').deleteMany({ key: { $in: keys } });
}

// Toggles any number of env vars for the duration of `fn`, restoring the exact previous state (including
// "was absent") afterward even if `fn` throws — same technique as the established withRealLockout() pattern
// in test/google-oauth-rate-limit.test.js, generalized to more than just NODE_ENV.
async function withEnv(overrides, fn) {
  const saved = {};
  for (const key of Object.keys(overrides)) saved[key] = process.env[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  try {
    await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
}

describe('APP_BASE_URL takes precedence over the request Host header for all three integrations', () => {
  test('Google Calendar status reports a redirectUri built from APP_BASE_URL, ignoring a spoofed Host header', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    await withEnv({ APP_BASE_URL: 'https://configured.example.test' }, async () => {
      const res = await agent.get('/api/google-calendar/status').set('Host', 'attacker-controlled.example');
      expect(res.status).toBe(200);
      expect(res.body.redirectUri).toBe('https://configured.example.test/api/google-calendar/callback');
    });
  });

  test('Google Docs status reports a redirectUri built from APP_BASE_URL, ignoring a spoofed Host header', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    await withEnv({ APP_BASE_URL: 'https://configured.example.test' }, async () => {
      const res = await agent.get('/api/google-docs/status').set('Host', 'attacker-controlled.example');
      expect(res.status).toBe(200);
      expect(res.body.redirectUri).toBe('https://configured.example.test/api/google-docs/callback');
    });
  });

  test('Google sign-in\'s real redirect to Google embeds the APP_BASE_URL-built callback, ignoring a spoofed Host header', async () => {
    await clearLockouts(LOOPBACK);
    await withEnv({ APP_BASE_URL: 'https://configured.example.test' }, async () => {
      const res = await request(app).get('/auth/google').set('Host', 'attacker-controlled.example');
      expect(res.status).toBe(302);
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('redirect_uri')).toBe('https://configured.example.test/auth/google/callback');
    });
  });

  test('a trailing slash on APP_BASE_URL is stripped once, never doubled', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    await withEnv({ APP_BASE_URL: 'https://configured.example.test/' }, async () => {
      const res = await agent.get('/api/google-calendar/status');
      expect(res.body.redirectUri).toBe('https://configured.example.test/api/google-calendar/callback');
    });
  });
});

describe('Each of the three callback paths is constructed correctly', () => {
  test('exact paths: /auth/google/callback, /api/google-calendar/callback, /api/google-docs/callback', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    await clearLockouts(LOOPBACK);
    await withEnv({ APP_BASE_URL: 'https://configured.example.test' }, async () => {
      const signInRes = await request(app).get('/auth/google');
      expect(new URL(signInRes.headers.location).searchParams.get('redirect_uri')).toBe('https://configured.example.test/auth/google/callback');

      const calendarRes = await agent.get('/api/google-calendar/status');
      expect(calendarRes.body.redirectUri).toBe('https://configured.example.test/api/google-calendar/callback');

      const docsRes = await agent.get('/api/google-docs/status');
      expect(docsRes.body.redirectUri).toBe('https://configured.example.test/api/google-docs/callback');
    });
  });
});

describe('Missing or invalid APP_BASE_URL in production fails safely — never falls back to request headers', () => {
  test('GET /auth/google answers a safe generic error (not a Host-derived redirect) when APP_BASE_URL is unset in production', async () => {
    await clearLockouts(LOOPBACK);
    await withEnv({ NODE_ENV: 'production', APP_BASE_URL: undefined }, async () => {
      const res = await request(app).get('/auth/google').set('Host', 'attacker-controlled.example');
      expect(res.status).toBe(500);
      expect(res.text).toMatch(/temporarily unavailable/i);
      expect(res.text).not.toContain('attacker-controlled.example');
    });
  });

  test('Google Calendar connect redirects to a safe Settings error (not an attacker-influenced OAuth URL) under the same condition', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    await withEnv({ NODE_ENV: 'production', APP_BASE_URL: undefined }, async () => {
      const res = await agent.get('/api/google-calendar/connect').set('Host', 'attacker-controlled.example');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/settings?googleCalendar=error&reason=config');
      expect(res.headers.location).not.toContain('attacker-controlled.example');
    });
  });

  test('Google Docs connect redirects to a safe Settings error under the same condition', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    await withEnv({ NODE_ENV: 'production', APP_BASE_URL: undefined }, async () => {
      const res = await agent.get('/api/google-docs/connect').set('Host', 'attacker-controlled.example');
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/admin/settings?googleDocs=error&reason=config');
    });
  });

  test('an invalid (non-absolute-http(s)) APP_BASE_URL also fails safely in production rather than being used as-is', async () => {
    await clearLockouts(LOOPBACK);
    await withEnv({ NODE_ENV: 'production', APP_BASE_URL: 'not a valid url' }, async () => {
      const res = await request(app).get('/auth/google');
      expect(res.status).toBe(500);
    });
  });

  test('an invalid APP_BASE_URL is also refused OUTSIDE production — never silently used even when the fallback is otherwise permitted', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const agent = request.agent(app);
    await loginAs(agent, admin);
    await withEnv({ APP_BASE_URL: 'ftp://not-http.example' }, async () => {
      const res = await agent.get('/api/google-calendar/status');
      expect(res.status).toBe(500); // caught by this route's own existing try/catch
      expect(res.body.error).not.toMatch(/ftp|not-http/i);
    });
  });
});

describe('The local-development fallback activates only outside production, and only when APP_BASE_URL is unset', () => {
  test('with APP_BASE_URL unset and NODE_ENV unset (matching this project\'s real local `node cirl.js` runs), the Host-derived fallback is used', async () => {
    await clearLockouts(LOOPBACK);
    await withEnv({ APP_BASE_URL: undefined, NODE_ENV: undefined }, async () => {
      const res = await request(app).get('/auth/google').set('Host', 'localhost:4321');
      expect(res.status).toBe(302); // a real redirect was built, not a config-error failure
      const location = new URL(res.headers.location);
      expect(location.searchParams.get('redirect_uri')).toBe('http://localhost:4321/auth/google/callback');
    });
  });

  test('the same fallback is used under NODE_ENV=development', async () => {
    await clearLockouts(LOOPBACK);
    await withEnv({ APP_BASE_URL: undefined, NODE_ENV: 'development' }, async () => {
      const res = await request(app).get('/auth/google').set('Host', 'localhost:4321');
      expect(res.status).toBe(302);
      expect(new URL(res.headers.location).searchParams.get('redirect_uri')).toBe('http://localhost:4321/auth/google/callback');
    });
  });

  test('NODE_ENV=production is the ONLY value that blocks the fallback — confirms the gate is a deny-list, not an allow-list', async () => {
    await clearLockouts(LOOPBACK);
    await withEnv({ APP_BASE_URL: undefined, NODE_ENV: 'staging' }, async () => {
      const res = await request(app).get('/auth/google').set('Host', 'localhost:4321');
      expect(res.status).toBe(302); // still falls back — only 'production' itself is denied
    });
  });
});
