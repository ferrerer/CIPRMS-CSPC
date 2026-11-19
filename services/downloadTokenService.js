// One-time download tokens (2026-11, College Dean one-time-download reliability follow-up).
//
// A plain static fileLink sitting in the page's DOM can be retried, prefetched, or opened in a second tab
// without the user ever clicking anything — none of that should be able to claim a Dean's one try at a
// reference document. This service makes the Download button request a short-lived, single-purpose token
// (POST .../download-token) BEFORE the browser is handed anything it could act on by itself; the file URL
// then requires that exact token. A prefetch/retry of the bare file URL with no token (or a stale one)
// is rejected outright — only an explicit button click can ever obtain one.
//
// In-memory only (same convention as services/ocrService.js's job map) — a 5-minute-lived token has no
// business surviving a restart, and every route that reads it runs in this same process.
const crypto = require('crypto');

const TOKEN_TTL_MS = 5 * 60 * 1000;
const tokens = new Map(); // token -> { email, documentId, requestId, expiresAt }

function issueToken({ email, documentId, requestId }) {
  const token = crypto.randomBytes(24).toString('hex');
  tokens.set(token, { email, documentId, requestId, expiresAt: Date.now() + TOKEN_TTL_MS });
  return token;
}

// Validates WITHOUT consuming — a retry or a prefetch of the file URL with the same still-valid token
// must be allowed to try again as long as no earlier attempt actually completed (see consumeToken below,
// only ever called after a confirmed full transfer). This is what lets a flaky connection retry without
// burning the Dean's one real try, while a token that was never issued, already consumed, or has expired
// is rejected every time.
function peekToken(token, { email, documentId }) {
  if (!token) return false;
  const entry = tokens.get(token);
  if (!entry) return false;
  if (entry.expiresAt < Date.now()) { tokens.delete(token); return false; }
  return entry.email === email && entry.documentId === documentId;
}

// Called only once a download has actually completed — deletes the token so it can never be reused, same
// as if it had simply expired.
function consumeToken(token) {
  tokens.delete(token);
}

// Periodic sweep of abandoned tokens (issued but never used, never retried to completion, never expired
// naturally because nothing ever asked about them again) — keeps this Map from growing unbounded on a
// long-running process. unref() so it never keeps the process (or a Jest worker) alive on its own.
const sweepTimer = setInterval(() => {
  const now = Date.now();
  for (const [token, entry] of tokens) {
    if (entry.expiresAt < now) tokens.delete(token);
  }
}, TOKEN_TTL_MS);
if (typeof sweepTimer.unref === 'function') sweepTimer.unref();

module.exports = { issueToken, peekToken, consumeToken };
