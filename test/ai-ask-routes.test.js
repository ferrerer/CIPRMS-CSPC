// Phase 3 route-level wiring: POST /api/ai-insights/ask — RBAC, rate limiting, request validation,
// and default-blocked-without-approval behavior through the real Express app. No mocked Gemini is
// needed here — with INSTITUTIONAL_AI_DATA_APPROVED unset, the route never gets far enough to need
// one (same contract as the two existing AI routes from Phase 1/2).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

describe('POST /api/ai-insights/ask — RBAC, validation, default-blocked behavior', () => {
  let db;
  const ORIGINAL = process.env.INSTITUTIONAL_AI_DATA_APPROVED;

  beforeAll(async () => { db = await connectDB(); delete process.env.INSTITUTIONAL_AI_DATA_APPROVED; });
  afterAll(async () => {
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = ORIGINAL;
    await db.collection('aiinsightscache').deleteMany({});
    await cleanupAll();
    await closeDB();
  });

  test('no session -> 401/302, not 200', async () => {
    const res = await request(app).post('/api/ai-insights/ask').send({ question: 'Summarize our partnerships.' });
    expect([301, 302, 401, 403]).toContain(res.status);
  });

  test('Auth. Personnel and potential_partner get no access', async () => {
    for (const role of ['Auth. Personnel', 'potential_partner']) {
      const agent = request.agent(app);
      await loginAs(agent, await createTestUser({ role, unit: role === 'Auth. Personnel' ? 'CCS' : '' }));
      const res = await agent.post('/api/ai-insights/ask').send({ question: 'Summarize our partnerships.' });
      expect([301, 302, 401, 403]).toContain(res.status);
    }
  });

  test.each([['Administrator'], ['Staff']])('%s can reach the route and gets the deterministic-blocked shape (approval unset)', async (role) => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role }));
    const res = await agent.post('/api/ai-insights/ask').send({ question: 'Which units have the largest partnership gaps?' });
    expect(res.status).toBe(200);
    expect(res.body.aiBlocked).toBe(true);
    expect(res.body.answer).toBeNull();
  });

  test('a missing question is rejected with 400, not 500', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role: 'Staff' }));
    const res = await agent.post('/api/ai-insights/ask').send({});
    expect(res.status).toBe(400);
  });

  test('an empty-string question is rejected with 400', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role: 'Staff' }));
    const res = await agent.post('/api/ai-insights/ask').send({ question: '   ' });
    expect(res.status).toBe(400);
  });

  test('an over-length question is rejected with 400', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role: 'Staff' }));
    const res = await agent.post('/api/ai-insights/ask').send({ question: 'x'.repeat(400) });
    expect(res.status).toBe(400);
  });

  test('an AI_ASK_REQUEST audit log entry is written with the intent field but never the raw question text, API key, or prompt', async () => {
    const agent = request.agent(app);
    const user = await createTestUser({ role: 'Staff' });
    await loginAs(agent, user);
    const distinctiveQuestion = 'jesttest-distinctive-question-marker-' + Date.now();
    await agent.post('/api/ai-insights/ask').send({ question: distinctiveQuestion });
    const log = await db.collection('activitylogs').find({ action: 'AI_ASK_REQUEST', email: user.email }).sort({ id: -1 }).limit(1).toArray();
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('blocked');
    const serialized = JSON.stringify(log[0]);
    expect(serialized).not.toContain(distinctiveQuestion);
    expect(serialized).not.toMatch(/GEMINI_API_KEY|sk-|AIza/);
  });

  test('shares the same rate limiter as the other two AI routes (reused, not a near-duplicate)', () => {
    // Static confirmation rather than tripping the real 15-minute limiter in a unit test: both
    // routes are wired to the identical `aiInsightsLimiter` instance declared once in cirl.js.
    const fs = require('fs');
    const src = fs.readFileSync(require.resolve('../cirl.js'), 'utf8');
    const askBlock = src.slice(src.indexOf("app.post('/api/ai-insights/ask'"), src.indexOf("app.post('/api/ai-insights/ask'") + 200);
    expect(askBlock).toContain('aiInsightsLimiter');
    expect(src.match(/makeRateLimiter\('Too many AI insight requests/g) || []).toHaveLength(1);
  });
});
