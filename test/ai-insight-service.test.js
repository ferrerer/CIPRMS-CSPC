// aiInsightService — structured claim validation, payload allowlist construction, cache/
// coalescing/retry behavior. Every Gemini call is dependency-injected (deps.callGemini); no test
// here ever makes a real HTTP request. Synthetic fixtures only, matching the real schema's shape.
const { connectDB, closeDB } = require('../db');
const { cleanupAll } = require('./helpers');
const aiInsightService = require('../services/aiInsightService');
const { rankOpportunities, computeTargetGapSummary, RANKING_CONFIG } = require('../services/strategicAnalyticsService');

// A small, hand-built synthetic snapshot in the real computeSnapshot() shape — never derived from
// real partnership/target records.
function makeSyntheticSnapshot() {
  const ranking = rankOpportunities([
    { unit: 'jesttest-CCS', total: 10, active: 6, international: 3, expiringSoon: 2 },
    { unit: 'jesttest-CBA', total: 4, active: 1, international: 0, expiringSoon: 1 },
  ], RANKING_CONFIG);
  const targetGaps = computeTargetGapSummary([
    { id: 1, type: 'monthly', year: 2026, month: 11, targetCount: 10, active: true, progress: { current: 4, lacking: 6, percentage: 40, status: 'IN_PROGRESS' } },
  ]);
  return { generatedAt: new Date().toISOString(), ranking, targetGaps };
}

describe('buildIndicatorCatalog — allowlist construction, strict validation', () => {
  test('produces only the four allowed fields per indicator, with no institution names anywhere', () => {
    const catalog = aiInsightService.buildIndicatorCatalog(makeSyntheticSnapshot());
    expect(catalog.length).toBeGreaterThan(0);
    for (const ind of catalog) {
      expect(Object.keys(ind).sort()).toEqual(aiInsightService.ALLOWED_INDICATOR_FIELDS.slice().sort());
      expect(aiInsightService.ALLOWED_CATEGORIES).toContain(ind.category);
    }
    const serialized = JSON.stringify(catalog);
    expect(serialized).not.toMatch(/partnerEmail|coordinator|remarks|docLink|_id|byInstitution/i);
  });

  test('rejects (never truncates) an oversized label', () => {
    const snapshot = makeSyntheticSnapshot();
    snapshot.ranking.rankGroups[0].units[0].unit = 'x'.repeat(aiInsightService.MAX_LABEL_LENGTH + 10);
    expect(() => aiInsightService.buildIndicatorCatalog(snapshot)).toThrow(/exceeds.*characters/);
  });

  test('rejects a catalog exceeding MAX_INDICATORS', () => {
    const snapshot = makeSyntheticSnapshot();
    const template = snapshot.ranking.rankGroups[0].units[0];
    const manyUnits = [];
    for (let i = 0; i < 60; i += 1) manyUnits.push({ ...template, unit: `jesttest-unit-${i}` });
    snapshot.ranking.rankGroups = [{ rank: 1, tied: false, scoreSpan: 0, confidenceReduced: false, units: manyUnits }];
    expect(() => aiInsightService.buildIndicatorCatalog(snapshot)).toThrow(/MAX_INDICATORS/);
  });
});

describe('validateClaims — structured schema enforcement', () => {
  let catalog;
  beforeAll(() => { catalog = aiInsightService.buildIndicatorCatalog(makeSyntheticSnapshot()); });

  const opportunityId = () => catalog.find(c => c.category === 'opportunity').id;
  const targetId = () => catalog.find(c => c.category === 'target').id;

  test('accepts a fully valid opportunity claim and substitutes evidence from the catalog, not from the claim text', () => {
    const claim = {
      claimType: 'opportunity', evidenceIds: [opportunityId()],
      interpretation: 'This unit shows the highest development-attention score among tracked units.',
      suggestedAction: 'Prioritize outreach for this unit next quarter.',
      priority: 'High', priorityReason: 'Highest composite score in the current snapshot.',
      limitations: 'Based on the current snapshot only; no historical trend data is available.',
    };
    const { accepted, rejected } = aiInsightService.validateClaims([claim], catalog);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
    expect(accepted[0].evidence[0].id).toBe(opportunityId());
    expect(accepted[0].evidence[0].value).toBe(catalog.find(c => c.id === opportunityId()).value); // server-verified value, not claim-authored
  });

  test('rejects an unknown claimType', () => {
    const claim = { claimType: 'forecast', evidenceIds: [opportunityId()], interpretation: 'x', limitations: 'x' };
    const { rejected, accepted } = aiInsightService.validateClaims([claim], catalog);
    expect(accepted).toHaveLength(0);
    expect(rejected[0].reasons.join(' ')).toMatch(/unknown claimType/);
  });

  test('rejects a claim citing an evidenceId not present in the catalog', () => {
    const claim = { claimType: 'current_state', evidenceIds: ['not_a_real_id'], interpretation: 'x', limitations: 'x' };
    const { rejected } = aiInsightService.validateClaims([claim], catalog);
    expect(rejected[0].reasons.join(' ')).toMatch(/unknown indicator/);
  });

  test('rejects an opportunity claim missing required suggestedAction/priority/priorityReason', () => {
    const claim = { claimType: 'opportunity', evidenceIds: [opportunityId()], interpretation: 'x', limitations: 'x' };
    const { rejected } = aiInsightService.validateClaims([claim], catalog);
    expect(rejected[0].reasons.join(' ')).toMatch(/missing suggestedAction/);
  });

  test('rejects a target_gap claim that only cites opportunity-category evidence (category-support mismatch)', () => {
    const claim = { claimType: 'target_gap', evidenceIds: [opportunityId()], interpretation: 'x', limitations: 'x' };
    const { rejected } = aiInsightService.validateClaims([claim], catalog);
    expect(rejected[0].reasons.join(' ')).toMatch(/not supported by any cited indicator's category/);
  });

  test('a target_gap claim citing a real target-category indicator is accepted', () => {
    const claim = { claimType: 'target_gap', evidenceIds: [targetId()], interpretation: 'The current period is short of its target.', limitations: 'Institution-wide figure only.' };
    const { accepted, rejected } = aiInsightService.validateClaims([claim], catalog);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
  });

  test('rejects trend/growth/forecast language smuggled into interpretation under an otherwise-valid claimType', () => {
    const claim = {
      claimType: 'current_state', evidenceIds: [opportunityId()],
      interpretation: 'Partnerships have grown steadily year-over-year for this unit.',
      limitations: 'x',
    };
    const { rejected } = aiInsightService.validateClaims([claim], catalog);
    expect(rejected[0].reasons.join(' ')).toMatch(/trend\/growth\/forecast/);
  });

  test('a numerically-consistent but causally-unsupported claim still passes structural validation (honest, stated limit)', () => {
    // Schema validation cannot and does not claim to catch an unsupported causal leap — only
    // structural conformance. This test documents that limit rather than hiding it.
    const claim = {
      claimType: 'current_state', evidenceIds: [opportunityId()],
      interpretation: 'This score is high because of a recent policy change in the office.',
      limitations: 'Causation is not established by this indicator alone.',
    };
    const { accepted, rejected } = aiInsightService.validateClaims([claim], catalog);
    expect(rejected).toHaveLength(0);
    expect(accepted).toHaveLength(1);
  });
});

describe('classifyGeminiError / errorMessageFor', () => {
  test('429/401/403/400 are permanent; anything else (network, 5xx) is transient', () => {
    expect(aiInsightService.classifyGeminiError({ status: 429 })).toBe('permanent');
    expect(aiInsightService.classifyGeminiError({ status: 401 })).toBe('permanent');
    expect(aiInsightService.classifyGeminiError({ status: 403 })).toBe('permanent');
    expect(aiInsightService.classifyGeminiError({ status: 400 })).toBe('permanent');
    expect(aiInsightService.classifyGeminiError({ status: 503 })).toBe('transient');
    expect(aiInsightService.classifyGeminiError({})).toBe('transient');
  });
  test('429 never invents a specific quota number in its message', () => {
    expect(aiInsightService.errorMessageFor({ status: 429 })).not.toMatch(/\d+ (requests|calls|per)/);
  });

  // 2026-11 fix: a missing-key error (code: 'NOT_CONFIGURED') is now distinguishable from a real
  // 401 auth failure (bad/revoked key) — previously both produced the identical generic message,
  // which told an administrator nothing about which of the two to actually fix.
  test('a NOT_CONFIGURED error gets a distinct "not configured" message, not the generic 401 one', () => {
    const configuredMsg = aiInsightService.errorMessageFor({ status: 401, code: 'NOT_CONFIGURED' });
    const genericAuthMsg = aiInsightService.errorMessageFor({ status: 401 });
    expect(configuredMsg).toMatch(/not configured/i);
    expect(configuredMsg).not.toBe(genericAuthMsg);
  });

  test('a NOT_CONFIGURED error is still classified permanent (never retried)', () => {
    expect(aiInsightService.classifyGeminiError({ status: 401, code: 'NOT_CONFIGURED' })).toBe('permanent');
  });
});

describe('isGeminiConfigured / blockedReason', () => {
  const originalKey = process.env.GEMINI_API_KEY;
  afterEach(() => { process.env.GEMINI_API_KEY = originalKey; });

  test('isGeminiConfigured reflects GEMINI_API_KEY presence only, read fresh', () => {
    process.env.GEMINI_API_KEY = 'anything';
    expect(aiInsightService.isGeminiConfigured()).toBe(true);
    delete process.env.GEMINI_API_KEY;
    expect(aiInsightService.isGeminiConfigured()).toBe(false);
  });

  test('blockedReason stays the original sentence when configured, and names both facts when not', () => {
    process.env.GEMINI_API_KEY = 'anything';
    expect(aiInsightService.blockedReason()).toBe('Pending institutional data-sharing approval');
    delete process.env.GEMINI_API_KEY;
    expect(aiInsightService.blockedReason()).toMatch(/not configured/i);
    expect(aiInsightService.blockedReason()).toMatch(/institutional data-sharing approval/i);
  });
});

describe('defaultCallGemini tags a missing key with code: NOT_CONFIGURED', () => {
  test('calling the real (unmocked) implementation with no key throws status:401, code:NOT_CONFIGURED', async () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      await expect(aiInsightService.defaultCallGemini({ prompt: 'x', systemInstruction: 'y' }, {}))
        .rejects.toMatchObject({ status: 401, code: 'NOT_CONFIGURED' });
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });
});

describe('getAiInsights — cache, coalescing, retry (real test DB, mocked Gemini)', () => {
  let db;
  const ORIGINAL = process.env.INSTITUTIONAL_AI_DATA_APPROVED;

  beforeAll(async () => {
    db = await connectDB();
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = 'true';
    await db.collection('aiinsightscache').deleteMany({});
  });
  afterAll(async () => {
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = ORIGINAL;
    await db.collection('aiinsightscache').deleteMany({});
    await cleanupAll();
    await closeDB();
  });

  const freshParams = (overrides = {}) => ({ generate: true, targetsWithProgress: [], scope: `test-${Date.now()}-${Math.random()}`, ...overrides });

  test('generate:true with no cache calls Gemini exactly once and caches the result', async () => {
    const mock = jest.fn().mockResolvedValue({ claims: [] });
    const params = freshParams();
    const result = await aiInsightService.getAiInsights(db, {}, params, { callGemini: mock });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.outcome).toBe('success');
  });

  test('generate:true with a valid cache present returns the cached result WITHOUT calling Gemini again (generate only on cache miss)', async () => {
    const mock = jest.fn().mockResolvedValue({ claims: [] });
    const params = freshParams();
    await aiInsightService.getAiInsights(db, {}, params, { callGemini: mock });
    const second = await aiInsightService.getAiInsights(db, {}, params, { callGemini: mock });
    expect(mock).toHaveBeenCalledTimes(1); // not called again
    expect(second.cacheStatus).toBe('hit');
  });

  test('forceRefresh:true bypasses a settled cache entry and calls Gemini again', async () => {
    const mock = jest.fn().mockResolvedValue({ claims: [] });
    const params = freshParams();
    await aiInsightService.getAiInsights(db, {}, params, { callGemini: mock });
    const refreshed = await aiInsightService.getAiInsights(db, {}, { ...params, forceRefresh: true }, { callGemini: mock });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(refreshed.outcome).toBe('success');
  });

  test('forceRefresh:true without generate:true is rejected (invalid combination)', async () => {
    await expect(aiInsightService.getAiInsights(db, {}, { forceRefresh: true, targetsWithProgress: [] }, {}))
      .rejects.toMatchObject({ status: 400 });
  });

  test('a non-boolean generate/forceRefresh value is rejected', async () => {
    await expect(aiInsightService.getAiInsights(db, {}, { generate: 'true', targetsWithProgress: [] }, {}))
      .rejects.toMatchObject({ status: 400 });
  });

  test('two simultaneous identical requests coalesce into exactly one Gemini call', async () => {
    let resolveCall;
    const mock = jest.fn().mockImplementation(() => new Promise(r => { resolveCall = r; }));
    const params = freshParams();
    const p1 = aiInsightService.getAiInsights(db, {}, params, { callGemini: mock });
    const p2 = aiInsightService.getAiInsights(db, {}, params, { callGemini: mock });
    // Poll rather than a fixed sleep — real Mongo round-trips (snapshot + cache lookup) have
    // variable latency; wait until the mock has actually been invoked before resolving it.
    for (let i = 0; i < 100 && mock.mock.calls.length === 0; i += 1) await new Promise(r => setTimeout(r, 10));
    resolveCall({ claims: [] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(mock).toHaveBeenCalledTimes(1); // the one property both coalescing AND cache-hit-after-the-fact would satisfy — no duplicate paid call either way
    expect(r1.aiBlocked).toBeUndefined();
    expect(r2.aiBlocked).toBeUndefined();
    expect(r1.ai).not.toBeNull();
    expect(r2.ai).not.toBeNull();
  });

  test('transient failure then a successful retry: exactly 2 calls, final outcome success', async () => {
    const mock = jest.fn()
      .mockRejectedValueOnce(Object.assign(new Error('timeout'), { status: 503 }))
      .mockResolvedValueOnce({ claims: [] });
    const result = await aiInsightService.getAiInsights(db, {}, freshParams(), { callGemini: mock });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('success');
  });

  test('transient failure on both attempts: exactly 2 calls, deterministic figures still returned, error surfaced', async () => {
    const mock = jest.fn().mockRejectedValue(Object.assign(new Error('timeout'), { status: 503 }));
    const result = await aiInsightService.getAiInsights(db, {}, freshParams(), { callGemini: mock });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(result.outcome).toBe('error');
    expect(result.deterministic).toBeTruthy();
  });

  test('permanent error (401) is never retried: exactly 1 call', async () => {
    const mock = jest.fn().mockRejectedValue(Object.assign(new Error('bad key'), { status: 401 }));
    const result = await aiInsightService.getAiInsights(db, {}, freshParams(), { callGemini: mock });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.error).toMatch(/administrator/);
  });

  test('permanent error (429) is never retried and never invents a quota number', async () => {
    const mock = jest.fn().mockRejectedValue(Object.assign(new Error('quota'), { status: 429 }));
    const result = await aiInsightService.getAiInsights(db, {}, freshParams(), { callGemini: mock });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(result.error).toMatch(/usage limit/);
  });

  test('regenerate (forceRefresh) racing an in-flight generation for the same key joins it rather than duplicating', async () => {
    let resolveCall;
    const mock = jest.fn().mockImplementation(() => new Promise(r => { resolveCall = r; }));
    const params = freshParams();
    const p1 = aiInsightService.getAiInsights(db, {}, params, { callGemini: mock }); // starts the in-flight generation
    for (let i = 0; i < 100 && mock.mock.calls.length === 0; i += 1) await new Promise(r => setTimeout(r, 10)); // wait until p1 actually reaches the mock
    const p2 = aiInsightService.getAiInsights(db, {}, { ...params, forceRefresh: true }, { callGemini: mock }); // races it
    await new Promise(r => setTimeout(r, 50)); // give p2 time to reach the coalescing check before resolving
    resolveCall({ claims: [] });
    const [r1, r2] = await Promise.all([p1, p2]);
    expect(mock).toHaveBeenCalledTimes(1);
    expect(r1.ai).not.toBeNull();
    expect(r2.ai).not.toBeNull();
  }, 20000);

  test('in-flight entries are cleaned up after both a successful and a failed generation', async () => {
    const okMock = jest.fn().mockResolvedValue({ claims: [] });
    const okParams = freshParams();
    await aiInsightService.getAiInsights(db, {}, okParams, { callGemini: okMock });

    const failMock = jest.fn().mockRejectedValue(Object.assign(new Error('bad key'), { status: 401 }));
    const failParams = freshParams();
    await aiInsightService.getAiInsights(db, {}, failParams, { callGemini: failMock });

    // If cleanup didn't happen, a second call for either key would hang on (or wrongly reuse) a
    // stale in-flight promise instead of running fresh. Calling again proves the map entry is gone.
    const okMock2 = jest.fn().mockResolvedValue({ claims: [] });
    await aiInsightService.getAiInsights(db, {}, { ...okParams, forceRefresh: true }, { callGemini: okMock2 });
    expect(okMock2).toHaveBeenCalledTimes(1);

    const failMock2 = jest.fn().mockRejectedValue(Object.assign(new Error('bad key'), { status: 401 }));
    await aiInsightService.getAiInsights(db, {}, { ...failParams, forceRefresh: true }, { callGemini: failMock2 });
    expect(failMock2).toHaveBeenCalledTimes(1);
  });

  // 2026-11 Phase 4 audit (cache/reliability checklist item: "approval revoked during generation").
  // The post-resolution re-check at getAiInsights' generateAndCache step was implemented in Phase 1
  // but had no test exercising the actual mid-flight race until this audit — added now as
  // verification, not a behavior change (the code under test is unmodified).
  test('approval revoked WHILE a Gemini call is in flight: the result is blocked, not cached, once it resolves', async () => {
    let resolveCall;
    const mock = jest.fn().mockImplementation(() => new Promise(r => { resolveCall = r; }));
    const params = freshParams();

    const pending = aiInsightService.getAiInsights(db, {}, params, { callGemini: mock });
    for (let i = 0; i < 100 && mock.mock.calls.length === 0; i += 1) await new Promise(r => setTimeout(r, 10));

    process.env.INSTITUTIONAL_AI_DATA_APPROVED = 'false'; // revoked mid-flight, before the mocked call resolves
    resolveCall({ claims: [] }); // Gemini "answers" after revocation already happened
    const result = await pending;
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = 'true'; // restore for the assertion below and later tests

    expect(result.aiBlocked).toBe(true);
    expect(result.ai).toBeNull();

    // The revoked-window result must never have been cached — a fresh call for the identical key,
    // now that approval is restored, must still call Gemini again rather than serving a poisoned hit.
    const mock2 = jest.fn().mockResolvedValue({ claims: [] });
    const result2 = await aiInsightService.getAiInsights(db, {}, params, { callGemini: mock2 });
    expect(mock2).toHaveBeenCalledTimes(1);
    expect(result2.outcome).toBe('success');
  });
});
