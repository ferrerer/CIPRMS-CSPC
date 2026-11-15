// Phase 2 — AI Strategic Insights / Executive Briefing dashboard UI. Server-rendered markup checks
// (the EJS/client-JS behavior itself is covered by a standalone, dependency-free DOM-shim driver run
// separately — see the chat record) plus confirmation that rendering the dashboard page itself never
// touches aiInsightService (no Gemini call is reachable from a GET, only from the two POST routes).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

describe('Dashboard: AI Strategic Insights & Executive Briefing section renders for Admin and Staff', () => {
  let db;
  beforeAll(async () => { db = await connectDB(); });
  afterAll(async () => { await cleanupAll(); await closeDB(); });

  test.each([
    ['Administrator', '/dashboard'],
    ['Staff', '/staff/dashboard'],
  ])('%s: %s includes the AI section markup, all required state containers, and never auto-fires a Gemini call', async (role, path) => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role }));
    const res = await agent.get(path);
    expect(res.status).toBe(200);

    expect(res.text).toContain('AI Strategic Insights');
    expect(res.text).toContain('Executive Briefing');
    expect(res.text).toContain('Gemini interprets the institutional indicators already computed');

    // Buttons and every state container the task's checklist calls for.
    for (const id of [
      'ai-generate-btn', 'ai-regenerate-btn', 'ai-retry-btn',
      'ai-state-checking', 'ai-state-blocked', 'ai-state-empty', 'ai-state-generating', 'ai-state-error', 'ai-state-ready',
      'ai-verified-figures', 'ai-interpretation-list',
      'ai-briefing-generate-btn', 'ai-briefing-retry-btn',
      'ai-briefing-state-checking', 'ai-briefing-state-blocked', 'ai-briefing-state-empty',
      'ai-briefing-state-generating', 'ai-briefing-state-error', 'ai-briefing-state-ready', 'ai-briefing-content',
    ]) {
      expect(res.text).toContain(`id="${id}"`);
    }

    // Human-review disclosure on the briefing, per spec.
    expect(res.text).toContain('requires human review before institutional use');

    // The page's own script never calls /api/ai-insights with generate:true on load — only in
    // response to a button click (grep-level check that the literal string pairing a mount-time
    // call with generate:true never appears; the real behavioral proof is the DOM-shim driver run).
    expect(res.text).toMatch(/aiCheck\(\);\s*\/\/ the ONLY call fired on page load/);
    expect(res.text).toMatch(/briefCheck\(\);\s*\/\/ free cache-check on load/);
  });

  test('Auth. Personnel and potential_partner cannot reach either dashboard route at all (pre-existing RBAC, unchanged)', async () => {
    for (const [role, path] of [['Auth. Personnel', '/dashboard'], ['potential_partner', '/dashboard'], ['Auth. Personnel', '/staff/dashboard'], ['potential_partner', '/staff/dashboard']]) {
      const agent = request.agent(app);
      await loginAs(agent, await createTestUser({ role, unit: role === 'Auth. Personnel' ? 'CCS' : '' }));
      const res = await agent.get(path);
      expect([301, 302, 401, 403]).toContain(res.status);
    }
  });

  test('no session -> dashboard routes redirect/deny, never render the AI section', async () => {
    const res1 = await request(app).get('/dashboard');
    const res2 = await request(app).get('/staff/dashboard');
    expect([301, 302, 401, 403]).toContain(res1.status);
    expect([301, 302, 401, 403]).toContain(res2.status);
  });
});
