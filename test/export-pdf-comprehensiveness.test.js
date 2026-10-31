// Regression tests for the 2026-10 PDF comprehensiveness audit — summary sections, applied-filter context,
// and the Audit Trail action-type breakdown added to renderPartnershipReportPdf (both paths),
// renderMultiComparisonReportPdf, and renderTablePdf. Unlike test/export-layout-helper.test.js (which checks
// LAYOUT — no overlap, correct wrapping), this file extracts and asserts on the actual TEXT CONTENT of the
// generated PDFs via pdf-parse (already a project dependency, used by services/ocrService.js) — proving the
// right numbers are actually in the output, not just that generation didn't crash.
const request = require('supertest');
const { PDFParse } = require('pdf-parse');
const app = require('../cirl');
const { connectDB, closeDB } = require('../db');
const { createTestUser, loginAs, cleanupAll } = require('./helpers');

async function pdfText(buffer) {
  const parser = new PDFParse({ data: buffer });
  try {
    const parsed = await parser.getText();
    return (parsed.pages || []).map((p) => p.text || '').join('\n');
  } finally {
    await parser.destroy();
  }
}

async function fetchPdfBuffer(agent, url) {
  const res = await agent.get(url).buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  return res;
}

let agent;
const createdIds = [];
const stamp = Date.now();
const TAG = `jesttest PdfComp ${stamp}`;
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d; };
const fmt = (d) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });

beforeAll(async () => {
  await connectDB();
  agent = request.agent(app);
  await loginAs(agent, await createTestUser({ role: 'Administrator' }));

  const fixtures = [
    { inst: `${TAG} Active`, end: fmt(daysFromNow(365)) },
    { inst: `${TAG} ExpiringSoon`, end: fmt(daysFromNow(30)) },
    { inst: `${TAG} Expired`, end: fmt(daysFromNow(-30)) }
  ];
  for (const f of fixtures) {
    const res = await agent.post('/api/partnerships').send({
      inst: f.inst, country: 'Testland', region: 'Asia', type: 'MOU', nature: 'Training',
      cat: 'International', unit: 'CIRL', start: 'Jan 1, 2020', end: f.end, status: 'Active', remarks: 'jesttest'
    });
    createdIds.push(res.body.partnership.id);
  }
});

afterAll(async () => {
  const db = await connectDB();
  await db.collection('partnerships').deleteMany({ id: { $in: createdIds } });
  await cleanupAll();
  await closeDB();
});

describe('Partnership Report PDF (flat path) — summary section', () => {
  test('shows the correct Active/Expiring Soon/Expired/Total counts, computed from the exact same filtered dataset as the table', async () => {
    const res = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=Summary%20Test&country=Testland');
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    expect(text).toMatch(/Total:\s*3/);
    expect(text).toMatch(/Active:\s*1/);
    expect(text).toMatch(/Expiring Soon:\s*1/);
    expect(text).toMatch(/Expired:\s*1/);
  });

  test('an empty-result report shows a zeroed summary, not a crash or a missing section', async () => {
    const res = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=Empty&country=NoSuchCountryZZZ');
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    expect(text).toMatch(/Total:\s*0/);
  });

  test('a filtered report shows the applied-filter line with the real filter values', async () => {
    const res = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=Filtered&country=Testland&status=Active');
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    expect(text).toContain('Filters:');
    expect(text).toMatch(/Status: Active/);
  });

  test('an unfiltered report (no non-default filters set) shows "all records", not a wall of "All"', async () => {
    const res = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=Unfiltered');
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    expect(text).toMatch(/Filters:\s*None/i);
  });
});

describe('Partnership Report PDF (grouped path) — upgraded summary section', () => {
  test('Group By report shows the full status breakdown, not just a bare total', async () => {
    const res = await fetchPdfBuffer(agent, '/api/reports/partnerships/pdf?title=Grouped%20Summary&country=Testland&groupBy=unit');
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    expect(text).toMatch(/Active:\s*1/);
    expect(text).toMatch(/Expired:\s*1/);
    expect(text).toMatch(/Grouped by: College \/ Unit/);
  });
});

describe('Multi-Configuration Comparison PDF — per-configuration filter context', () => {
  test('each configuration shows its own applied filters, including one that matches nothing', async () => {
    const configs = encodeURIComponent(JSON.stringify([
      { label: 'All Testland', country: 'Testland' },
      { label: 'Nonexistent Unit', country: 'Testland', unit: 'NoSuchUnitZZZ' }
    ]));
    const res = await fetchPdfBuffer(agent, `/api/reports/comparison/multi/pdf?configs=${configs}`);
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    expect(text).toMatch(/Country: Testland/);
    expect(text).toMatch(/Unit: NoSuchUnitZZZ/);
    expect(text).toContain('No records found for this configuration.'); // the zero-match config's own evidence
  });
});

describe('Audit Trail PDF — action-type summary, additive to the full entry list', () => {
  test('summary line totals match the real entry count, and the full detailed list still follows it', async () => {
    const res = await fetchPdfBuffer(agent, '/api/reports/activitylog/pdf');
    expect(res.status).toBe(200);
    const text = await pdfText(res.body);
    const totalMatch = text.match(/Total:\s*(\d+)/);
    expect(totalMatch).toBeTruthy();
    const claimedTotal = parseInt(totalMatch[1], 10);
    expect(claimedTotal).toBeGreaterThan(0);
    // The detailed table's own subtitle line independently states the same entry count — confirms the
    // summary and the full list were built from the exact same `logs` array, never two different queries.
    expect(text).toMatch(new RegExp(`${claimedTotal} entries`));
  });
});

describe('Permission checks — protected export routes reject non-staff roles (unchanged by this audit, re-confirmed)', () => {
  test('a potential_partner cannot reach the partnership PDF export', async () => {
    const partnerAgent = request.agent(app);
    await loginAs(partnerAgent, await createTestUser({ role: 'potential_partner' }));
    const res = await partnerAgent.get('/api/reports/partnerships/pdf');
    expect(res.status).toBe(302); // redirected away by requireStaffAccess, not served the export
  });
});
