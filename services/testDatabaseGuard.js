// Test-database isolation guard (2026-10 authentication hardening, Phase 0).
//
// Every write-enabled automated test (Jest, and the Playwright suite that boots `node cirl.js`) must run
// against a dedicated, local, explicitly-named test database — never production, never a shared database.
// This module is the single definition of what counts as "explicitly a test database", used in three places:
//   - test/setup-env.js       points Jest at the test database and refuses to start otherwise
//   - playwright.config.js    passes the same database to the server it starts
//   - db.js                   refuses to connect at all in test mode unless the URI passes this check,
//                             so a misconfigured test run fails closed instead of writing to real data
// It has no dependencies on purpose: test/setup-env.js loads it before db.js is ever required.

// Default for local runs: a throwaway MongoDB container bound to this machine's loopback interface only
// (see `npm run test:db:up` in package.json). Port 27018, not 27017, so it can never be confused with a
// developer's own local MongoDB.
const DEFAULT_TEST_MONGO_URI = 'mongodb://127.0.0.1:27018/ciprms_test';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const TEST_DB_NAME_RE = /^[A-Za-z0-9_-]+_test$/;

// Shared by isLocalMongoUri() and isSafeTestDatabaseUri() below — parses a mongodb:// URI's host list and
// database name, or returns null if it isn't even that well-formed. mongodb+srv:// is deliberately never
// matched here (that scheme is only ever a hosted cluster such as Atlas, never a local loopback instance),
// so both callers correctly treat it as "not local" without needing their own separate check for it.
function parseMongoUri(uri) {
  if (typeof uri !== 'string' || !uri) return null;
  const match = /^mongodb:\/\/(?:[^@/]*@)?([^/?]+)\/([^?]*)/.exec(uri.trim());
  if (!match) return null;
  const hosts = match[1].split(',').map((h) => {
    const host = h.trim().toLowerCase();
    if (host.startsWith('[')) return host.slice(0, host.indexOf(']') + 1);
    return host.replace(/:\d+$/, '');
  });
  let dbName;
  try { dbName = decodeURIComponent(match[2]); } catch (e) { return null; }
  return { hosts, dbName };
}

// True only for a plain mongodb:// URI whose every host is a loopback address (127.0.0.1/localhost/::1) —
// no requirement on the database name. This is the broader, standalone-usable check db.js's fail-closed
// guard (2026-11 production-exposure audit, proposal 2) runs against EVERY connection attempt, test or
// not: a non-local URI is only ever allowed when NODE_ENV=production is explicit. Never throws; never
// includes the URI (which may hold credentials) in anything it returns.
function isLocalMongoUri(uri) {
  const parsed = parseMongoUri(uri);
  return !!parsed && parsed.hosts.length > 0 && parsed.hosts.every((h) => LOOPBACK_HOSTS.has(h));
}

// True only for a plain mongodb:// URI whose every host is a loopback address and whose database name ends
// in "_test". mongodb+srv:// is always rejected (that scheme is only ever a hosted cluster such as Atlas).
// Never throws; never includes the URI (which may hold credentials) in anything it returns.
function isSafeTestDatabaseUri(uri) {
  const parsed = parseMongoUri(uri);
  if (!parsed || !parsed.hosts.length || !parsed.hosts.every((h) => LOOPBACK_HOSTS.has(h))) return false;
  return TEST_DB_NAME_RE.test(parsed.dbName);
}

// Resolves the test database URI for this run (TEST_MONGO_URI if set, else the local default) and throws
// if it is not a safe test database. The error message deliberately never echoes the URI.
function resolveTestDatabaseUri(env = process.env) {
  const uri = env.TEST_MONGO_URI || DEFAULT_TEST_MONGO_URI;
  if (!isSafeTestDatabaseUri(uri)) {
    throw new Error('Refusing to run tests: TEST_MONGO_URI must be a mongodb:// URI on localhost/127.0.0.1 whose database name ends in "_test".');
  }
  return uri;
}

module.exports = { DEFAULT_TEST_MONGO_URI, isLocalMongoUri, isSafeTestDatabaseUri, resolveTestDatabaseUri };
