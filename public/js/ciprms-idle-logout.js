/**
 * CIPRMS automatic sign-out after inactivity.
 *
 * - "Activity" = the person actually using the page: mouse, keyboard, scroll, touch, wheel.
 *   Background traffic (live updates, notification checks) does NOT count.
 * - Shared across tabs via localStorage: working in any open CIPRMS tab keeps every tab signed in,
 *   and a sign-out in one tab signs the others out too.
 * - 1 minute before the limit a warning appears with "Stay signed in"; any activity also dismisses it.
 * - While the person is active, a light keep-alive ping (GET /api/session/ping) keeps the server
 *   session (also 10 minutes, see SESSION_IDLE_TIMEOUT_MS in cirl.js) from expiring mid-work.
 * - At the limit: POST /logout, then the login page with ?timeout=1 ("signed out due to inactivity").
 */
(function (window, document) {
  'use strict';
  if (!window.CIPRMS_USER || !window.localStorage) return;

  var IDLE_MS = 10 * 60 * 1000;          // sign out after 10 minutes without activity
  var WARN_MS = 60 * 1000;               // warn 1 minute before
  var PING_EVERY_MS = 4 * 60 * 1000;     // keep-alive at most every 4 minutes, only while active
  var CHECK_EVERY_MS = 5 * 1000;
  var KEY_ACTIVE = 'ciprms:lastActivity';
  var KEY_LOGOUT = 'ciprms:idleLogout';

  var lastLocal = Date.now();
  var lastPing = Date.now();
  var loggingOut = false;
  var warnEl = null, countdownEl = null;

  function readShared() {
    try { return parseInt(localStorage.getItem(KEY_ACTIVE), 10) || 0; } catch (e) { return 0; }
  }
  function lastActivity() { return Math.max(lastLocal, readShared()); }

  var lastWrite = 0;
  function markActive() {
    var now = Date.now();
    lastLocal = now;
    if (now - lastWrite > 1000) {           // throttle storage writes (mousemove fires constantly)
      lastWrite = now;
      try { localStorage.setItem(KEY_ACTIVE, String(now)); } catch (e) { /* private mode: this tab still works */ }
    }
    hideWarning();
    if (now - lastPing > PING_EVERY_MS) {
      lastPing = now;
      fetch('/api/session/ping', { headers: { 'X-Requested-With': 'ciprms' }, credentials: 'same-origin' }).catch(function () {});
    }
  }

  function goToLogin() { window.location.href = '/?timeout=1'; }

  function logout() {
    if (loggingOut) return;
    loggingOut = true;
    try { localStorage.setItem(KEY_LOGOUT, String(Date.now())); } catch (e) {}
    fetch('/logout', { method: 'POST', headers: { 'X-Requested-With': 'ciprms' }, credentials: 'same-origin' })
      .catch(function () {})
      .then(goToLogin);
  }

  function showWarning(secondsLeft) {
    if (!warnEl) {
      warnEl = document.createElement('div');
      warnEl.setAttribute('role', 'alertdialog');
      warnEl.setAttribute('aria-live', 'assertive');
      warnEl.style.cssText = 'position:fixed;right:20px;bottom:20px;z-index:2000;max-width:340px;background:#fff;' +
        'border:1px solid #f7b84b;border-left:4px solid #f7b84b;border-radius:6px;box-shadow:0 6px 24px rgba(0,0,0,.18);' +
        'padding:14px 16px;font-size:14px;color:#212529;';
      warnEl.innerHTML =
        '<div style="font-weight:600;margin-bottom:4px;"><i class="ri-time-line me-1" style="color:#f7b84b;"></i>Are you still there?</div>' +
        '<div style="margin-bottom:10px;">You will be signed out in <strong class="ciprms-idle-count"></strong> seconds due to inactivity.</div>' +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
        '<button type="button" class="btn btn-sm btn-light ciprms-idle-out">Sign out</button>' +
        '<button type="button" class="btn btn-sm btn-primary ciprms-idle-stay">Stay signed in</button></div>';
      document.body.appendChild(warnEl);
      countdownEl = warnEl.querySelector('.ciprms-idle-count');
      warnEl.querySelector('.ciprms-idle-stay').addEventListener('click', function () { lastPing = 0; markActive(); });
      warnEl.querySelector('.ciprms-idle-out').addEventListener('click', logout);
    }
    countdownEl.textContent = secondsLeft;
    warnEl.style.display = '';
  }
  function hideWarning() { if (warnEl) warnEl.style.display = 'none'; }

  function check() {
    if (loggingOut) return;
    var idle = Date.now() - lastActivity();
    if (idle >= IDLE_MS) return logout();
    if (idle >= IDLE_MS - WARN_MS) showWarning(Math.max(1, Math.ceil((IDLE_MS - idle) / 1000)));
    else hideWarning();
  }

  ['mousemove', 'mousedown', 'keydown', 'scroll', 'wheel', 'touchstart'].forEach(function (evt) {
    window.addEventListener(evt, markActive, { passive: true, capture: true });
  });
  // Another tab: activity there hides our warning; a sign-out there signs this tab out too.
  window.addEventListener('storage', function (e) {
    if (e.key === KEY_ACTIVE) hideWarning();
    if (e.key === KEY_LOGOUT && !loggingOut) { loggingOut = true; goToLogin(); }
  });
  // Coming back to a tab (or waking the computer) re-checks immediately, so an expired session is caught at once.
  document.addEventListener('visibilitychange', function () { if (!document.hidden) check(); });

  markActive();
  setInterval(check, CHECK_EVERY_MS);
})(window, document);
