require('dotenv').config();
const { connectDB, closeDB } = require('../db');
const app = require('../cirl');
const emailService = require('../services/emailService');

describe('TASK 2 — Partnership Expiration Email Notifications', () => {
  let db;
  const stamp = Date.now();
  const testPartnershipId = stamp;
  const renewalPartnershipId = stamp + 1;

  beforeAll(async () => {
    db = await connectDB();

    // Create test active reviewer accounts. $setOnInsert (not $set) for `id` — users.id now has a unique
    // index (2026-11 Phase 2 sequential-id fix); an upsert that only ever $set name/role/status left every
    // newly-inserted doc with NO id field at all, which that index treats as id: null, so the second and
    // third upsert here collided with the first the moment all three ran against an empty filter. Computed
    // once, up front, the same plain "read the current max, then increment" every other test fixture in this
    // suite already uses (test/helpers.js's own createTestUser()) — fine for a one-time, serial beforeAll,
    // not a path this app's real concurrent traffic ever runs through.
    const lastUser = await db.collection('users').find({}).sort({ id: -1 }).limit(1).toArray();
    let nextTestUserId = lastUser.length ? (lastUser[0].id || 0) + 1 : 1;
    await db.collection('users').updateOne(
      { email: 'admin-expire-test@cirl.test' },
      { $set: { name: 'Admin Expire Test', role: 'Administrator', status: 'Active' }, $setOnInsert: { id: nextTestUserId++ } },
      { upsert: true }
    );
    await db.collection('users').updateOne(
      { email: 'staff-expire-test@cirl.test' },
      { $set: { name: 'Staff Expire Test', role: 'Staff', status: 'Active' }, $setOnInsert: { id: nextTestUserId++ } },
      { upsert: true }
    );
    await db.collection('users').updateOne(
      { email: 'inactive-expire-test@cirl.test' },
      { $set: { name: 'Inactive User', role: 'Staff', status: 'Inactive' }, $setOnInsert: { id: nextTestUserId++ } },
      { upsert: true }
    );
  });

  afterAll(async () => {
    if (db) {
      await db.collection('users').deleteMany({
        email: { $in: ['admin-expire-test@cirl.test', 'staff-expire-test@cirl.test', 'inactive-expire-test@cirl.test'] }
      });
      await db.collection('partnerships').deleteMany({
        id: { $in: [testPartnershipId, renewalPartnershipId] }
      });
      await db.collection('partnership_expiration_notifications').deleteMany({
        partnershipId: { $in: [testPartnershipId, renewalPartnershipId] }
      });
    }
    await closeDB();
  });

  beforeEach(() => {
    emailService.sentForTests.length = 0;
  });

  describe('Date Calculation & Milestone Rules', () => {
    test('calculateDaysRemaining accurately counts local calendar days', () => {
      const today = new Date(2026, 9, 1); // Oct 1, 2026

      expect(app.calculateDaysRemaining('2026-10-01', today)).toBe(0);
      expect(app.calculateDaysRemaining('2026-10-02', today)).toBe(1);
      expect(app.calculateDaysRemaining('2026-10-16', today)).toBe(15);
      expect(app.calculateDaysRemaining('2026-10-31', today)).toBe(30);
      expect(app.calculateDaysRemaining('2026-11-30', today)).toBe(60);
      expect(app.calculateDaysRemaining('2026-12-30', today)).toBe(90);
      expect(app.calculateDaysRemaining('2026-09-30', today)).toBe(-1);
      expect(app.calculateDaysRemaining('', today)).toBeNull();
      expect(app.calculateDaysRemaining('invalid-date', today)).toBeNull();
    });

    // 2026-11 (Email Delivery Check): replaced the old 90/60/30/15 + daily-countdown-to-0 design with a
    // fixed milestone list only — 90, 30, 15, 7, 3, 1, and 0 (expiry day), each sent once, never daily.
    test('isExpirationNotificationDay matches exactly the fixed milestone list (90, 30, 15, 7, 3, 1, 0) — no daily repeats', () => {
      // Milestones
      for (const d of [90, 30, 15, 7, 3, 1, 0]) {
        expect(app.isExpirationNotificationDay(d)).toBe(true);
      }

      // Every OTHER day in between a milestone is explicitly NOT a notification day anymore — this is the
      // behavior that changed: 14, 13, ..., 2 used to all be true (daily reminders); none of them are now.
      for (const d of [89, 61, 60, 45, 31, 29, 16, 14, 13, 8, 6, 4, 2, 91]) {
        expect(app.isExpirationNotificationDay(d)).toBe(false);
      }
      expect(app.isExpirationNotificationDay(-1)).toBe(false);
      expect(app.isExpirationNotificationDay(null)).toBe(false);
    });
  });

  describe('Recipient Aggregation', () => {
    test('aggregates Administrator, CIRL Staff, partnerEmail, coordinator email, and approved requester', async () => {
      const partnership = {
        id: testPartnershipId,
        inst: `Test Expire Recipient Inst ${stamp}`,
        type: 'MOA',
        partnerEmail: 'partner-stakeholder@partner.test',
        coordinator: 'coordinator@cspc.edu.ph',
        end: '2026-10-16'
      };

      await db.collection('requests').insertOne({
        id: stamp + 50,
        institution: partnership.inst,
        status: 'Approved',
        submittedByEmail: 'original-requester@cspc.edu.ph'
      });

      const recipients = await app.getPartnershipEmailRecipients(db, partnership);

      await db.collection('requests').deleteOne({ id: stamp + 50 });

      expect(recipients).toContain('admin-expire-test@cirl.test');
      expect(recipients).toContain('staff-expire-test@cirl.test');
      expect(recipients).not.toContain('inactive-expire-test@cirl.test'); // Inactive user excluded
      expect(recipients).toContain('partner-stakeholder@partner.test');
      expect(recipients).toContain('coordinator@cspc.edu.ph');
      expect(recipients).toContain('original-requester@cspc.edu.ph');
    });
  });

  describe('Email Content Formatting', () => {
    test('formats payload with institution, type, nature, expiration date, days remaining, and link', () => {
      const p = {
        id: testPartnershipId,
        inst: 'Tokyo University',
        country: 'Japan',
        type: 'MOA',
        nature: ['Research', 'Student Exchange'],
        end: 'Oct 15, 2026'
      };

      // Milestone
      const milestonePayload = app.formatExpirationEmailPayload(p, 90);
      expect(milestonePayload.title).toContain('90 Days Remaining');
      expect(milestonePayload.desc).toContain('Tokyo University');
      expect(milestonePayload.desc).toContain('Oct 15, 2026');
      expect(milestonePayload.desc).toContain('Research, Student Exchange');
      expect(milestonePayload.link).toContain('/lifecycle?q=Tokyo%20University');

      // Urgent milestone (e.g. 15d, 7d, 3d, 1d) — renamed from "Daily Reminder" since these no longer repeat daily.
      const urgentPayload = app.formatExpirationEmailPayload(p, 7);
      expect(urgentPayload.title).toContain('7 Days Remaining');
      expect(urgentPayload.desc).toContain('Tokyo University');
      expect(urgentPayload.tag).toContain('Urgent Milestone');

      // Final Notice (0 days remaining)
      const finalPayload = app.formatExpirationEmailPayload(p, 0);
      expect(finalPayload.title).toContain('Expires Today');
      expect(finalPayload.tag).toContain('Final Notice');
    });
  });

  describe('Automated Notification Execution and Deduplication', () => {
    const fixedNow = new Date(2026, 9, 1); // 2026-10-01

    beforeEach(async () => {
      await db.collection('partnership_expiration_notifications').deleteMany({
        partnershipId: { $in: [testPartnershipId, renewalPartnershipId] }
      });
      await db.collection('partnerships').deleteMany({
        id: { $in: [testPartnershipId, renewalPartnershipId] }
      });
    });

    test('sends email notification on 90-day milestone and prevents duplicates on repeat runs', async () => {
      // 90 days after Oct 1, 2026 is Dec 30, 2026
      await db.collection('partnerships').insertOne({
        id: testPartnershipId,
        inst: `Jest Milestone Inst ${stamp}`,
        type: 'MOU',
        nature: ['Research'],
        status: 'Expiring Soon',
        start: '2023-12-30',
        end: '2026-12-30'
      });

      // First run: should send notification
      const sent1 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: testPartnershipId });
      expect(sent1).toBe(1);
      expect(emailService.sentForTests.length).toBeGreaterThan(0);
      const firstBatchSize = emailService.sentForTests.length;

      // Check audit record in DB
      const audit = await db.collection('partnership_expiration_notifications').findOne({
        partnershipId: testPartnershipId,
        milestone: 90
      });
      expect(audit).toBeDefined();
      expect(audit.endKey).toBe('2026-12-30');

      // Second run on the same day: should NOT duplicate
      const sent2 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: testPartnershipId });
      expect(sent2).toBe(0);
      expect(emailService.sentForTests.length).toBe(firstBatchSize); // No extra emails sent
    });

    test('fires once on each of the fixed milestones (15, 7, 3, 1, 0) and NOT on the non-milestone days between them', async () => {
      // 15 days after Oct 1, 2026 is Oct 16, 2026
      await db.collection('partnerships').insertOne({
        id: testPartnershipId,
        inst: `Jest Milestones Inst ${stamp}`,
        type: 'MOA',
        nature: ['Academic'],
        status: 'Expiring Soon',
        start: '2023-10-16',
        end: '2026-10-16'
      });

      // Day 15 (2026-10-01): fires
      const sent15 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: testPartnershipId });
      expect(sent15).toBe(1);

      // Re-run same day: deduplicated
      const rerun15 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: testPartnershipId });
      expect(rerun15).toBe(0);

      // Day 14 (2026-10-02): NOT a milestone anymore — the behavior that changed (used to fire daily)
      const day14 = new Date(2026, 9, 2);
      const sent14 = await app.checkPartnershipExpirationNotifications(db, day14, { id: testPartnershipId });
      expect(sent14).toBe(0);

      // Day 7 (2026-10-09): fires
      const day7 = new Date(2026, 9, 9);
      expect(await app.checkPartnershipExpirationNotifications(db, day7, { id: testPartnershipId })).toBe(1);

      // Day 3 (2026-10-13): fires
      const day3 = new Date(2026, 9, 13);
      expect(await app.checkPartnershipExpirationNotifications(db, day3, { id: testPartnershipId })).toBe(1);

      // Day 2 (2026-10-14): NOT a milestone
      const day2 = new Date(2026, 9, 14);
      expect(await app.checkPartnershipExpirationNotifications(db, day2, { id: testPartnershipId })).toBe(0);

      // Day 1 (2026-10-15): fires
      const day1 = new Date(2026, 9, 15);
      expect(await app.checkPartnershipExpirationNotifications(db, day1, { id: testPartnershipId })).toBe(1);

      // Day 0 / expiry (2026-10-16): fires
      const day0 = new Date(2026, 9, 16);
      const sent0 = await app.checkPartnershipExpirationNotifications(db, day0, { id: testPartnershipId });
      expect(sent0).toBe(1);

      const finalAudit = await db.collection('partnership_expiration_notifications').findOne({
        partnershipId: testPartnershipId,
        milestone: 0
      });
      expect(finalAudit).toBeDefined();
      expect(finalAudit.payload.title).toContain('Expires Today');

      // Exactly 5 audit rows for this partnership: 15, 7, 3, 1, 0 — never one for 14 or 2.
      const allAudits = await db.collection('partnership_expiration_notifications').find({ partnershipId: testPartnershipId }).toArray();
      expect(allAudits.map((a) => a.milestone).sort((a, b) => b - a)).toEqual([15, 7, 3, 1, 0]);
    });

    test('renewal/extension with new expiration date triggers fresh notification cycle', async () => {
      // Partnership expiring in 30 days (2026-10-31)
      await db.collection('partnerships').insertOne({
        id: renewalPartnershipId,
        inst: `Jest Renewal Inst ${stamp}`,
        type: 'MOA',
        nature: ['Research'],
        status: 'Expiring Soon',
        start: '2023-10-31',
        end: '2026-10-31'
      });

      // 30 days remaining on 2026-10-01
      const sent30 = await app.checkPartnershipExpirationNotifications(db, fixedNow, { id: renewalPartnershipId });
      expect(sent30).toBe(1);

      // Partnership is now renewed/extended with new end date: 2029-10-31
      await db.collection('partnerships').updateOne(
        { id: renewalPartnershipId },
        { $set: { end: '2029-10-31', status: 'Active' } }
      );

      // Simulate time jumping to 30 days before the new expiration date (2029-10-01)
      const newNow = new Date(2029, 9, 1);
      const sentNew30 = await app.checkPartnershipExpirationNotifications(db, newNow, { id: renewalPartnershipId });
      expect(sentNew30).toBe(1);

      const audits = await db.collection('partnership_expiration_notifications').find({
        partnershipId: renewalPartnershipId
      }).toArray();
      expect(audits.length).toBe(2);
      expect(audits.map(a => a.endKey)).toContain('2026-10-31');
      expect(audits.map(a => a.endKey)).toContain('2029-10-31');
    });

    test('skips partnerships with invalid dates or already expired (< 0 days)', async () => {
      await db.collection('partnerships').insertOne({
        id: testPartnershipId,
        inst: `Jest Expired Inst ${stamp}`,
        type: 'MOA',
        status: 'Expired',
        end: '2025-01-01'
      });

      const sent = await app.checkPartnershipExpirationNotifications(db, fixedNow);
      expect(sent).toBe(0);
    });
  });
});
