// AI Strategic Insights / Ask a Question moved to Reports & Analytics → Strategic Insights (DSS)
// (2026-11), replacing Partnership Recommendations (left card) and Partnership Health Score (right
// card). Endpoints/prompts/response formats are unchanged — only the EJS/client-JS location moved,
// so this mirrors the dashboard's own former coverage (test/ai-insights-dashboard-ui.test.js) but
// pointed at /reports and /staff/reports instead.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

describe('Reports & Analytics → Strategic Insights (DSS): AI Strategic Insights & Ask a Question', () => {
  let db;
  beforeAll(async () => { db = await connectDB(); });
  afterAll(async () => { await cleanupAll(); await closeDB(); });

  test.each([
    ['Administrator', '/reports'],
    ['Staff', '/staff/reports'],
  ])('%s: %s has the moved AI Strategic Insights card, Ask a Question card, every required state container, and never auto-fires a Gemini call', async (role, path) => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role }));
    const res = await agent.get(path);
    expect(res.status).toBe(200);

    expect(res.text).toContain('id="content-insights"');
    expect(res.text).toContain('id="ai-insights-card"');
    expect(res.text).toContain('AI Strategic Insights');
    expect(res.text).toContain('Gemini interprets the institutional indicators already computed');
    expect(res.text).toContain('id="ai-ask-card"');
    expect(res.text).toContain('Ask a Question');

    // Moved exactly: Verified Figures, unit table/targets containers, Generate button, interpretation.
    for (const id of [
      'ai-generate-btn', 'ai-regenerate-btn', 'ai-retry-btn',
      'ai-state-checking', 'ai-state-blocked', 'ai-state-empty', 'ai-state-generating', 'ai-state-error', 'ai-state-ready',
      'ai-verified-figures', 'ai-interpretation-list', 'ai-recommendations-wrap', 'ai-recommendation-list',
      'ai-ask-input', 'ai-ask-submit-btn', 'ai-ask-retry-btn',
      'ai-ask-state-blocked', 'ai-ask-state-asking', 'ai-ask-state-unsupported', 'ai-ask-state-error', 'ai-ask-state-answered',
      'ai-ask-verified-figures', 'ai-ask-answer-list',
    ]) {
      expect(res.text).toContain(`id="${id}"`);
    }

    // Partnership Recommendations / Partnership Health Score are gone.
    expect(res.text).not.toContain('Partnership Recommendations');
    expect(res.text).not.toContain('Partnership Health Score');
    expect(res.text).not.toContain('id="dss-alert"');
    expect(res.text).not.toContain('id="health-score"');

    // Mount-time behavior unchanged: only a free cache-check, never generate:true on load.
    expect(res.text).toMatch(/aiCheck\(\);\s*\/\/ the ONLY call fired on page load/);
    expect(res.text).not.toMatch(/loadDssInsights/);
  });

  test.each([
    ['Administrator', '/reports'],
    ['Staff', '/staff/reports'],
  ])('%s: %s — layout (2026-11): both AI cards are full width, stacked, and share the scroll-box class', async (role, path) => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role }));
    const res = await agent.get(path);
    expect(res.status).toBe(200);

    // Both cards are now col-xl-12 (full width); the old 8/4 split is gone from this tab.
    const insightsCardIdx = res.text.indexOf('id="ai-insights-card"');
    const askCardIdx = res.text.indexOf('id="ai-ask-card"');
    expect(insightsCardIdx).toBeGreaterThan(-1);
    expect(askCardIdx).toBeGreaterThan(insightsCardIdx); // Ask a Question now sits BELOW Insights
    const colOpenBeforeInsights = res.text.lastIndexOf('<div class="col-xl-12">', insightsCardIdx);
    const colOpenBeforeAsk = res.text.lastIndexOf('<div class="col-xl-12">', askCardIdx);
    expect(colOpenBeforeInsights).toBeGreaterThan(-1);
    expect(colOpenBeforeAsk).toBeGreaterThan(-1);
    expect(res.text).not.toContain('<div class="col-xl-8">');
    expect(res.text).not.toContain('<div class="col-xl-4">');

    // The scroll-box class is defined once and applied 4 times (2 boxes per card).
    expect(res.text).toContain('.ai-scroll-box {');
    const scrollBoxCount = (res.text.match(/class="[^"]*\bai-scroll-box\b/g) || []).length;
    expect(scrollBoxCount).toBe(4); // 2 boxes in the Insights card + 2 in the Ask a Question card
  });

  test('a role with no access to Reports (e.g. potential_partner) cannot reach either route or see the panel', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role: 'potential_partner' }));
    const res1 = await agent.get('/reports');
    const res2 = await agent.get('/staff/reports');
    expect([301, 302, 401, 403]).toContain(res1.status);
    expect([301, 302, 401, 403]).toContain(res2.status);
  });

  test('Staff cannot reach the Administrator-only /reports path (must use /staff/reports instead) — pre-existing RBAC, unchanged', async () => {
    const agent = request.agent(app);
    await loginAs(agent, await createTestUser({ role: 'Staff' }));
    const res = await agent.get('/reports');
    expect([301, 302, 401, 403]).toContain(res.status);
  });

  test('no session -> both report routes redirect/deny, never render the panel', async () => {
    const res1 = await request(app).get('/reports');
    const res2 = await request(app).get('/staff/reports');
    expect([301, 302, 401, 403]).toContain(res1.status);
    expect([301, 302, 401, 403]).toContain(res2.status);
  });
});
