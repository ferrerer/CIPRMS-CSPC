// Natural-language analytics assistant — Phase 3 of the Gemini AI Integration (CIPRMS, 2026-11).
//
// Architecture (mandatory, per the approved design): Gemini sees the user's question and may
// classify it into one of a FIXED enum (classifyIntent, below) — nothing else. The server validates
// that classification against the same fixed allowlist before doing anything with it. Only once
// validated does the server dispatch to an ALREADY-EXISTING deterministic function (the caller in
// cirl.js injects `executeIntent`, since computeCustomReportData/withTargetProgress live there) —
// this module never queries MongoDB itself and never asks Gemini to generate a query, code, or a
// field/collection name. Only after that real result exists does a SECOND Gemini call interpret it,
// through the same evidence-ID claim structure Phase 1 already established.
//
// Reuse, not duplication: the approval gate, the Gemini HTTP call, its retry/error classification,
// and the generic cache primitives are all imported directly from aiInsightService.js — nothing
// about THOSE is reimplemented here. What IS independently written here is the indicator-catalog
// builder and claim validator, because Phase 3's data shapes (region/category breakdowns, the
// institutional summary) are genuinely different from Phase 1's (unit ranking, target gaps) and
// Phase 1's builder is hardcoded to its own snapshot shape. The independent version follows the
// identical safety pattern (construct-not-filter, reject-not-truncate, size caps, category-support
// checking) rather than reusing Phase 1's code by reference — see the chat record for why this was
// judged cleaner than contorting Phase 1's constants to cover a second, unrelated vocabulary.
const crypto = require('crypto');
const aiInsightService = require('./aiInsightService');

const MAX_QUESTION_LENGTH = 300;

// The fixed, server-validated allowlist. Gemini's classification call can ONLY ever return one of
// these ids (or 'unsupported') — there is no "default" or "best guess" fallback anywhere below.
const INTENT_SPECS = {
  opportunity_ranking: 'Which institutional units have the largest partnership gaps, or the greatest opportunities for development attention.',
  region_breakdown: 'Which geographic regions have the most or fewest active partnerships.',
  category_breakdown: 'Which partnership categories (International vs. Local) have the most or fewest active partnerships.',
  target_progress: 'How monthly or yearly institutional targets are progressing — accomplishment, shortfall, percentage.',
  institutional_summary: 'A general summary of the current overall institutional partnership situation (totals, active, expiring, expired).',
};
const INTENT_IDS = Object.keys(INTENT_SPECS);

const ALLOWED_INDICATOR_FIELDS = ['id', 'label', 'value', 'category'];
const ALLOWED_CATEGORIES = ['unit', 'target', 'opportunity', 'region', 'category', 'summary'];
const MAX_LABEL_LENGTH = 100;
const MAX_INDICATORS = 200;
const MAX_PAYLOAD_BYTES = 32 * 1024;
const INDICATOR_ID_PATTERN = /^[a-z_]+\.[\s\S]+$|^[a-z_]+$/i;

const CLAIM_TYPES = ['current_state', 'comparison', 'opportunity', 'target_gap', 'suggested_action'];
const CLAIM_CATEGORY_SUPPORT = {
  current_state: ['unit', 'target', 'opportunity', 'region', 'category', 'summary'],
  comparison: ['unit', 'opportunity', 'region', 'category'],
  opportunity: ['opportunity'],
  target_gap: ['target'],
  suggested_action: ['opportunity', 'target'],
};
const TREND_KEYWORDS = /\b(grown|growth|grew|increas\w+ over|declin\w+ over|historical trend|forecast|predict\w*|renewal rate|month-over-month|year-over-year|quarter-over-quarter)\b/i;

function hashText(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

function makeIndicator(id, label, value, category) {
  const clean = { id, label, value, category };
  if (typeof clean.id !== 'string' || !INDICATOR_ID_PATTERN.test(clean.id)) throw new Error(`Rejected indicator id: ${String(id)}`);
  if (typeof clean.label !== 'string' || !clean.label.trim()) throw new Error(`Rejected indicator label for ${id}: must be a non-empty string`);
  if (clean.label.length > MAX_LABEL_LENGTH) throw new Error(`Rejected indicator label for ${id}: exceeds ${MAX_LABEL_LENGTH} characters (rejected, not truncated)`);
  if (typeof clean.value !== 'number' || !Number.isFinite(clean.value)) throw new Error(`Rejected indicator value for ${id}: must be a finite number`);
  if (!ALLOWED_CATEGORIES.includes(clean.category)) throw new Error(`Rejected indicator category for ${id}: ${category}`);
  return clean;
}

/**
 * Builds the indicator catalog for a given intent's ALREADY-COMPUTED result (never raw partnership
 * records, never institution names). Construct-not-filter, reject-not-truncate, size-capped — same
 * safety pattern as aiInsightService.buildIndicatorCatalog, independently applied here (see header).
 */
function buildIndicatorCatalog(intent, dataResult) {
  const indicators = [];

  if (intent === 'opportunity_ranking') {
    for (const group of (dataResult.rankGroups || [])) {
      for (const u of group.units) {
        indicators.push(makeIndicator(`unit_opportunity_score.${u.unit}`, `Development-attention score — ${u.unit}`, u.scorePercent, 'opportunity'));
        indicators.push(makeIndicator(`unit_active_total.${u.unit}`, `Active partnerships — ${u.unit}`, u.active, 'unit'));
        indicators.push(makeIndicator(`unit_total.${u.unit}`, `Total partnerships — ${u.unit}`, u.total, 'unit'));
      }
    }
  } else if (intent === 'target_progress') {
    for (const t of (dataResult.targets || [])) {
      const period = t.type === 'monthly' ? `${t.month}-${t.year}` : `${t.year}`;
      indicators.push(makeIndicator(`target_gap.${period}`, `Target gap — ${period}`, t.lacking, 'target'));
      indicators.push(makeIndicator(`target_percentage.${period}`, `Target accomplishment percent — ${period}`, t.percentage, 'target'));
    }
  } else if (intent === 'region_breakdown' || intent === 'category_breakdown') {
    const dimension = intent === 'region_breakdown' ? 'region' : 'category';
    for (const row of (dataResult.comparisonData || [])) {
      const key = String(row.group);
      indicators.push(makeIndicator(`${dimension}_active.${key}`, `Active partnerships — ${key}`, row.Active || 0, dimension));
      indicators.push(makeIndicator(`${dimension}_total.${key}`, `Total partnerships — ${key}`, row.Total || 0, dimension));
    }
  } else if (intent === 'institutional_summary') {
    const s = dataResult.summary || {};
    indicators.push(makeIndicator('institution_active_total', 'Active partnerships (institution-wide)', s.activeCount || 0, 'summary'));
    indicators.push(makeIndicator('institution_expiring_total', 'Expiring-soon partnerships (institution-wide)', s.expiringSoonCount || 0, 'summary'));
    indicators.push(makeIndicator('institution_expired_total', 'Expired partnerships (institution-wide)', s.expiredCount || 0, 'summary'));
    indicators.push(makeIndicator('institution_total', 'Total partnerships (institution-wide)', s.totalCount || 0, 'summary'));
  } else {
    throw new Error(`Unknown intent for catalog construction: ${intent}`);
  }

  if (indicators.length > MAX_INDICATORS) throw new Error(`Indicator catalog exceeds MAX_INDICATORS (${MAX_INDICATORS}): got ${indicators.length}`);
  const payloadBytes = Buffer.byteLength(JSON.stringify(indicators));
  if (payloadBytes > MAX_PAYLOAD_BYTES) throw new Error(`Indicator catalog exceeds MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES}): got ${payloadBytes}`);
  return indicators;
}

const INTENT_CLASSIFICATION_SCHEMA = {
  type: 'object',
  properties: { intent: { type: 'string', enum: [...INTENT_IDS, 'unsupported'] } },
  required: ['intent'],
};

const ANSWER_RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    claims: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claimType: { type: 'string', enum: CLAIM_TYPES },
          evidenceIds: { type: 'array', items: { type: 'string' } },
          interpretation: { type: 'string' },
          suggestedAction: { type: ['string', 'null'] },
          priority: { type: ['string', 'null'], enum: ['High', 'Medium', 'Low', null] },
          priorityReason: { type: ['string', 'null'] },
          limitations: { type: 'string' },
        },
        required: ['claimType', 'evidenceIds', 'interpretation', 'limitations'],
      },
    },
  },
  required: ['claims'],
};

function buildClassificationPrompt(question) {
  const list = INTENT_IDS.map(id => `- "${id}": ${INTENT_SPECS[id]}`).join('\n');
  return {
    systemInstruction: 'You classify a user\'s analytics question into exactly one predefined intent id. '
      + 'You have no access to any database, tool, or code execution — you only choose a label. '
      + 'Never invent a new intent id. If the question does not clearly match one of the listed intents, '
      + 'respond with "unsupported".',
    prompt: `Allowed intents:\n${list}\n- "unsupported": the question does not match any of the above.\n\n`
      + `Question: ${question}\n\nRespond with a JSON object: { "intent": "<one of the ids above>" }`,
  };
}

function buildAnswerPrompt(catalog, question) {
  return {
    systemInstruction: 'You are a strategic-analytics interpreter for a university research-partnerships office. '
      + 'You are given a fixed catalog of pre-verified numeric indicators that already answer the user\'s question '
      + 'category. Interpret only these indicators. Never invent a number not in the catalog. Never claim monthly '
      + 'growth, renewal rates, historical trends, or forecasts — no such data is provided. Every claim must cite '
      + 'evidenceIds from the catalog and state its own limitations.',
    prompt: `User's question: ${question}\n\nIndicator catalog (JSON):\n${JSON.stringify(catalog)}\n\n`
      + 'Respond with a JSON object: { "claims": [...] } where every claim follows the required schema.',
  };
}

/** Identical structural rules to aiInsightService.validateClaims — see header for why this is an independent copy, not a reused reference. */
function validateClaims(rawClaims, catalog) {
  const catalogById = new Map(catalog.map(i => [i.id, i]));
  const accepted = [];
  const rejected = [];

  for (const claim of (Array.isArray(rawClaims) ? rawClaims : [])) {
    const reasons = [];
    if (!claim || typeof claim !== 'object') { rejected.push({ claim, reasons: ['not an object'] }); continue; }
    if (!CLAIM_TYPES.includes(claim.claimType)) reasons.push(`unknown claimType: ${claim.claimType}`);
    const evidenceIds = Array.isArray(claim.evidenceIds) ? claim.evidenceIds : [];
    if (evidenceIds.length === 0) reasons.push('no evidenceIds');
    const resolvedEvidence = evidenceIds.filter(id => catalogById.has(id));
    if (resolvedEvidence.length !== evidenceIds.length) reasons.push('evidenceIds references an unknown indicator');
    if (typeof claim.interpretation !== 'string' || !claim.interpretation.trim()) reasons.push('missing interpretation');
    if (typeof claim.limitations !== 'string' || !claim.limitations.trim()) reasons.push('missing limitations');

    const requiresAction = claim.claimType === 'opportunity' || claim.claimType === 'suggested_action';
    if (requiresAction) {
      if (typeof claim.suggestedAction !== 'string' || !claim.suggestedAction.trim()) reasons.push('missing suggestedAction for this claimType');
      if (!['High', 'Medium', 'Low'].includes(claim.priority)) reasons.push('missing/invalid priority for this claimType');
      if (typeof claim.priorityReason !== 'string' || !claim.priorityReason.trim()) reasons.push('missing priorityReason for this claimType');
    }

    if (reasons.length === 0) {
      const supportedCategories = CLAIM_CATEGORY_SUPPORT[claim.claimType];
      const hasSupport = resolvedEvidence.some(id => supportedCategories.includes(catalogById.get(id).category));
      if (!hasSupport) reasons.push(`claimType "${claim.claimType}" is not supported by any cited indicator's category`);
    }

    if (reasons.length === 0 && TREND_KEYWORDS.test(claim.interpretation || '')) {
      reasons.push('interpretation contains disallowed trend/growth/forecast language unsupported by any indicator category');
    }

    if (reasons.length) { rejected.push({ claim, reasons }); continue; }

    accepted.push({
      claimType: claim.claimType,
      evidenceIds: resolvedEvidence,
      evidence: resolvedEvidence.map(id => catalogById.get(id)),
      interpretation: claim.interpretation,
      suggestedAction: claim.suggestedAction || null,
      priority: claim.priority || null,
      priorityReason: claim.priorityReason || null,
      limitations: claim.limitations,
    });
  }
  return { accepted, rejected };
}

/**
 * Classifies a question against the fixed allowlist. Returns { intent: <id> } on a valid match,
 * { intent: null, unsupported: true } when Gemini says 'unsupported' OR returns anything else not
 * in the allowlist (malformed, hallucinated id, wrong shape) — there is no silent fallback intent.
 */
async function classifyIntent(question, deps = {}) {
  const callGemini = deps.callGemini || aiInsightService.defaultCallGemini;
  const raw = await aiInsightService.callGeminiWithRetry(callGemini, buildClassificationPrompt(question), INTENT_CLASSIFICATION_SCHEMA);
  const candidate = raw && raw.intent;
  if (typeof candidate === 'string' && INTENT_IDS.includes(candidate)) return { intent: candidate };
  return { intent: null, unsupported: true };
}

// In-process coalescing for the ask-a-question flow — kept separate from aiInsightService's own
// inFlight map (different keys, different feature; see header for why this isn't shared).
const inFlight = new Map();

/**
 * Main entry point. `deps.executeIntent(db, intent, user)` is injected by the caller (cirl.js),
 * since the real deterministic functions it must call (computeCustomReportData, withTargetProgress,
 * strategicAnalyticsService) live there — this module never queries MongoDB itself.
 */
async function askQuestion(db, user, question, deps = {}) {
  if (typeof question !== 'string' || !question.trim()) { const e = new Error('question is required'); e.status = 400; throw e; }
  const trimmed = question.trim();
  if (trimmed.length > MAX_QUESTION_LENGTH) { const e = new Error(`question must be ${MAX_QUESTION_LENGTH} characters or fewer`); e.status = 400; throw e; }
  if (typeof deps.executeIntent !== 'function') { const e = new Error('executeIntent dependency is required'); e.status = 500; throw e; }

  if (!aiInsightService.isRealDataApprovedForGemini()) {
    return { answer: null, deterministic: null, intent: null, aiBlocked: true, geminiConfigured: aiInsightService.isGeminiConfigured(), reason: aiInsightService.blockedReason() };
  }

  const callGemini = deps.callGemini || aiInsightService.defaultCallGemini;

  let classification;
  try {
    classification = await classifyIntent(trimmed, { callGemini });
  } catch (err) {
    return { answer: null, deterministic: null, intent: null, error: aiInsightService.errorMessageFor(err), errorClass: aiInsightService.classifyGeminiError(err) };
  }
  if (!classification.intent) {
    return { answer: null, deterministic: null, intent: null, unsupported: true, reason: 'This question could not be matched to a supported analytics topic.' };
  }
  const intent = classification.intent;

  const dataResult = await deps.executeIntent(db, intent, user);
  const catalog = buildIndicatorCatalog(intent, dataResult);

  const modelId = deps.modelId || process.env.GEMINI_MODEL || aiInsightService.GEMINI_MODEL_DEFAULT;
  const dataFingerprint = hashText(JSON.stringify(catalog));
  const scope = `qa:${hashText(trimmed.toLowerCase())}`;
  const cacheKey = aiInsightService.buildCacheKey({ scope, dataFingerprint, modelId, promptVersion: aiInsightService.PROMPT_VERSION, schemaVersion: aiInsightService.SCHEMA_VERSION });

  const cached = await aiInsightService.lookupCache(db, cacheKey);
  if (cached) {
    return { answer: cached.ai, deterministic: dataResult, intent, cacheStatus: 'hit' };
  }

  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const promise = (async () => {
    try {
      let raw;
      try {
        raw = await aiInsightService.callGeminiWithRetry(callGemini, buildAnswerPrompt(catalog, trimmed), ANSWER_RESPONSE_SCHEMA);
      } catch (err) {
        return { answer: null, deterministic: dataResult, intent, error: aiInsightService.errorMessageFor(err), errorClass: aiInsightService.classifyGeminiError(err), cacheStatus: 'miss' };
      }

      const { accepted, rejected } = validateClaims(raw && raw.claims, catalog);

      // Re-check approval AFTER the Gemini call resolves, before storing or returning — same
      // mid-flight-revocation guard as aiInsightService's own gate.
      if (!aiInsightService.isRealDataApprovedForGemini()) {
        return { answer: null, deterministic: dataResult, intent, aiBlocked: true, geminiConfigured: aiInsightService.isGeminiConfigured(), reason: aiInsightService.blockedReason(), cacheStatus: 'miss' };
      }

      const ai = { claims: accepted, rejectedCount: rejected.length, modelId, generatedAt: new Date().toISOString() };
      await aiInsightService.storeCache(db, cacheKey, scope, ai);
      return { answer: ai, deterministic: dataResult, intent, cacheStatus: 'miss', outcome: 'success' };
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

module.exports = {
  MAX_QUESTION_LENGTH,
  INTENT_SPECS, INTENT_IDS,
  ALLOWED_INDICATOR_FIELDS, ALLOWED_CATEGORIES, MAX_LABEL_LENGTH, MAX_INDICATORS, MAX_PAYLOAD_BYTES,
  CLAIM_TYPES, CLAIM_CATEGORY_SUPPORT,
  buildIndicatorCatalog,
  classifyIntent,
  validateClaims,
  askQuestion,
  _inFlight: inFlight,
};
