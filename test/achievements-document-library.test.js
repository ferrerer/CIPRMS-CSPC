// Institutional Achievements → Document Library archiving (2026-11). Covers what changed when the
// Achievements section moved out of the header-triggered modal to the bottom of the Dashboard: every
// uploaded file now archives through the same pipeline as Partner Activities (archiveToDocumentLibrary),
// in its own "Achievements" folder/type, linked back via achievementId; replacing a file supersedes the
// old Document Library entry (never deletes it); deleting the achievement keeps the entry, marked
// archived. RBAC, endpoint names and response shapes are unchanged — see test/profile-avatar.test.js's
// sibling note on this session's other storage-migration work for the same "never delete, just mark"
// convention this mirrors.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);
const PDF = Buffer.from('%PDF-1.4\n% jesttest achievements fixture\n');

let db;
const createdAchievementIds = [];
const createdDocumentIds = [];

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}

beforeAll(async () => { db = await connectDB(); });
afterAll(async () => {
  if (createdAchievementIds.length) await db.collection('achievements').deleteMany({ id: { $in: createdAchievementIds } });
  if (createdDocumentIds.length) await db.collection('documents').deleteMany({ id: { $in: createdDocumentIds } });
  await cleanupAll();
  await closeDB();
});

function trackAchievement(res) {
  if (res.body && res.body.achievement) createdAchievementIds.push(res.body.achievement.id);
  return res;
}
function trackDocument(id) {
  if (id != null) createdDocumentIds.push(id);
  return id;
}

describe('Creating an achievement with a file archives it to the Document Library', () => {
  test('the new achievement gets a documentId, and the Document Library entry is type "Achievements", linked by achievementId, never flagged as a duplicate of itself', async () => {
    const { agent } = await agentFor('Staff');
    const res = await trackAchievement(await agent.post('/api/achievements')
      .field('title', 'jesttest QS Ranking 2026')
      .field('category', 'QS Ranking')
      .field('organization', 'QS World University Rankings')
      .attach('file', PNG, { filename: 'cert.png', contentType: 'image/png' }));
    expect(res.status).toBe(200);
    expect(res.body.achievement.fileLink).toMatch(/^\/uploads\/documents\//); // archived via the shared pipeline, not uploads/achievements/
    expect(res.body.achievement.documentId).toBeTruthy();
    trackDocument(res.body.achievement.documentId);

    const doc = await db.collection('documents').findOne({ id: res.body.achievement.documentId });
    expect(doc).toBeTruthy();
    expect(doc.type).toBe('Achievements');
    expect(doc.achievementId).toBe(res.body.achievement.id);
    expect(doc.fileLink).toBe(res.body.achievement.fileLink);
    expect(doc.superseded).toBeFalsy();
    expect(doc.archived).toBeFalsy();
  });

  test('an achievement with no file gets no documentId, and nothing is archived', async () => {
    const { agent } = await agentFor('Staff');
    const res = await trackAchievement(await agent.post('/api/achievements')
      .field('title', 'jesttest No File Award')
      .field('category', 'Award'));
    expect(res.status).toBe(200);
    expect(res.body.achievement.documentId).toBeFalsy();
    expect(res.body.achievement.fileLink).toBeFalsy();
  });
});

describe('Editing: replacing the file supersedes the old Document Library entry; removing archives it', () => {
  test('replacing the file creates a NEW Document Library entry and marks the old one superseded (never deleted)', async () => {
    const { agent } = await agentFor('Administrator');
    const created = await trackAchievement(await agent.post('/api/achievements')
      .field('title', 'jesttest PQA Accreditation')
      .field('category', 'PQA')
      .attach('file', PDF, { filename: 'v1.pdf', contentType: 'application/pdf' }));
    const oldDocumentId = created.body.achievement.documentId;
    trackDocument(oldDocumentId);
    expect(oldDocumentId).toBeTruthy();

    const edited = await agent.patch('/api/achievements/' + created.body.achievement.id)
      .field('title', 'jesttest PQA Accreditation')
      .field('category', 'PQA')
      .attach('file', PDF, { filename: 'v2.pdf', contentType: 'application/pdf' });
    expect(edited.status).toBe(200);
    const newDocumentId = edited.body.achievement.documentId;
    trackDocument(newDocumentId);
    expect(newDocumentId).toBeTruthy();
    expect(newDocumentId).not.toBe(oldDocumentId);

    const oldDoc = await db.collection('documents').findOne({ id: oldDocumentId });
    expect(oldDoc).toBeTruthy(); // kept, never deleted
    expect(oldDoc.superseded).toBe(true);
    expect(oldDoc.supersededBy).toBe(newDocumentId);

    const newDoc = await db.collection('documents').findOne({ id: newDocumentId });
    expect(newDoc).toBeTruthy();
    expect(newDoc.superseded).toBeFalsy();
    expect(newDoc.achievementId).toBe(created.body.achievement.id);
  });

  test('removing the file (no replacement) archives the Document Library entry rather than deleting it', async () => {
    const { agent } = await agentFor('Administrator');
    const created = await trackAchievement(await agent.post('/api/achievements')
      .field('title', 'jesttest Remove File Ranking')
      .field('category', 'Ranking')
      .attach('file', PNG, { filename: 'r.png', contentType: 'image/png' }));
    const documentId = created.body.achievement.documentId;
    trackDocument(documentId);

    const edited = await agent.patch('/api/achievements/' + created.body.achievement.id)
      .field('title', 'jesttest Remove File Ranking')
      .field('category', 'Ranking')
      .field('removeFile', '1');
    expect(edited.status).toBe(200);
    expect(edited.body.achievement.fileLink).toBeFalsy();
    expect(edited.body.achievement.documentId).toBeFalsy();

    const doc = await db.collection('documents').findOne({ id: documentId });
    expect(doc).toBeTruthy(); // kept, never deleted
    expect(doc.archived).toBe(true);
  });
});

describe('Deleting an achievement keeps its Document Library entry, marked archived', () => {
  test('DELETE removes the achievement record but the Document Library entry survives, archived', async () => {
    const { agent } = await agentFor('Staff');
    const created = await trackAchievement(await agent.post('/api/achievements')
      .field('title', 'jesttest Delete Me Award')
      .field('category', 'Award')
      .attach('file', PNG, { filename: 'd.png', contentType: 'image/png' }));
    const documentId = created.body.achievement.documentId;
    trackDocument(documentId);

    const del = await agent.delete('/api/achievements/' + created.body.achievement.id);
    expect(del.status).toBe(200);
    expect(await db.collection('achievements').findOne({ id: created.body.achievement.id })).toBeNull();

    const doc = await db.collection('documents').findOne({ id: documentId });
    expect(doc).toBeTruthy(); // kept, never deleted
    expect(doc.archived).toBe(true);
  });
});

describe('Dashboard page: the old header "Achievements" modal trigger is gone', () => {
  test('neither /dashboard nor /staff/dashboard ships the old header button, and both still ship the new section', async () => {
    const { agent: adminAgent } = await agentFor('Administrator');
    const { agent: staffAgent } = await agentFor('Staff');
    for (const [agent, path] of [[adminAgent, '/dashboard'], [staffAgent, '/staff/dashboard']]) {
      const res = await agent.get(path);
      expect(res.status).toBe(200);
      expect(res.text).not.toContain('data-bs-target="#achievements-modal"');
      expect(res.text).toContain('id="ach-section-card"');
      expect(res.text).toContain('id="ach-section-list"');
      expect(res.text).toContain('id="ach-section-see-more"');
    }
  });
});
