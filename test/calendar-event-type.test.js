// Calendar Event Type field (2026-11) — a searchable <select> (predefined types) plus an "Other / Custom…"
// option that reveals a free-text input (views/administrator/calendar.ejs), persisted as the new optional
// `eventType` string field (cirl.js CALENDAR_EVENT_FIELDS). "Physical Meeting" is one of the predefined
// values; it carries no separate schema field of its own — the UI relabels the existing Institution/Location
// field as the venue and hides the Join-meeting control for it, both covered by calendar-add-event-steps.test.js
// at the source level. This file proves the field itself persists correctly end-to-end through the real API.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let db, adminAgent;
const createdEventIds = [];

function isoInDays(days, hh, mm) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` + (hh != null ? `T${String(hh).padStart(2, '0')}:${String(mm || 0).padStart(2, '0')}` : '');
}

beforeAll(async () => {
  db = await connectDB();
  adminAgent = request.agent(app); await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
});

afterAll(async () => {
  if (createdEventIds.length) await db.collection('calendarevents').deleteMany({ id: { $in: createdEventIds } });
  await cleanupAll();
  await closeDB();
});

describe('Event Type field persistence', () => {
  test('a predefined eventType (e.g. "Conference") is saved and returned as-is', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Conference event', start: isoInDays(1, 9, 0), end: isoInDays(1, 10, 0), allDay: false,
      className: 'bg-primary-subtle', location: 'Main Hall', eventType: 'Conference', recipients: []
    });
    expect(res.status).toBe(200);
    expect(res.body.event.eventType).toBe('Conference');
    createdEventIds.push(res.body.event.id);

    const doc = await db.collection('calendarevents').findOne({ id: res.body.event.id });
    expect(doc.eventType).toBe('Conference');
  });

  test('a custom (non-predefined) eventType string is saved exactly as given', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Custom type event', start: isoInDays(1, 11, 0), end: isoInDays(1, 12, 0), allDay: false,
      className: 'bg-primary-subtle', location: 'Room 204', eventType: 'Alumni Homecoming', recipients: []
    });
    expect(res.status).toBe(200);
    expect(res.body.event.eventType).toBe('Alumni Homecoming');
    createdEventIds.push(res.body.event.id);
  });

  test('"Physical Meeting" is just a string value of eventType — no separate field required, and the existing Institution/Location value is kept as the venue', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Physical Meeting event', start: isoInDays(1, 13, 0), end: isoInDays(1, 14, 0), allDay: false,
      className: 'bg-primary-subtle', location: 'Admin Bldg, Room 101', eventType: 'Physical Meeting', recipients: []
    });
    expect(res.status).toBe(200);
    expect(res.body.event.eventType).toBe('Physical Meeting');
    expect(res.body.event.location).toBe('Admin Bldg, Room 101');
    createdEventIds.push(res.body.event.id);

    // Round-trips through the main feed (what the calendar grid actually renders from) exactly the same way.
    const feed = await adminAgent.get('/api/calendarevents').set('X-Requested-With', 'ciprms');
    const fromFeed = feed.body.find(e => e.id === res.body.event.id);
    expect(fromFeed.eventType).toBe('Physical Meeting');
  });

  test('eventType is optional — omitting it entirely still creates the event (backward compatible)', async () => {
    const res = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest No event type given', start: isoInDays(1, 15, 0), end: isoInDays(1, 16, 0), allDay: false,
      className: 'bg-primary-subtle', location: 'Somewhere', recipients: []
    });
    expect(res.status).toBe(200);
    expect(res.body.event.eventType).toBeUndefined();
    createdEventIds.push(res.body.event.id);
  });

  test('PATCH can change the eventType of an existing event', async () => {
    const created = await adminAgent.post('/api/calendarevents').send({
      title: 'jesttest Type change event', start: isoInDays(2, 9, 0), end: isoInDays(2, 10, 0), allDay: false,
      className: 'bg-primary-subtle', location: 'Hall B', eventType: 'Meeting', recipients: []
    });
    const id = created.body.event.id;
    createdEventIds.push(id);

    const patched = await adminAgent.patch('/api/calendarevents/' + id).send({ eventType: 'Workshop' });
    expect(patched.status).toBe(200);
    expect(patched.body.event.eventType).toBe('Workshop');

    const doc = await db.collection('calendarevents').findOne({ id });
    expect(doc.eventType).toBe('Workshop');
  });
});
