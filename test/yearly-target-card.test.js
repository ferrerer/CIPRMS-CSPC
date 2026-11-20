// Yearly Target dashboard card (2026-11, Decision Support & Insights — replaces "Expansion
// Opportunity"). Reuses the existing Target Tracker (/api/targets, computeTargetAccomplishment) and
// the existing Gemini AI layer (aiInsightService) — this file only covers the NEW surface: the
// dashboard card itself, the status-label/days-left formula, Staff now being allowed to set/edit a
// target (2026-11, confirmed for this card), and the new per-target AI suggestion route.
//
// "On track"/"Behind pace" are date-dependent by nature (they compare progress against how much of
// the CURRENT year has elapsed) — the cases below are picked to be robust for any day of year EXCEPT
// the very last ~2 weeks of December (see each test's own comment), which is an accepted, documented
// trade-off rather than a real flake risk.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const aiInsightService = require('../services/aiInsightService');

let db;
let adminAgent, staffAgent, personnelAgent, partnerAgent;
const createdTargetIds = [];
const createdPartnershipIds = [];
const CURRENT_YEAR = new Date().getFullYear();

async function seedPartnership(startDate) {
  const last = await db.collection('partnerships').find({}).sort({ id: -1 }).limit(1).toArray();
  const id = last.length ? last[0].id + 1 : 1;
  const doc = {
    id, inst: 'jesttest Yearly Target Univ', country: 'Testland', region: 'Test Region',
    type: 'MOA', nature: 'New', cat: 'Academic', unit: ['CCS'],
    start: startDate, end: 'Dec 31, 2099', status: 'Active', remarks: 'jesttest'
  };
  await db.collection('partnerships').insertOne(doc);
  createdPartnershipIds.push(id);
  return doc;
}

async function clearYearlyTarget() {
  await db.collection('targets').deleteMany({ type: 'yearly', year: CURRENT_YEAR });
}

// The card's EJS markup wraps onto many lines for readability (an interpolated value often sits on
// its own line) — browsers collapse that whitespace visually, but a literal toContain() check would
// not, so page-text assertions below compare against whitespace-collapsed text instead.
function normalizeWhitespace(s) {
  return s.replace(/\s+/g, ' ');
}

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  partnerAgent = request.agent(app);
  await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
  await clearYearlyTarget();
});

afterAll(async () => {
  if (createdTargetIds.length) await db.collection('targets').deleteMany({ id: { $in: createdTargetIds } });
  await db.collection('aiinsightscache').deleteMany({ scope: 'target_suggestion' });
  await cleanupAll();
  await closeDB();
});

describe('Dashboard card: renders for both Admin and Staff, in every state', () => {
  // Scoped to this describe only — the AI-suggestion describe below needs its own target to survive
  // across several tests, so cleanup must not be a blanket top-level afterEach.
  afterEach(async () => {
    await clearYearlyTarget();
    if (createdPartnershipIds.length) {
      await db.collection('partnerships').deleteMany({ id: { $in: createdPartnershipIds } });
      createdPartnershipIds.length = 0;
    }
  });

  test('no target set: shows "No target set for <year>" and a Set Target button', async () => {
    for (const [agent, path] of [[adminAgent, '/dashboard'], [staffAgent, '/staff/dashboard']]) {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      const text = normalizeWhitespace(res.text);
      expect(text).toContain(`No target set for ${CURRENT_YEAR}`);
      expect(text).toContain('Set Target');
      expect(text).not.toContain('Edit Target');
    }
  });

  test('a target that is behind pace (0 of 5 this year) shows the Behind pace badge and remaining/days-left text', async () => {
    const created = await adminAgent.post('/api/targets').send({ type: 'yearly', year: CURRENT_YEAR, targetCount: 5 });
    expect(created.status).toBe(200);
    createdTargetIds.push(created.body.target.id);

    for (const [agent, path] of [[adminAgent, '/dashboard'], [staffAgent, '/staff/dashboard']]) {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      const text = normalizeWhitespace(res.text);
      expect(text).toContain(`Yearly Target ${CURRENT_YEAR}`);
      expect(text).toContain('0 of 5 new partnerships');
      expect(text).toContain('Behind pace');
      expect(text).toContain('5 more needed');
      expect(text).toMatch(/\d+ days left/);
      expect(text).toContain('Edit Target');
    }
  });

  test('a target that is on track (19 of 20, i.e. 95% through the year\'s worth of progress) shows the On track badge', async () => {
    for (let i = 0; i < 19; i++) await seedPartnership(`Jan ${(i % 28) + 1}, ${CURRENT_YEAR}`);
    const created = await adminAgent.post('/api/targets').send({ type: 'yearly', year: CURRENT_YEAR, targetCount: 20 });
    expect(created.status).toBe(200);
    createdTargetIds.push(created.body.target.id);
    expect(created.body.target.progress.current).toBe(19);

    const res = await adminAgent.get('/dashboard');
    expect(res.status).toBe(200);
    const text = normalizeWhitespace(res.text);
    expect(text).toContain('19 of 20 new partnerships');
    expect(text).toContain('On track');
  });

  test('a target that has been reached shows "Achieved" regardless of how much of the year is left', async () => {
    await seedPartnership(`Jan 1, ${CURRENT_YEAR}`);
    const created = await adminAgent.post('/api/targets').send({ type: 'yearly', year: CURRENT_YEAR, targetCount: 1 });
    expect(created.status).toBe(200);
    createdTargetIds.push(created.body.target.id);
    expect(created.body.target.progress.current).toBe(1);

    const res = await adminAgent.get('/dashboard');
    expect(res.status).toBe(200);
    const text = normalizeWhitespace(res.text);
    expect(text).toContain('1 of 1 new partnerships');
    expect(text).toContain('Achieved');
    expect(text).toContain(`Target achieved for ${CURRENT_YEAR}`);
    expect(text).not.toContain('more needed');
  });

  test('the Set/Edit Target modal markup ships on the page (EJS render check)', async () => {
    const res = await adminAgent.get('/dashboard');
    expect(res.text).toContain('id="target-modal"');
    expect(res.text).toContain('id="target-modal-year"');
    expect(res.text).toContain('id="target-modal-count"');
    expect(res.text).toContain('id="target-modal-notes"');
  });
});

describe('Setting/editing a target (Staff now allowed, 2026-11) — logged, one per year', () => {
  // Scoped afterAll — must clear the current-year target it creates before the AI-suggestion describe
  // below tries to create its own, or that POST would hit the unique (type, year) index and 409.
  afterAll(clearYearlyTarget);

  test('Staff can set a target for the current year with notes, then edit it; a duplicate for the same year is rejected', async () => {
    const setRes = await staffAgent.post('/api/targets').send({ type: 'yearly', year: CURRENT_YEAR, targetCount: 12, notes: 'jesttest focus on CCS' });
    expect(setRes.status).toBe(200);
    expect(setRes.body.target.notes).toBe('jesttest focus on CCS');
    createdTargetIds.push(setRes.body.target.id);

    const dup = await adminAgent.post('/api/targets').send({ type: 'yearly', year: CURRENT_YEAR, targetCount: 99 });
    expect(dup.status).toBe(409);
    expect(await db.collection('targets').countDocuments({ type: 'yearly', year: CURRENT_YEAR })).toBe(1);

    const editRes = await staffAgent.patch(`/api/targets/${setRes.body.target.id}`).send({ targetCount: 15, notes: 'jesttest updated note' });
    expect(editRes.status).toBe(200);
    expect(editRes.body.target.targetCount).toBe(15);
    expect(editRes.body.target.notes).toBe('jesttest updated note');

    const log = await db.collection('activitylogs').find({ action: { $in: ['ADD', 'EDIT'] }, record: /Target (created|updated)/ }).sort({ id: -1 }).limit(2).toArray();
    expect(log.some(l => l.by === 'jesttest Staff')).toBe(true);
  });
});

describe('AI suggestion for the Yearly Target card (2026-11)', () => {
  let target;

  // This deployment's real .env has INSTITUTIONAL_AI_DATA_APPROVED=true (confirmed live), and
  // test/setup-env.js deliberately leaves AI-gate vars alone (only MONGO_URI is forced) — so every
  // AI-gated test file in this codebase manages this var itself (see ai-insights-routes.test.js's
  // identical pattern). Explicitly deleting it here, regardless of the ambient value, is what makes
  // the "AI off" test below actually exercise the blocked path instead of silently depending on
  // whatever the real .env happens to say.
  const ORIGINAL_AI_APPROVED = process.env.INSTITUTIONAL_AI_DATA_APPROVED;

  beforeAll(async () => {
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const created = await adminAgent.post('/api/targets').send({ type: 'yearly', year: CURRENT_YEAR, targetCount: 10 });
    target = created.body.target;
    createdTargetIds.push(target.id);
  });

  afterAll(() => { process.env.INSTITUTIONAL_AI_DATA_APPROVED = ORIGINAL_AI_APPROVED; });

  test('Auth. Personnel and potential_partner get 403 on the AI suggestion route', async () => {
    for (const agent of [personnelAgent, partnerAgent]) {
      const res = await agent.post(`/api/targets/${target.id}/ai-suggestion`).set('X-Requested-With', 'ciprms');
      expect(res.status).toBe(403);
    }
  });

  test('with the AI gate off, the route reports aiBlocked (never a real Gemini call — GEMINI_API_KEY is also unset in this environment) and the card still works', async () => {
    const res = await adminAgent.post(`/api/targets/${target.id}/ai-suggestion`).send({});
    expect(res.status).toBe(200);
    expect(res.body.aiBlocked).toBe(true);
    expect(res.body.suggestion).toBeFalsy();
    // The card's own markup never depends on the AI gate — the link always ships; only a click's
    // *result* differs. Confirms "the card must still work fully without AI."
    const dashRes = await adminAgent.get('/dashboard');
    expect(normalizeWhitespace(dashRes.text)).toContain('Get AI suggestion');
  });

  test('with the AI gate on and a mocked Gemini (no real HTTP call), a short suggestion is generated and cached', async () => {
    // Same test seam as aiInsightService.getAiInsights (see ai-insight-service.test.js): the HTTP
    // route itself has no mock-injection point by design (a real caller can never choose what Gemini
    // "says"), so the mocked-Gemini path is exercised at the service layer directly, exactly like
    // every other Gemini-backed route in this codebase already is.
    const ORIGINAL = process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = 'true';
    try {
      const figures = { year: CURRENT_YEAR, targetCount: 10, current: 2, lacking: 8, percentage: 20, statusLabel: 'Behind pace', daysLeft: 90, lowestActiveUnit: { unit: 'jesttest-CCS', active: 1, total: 3 } };
      const mock = jest.fn().mockResolvedValue({ suggestion: 'Focus outreach on CCS to close the 8-partnership gap before year end.' });
      const result = await aiInsightService.getTargetSuggestion(db, figures, { callGemini: mock });
      expect(mock).toHaveBeenCalledTimes(1);
      expect(result.suggestion).toMatch(/CCS/);
      expect(result.cacheStatus).toBe('miss');

      // Same figures again — served from cache, Gemini not called a second time.
      const cached = await aiInsightService.getTargetSuggestion(db, figures, { callGemini: mock });
      expect(mock).toHaveBeenCalledTimes(1);
      expect(cached.cacheStatus).toBe('hit');
      expect(cached.suggestion).toBe(result.suggestion);
    } finally {
      process.env.INSTITUTIONAL_AI_DATA_APPROVED = ORIGINAL;
      await db.collection('aiinsightscache').deleteMany({ scope: 'target_suggestion' });
    }
  });
});
