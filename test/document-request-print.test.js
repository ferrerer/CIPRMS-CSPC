// Covers the printable CSPC-F-CIRL-04 "Documents Request Form": the
// contactNumber/documentForm/submittedAt fields on submission, the
// multi-item free-form documentTypes list (2026-09-02 combobox redesign),
// the dynamically-populated Released By/Received By + fixed Approved By
// sign-off on fulfillment, and the RBAC boundary on the
// /document-requests/:id/print and /api/document-requests/:id/pdf routes
// (owner + Administrator/Staff only).
const request = require('supertest');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

let adminAgent, personnelAgent, otherPartnerAgent, staffAgent, requestId, secondRequestId;

beforeAll(async () => {
  await connectDB();
  adminAgent = request.agent(app);
  await loginAs(adminAgent, await createTestUser({ role: 'Administrator' }));
  personnelAgent = request.agent(app);
  await loginAs(personnelAgent, await createTestUser({ role: 'Auth. Personnel', unit: 'CCS' }));
  otherPartnerAgent = request.agent(app);
  await loginAs(otherPartnerAgent, await createTestUser({ role: 'potential_partner' }));
  staffAgent = request.agent(app);
  await loginAs(staffAgent, await createTestUser({ role: 'Staff' }));
});

afterAll(async () => {
  const db = await connectDB();
  if (requestId) await db.collection('documentrequests').deleteOne({ id: requestId });
  if (secondRequestId) await db.collection('documentrequests').deleteOne({ id: secondRequestId });
  await cleanupAll();
  await closeDB();
});

test('Submit Document Request: multi-item documentTypes (predefined + custom) persist as an array', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS',
    documentTypes: ['Universitas Airlangga - MOA', 'MOUs', 'jesttest Custom Document'],
    notes: 'jesttest purpose', contactNumber: '0917-000-0000', documentForm: 'Printed Copy'
  });
  expect(res.status).toBe(200);
  expect(res.body.success).toBe(true);
  expect(res.body.request.contactNumber).toBe('0917-000-0000');
  expect(res.body.request.documentForm).toBe('Printed Copy');
  expect(typeof res.body.request.submittedAt).toBe('string');
  expect(res.body.request.documentTypes).toEqual(['Universitas Airlangga - MOA', 'MOUs', 'jesttest Custom Document']);
  // Backward-compatible joined string kept for existing notification/log/badge call sites.
  expect(res.body.request.documentType).toBe('Universitas Airlangga - MOA, MOUs, jesttest Custom Document');
  requestId = res.body.request.id;
});

test('Submit Document Request: rejects an empty documentTypes list', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentTypes: [], notes: 'jesttest'
  });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/documentTypes/);
});

test('Submit Document Request: legacy singular documentType string still accepted (backward compatibility)', async () => {
  const res = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentType: 'MOA', notes: 'jesttest legacy'
  });
  expect(res.status).toBe(200);
  expect(res.body.request.documentTypes).toEqual(['MOA']);
  await (await connectDB()).collection('documentrequests').deleteOne({ id: res.body.request.id });
});

test('Print/PDF RBAC: the requester (owner) can view and download; document list renders as an itemized list', async () => {
  const printRes = await personnelAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(200);
  expect(printRes.text).toContain('DOCUMENTS REQUEST FORM');
  expect(printRes.text).toContain('0917-000-0000');
  expect(printRes.text).toContain('Universitas Airlangga - MOA');
  expect(printRes.text).toContain('MOUs');
  expect(printRes.text).toContain('jesttest Custom Document');
  // Not yet Fulfilled — the official approval section must stay blank.
  expect(printRes.text).not.toContain('Filmor J. Murillo');

  const pdfRes = await personnelAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(200);
  expect(pdfRes.headers['content-type']).toBe('application/pdf');
  expect(pdfRes.headers['content-disposition']).toContain(`Document_Request_${requestId}.pdf`);
});

test('Print/PDF RBAC: an unrelated potential_partner cannot view or download someone else\'s request', async () => {
  const printRes = await otherPartnerAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(403);

  const pdfRes = await otherPartnerAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(403);
});

test('Print/PDF RBAC: Administrator can view and download any request', async () => {
  const printRes = await adminAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(200);

  const pdfRes = await adminAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(200);
});

// 2026-08-27 full-parity revision: Staff reviews Document Requests exactly
// like Administrator (canAccessDocumentRequest + REQUEST_REVIEWER_ROLES).
test('Print/PDF RBAC: Staff can view and download any request (full parity with Administrator)', async () => {
  const printRes = await staffAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(200);

  const pdfRes = await staffAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(200);
});

test('Print/PDF RBAC: no session redirects instead of leaking the form', async () => {
  const printRes = await request(app).get(`/document-requests/${requestId}/print`);
  expect(printRes.status).toBe(302);

  const pdfRes = await request(app).get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(302);
});

test('Staff can advance a Document Request to Preparing (full parity with Administrator)', async () => {
  const res = await staffAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Preparing', remark: 'jesttest staff review' });
  expect(res.status).toBe(200);
  expect(res.body.request.status).toBe('Preparing');
});

test('Invalid transitions are rejected: no skipping ahead and no moving backward', async () => {
  // Current status is 'Preparing' — skipping straight to 'Approved' must fail.
  const skipRes = await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Approved' });
  expect(skipRes.status).toBe(400);
  expect(skipRes.body.error).toMatch(/Preparing/);

  // Advance one real step, then try to move backward to the previous stage.
  const advanceRes = await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Awaiting for Approval' });
  expect(advanceRes.status).toBe(200);
  const backRes = await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Preparing' });
  expect(backRes.status).toBe(400);
});

test('Advancing to Approved shows the fixed CIRL Head signatory on the printable form', async () => {
  const res = await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Approved' });
  expect(res.status).toBe(200);
  expect(res.body.request.status).toBe('Approved');
  expect(typeof res.body.request.approvedAt).toBe('string');

  const printRes = await personnelAgent.get(`/document-requests/${requestId}/print`);
  expect(printRes.text).toContain('Filmor J. Murillo');
});

test('Advancing to Release: Released By is always the actual actor (never client-supplied)', async () => {
  // A client-supplied releasedBy must be ignored — it is not part of the
  // request body the server reads for that field at all; Released By can
  // only ever be the authenticated actor performing the release.
  const res = await adminAgent.patch(`/api/document-requests/${requestId}`).send({
    status: 'Release', remark: 'jesttest', releasedBy: 'Someone Else Entirely'
  });
  expect(res.status).toBe(200);
  expect(res.body.request.decidedBy).toBe('jesttest Administrator');
  expect(res.body.request.releasedBy).toBe('jesttest Administrator');
  expect(res.body.request.releasedBy).not.toBe('Someone Else Entirely');
  expect(typeof res.body.request.releasedAt).toBe('string');
});

test('Advancing to Completed: Received By honors an explicit override; full sign-off appears on the printed form and PDF', async () => {
  const res = await adminAgent.patch(`/api/document-requests/${requestId}`).send({
    status: 'Completed', remark: 'jesttest', receivedBy: 'jesttest Override Receiver'
  });
  expect(res.status).toBe(200);
  expect(res.body.request.receivedBy).toBe('jesttest Override Receiver');
  expect(typeof res.body.request.receivedAt).toBe('string');

  const printRes = await personnelAgent.get(`/document-requests/${requestId}/print`);
  // Approved By is the fixed institutional signatory, not the processing admin.
  expect(printRes.text).toContain('Filmor J. Murillo');
  expect(printRes.text).not.toContain('Someone Else Entirely');
  expect(printRes.text).toContain('jesttest Administrator');
  expect(printRes.text).toContain('jesttest Override Receiver');

  const pdfRes = await personnelAgent.get(`/api/document-requests/${requestId}/pdf`);
  expect(pdfRes.status).toBe(200);
  expect(pdfRes.headers['content-type']).toBe('application/pdf');
});

test('A Completed request cannot be advanced further', async () => {
  const res = await adminAgent.patch(`/api/document-requests/${requestId}`).send({ status: 'Rejected' });
  expect(res.status).toBe(400);
  expect(res.body.error).toMatch(/already been decided/);
});

test('Full pipeline walk-through: Received By defaults to the requester when not overridden', async () => {
  const submitRes = await personnelAgent.post('/api/document-requests').send({
    institution: 'CCS', documentTypes: ['jesttest Second Document'], notes: 'jesttest second'
  });
  expect(submitRes.status).toBe(200);
  expect(submitRes.body.request.status).toBe('Received');
  secondRequestId = submitRes.body.request.id;

  for (const status of ['Preparing', 'Awaiting for Approval', 'Approved', 'Release', 'Completed']) {
    const res = await staffAgent.patch(`/api/document-requests/${secondRequestId}`).send({ status, remark: 'jesttest' });
    expect(res.status).toBe(200);
    expect(res.body.request.status).toBe(status);
  }

  const finalRes = await staffAgent.patch(`/api/document-requests/${secondRequestId}`).send({ status: 'Completed' });
  expect(finalRes.status).toBe(400); // already Completed
  const db = await connectDB();
  const finalDoc = await db.collection('documentrequests').findOne({ id: secondRequestId });
  expect(finalDoc.releasedBy).toBe('jesttest Staff');
  expect(finalDoc.receivedBy).toBe('jesttest Auth. Personnel');
  expect(finalDoc.statusHistory.length).toBe(5);
  expect(finalDoc.statusHistory.every(h => h.by === 'jesttest Staff')).toBe(true);
});
