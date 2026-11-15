// Route-level wiring: RBAC on POST /api/ai-insights* (Staff/Admin only, same gate as Reports/
// Monitoring/Targets-viewing), and the default-blocked-without-approval behavior reaching all the
// way through the real Express app (no mocked Gemini needed here — with
// INSTITUTIONAL_AI_DATA_APPROVED unset, the route never gets far enough to need one).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

describe('POST /api/ai-insights* — RBAC and default-blocked behavior', () => {
  let db;
  const ORIGINAL = process.env.INSTITUTIONAL_AI_DATA_APPROVED;

  beforeAll(async () => {
    db = await connectDB();
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
  });
  afterAll(async () => {
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = ORIGINAL;
    await db.collection('aiinsightscache').deleteMany({});
    await cleanupAll();
    await closeDB();
  });

  test('no session -> 401/302, not 200', async () => {
    const res = await request(app).post('/api/ai-insights').send({});
    expect([301, 302, 401, 403]).toContain(res.status);
  });

  test('Auth. Personnel (College Dean) and potential_partner get no access', async () => {
    for (const role of ['Auth. Personnel', 'potential_partner']) {
      const agent = request.agent(app);
      await loginAs(agent, await createTestUser({ role, unit: role === 'Auth. Personnel' ? 'CCS' : '' }));
      const res = await agent.post('/api/ai-insights').send({});
      expect([301, 302, 401, 403]).toContain(res.status);
    }
  });

  test.each([['Administrator'], ['Staff']])('%s can reach the route and gets the deterministic-blocked shape (approval unset)', async (role) => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role }));
    const res = await agent.post('/api/ai-insights').send({ generate: true });
    expect(res.status).toBe(200);
    expect(res.body.aiBlocked).toBe(true);
    expect(res.body.ai).toBeNull();
    expect(res.body.deterministic).toBeTruthy();
    expect(res.body.deterministic.ranking).toBeDefined();
  });

  test('executive-briefing endpoint has the same RBAC and blocked behavior', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role: 'Staff' }));
    const res = await agent.post('/api/ai-insights/executive-briefing').send({ generate: true });
    expect(res.status).toBe(200);
    expect(res.body.aiBlocked).toBe(true);
  });

  test('a non-boolean generate value is rejected with 400, not 500', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role: 'Staff' }));
    const res = await agent.post('/api/ai-insights').send({ generate: 'yes' });
    expect(res.status).toBe(400);
  });

  test('an AI_INSIGHT_REQUEST audit log entry is written, with no prompt text or API key', async () => {
    const agent = request.agent(app);
    const user = await createTestUser({ role: 'Staff' });
    await loginAs(agent, user);
    await agent.post('/api/ai-insights').send({ generate: true });
    const log = await db.collection('activitylogs').find({ action: 'AI_INSIGHT_REQUEST', email: user.email }).sort({ id: -1 }).limit(1).toArray();
    expect(log).toHaveLength(1);
    expect(log[0].status).toBe('blocked');
    expect(JSON.stringify(log[0])).not.toMatch(/GEMINI_API_KEY|sk-|AIza/);
  });
});
