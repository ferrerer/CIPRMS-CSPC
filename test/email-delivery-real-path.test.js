// Email notification failure investigation (2026-11) — closes a real gap: every existing email test
// (test/email-notifications.test.js, test/centralized-notification-system.test.js) runs under Jest, where
// sendNotificationEmails() ALWAYS takes its `process.env.JEST_WORKER_ID` branch (sentForTests.push(msg)) —
// so none of them ever exercise the REAL Resend-call code path at all: a successful provider response, a
// provider rejection, missing credentials, or a network/timeout failure. This file exercises that real path
// directly, with the 'resend' package mocked (no network call ever made), by temporarily clearing
// JEST_WORKER_ID and forcing NODE_ENV='production' for the duration of each test only (restored in
// `finally`, every time — this must never leak into any other test in this or another file).
// .env is only ever loaded as a side effect of requiring cirl.js (dotenv.config() runs at its top, nowhere
// else in the codebase) — this file never requires cirl.js, so RESEND_API_KEY/MAIL_USER must be loaded
// explicitly or isConfigured() reads them as unset regardless of the real .env.
require('dotenv').config();
jest.mock('resend', () => {
  const send = jest.fn();
  const list = jest.fn();
  return { Resend: jest.fn().mockImplementation(() => ({ emails: { send }, domains: { list } })), __send: send, __list: list };
});
const { __send: sendMock } = require('resend');
const emailService = require('../services/emailService');
const notificationService = require('../services/notificationService');
const { connectDB, closeDB } = require('../db');

// Runs `fn` with the real (non-Jest, non-dev-skip) send path active, restoring the environment afterward
// no matter what `fn` does — this is the one piece of scaffolding every test below depends on being exact.
async function withRealSendPath(fn) {
  const savedWorkerId = process.env.JEST_WORKER_ID;
  const savedNodeEnv = process.env.NODE_ENV;
  delete process.env.JEST_WORKER_ID;
  process.env.NODE_ENV = 'production';
  try {
    await fn();
  } finally {
    if (savedWorkerId !== undefined) process.env.JEST_WORKER_ID = savedWorkerId;
    process.env.NODE_ENV = savedNodeEnv;
  }
}

describe('emailService.sendNotificationEmails() — the real (mocked-provider) send path', () => {
  beforeEach(() => { sendMock.mockReset(); });

  test('a successful provider response is reported as sent, not failed', async () => {
    sendMock.mockResolvedValue({ data: { id: 'mock-id' }, error: null });
    let result;
    await withRealSendPath(async () => {
      result = await emailService.sendNotificationEmails(['someone@example.com'], { title: 'T', desc: 'D' });
    });
    expect(result.sent).toEqual(['someone@example.com']);
    expect(result.failed).toEqual([]);
    expect(sendMock).toHaveBeenCalledTimes(1);
  });

  test('a provider rejection is reported as failed, retried exactly once, and logged — never silently reported as sent', async () => {
    const providerError = { message: 'The gmail.com domain is not verified. Please add and verify your domain.' };
    sendMock.mockResolvedValue({ data: null, error: providerError });
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    let result;
    try {
      await withRealSendPath(async () => {
        result = await emailService.sendNotificationEmails(['someone@example.com'], { title: 'T', desc: 'D' });
      });
      expect(result.sent).toEqual([]); // never appears successful
      expect(result.failed).toEqual([{ email: 'someone@example.com', error: providerError.message }]);
      expect(sendMock).toHaveBeenCalledTimes(2); // the one retry
      expect(warnSpy).toHaveBeenCalledTimes(1); // first-attempt warning
      expect(errorSpy).toHaveBeenCalledTimes(1); // final failure, logged once after the retry
      expect(errorSpy.mock.calls[0][0]).toMatch(/failed \(after retry\)/);
    } finally {
      warnSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });

  test('a network/timeout error (the send call itself throwing) is handled the same way as a provider rejection', async () => {
    const timeoutErr = new Error('This operation was aborted due to timeout');
    sendMock.mockRejectedValue(timeoutErr);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let result;
    try {
      await withRealSendPath(async () => {
        result = await emailService.sendNotificationEmails(['someone@example.com'], { title: 'T', desc: 'D' });
      });
      expect(result.sent).toEqual([]);
      expect(result.failed[0].email).toBe('someone@example.com');
      expect(result.failed[0].error).toMatch(/timeout/i);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });

  test('missing provider credentials (RESEND_API_KEY/MAIL_USER absent) skips delivery with skipped:"not_configured", attempts no send', async () => {
    const savedKey = process.env.RESEND_API_KEY;
    const savedUser = process.env.MAIL_USER;
    delete process.env.RESEND_API_KEY;
    delete process.env.MAIL_USER;
    let result;
    try {
      await withRealSendPath(async () => {
        result = await emailService.sendNotificationEmails(['someone@example.com'], { title: 'T', desc: 'D' });
      });
      expect(result.skipped).toBe('not_configured');
      expect(result.sent).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(sendMock).not.toHaveBeenCalled();
    } finally {
      if (savedKey !== undefined) process.env.RESEND_API_KEY = savedKey;
      if (savedUser !== undefined) process.env.MAIL_USER = savedUser;
    }
  });

  test('a partial failure across multiple recipients reports each independently (one sent, one failed)', async () => {
    sendMock
      .mockResolvedValueOnce({ data: { id: '1' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'rejected' } })
      .mockResolvedValueOnce({ data: null, error: { message: 'rejected' } }); // the second recipient's retry
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let result;
    try {
      await withRealSendPath(async () => {
        result = await emailService.sendNotificationEmails(['ok@example.com', 'bad@example.com'], { title: 'T', desc: 'D' });
      });
      expect(result.sent).toEqual(['ok@example.com']);
      expect(result.failed.map(f => f.email)).toEqual(['bad@example.com']);
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});

describe('A failed email never makes the in-app (Channel 1) notification silently disappear or fail', () => {
  let db;
  const recipient = `jesttest-email-failure-${Date.now()}@example.com`;
  let createdNotifId;

  beforeAll(async () => { db = await connectDB(); });
  afterAll(async () => {
    if (createdNotifId != null) await db.collection('notifications').deleteOne({ id: createdNotifId });
    await closeDB();
  });

  test('createNotification() still succeeds and the DB record still exists, even when the real send path would reject', async () => {
    sendMock.mockResolvedValue({ data: null, error: { message: 'simulated rejection' } });
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    let res;
    try {
      await withRealSendPath(async () => {
        res = await notificationService.createNotification(db, {
          recipients: [recipient], module: 'system', tag: 'System Alert',
          title: 'jesttest email-failure resilience', desc: 'Channel 1 must survive a Channel 2 failure.'
        });
        expect(res.success).toBe(true);
        expect(res.insertedCount).toBe(1);
        createdNotifId = res.docs[0].id;

        const emailResult = await res.emailPromise;
        expect(emailResult.sent).toEqual([]);
        expect(emailResult.failed[0].email).toBe(recipient);
      });

      const inDb = await db.collection('notifications').findOne({ id: createdNotifId });
      expect(inDb).toBeTruthy();
      expect(inDb.targetEmail).toBe(recipient);
      expect(inDb.title).toBe('jesttest email-failure resilience');
    } finally {
      errorSpy.mockRestore();
      warnSpy.mockRestore();
    }
  });
});
