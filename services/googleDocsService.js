// Google Docs integration (2026-09-26) — MOA/MOU agreement drafts written in Google Docs, linked to a Partnership
// Request. Same architecture as services/googleCalendarService.js: ONE org-wide Google account, connected once by an
// Administrator in Settings → Integrations, owns every draft (they live in a "CIPRMS Agreement Drafts" folder in its
// Drive, so they stay with the office when people leave). CIPRMS shares each draft by e-mail with the people on the
// request; Google itself enforces who can open/edit/comment.
//
// Its own connection, separate from Google Calendar's: a different scope, and connecting or disconnecting one never
// affects the other. Scope is drive.file — CIPRMS can only see and change the files it created itself, never
// anything else in the connected account's Drive.
const { google } = require('googleapis');
const { Readable } = require('stream');
const { encrypt, decrypt } = require('./tokenCrypto');
const { redact } = require('./googleCalendarService');

const SCOPES = ['https://www.googleapis.com/auth/drive.file'];
const FOLDER_NAME = 'CIPRMS Agreement Drafts';
const DOC_MIME = 'application/vnd.google-apps.document';
const FOLDER_MIME = 'application/vnd.google-apps.folder';

// 2026-11 Phase 2: every outbound call this service makes (getToken, and every drive.files.*/permissions.*
// call below) goes through this one client's transporter, so a single `transporterOptions.timeout` here
// bounds all of them — a stalled/unreachable Google Drive now fails after this long instead of leaving the
// Express request hanging indefinitely. Same fix and same constant as services/googleCalendarService.js.
const GOOGLE_API_TIMEOUT_MS = 15000;

// Collection names are overridable ONLY so the test suite never touches the real connection (see test/setup-env.js
// and the same guard in googleCalendarService.js).
const REAL_INTEGRATION_COLLECTION = 'googleDocsIntegration';
function integrationCollection(db) {
  const name = process.env.GOOGLE_DOCS_INTEGRATION_COLLECTION || REAL_INTEGRATION_COLLECTION;
  if (process.env.JEST_WORKER_ID && name === REAL_INTEGRATION_COLLECTION) {
    throw new Error('Refusing to use the real googleDocsIntegration collection from a test run — set GOOGLE_DOCS_INTEGRATION_COLLECTION (see test/setup-env.js).');
  }
  return db.collection(name);
}

// Linked drafts: { id, requestId, kind, title, fileId, url, createdByEmail, createdByName, createdAt, sharing[] }
function docsCollection(db) {
  return db.collection('googleDocs');
}

function describeGoogleError(err) {
  const raw = redact((err && err.message) || err || 'Unknown error');
  if (/Unsupported state|unable to authenticate data|Malformed encrypted payload|Invalid authentication tag/i.test(raw)) {
    return 'The stored Google authorization cannot be decrypted with this server\'s GOOGLE_TOKEN_ENCRYPTION_KEY (it was connected with a different key). Reconnect Google Docs.';
  }
  if (/invalid_grant/i.test(raw)) {
    return 'Google no longer accepts the stored authorization (revoked, or expired — apps in "Testing" mode only keep tokens for 7 days). Disconnect and reconnect Google Docs.';
  }
  if (/accessNotConfigured|has not been used in project|API has not been enabled|Drive API.*(disabled|not enabled)/i.test(raw)) {
    return 'The Google Drive API is not enabled for the Google Cloud project behind this OAuth client. Enable "Google Drive API" under APIs & Services, then try again.';
  }
  if (/redirect_uri_mismatch/i.test(raw)) {
    return 'Google rejected the redirect URI. Add the exact redirect URI shown on this page to the OAuth client\'s "Authorized redirect URIs" in Google Cloud.';
  }
  if (/invalid_client|unauthorized_client/i.test(raw)) {
    return 'Google rejected the OAuth client ID/secret configured for CIPRMS (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET).';
  }
  if (/insufficient.*(scope|permission)/i.test(raw)) {
    return 'Google Drive permission was not granted. Disconnect, reconnect, and allow the Drive access request.';
  }
  // The GOOGLE_API_TIMEOUT_MS bound above (gaxios, via AbortSignal.timeout) surfaces as a DOMException named
  // "TimeoutError" with a message like "This operation was aborted due to timeout" — never anything an
  // Administrator could act on, so it gets the same "try again" framing as any other transient failure.
  if (/timeout|aborted due to timeout|TimeoutError/i.test(raw)) {
    return 'Google Docs did not respond in time. Please try again.';
  }
  return raw;
}

function buildOAuthClient(redirectUri) {
  return new google.auth.OAuth2({
    clientId: process.env.GOOGLE_CLIENT_ID,
    clientSecret: process.env.GOOGLE_CLIENT_SECRET,
    redirectUri,
    transporterOptions: { timeout: GOOGLE_API_TIMEOUT_MS }
  });
}

function getAuthUrl(redirectUri, state) {
  return buildOAuthClient(redirectUri).generateAuthUrl({
    access_type: 'offline', // required to receive a refresh_token
    prompt: 'consent',      // so a refresh_token is issued even on reconnect
    scope: SCOPES,
    state
  });
}

async function getIntegration(db) {
  return integrationCollection(db).findOne({});
}

async function handleOAuthCallback(db, code, redirectUri, connectedBy) {
  const { tokens } = await buildOAuthClient(redirectUri).getToken(code);
  if (!tokens.refresh_token) {
    throw new Error('Google did not return a refresh token — remove CIPRMS from your Google Account → Security → Third-party access, then reconnect.');
  }
  // Insert the new connection first, then remove any older one, so a failure part-way never leaves none at all.
  const inserted = await integrationCollection(db).insertOne({
    connectedByEmail: connectedBy.email,
    connectedByName: connectedBy.name,
    encryptedRefreshToken: encrypt(tokens.refresh_token),
    connectedAt: new Date().toISOString()
  });
  await integrationCollection(db).deleteMany({ _id: { $ne: inserted.insertedId } });
  return { verification: await verifyConnection(db) };
}

async function getAuthorizedDrive(db) {
  const doc = await getIntegration(db);
  if (!doc) return null;
  const client = buildOAuthClient();
  client.setCredentials({ refresh_token: decrypt(doc.encryptedRefreshToken) });
  client.on('tokens', (tokens) => {
    if (tokens.refresh_token) {
      integrationCollection(db)
        .updateOne({ _id: doc._id }, { $set: { encryptedRefreshToken: encrypt(tokens.refresh_token) } })
        .catch(err => console.error('Google Docs: failed to persist rotated refresh token:', describeGoogleError(err)));
    }
  });
  return { drive: google.drive({ version: 'v3', auth: client }), integration: doc };
}

async function recordResult(db, ok, error) {
  try {
    await integrationCollection(db).updateOne({}, {
      $set: { lastSyncOk: ok, lastSyncAt: new Date().toISOString(), lastSyncError: ok ? null : (error || 'Unknown error') }
    });
  } catch (err) {
    console.error('Google Docs: failed to record result:', describeGoogleError(err));
  }
}

// Read-only check of the whole chain (stored refresh token → access token → Drive API); also learns which Google
// account is connected, so Settings can show where the drafts live.
async function verifyConnection(db) {
  let authorized;
  try {
    authorized = await getAuthorizedDrive(db);
  } catch (err) {
    const message = describeGoogleError(err);
    await recordResult(db, false, message);
    return { ok: false, error: message };
  }
  if (!authorized) return { ok: false, error: 'not_connected' };
  try {
    const about = await authorized.drive.about.get({ fields: 'user(emailAddress,displayName)' });
    const accountEmail = about.data && about.data.user && about.data.user.emailAddress
      ? about.data.user.emailAddress.toLowerCase() : null;
    await integrationCollection(db).updateOne({}, {
      $set: { verifiedAt: new Date().toISOString(), ...(accountEmail ? { googleAccountEmail: accountEmail } : {}) }
    });
    await recordResult(db, true, null);
    return { ok: true, accountEmail };
  } catch (err) {
    const message = describeGoogleError(err);
    console.error('Google Docs: connection check failed:', message);
    await recordResult(db, false, message);
    return { ok: false, error: message };
  }
}

async function disconnect(db) {
  const doc = await getIntegration(db);
  if (doc) {
    try {
      await buildOAuthClient().revokeToken(decrypt(doc.encryptedRefreshToken));
    } catch (err) {
      console.error('Google Docs: revoke during disconnect failed (continuing):', describeGoogleError(err));
    }
  }
  await integrationCollection(db).deleteMany({});
}

// The "CIPRMS Agreement Drafts" folder, created on first use. Recreated if it was deleted in Drive.
async function ensureFolder(db, drive, integration) {
  if (integration.folderId) {
    try {
      const f = await drive.files.get({ fileId: integration.folderId, fields: 'id,trashed' });
      if (f.data && !f.data.trashed) return integration.folderId;
    } catch (err) { /* gone — create a new one below */ }
  }
  const created = await drive.files.create({ requestBody: { name: FOLDER_NAME, mimeType: FOLDER_MIME }, fields: 'id' });
  await integrationCollection(db).updateOne({ _id: integration._id }, { $set: { folderId: created.data.id } });
  return created.data.id;
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Starting content of a draft, filled from the Partnership Request. Google converts this HTML into a normal,
// editable Google Doc. Bracketed text is for the drafters to replace.
function buildAgreementHtml(request, kind) {
  const isMoa = kind === 'MOA';
  const title = isMoa ? 'MEMORANDUM OF AGREEMENT' : 'MEMORANDUM OF UNDERSTANDING';
  const inst = esc(request.institution || '[Partner Institution]');
  const country = esc(request.country || '[Country]');
  const units = Array.isArray(request.unit) ? request.unit.join(', ') : request.unit;
  const row = (label, value) => `<tr><td style="padding:4px 10px;border:1px solid #999;"><b>${esc(label)}</b></td><td style="padding:4px 10px;border:1px solid #999;">${esc(value || '—')}</td></tr>`;
  return `<html><body style="font-family:Arial;font-size:11pt;">
<p style="text-align:center;"><b>${title}</b></p>
<p style="text-align:center;">between<br><b>CAMARINES SUR POLYTECHNIC COLLEGES</b><br>and<br><b>${inst}</b> (${country})</p>
<p style="color:#666;"><i>Draft prepared in CIPRMS for Partnership Request #REQ-${esc(String(request.id).padStart(3, '0'))}. Replace every [bracketed] item before signing.</i></p>
<table style="border-collapse:collapse;">
${row('Partner Institution', request.institution)}
${row('Country', request.country)}
${row('Agreement Type', kind)}
${row('Nature of Partnership', request.nature)}
${row('Category', request.category)}
${row('Responsible CSPC Unit', units)}
${row('Proposed Start Date', request.startDate)}
${row('Proposed End Date', request.endDate)}
</table>
<p><b>KNOW ALL MEN BY THESE PRESENTS:</b></p>
<p>This ${isMoa ? 'Memorandum of Agreement' : 'Memorandum of Understanding'} is entered into by and between:</p>
<p><b>CAMARINES SUR POLYTECHNIC COLLEGES (CSPC)</b>, a state college with principal office at Nabua, Camarines Sur, Philippines, represented by its [President / authorized representative], hereinafter referred to as the <b>"FIRST PARTY"</b>;</p>
<p>— and —</p>
<p><b>${inst}</b>, with principal office at [address], ${country}, represented by [name and designation], hereinafter referred to as the <b>"SECOND PARTY"</b>.</p>
<p><b>WITNESSETH:</b></p>
<p>WHEREAS, [background and shared goals of both parties];</p>
<p><b>ARTICLE I — PURPOSE</b></p>
<p>[Purpose of the partnership: ${esc(request.nature || 'nature of partnership')}.]</p>
<p><b>ARTICLE II — SCOPE OF COOPERATION</b></p>
<p>[Activities covered, e.g. research, student/faculty exchange, training.]</p>
<p><b>ARTICLE III — RESPONSIBILITIES OF THE PARTIES</b></p>
<p>[Obligations of the FIRST PARTY.]</p>
<p>[Obligations of the SECOND PARTY.]</p>
<p><b>ARTICLE IV — ${isMoa ? 'FINANCIAL ARRANGEMENTS' : 'NON-BINDING NATURE'}</b></p>
<p>${isMoa ? '[Funding, cost-sharing and resources.]' : 'This Memorandum expresses the intent of the parties to cooperate and does not create legally binding financial obligations.'}</p>
<p><b>ARTICLE V — EFFECTIVITY AND TERM</b></p>
<p>This ${kind} takes effect on ${esc(request.startDate || '[start date]')} and remains in force until ${esc(request.endDate || '[end date]')}, unless terminated earlier by either party with [30] days' written notice.</p>
<p><b>ARTICLE VI — AMENDMENTS</b></p>
<p>Any amendment shall be in writing and signed by both parties.</p>
<p>IN WITNESS WHEREOF, the parties have signed this ${kind} on [date] at [place].</p>
<table style="width:100%;"><tr>
<td style="width:50%;vertical-align:top;"><b>CAMARINES SUR POLYTECHNIC COLLEGES</b><br><br><br>______________________________<br>[Name]<br>[Designation]</td>
<td style="width:50%;vertical-align:top;"><b>${inst}</b><br><br><br>______________________________<br>[Name]<br>[Designation]</td>
</tr></table>
</body></html>`;
}

// Shares a file with one person. Returns { email, role, ok, error? }. Google sends its own invitation e-mail with
// the link (required anyway for addresses that have no Google account).
async function shareWith(drive, fileId, email, role, message) {
  try {
    await drive.permissions.create({
      fileId,
      sendNotificationEmail: true,
      emailMessage: message,
      requestBody: { type: 'user', role, emailAddress: email }
    });
    return { email, role, ok: true };
  } catch (err) {
    return { email, role, ok: false, error: describeGoogleError(err) };
  }
}

// Creates the draft in the connected account's Drive, shares it with everyone in `recipients`
// ([{ email, role: 'writer'|'commenter'|'reader' }]) and returns the Drive file. Throws a readable Error on failure.
async function createAgreementDoc(db, request, kind, recipients) {
  // 2026-11 error-leakage fix: getAuthorizedDrive() (specifically its decrypt() of the stored refresh
  // token) is now INSIDE this same try/catch too — it used to run before the try started, so a bad
  // GOOGLE_TOKEN_ENCRYPTION_KEY threw a raw crypto-library error straight past describeGoogleError()
  // and out to the client via the route's `res.status(422).json({ error: err.message })`.
  const title = `${kind} Draft — ${request.institution || 'Partner'} (#REQ-${String(request.id).padStart(3, '0')})`;
  let file, drive;
  try {
    const authorized = await getAuthorizedDrive(db);
    if (!authorized) throw new Error('Google Docs is not connected. An Administrator can connect it in Settings → Integrations.');
    drive = authorized.drive;
    const folderId = await ensureFolder(db, drive, authorized.integration);
    const created = await drive.files.create({
      requestBody: { name: title, mimeType: DOC_MIME, parents: [folderId] },
      media: { mimeType: 'text/html', body: Readable.from([buildAgreementHtml(request, kind)]) },
      fields: 'id,name,webViewLink'
    });
    file = created.data;
  } catch (err) {
    const message = describeGoogleError(err);
    await recordResult(db, false, message);
    throw new Error(message);
  }
  await recordResult(db, true, null);
  const message = `CIPRMS shared this ${kind} draft for Partnership Request #REQ-${String(request.id).padStart(3, '0')} (${request.institution || 'partner'}).`;
  const sharing = [];
  for (const r of recipients) sharing.push(await shareWith(drive, file.id, r.email, r.role, message));
  return { fileId: file.id, title: file.name || title, url: file.webViewLink || `https://docs.google.com/document/d/${file.id}/edit`, sharing };
}

// Re-applies sharing to an existing draft (e.g. after new staff joined). Google ignores a share that already exists.
async function reshareDoc(db, fileId, recipients, message) {
  // Same reasoning as createAgreementDoc() above — getAuthorizedDrive() must be inside the try, not before
  // it, so a decrypt failure is translated by describeGoogleError() instead of reaching the client raw via
  // the route's `res.status(422).json({ error: err.message })` (PATCH /api/google-docs/:docId/reshare).
  let drive;
  try {
    const authorized = await getAuthorizedDrive(db);
    if (!authorized) throw new Error('Google Docs is not connected.');
    drive = authorized.drive;
  } catch (err) {
    throw new Error(describeGoogleError(err));
  }
  const sharing = [];
  for (const r of recipients) sharing.push(await shareWith(drive, fileId, r.email, r.role, message));
  return sharing;
}

module.exports = {
  SCOPES,
  getAuthUrl,
  handleOAuthCallback,
  verifyConnection,
  getIntegration,
  disconnect,
  describeGoogleError,
  createAgreementDoc,
  reshareDoc,
  buildAgreementHtml,
  docsCollection,
  // Exported for services/documentStorageService.js (Document Library file storage, 2026-11) — reuses this
  // same connected account/token-refresh/collection-safety machinery for a second, separate Drive folder
  // ("CIPRMS Document Library") rather than duplicating the OAuth plumbing a second time.
  getAuthorizedDrive,
  integrationCollection,
  GOOGLE_API_TIMEOUT_MS // exported for unit testing the configured bound in isolation
};
