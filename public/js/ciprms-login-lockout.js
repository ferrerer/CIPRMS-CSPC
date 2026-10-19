/* Live sign-in lockout countdown (2026-10). Included only on views/index.ejs. The displayed MM:SS is purely
   cosmetic — seeded from, and only ever a visual tick-down of, the server's own authoritative `lockedUntil`
   (rendered into #ciprms-lockout-countdown's data-locked-until by checkSignInLockout()/GET '/' in cirl.js).
   This script NEVER decides on its own that a retry is allowed: reaching 00:00 locally only triggers a real
   check against GET /api/login-lockout-status, and the "Sign in with Google" button is re-enabled ONLY once
   that server response confirms the lockout has actually expired — the exact same two-scope check
   checkSignInLockout() itself performs, so a client whose clock is wrong, or who is still locked under a
   fresh lockout that started after this page loaded, is never let through early. */
(function () {
  'use strict';
  var el = document.getElementById('ciprms-lockout-countdown');
  if (!el) return; // no active lockout on this page load — nothing to do

  var timeEl = document.getElementById('ciprms-lockout-countdown-time');
  var btn = document.getElementById('ciprms-google-signin-btn');
  var lockedUntil = new Date(el.getAttribute('data-locked-until')).getTime();

  var RECHECK_EVERY_MS = 5000; // a safety net against client/server clock drift, not the primary mechanism
  var tickTimer = null;
  var recheckTimer = null;
  var awaitingConfirm = false; // avoids firing a fresh server check on every single tick while already at 00:00

  function formatMMSS(totalSeconds) {
    var s = Math.max(0, Math.ceil(totalSeconds));
    var mm = Math.floor(s / 60);
    var ss = s % 60;
    return (mm < 10 ? '0' : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function render() {
    var remainingSeconds = (lockedUntil - Date.now()) / 1000;
    timeEl.textContent = formatMMSS(remainingSeconds);
    if (remainingSeconds <= 0 && !awaitingConfirm) confirmWithServer();
  }

  function stopCountingDown() {
    if (tickTimer) clearInterval(tickTimer);
    if (recheckTimer) clearInterval(recheckTimer);
    tickTimer = null;
    recheckTimer = null;
  }

  function unlock() {
    stopCountingDown();
    if (el && el.parentNode) el.parentNode.removeChild(el);
    if (btn) btn.disabled = false;
  }

  function applyServerStatus(status) {
    if (!status || !status.locked) { unlock(); return; }
    // Still locked — either clock drift (same lockout, slightly different remaining time) or a genuinely
    // fresh lockout that started after this page loaded. Either way, keep counting from the server's own
    // current value rather than ending the countdown on an unconfirmed assumption.
    var fresh = new Date(status.lockedUntil).getTime();
    if (!isNaN(fresh)) lockedUntil = fresh;
    if (btn) btn.disabled = true;
    render();
  }

  function confirmWithServer() {
    awaitingConfirm = true;
    fetch('/api/login-lockout-status', { headers: { 'X-Requested-With': 'ciprms', Accept: 'application/json' }, credentials: 'same-origin' })
      .then(function (res) {
        var ct = res.headers.get('content-type') || '';
        if (!res.ok || !/json/i.test(ct)) return null; // an inconclusive check is never itself proof of expiry
        return res.json().catch(function () { return null; });
      })
      .then(function (status) {
        awaitingConfirm = false;
        if (status === null) return; // network hiccup — stay as-is, the next scheduled recheck will try again
        applyServerStatus(status);
      })
      .catch(function () { awaitingConfirm = false; /* same as above — never assume unlocked just because the check itself failed */ });
  }

  render();
  tickTimer = setInterval(render, 1000);
  recheckTimer = setInterval(confirmWithServer, RECHECK_EVERY_MS);
})();
