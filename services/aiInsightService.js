// Gemini AI narrative layer — Layer 2 of the Gemini AI Integration (CIPRMS, 2026-11, Phase 1).
// REST + fetch, not the @google/genai SDK (keeps this feature off the Node>=22 requirement the SDK
// carries — see the chat record's comparison). The actual HTTP call lives in exactly one function,
// defaultCallGemini(), so a change to Google's request/response shape touches one place.
//
// Gate order (approved 2026-11-10, corrected from an earlier draft that let a cache hit bypass the
// institutional-approval check): authenticate/authorize happens in the Express route before this
// module is ever reached; THIS module always computes the deterministic snapshot first, THEN checks
// institutional approval, and only past that gate does it ever touch the cache, build a prompt, or
// call Gemini. Approval is re-checked again after a Gemini call resolves, before the result is
// stored or returned, closing the window where approval could be revoked mid-flight.
const crypto = require('crypto');
const strategicAnalyticsService = require('./strategicAnalyticsService');

const GEMINI_MODEL_DEFAULT = 'gemini-3.5-flash-lite'; // MUST be re-verified against Google's live docs before any real call — see chat record
const PROMPT_VERSION = 'v1';
const SCHEMA_VERSION = 'v1';
const CACHE_TTL_MS = 60 * 60 * 1000;

const ALLOWED_INDICATOR_FIELDS = ['id', 'label', 'value', 'category'];
const ALLOWED_CATEGORIES = ['unit', 'target', 'opportunity'];
const MAX_LABEL_LENGTH = 100;
const MAX_INDICATORS = 200;
const MAX_PAYLOAD_BYTES = 32 * 1024;
// Shape only (prefix.suffix or a bare word) — length is policed separately via MAX_LABEL_LENGTH on
// the label, not folded into this pattern, so the two checks don't mask each other.
const INDICATOR_ID_PATTERN = /^[a-z_]+\.[\s\S]+$|^[a-z_]+$/i;

const CLAIM_TYPES = ['current_state', 'comparison', 'opportunity', 'target_gap', 'suggested_action'];
const CLAIM_CATEGORY_SUPPORT = {
  current_state: ['unit', 'target', 'opportunity'],
  comparison: ['unit', 'opportunity'],
  opportunity: ['opportunity'],
  target_gap: ['target'],
  suggested_action: ['opportunity', 'target'],
};
// Secondary, defense-in-depth check only — the CLAIM_TYPES enum itself (no "trend"/"growth"/
// "forecast" value exists in it) is the primary enforcement mechanism. This catches language
// smuggled into `interpretation` under a different, permitted claimType label.
const TREND_KEYWORDS = /\b(grown|growth|grew|increas\w+ over|declin\w+ over|historical trend|forecast|predict\w*|renewal rate|month-over-month|year-over-year|quarter-over-quarter)\b/i;

/** Fails closed: only the exact string 'true' enables real-data Gemini generation, read fresh every call — never cached, never inferred from GEMINI_API_KEY's presence. */
function isRealDataApprovedForGemini() {
  return process.env.INSTITUTIONAL_AI_DATA_APPROVED === 'true';
}

/**
 * Diagnostic only — whether a GEMINI_API_KEY is present. This NEVER gates, bypasses, or weakens
 * isRealDataApprovedForGemini() in any way; it exists solely so a blocked response's message can
 * tell "nothing is configured at all" apart from "it's configured but not yet institutionally
 * approved" — two different facts an administrator needs to act on differently. The approval flag
 * remains the one and only thing that controls whether Gemini is ever called.
 */
function isGeminiConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

/**
 * The blocked-state reason shown to the user. Deliberately unchanged ("Pending institutional
 * data-sharing approval") when a key IS configured — that sentence is already accurate for that
 * case and this fix must not alter it. Only the unconfigured-AND-unapproved case (previously
 * indistinguishable from the above) gets a fuller message naming both facts.
 */
function blockedReason() {
  return isGeminiConfigured()
    ? 'Pending institutional data-sharing approval'
    : 'Gemini is not configured for this deployment, and institutional data-sharing approval has not been granted.';
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
 * Builds the Gemini-bound indicator catalog by explicitly constructing each entry field-by-field
 * from the deterministic snapshot — never by spreading/cloning a source object and deleting
 * prohibited keys afterward. No institution names (`inst`/byInstitution) are included anywhere in
 * Phase 1, regardless of approval state. Rejects (never silently truncates) an oversized label,
 * an unrecognized category, or a catalog exceeding the indicator-count/payload-size caps.
 */
function buildIndicatorCatalog(snapshot) {
  const indicators = [];
  for (const group of snapshot.ranking.rankGroups) {
    for (const u of group.units) {
      const key = u.unit;
      indicators.push(makeIndicator(`unit_opportunity_score.${key}`, `Development-attention score — ${key}`, u.scorePercent, 'opportunity'));
      indicators.push(makeIndicator(`unit_active_total.${key}`, `Active partnerships — ${key}`, u.active, 'unit'));
      indicators.push(makeIndicator(`unit_total.${key}`, `Total partnerships — ${key}`, u.total, 'unit'));
      indicators.push(makeIndicator(`unit_international_total.${key}`, `International partnerships — ${key}`, u.international, 'unit'));
      indicators.push(makeIndicator(`unit_expiring_total.${key}`, `Expiring-soon partnerships — ${key}`, u.expiringSoon, 'unit'));
    }
  }
  for (const t of snapshot.targetGaps.targets) {
    const period = t.type === 'monthly' ? `${t.month}-${t.year}` : `${t.year}`;
    indicators.push(makeIndicator(`target_gap.${period}`, `Target gap — ${period}`, t.lacking, 'target'));
    indicators.push(makeIndicator(`target_percentage.${period}`, `Target accomplishment percent — ${period}`, t.percentage, 'target'));
  }
  if (indicators.length > MAX_INDICATORS) throw new Error(`Indicator catalog exceeds MAX_INDICATORS (${MAX_INDICATORS}): got ${indicators.length}`);
  const payloadBytes = Buffer.byteLength(JSON.stringify(indicators));
  if (payloadBytes > MAX_PAYLOAD_BYTES) throw new Error(`Indicator catalog exceeds MAX_PAYLOAD_BYTES (${MAX_PAYLOAD_BYTES}): got ${payloadBytes}`);
  return indicators;
}

const CLAIM_RESPONSE_SCHEMA = {
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

function buildPrompt(catalog) {
  return {
    systemInstruction: 'You are a strategic-analytics interpreter for a university research-partnerships office. '
      + 'You are given a fixed catalog of pre-verified numeric indicators. Interpret only these indicators. '
      + 'Never invent a number not in the catalog. Never claim monthly growth, renewal rates, historical trends, '
      + 'or forecasts — no such data is provided. Every claim must cite evidenceIds from the catalog and state '
      + 'its own limitations.',
    prompt: `Indicator catalog (JSON):\n${JSON.stringify(catalog)}\n\nRespond with a JSON object: { "claims": [...] } where every claim follows the required schema.`,
  };
}

/**
 * Validates Gemini's structured claims against the catalog. Proves structural conformance (right
 * shape, valid evidence references, a claim type the cited evidence's category actually supports)
 * — it does NOT and cannot prove the `interpretation` text is a logically sound inference from that
 * evidence, nor that a `suggestedAction`/`priority` is wise. That ceiling is why accepted claims are
 * still rendered as "AI Interpretation," never merged with the Verified Figures they cite.
 */
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

    // Server-side substitution: the evidence objects returned here are read fresh from the catalog —
    // whatever number (if any) Gemini's own prose contained is never what reaches the user.
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

/** Transient (network/5xx/timeout) vs. permanent (401/403/400/429) — only transient errors are ever retried. */
function classifyGeminiError(err) {
  const status = err && err.status;
  if (status === 429 || status === 401 || status === 403 || status === 400) return 'permanent';
  return 'transient';
}

function errorMessageFor(err) {
  const status = err && err.status;
  // Distinct from a real 401 auth failure below — this is "no key was ever supplied," which is a
  // deployment-configuration problem, not a revoked/invalid-credential problem, and needs its own
  // unambiguous message so an administrator knows which one to fix.
  if (err && err.code === 'NOT_CONFIGURED') return 'AI insights are not configured on this server — an administrator needs to add a Gemini API key.';
  if (status === 429) return 'The AI insights usage limit has been reached — try again later.';
  if (status === 401 || status === 403) return 'AI insights are not available right now — please contact an administrator.';
  if (status === 400) return 'AI insights are temporarily unavailable.';
  return 'AI insights are temporarily unavailable — please try again shortly.';
}

/**
 * The ONE place that ever makes an HTTP call to Gemini — isolated specifically so a change to
 * Google's endpoint/field shape (the Interactions API's structured-output fields were confirmed
 * against live docs during Phase 1 planning, but the raw response envelope's exact path was not
 * fully confirmed — see the chat record) only ever needs updating here, nowhere else.
 */
async function defaultCallGemini(promptPayload, schema) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) { const e = new Error('GEMINI_API_KEY is not configured'); e.status = 401; e.code = 'NOT_CONFIGURED'; throw e; }
  const model = process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  let res;
  try {
    res = await fetch('https://generativelanguage.googleapis.com/v1beta/interactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey, 'Api-Revision': '2026-05-20' },
      body: JSON.stringify({
        model,
        input: promptPayload.prompt,
        system_instruction: promptPayload.systemInstruction,
        response_format: { type: 'text', mime_type: 'application/json', schema },
      }),
    });
  } catch (networkErr) {
    networkErr.status = undefined; // no HTTP status at all → classifyGeminiError treats this as transient
    throw networkErr;
  }
  if (!res.ok) { const e = new Error(`Gemini API error ${res.status}`); e.status = res.status; throw e; }
  const data = await res.json();
  // Defensive multi-path extraction — re-verify against a live response before Phase 4.
  const text = data.output_text
    || (data.steps && data.steps.length && data.steps[data.steps.length - 1].content
      && data.steps[data.steps.length - 1].content[0] && data.steps[data.steps.length - 1].content[0].text);
  if (!text) { const e = new Error('Unrecognized Gemini response shape'); e.status = 502; throw e; }
  return JSON.parse(text);
}

async function callGeminiWithRetry(callGemini, promptPayload, schema) {
  try {
    return await callGemini(promptPayload, schema);
  } catch (err) {
    if (classifyGeminiError(err) !== 'transient') throw err;
    await new Promise(r => setTimeout(r, 250));
    return await callGemini(promptPayload, schema); // exactly one retry, transient errors only
  }
}

// Hashes only the computed aggregate values (ranking + targetGaps) — deliberately excludes
// `generatedAt`, which changes on every single call and would otherwise make every request a cache
// miss regardless of whether the underlying data actually changed. Hashing the computed VALUES
// (not a record timestamp) is also what makes a pure date-driven status flip — e.g. a partnership
// crossing the 90-day Expiring-Soon boundary with zero document write — correctly change the
// fingerprint: the next live recompute produces a different ranking/targetGaps value on its own.
function hashSnapshot(snapshot) {
  return crypto.createHash('sha256').update(JSON.stringify({ ranking: snapshot.ranking, targetGaps: snapshot.targetGaps })).digest('hex');
}

function buildCacheKey({ scope, dataFingerprint, modelId, promptVersion, schemaVersion }) {
  return crypto.createHash('sha256').update(JSON.stringify({ scope, dataFingerprint, modelId, promptVersion, schemaVersion })).digest('hex');
}

async function lookupCache(db, cacheKey) {
  const entry = await db.collection('aiinsightscache').findOne({ cacheKey });
  if (!entry) return null;
  if (entry.expiresAt && new Date(entry.expiresAt) < new Date()) return null;
  return entry;
}

async function storeCache(db, cacheKey, scope, ai) {
  const now = new Date();
  await db.collection('aiinsightscache').updateOne(
    { cacheKey },
    { $set: { cacheKey, scope, ai, createdAt: now, expiresAt: new Date(now.getTime() + CACHE_TTL_MS) } },
    { upsert: true }
  );
}

// In-process coalescing — sufficient for this app's current single-instance (render.yaml plan:
// free) deployment; would need a Mongo-backed lock instead if ever run on multiple instances.
const inFlight = new Map();

async function generateAndCache(db, snapshot, cacheKey, scope, deps) {
  if (inFlight.has(cacheKey)) return inFlight.get(cacheKey);

  const promise = (async () => {
    try {
      let catalog, promptPayload;
      try {
        catalog = buildIndicatorCatalog(snapshot);
        promptPayload = buildPrompt(catalog);
      } catch (buildErr) {
        return { deterministic: snapshot, ai: null, error: 'AI insights could not be prepared right now.', errorClass: 'permanent', cacheStatus: 'miss', outcome: 'error' };
      }

      let raw;
      try {
        const callGemini = deps.callGemini || defaultCallGemini;
        raw = await callGeminiWithRetry(callGemini, promptPayload, CLAIM_RESPONSE_SCHEMA);
      } catch (callErr) {
        return { deterministic: snapshot, ai: null, error: errorMessageFor(callErr), errorClass: classifyGeminiError(callErr), cacheStatus: 'miss', outcome: 'error' };
      }

      const { accepted, rejected } = validateClaims(raw && raw.claims, catalog);

      // Re-check approval AFTER the Gemini call resolves, before storing or returning anything —
      // closes the window where approval could be revoked while the call was in flight.
      if (!isRealDataApprovedForGemini()) {
        return { deterministic: snapshot, ai: null, aiBlocked: true, geminiConfigured: isGeminiConfigured(), reason: blockedReason(), cacheStatus: 'miss' };
      }

      const ai = { claims: accepted, rejectedCount: rejected.length, modelId: deps.modelId || process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT, generatedAt: new Date().toISOString() };
      await storeCache(db, cacheKey, scope, ai);
      return { deterministic: snapshot, ai, cacheStatus: 'miss', outcome: 'success' };
    } finally {
      inFlight.delete(cacheKey);
    }
  })();

  inFlight.set(cacheKey, promise);
  return promise;
}

/**
 * Main entry point. Gate order (approved, see module header): snapshot -> approval check ->
 * cache -> coalesced generation. `deps.callGemini` is the test seam (dependency injection) —
 * production call sites never need to pass it; tests always inject a mock so no real HTTP call
 * is ever made from a test, independent of the (always-live) approval-flag check.
 */
async function getAiInsights(db, user, params = {}, deps = {}) {
  if (typeof params.generate !== 'undefined' && typeof params.generate !== 'boolean') { const e = new Error('generate must be a boolean'); e.status = 400; throw e; }
  if (typeof params.forceRefresh !== 'undefined' && typeof params.forceRefresh !== 'boolean') { const e = new Error('forceRefresh must be a boolean'); e.status = 400; throw e; }
  if (params.forceRefresh === true && params.generate !== true) { const e = new Error('forceRefresh requires generate: true'); e.status = 400; throw e; }

  const scope = params.scope || 'insights';

  const snapshot = await strategicAnalyticsService.computeSnapshot(db, { targetsWithProgress: params.targetsWithProgress });

  if (!isRealDataApprovedForGemini()) {
    return { deterministic: snapshot, ai: null, aiBlocked: true, geminiConfigured: isGeminiConfigured(), reason: blockedReason(), cacheStatus: 'blocked' };
  }

  const dataFingerprint = hashSnapshot(snapshot);
  const modelId = deps.modelId || process.env.GEMINI_MODEL || GEMINI_MODEL_DEFAULT;
  const cacheKey = buildCacheKey({ scope, dataFingerprint, modelId, promptVersion: PROMPT_VERSION, schemaVersion: SCHEMA_VERSION });

  const cached = await lookupCache(db, cacheKey);
  if (cached && !params.forceRefresh) {
    return { deterministic: snapshot, ai: cached.ai, cacheStatus: 'hit' };
  }
  if (!params.generate) {
    return { deterministic: snapshot, ai: null, cacheStatus: 'miss', needsGeneration: true };
  }

  return generateAndCache(db, snapshot, cacheKey, scope, deps);
}

module.exports = {
  GEMINI_MODEL_DEFAULT, PROMPT_VERSION, SCHEMA_VERSION, CACHE_TTL_MS,
  ALLOWED_INDICATOR_FIELDS, ALLOWED_CATEGORIES, MAX_LABEL_LENGTH, MAX_INDICATORS, MAX_PAYLOAD_BYTES,
  CLAIM_TYPES, CLAIM_CATEGORY_SUPPORT, CLAIM_RESPONSE_SCHEMA,
  isRealDataApprovedForGemini,
  isGeminiConfigured,
  blockedReason,
  buildIndicatorCatalog,
  buildPrompt,
  validateClaims,
  classifyGeminiError,
  errorMessageFor,
  defaultCallGemini,
  callGeminiWithRetry,
  hashSnapshot,
  buildCacheKey,
  lookupCache,
  storeCache,
  getAiInsights,
  _inFlight: inFlight, // test-only visibility into the coalescing map, to assert cleanup after success/failure
};
