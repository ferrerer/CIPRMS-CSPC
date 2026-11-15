// Institutional-approval gate — the real, production gate logic (no NODE_ENV bypass anywhere in
// aiInsightService.js), exercised with the approval env var toggled per test and a dependency-
// injected mocked Gemini caller so no real HTTP call is ever made. Proves: (1) the gate blocks when
// approval is absent, before the cache is ever touched, and (2) a cache hit never bypasses it.
const { connectDB, closeDB } = require('../db');
const { cleanupAll } = require('./helpers');
const aiInsightService = require('../services/aiInsightService');

describe('institutional approval gate — fails closed', () => {
  const ORIGINAL = process.env.INSTITUTIONAL_AI_DATA_APPROVED;
  let db;

  // aiinsightscache is a brand-new collection this feature exclusively owns — cleanupAll() (shared
  // across the whole test suite) doesn't know about it, so this file clears it itself, both so a
  // leftover entry from a previous run never produces a false "cache hit" here and so this file
  // doesn't leave anything behind for the next run either.
  beforeAll(async () => { db = await connectDB(); await db.collection('aiinsightscache').deleteMany({}); });
  afterAll(async () => { await db.collection('aiinsightscache').deleteMany({}); await cleanupAll(); await closeDB(); });
  afterEach(() => { process.env.INSTITUTIONAL_AI_DATA_APPROVED = ORIGINAL; });

  test('unset flag -> blocked, deterministic figures still returned, mocked callGemini never invoked', async () => {
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const mockCallGemini = jest.fn();

    const result = await aiInsightService.getAiInsights(db, { role: 'Staff' }, { generate: true, targetsWithProgress: [] }, { callGemini: mockCallGemini });

    expect(result.aiBlocked).toBe(true);
    expect(result.ai).toBeNull();
    expect(result.deterministic).toBeTruthy();
    expect(result.deterministic.ranking).toBeDefined();
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  test('a non-"true" string (e.g. "TRUE", "1") still fails closed', async () => {
    const mockCallGemini = jest.fn();
    for (const value of ['TRUE', '1', 'yes', 'True']) {
      process.env.INSTITUTIONAL_AI_DATA_APPROVED = value;
      const result = await aiInsightService.getAiInsights(db, { role: 'Staff' }, { generate: true, targetsWithProgress: [] }, { callGemini: mockCallGemini });
      expect(result.aiBlocked).toBe(true);
    }
    expect(mockCallGemini).not.toHaveBeenCalled();
  });

  test('GEMINI_API_KEY presence alone (with approval still unset) does not unlock generation', async () => {
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fake-key-for-this-test-only';
    const mockCallGemini = jest.fn();
    try {
      const result = await aiInsightService.getAiInsights(db, { role: 'Staff' }, { generate: true, targetsWithProgress: [] }, { callGemini: mockCallGemini });
      expect(result.aiBlocked).toBe(true);
      expect(mockCallGemini).not.toHaveBeenCalled();
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('exact string "true" proceeds past the gate to the (mocked) cache/generation pipeline', async () => {
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = 'true';
    const mockCallGemini = jest.fn().mockResolvedValue({ claims: [] });
    const result = await aiInsightService.getAiInsights(db, { role: 'Staff' }, { generate: true, targetsWithProgress: [] }, { callGemini: mockCallGemini });
    expect(result.aiBlocked).toBeUndefined();
    expect(mockCallGemini).toHaveBeenCalledTimes(1);
  });

  test('a previously-cached entry is never returned once approval is unset for a later request with the identical key', async () => {
    process.env.INSTITUTIONAL_AI_DATA_APPROVED = 'true';
    const mockCallGemini = jest.fn().mockResolvedValue({ claims: [] });
    const params = { generate: true, targetsWithProgress: [] };
    const first = await aiInsightService.getAiInsights(db, { role: 'Staff' }, params, { callGemini: mockCallGemini });
    // May be a fresh generation or a cache hit from an earlier test sharing the identical key —
    // either is fine here; what matters is that it succeeded and wrote/confirmed a cache entry.
    expect(first.aiBlocked).toBeUndefined();
    expect(first.ai).not.toBeNull();

    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const second = await aiInsightService.getAiInsights(db, { role: 'Staff' }, params, { callGemini: mockCallGemini });
    expect(second.aiBlocked).toBe(true);
    expect(second.ai).toBeNull();
  });

  // 2026-11 fix: missing configuration and withheld approval were previously indistinguishable —
  // both produced the identical "Pending institutional data-sharing approval" message even when no
  // GEMINI_API_KEY existed at all. Fixed to report both facts via blockedReason()/
  // isGeminiConfigured(), without changing what blocks generation (isRealDataApprovedForGemini()
  // alone still decides that — these two tests prove the message changed, not the gate).
  test('key configured + approval unset -> message UNCHANGED from before this fix ("Pending institutional data-sharing approval")', async () => {
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'fake-key-for-this-test-only';
    try {
      const result = await aiInsightService.getAiInsights(db, { role: 'Staff' }, { generate: true, targetsWithProgress: [] }, { callGemini: jest.fn() });
      expect(result.aiBlocked).toBe(true);
      expect(result.geminiConfigured).toBe(true);
      expect(result.reason).toBe('Pending institutional data-sharing approval');
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('key NOT configured + approval unset -> message names BOTH facts, geminiConfigured:false', async () => {
    delete process.env.INSTITUTIONAL_AI_DATA_APPROVED;
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;
    try {
      const result = await aiInsightService.getAiInsights(db, { role: 'Staff' }, { generate: true, targetsWithProgress: [] }, { callGemini: jest.fn() });
      expect(result.aiBlocked).toBe(true);
      expect(result.geminiConfigured).toBe(false);
      expect(result.reason).toMatch(/not configured/i);
      expect(result.reason).toMatch(/institutional data-sharing approval/i);
    } finally {
      process.env.GEMINI_API_KEY = originalKey;
    }
  });
});
