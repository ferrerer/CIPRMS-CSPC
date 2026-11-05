// Demo/sample data seeder (2026-11, Final Oral Defense panel feedback: "add more data — different
// scenarios/cases"). Populates a LOCAL TEST DATABASE ONLY with realistic, clearly-fictional sample
// Partnerships, Partnership Requests, and Document Library records spanning different statuses,
// categories, and boundary-date scenarios — so a live walkthrough has enough variety to show every
// state (Active / Expiring Soon / Expired, International / Local, MOA / MOU, multi-unit, etc.) instead
// of a handful of similar-looking records.
//
// SAFETY: this script reuses the exact same hard guard test/setup-env.js relies on
// (services/testDatabaseGuard.js) — it refuses to run at all against anything other than a local,
// explicitly "_test"-suffixed MongoDB database. It is physically incapable of writing to production.
//
// Usage:
//   node scripts/seed-demo-data.js            — insert the demo dataset (safe to run more than once;
//                                                it does not insert if the demo set already exists)
//   node scripts/seed-demo-data.js --cleanup   — remove every record this script ever inserted
//
// Every record is tagged with DEMO_TAG in its institution/title, exactly like this app's own Jest
// fixtures use a "jesttest"/"zztest-" prefix — so it is always visually distinguishable from real
// institutional data and always findable/removable by that one marker, never mixed into real records.

process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { resolveTestDatabaseUri } = require('../services/testDatabaseGuard');
process.env.MONGO_URI = resolveTestDatabaseUri(process.env);

const fs = require('fs');
const path = require('path');
const PDFDocument = require('pdfkit');
const { connectDB, closeDB, insertManyWithNextId } = require('../db');

const DEMO_TAG = 'DEMO —';
const DEMO_DOCS_DIR = path.join(__dirname, '..', 'uploads', 'documents');

function daysFromNow(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

function fmtDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

// ── Partnerships — the main scenario set: every status/boundary/category/unit combination the panel's
// "different scenarios/cases" feedback would want a live demo to show. ──
function partnershipScenarios() {
  const farFutureStart = daysFromNow(-900);
  return [
    { inst: `${DEMO_TAG} Far East Polytechnic University`, country: 'Japan', region: 'Asia', type: 'MOA', nature: ['Academic Exchange'], cat: 'International', unit: ['CIRL'], coordinator: 'Dr. Ana Reyes', start: farFutureStart, end: daysFromNow(900), status: 'Active', remarks: 'Long-standing exchange partnership, well into its term.' },
    { inst: `${DEMO_TAG} Metro Manila Tech Institute`, country: 'Philippines', region: 'Asia', type: 'MOU', nature: ['Research Collaboration', 'Faculty Development'], cat: 'Local', unit: ['CCS', 'CETE'], coordinator: 'Engr. Paolo Santos', start: daysFromNow(-30), end: daysFromNow(730), status: 'Active', remarks: 'Recently signed; multi-unit collaboration.' },
    { inst: `${DEMO_TAG} Riverside College of Arts`, country: 'Philippines', region: 'Asia', type: 'MOA', nature: ['Student Internship'], cat: 'Local', unit: ['CILS'], coordinator: 'Prof. Liza Cruz', start: daysFromNow(-1000), end: daysFromNow(90), status: 'Expiring Soon', remarks: 'Exactly 90 days from renewal deadline — boundary case.' },
    { inst: `${DEMO_TAG} Golden Valley University`, country: 'South Korea', region: 'Asia', type: 'MOU', nature: ['Academic Exchange'], cat: 'International', unit: ['CIRL'], coordinator: 'Dr. Minji Park', start: daysFromNow(-700), end: daysFromNow(30), status: 'Expiring Soon', remarks: 'Exactly 30 days left — the "critical soon" boundary.' },
    { inst: `${DEMO_TAG} Coastal State College`, country: 'Philippines', region: 'Asia', type: 'MOA', nature: ['Community Extension'], cat: 'Local', unit: ['CNAS'], coordinator: 'Dr. Ramon Dela Cruz', start: daysFromNow(-365), end: daysFromNow(1), status: 'Expiring Soon', remarks: 'One day left — extreme edge of the expiring-soon window.' },
    { inst: `${DEMO_TAG} Oakridge International School`, country: 'Australia', region: 'Oceania', type: 'MOU', nature: ['Academic Exchange'], cat: 'International', unit: ['CAMS'], coordinator: 'Ms. Grace Tan', start: daysFromNow(-800), end: daysFromNow(-1), status: 'Expired', remarks: 'Expired yesterday — boundary case just past the line.' },
    { inst: `${DEMO_TAG} Northfield Business Academy`, country: 'Philippines', region: 'Asia', type: 'MOA', nature: ['Industry Linkage'], cat: 'Local', unit: ['CCS'], coordinator: 'Mr. Danilo Ramos', start: daysFromNow(-2200), end: daysFromNow(-800), status: 'Expired', remarks: 'Long expired — no renewal requested.' },
    { inst: `${DEMO_TAG} Sunrise Agricultural Institute`, country: 'Vietnam', region: 'Asia', type: 'MOA', nature: ['Research Collaboration'], cat: 'International', unit: ['CNAS'], coordinator: 'Dr. Linh Nguyen', start: daysFromNow(-200), end: daysFromNow(500), status: 'Active', remarks: '' },
    { inst: `${DEMO_TAG} Westbridge Maritime College`, country: 'Philippines', region: 'Asia', type: 'MOU', nature: ['Student Internship'], cat: 'Local', unit: ['CILS'], coordinator: '', start: daysFromNow(-60), end: daysFromNow(400), status: 'Active', remarks: '' }, // minimal/empty-field scenario
    { inst: `${DEMO_TAG} Highland Normal University`, country: 'Philippines', region: 'Asia', type: 'MOA', nature: ['Faculty Development', 'Research Collaboration'], cat: 'Local', unit: ['CETE', 'CIRL'], coordinator: 'Dr. Josefina Mendoza', start: daysFromNow(-500), end: daysFromNow(1200), status: 'Active', remarks: 'Two responsible units, two nature tags — multi-select demo case.' },
  ];
}

// ── Partnership Requests — every status the review queue can show. ──
function requestScenarios() {
  return [
    { institution: `${DEMO_TAG} Lakeside College of Education`, country: 'Philippines', type: 'MOU', nature: 'Academic Exchange', category: 'Local', region: 'Asia', unit: 'CETE', startDate: daysFromNow(30), endDate: daysFromNow(760), notes: 'Awaiting initial review.', status: 'Pending' },
    { institution: `${DEMO_TAG} Pacific Rim Institute of Technology`, country: 'Malaysia', type: 'MOA', nature: 'Research Collaboration', category: 'International', region: 'Asia', unit: 'CIRL', startDate: daysFromNow(14), endDate: daysFromNow(745), notes: 'Approved after panel-noted documentation review.', status: 'Approved' },
    { institution: `${DEMO_TAG} Everdale Community College`, country: 'Philippines', type: 'MOU', nature: 'Community Extension', category: 'Local', region: 'Asia', unit: 'CNAS', startDate: daysFromNow(7), endDate: daysFromNow(372), notes: 'Rejected — incomplete supporting documents.', status: 'Rejected' },
    { institution: `${DEMO_TAG} Ironwood Institute of Design`, country: 'Philippines', type: 'MOA', nature: 'Student Internship', category: 'Local', region: 'Asia', unit: 'CCS', startDate: '', endDate: '', notes: 'Still being drafted — empty-date scenario.', status: 'Draft' },
  ];
}

async function seed() {
  const db = await connectDB();

  const existing = await db.collection('partnerships').countDocuments({ inst: { $regex: '^' + DEMO_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') } });
  if (existing > 0) {
    console.log(`Demo data already present (${existing} partnership record(s) tagged "${DEMO_TAG}"). Nothing inserted. Run with --cleanup first to reset.`);
    await closeDB();
    return;
  }

  const partnerships = await insertManyWithNextId(db.collection('partnerships'), partnershipScenarios().length, (nextId, i) => {
    const s = partnershipScenarios()[i];
    return {
      id: nextId, ...s,
      startYear: new Date(s.start).getFullYear(),
      endYear: new Date(s.end).getFullYear(),
      date: fmtDate(s.start)
    };
  });
  console.log(`Inserted ${partnerships.length} demo partnerships (statuses: ${[...new Set(partnerships.map(p => p.status))].join(', ')}).`);

  const requests = await insertManyWithNextId(db.collection('requests'), requestScenarios().length, (nextId, i) => {
    const r = requestScenarios()[i];
    return {
      id: nextId, ...r,
      attachmentLink: '',
      requestedBy: `${DEMO_TAG} Demo Submitter`,
      submittedByEmail: 'demo-seed@example.invalid',
      date: fmtDate(new Date().toISOString()),
      updatedAt: new Date().toISOString()
    };
  });
  console.log(`Inserted ${requests.length} demo partnership requests (statuses: ${[...new Set(requests.map(r => r.status))].join(', ')}).`);

  // Document Library — each gets a real tiny placeholder PDF on disk so Preview/Download actually works
  // in a live demo instead of 404ing, and gets cleaned up by --cleanup below.
  if (!fs.existsSync(DEMO_DOCS_DIR)) fs.mkdirSync(DEMO_DOCS_DIR, { recursive: true });
  const docScenarios = [
    { title: `${DEMO_TAG} MOA — Far East Polytechnic University`, type: 'MOA', institution: 'Far East Polytechnic University', partner: 'Far East Polytechnic University', status: 'Active' },
    { title: `${DEMO_TAG} MOU — Metro Manila Tech Institute`, type: 'MOU', institution: 'Metro Manila Tech Institute', partner: 'Metro Manila Tech Institute', status: 'Active' },
    { title: `${DEMO_TAG} Accreditation — AACCUP Level III`, type: 'Accreditation', institution: 'Camarines Sur Polytechnic Colleges', partner: 'Camarines Sur Polytechnic Colleges', status: 'Needs Review' }
  ];
  const documentFiles = [];
  const documents = await insertManyWithNextId(db.collection('documents'), docScenarios.length, (nextId, i) => {
    const d = docScenarios[i];
    const filename = `demo-${nextId}-${Date.now()}.pdf`;
    documentFiles.push(filename);
    return {
      id: nextId, title: d.title, type: d.type, institution: d.institution, partner: d.partner,
      validity: `${fmtDate(daysFromNow(-30))} – ${fmtDate(daysFromNow(700))}`,
      date: fmtDate(new Date().toISOString()), status: d.status,
      fileLink: `/uploads/documents/${filename}`, driveFileId: null,
      tags: [d.type, 'Demo Data'], uploadedBy: `${DEMO_TAG} Demo Uploader`, uploadedByEmail: 'demo-seed@example.invalid',
      uploadedAt: new Date().toISOString(), originalFilename: `${d.title}.pdf`
    };
  });
  for (let i = 0; i < documents.length; i++) {
    await new Promise((resolve, reject) => {
      const doc = new PDFDocument();
      const out = fs.createWriteStream(path.join(DEMO_DOCS_DIR, documentFiles[i]));
      doc.pipe(out);
      doc.fontSize(18).text(docScenarios[i].title, { align: 'center' }).moveDown();
      doc.fontSize(12).text('This is a placeholder PDF generated by scripts/seed-demo-data.js for demonstration purposes only. It does not represent a real institutional document.');
      doc.end();
      out.on('finish', resolve);
      out.on('error', reject);
    });
  }
  console.log(`Inserted ${documents.length} demo Document Library records with real placeholder PDFs.`);

  console.log(`\nDone. Every record is tagged "${DEMO_TAG}" and lives only in this database (${process.env.MONGO_URI}). Run "node scripts/seed-demo-data.js --cleanup" to remove it all.`);
  await closeDB();
}

async function cleanup() {
  const db = await connectDB();
  const tagRegex = { $regex: DEMO_TAG.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };

  const docs = await db.collection('documents').find({ title: tagRegex }).toArray();
  for (const d of docs) {
    if (d.fileLink && d.fileLink.startsWith('/uploads/documents/')) {
      await fs.promises.unlink(path.join(DEMO_DOCS_DIR, path.basename(d.fileLink))).catch(() => {});
    }
  }
  const docsRemoved = (await db.collection('documents').deleteMany({ title: tagRegex })).deletedCount;
  const partnershipsRemoved = (await db.collection('partnerships').deleteMany({ inst: tagRegex })).deletedCount;
  const requestsRemoved = (await db.collection('requests').deleteMany({ institution: tagRegex })).deletedCount;

  console.log(`Removed ${partnershipsRemoved} demo partnership(s), ${requestsRemoved} demo request(s), ${docsRemoved} demo document(s) and their placeholder files.`);
  await closeDB();
}

const isCleanup = process.argv.includes('--cleanup');
(isCleanup ? cleanup() : seed()).catch((err) => {
  console.error('❌ Demo data script failed:', err);
  process.exitCode = 1;
});
