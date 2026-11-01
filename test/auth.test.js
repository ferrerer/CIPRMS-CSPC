// Covers the thesis's own Black-Box Table 5 "User Authentication Module" and
// "Security Module" rows: Login Validation, Invalid Login Attempt,
// Unauthorized Access Attempt, Role-Based Access Restriction.
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll, uniqueEmail } = require('./helpers');

beforeAll(async () => { await connectDB(); });
afterAll(async () => { await cleanupAll(); await closeDB(); });

// Public self-registration was disabled 2026-09-05 as part of the strict
// allowlist policy, then the entire /signup flow (both routes, the view, and
// its disabled-stub rendering) was removed outright 2026-10 — see
// test/oauth-allowlist.test.js for the full "no auto-provisioning, ever"
// coverage (Google OAuth + /signup together). This describe block only
// re-confirms /signup's removal doesn't vary with input (weak vs. strong
// password both 404 — there is no longer a route to reach at all).
describe('Signup (removed)', () => {
  test('a weak password still cannot create an account — there is no route to submit it to', async () => {
    const email = uniqueEmail('weak');
    const res = await request(app).post('/signup').type('form').send({
      username: 'Weak Pw', email, password: 'weakpass', confirmPassword: 'weakpass'
    });
    expect(res.status).toBe(404);

    const db = await connectDB();
    expect(await db.collection('users').findOne({ email })).toBeNull();
  });

  test('a strong password does not create an account or session either', async () => {
    const email = uniqueEmail('strong');
    const agent = request.agent(app);
    const res = await agent.post('/signup').type('form').send({
      username: 'Strong Pw', email, password: 'StrongPass1', confirmPassword: 'StrongPass1'
    });
    expect(res.status).toBe(404);

    const db = await connectDB();
    expect(await db.collection('users').findOne({ email })).toBeNull();

    const meRes = await agent.get('/api/me');
    expect(meRes.status).toBe(302);
  });
});

describe('Login', () => {
  test('rejects an invalid password with a generic error', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: 'WrongPassword1' });
    // 401 (2026-10-28 brute-force-protection investigation): a real, non-200 status on every failed login is
    // what lets the rate limiter's skipSuccessfulRequests correctly count this as a failure instead of
    // silently treating every login outcome (success or failure) as "successful" — see cirl.js's own comment
    // on this at the top of the /login route.
    expect(res.status).toBe(401);
    expect(res.text).toMatch(/invalid email or password/i);
  });

  test('accepts a valid password and redirects to the role home page', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/staff/dashboard');
  });

  test('redirects Administrator to /dashboard and Auth. Personnel (College Dean) to /personnel/monitoring', async () => {
    const admin = await createTestUser({ role: 'Administrator' });
    const personnel = await createTestUser({ role: 'Auth. Personnel' });

    const adminRes = await request(app).post('/login').type('form').send({ username: admin.email, password: admin.password });
    expect(adminRes.headers.location).toBe('/dashboard');

    const personnelRes = await request(app).post('/login').type('form').send({ username: personnel.email, password: personnel.password });
    expect(personnelRes.headers.location).toBe('/personnel/monitoring');
  });
});

describe('Unauthorized access', () => {
  test('an unauthenticated request to a protected page redirects to login', async () => {
    const res = await request(app).get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/');
  });

  test('a logged-in Staff user is redirected away from an Admin-only page (not a 403 crash)', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    const res = await agent.get('/dashboard');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/staff/dashboard');
  });

  test('a logged-in Auth. Personnel user cannot reach an Admin-only page', async () => {
    const user = await createTestUser({ role: 'Auth. Personnel' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    const res = await agent.get('/registry'); // Administrator-only since 2026-07-23
    expect(res.status).toBe(302); // requireAdmin redirects non-admins to their own dashboard
  });

  // 2026-08-27 full-parity revision: Administrator and Staff share full
  // User Management, Registry, and Requests CRUD. These confirm the
  // boundary is exactly where it should be now — full access granted,
  // EXCEPT the privilege-escalation guard around Administrator accounts.
  test('Staff CAN reach the User Management API (requireStaffAccess)', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    const res = await agent.get('/api/users');
    expect(res.status).toBe(200);
  });

  test('Staff CAN create a non-Administrator user (full parity)', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    const email = uniqueEmail('staffcreated');
    const res = await agent.post('/api/users').send({ name: 'Staff Created Me', email, role: 'Staff', password: 'StrongPass1' });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const db = await connectDB();
    await db.collection('users').deleteOne({ email });
  });

  test('Staff CANNOT create an Administrator account (privilege-escalation guard)', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    const res = await agent.post('/api/users').send({ name: 'Should Not Exist', email: uniqueEmail('staffescalation'), role: 'Administrator', password: 'StrongPass1' });
    expect(res.status).toBe(403);
  });

  test('Staff CANNOT edit an existing Administrator account (privilege-escalation guard)', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
    const targetAdmin = await createTestUser({ role: 'Administrator' });
    const res = await staffAgent.patch(`/api/users/${targetAdmin.id}`).send({ name: 'Renamed By Staff' });
    expect(res.status).toBe(403);
  });

  test('Staff CANNOT grant the Administrator role to another account (privilege-escalation guard)', async () => {
    const staffAgent = request.agent(app);
    await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
    const targetStaff = await createTestUser({ role: 'Staff' });
    const res = await staffAgent.patch(`/api/users/${targetStaff.id}`).send({ role: 'Administrator' });
    expect(res.status).toBe(403);
  });

  test('Staff CAN reach the Registry mutation route (full parity)', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const agent = request.agent(app);
    await loginAs(agent, user);
    const res = await agent.post('/api/partnerships').send({
      inst: 'zztest Staff Registry Parity', country: 'Testland', type: 'MOA',
      unit: 'CCS', start: 'Jan 1, 2026', end: 'Jan 1, 2030'
    });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const db = await connectDB();
    await db.collection('partnerships').deleteOne({ id: res.body.partnership.id });
  });
});

describe('Session security', () => {
  test('session cookie is httpOnly and SameSite=Lax', async () => {
    const user = await createTestUser({ role: 'Staff' });
    const res = await request(app).post('/login').type('form').send({ username: user.email, password: user.password });
    const cookie = res.headers['set-cookie'][0];
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Lax/i);
  });

  // Note: /login rate-limiting (10 attempts / 15 min, see cirl.js's loginLimiter)
  // is intentionally not exercised here — it's a shared, IP-keyed, in-memory
  // limiter, and actually tripping it in this file would 429 every other
  // test file's logins for the rest of the run. Verified manually instead.
});
