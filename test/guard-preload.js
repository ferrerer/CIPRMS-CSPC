// Central Playwright guard (2026-11, production-exposure audit follow-up).
//
// Preloaded into EVERY process this project's Playwright config spawns, via NODE_OPTIONS=--require (see
// playwright.config.js) — every test worker (where a spec file's own top-of-file code, including any
// require('dotenv').config() call, runs) and the webServer child (`node cirl.js`) alike. Node runs a
// --require'd module before the process's own entry module, so this always executes first.
//
// This is what actually closes the gap that let six e2e specs reach the organization's real Atlas
// database for up to ~38 days (2026-11 production-exposure audit): each of those files' own per-file
// guard (see partner-activities-real.spec.js's own comment on the same pattern) only protects a spec
// whose author remembered to copy it. Setting MONGO_URI to the safe local value HERE, before any spec
// file's own module code runs, means a spec that forgets the per-file guard is still safe: dotenv never
// overrides an already-set environment variable, so a later require('dotenv').config() in that spec
// becomes a no-op for MONGO_URI regardless. Per-file guards stay in place anyway (see each file's own
// comment) — this is defense in depth, not a replacement; a spec run directly outside this config (e.g.
// `node test/e2e/foo.spec.js` for a one-off manual check, with no NODE_OPTIONS in effect) has only the
// per-file guard protecting it.
//
// Deliberately has no logic of its own beyond this one call: services/testDatabaseGuard.js is the single
// source of truth db.js, test/setup-env.js, and every per-file guard already ask the same question of.
// resolveTestDatabaseUri() throws (refusing to let this process start at all) if TEST_MONGO_URI (or, with
// it unset, the hardcoded local default) is not a loopback mongodb:// database whose name ends in "_test".
const { resolveTestDatabaseUri } = require('../services/testDatabaseGuard');

process.env.MONGO_URI = resolveTestDatabaseUri(process.env);
