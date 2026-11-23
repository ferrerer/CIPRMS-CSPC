// Potential Partner UI cleanup: no Dashboard, Document Library or Notifications PAGE, no Search bar,
// no Notifications item in the profile menu — while the header Notifications bell keeps working
// (user-specific, with its overflow protection). Nothing here may leak into Administrator, Staff or
// College Dean.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, getDb } = require('./helpers');

beforeAll(async () => { await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

async function agentFor(role) {
  const user = await createTestUser({ role });
  const agent = request.agent(app);
  const login = await loginAs(agent, user);
  return { agent, user, login };
}
const navHrefs = html => [...html.matchAll(/<a class="nav-link menu-link[^"]*"\s+href="([^"]+)"/g)].map(m => m[1]);
const PARTNER_PAGES = ['/partner/requests', '/partner/monitoring', '/partner/calendar', '/partner/settings'];

describe('Partner: post-login landing and the three removed pages', () => {
  let agent, login;
  beforeAll(async () => { ({ agent, login } = await agentFor('potential_partner')); });

  test('login lands on Monitoring (there is no Dashboard to land on)', async () => {
    expect(login.status).toBe(302);
    expect(login.headers.location).toBe('/partner/monitoring');
  });

  test('"/" and "/partner" both send a signed-in Partner to Monitoring', async () => {
    for (const path of ['/', '/partner']) {
      const res = await agent.get(path);
      expect(res.status).toBe(302);
      expect(res.headers.location).toBe('/partner/monitoring');
    }
  });

  test.each(['/partner/dashboard', '/partner/documents'])('%s redirects to Monitoring — never a 404/500 — and Monitoring then renders', async (path) => {
    const res = await agent.get(path);
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/partner/monitoring');
    expect((await agent.get(res.headers.location)).status).toBe(200);
  });

  test('a logged-out visitor is sent to login, and other roles who wander onto these URLs go to their OWN home', async () => {
    for (const path of ['/partner/dashboard', '/partner/documents']) {
      const anon = await request(app).get(path);
      expect(anon.status).toBe(302);
      expect(anon.headers.location).toBe('/');
    }
    for (const [role, home] of [['Administrator', '/dashboard'], ['Staff', '/staff/dashboard'], ['Auth. Personnel', '/personnel/monitoring']]) {
      const other = (await agentFor(role)).agent;
      for (const path of ['/partner/dashboard', '/partner/documents']) {
        const res = await other.get(path);
        expect(res.status).toBe(302);
        expect(res.headers.location).toBe(home);
      }
    }
  });

  test('the pages Partner keeps still render', async () => {
    for (const path of PARTNER_PAGES) expect((await agent.get(path)).status).toBe(200);
  });
});

describe('Partner: sidebar and header on every remaining page', () => {
  let agent;
  beforeAll(async () => { ({ agent } = await agentFor('potential_partner')); });

  test('sidebar is Requests, Monitoring, Calendar, Notifications, Settings, Logout — no Dashboard or Document Library item', async () => {
    for (const path of PARTNER_PAGES) {
      const html = (await agent.get(path)).text;
      expect(navHrefs(html)).toEqual(['/partner/requests', '/partner/monitoring', '/partner/calendar', '/partner/notifications', '/partner/settings', '#']);
      expect(html).toContain('id="sidebar-notif-badge"');
      for (const gone of ['/partner/dashboard', '/partner/documents']) expect(html).not.toContain('href="' + gone + '"');
      expect(html).not.toMatch(/ri-dashboard-2-line/);
    }
  });

  test('logo and "CIPRMS" breadcrumb point at Monitoring, not the removed Dashboard', async () => {
    for (const path of PARTNER_PAGES) {
      const html = (await agent.get(path)).text;
      expect(html).toMatch(/<a href="\/partner\/monitoring" class="logo logo-dark">/);
      expect(html).toContain('breadcrumb-item"><a href="/partner/monitoring">CIPRMS</a>');
    }
  });

  test('header has NO Search bar (desktop input or mobile toggle)', async () => {
    for (const path of PARTNER_PAGES) {
      const html = (await agent.get(path)).text;
      expect(html).not.toContain('id="search-options"');
      expect(html).not.toContain('page-header-search-dropdown');
      expect(html).not.toContain('app-search');
    }
  });

  test('header KEEPS the Notifications bell (badge + dropdown + shared feed), fullscreen, dark mode and the user menu', async () => {
    for (const path of PARTNER_PAGES) {
      const html = (await agent.get(path)).text;
      expect(html).toContain('id="notificationDropdown"');
      expect(html).toContain('page-header-notifications-dropdown');
      expect(html).toContain('id="notif-badge"');
      expect(html).toContain('/api/notifications/unread-count');
      expect(html).toContain('/api/notifications/mine');
      expect(html).toContain('data-toggle="fullscreen"');
      expect(html).toContain('light-dark-mode');
      expect(html).toContain('page-header-user-dropdown');
      // Velzon's global app.js needs #removeNotificationModal exactly once
      expect(html.split('id="removeNotificationModal"').length - 1).toBe(1);
    }
  });

  test('the bell has "View All Notifications" (Partner has its own Notifications page again) and the profile menu is only Settings and Logout', async () => {
    for (const path of PARTNER_PAGES) {
      const html = (await agent.get(path)).text;
      expect(html).toMatch(/href="\/partner\/notifications" class="btn btn-soft-success[^"]*">View All Notifications/);
      const menu = html.slice(html.indexOf('page-header-user-dropdown'), html.indexOf('</header>'));
      expect(menu).not.toMatch(/class="align-middle">Notifications</);
      expect(menu).not.toMatch(/class="align-middle">Profile</);
      expect(menu).toMatch(/href="\/partner\/settings"[^>]*>[\s\S]*?Settings/);
      expect(menu).toContain('Logout');
    }
  });

  test('Partner pages load the notification-overflow stylesheet (they do not load ciprms-bridge.css, where it used to live)', async () => {
    for (const path of PARTNER_PAGES) {
      const html = (await agent.get(path)).text;
      expect(html).toContain('href="/velzon/assets/css/header-notifications.css"');
      expect(html).not.toContain('ciprms-bridge.css'); // the reason the dedicated file is needed
    }
    const css = await request(app).get('/velzon/assets/css/header-notifications.css');
    expect(css.status).toBe(200);
    expect(css.text).toMatch(/\.notif-scroll\s*{[^}]*max-height:\s*280px[^}]*overflow-y:\s*auto/);
    expect(css.text).toMatch(/\.notification-item \.notif-title-line[\s\S]*?text-overflow:\s*ellipsis[\s\S]*?white-space:\s*nowrap/);
    expect(css.text).toMatch(/\[data-bs-theme="dark"\] \.notif-scroll/);
  });

  test('the Partner "Monitoring" page keeps My Partnership Requests (My Document Requests was removed on purpose — see partner-requests-cleanup.test.js)', async () => {
    const html = (await agent.get('/partner/monitoring')).text;
    expect(html).toContain('My Partnership Requests');
    expect(html).not.toContain('My Document Requests');
  });
});

describe('Partner header notifications are user-specific and correctly counted', () => {
  let agent, partner, otherAgent, other;
  const LONG = 'jesttest ' + 'A very long notification sentence that must never stretch the header or the dropdown. '.repeat(6);

  beforeAll(async () => {
    ({ agent, user: partner } = await agentFor('potential_partner'));
    ({ agent: otherAgent, user: other } = await agentFor('potential_partner'));
    const db = getDb();
    const last = await db.collection('notifications').find({}).sort({ id: -1 }).limit(1).toArray();
    let id = (last.length ? last[0].id : 0) + 1000;
    const mk = (targetEmail, title, desc, unread) => ({ id: id++, targetEmail, unread, time: 'Sep 20, 2026', module: 'request', tag: 'Document Request', icon: 'ri-file-shield-2-line', color: 'secondary', title, desc, link: '/partner/monitoring' });
    const docs = [];
    for (let i = 1; i <= 12; i++) docs.push(mk(partner.email, i % 4 === 0 ? LONG : `jesttest mine #${i}`, i % 4 === 0 ? LONG : `jesttest desc ${i}`, i > 3)); // 9 unread, 3 read
    docs.push(mk(other.email, 'jesttest SECRET for the other partner', 'jesttest not yours', true), mk(other.email, 'jesttest SECRET two', 'jesttest not yours', true));
    await db.collection('notifications').insertMany(docs);
  });

  test('GET /api/notifications/mine returns only the signed-in Partner\'s own notifications (12), never the other Partner\'s', async () => {
    const mine = (await agent.get('/api/notifications/mine')).body;
    expect(mine).toHaveLength(12);
    expect(mine.every(n => n.targetEmail === partner.email)).toBe(true);
    expect(JSON.stringify(mine)).not.toContain('SECRET');
    const theirs = (await otherAgent.get('/api/notifications/mine')).body;
    expect(theirs).toHaveLength(2);
    expect(theirs.every(n => n.targetEmail === other.email)).toBe(true);
  });

  test('the badge count is each user\'s own unread total (9 vs 2)', async () => {
    expect((await agent.get('/api/notifications/unread-count')).body.count).toBe(9);
    expect((await otherAgent.get('/api/notifications/unread-count')).body.count).toBe(2);
  });

  test('a Partner cannot mark another user\'s notification read, and marking their own decrements the badge', async () => {
    const theirs = (await otherAgent.get('/api/notifications/mine')).body[0];
    expect((await agent.patch('/api/notifications/' + theirs.id).send({ unread: false })).status).toBe(403);
    expect((await otherAgent.get('/api/notifications/unread-count')).body.count).toBe(2); // untouched

    const mine = (await agent.get('/api/notifications/mine')).body.find(n => n.unread);
    expect((await agent.patch('/api/notifications/' + mine.id).send({ unread: false })).status).toBe(200);
    expect((await agent.get('/api/notifications/unread-count')).body.count).toBe(8);
  });
});

describe('Nothing leaks into Administrator, Staff or College Dean', () => {
  test.each([['Administrator', '/dashboard'], ['Staff', '/staff/dashboard']])('%s keeps Search and "See All", has a Settings/Logout-only profile menu, and the shared notification-dropdown stylesheet (%s)', async (role, path) => {
    const { agent } = await agentFor(role);
    const html = (await agent.get(path)).text;
    expect(html).toContain('id="search-options"');
    expect(html).toContain('page-header-search-dropdown');
    expect(html).toMatch(/class="[^"]*view-all[^"]*"/);
    expect(html).toContain('View All Notifications');
    const menu = html.slice(html.indexOf('page-header-user-dropdown'), html.indexOf('</header>'));
    expect(menu).not.toMatch(/class="align-middle">(Profile|Notifications)</); // the profile menu is Settings + Logout for every role
    expect(menu).toMatch(/class="align-middle">Settings</);
    expect(menu).toContain('Logout');
    expect(html).toContain('href="/velzon/assets/css/header-notifications.css"');
  });

  test('Administrator and Staff still have Dashboard, Document Library and Notifications pages + sidebar items', async () => {
    const admin = (await agentFor('Administrator')).agent;
    for (const path of ['/dashboard', '/documents', '/notifications']) expect((await admin.get(path)).status).toBe(200);
    const adminNav = navHrefs((await admin.get('/dashboard')).text);
    for (const href of ['/dashboard', '/documents', '/notifications']) expect(adminNav).toContain(href);

    const staff = (await agentFor('Staff')).agent;
    for (const path of ['/staff/dashboard', '/staff/documents', '/staff/notifications']) expect((await staff.get(path)).status).toBe(200);
    const staffNav = navHrefs((await staff.get('/staff/dashboard')).text);
    for (const href of ['/staff/dashboard', '/staff/documents', '/staff/notifications']) expect(staffNav).toContain(href);
  });

  test('College Dean: no Search, "View All Notifications" to its own page, same sidebar, and the notification dropdown keeps its one-line, scrollable layout', async () => {
    const { agent } = await agentFor('Auth. Personnel');
    const html = (await agent.get('/personnel/monitoring')).text;
    expect(html).not.toContain('id="search-options"');
    expect(html).toContain('href="/personnel/notifications" class="btn btn-soft-success');
    // Its Monitoring page does not load ciprms-bridge.css, so without this the bell's items wrapped over many lines.
    expect(html).toContain('href="/velzon/assets/css/header-notifications.css"');
    expect(navHrefs(html)).toEqual(['/personnel/monitoring', '/personnel/requests', '/personnel/calendar', '/personnel/settings', '#']);
  });
});

describe('The header bell has no "Alerts" tab for any role', () => {
  test.each([
    ['Partner', 'potential_partner', '/partner/monitoring'],
    ['College Dean', 'Auth. Personnel', '/personnel/monitoring'],
    ['Administrator', 'Administrator', '/dashboard'],
    ['CIRL Staff', 'Staff', '/staff/dashboard']
  ])('%s: just the notification list — no Alerts tab, no unread-only pane', async (_label, role, path) => {
    const { agent } = await agentFor(role);
    const html = (await agent.get(path)).text;
    expect(html).toContain('id="notif-list"');            // the bell and its list are still there
    expect(html).toContain('id="notif-badge"');
    expect(html).not.toContain('>Alerts<');
    expect(html).not.toContain('alerts-tab');
    expect(html).not.toContain('id="notif-alerts-list"');   // (the header script still names it, and skips it when absent)
    expect(html).not.toContain('id="notificationItemsTab"');
  });
});
