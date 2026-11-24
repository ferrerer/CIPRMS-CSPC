'use strict';
// Per-request context for the Audit Trail (2026-11-24).
//
// Only the login/logout/blocked call sites ever passed `ip`/`userAgent` to logActivity(); the ~50 other
// audit writes (add/edit/approve/delete/export/...) did not, so their IP Address column showed "—".
// Instead of threading `req` through every call site, a middleware stores the request's client IP,
// User-Agent and session id in an AsyncLocalStorage, and logActivity() falls back to it whenever a
// caller didn't supply those fields explicitly.
const { AsyncLocalStorage, AsyncResource } = require('async_hooks');
const multer = require('multer');

const als = new AsyncLocalStorage();

// multer finishes parsing on busboy stream events, which fire outside the request's async context — so a
// route's code after `upload.single(...)(req, res, cb)` would lose the store. Bind every multer `next`
// /callback to the context active when the middleware was invoked. Behavior is otherwise unchanged.
(function patchMulter() {
  const proto = Object.getPrototypeOf(multer());
  if (!proto || proto.__auditCtxPatched) return;
  ['single', 'array', 'fields', 'none', 'any'].forEach((name) => {
    const orig = proto[name];
    if (typeof orig !== 'function') return;
    proto[name] = function (...args) {
      const mw = orig.apply(this, args);
      return function (req, res, next) {
        return mw(req, res, typeof next === 'function' ? AsyncResource.bind(next) : next);
      };
    };
  });
  Object.defineProperty(proto, '__auditCtxPatched', { value: true });
})();

// getIp/getUserAgent are passed in (cirl.js owns getClientIp()/getClientUserAgent()).
function middleware(getIp, getUserAgent) {
  return function auditContextMiddleware(req, res, next) {
    const store = {
      ip: getIp(req),
      userAgent: getUserAgent(req),
      get requestId() { return req.sessionID || null; }
    };
    als.run(store, next);
  };
}

function current() {
  return als.getStore() || null;
}

module.exports = { middleware, current };
