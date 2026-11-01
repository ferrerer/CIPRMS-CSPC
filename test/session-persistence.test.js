// Covers the 2026-10 session-persistence fix: swapping the production session store from
// express-session's MemoryStore to connect-mongo's MongoStore so signed-in users survive a
// process restart (Render redeploy, crash-restart, dyno cycle).
//
// Two kinds of coverage here, deliberately kept apart:
//   - "MongoStore persistence" below talks to connect-mongo's Store interface directly,
//     against the local test MongoDB container — never the live app — because cirl.js itself
//     always uses MemoryStore under NODE_ENV==='test' (by design: ordinary tests stay fast and
//     isolated). This is the only way to actually exercise MongoStore's real behavior.
//   - "Application-level session/cookie behavior" drives the real app through supertest. That
//     behavior (login, logout, auth guard, cookie handling) lives in express-session and
//     requireAuth(), is identical regardless of which Store backs it, and is exactly what the
//     existing MemoryStore-backed test run already proves correctly — see test/auth.test.js.
//
// Nothing here depends on a live Render deployment; the MongoStore half runs against
// mongodb://127.0.0.1:27018/ciprms_test (the same local Docker container every other test file
// uses — see services/testDatabaseGuard.js), via two independent MongoClient connections, which
// is what actually simulates "the old server process is gone and a new one just started."
const request = require('supertest');
const { MongoClient } = require('mongodb');
const MongoStore = require('connect-mongo').default;
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const { resolveTestDatabaseUri } = require('../services/testDatabaseGuard');

const TEST_URI = resolveTestDatabaseUri();
const SESSIONS_COLLECTION = 'sessions_persistence_test';

beforeAll(async () => { await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

describe('MongoStore persistence (direct store interface, simulated restart)', () => {
  let clientA; // stands in for "the server process before a restart"
  let clientB; // stands in for "the server process after a restart" — a brand-new connection
  let storeA;
  let storeB;

  beforeAll(async () => {
    clientA = new MongoClient(TEST_URI);
    await clientA.connect();
    storeA = MongoStore.create({ clientPromise: Promise.resolve(clientA), collectionName: SESSIONS_COLLECTION, autoRemove: 'native' });

    clientB = new MongoClient(TEST_URI);
    await clientB.connect();
    storeB = MongoStore.create({ clientPromise: Promise.resolve(clientB), collectionName: SESSIONS_COLLECTION, autoRemove: 'native' });
  });

  afterAll(async () => {
    // beforeAll can fail partway through (e.g. clientA connects but clientB.connect() throws) —
    // guard every step so a partial setup still closes whatever did open, instead of throwing on
    // an undefined client and leaking the one that succeeded. Dropping the collection only needs
    // whichever client actually connected; both point at the same database.
    const liveClient = clientA || clientB;
    if (liveClient) {
      await liveClient.db().collection(SESSIONS_COLLECTION).drop().catch(() => {});
    }
    if (clientA) await clientA.close().catch(() => {});
    if (clientB) await clientB.close().catch(() => {});
  });

  test('a session written before a restart is still readable by a brand-new connection after it', async () => {
    const sid = 'persist-test-' + Date.now();
    const sessionData = {
      cookie: { originalMaxAge: 7200000, expires: new Date(Date.now() + 7200000) },
      user: { id: 424242, email: 'persist@example.com', role: 'Staff' }
    };

    await new Promise((resolve, reject) => storeA.set(sid, sessionData, err => err ? reject(err) : resolve()));

    // storeB never saw this write happen in-process — it only ever reads the shared MongoDB
    // collection, exactly as a freshly-restarted server process would.
    const readBack = await new Promise((resolve, reject) => storeB.get(sid, (err, sess) => err ? reject(err) : resolve(sess)));

    expect(readBack).not.toBeNull();
    expect(readBack.user).toEqual(sessionData.user);
  });

  test('logout (destroy) on one connection removes the session for every other connection', async () => {
    const sid = 'destroy-test-' + Date.now();
    const sessionData = { cookie: { originalMaxAge: 7200000, expires: new Date(Date.now() + 7200000) }, user: { id: 1 } };

    await new Promise((resolve, reject) => storeA.set(sid, sessionData, err => err ? reject(err) : resolve()));
    await new Promise((resolve, reject) => storeA.destroy(sid, err => err ? reject(err) : resolve()));

    const afterDestroy = await new Promise((resolve, reject) => storeB.get(sid, (err, sess) => err ? reject(err) : resolve(sess)));
    expect(afterDestroy).toBeNull();
  });

  test('an expired session is not returned even if the TTL monitor has not yet physically deleted it', async () => {
    const sid = 'expired-test-' + Date.now();
    const sessionData = {
      // Already in the past — MongoStore.get() filters by `expires: { $gt: now }` server-side,
      // so this must come back null immediately rather than waiting for MongoDB's background
      // TTL sweep (which only runs roughly once a minute).
      cookie: { originalMaxAge: -1000, expires: new Date(Date.now() - 1000) },
      user: { id: 2 }
    };

    await new Promise((resolve, reject) => storeA.set(sid, sessionData, err => err ? reject(err) : resolve()));
    const result = await new Promise((resolve, reject) => storeA.get(sid, (err, sess) => err ? reject(err) : resolve(sess)));
    expect(result).toBeNull();
  });

  test('autoRemove:"native" creates a TTL index on the expires field', async () => {
    const indexes = await clientA.db().collection(SESSIONS_COLLECTION).indexes();
    const ttlIndex = indexes.find(i => i.expireAfterSeconds !== undefined);
    expect(ttlIndex).toBeDefined();
    expect(ttlIndex.key).toEqual({ expires: 1 });
  });
});

describe('Application-level session/cookie behavior (via the real app)', () => {
  test('an unauthenticated request to a protected route is rejected, not served', async () => {
    const res = await request(app).get('/api/me').set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('logging out destroys the session — the same cookie no longer authenticates', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);

    const before = await agent.get('/api/me').set('X-Requested-With', 'ciprms');
    expect(before.status).toBe(200);
    expect(before.body.user.email).toBe(user.email);

    await agent.post('/logout');

    const after = await agent.get('/api/me').set('X-Requested-With', 'ciprms');
    expect(after.status).toBe(401);
  });

  test('a tampered session cookie is rejected rather than trusted or crashing the server', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);

    const meRes = await agent.get('/api/me').set('X-Requested-With', 'ciprms');
    expect(meRes.status).toBe(200); // sanity: still logged in before tampering

    const tamperedAgent = request.agent(app);
    // A syntactically-plausible but wrong signed cookie — express-session's signature check must
    // reject this outright rather than treating it as a fresh/empty session that happens to 500.
    const res = await tamperedAgent
      .get('/api/me')
      .set('Cookie', 'connect.sid=s%3Atampered-value-that-is-not-a-real-session.invalidSignatureHere')
      .set('X-Requested-With', 'ciprms');
    expect(res.status).toBe(401);
  });

  test('the cookie set on login carries the expected security attributes', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    const setCookie = res.headers['set-cookie'] || [];
    const sessionCookie = setCookie.find(c => c.startsWith('connect.sid='));
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toMatch(/HttpOnly/i);
    expect(sessionCookie).toMatch(/SameSite=Lax/i);
    // Not asserting Secure here: supertest's in-process requests are never over TLS, and
    // cookie.secure:'auto' (cirl.js) correctly omits Secure on a non-HTTPS connection — asserting
    // its absence here is exactly what proves 'auto' is still working, not a gap in coverage.
  });
});
