// Natural-language analytics assistant — intent classification, allowlist validation, catalog
// construction, claim validation, and the full askQuestion orchestration. Every Gemini call is
// dependency-injected; no test here ever makes a real HTTP request. Synthetic fixtures only.
const { connectDB, closeDB } = require('../db');
const { cleanupAll } = require('./helpers');
const svc = require('../services/analyticsIntentService');

const SYNTH_RANKING = {
  scoreLabel: 'Development-attention priority indicator — not a performance score or a forecast',
  institutionWideZeroActive: false,
  rankGroups: [{ rank: 1, tied: false, scoreSpan: 0, confidenceReduced: false,
    units: [{ unit: 'jesttest-CCS', total: 10, active: 6, international: 3, expiringSoon: 2, scorePercent: 35 }] }],
};
const SYNTH_TARGET_GAPS = {
  scope: 'institution-wide', collegeBreakdown: null, note: 'Targets are not tracked per college.',
  targets: [{ id: 1, type: 'monthly', year: 2026, month: 11, targetCount: 10, current: 4, lacking: 6, percentage: 40, status: 'IN_PROGRESS' }],
};
const SYNTH_CUSTOM_REPORT_GROUPED = {
  comparisonData: [{ group: 'Asia', Region: 'Asia', Active: 5, 'Expiring Soon': 1, Inactive: 2, Total: 8 }],
};
const SYNTH_CUSTOM_REPORT_SUMMARY = {
  summary: { activeCount: 20, expiringSoonCount: 4, expiredCount: 3, inactiveCount: 7, totalCount: 27 },
};

function fakeExecuteIntent(intent) {
  return async () => {
    if (intent === 'opportunity_ranking') return SYNTH_RANKING;
    if (intent === 'target_progress') return SYNTH_TARGET_GAPS;
    if (intent === 'region_breakdown' || intent === 'category_breakdown') return SYNTH_CUSTOM_REPORT_GROUPED;
    if (intent === 'institutional_summary') return SYNTH_CUSTOM_REPORT_SUMMARY;
    throw new Error('unreachable');
  };
}

describe('buildIndicatorCatalog — one builder per intent, allowlist-constructed', () => {
  test.each(svc.INTENT_IDS)('intent "%s" produces only the four allowed fields, categories drawn from the fixed allowlist', async (intent) => {
    const dataResult = await fakeExecuteIntent(intent)();
    const catalog = svc.buildIndicatorCatalog(intent, dataResult);
    expect(catalog.length).toBeGreaterThan(0);
    for (const ind of catalog) {
      expect(Object.keys(ind).sort()).toEqual(svc.ALLOWED_INDICATOR_FIELDS.slice().sort());
      expect(svc.ALLOWED_CATEGORIES).toContain(ind.category);
    }
  });

  test('rejects an unknown intent outright (no default/fallback shape)', () => {
    expect(() => svc.buildIndicatorCatalog('not_a_real_intent', {})).toThrow(/Unknown intent/);
  });
});

describe('classifyIntent — strict allowlist, no silent fallback', () => {
  test.each(svc.INTENT_IDS)('a well-formed classification for "%s" is accepted', async (intent) => {
    const mock = async () => ({ intent });
    const result = await svc.classifyIntent('some question', { callGemini: mock });
    expect(result.intent).toBe(intent);
  });

  test('Gemini explicitly saying "unsupported" is honored, not coerced to a real intent', async () => {
    const mock = async () => ({ intent: 'unsupported' });
    const result = await svc.classifyIntent('what is the weather today', { callGemini: mock });
    expect(result.intent).toBeNull();
    expect(result.unsupported).toBe(true);
  });

  test('a hallucinated/unknown intent id is treated as unsupported, never guessed into a real one', async () => {
    const mock = async () => ({ intent: 'delete_all_partnerships' });
    const result = await svc.classifyIntent('anything', { callGemini: mock });
    expect(result.intent).toBeNull();
    expect(result.unsupported).toBe(true);
  });

  test('a malformed response (missing intent field entirely) is treated as unsupported', async () => {
    const mock = async () => ({ somethingElse: true });
    const result = await svc.classifyIntent('anything', { callGemini: mock });
    expect(result.intent).toBeNull();
  });

  test('a non-object/garbage response is treated as unsupported, not thrown', async () => {
    const mock = async () => 'not even an object';
    const result = await svc.classifyIntent('anything', { callGemini: mock });
    expect(result.intent).toBeNull();
  });
});

describe('validateClaims — same structural rules as Phase 1, independently applied here', () => {
  let catalog;
  beforeAll(async () => { catalog = svc.buildIndicatorCatalog('opportunity_ranking', SYNTH_RANKING); });
  const oppId = () => catalog.find(c => c.category === 'opportunity').id;

  test('accepts a valid claim and substitutes evidence from the catalog', () => {
    const claim = { claimType: 'current_state', evidenceIds: [oppId()], interpretation: 'This unit has an elevated score.', limitations: 'Snapshot only.' };
    const { accepted, rejected } = svc.validateClaims([claim], catalog);
    expect(rejected).toHaveLength(0);
    expect(accepted[0].evidence[0].id).toBe(oppId());
  });

  test('rejects an evidenceId not present in the catalog', () => {
    const claim = { claimType: 'current_state', evidenceIds: ['nope'], interpretation: 'x', limitations: 'x' };
    const { rejected } = svc.validateClaims([claim], catalog);
    expect(rejected[0].reasons.join(' ')).toMatch(/unknown indicator/);
  });

  test('rejects trend/growth language', () => {
    const claim = { claimType: 'current_state', evidenceIds: [oppId()], interpretation: 'Partnerships have grown year-over-year.', limitations: 'x' };
    const { rejected } = svc.validateClaims([claim], catalog);
    expect(rejected[0].reasons.join(' ')).toMatch(/trend\/growth\/forecast/);
  });
});

describe('askQuestion — full orchestration (real test DB for cache, mocked Gemini throughout)', () => {
  let db;
  const ORIGINAL = process.env.INSTITUTIONAL_AI_DATA_APPROVED;
  beforeAll(async () => { db = await connectDB(); await db.collection('aiinsightscache').deleteMany({}); });
  afterAll(async () => {
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = ORIGINAL;
    await db.collection('aiinsightscache').deleteMany({});
    await cleanupAll();
    await closeDB();
  });

  test('rejects an empty/non-string question with 400, before any Gemini call', async () => {
    const mock = jest.fn();
    await expect(svc.askQuestion(db, {}, '', { callGemini: mock, executeIntent: fakeExecuteIntent('institutional_summary') }))
      .rejects.toMatchObject({ status: 400 });
    expect(mock).not.toHaveBeenCalled();
  });

  test('rejects an over-length question with 400', async () => {
    await expect(svc.askQuestion(db, {}, 'x'.repeat(svc.MAX_QUESTION_LENGTH + 1), { executeIntent: fakeExecuteIntent('institutional_summary') }))
      .rejects.toMatchObject({ status: 400 });
  });

  test('approval unset -> blocked before classification is ever attempted (no Gemini call at all)', async () => {
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const mock = jest.fn();
    const result = await svc.askQuestion(db, {}, 'How are our targets doing?', { callGemini: mock, executeIntent: fakeExecuteIntent('target_progress') });
    expect(result.aiBlocked).toBe(true);
    expect(mock).not.toHaveBeenCalled();
  });

  // 2026-11 fix: Ask a Question shares the same two-fact-aware blocked message as the other two AI
  // features (reused directly from aiInsightService, not duplicated here).
  test('key configured + approval unset -> same "Pending institutional data-sharing approval" message as before', async () => {
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fake-key-for-this-test-only';
    try {
      const result = await svc.askQuestion(db, {}, 'How are our targets doing?', { callGemini: jest.fn(), executeIntent: fakeExecuteIntent('target_progress') });
      expect(result.geminiConfigured).toBe(true);
      expect(result.reason).toBe('Pending institutional data-sharing approval');
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('key NOT configured + approval unset -> message names both facts', async () => {
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const result = await svc.askQuestion(db, {}, 'How are our targets doing?', { callGemini: jest.fn(), executeIntent: fakeExecuteIntent('target_progress') });
      expect(result.geminiConfigured).toBe(false);
      expect(result.reason).toMatch(/not configured/i);
      expect(result.reason).toMatch(/institutional data-sharing approval/i);
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('approved + valid intent + valid claims -> full success, executeIntent called with the classified intent only', async () => {
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = 'true';
    const executeIntentSpy = jest.fn(fakeExecuteIntent('institutional_summary'));
    let callCount = 0;
    const mock = async (payload, schema) => {
      callCount += 1;
      if (callCount === 1) return { intent: 'institutional_summary' }; // classification call
      return { claims: [] }; // interpretation call
    };
    const result = await svc.askQuestion(db, {}, 'Summarize our partnership situation.', { callGemini: mock, executeIntent: executeIntentSpy });
    expect(result.intent).toBe('institutional_summary');
    expect(result.outcome).toBe('success');
    expect(executeIntentSpy).toHaveBeenCalledWith(db, 'institutional_summary', {});
  });

  test('unsupported question -> no deterministic data is ever fetched (executeIntent never called)', async () => {
    const executeIntentSpy = jest.fn(fakeExecuteIntent('institutional_summary'));
    const mock = async () => ({ intent: 'unsupported' });
    const result = await svc.askQuestion(db, {}, 'What is the weather today?', { callGemini: mock, executeIntent: executeIntentSpy });
    expect(result.unsupported).toBe(true);
    expect(result.intent).toBeNull();
    expect(executeIntentSpy).not.toHaveBeenCalled();
  });

  test('classification Gemini call failing (transient) still surfaces a clean error, never a thrown exception', async () => {
    const mock = async () => { throw Object.assign(new Error('timeout'), { status: 503 }); };
    const result = await svc.askQuestion(db, {}, 'How are our targets doing?', { callGemini: mock, executeIntent: fakeExecuteIntent('target_progress') });
    expect(result.error).toBeTruthy();
    expect(result.intent).toBeNull();
  });

  test('malformed interpretation response (claims not an array) yields zero accepted claims, not a crash', async () => {
    let callCount = 0;
    const mock = async () => {
      callCount += 1;
      if (callCount === 1) return { intent: 'target_progress' };
      return { claims: 'not an array' };
    };
    const result = await svc.askQuestion(db, {}, 'How are our targets doing, specifically?', { callGemini: mock, executeIntent: fakeExecuteIntent('target_progress') });
    expect(result.outcome).toBe('success');
    expect(result.answer.claims).toHaveLength(0);
  });

  test('identical question asked twice returns a cache hit the second time (no second interpretation call)', async () => {
    let interpretCalls = 0;
    const mock = async (payload) => {
      // Disambiguate by prompt shape: classification prompts never mention "Indicator catalog".
      if (typeof payload.prompt === 'string' && payload.prompt.indexOf('Indicator catalog') === -1) return { intent: 'institutional_summary' };
      interpretCalls += 1;
      return { claims: [] };
    };
    const q = 'Cache test question, asked twice, unique-' + Date.now();
    const first = await svc.askQuestion(db, {}, q, { callGemini: mock, executeIntent: fakeExecuteIntent('institutional_summary') });
    const second = await svc.askQuestion(db, {}, q, { callGemini: mock, executeIntent: fakeExecuteIntent('institutional_summary') });
    expect(first.outcome).toBe('success');
    expect(second.cacheStatus).toBe('hit');
    expect(interpretCalls).toBe(1);
  });

  test('deterministic data is always present on a successful answer, matching what executeIntent actually returned', async () => {
    const mock = async (payload) => (typeof payload.prompt === 'string' && payload.prompt.indexOf('Indicator catalog') === -1)
      ? { intent: 'target_progress' } : { claims: [] };
    const result = await svc.askQuestion(db, {}, 'target progress unique question ' + Date.now(), { callGemini: mock, executeIntent: fakeExecuteIntent('target_progress') });
    expect(result.deterministic).toEqual(SYNTH_TARGET_GAPS);
  });
});

describe('Architectural guarantee: Gemini never receives a database handle', () => {
  test('buildClassificationPrompt/buildAnswerPrompt-driven callGemini only ever receives a plain {systemInstruction, prompt} object and a JSON schema — never db/user/raw records', async () => {
    const seen = [];
    const mock = async (payload, schema) => { seen.push({ payload, schema }); return { intent: 'institutional_summary' }; };
    await svc.classifyIntent('any question', { callGemini: mock });
    expect(seen).toHaveLength(1);
    expect(Object.keys(seen[0].payload).sort()).toEqual(['prompt', 'systemInstruction']);
    expect(typeof seen[0].payload.prompt).toBe('string');
    expect(typeof seen[0].payload.systemInstruction).toBe('string');
  });
});
