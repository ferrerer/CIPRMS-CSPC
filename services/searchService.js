// Global header search (Administrator / CIRL Staff only — see requireStaffAccess on GET /api/search in cirl.js).
//
// This is a data layer only: every function here returns RAW field values, never HTML. The Express route builds the
// final per-role `href` (reusing the existing prLinkForRole/drLinkForRole helpers already in cirl.js) and the client
// is responsible for escaping before it ever touches innerHTML — see public/js/ciprms-search.js.
//
// Query strategy, per collection:
//   - partnerships / requests / documentrequests: all fields worth searching are short metadata (an institution name,
//     a status, a type) — a case-insensitive regex OR across those fields is simple, correct, and (at this app's
//     scale) cheap, and it naturally supports arbitrary substrings ("Univ" -> "University"), which a MongoDB $text
//     index does not (it only matches whole, stemmed words).
//   - documents: the same regex covers the short fields (title, filename, type, institution, partner), but `ocrText`
//     can run to tens of thousands of characters per document, and regex-scanning that column on every keystroke does
//     not use any index. The `documents` collection additionally gets a MongoDB text index (created once, in db.js)
//     covering ocrText + the same metadata; `$text` uses that index and is what actually makes OCR-content search
//     efficient at scale. The two result sets are merged and de-duplicated below, so a short-field regex hit and a
//     full-text hit on the same document collapse into one row instead of two.
//
// Nothing here is cached, and nothing needs to be invalidated: every call reads MongoDB directly, so a document whose
// OCR just finished, or a partnership just saved, is included in the very next search with no restart and no extra
// wiring — the realtime layer elsewhere in the app has nothing to do with this feature.
const MAX_QUERY_LENGTH = 200;
const PER_COLLECTION_LIMIT = 8; // shown in the header dropdown
const PER_COLLECTION_LIMIT_FULL = 40; // shown on the full /search results page
const SNIPPET_RADIUS = 90; // characters of ocrText shown on each side of the match

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Cheap input hardening: a hard length cap and control-character strip. Every use below still escapes for regex, so
 * this is defense in depth, not the only thing standing between user input and a query. */
function sanitizeQuery(raw) {
  return String(raw == null ? '' : raw)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001F\u007F]/g, '')
    .trim()
    .slice(0, MAX_QUERY_LENGTH);
}

/** OR-filter across a set of string/array-of-string fields. Every field is matched independently (Mongo already
 * matches a regex against any element of an array field), so this works unchanged for both plain strings
 * (institution) and multi-value fields (partnerships.unit, partnerships.nature). */
function fieldsRegexFilter(fields, pattern) {
  return { $or: fields.map(f => ({ [f]: pattern })) };
}

/** Does `value` (a string, or an array of strings) contain `term`, case-insensitively? Used only to decide which
 * field to show as the "matched in" hint — never for authorization. */
function fieldContains(value, termLower) {
  if (value == null) return false;
  const parts = Array.isArray(value) ? value : [value];
  return parts.some(v => typeof v === 'string' && v.toLowerCase().includes(termLower));
}

/** A short window of `text` centered on the first case-insensitive occurrence of `term`, or null if it isn't there.
 * Word boundaries are not required — a mid-word partial match still produces a useful snippet. */
function buildSnippet(text, term) {
  if (!text || !term) return null;
  const idx = text.toLowerCase().indexOf(term.toLowerCase());
  if (idx === -1) return null;
  const start = Math.max(0, idx - SNIPPET_RADIUS);
  const end = Math.min(text.length, idx + term.length + SNIPPET_RADIUS);
  let snippet = text.slice(start, end).replace(/\s+/g, ' ').trim();
  if (start > 0) snippet = '…' + snippet;
  if (end < text.length) snippet = snippet + '…';
  return snippet;
}

async function searchPartnerships(db, q, pattern, limit) {
  const fields = ['inst', 'institution', 'country', 'region', 'type', 'nature', 'cat', 'category', 'status', 'unit', 'remarks', 'coordinator'];
  const idAsNumber = /^\d+$/.test(q) ? Number(q) : null;
  const filter = idAsNumber != null ? { $or: [...fields.map(f => ({ [f]: pattern })), { id: idAsNumber }] } : fieldsRegexFilter(fields, pattern);
  const docs = await db.collection('partnerships').find(filter).limit(limit).toArray();
  const qLower = q.toLowerCase();
  return docs.map(p => ({
    kind: 'partnership',
    id: p.id,
    title: p.inst || p.institution || `Partnership #${p.id}`,
    subtitle: [p.type, p.country, p.status].filter(Boolean).join(' · '),
    matchedField: ['inst', 'institution', 'country', 'region', 'status'].find(f => fieldContains(p[f], qLower)) || null,
    snippet: null
  }));
}

async function searchRequests(db, q, pattern, limit) {
  const fields = ['institution', 'country', 'type', 'nature', 'status', 'requestedBy', 'category', 'region'];
  const idAsNumber = /^\d+$/.test(q) ? Number(q) : null;
  const filter = idAsNumber != null ? { $or: [...fields.map(f => ({ [f]: pattern })), { id: idAsNumber }] } : fieldsRegexFilter(fields, pattern);
  const docs = await db.collection('requests').find({ ...filter, status: { $ne: 'Draft' } }).limit(limit).toArray();
  const qLower = q.toLowerCase();
  return docs.map(r => ({
    kind: 'request',
    id: r.id,
    title: r.institution || `Request #${r.id}`,
    subtitle: [r.isRenewal ? 'Renewal' : 'Partnership Request', r.type, r.status].filter(Boolean).join(' · '),
    matchedField: ['institution', 'country', 'requestedBy', 'status'].find(f => fieldContains(r[f], qLower)) || null,
    snippet: null,
    isRenewal: !!r.isRenewal
  }));
}

async function searchDocumentRequests(db, q, pattern, limit) {
  const fields = ['institution', 'documentType', 'status', 'requestedBy'];
  const idAsNumber = /^\d+$/.test(q) ? Number(q) : null;
  const filter = idAsNumber != null ? { $or: [...fields.map(f => ({ [f]: pattern })), { id: idAsNumber }] } : fieldsRegexFilter(fields, pattern);
  const docs = await db.collection('documentrequests').find(filter).limit(limit).toArray();
  const qLower = q.toLowerCase();
  return docs.map(r => ({
    kind: 'documentRequest',
    id: r.id,
    title: r.institution || `Document Request #${r.id}`,
    subtitle: [r.documentType, r.canonicalStatus || r.status].filter(Boolean).join(' · '),
    matchedField: ['institution', 'documentType', 'status', 'requestedBy'].find(f => fieldContains(r[f], qLower)) || null,
    snippet: null
  }));
}

async function searchDocuments(db, q, pattern, limit) {
  // LAU Internal Review Uploads (2026-11) — excluded from this search even though it is Admin/Staff-only
  // (GET /api/search is requireStaffAccess): this index is for the Document Library's own MOA/MOU/
  // Accreditation content, and an LAU review surfacing here mixed in with ordinary documents is exactly
  // the kind of "found through library search" exposure this feature's leak audit flagged — Admin/Staff
  // already see every LAU review in its proper place, the request's own draft modal.
  const notLauReview = { requestType: { $ne: 'partnership-lau-review' } };
  const shortFields = ['title', 'originalFilename', 'type', 'institution', 'partner', 'issuingBody', 'country', 'nature', 'unit'];
  const byMetadata = await db.collection('documents').find({ ...fieldsRegexFilter(shortFields, pattern), ...notLauReview }).limit(limit).toArray();

  // Full-text content search — uses the text index created once in db.js (see the 2026-09-22 comment there) to avoid
  // a full collection scan of every stored ocrText on every keystroke. Wrapped in its own try/catch: if the index
  // hasn't been created yet (a fresh/failed-index environment), content search is simply skipped rather than failing
  // the whole request — metadata search above still works.
  //
  // $text only NARROWS the candidate set — it matches if a document contains ANY of the query's words (after
  // stemming), which is far looser than what a search box should return ("distinctive phrase" searching for a
  // document containing "distinctive" OR "phrase" anywhere would otherwise resurface unrelated real documents that
  // happen to share one common word). Every $text candidate is therefore re-checked below with the same precise
  // substring match the short metadata fields use (buildSnippet), and dropped if that check doesn't actually confirm
  // the query text is present — the index accelerates finding candidates in a large collection, but never decides
  // inclusion on its own.
  let byContent = [];
  try {
    byContent = await db.collection('documents')
      .find({ $text: { $search: q }, ...notLauReview })
      .limit(limit * 4)
      .toArray();
  } catch (_) { /* no text index yet — metadata search still covers this collection */ }

  const byId = new Map();
  for (const d of [...byMetadata, ...byContent]) if (!byId.has(d.id)) byId.set(d.id, d);
  const qLower = q.toLowerCase();

  return [...byId.values()]
    .map(d => {
      const metaField = shortFields.find(f => fieldContains(d[f], qLower));
      const snippet = metaField ? null : buildSnippet(d.ocrText, q);
      return { d, metaField, snippet };
    })
    .filter(({ metaField, snippet }) => metaField || snippet) // drop a $text candidate that didn't actually contain the query text
    .slice(0, limit)
    .map(({ d, metaField, snippet }) => ({
      kind: 'document',
      id: d.id,
      title: d.title || d.originalFilename || `Document #${d.id}`,
      subtitle: [d.type, d.institution].filter(Boolean).join(' · '),
      matchedField: metaField || (snippet ? 'ocrText' : null),
      snippet,
      fileLink: d.fileLink || null,
      archived: !!d.archived
    }));
}

/**
 * @param {import('mongodb').Db} db
 * @param {string} rawQuery
 * @param {{full?: boolean}} [opts] full=true uses the larger, "/search results page" limit
 * @returns {Promise<{query: string, tooShort: boolean, partnerships: object[], requests: object[], documentRequests: object[], documents: object[]}>}
 */
async function globalSearch(db, rawQuery, opts = {}) {
  const q = sanitizeQuery(rawQuery);
  if (q.length < 2) return { query: q, tooShort: true, partnerships: [], requests: [], documentRequests: [], documents: [] };

  const pattern = { $regex: escapeRegex(q), $options: 'i' };
  const limit = opts.full ? PER_COLLECTION_LIMIT_FULL : PER_COLLECTION_LIMIT;

  const [partnerships, requests, documentRequests, documents] = await Promise.all([
    searchPartnerships(db, q, pattern, limit),
    searchRequests(db, q, pattern, limit),
    searchDocumentRequests(db, q, pattern, limit),
    searchDocuments(db, q, pattern, limit)
  ]);

  return { query: q, tooShort: false, partnerships, requests, documentRequests, documents };
}

module.exports = { globalSearch, escapeRegex, buildSnippet, sanitizeQuery, MAX_QUERY_LENGTH };
