// One-off test send (2026-11, Email Delivery Check) — sends ONE real e-mail through the exact same
// production code path every other notification in this app uses (services/emailService.js's
// sendNotificationEmails/buildMessage: same "from" address, same subject format, same mobile-friendly
// HTML template, same "Open in CIPRMS" button and footer), so what you receive is exactly what a real
// user would see for a real notification.
//
// SAFE BY DESIGN — two independent things must BOTH be true for a real send to leave this machine:
//   1. This script's own --live flag (without it: prints the message it WOULD send and exits — no
//      network call of any kind, not even a dev-log write).
//   2. services/emailService.js's own, pre-existing, separate safety switch
//      (devSendDisabled() — unrelated to this script, never touched by it): outside a real production
//      run (NODE_ENV=production) it only logs to tmp/mail/ UNLESS MAIL_SEND_IN_DEV=true is also set.
// So running this locally with --live alone still only logs to tmp/mail/ — exactly like every other
// e-mail this app sends locally. To actually receive it, also set MAIL_SEND_IN_DEV=true for this one run
// (see the examples below). Never run with --live by anyone other than the person asking for this real
// test, and never to an address you don't recognize.
//
// Usage:
//   node scripts/send-test-email.js --to you@example.com                        (preview only — always safe)
//   node scripts/send-test-email.js --to you@example.com --live                 (still just logs to tmp/mail/ unless MAIL_SEND_IN_DEV=true too)
//   MAIL_SEND_IN_DEV=true node scripts/send-test-email.js --to you@example.com --live   (actually sends, via Resend, using RESEND_API_KEY/MAIL_USER from .env)
require('dotenv').config();
const emailService = require('../services/emailService');

function parseArgs(argv) {
  const toIdx = argv.indexOf('--to');
  return { to: toIdx !== -1 ? argv[toIdx + 1] : null, live: argv.includes('--live') };
}

async function main() {
  const { to, live } = parseArgs(process.argv.slice(2));
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) {
    console.error('Usage: node scripts/send-test-email.js --to <email> [--live]');
    console.error('Requires a valid --to address. Defaults to preview-only; pass --live to actually attempt a send');
    console.error('(still gated by emailService.js\'s own MAIL_SEND_IN_DEV/NODE_ENV switch — see this file\'s header comment).');
    process.exit(1);
  }

  const payload = {
    title: 'CIPRMS Test E-mail',
    desc: `This is a one-off test message sent by scripts/send-test-email.js on ${new Date().toLocaleString('en-US')}. `
      + 'If you received this, outgoing e-mail delivery (Resend, the "from" address, and the DNS/domain '
      + 'verification behind it) is working end to end. No action is needed.',
    tag: 'Test',
    link: '/dashboard'
  };

  if (!live) {
    console.log('PREVIEW ONLY (default) — nothing sent, nothing logged. Pass --live to actually attempt delivery.\n');
    const msg = emailService.buildMessage(to, payload);
    console.log(`From: ${msg.from.name} <${msg.from.address}>`);
    console.log(`To: ${msg.to}`);
    console.log(`Subject: ${msg.subject}`);
    console.log(`\n${msg.text}`);
    return;
  }

  console.log(`--live given — attempting delivery to ${to} (still subject to emailService.js's own dev-safe switch; see this file's header).`);
  const result = await emailService.sendNotificationEmails([to], payload);
  if (result.sent.includes(to)) {
    console.log('Reported as sent (or logged to tmp/mail/ if MAIL_SEND_IN_DEV was not also set — check there if you expected a real inbox delivery and did not get one).');
  } else {
    const failure = result.failed.find((f) => f.email === to);
    console.error('Not sent:', result.skipped || (failure && failure.error) || 'unknown reason');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('Test e-mail script failed:', err.message);
  process.exit(1);
});
