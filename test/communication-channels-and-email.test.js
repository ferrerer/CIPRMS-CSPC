// Partnership Request Communication Channels + "Email for Every Notification" (2026-11).
//
// Part 1: visibility: 'shared' is now stamped on every supportingDocuments entry (mirrors lauReviews' own
// 'internal' marker, added in test/lau-internal-review.test.js) — not load-bearing for access control
// (supportingDocuments was already fully visible to Partner/LAU/Admin/Staff regardless of uploader; see
// POST /api/requests/:id/documents in cirl.js), just an explicit, queryable marker.
//
// Part 2: achievements and targets had NO notification at all before this change (grepped — confirmed
// absent). Added: creating either now notifies every OTHER active Administrator/Staff user (the actor is
// excluded), through the same notifyReviewers()/notificationService.createNotification() path every other
// notification in this app uses — which also means it already gets an e-mail, for free, via the exact
// same transport. Checked here with Jest's sentForTests capture (services/emailService.js) — never a real
// send.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');
const emailService = require('../services/emailService');

let db;
const createdRequestIds = [];
const createdAchievementIds = [];
const createdTargetIds = [];

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  if (createdRequestIds.length) await db.collection('requests').deleteMany({ id: { $in: createdRequestIds } });
  if (createdAchievementIds.length) await db.collection('achievements').deleteMany({ id: { $in: createdAchievementIds } });
  if (createdTargetIds.length) await db.collection('targets').deleteMany({ id: { $in: createdTargetIds } });
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

describe('Part 1: supportingDocuments entries are tagged visibility: "shared"', () => {
  test('a plain draft upload is stamped shared', async () => {
    const { agent } = await agentFor('potential_partner');
    const created = await agent.post('/api/requests').send({
      institution: `jesttest Comms Shared Inst ${Date.now()}`, country: 'Testland', type: 'MOA', nature: 'Academic'
    });
    const id = created.body.request.id;
    createdRequestIds.push(id);

    const res = await agent.post(`/api/requests/${id}/documents`).send({ note: 'jesttest shared-tag check' });
    expect(res.status).toBe(200);

    const updated = await db.collection('requests').findOne({ id });
    expect(updated.supportingDocuments[0].visibility).toBe('shared');
  });
});

describe('Part 2: achievements and targets now notify colleagues, with an email', () => {
  test('creating an achievement notifies every OTHER active Administrator/Staff, excludes the actor, and sends email', async () => {
    const { agent: actorAgent, user: actorUser } = await agentFor('Staff');
    const { user: colleagueUser } = await agentFor('Administrator');

    emailService.sentForTests.length = 0;
    const res = await actorAgent.post('/api/achievements')
      .field('title', `jesttest Comms Achievement ${Date.now()}`)
      .field('category', 'Award');
    expect(res.status).toBe(200);
    createdAchievementIds.push(res.body.achievement.id);

    const notifToColleague = await db.collection('notifications').findOne({ targetEmail: colleagueUser.email, tag: 'Achievement' });
    expect(notifToColleague).toBeTruthy();
    const notifToActor = await db.collection('notifications').findOne({ targetEmail: actorUser.email, tag: 'Achievement' });
    expect(notifToActor).toBeNull(); // the actor is excluded from their own notification

    const emailedColleague = emailService.sentForTests.some((m) => m.to === colleagueUser.email);
    expect(emailedColleague).toBe(true);
  });

  test('creating a target notifies every OTHER active Administrator/Staff, excludes the actor, and sends email', async () => {
    const { agent: actorAgent, user: actorUser } = await agentFor('Administrator');
    const { user: colleagueUser } = await agentFor('Staff');
    const year = 2000 + (Date.now() % 100); // TARGET_YEAR_MIN/MAX is 2000-2100; this just avoids the (type, year, month) unique index colliding with another run

    emailService.sentForTests.length = 0;
    const res = await actorAgent.post('/api/targets').send({ type: 'yearly', year, targetCount: 5 });
    expect(res.status).toBe(200);
    createdTargetIds.push(res.body.target.id);

    const notifToColleague = await db.collection('notifications').findOne({ targetEmail: colleagueUser.email, tag: 'Target' });
    expect(notifToColleague).toBeTruthy();
    const notifToActor = await db.collection('notifications').findOne({ targetEmail: actorUser.email, tag: 'Target' });
    expect(notifToActor).toBeNull();

    const emailedColleague = emailService.sentForTests.some((m) => m.to === colleagueUser.email);
    expect(emailedColleague).toBe(true);
  });
});
