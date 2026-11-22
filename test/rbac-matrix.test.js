// The "Role Permissions Matrix (RBAC)" on the User Management page is documentation rendered from a
// table in views/users.ejs. This suite keeps it honest: it parses the table exactly as an
// Administrator / CIRL Staff sees it and checks each row against what the real routes do for a real
// session of every role. If gating changes and the matrix is not updated (or vice versa), this fails.
// It only READS behaviour (plus one disposable calendar event); it changes no permission.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

const ROLES = ['admin', 'college', 'partner', 'staff'];           // matrix column order
const COLUMN_ROLE = { admin: 'Administrator', college: 'Auth. Personnel', partner: 'potential_partner', staff: 'Staff' };
let db, agents, matrix;
const createdEventIds = [];

const levelOf = (cellHtml) => /rbac-full/.test(cellHtml) ? 'full' : /rbac-none/.test(cellHtml) ? 'none' : /rbac-scoped/.test(cellHtml) ? 'scoped' : '?';
const textOf = (html) => html.replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&ldquo;|&rdquo;/g, '"').replace(/\s+/g, ' ').trim();

function parseMatrix(html) {
  const section = html.slice(html.indexOf('Role Permissions Matrix (RBAC)'));
  const rows = {};
  // 2026-11 layout: each role cell is <td class="rbac-cell rbac-full|rbac-scoped|rbac-none" data-role data-level>
  // holding an icon, the access text (.rbac-text) and a level word (.rbac-level). Columns ordered
  // Administrator, College Dean, Partner, CIRL Staff, LAU, then Notes. Full cells read just "Full".
  const cell = /<td class="(rbac-cell [^"]*)"[^>]*>([\s\S]*?)<\/td>\s*/.source;
  const re = new RegExp(/<tr[^>]*>\s*<td class="rbac-feature">([\s\S]*?)<\/td>\s*/.source + cell + cell + cell + cell + cell
    + /<td class="rbac-note">([\s\S]*?)<\/td>\s*<\/tr>/.source, 'g');
  const cellText = (html) => { const t = /<span class="rbac-text">([\s\S]*?)<\/span>/.exec(html); return textOf(t ? t[1] : html); };
  let m;
  while ((m = re.exec(section))) {
    const c = (k) => ({ level: levelOf(m[k]), text: cellText(m[k + 1]) });
    rows[textOf(m[1])] = { admin: c(2), college: c(4), partner: c(6), staff: c(8), lau: c(10), note: textOf(m[12]) };
  }
  return rows;
}

beforeAll(async () => {
  db = await connectDB();
  agents = {};
  for (const key of ROLES) {
    const user = await createTestUser({ role: COLUMN_ROLE[key], unit: key === 'college' ? 'CCS' : '' });
    agents[key] = request.agent(app);
    await loginAs(agents[key], user);
  }
  matrix = parseMatrix((await agents.admin.get('/users')).text);
});
afterAll(async () => {
  if (createdEventIds.length) await db.collection('calendarevents').deleteMany({ id: { $in: createdEventIds } });
  await cleanupAll();
  await closeDB();
});

const pageOpens = async (key, paths) => (await agents[key].get(paths[key])).status === 200;

describe('the matrix as rendered', () => {
  test('lists the current features, every cell has a level, and every row has a note', () => {
    expect(Object.keys(matrix)).toEqual([
      'Dashboard', 'Calendar', 'Meetings (invitations & attendance)', 'Monitoring', 'Registry (inside Monitoring)', 'Document Library',
      'User Management', 'Partnership Requests', 'Document Requests', 'Notifications', 'Reports & Analytics', 'Settings (personal account)',
      'Google Calendar connection (Admin Settings)'
    ]);
    for (const row of Object.values(matrix)) {
      for (const key of ROLES) expect(['full', 'scoped', 'none']).toContain(row[key].level);
      expect(row.note.length).toBeGreaterThan(20);
    }
  });

  test('CIRL Staff sees exactly the same matrix as Administrator', async () => {
    expect(parseMatrix((await agents.staff.get('/staff/users')).text)).toEqual(matrix);
  });

  test('uses the visible role names and never the old "Department/Colleges" or bare internal "Auth. Personnel"', async () => {
    const html = (await agents.admin.get('/users')).text;
    const section = html.slice(html.indexOf('Role Permissions Matrix (RBAC)'), html.indexOf('</table>', html.indexOf('Role Permissions Matrix (RBAC)')));
    expect(section).toContain('College Dean');
    expect(section).toContain('CIRL Staff');
    expect(section).not.toMatch(/Department\/Colleges|Auth\. Personnel/);
  });

  test('the specific wording for the changes since the last audit', () => {
    expect(matrix['Calendar'].staff).toEqual({ level: 'full', text: 'Full' });
    expect(matrix['Calendar'].college.text).toBe('View Only');
    expect(matrix['Meetings (invitations & attendance)'].partner.text).toBe('Join When Invited');
    expect(matrix['Dashboard'].college.level).toBe('none');
    expect(matrix['Dashboard'].partner.level).toBe('none');
    expect(matrix['Document Library'].college.level).toBe('none');
    expect(matrix['Document Library'].partner.level).toBe('none');
    expect(matrix['Notifications'].college.text).toBe('Personal Only');   // bell + its own Notifications page (reopened 2026-09-26)
    expect(matrix['Notifications'].partner.text).toBe('Personal Only');
    expect(matrix['Document Requests'].partner.text).toBe('Submit MOA/MOU Only');
    expect(matrix['User Management'].staff.text).toBe('Full (except Administrator accounts)');
    expect(matrix['Reports & Analytics'].staff.text).toBe('Full, Personal Audit Trail Only');
    expect(matrix['Google Calendar connection (Admin Settings)'].staff.level).toBe('none');
  });
});

describe('every row agrees with what the routes really do', () => {
  const expectAccess = (feature, probe) => async () => {
    for (const key of ROLES) {
      const allowed = await probe(key);
      const cell = matrix[feature][key];
      expect({ feature, role: key, allowed }).toEqual({ feature, role: key, allowed: cell.level !== 'none' });
    }
  };

  test('Dashboard', expectAccess('Dashboard', (k) => pageOpens(k, { admin: '/dashboard', college: '/personnel/dashboard', partner: '/partner/dashboard', staff: '/staff/dashboard' })));
  test('Monitoring', expectAccess('Monitoring', (k) => pageOpens(k, { admin: '/lifecycle', college: '/personnel/monitoring', partner: '/partner/monitoring', staff: '/staff/lifecycle' })));
  test('Document Library (page)', expectAccess('Document Library', (k) => pageOpens(k, { admin: '/documents', college: '/personnel/documents', partner: '/partner/documents', staff: '/staff/documents' })));
  test('User Management (page)', expectAccess('User Management', (k) => pageOpens(k, { admin: '/users', college: '/users', partner: '/users', staff: '/staff/users' })));
  test('Reports & Analytics (page)', expectAccess('Reports & Analytics', (k) => pageOpens(k, { admin: '/reports', college: '/reports', partner: '/reports', staff: '/staff/reports' })));
  test('Settings (personal account)', expectAccess('Settings (personal account)', (k) => pageOpens(k, { admin: '/admin/settings', college: '/personnel/settings', partner: '/partner/settings', staff: '/staff/settings' })));
  test('Google Calendar connection', expectAccess('Google Calendar connection (Admin Settings)', async (k) => (await agents[k].get('/api/google-calendar/status')).status === 200));
  test('Registry (add/edit/delete partnerships)', expectAccess('Registry (inside Monitoring)', async (k) => (await agents[k].patch('/api/partnerships/99999999').send({ notes: 'jesttest' })).status !== 302));

  test('Partnership Requests: reviewers and the Partner have a page; the review action is reviewer-only', async () => {
    expect(await pageOpens('admin', { admin: '/partnership-requests' })).toBe(true);
    expect(await pageOpens('staff', { staff: '/staff/requests' })).toBe(true);
    expect(await pageOpens('partner', { partner: '/partner/requests' })).toBe(true);
    const review = async (k) => (await agents[k].patch('/api/requests/99999999').send({ status: 'Approved' })).status !== 302;
    expect(await review('admin')).toBe(matrix['Partnership Requests'].admin.level === 'full');
    expect(await review('staff')).toBe(matrix['Partnership Requests'].staff.level === 'full');
    expect(await review('college')).toBe(false);
    expect(await review('partner')).toBe(false);
    expect(matrix['Partnership Requests'].partner.text).toBe('Submit Only');
    expect(matrix['Partnership Requests'].college.level).toBe('none');
  });

  test('Document Requests: College Dean and Partner can submit but not review; reviewers can review', async () => {
    const review = async (k) => (await agents[k].patch('/api/document-requests/99999999').send({ status: 'Preparing' })).status !== 302;
    const submit = async (k) => (await agents[k].post('/api/document-requests').send({})).status !== 302;   // 400 (no fields) still means the role reached the handler
    for (const k of ['admin', 'staff']) expect({ k, review: await review(k), full: matrix['Document Requests'][k].level === 'full' }).toEqual({ k, review: true, full: true });
    for (const k of ['college', 'partner']) expect({ k, review: await review(k), submit: await submit(k), level: matrix['Document Requests'][k].level }).toEqual({ k, review: false, submit: true, level: 'scoped' });
  });

  test('Calendar: manage = Full, everyone else views; and the calendar page opens for all four', async () => {
    for (const k of ROLES) expect(await pageOpens(k, { admin: '/calendar', college: '/personnel/calendar', partner: '/partner/calendar', staff: '/staff/calendar' })).toBe(true);
    for (const k of ROLES) {
      const res = await agents[k].post('/api/calendarevents').send({ title: 'jesttest matrix probe', start: '2026-12-01T09:00', allDay: false, className: 'bg-warning-subtle', recipients: [] });
      if (res.status === 200) createdEventIds.push(res.body.event.id);
      expect({ k, canManage: res.status === 200, full: matrix['Calendar'][k].level === 'full' }).toEqual({ k, canManage: matrix['Calendar'][k].level === 'full', full: matrix['Calendar'][k].level === 'full' });
    }
  });

  test('Meetings: only reviewers read attendance; any invited user (and only they) can join', async () => {
    for (const k of ROLES) {
      const readsAttendance = (await agents[k].get('/api/calendarevents/99999999/attendance')).status !== 302;
      expect({ k, readsAttendance }).toEqual({ k, readsAttendance: matrix['Meetings (invitations & attendance)'][k].level === 'full' });
    }
    // join is open to a signed-in user but the server refuses anyone who is not invited (404 = no such meeting)
    for (const k of ['college', 'partner']) expect([403, 404]).toContain((await agents[k].post('/api/calendarevents/99999999/join')).status);
  });

  test('Notifications: every role has its own bell feed; the Notifications PAGE is closed to Partner only (College Dean\'s reopened 2026-09-26)', async () => {
    for (const k of ROLES) expect((await agents[k].get('/api/notifications/unread-count')).status).toBe(200);
    expect(await pageOpens('admin', { admin: '/notifications' })).toBe(true);
    expect(await pageOpens('staff', { staff: '/staff/notifications' })).toBe(true);
    expect(await pageOpens('college', { college: '/personnel/notifications' })).toBe(true);
    expect(await pageOpens('partner', { partner: '/partner/notifications' })).toBe(false);
    expect(matrix['Notifications'].college.text).toMatch(/Personal Only/);
    expect(matrix['Notifications'].partner.text).toMatch(/Bell/);
  });
});
