// Profile pictures: every account starts with the default picture; an upload from Settings is stored on the account
// and shows in the header of every page (and replaces the previous file on disk).
const fs = require('fs');
const path = require('path');
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]), Buffer.alloc(64)]);
const DEFAULT_AVATAR = '/images/default-avatar.jpg';
const uploadedFiles = [];

beforeAll(async () => { await connectDB(); });
afterAll(async () => {
  // 2026-11 audit fix: avatar bytes now live in MongoDB, not on local disk (see cirl.js's
  // saveAvatarUpload/`avatars` collection) — nothing ever persists to disk to clean up here anymore,
  // but the Mongo documents this file's uploads created still need to be swept.
  for (const url of uploadedFiles) {
    fs.rmSync(path.join(__dirname, '..', url), { force: true });
    const fileId = (url.match(/^\/uploads\/avatars\/([A-Za-z0-9._-]+)$/) || [])[1];
    if (fileId) await getDb().collection('avatars').deleteOne({ _id: fileId });
  }
  await cleanupAll();
  await closeDB();
});

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  await loginAs(agent, user);
  return { agent, user };
}
const headerAvatar = html => (html.match(/header-profile-user js-user-avatar" src="([^"]+)"/) || [])[1];

describe('Profile picture', () => {
  test.each([
    ['Administrator', '/admin/settings', '/dashboard'],
    ['Staff', '/staff/settings', '/staff/dashboard'],
    ['Auth. Personnel', '/personnel/settings', '/personnel/monitoring'],
    ['potential_partner', '/partner/settings', '/partner/monitoring']
  ])('%s: starts with the default picture, and an upload shows in the header on every page', async (role, settings, home) => {
    const { agent } = await agentFor(role);
    expect(headerAvatar((await agent.get(settings)).text)).toBe(DEFAULT_AVATAR);

    const res = await agent.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'me.png', contentType: 'image/png' });
    expect(res.status).toBe(200);
    uploadedFiles.push(res.body.avatarUrl);
    expect(res.body.avatarUrl).toMatch(/^\/uploads\/avatars\/.+\.png$/);

    expect(headerAvatar((await agent.get(home)).text)).toBe(res.body.avatarUrl);
    expect(headerAvatar((await agent.get(settings)).text)).toBe(res.body.avatarUrl);
  });

  test('a new upload replaces the previous file; a file that is not really an image is refused', async () => {
    const { agent } = await agentFor('Staff');
    const first = await agent.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'a.png', contentType: 'image/png' });
    const second = await agent.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'b.png', contentType: 'image/png' });
    uploadedFiles.push(first.body.avatarUrl, second.body.avatarUrl);
    expect(second.status).toBe(200);
    await new Promise(r => setTimeout(r, 200)); // the old file is unlinked in the background
    expect(fs.existsSync(path.join(__dirname, '..', first.body.avatarUrl))).toBe(false);
    // The previous photo's MongoDB document is deleted outright on replace (unlike the Head's
    // e-signature, an avatar has no "keep every old version" requirement).
    const oldFileId = first.body.avatarUrl.split('/').pop();
    expect(await getDb().collection('avatars').findOne({ _id: oldFileId })).toBeNull();

    const fake = await agent.post('/api/profile/avatar').attach('avatar', Buffer.from('not an image'), { filename: 'x.png', contentType: 'image/png' });
    expect(fake.status).toBe(400);
  });

  // 2026-11 audit fix (High #3): avatars used to live only on local disk, which Render's free plan
  // wipes on every redeploy — silently breaking every profile photo in production. Bytes now live in
  // MongoDB; the upload's own temp disk file is deleted immediately (nothing is ever actually
  // persisted locally), which doubles as proof the photo doesn't depend on local disk surviving at all.
  test('a photo is never left on local disk at all (MongoDB is the only persistent copy), and still serves correctly', async () => {
    const { agent } = await agentFor('Staff');
    const up = await agent.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'gone.png', contentType: 'image/png' });
    uploadedFiles.push(up.body.avatarUrl);
    await new Promise(r => setTimeout(r, 200)); // the temp upload file is unlinked in the background
    expect(fs.existsSync(path.join(__dirname, '..', up.body.avatarUrl))).toBe(false);

    const res = await agent.get(up.body.avatarUrl);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/png/);
    expect(res.body.equals(PNG)).toBe(true); // the real uploaded photo, served straight from MongoDB
  });

  test('an avatarUrl with no matching MongoDB record (e.g. a legacy pointer never migrated) falls back to the default picture, not a broken image', async () => {
    const { agent } = await agentFor('Staff');
    const res = await agent.get('/uploads/avatars/jesttest-does-not-exist.png');
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/image\/jpeg/);
    expect(res.body.equals(fs.readFileSync(path.join(__dirname, '..', 'public', 'images', 'default-avatar.jpg')))).toBe(true);
    expect((await request(app).get('/uploads/avatars/jesttest-does-not-exist.png')).status).toBe(302); // still sign-in only
  });

  // 2026-11 Batch 1 follow-up: ETag is derived from the filename itself, which is never reused — a
  // replace/fresh upload always gets a brand-new filename (and so a brand-new URL/ETag), which is what
  // makes the new photo show immediately rather than being masked by a stale cached response.
  describe('ETag / Cache-Control', () => {
    test('a matching If-None-Match gets a 304 with no body', async () => {
      const { agent } = await agentFor('Staff');
      const up = await agent.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'etag.png', contentType: 'image/png' });
      uploadedFiles.push(up.body.avatarUrl);

      const first = await agent.get(up.body.avatarUrl);
      expect(first.status).toBe(200);
      const etag = first.headers.etag;
      expect(etag).toBeTruthy();
      expect(first.headers['cache-control']).toMatch(/private/);
      expect(first.headers['cache-control']).toMatch(/max-age=86400/);

      const second = await agent.get(up.body.avatarUrl).set('If-None-Match', etag);
      expect(second.status).toBe(304);
      expect(second.text || '').toBe('');
    });

    test('a new upload gets a different ETag (and URL) than the previous photo', async () => {
      // Two separate agents/users, not one user uploading twice — this file's own "replaces the
      // previous file" test already proves a second upload from the SAME user deletes the first one's
      // record outright, which would make its ETag disappear (no-store, no ETag) rather than merely
      // differ. Comparing two independently-still-existing avatars isolates the actual claim here: a
      // fresh upload's ETag is never reused for a different photo.
      const { agent: agentA } = await agentFor('Staff');
      const { agent: agentB } = await agentFor('Staff');
      const first = await agentA.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'v1.png', contentType: 'image/png' });
      const second = await agentB.post('/api/profile/avatar').attach('avatar', PNG, { filename: 'v2.png', contentType: 'image/png' });
      uploadedFiles.push(first.body.avatarUrl, second.body.avatarUrl);
      expect(first.body.avatarUrl).not.toBe(second.body.avatarUrl);

      const firstEtag = (await agentA.get(first.body.avatarUrl)).headers.etag;
      const secondEtag = (await agentB.get(second.body.avatarUrl)).headers.etag;
      expect(firstEtag).toBeTruthy();
      expect(secondEtag).toBeTruthy();
      expect(firstEtag).not.toBe(secondEtag);

      // Cross-checking the NEW url with the OLD ETag must not 304 (they are different resources).
      const crossCheck = await agentB.get(second.body.avatarUrl).set('If-None-Match', firstEtag);
      expect(crossCheck.status).toBe(200);
    });

    test('the "record missing, fell back to default" response is never cached', async () => {
      const { agent } = await agentFor('Staff');
      const res = await agent.get('/uploads/avatars/jesttest-etag-missing.png');
      expect(res.status).toBe(200);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers.etag).toBeFalsy();
    });
  });

  test('a Partner photo survives saving the Partner profile, and User Management cannot set anyone\'s picture', async () => {
    const { agent: partner, user } = await agentFor('potential_partner');
    const up = await partner.post('/api/partner/avatar').attach('avatar', PNG, { filename: 'p.png', contentType: 'image/png' });
    uploadedFiles.push(up.body.avatarUrl);
    await partner.post('/api/partner/profile').send({ organization: 'jesttest Org', contactName: 'jesttest Partner' });
    expect((await partner.get('/api/partner/profile')).body.avatarUrl).toBe(up.body.avatarUrl);

    const { agent: admin } = await agentFor('Administrator');
    const stored = await getDb().collection('users').findOne({ email: user.email });
    expect((await admin.patch('/api/users/' + stored.id).send({ avatarUrl: 'javascript:alert(1)' })).status).toBe(200);
    expect((await getDb().collection('users').findOne({ email: user.email })).avatarUrl).toBe(up.body.avatarUrl);
    await getDb().collection('profiles').deleteMany({ email: user.email });
  });
});
