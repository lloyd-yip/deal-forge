'use strict';
// Load .env file first — must be before ANY process.env reads
require('dotenv').config({ path: require('path').join(__dirname, '.env') });

const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const sharp = require('sharp');

const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };

// ── Prompt templates — loaded from files at startup ───────────────────────────
const PROMPTS_DIR   = path.join(__dirname, 'prompts');
const TEMPLATES_DIR = path.join(__dirname, 'templates');
let WEBINAR_SYSTEM_TEMPLATE = '';
let WEBINAR_USER_TEMPLATE   = '';
let WEBINAR_FALLBACK_FORMAT = '';
let ROI_MODEL_TEMPLATE      = '';
let CALENDAR_VISUAL_TEMPLATE = '';
let WEBINAR_MOCK_TEMPLATE   = '';
try {
  WEBINAR_SYSTEM_TEMPLATE  = fs.readFileSync(path.join(PROMPTS_DIR,   'webinar_titles_system.txt'), 'utf8');
  WEBINAR_USER_TEMPLATE    = fs.readFileSync(path.join(PROMPTS_DIR,   'webinar_titles_user.txt'),   'utf8');
  WEBINAR_FALLBACK_FORMAT  = fs.readFileSync(path.join(PROMPTS_DIR,   'webinar_titles_fallback_format.txt'), 'utf8');
  console.log('[Prompts] Loaded webinar title templates');
} catch(e) { console.warn('[Prompts] Could not load webinar templates:', e.message); }
try {
  ROI_MODEL_TEMPLATE       = fs.readFileSync(path.join(TEMPLATES_DIR, 'roi_model.html'),       'utf8');
  CALENDAR_VISUAL_TEMPLATE = fs.readFileSync(path.join(TEMPLATES_DIR, 'calendar_visual.html'), 'utf8');
  WEBINAR_MOCK_TEMPLATE    = fs.readFileSync(path.join(TEMPLATES_DIR, 'webinar_mock.html'),    'utf8');
  console.log('[Templates] Loaded roi_model, calendar_visual, webinar_mock');
} catch(e) { console.warn('[Templates] Could not load HTML templates:', e.message); }

function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => (vars[k] !== undefined && vars[k] !== null) ? vars[k] : '');
}

// ── Supabase REST helper ───────────────────────────────────────────────────────
const SUPABASE_URL        = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USE_SUPABASE        = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

// Sales-assets schema profile header (PostgREST non-public schema routing)
function schemaHeaders(method) {
  return method === 'GET' || method === 'HEAD'
    ? { 'Accept-Profile': 'sales_assets' }
    : { 'Content-Profile': 'sales_assets' };
}

async function supabaseRequest(method, urlPath, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url     = new URL(SUPABASE_URL + urlPath);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        ...schemaHeaders(method),
        ...extraHeaders
      }
    };
    if (payload) options.headers['Content-Length'] = Buffer.byteLength(payload);
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: data ? JSON.parse(data) : null }); }
        catch(e) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Upload file to Supabase Storage (bucket: sales-assets)
async function storageUpload(storagePath, content, contentType = 'text/html') {
  return new Promise((resolve, reject) => {
    const url     = new URL(`${SUPABASE_URL}/storage/v1/object/sales-assets/${storagePath}`);
    const payload = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const options = {
      hostname: url.hostname,
      path: url.pathname,
      method: 'PUT',
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': contentType,
        'Content-Length': payload.length,
        'x-upsert': 'true'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const publicUrl = `${SUPABASE_URL}/storage/v1/object/public/sales-assets/${storagePath}`;
          resolve(publicUrl);
        } else {
          reject(new Error(`Storage upload failed: ${res.statusCode} ${data}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// ── DB helpers — jobs & tasks ─────────────────────────────────────────────────
async function createJob(email, websiteUrl, brief, repName = null) {
  const domain          = websiteUrl || email.split('@')[1];
  const prospectCompany = brief?.prospect?.company || null;
  const prospectName    = brief?.prospect?.contact_name || null;
  const r = await supabaseRequest('POST', '/rest/v1/jobs', {
    prospect_email:   email,
    prospect_website: domain || null,
    prospect_company: prospectCompany,
    prospect_name:    prospectName,
    rep_name:         repName || null,      // B5 fix: persist rep at job creation
    extracted_data:   brief || null,
    status:           'processing'
  }, { 'Prefer': 'return=representation' });
  if (r.status >= 400) throw new Error(`createJob failed: ${r.status} ${JSON.stringify(r.body)}`);
  return Array.isArray(r.body) ? r.body[0] : r.body;
}

// Idempotent: unique constraint on (job_id, task_type) — duplicates silently ignored
async function createTasks(jobId, taskTypes) {
  const rows = taskTypes.map(t => ({
    job_id:        jobId,
    task_type:     t,
    status:        'pending',
    attempt_count: 0,
    max_attempts:  2
  }));
  const r = await supabaseRequest('POST', '/rest/v1/tasks', rows,
    { 'Prefer': 'return=representation,resolution=ignore-duplicates' });
  if (r.status >= 400) throw new Error(`createTasks failed: ${r.status}`);
  return Array.isArray(r.body) ? r.body : [r.body];
}

async function claimTask(taskId) {
  const r = await supabaseRequest('PATCH',
    `/rest/v1/tasks?id=eq.${taskId}&status=eq.pending`,
    { status: 'processing', started_at: new Date().toISOString(), updated_at: new Date().toISOString() },
    { 'Prefer': 'return=representation' }
  );
  if (r.status >= 400) return false;
  return Array.isArray(r.body) && r.body.length > 0;
}

async function completeTask(taskId, outputData, assetUrl) {
  await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${taskId}`, {
    status:       'completed',
    output_data:  outputData || null,
    asset_url:    assetUrl || null,
    completed_at: new Date().toISOString(),
    updated_at:   new Date().toISOString()
  });
}

// retryTask: increment attempt_count and reset to pending (up to max_attempts)
async function retryOrFailTask(task, errorMessage) {
  const attempts = (task.attempt_count || 0) + 1;
  if (attempts < (task.max_attempts || 2)) {
    console.log(`[worker] Retrying ${task.task_type} (attempt ${attempts}/${task.max_attempts})`);
    await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${task.id}`, {
      status:        'pending',
      attempt_count: attempts,
      error_message: `Attempt ${attempts} failed: ${errorMessage}`,
      started_at:    null,
      updated_at:    new Date().toISOString()
    });
  } else {
    await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${task.id}`, {
      status:        'failed',
      attempt_count: attempts,
      error_message: errorMessage,
      updated_at:    new Date().toISOString()
    });
  }
}

async function needsInputTask(taskId, errorMessage) {
  await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${taskId}`, {
    status:        'needs_input',
    error_message: errorMessage,
    updated_at:    new Date().toISOString()
  });
}

async function getJob(jobId) {
  const r = await supabaseRequest('GET', `/rest/v1/jobs?id=eq.${jobId}&limit=1`);
  if (r.status !== 200 || !Array.isArray(r.body) || !r.body.length) return null;
  return r.body[0];
}

async function updateJobExtractedData(jobId, extractedData) {
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, {
    extracted_data: extractedData,
    updated_at:     new Date().toISOString()
  });
}

async function updateJobBrandData(jobId, brandData) {
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, {
    brand_data: brandData,
    updated_at: new Date().toISOString()
  });
}

async function updateJobResearchData(jobId, researchData) {
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, {
    research_data: researchData,
    updated_at:    new Date().toISOString()
  });
}

async function updateJobStatus(jobId, status) {
  const patch = { status, updated_at: new Date().toISOString() };
  if (status === 'completed' || status === 'failed') patch.completed_at = new Date().toISOString();
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`, patch);
}

// ── Phase 4: In-app notification helper ───────────────────────────────────────
async function createNotification({ type, title, body = null, callId = null, jobId = null, repId = null }) {
  try {
    await supabaseRequest('POST', '/rest/v1/notifications',
      { type, title, body, call_id: callId, job_id: jobId, rep_id: repId, read: false },
      { 'Prefer': 'return=minimal', 'Content-Profile': 'public' }
    );
  } catch(e) {
    console.warn('[notif] Failed to create notification:', e.message);
  }
}

async function getTasksByJobId(jobId) {
  const r = await supabaseRequest('GET', `/rest/v1/tasks?job_id=eq.${jobId}&order=created_at.asc`);
  if (r.status !== 200) return [];
  return Array.isArray(r.body) ? r.body : [];
}

async function getRecentJobsByEmail(email, limit = 5) {
  const r = await supabaseRequest(
    'GET',
    `/rest/v1/jobs?prospect_email=eq.${encodeURIComponent(email)}&order=updated_at.desc&limit=${limit}`
  );
  if (r.status !== 200 || !Array.isArray(r.body)) return [];
  return r.body;
}

async function getHistoricalContextByEmail(email) {
  const rows = await getRecentJobsByEmail(email, 5);
  if (!rows.length) return null;
  let websiteOnlyFallback = null;
  for (const row of rows) {
    const brief = row.extracted_data || null;
    const company = row.prospect_company || brief?.prospect?.company || null;
    const name = row.prospect_name || brief?.prospect?.contact_name || null;
    const website = row.prospect_website || null;
    if (brief || company || name) {
      return { brief, company, name, website, jobId: row.id || row.job_id || null };
    }
    if (!websiteOnlyFallback && website) {
      websiteOnlyFallback = { brief: null, company: null, name: null, website, jobId: row.id || row.job_id || null };
    }
  }
  return websiteOnlyFallback;
}

async function getPendingTasks(limit = 5) {
  const r = await supabaseRequest('GET', `/rest/v1/tasks?status=eq.pending&order=created_at.asc&limit=${limit}`);
  if (r.status !== 200) return [];
  return Array.isArray(r.body) ? r.body : [];
}

async function getTaskOutput(jobId, taskType) {
  const r = await supabaseRequest('GET',
    `/rest/v1/tasks?job_id=eq.${jobId}&task_type=eq.${taskType}&limit=1`);
  if (r.status !== 200 || !Array.isArray(r.body) || !r.body.length) return null;
  return r.body[0];
}

// ── Utility ───────────────────────────────────────────────────────────────────
async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => data += chunk);
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch(e) { resolve({}); } });
    req.on('error', reject);
  });
}
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Apify helper ──────────────────────────────────────────────────────────────
async function runApifyActor(actorId, input, timeoutMs = 90000) {
  const APIFY_TOKEN = process.env.APIFY_API_TOKEN;
  if (!APIFY_TOKEN) throw new Error('APIFY_API_TOKEN not set');

  // Start the run
  const startRes = await fetch(
    `https://api.apify.com/v2/acts/${encodeURIComponent(actorId)}/runs?token=${APIFY_TOKEN}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(15000)
    }
  );
  if (!startRes.ok) {
    const text = await startRes.text();
    if (startRes.status === 401) throw new Error('Apify 401: invalid token');
    throw new Error(`Apify start failed: ${startRes.status} ${text.slice(0, 200)}`);
  }
  const startData = await startRes.json();
  const runId = startData.data?.id;
  const datasetId = startData.data?.defaultDatasetId;
  if (!runId) throw new Error('Apify: no run ID returned');

  // Poll for completion
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(r => setTimeout(r, 5000));
    const pollRes = await fetch(
      `https://api.apify.com/v2/actor-runs/${runId}?token=${APIFY_TOKEN}`,
      { signal: AbortSignal.timeout(8000) }
    );
    if (!pollRes.ok) continue;
    const pollData = await pollRes.json();
    const status = pollData.data?.status;
    if (status === 'SUCCEEDED') break;
    if (status === 'FAILED' || status === 'ABORTED' || status === 'TIMED-OUT') {
      throw new Error(`Apify run ${status}: ${runId}`);
    }
  }

  if (Date.now() >= deadline) throw new Error('Apify actor timeout');

  // Fetch results
  const itemsRes = await fetch(
    `https://api.apify.com/v2/datasets/${datasetId}/items?token=${APIFY_TOKEN}`,
    { signal: AbortSignal.timeout(10000) }
  );
  if (!itemsRes.ok) throw new Error(`Apify dataset fetch failed: ${itemsRes.status}`);
  return await itemsRes.json();
}

// ── GHL contact lookup ────────────────────────────────────────────────────────
const GHL_API_KEY     = process.env.GHL_API_KEY;
const GHL_LOCATION_ID = process.env.GHL_LOCATION_ID;

async function lookupGHLContact(email) {
  if (!GHL_API_KEY || !GHL_LOCATION_ID) {
    console.log('[GHL] No credentials — skipping contact lookup');
    return null;
  }
  try {
    const url = `https://services.leadconnectorhq.com/contacts/?email=${encodeURIComponent(email)}&locationId=${GHL_LOCATION_ID}`;
    const res = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${GHL_API_KEY}`,
        'Version': '2021-07-28',
        'Content-Type': 'application/json'
      },
      signal: AbortSignal.timeout(5000)
    });
    if (!res.ok) { console.warn('[GHL] Lookup failed:', res.status); return null; }
    const data = await res.json();
    const contact = (data.contacts || [])[0];
    if (!contact) return null;
    const name = [contact.firstName, contact.lastName].filter(Boolean).join(' ').trim() || null;
    const company = contact.companyName || contact.company || null;
    const website = contact.website || null;
    console.log(`[GHL] Found contact: ${name} @ ${company}`);
    return { name, company, website, title: contact.customField?.find(f => f.name === 'Title')?.value || null };
  } catch(e) {
    console.warn('[GHL] Lookup error:', e.message);
    return null;
  }
}

function normalizeToken(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function uniqueTokens(values, minLength = 3) {
  const out = [];
  const seen = new Set();
  for (const value of values || []) {
    for (const token of normalizeToken(value).split(/\s+/)) {
      if (!token || token.length < minLength) continue;
      if (seen.has(token)) continue;
      seen.add(token);
      out.push(token);
    }
  }
  return out;
}

// ── Fireflies GraphQL helper ──────────────────────────────────────────────────
async function firefliesQuery(gql, variables) {
  const res = await fetch('https://api.fireflies.ai/graphql', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${process.env.FIREFLIES_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ query: gql, variables }),
    signal: AbortSignal.timeout(12000)
  });
  if (!res.ok) { console.error('Fireflies HTTP error:', res.status); return null; }
  const data = await res.json();
  if (data.errors) { console.error('Fireflies errors:', JSON.stringify(data.errors)); return null; }
  return data.data;
}

// Used in search/list passes — NO sentences (would be enormous for 30-50 transcripts)
const TRANSCRIPT_LIST_FIELDS = `
  id title dateString duration
  summary { short_summary overview action_items shorthand_bullet }
  meeting_attendees { email displayName }
`;

// Used for single-transcript detail fetch after match is found
const TRANSCRIPT_DETAIL_FIELDS = `
  id title dateString duration
  summary { short_summary overview action_items shorthand_bullet }
  sentences { text speaker_name }
  meeting_attendees { email displayName }
`;

// Fetch a single transcript by ID to get full sentences (called after match is confirmed)
async function fetchTranscriptDetail(id) {
  try {
    const gql  = `query Detail($id: String!) { transcript(id: $id) { ${TRANSCRIPT_DETAIL_FIELDS} } }`;
    const data = await firefliesQuery(gql, { id });
    return data?.transcript || null;
  } catch(e) {
    console.warn('[FF] Detail fetch failed for', id, ':', e.message);
    return null;
  }
}

// B2 fix: Multi-transcript search — returns ALL calls matching this prospect.
// The caller (handleExtract) aggregates all summaries into one Claude context block
// so that follow-up calls, pricing calls, and objection-handling calls all inform the ICP.
// Sort order: exact-email matches first, then by duration desc (longest = richest context).
async function findFirefliesTranscripts(email, contactInfo = {}) {
  const domain     = (email.split('@')[1] || '').toLowerCase();
  const domainBase = domain.split('.')[0];
  const emailLocal = email.split('@')[0].toLowerCase();
  const NON_GENERIC    = new Set(['info','admin','contact','hello','sales','support','team','office','mail','noreply','no-reply','hi','hey']);
  const GENERIC_DOMAINS = new Set(['gmail','yahoo','hotmail','outlook','icloud','proton','me','live','aol']);
  const nameTokens = uniqueTokens([contactInfo.name]);
  const companyTokens = uniqueTokens([contactInfo.company, domainBase], 4);

  // ── Build ordered search terms: best signal first ───────────────────────────
  const terms = []; // { keyword, source, acceptLoose }

  // A) GHL contact first + last name (highest quality)
  const fullName = (contactInfo.name || '').trim();
  if (fullName) {
    const parts = fullName.split(/\s+/);
    const fn = parts[0]?.toLowerCase();
    const ln = parts[parts.length - 1]?.toLowerCase();
    if (fn && fn.length >= 3) terms.push({ keyword: fn, source: 'ghl_first', acceptLoose: false });
    if (ln && ln !== fn && ln.length >= 3) terms.push({ keyword: ln, source: 'ghl_last', acceptLoose: false });
  }

  // B) GHL company name + first word of company
  const company = (contactInfo.company || '').trim();
  if (company.length >= 3) {
    terms.push({ keyword: company.toLowerCase(), source: 'ghl_company', acceptLoose: true });
    const compWord = company.split(/[\s,._\-]+/)[0].toLowerCase();
    if (compWord.length >= 4 && compWord !== company.toLowerCase()) {
      terms.push({ keyword: compWord, source: 'ghl_company_word', acceptLoose: true });
    }
  }

  // C) All email local-part segments (sgoldstucker → ['sgoldstucker']; sarah.goldstucker → ['sarah','goldstucker'])
  // acceptLoose=true for segments >= 7 chars — specific enough that Fireflies finding it means it's the right transcript
  for (const part of emailLocal.split(/[._\-+]/)) {
    const clean = part.replace(/\d+$/, '');
    if (/^[a-z]{3,20}$/.test(clean) && !NON_GENERIC.has(clean) && clean !== domainBase) {
      terms.push({ keyword: clean, source: `email:${clean}`, acceptLoose: clean.length >= 7 });
    }
  }

  // D) Domain base — accept loose match (Fireflies often omits attendee emails)
  if (domainBase.length >= 4 && !GENERIC_DOMAINS.has(domainBase)) {
    terms.push({ keyword: domainBase, source: 'domain', acceptLoose: true });
  }

  // ── Match helpers ─────────────────────────────────────────────────────────
  const isExactEmail  = t => (t.meeting_attendees || []).some(a => (a.email || '').toLowerCase() === email.toLowerCase());
  const isDomainEmail = t => (t.meeting_attendees || []).some(a => (a.email || '').toLowerCase().endsWith('@' + domain));
  const hasDisplayNameMatch = t => {
    if (!nameTokens.length) return false;
    return (t.meeting_attendees || []).some(a => {
      const normalized = normalizeToken(a.displayName);
      return nameTokens.every(token => normalized.includes(token)) ||
        nameTokens.some(token => normalized.includes(token));
    });
  };
  const hasCompanyTitleMatch = t => {
    const haystack = normalizeToken(t.title);
    if (!haystack) return false;
    return companyTokens.some(token => haystack.includes(token));
  };

  // Collect ALL unique matches into a Map (id → transcript)
  const allMatches = new Map();
  function collectMatches(results, acceptLoose, source) {
    results.filter(isExactEmail).forEach(t => {
      if (!allMatches.has(t.id)) { console.log(`[FF] ✓ exact email (${source}): "${t.title}"`); allMatches.set(t.id, t); }
    });
    results.filter(isDomainEmail).forEach(t => {
      if (!allMatches.has(t.id)) { console.log(`[FF] ✓ domain email (${source}): "${t.title}"`); allMatches.set(t.id, t); }
    });
    if (acceptLoose) results.forEach(t => {
      if (!allMatches.has(t.id)) { console.log(`[FF] ✓ loose match (${source}): "${t.title}"`); allMatches.set(t.id, t); }
    });
  }

  // ── Passes 1–5: keyword searches ──────────────────────────────────────────
  const searchGql = `query Search($keyword: String) { transcripts(keyword: $keyword, limit: 30) { ${TRANSCRIPT_LIST_FIELDS} } }`;
  const searched  = new Set();

  for (const { keyword, source, acceptLoose } of terms) {
    if (searched.has(keyword)) continue;
    searched.add(keyword);
    try {
      const data = await firefliesQuery(searchGql, { keyword });
      collectMatches(data?.transcripts || [], acceptLoose, source);
    } catch(e) { console.warn(`[FF] Pass ${source} error:`, e.message); }
  }

  // ── Pass 6a: recent scan — page 1 ─────────────────────────────────────────
  console.log('[FF] Scanning recent transcripts pass 6a (limit 50)...');
  try {
    const data = await firefliesQuery(`{ transcripts(limit: 50) { ${TRANSCRIPT_LIST_FIELDS} } }`, {});
    const transcripts = data?.transcripts || [];
    console.log(`[FF] Pass 6a: ${transcripts.length} transcripts`);
    transcripts.forEach(t => {
      const emails = (t.meeting_attendees || []).map(a => a.email).filter(Boolean);
      if (emails.length) console.log(`[FF]   "${t.title}": ${emails.join(', ')}`);
    });
    collectMatches(transcripts, false, 'recent_scan_6a');
  } catch(e) { console.warn('[FF] Pass 6a scan error:', e.message); }

  // ── Pass 6b: recent scan — page 2 ─────────────────────────────────────────
  console.log('[FF] Scanning recent transcripts pass 6b (skip 50)...');
  try {
    const data2 = await firefliesQuery(`{ transcripts(limit: 50, skip: 50) { ${TRANSCRIPT_LIST_FIELDS} } }`, {});
    const transcripts2 = data2?.transcripts || [];
    console.log(`[FF] Pass 6b: ${transcripts2.length} transcripts`);
    transcripts2.forEach(t => {
      const emails = (t.meeting_attendees || []).map(a => a.email).filter(Boolean);
      if (emails.length) console.log(`[FF]   "${t.title}": ${emails.join(', ')}`);
    });
    collectMatches(transcripts2, false, 'recent_scan_6b');
  } catch(e) { console.warn('[FF] Pass 6b scan error:', e.message); }

  // ── Sort and return all matches ────────────────────────────────────────────
  const matches = [...allMatches.values()];
  if (!matches.length) {
    console.log('[FF] No transcripts found for', email, '— searched:', [...searched].join(', '));
    return [];
  }
  // Exact email first, then longest duration (most context)
  matches.sort((a, b) => {
    const aEx = isExactEmail(a) ? 1 : 0, bEx = isExactEmail(b) ? 1 : 0;
    if (bEx !== aEx) return bEx - aEx;
    return (b.duration || 0) - (a.duration || 0);
  });
  console.log(`[FF] Found ${matches.length} transcript(s) for ${email}:`);
  matches.forEach(t => console.log(`[FF]   - "${t.title}" (${(t.duration||0).toFixed(0)} min)${isExactEmail(t) ? ' [exact]' : ''}`));
  return matches;
}

// Legacy wrapper — callers that need only the best single transcript
async function findFirefliesTranscript(email, contactInfo = {}) {
  const all = await findFirefliesTranscripts(email, contactInfo);
  return all[0] || null;
}

// ── Website scraper ───────────────────────────────────────────────────────────
async function scrapeWebsite(domain) {
  // Strip protocol if accidentally passed with it
  const cleanDomain = domain.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const baseUrl = `https://${cleanDomain}`;

  // ── Path A: Jina AI Reader — renders JS/SPA sites via headless browser ──────
  // Returns clean markdown text — far better than regex-stripped HTML for briefs.
  // No API key required. Already proven in websiteQualityCheck() for lead classification.
  const jinaFetch = async (targetUrl) => {
    try {
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text', 'X-Timeout': '8' },
        signal: AbortSignal.timeout(9000)
      });
      if (!res.ok) return '';
      return (await res.text()).trim();
    } catch(e) { return ''; }
  };

  // ── Path B: Raw fetch — needed for HTML metadata (og:image, theme-color, etc.) ─
  // brand_scrape depends on raw HTML for logo/color regex extraction.
  const rawFetch = async () => {
    try {
      const res = await fetch(baseUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(8000)
      });
      return res.ok ? await res.text() : '';
    } catch(e) { return ''; }
  };

  // Run both in parallel — no speed penalty
  const [jinaText, html] = await Promise.all([jinaFetch(baseUrl), rawFetch()]);

  // If Jina homepage is thin (<250 chars), try /about page for richer content
  let bodyText = jinaText;
  if (jinaText.length < 250) {
    const aboutText = await jinaFetch(`${baseUrl}/about`);
    if (aboutText.length > jinaText.length) bodyText = aboutText;
  }
  bodyText = bodyText.slice(0, 3000);

  // Extract title + metaDesc from raw HTML (they're in <head>, always server-rendered)
  const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim() ||
                bodyText.split('\n').find(l => l.trim().length > 10)?.trim().slice(0, 120) || '';
  const metaDesc = (
    html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) ||
    html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i)
  )?.[1]?.trim() || '';

  console.log(`[scrape] ${cleanDomain} — Jina:${jinaText.length}chars, HTML:${html.length}chars, title:"${title.slice(0,60)}"`);
  return { html, title, metaDesc, bodyText };
}

// ── Brief extraction from transcript + website ────────────────────────────────
async function extractBriefFromTranscript(transcriptContent, websiteContent, contactInfo) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const knownCompany  = contactInfo.company  || null;
  const knownName     = contactInfo.name     || null;
  const knownWebsite  = contactInfo.website  || null;

  const systemPrompt = `You are extracting a high-fidelity Prospect Brief from a sales call transcript.
Your job is to pull out the richest possible context for creating personalized sales assets.

Rules:
- Extract ONLY what was explicitly stated. Return null for anything not mentioned.
- Never infer, guess, or hallucinate values.
- The PROSPECT is the CLIENT company being pitched to — NOT Quantum Scaling, NOT Lloyd Yip, NOT QS team.
- For verbatim fields: copy exact words spoken. Do not paraphrase.
- For apollo_titles: return ONLY real job titles (2-4 words each) that a person would hold on LinkedIn or a business card. These feed directly into an API search. Sentence fragments, role descriptions, and qualifiers are NEVER valid titles — infer the actual titles from the described role.
- Return valid JSON only. No markdown, no explanation.`;

  const userPrompt = `Known contact info (treat as ground truth if not contradicted):
Company: ${knownCompany || 'unknown — extract from transcript'}
Name: ${knownName || 'extract from transcript'}
Website: ${knownWebsite || 'extract from transcript'}

${transcriptContent ? `${transcriptContent}\n---` : '(No transcript available)'}
${websiteContent ? `\nWEBSITE CONTENT:\n---\n${websiteContent.slice(0, 2000)}\n---` : ''}

Return this exact JSON (null for anything not found):
{
  "prospect": {
    "company":       "string — company name. Use known value if transcript confirms or is silent",
    "contact_name":  "string | null — full name of person on the call",
    "contact_title": "string | null — their job title"
  },
  "icp": {
    "role":          "string | null — human-readable description of their target buyers (used for display only)",
    "target_audience_type": "string — 'b2b' if the buyer is a person at a business (any role: Property Manager, CEO, Marketing Director, etc), 'b2c' if the buyer is a private consumer (homeowner, resident, individual end-user, member of the public), or 'mixed' if the prospect explicitly serves both. Default 'b2b' if unclear. CRITICAL: this drives whether Apollo is used at all — Apollo is a B2B contact database with no consumer records.",
    "apollo_titles": "array of strings | null — EXACTLY 3-6 standalone job titles for Apollo API search. STRICT RULES: (1) Each entry must be a real B2B job title a person would hold — 2-4 words max. (2) NEVER include consumer/B2C terms (Homeowner, Resident, Tenant, Consumer, Buyer, End-user) — those belong in target_audience_type='b2c'. (3) NEVER include sentence fragments, descriptions, qualifiers, or phrases. If the transcript says 'senior decision-makers at organizations with 50+ employees' — extract titles: ['CEO', 'Director of Strategy', 'Head of Operations']. (4) Self-check each entry: would this appear verbatim on a LinkedIn profile or business card? If not — it is wrong, replace it. VALID: ['CEO', 'Managing Director', 'VP Sales', 'Head of Strategy', 'Chief Operating Officer', 'Property Manager', 'Facilities Manager']. INVALID: ['Homeowner', 'particularly in government', 'large enterprises', 'goals', 'accountability']. If titles not stated, INFER from role/industry context. Null if target_audience_type='b2c' or buyer role is completely indeterminate.",
    "apollo_keyword": "string | null — a SINGLE short free-text phrase (1-3 words) describing the INDUSTRY THE BUYER'S EMPLOYER OPERATES IN. This is fed into Apollo's q_keywords (free-text company search), NOT a tag — so use plain natural language, not Apollo enums. CRITICAL DISTINCTION — extract the buyer's employer industry, NOT the topic/solution the prospect is selling: ✗ Solar company selling to property managers → 'renewables' is WRONG (that's the seller's domain). ✓ → 'property management' or 'real estate'. ✗ Marketing agency selling to SaaS founders → 'marketing' is WRONG. ✓ → 'software'. ✗ Roofing company selling to facilities managers at hotels → 'roofing' is WRONG. ✓ → 'hospitality' or 'commercial real estate'. Ask yourself: 'If I looked up this buyer on LinkedIn, what industry would their EMPLOYER be listed under?' That is the answer. Examples of valid values: 'real estate', 'property management', 'hospitality', 'manufacturing', 'software', 'healthcare', 'financial services', 'construction', 'education', 'logistics', 'retail', 'consulting'. Null if target_audience_type='b2c' or the buyer's industry is genuinely indeterminate (e.g. 'CEOs of any company' with no sector specified).",
    "industry":      "string | null — same as apollo_keyword — kept as a separate field for display compatibility",
    "company_size":  "string | null — human-readable size of their TARGET clients, for display only (e.g. '50-200 employees', 'mid-market', 'enterprise'). Concise — not a full sentence.",
    "apollo_employee_ranges": "array of strings | null — Apollo API employee range codes for their TARGET clients. Choose ONLY from these exact strings: '1,10', '11,50', '51,200', '201,500', '501,1000', '1001,10000', '10001,50000', '50001+'. Match to the described size: '50+ employees, ideally 100+' → ['51,200','201,500']. 'Enterprise/large organizations' → ['501,1000','1001,10000','10001,50000']. CRITICAL RULE: if transcript mentions 'enterprise', 'large organizations', 'government agencies', 'Fortune 500', 'enterprise clients', or any equivalent → you MUST include '1001,10000' in the ranges. Government agencies and large enterprises are typically 1000+ employees. 'Small businesses under 10' → ['1,10']. Select 1-4 contiguous ranges that bracket the target. Null if no size mentioned.",
    "geography":     "string | null — target geography narrative, only if explicitly mentioned",
    "apollo_geography": "array of strings | null — clean country/region names for Apollo API. Valid entries: country names, continent names ('Europe', 'Asia', 'North America'), US/Canadian/Australian states or provinces, major cities. STRICT RULES: (1) NEVER include language names — Estonian, Latvian, Lithuanian, Montenegrin, English are LANGUAGES not locations. Extract the countries instead. (2) NEVER write 'European Union' — it is not a country. Instead expand to the specific European countries mentioned or implied: 'EU' → list the relevant member countries explicitly (e.g. Estonia, Latvia, Lithuania, Germany, France). If broadly EU-wide, use 'Europe'. (3) NEVER include narrative phrases. (4) Extract ONLY location nouns. Examples: 'North America' → ['United States', 'Canada']. 'Baltic states' → ['Estonia', 'Latvia', 'Lithuania']. 'DACH region' → ['Germany', 'Austria', 'Switzerland']. 'EU' broadly → ['Europe']. Null if no geography mentioned.",
    "person_seniorities": "array of strings | null — seniority levels of target buyers. Choose ONLY from these exact values: owner, founder, c_suite, partner, vp, head, director, manager. Infer from role/title context. Null if completely unclear.",
    "company_revenue": "string | null — revenue range of their TARGET clients if mentioned or clearly implied (e.g. '$1M-$5M', '$500K+', '$2M ARR'). Verbatim if stated, short inference if strongly implied. Null if not determinable.",
    "kpis":          "array of 3-5 strings — the specific business performance metrics the prospect's service directly helps their ICP improve. Extract verbatim if mentioned. If not explicitly stated, INFER from the service description, promised outcomes, and problems solved — look at what their clients gain. Return short, specific metric names like 'Revenue per client', 'Customer acquisition rate', 'Client retention rate', 'Brand visibility', 'Lead conversion rate', 'Average deal size'. Never null — always infer at least 3."
  },
  "metrics": {
    "ltv":        "string | null — client lifetime value, verbatim from transcript. null if not explicitly stated.",
    "close_rate": "string | null — current close rate, verbatim from transcript. null if not explicitly stated.",
    "show_rate":  "string | null — current show/attendance rate, verbatim from transcript. null if not explicitly stated."
  },
  "angle": {
    "pain":        "string | null — the DEEP, specific, emotional frustration their clients experience. Go beyond the surface problem: what does it actually cost them (money, time, stress, missed opportunity)? What have they tried that didn't work? What does failure look or feel like for their client day-to-day? Write in customer language — raw frustration, not a polished problem statement. Pull their exact words from the transcript wherever possible. 4-6 sentences.",
    "result":      "string | null — the concrete before/after transformation they deliver. What specifically changes for the client? What does their business or life look like 6-12 months after working with this person? Be specific about outcomes — revenue, time saved, stress removed, capability gained. Include verbatim numbers if mentioned. 3-5 sentences.",
    "methodology": "string | null — their named framework or system if they mentioned one (exact name)",
    "proof":       "string | null — their single best client outcome with specific numbers verbatim"
  },
  "verbatim": {
    "pain_quote":   "string | null — exact verbatim quote (≤40 words) of the prospect describing their clients' biggest pain. Must be their actual spoken words. null if no clear quote.",
    "result_quote": "string | null — exact verbatim quote (≤30 words) of the prospect describing what they deliver. null if no clear quote.",
    "goal_quote":   "string | null — exact verbatim quote (≤30 words) of what they want to achieve. null if no clear quote."
  },
  "situation": {
    "current_lead_gen": "string | null — how they currently get clients, verbatim or close paraphrase (e.g. '100% referrals', 'cold email + LinkedIn + events')",
    "revenue_range":    "string | null — their current revenue if mentioned (e.g. '$2M ARR', '$500K-$1M/year')",
    "team_size":        "string | null — their team/company size if mentioned",
    "biggest_challenge":"string | null — the single most important challenge they named for their own business growth (not their clients' challenges). 1-2 sentences."
  },
  "context": {
    "goals":       "string | null — what they want to achieve in next 6-12 months",
    "why_webinar": "string | null — why they are exploring webinars or this system specifically"
  },
  "titles": {
    "a": "string | null — compelling webinar title based on their pain + result, max 70 chars",
    "b": "string | null — second variant with different angle or audience framing, max 70 chars"
  }
}`;

  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 3000,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const raw = message.content[0].text;
  try { return JSON.parse(raw); }
  catch(e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    return null; // Graceful: modal opens blank for manual entry
  }
}

function emptyBrief(contactInfo) {
  return {
    prospect:  { company: contactInfo.company || null, contact_name: contactInfo.name || null, contact_title: null },
    icp:       { role: null, target_audience_type: 'b2b', apollo_titles: null, apollo_keyword: null, industry: null, company_size: null, apollo_employee_ranges: null, geography: null, apollo_geography: null, person_seniorities: null, company_revenue: null, kpis: null },
    metrics:   { ltv: null, close_rate: null, show_rate: null },
    angle:     { pain: null, result: null, methodology: null, proof: null },
    verbatim:  { pain_quote: null, result_quote: null, goal_quote: null },
    situation: { current_lead_gen: null, revenue_range: null, team_size: null, biggest_challenge: null },
    context:   { goals: null, why_webinar: null },
    titles:    { a: null, b: null }
  };
}

// ── Apollo helpers ────────────────────────────────────────────────────────────
function mapCompanySize(sizeStr) {
  if (!sizeStr) return ['11,50', '51,200'];
  const s = sizeStr.toLowerCase();
  if (/solo|1.person|solopreneur/.test(s)) return ['1,1'];
  if (/\bsmall\b/.test(s) && !/team/.test(s)) return ['1,10'];
  if (/1.10|under 10|fewer than 10/.test(s)) return ['1,10'];
  if (/10.50|startup|small.*team/.test(s)) return ['1,10', '11,50'];
  if (/1000\+|1,000\+|very large/.test(s)) return ['1001,10000'];
  if (/500\+|enterprise|large/.test(s)) return ['501,1000', '1001,10000'];
  if (/200.500|mid.market/.test(s)) return ['201,500'];
  if (/100\+|ideally 100/.test(s)) return ['101,200', '201,500'];
  if (/50\+/.test(s) && !/200|500|1000/.test(s)) return ['51,200'];
  if (/50.200|mid.size|growing/.test(s)) return ['51,200'];
  return ['11,50', '51,200'];
}
function fmtEmp(n) {
  if (!n) return '';
  if (n <= 10) return `${n} emp`;
  if (n <= 200) return `${Math.round(n/10)*10} emp`;
  if (n <= 1000) return `~${Math.round(n/100)*100} emp`;
  return `${Math.round(n/1000)}K+ emp`;
}
// Global TAM estimator — Apollo's global people/search requires a higher plan tier.
// We estimate the global reachable market from known industry/size data.
// These are conservative global counts of relevant decision-makers in Apollo's database.
function estimateGlobalTAM(icp) {
  // Industry base: sourced from the single free-text apollo_keyword (preferred)
  // or the legacy industry field. apollo_industries (array) is no longer produced
  // by the extractor — older jobs may still have it, so read as a fallback.
  const industries = (typeof icp?.apollo_keyword === 'string' && icp.apollo_keyword.trim())
    ? [icp.apollo_keyword.trim()]
    : (Array.isArray(icp?.apollo_industries) && icp.apollo_industries.length
        ? icp.apollo_industries
        : [(icp?.industry || '')]);
  function getIndBase(s) {
    s = s.toLowerCase();
    if (/coach/.test(s)) return 4000000;
    if (/consult/.test(s)) return 2500000;
    if (/agency|advertis|marketing/.test(s)) return 1200000;
    if (/ecommerce|retail|consumer/.test(s)) return 1500000;
    if (/manufactur/.test(s)) return 950000;
    if (/software|tech|saas|information technology/.test(s)) return 900000;
    if (/real.estate/.test(s)) return 750000;
    if (/health|medical|pharma/.test(s)) return 650000;
    if (/financ|banking|insurance/.test(s)) return 550000;
    if (/legal|law/.test(s)) return 380000;
    if (/government|public.sector|municipal/.test(s)) return 280000;
    if (/education|school|university/.test(s)) return 420000;
    if (/nonprofit|ngo/.test(s)) return 200000;
    if (/construct|architect/.test(s)) return 220000;
    if (/transport|logistics/.test(s)) return 310000;
    if (/hospitality|hotel/.test(s)) return 180000;
    if (/telecom/.test(s)) return 120000;
    return 1100000;
  }
  // Cap at first 2 industries — additional industries are likely overlapping markets
  // More than 2 would compound the base unrealistically (old formula produced 8.5M for 3+ industries)
  const cappedIndustries = industries.slice(0, 2);
  let base = cappedIndustries.reduce((sum, ind, i) => sum + getIndBase(ind) * Math.pow(0.6, i), 0);

  // Size adjustment: larger company = fewer companies but same contact density
  const sizeStr = (icp?.company_size || '').toLowerCase();
  let sizeMult = 0.30; // default: 10-50 range
  if (/solo|1.person|1.10|under 10/.test(sizeStr)) sizeMult = 0.42;
  else if (/10.50|startup/.test(sizeStr)) sizeMult = 0.28;
  else if (/50.200|mid.size/.test(sizeStr)) sizeMult = 0.18;
  else if (/200.500|mid.market/.test(sizeStr)) sizeMult = 0.08;
  else if (/500\+?|enterprise/.test(sizeStr)) sizeMult = 0.04;
  // Revenue-based sizing (e.g. "$25M+" maps roughly to 50+ employees)
  else if (/\$25m|\$50m|\$100m|million/.test(sizeStr)) sizeMult = 0.18;

  // Geography adjustment — prefer apollo_geography (clean array) over raw geography string
  const geoArr = Array.isArray(icp?.apollo_geography) && icp.apollo_geography.length ? icp.apollo_geography : null;
  const geo = geoArr ? geoArr.join(' ').toLowerCase() : (icp?.geography || '').toLowerCase();
  let geoMult = 1.0;
  if (geo && !/global|worldwide|international/.test(geo)) {
    // Count how many distinct markets
    const marketCount = geoArr ? geoArr.length : 1;
    if (/united states|usa/.test(geo)) geoMult = 0.35 * Math.min(marketCount, 3) / 1;
    else if (/canada/.test(geo) && marketCount === 1) geoMult = 0.05;
    else if (/uk|united kingdom/.test(geo) && marketCount === 1) geoMult = 0.07;
    else if (/australia/.test(geo) && marketCount === 1) geoMult = 0.04;
    else if (/germany|france/.test(geo) && marketCount === 1) geoMult = 0.06;
    else {
      // Multiple countries or unlisted single country — scale by count, capped at 0.5
      geoMult = Math.min(0.50, marketCount * 0.06);
    }
    geoMult = Math.min(1.0, geoMult); // never exceed global
  }

  const raw = Math.round(base * sizeMult * geoMult);
  // Round to a clean number — nearest 5K below 100K, nearest 25K above
  // Hard cap at 500K: if heuristic says more, it's almost certainly wrong
  // (Apollo's org search returns real counts; this is only used as a fallback)
  const capped = Math.min(500000, raw);
  if (capped < 10000) return Math.round(capped / 500) * 500;
  if (capped < 100000) return Math.round(capped / 5000) * 5000;
  return Math.round(capped / 25000) * 25000;
}
const PARKING_SIGNALS = ['domain for sale','this domain is for sale','buy this domain','coming soon','under construction','parked by','domain parking'];
// ── Jina AI Reader — JS-rendering-aware website scraper ─────────────────────
// Replaces raw fetch() + HTML parser. Jina runs a headless browser on their end,
// so React/Next.js/Vue sites return actual content instead of empty shells.
// No API key required. Format: https://r.jina.ai/{full-url}
async function websiteQualityCheck(url, timeoutMs = 7000) {
  if (!url) return null;
  const jinaFetch = async (targetUrl) => {
    try {
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) return '';
      return (await res.text()).trim();
    } catch(e) { return ''; }
  };

  const base = url.replace(/\/$/, '');

  // Step 1: fetch homepage
  let text = await jinaFetch(base);

  // Step 2: if homepage is thin (<250 chars), try /about and /about-us in parallel
  // About pages have higher signal density — they describe who the company serves,
  // not just marketing taglines.
  if (text.length < 250) {
    const [a, b] = await Promise.all([jinaFetch(`${base}/about`), jinaFetch(`${base}/about-us`)]);
    const best = [a, b].sort((x, y) => y.length - x.length)[0];
    if (best.length > text.length) text = best;
  }

  if (text.length < 100) return null; // parked domain or completely empty
  if (PARKING_SIGNALS.some(s => text.toLowerCase().includes(s))) return null;

  // Jina already strips nav/footer/boilerplate — just trim to 500 chars
  return { excerpt: text.slice(0, 500) };
}
async function classifyLeadsWithHaiku(leads, briefOrIcp) {
  if (!leads.length) return [];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const brief = briefOrIcp && briefOrIcp.icp ? briefOrIcp : { icp: briefOrIcp || {} };
  const icp = brief.icp || {};
  const context = brief.context || {};
  const angle = brief.angle || {};
  const leadProfile = buildLeadProfile(brief);

  // The sector is the primary classification signal.
  // Titles/seniority are already pre-filtered by Apollo — we only need to confirm
  // the company is genuinely in the right industry sector.
  const targetSectors = (typeof icp.apollo_keyword === 'string' && icp.apollo_keyword.trim())
    ? [icp.apollo_keyword.trim()]
    : (Array.isArray(icp.apollo_industries) && icp.apollo_industries.length
        ? icp.apollo_industries
        : [icp.industry || icp.role || 'the target sector']);
  const targetSector  = targetSectors.join(', ');
  const targetTitles  = icp.apollo_titles?.join(', ') || icp.role || null;
  const targetGeo     = icp.apollo_geography?.join(', ') || icp.geography || null;
  const targetProfile = icp.company_size || null;
  const targetPain    = brief.customer_pain || angle.pain || icp.target_pain || null;
  const targetGoal    = brief.goals || context.goals || icp.target_goal || null;
  const targetPreferences = leadProfile.strong_preferences.join(', ') || null;
  const targetNegatives = leadProfile.negatives.join(', ') || null;
  const targetHypotheses = leadProfile.search_hypotheses.join(', ') || null;
  const systemPrompt = `You are a strict B2B lead classifier. Your job: determine if each company matches the target ICP on TWO dimensions — sector AND geography (if specified).

Rules:
1. PRIMARY SIGNAL — website content: does the copy, tone, and services described match ANY listed target sector? An agency writes about campaigns, clients, creative work. A university mentions students, courses, faculty, admissions. A consulting firm mentions strategy, engagements, frameworks.
2. SECONDARY SIGNAL — LinkedIn headline: if the person's headline explicitly references the company type or sector, weight it heavily.
3. SECTOR MISMATCH = NO MATCH. A CEO title does not overcome a wrong-sector company.
4. GEOGRAPHY CHECK (SOFT): If TARGET GEOGRAPHY is specified AND the company's location is CLEARLY and CONFIDENTLY in the wrong region (e.g., ".co.au" domain for a Baltic ICP, website explicitly says "serving Africa only") → reject. When geography is ambiguous, unclear, or the company operates internationally → INCLUDE with confidence "low". Do NOT reject on geography alone if you are less than highly confident. When in doubt, include the lead — the rep will verify.
5. NO SIGNAL RULE: If no website content AND no headline → default match: true with confidence "low" (benefit of the doubt — better to review than miss).
6. CONFIDENCE: "high" = website/headline clearly confirms BOTH sector AND geo. "medium" = sector confirmed, geo plausible but not explicit. "low" = company name plausible, geo ambiguous, or only partial confirmation.
7. Return valid JSON only. No markdown.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2000, temperature: 0,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }]
    });
    const raw = msg.content[0].text;
    return JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || raw);
  } catch(e) {
    console.warn('[Haiku classify] Failed:', e.message);
    return leads.map((_, i) => ({ index: i+1, match: false, confidence: 'low', reason: 'classification unavailable' }));
  }

  return out;
}
// ── Path A: Industry pre-filter — fast keyword gate before AI classifier ─────
// Removes obvious mismatches by company name before spending tokens on Haiku.
// Relaxed: requires 2+ keyword matches to reject (1 match was too aggressive —
// e.g., "TechConsult" got blocked because it contained "tech" for a consulting ICP).
function preFilterLeadsByIndustry(leads, icp) {
  const industry = (icp?.industry || '').toLowerCase();
  const BLOCKLISTS = {
    consulting: /\b(learning|e-?learning|academy|training|school|university|college|institute|software|saas|platform|apps?\b|tech\b|media|publishing|publisher|staffing|recruiting|recruitment|talent|insurance|banking|clinic|hospital|healthcare|dental|retail|store|restaurant|hotel|freight|logistics|shipping|transport)\b/i,
    coaching:   /\b(software|saas|platform|banking|insurance|retail|manufacturing|logistics|shipping|freight|staffing|recruiting)\b/i,
    software:   /\b(consulting|advisory|coaching|therapy|dental|clinic|hospital|school|university|college|staffing|recruiting)\b/i,
    agency:     /\b(school|university|hospital|clinic|banking|insurance|manufacturing|logistics|recruiting|staffing|learning)\b/i,
  };
  const pattern = BLOCKLISTS[industry];
  if (!pattern) return leads;

  // Count matches per lead — require 2+ hits to reject
  // Single-word matches are too prone to false positives (e.g. "TechConsult" for consulting ICP)
  const out = leads.filter(l => {
    const name = l.company || '';
    const words = name.match(/\b\w+\b/g) || [];
    const hits = words.filter(w => pattern.test(w)).length;
    if (hits >= 2) {
      console.log(`[PreFilter] Excluded "${name}" — ${hits} blocklist hits for ${industry} ICP`);
      return false;
    }
    return true;
  });

  // Safety escape: if pre-filter would remove >80% of leads, bypass it entirely
  // Better to let Haiku classify a few bad leads than return 0 leads
  if (out.length < leads.length * 0.20 && leads.length >= 5) {
    console.warn(`[PreFilter] Bypassed — would have removed ${leads.length - out.length}/${leads.length} leads (>80%). Sending all to Haiku.`);
    return leads;
  }

  console.log(`[PreFilter] ${out.length}/${leads.length} passed (2+ keyword threshold)`);
  return out;
}

function normalizePerson(p, source) {
  // Normalize contact shape from people/search and contacts/search into one format.
  // Apollo mixed_people/api_search returns obfuscated data on some plans:
  //   - last_name_obfuscated instead of last_name
  //   - no combined `name` field — must build from first_name + last_name_obfuscated
  //   - organization.name instead of organization_name
  //   - no linkedin_url on the free tier
  const org = p.organization || p.account || {};
  const name = p.name
    || (p.first_name && (p.last_name || p.last_name_obfuscated)
        ? `${p.first_name} ${p.last_name || p.last_name_obfuscated}`.trim()
        : (p.first_name || null));
  const company = p.organization_name || org.name || org.short_description || null;
  // Apollo's response shape varies by tier and contact — try every known path
  // before giving up. org.domain and org.primary_domain_url are populated for
  // some contacts where the primary three fields are null.
  const website = p.website_url
    || org.website_url
    || org.primary_domain
    || org.domain
    || org.primary_domain_url
    || null;
  const employeeCount = p.organization_num_employees || org.estimated_num_employees || org.employees || null;
  return {
    name,
    title: p.title,
    company,
    company_size: fmtEmp(employeeCount),
    website,
    linkedin_url: p.linkedin_url || p.linkedin_url_obfuscated || null,
    // LinkedIn headline — Apollo scrapes this from LinkedIn profiles. Far more specific
    // than org.industry tags. "VP Strategy at Gov of Estonia | EU Policy Advisor" is
    // an instant sector signal without any additional web request.
    _headline: p.headline || null,
    _source: source
  };
}

// ── ICP Translation Agent — converts human-readable ICP to Apollo-optimized params ──
// Runs before every Apollo search. Uses Claude Haiku (~$0.001/call) to:
//   1. Expand job titles into 10-15 LinkedIn-indexed variants (primary + extended tiers)
//   2. Map industry descriptions to Apollo's taxonomy
//   3. Flag if employee range may be too restrictive for the geography
// Result: reliable lead retrieval across all prospect types (EU pharma, US tech, APAC, etc.)
async function translateIcpForApollo(icp) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const rawTitles     = Array.isArray(icp?.apollo_titles)     && icp.apollo_titles.length     ? icp.apollo_titles     : (icp?.role ? [icp.role] : []);
  // apollo_keyword (single free-text phrase) is the new schema — fall back to legacy
  // apollo_industries array for jobs created before the cutover.
  const rawIndustries = (typeof icp?.apollo_keyword === 'string' && icp.apollo_keyword.trim())
    ? [icp.apollo_keyword.trim()]
    : (Array.isArray(icp?.apollo_industries) && icp.apollo_industries.length
        ? icp.apollo_industries
        : (icp?.industry ? [icp.industry] : []));
  const rawGeo        = Array.isArray(icp?.apollo_geography)  && icp.apollo_geography.length  ? icp.apollo_geography  : [];

  if (!rawTitles.length && !rawIndustries.length) {
    console.log('[ICP Translator] No titles or keyword to translate — skipping');
    return icp; // nothing to translate, return as-is
  }

  // Fallback prompt in case DB fetch fails
  const fallbackPrompt = `You are an expert at translating B2B ICP (Ideal Customer Profile) data into Apollo.io search parameters.

Apollo.io indexes job titles exactly as they appear on LinkedIn profiles. Many professional titles are abbreviated, shortened, or phrased differently.

Given this ICP:
- Target job titles: ${JSON.stringify(rawTitles)}
- Industries: ${JSON.stringify(rawIndustries)}
- Geography: ${JSON.stringify(rawGeo)}
- Company size: ${icp?.company_size || 'not specified'}
- Employee ranges (Apollo format): ${JSON.stringify(icp?.apollo_employee_ranges || [])}

You have three axes to target people:
1. Seniority (person_seniorities[]): Closed enum. Valid values are: "owner", "founder", "c_suite", "partner", "vp", "head", "director", "manager", "senior", "entry", "intern".
2. Department (person_department_or_subdepartments[]): Closed enum. Common values: "c_suite", "product", "engineering_technical", "design", "education", "finance", "human_resources", "information_technology", "legal", "marketing", "medical_health", "operations", "sales", "consulting".
3. Titles (person_titles[]): Free text. Use real LinkedIn conventions, abbreviations (CMO, CTO), and avoid overly generic titles alone.

For industries, generate a SINGLE 'q_keywords' string (e.g. "saas b2b software") instead of an industry tag, because Apollo org search uses strict AND logic for tags.
For geography (organization_locations[]), use English names (e.g. "United States", "Mexico").

Your task is to generate:
1. An "apollo_payload" object containing the optimal search filters for this ICP.
2. A "confidence_map" mapping each parameter to "high", "medium", or "low" confidence.
3. A "relaxation_order" array specifying the order in which parameters should be relaxed (removed/expanded) if we get fewer than 25 leads. Relax the least important or most restrictive filters first.

Output ONLY valid JSON matching this exact schema:
{
  "apollo_payload": {
    "person_titles": [],
    "person_seniorities": [],
    "person_department_or_subdepartments": [],
    "q_keywords": "",
    "organization_locations": [],
    "organization_num_employees_ranges": [],
    "contact_email_status": ["verified"],
    "per_page": 25
  },
  "confidence_map": {
    "person_titles": "high|medium|low",
    "person_seniorities": "high|medium|low",
    "person_department_or_subdepartments": "high|medium|low",
    "q_keywords": "high|medium|low",
    "organization_locations": "high|medium|low",
    "organization_num_employees_ranges": "high|medium|low"
  },
  "relaxation_order": [ "q_keywords", "organization_num_employees_ranges", "person_department_or_subdepartments", "organization_locations", "person_seniorities", "person_titles" ]
}`;

  let finalPrompt = fallbackPrompt;
  try {
    const r = await supabaseRequest('GET', '/rest/v1/prompts?slug=eq.icp_translation&limit=1');
    if (r && r.body && Array.isArray(r.body) && r.body.length > 0 && r.body[0].content) {
      finalPrompt = r.body[0].content
        .replace(/\{\{\s*rawTitles\s*\}\}/g, JSON.stringify(rawTitles))
        .replace(/\{\{\s*rawIndustries\s*\}\}/g, JSON.stringify(rawIndustries))
        .replace(/\{\{\s*rawGeo\s*\}\}/g, JSON.stringify(rawGeo))
        .replace(/\{\{\s*companySize\s*\}\}/g, icp?.company_size || 'not specified')
        .replace(/\{\{\s*employeeRanges\s*\}\}/g, JSON.stringify(icp?.apollo_employee_ranges || []));
      console.log('[ICP Translator] Loaded prompt from DB');
    }
  } catch (e) {
    console.warn('[ICP Translator] Failed to fetch prompt from DB, using fallback:', e.message);
  }

  try {
    console.log('[ICP Translator] Translating ICP for Apollo — titles:', rawTitles.length, ', industries:', rawIndustries.length);
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1000,
      messages: [{ role: 'user', content: finalPrompt }]
    });

    const raw = msg.content?.[0]?.text?.trim() || '';
    // Strip markdown code fences if present
    const jsonStr = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
    const parsed = JSON.parse(jsonStr);

    console.log(`[ICP Translator] ✓ Translation complete. Relaxation order: ${parsed.relaxation_order?.join(' > ') || 'fallback'}`);

    return {
      ...icp,
      apollo_payload: parsed.apollo_payload || {},
      confidence_map: parsed.confidence_map || {},
      relaxation_order: parsed.relaxation_order || [],
      _translated: true
    };
  } catch (e) {
    console.warn('[ICP Translator] Translation failed — using original ICP:', e.message);
    return icp; // fail-safe: use original ICP unchanged
  }
}

// ── EU countries list for Apollo geo expansion ─────────────────────────────────
const EU_COUNTRIES = [
  'Austria','Belgium','Bulgaria','Croatia','Cyprus','Czech Republic','Denmark',
  'Estonia','Finland','France','Germany','Greece','Hungary','Ireland','Italy',
  'Latvia','Lithuania','Luxembourg','Malta','Netherlands','Poland','Portugal',
  'Romania','Slovakia','Slovenia','Spain','Sweden',
  // Common non-EU European markets often meant when prospects say "Europe"
  'United Kingdom','Norway','Switzerland','Iceland'
];

// ── v3 Apollo Pipeline Functions ──────────────────────────────────────────────

const VALID_SENIORITIES = new Set([
  'owner', 'founder', 'c_suite', 'partner', 'vp',
  'head', 'director', 'manager', 'senior', 'entry', 'intern'
]);

const VALID_EMAIL_STATUSES = new Set([
  'verified', 'unverified', 'likely to engage', 'unavailable'
]);

const EMPLOYEE_RANGE_REGEX = /^\d+,\d+$/;

function sanitizeApolloPayload(payload) {
  const sanitized = { ...payload };
  const warnings = [];

  // Validate seniorities
  if (sanitized.person_seniorities) {
    const before = sanitized.person_seniorities.length;
    sanitized.person_seniorities = sanitized.person_seniorities.filter(s =>
      VALID_SENIORITIES.has(s)
    );
    if (sanitized.person_seniorities.length < before)
      warnings.push(`Removed ${before - sanitized.person_seniorities.length} invalid seniorities`);
  }

  // contact_email_status — the new api_search endpoint ignores this filter and returns 0.
  // Remove it to allow the search to return results (has_email is returned per contact).
  if (sanitized.contact_email_status) {
    delete sanitized.contact_email_status;
  }

  // Validate employee ranges format
  if (sanitized.organization_num_employees_ranges) {
    sanitized.organization_num_employees_ranges =
      sanitized.organization_num_employees_ranges.filter(r => EMPLOYEE_RANGE_REGEX.test(r) || r === '10001+');
  }

  // Ensure q_keywords is string not array
  if (Array.isArray(sanitized.q_keywords)) {
    sanitized.q_keywords = sanitized.q_keywords.join(' ');
  }
  // Normalize q_keywords (free text) → q_organization_keyword_tags as a SINGLE tag.
  // Apollo's mixed_people/api_search ignores q_keywords (returns 0 results) and
  // applies AND logic across multiple keyword tags. Putting the entire phrase as
  // one tag keeps it OR-style and preserves industry filtering. We do NOT split
  // on whitespace — that's the historical bug that killed EU coverage.
  if (typeof sanitized.q_keywords === 'string' && sanitized.q_keywords.trim()) {
    const phrase = sanitized.q_keywords.trim();
    if (!Array.isArray(sanitized.q_organization_keyword_tags) || sanitized.q_organization_keyword_tags.length === 0) {
      sanitized.q_organization_keyword_tags = [phrase];
    }
  }
  // Cap q_organization_keyword_tags to a single tag — multiple tags AND-collapse
  // to zero results. The industry signal is now a single phrase by design.
  if (Array.isArray(sanitized.q_organization_keyword_tags) && sanitized.q_organization_keyword_tags.length > 1) {
    warnings.push(`Capped q_organization_keyword_tags from ${sanitized.q_organization_keyword_tags.length} → 1 (AND-trap avoidance)`);
    sanitized.q_organization_keyword_tags = [sanitized.q_organization_keyword_tags[0]];
  }

  // Validate revenue (integers or null)
  if (sanitized.revenue_range) {
    if (sanitized.revenue_range.min !== null && !Number.isInteger(sanitized.revenue_range.min))
      sanitized.revenue_range.min = null;
    if (sanitized.revenue_range.max !== null && !Number.isInteger(sanitized.revenue_range.max))
      sanitized.revenue_range.max = null;
    if (!sanitized.revenue_range.min && !sanitized.revenue_range.max)
      delete sanitized.revenue_range;
  }

  // Normalize technology uids
  if (sanitized.currently_using_any_of_technology_uids) {
    sanitized.currently_using_any_of_technology_uids =
      sanitized.currently_using_any_of_technology_uids.map(t =>
        t.toLowerCase().replace(/[\\s.]/g, '_')
      );
  }

  // Remove empty arrays (can cause Apollo to return 0)
  Object.keys(sanitized).forEach(key => {
    if (Array.isArray(sanitized[key]) && sanitized[key].length === 0)
      delete sanitized[key];
  });

  return { payload: sanitized, warnings };
}

async function preflightCompanyCheck(payload) {
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) return { companiesFound: 0 };

  const companyFilters = {};
  // q_keywords is FREE TEXT for company search. Do NOT split into q_organization_keyword_tags —
  // tag-mode applies AND logic and collapses results (especially for EU/non-US markets).
  // Pass the entire phrase as a single free-text query.
  if (payload.q_keywords) companyFilters.q_keywords = String(payload.q_keywords).trim();
  if (payload.organization_num_employees_ranges) companyFilters.organization_num_employees_ranges = payload.organization_num_employees_ranges;
  if (payload.organization_locations) companyFilters.organization_locations = payload.organization_locations;
  if (payload.revenue_range) companyFilters.revenue_range = payload.revenue_range;

  if (Object.keys(companyFilters).length === 0) return { companiesFound: -1 }; // Skip if no org filters

  try {
    const res = await fetch('https://api.apollo.io/v1/organizations/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json',
        'x-api-key': APOLLO_KEY
      },
      body: JSON.stringify({ ...companyFilters, per_page: 1 }),
      signal: AbortSignal.timeout(10000)
    });
    if (!res.ok) return { companiesFound: 0 };
    const data = await res.json();
    return { companiesFound: data.pagination?.total_entries || 0 };
  } catch (e) {
    console.warn('[preflightCompanyCheck] Error:', e.message);
    return { companiesFound: -1 };
  }
}

function relaxFilter(payload, filterName) {
  switch (filterName) {
    case 'revenue_range':
    case 'currently_using_any_of_technology_uids':
      delete payload[filterName];
      return 'removed';

    case 'organization_num_employees_ranges': {
      const ALL = ['1,10','11,20','21,50','51,100','101,200','201,500',
                   '501,1000','1001,2000','2001,5000','5001,10000', '10001+'];
      const indices = payload[filterName].map(r => ALL.indexOf(r)).filter(i => i >= 0);
      if (indices.length === 0) { delete payload[filterName]; return 'removed'; }
      const lo = Math.max(0, Math.min(...indices) - 1);
      const hi = Math.min(ALL.length - 1, Math.max(...indices) + 1);
      payload[filterName] = ALL.slice(lo, hi + 1);
      return 'expanded';
    }

    case 'q_keywords': {
      const words = payload.q_keywords.split(' ');
      if (words.length > 1) {
        payload.q_keywords = words.slice(0, Math.ceil(words.length / 2)).join(' ');
        return 'simplified';
      }
      delete payload.q_keywords;
      return 'removed';
    }

    case 'q_organization_keyword_tags':
      // Single industry tag — broaden by removing it entirely (the keyword phrase
      // is the most expendable filter; titles + seniority + size + geo carry the rest).
      delete payload.q_organization_keyword_tags;
      return 'removed';

    case 'person_department_or_subdepartments':
      delete payload[filterName];
      return 'removed';

    case 'organization_locations':
    case 'person_locations':
      delete payload[filterName];
      return 'removed';

    case 'person_seniorities': {
      const HIER = ['intern','entry','senior','manager','director','head','vp','partner','c_suite','founder','owner'];
      const idxs = payload[filterName].map(s => HIER.indexOf(s)).filter(i => i >= 0);
      if (idxs.length === 0) { delete payload[filterName]; return 'removed'; }
      const lo = Math.max(0, Math.min(...idxs) - 1);
      const hi = Math.min(HIER.length - 1, Math.max(...idxs) + 1);
      const expanded = new Set(payload[filterName]);
      expanded.add(HIER[lo]);
      expanded.add(HIER[hi]);
      payload[filterName] = [...expanded];
      return 'expanded';
    }

    case 'person_titles':
      payload.include_similar_titles = true;
      return 'expanded_similar';

    default:
      delete payload[filterName];
      return 'removed';
  }
}

async function guaranteedLeadSearch(sanitizedPayload, confidenceMap, relaxationOrder) {
  const MIN_LEADS = 25;
  const MAX_ATTEMPTS = 6;
  const APOLLO_KEY = process.env.APOLLO_API_KEY;

  if (!APOLLO_KEY) return { leads: [], totalAvailable: 0, finalPayload: sanitizedPayload, relaxationLog: [], wasRelaxed: false };

  let currentPayload = { ...sanitizedPayload };
  let attempt = 0;
  let log = [];

  // ── Protected filters: never auto-stripped during relaxation ──────────────
  // Geography and industry-keyword are core ICP signals. Relaxing them produces
  // generic global leads instead of prospect-specific ones, which violates the
  // product principle "specific leads only, no fillers." If Apollo can't return
  // ≥25 leads without dropping these, we return what's available + the
  // "Market too small" UI label.
  const protectedFilters = new Set();
  if (Array.isArray(sanitizedPayload.organization_locations) && sanitizedPayload.organization_locations.length > 0) {
    protectedFilters.add('organization_locations');
  }
  if (Array.isArray(sanitizedPayload.q_organization_keyword_tags) && sanitizedPayload.q_organization_keyword_tags.length > 0) {
    protectedFilters.add('q_organization_keyword_tags');
  }
  if (protectedFilters.size > 0) {
    log.push({ step: 'protected', filters: [...protectedFilters] });
    console.log('[Apollo] Protected filters (will not be relaxed):', [...protectedFilters]);
  }

  const apolloPeopleSearch = async (payload) => {
    try {
      const body = {
        per_page: Math.max(payload.per_page || 50, MIN_LEADS),
        page: 1,
        ...payload
      };
      // sort_by_field: 'person_name' was rejected by Apollo's api_search backend
      // ("Fielddata is disabled on [person_name] in [people_v5]" — Elasticsearch
      // can't sort on a text field). Strip both sort params explicitly in case the
      // translator-built payload re-introduces them.
      delete body.sort_by_field;
      delete body.sort_ascending;
      // q_keywords is not supported by the api_search endpoint — it causes 0 results.
      // preflightCompanyCheck still uses it via q_organization_keyword_tags.
      delete body.q_keywords;
      
      const res = await fetch('https://api.apollo.io/api/v1/mixed_people/api_search', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Accept': 'application/json',
          'x-api-key': APOLLO_KEY
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000)
      });
      if (!res.ok) {
        console.error(`[Apollo] People search HTTP ${res.status} — body:`, await res.text().catch(() => '(unreadable)'));
        return { total_entries: 0, people: [] };
      }
      const data = await res.json();
      console.log(`[Apollo] People search raw response: total=${data.total_entries}, people=${data.people?.length}`);
      
      const people = (data.people || []).filter(p => {
        const n = normalizePerson(p, 'apollo');
        return n.name && n.name.length > 2 && n.title && n.company;
      }).map(p => normalizePerson(p, 'apollo'));

      return { total_entries: data.total_entries || 0, people };
    } catch(e) {
      console.error('[apolloPeopleSearch] exception:', e.message);
      return { total_entries: 0, people: [] };
    }
  };

  // ── STEP 1: Pre-flight company check ──
  const preflight = await preflightCompanyCheck(currentPayload);
  log.push({ step: 'preflight', companiesFound: preflight.companiesFound });

  if (preflight.companiesFound === 0) {
    // Only strip filters that are NOT protected. q_keywords mirrors
    // q_organization_keyword_tags (set by sanitizeApolloPayload), so if industry
    // is protected we leave q_keywords alone too — they carry the same signal.
    if (currentPayload.q_keywords && !protectedFilters.has('q_organization_keyword_tags')) {
      log.push({ action: 'removed', filter: 'q_keywords', reason: 'preflight_zero_companies' });
      delete currentPayload.q_keywords;
    }
    if (currentPayload.organization_num_employees_ranges) {
      log.push({ action: 'removed', filter: 'organization_num_employees_ranges', reason: 'preflight_zero_companies' });
      delete currentPayload.organization_num_employees_ranges;
    }
    if (currentPayload.revenue_range) {
      log.push({ action: 'removed', filter: 'revenue_range', reason: 'preflight_zero_companies' });
      delete currentPayload.revenue_range;
    }
  }

  // ── STEP 2: Initial people search ──
  let results = await apolloPeopleSearch(currentPayload);
  log.push({ step: 'initial_search', totalResults: results.total_entries, filtersUsed: Object.keys(currentPayload) });

  // ── STEP 3: Progressive relaxation loop ──
  let relaxIdx = 0;

  while (results.total_entries < MIN_LEADS && attempt < MAX_ATTEMPTS) {
    attempt++;

    let filterToRelax = null;
    while (relaxIdx < relaxationOrder.length) {
      const candidate = relaxationOrder[relaxIdx];
      relaxIdx++;
      // Skip protected filters — never auto-strip geography or industry keyword.
      if (protectedFilters.has(candidate)) {
        log.push({ step: 'skip_protected', attempt, filter: candidate });
        continue;
      }
      if (currentPayload[candidate] !== undefined) {
        filterToRelax = candidate;
        break;
      }
    }

    if (!filterToRelax) {
      // Nuclear fallback — keep titles + any protected filters (geo and/or industry)
      const nuclear = {
        person_titles: currentPayload.person_titles,
        per_page: 25
      };
      if (currentPayload.organization_locations) nuclear.organization_locations = currentPayload.organization_locations;
      if (currentPayload.person_locations) nuclear.person_locations = currentPayload.person_locations;
      // Preserve industry keyword tag through the nuclear path when protected.
      if (protectedFilters.has('q_organization_keyword_tags') && currentPayload.q_organization_keyword_tags) {
        nuclear.q_organization_keyword_tags = currentPayload.q_organization_keyword_tags;
      }

      currentPayload = nuclear;
      log.push({ step: 'nuclear_fallback', attempt });
      results = await apolloPeopleSearch(currentPayload);
      break;
    }

    const action = relaxFilter(currentPayload, filterToRelax);
    log.push({ step: 'relax', attempt, filter: filterToRelax, action });

    results = await apolloPeopleSearch(currentPayload);
    log.push({ step: 'search', attempt, totalResults: results.total_entries });
  }

  // ── STEP 4: Final absolute fallback ──
  // Skipped entirely when protected filters are set — returning fewer specific
  // leads (UI shows "Market too small") is preferred over many non-specific ones.
  if (results.total_entries < MIN_LEADS && protectedFilters.size === 0) {
    currentPayload = {
      person_titles: sanitizedPayload.person_titles || [],
      per_page: 25
    };
    results = await apolloPeopleSearch(currentPayload);
    log.push({ step: 'absolute_fallback', totalResults: results.total_entries });
  } else if (results.total_entries < MIN_LEADS && protectedFilters.size > 0) {
    log.push({ step: 'absolute_fallback_skipped', reason: 'protected_filters_set', protectedFilters: [...protectedFilters] });
    console.log('[Apollo] Absolute fallback skipped — protected filters are set, returning narrow result set instead');
  }

  return {
    leads: results.people?.slice(0, 50) || [],
    totalAvailable: results.total_entries,
    finalPayload: currentPayload,
    relaxationLog: log,
    wasRelaxed: attempt > 0
  };
}

async function fetchLeadsFromApollo(icp) {
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) { console.log('[Apollo] No API key — skipping'); return null; }

  // Fallback for Phase 2: map legacy ICP to Apollo Payload
  const rawGeo = Array.isArray(icp?.apollo_geography) && icp.apollo_geography.length ? icp.apollo_geography : null;
  const apolloGeo = rawGeo
    ? rawGeo.flatMap(g => (/^european union$/i.test(g) || /^europe$/i.test(g)) ? EU_COUNTRIES : [g]).filter((g, i, a) => a.indexOf(g) === i)
    : [];

  const sizeRanges = (Array.isArray(icp?.apollo_employee_ranges) && icp.apollo_employee_ranges.length)
    ? icp.apollo_employee_ranges
    : (icp?.company_size ? mapCompanySize(icp.company_size) : []);

  // apollo_keyword (single free-text phrase, e.g. "property management") is the
  // new industry signal. Falls back to first value of legacy apollo_industries
  // for jobs created before the cutover.
  const keywordPhrase = (typeof icp?.apollo_keyword === 'string' && icp.apollo_keyword.trim())
    ? icp.apollo_keyword.trim()
    : (Array.isArray(icp?.apollo_industries) && icp.apollo_industries.length
        ? String(icp.apollo_industries[0] || '').trim()
        : '');

  const legacyPayload = {
    person_titles: Array.isArray(icp?.apollo_titles) && icp.apollo_titles.length ? icp.apollo_titles : [],
    organization_locations: apolloGeo,
    organization_num_employees_ranges: sizeRanges,
    person_seniorities: Array.isArray(icp?.person_seniorities) && icp.person_seniorities.length ? icp.person_seniorities : [],
    per_page: 50
  };
  // Pass the keyword as q_keywords (string). sanitizeApolloPayload normalizes
  // this to a SINGLE-TAG q_organization_keyword_tags, avoiding Apollo's AND-trap.
  if (keywordPhrase) legacyPayload.q_keywords = keywordPhrase;

  const defaultRelaxationOrder = [
    "revenue_range",
    "currently_using_any_of_technology_uids",
    "organization_num_employees_ranges",
    "q_organization_keyword_tags", // industry phrase — drop early if results are tight
    "q_keywords",                  // fallback name (some translator outputs still use it)
    "person_department_or_subdepartments",
    "organization_locations",
    "person_seniorities",
    "person_titles"
  ];

  // Use apollo_payload from ICP translator only if it has actual query fields.
  // An empty {} object is truthy but would cause Apollo to return 0 results.
  const hasTranslatedPayload = icp.apollo_payload && Object.keys(icp.apollo_payload).length > 0;
  const { payload: sanitizedPayload, warnings } = sanitizeApolloPayload(hasTranslatedPayload ? icp.apollo_payload : legacyPayload);
  if (!hasTranslatedPayload) console.log('[Apollo] apollo_payload empty/missing — using legacyPayload');
  if (warnings.length > 0) console.log('[Apollo] Sanitize warnings:', warnings);

  console.log('[Apollo] sanitizedPayload keys:', Object.keys(sanitizedPayload));
  console.log('[Apollo] sanitizedPayload:', JSON.stringify(sanitizedPayload));
  console.log('[Apollo] Starting v3 guaranteed lead search...');
  const result = await guaranteedLeadSearch(
    sanitizedPayload, 
    icp.confidence_map || {}, 
    icp.relaxation_order || defaultRelaxationOrder
  );

  console.log(`[Apollo] v3 Search Complete: ${result.leads.length} leads returned. TAM: ${result.totalAvailable}. Was relaxed: ${result.wasRelaxed}`);
  
  // Expose wasRelaxed and relaxationLog at top level for handleLeadList
  return { 
    leads: result.leads, 
    total: result.totalAvailable, 
    tamSource: 'apollo',
    wasRelaxed: result.wasRelaxed,
    relaxationLog: result.relaxationLog,
    finalPayload: result.finalPayload,
    diagnostics: { 
      relaxationLog: result.relaxationLog,
      finalPayload: result.finalPayload
    } 
  };
}

// ── Webinar titles generation ─────────────────────────────────────────────────
async function generateWebinarTitles(extracted, companyName) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const icp = extracted.icp || {};
  const role = icp.role || 'business owners', industry = icp.industry || 'B2B';
  const size = icp.company_size || '', geo = icp.geography;
  // Brief schema uses angle.pain/result; spec schema uses customer_pain/result_delivered — support both
  const pain   = extracted.customer_pain   || extracted.angle?.pain   || 'unpredictable client acquisition';
  const result = extracted.result_delivered || extracted.angle?.result || 'predictable revenue growth';
  const cs     = extracted.case_study || null;
  const outputSchema = `\nRuntime rules: write as ${companyName} hosting — NEVER as Quantum Scaling • titles HARD LIMIT 60 chars • bullets = specific transformations, not topics • ${cs?.numbers ? 'proof numbers verbatim: ' + cs.numbers : 'no fabricated proof numbers'}\nReturn valid JSON only matching the Output Format schema above.`;
  let systemPrompt, userPrompt;
  if (WEBINAR_SYSTEM_TEMPLATE) {
    const businessContext = [
      `- Company: ${companyName}`,
      `- Their clients are: ${role}s at ${size ? size + ' ' : ''}companies in ${industry}`,
      `- Core pain they solve: ${pain}`,
      `- Result they deliver: ${result}`,
      cs?.numbers ? `- Client proof: ${cs.client_description || 'A client'} — ${cs.result || ''} (${cs.numbers})` : null,
      (extracted.webinar_angle || extracted.context?.why_webinar) ? `- Webinar angle: ${extracted.webinar_angle || extracted.context?.why_webinar}` : null
    ].filter(Boolean).join('\n');
    systemPrompt = interpolate(WEBINAR_SYSTEM_TEMPLATE, {
      prospect_company_name: companyName, icp_role: role, icp_industry: industry,
      business_context_block: businessContext,
      format_rules_block:    WEBINAR_FALLBACK_FORMAT || '(use best-practice direct-response structure)',
      principles_block:      '- Write as the prospect company hosting, never Quantum Scaling\n- Front-load ICP role in title first 40 chars\n- Every bullet is a transformation promise, not a topic',
      examples_block:        '(none loaded)'
    }) + outputSchema;
    userPrompt = interpolate(WEBINAR_USER_TEMPLATE, {
      prospect_company_name: companyName, icp_role: role, icp_company_size: size, icp_industry: industry,
      icp_geography_line:   geo ? `\n**Geography:** ${geo}` : '',
      customer_pain: pain, result_delivered: result,
      case_study_block:    cs?.result ? `**Client proof:** ${cs.client_description || 'A client'} — ${cs.result}${cs.numbers ? ' (' + cs.numbers + ')' : ''}` : '',
      webinar_angle_block: (extracted.webinar_angle || extracted.context?.why_webinar) ? `**Webinar angle:** ${extracted.webinar_angle || extracted.context?.why_webinar}` : ''
    });
  } else {
    systemPrompt = `You are a direct-response copywriter writing calendar blocker copy for ${companyName}'s webinar targeting ${role}s in ${industry}. Write as ${companyName} hosting — never as Quantum Scaling. Return valid JSON only.` + outputSchema;
    userPrompt   = `Generate 3 calendar blocker variants for ${companyName}'s webinar targeting ${role}s in ${industry}${size ? ' (' + size + ' companies)' : ''}.\nPain: ${pain}\nResult: ${result}`;
  }
  console.log('[webinar_titles] Calling Claude Sonnet...');
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 2000, temperature: 0.7,
    system: systemPrompt, messages: [{ role: 'user', content: userPrompt }]
  });
  const raw = message.content[0].text;
  try { return JSON.parse(raw); }
  catch(e) { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); throw new Error('webinar_titles: unparseable JSON'); }
}

// ── ROI model math ────────────────────────────────────────────────────────────
function parseLtv(s) {
  if (typeof s === 'number') return s;
  if (!s) return null;
  const clean = s.toString().replace(/[$,\s]/g, '').toUpperCase();
  const match = clean.match(/^([\d.]+)([KM]?)$/);
  if (!match) return null;
  let val = parseFloat(match[1]);
  if (match[2] === 'K') val *= 1000;
  if (match[2] === 'M') val *= 1000000;
  return isNaN(val) ? null : val;
}
function parseRate(s, defaultVal) {
  if (!s) return defaultVal;
  const n = parseFloat(s.toString().replace('%', ''));
  if (isNaN(n)) return defaultVal;
  return n > 1 ? n / 100 : n;
}
function calcRoiProjections(ltv, closeRate, showRate) {
  // Phase 1 params
  const p1 = { prospects: 7500, reg: 0.005, attend: 0.35, book: 0.08 };
  // Phase 2 params
  const p2 = { prospects: 50000, reg: 0.008, attend: 0.50, book: 0.18 };
  const show1 = showRate, close1 = closeRate;
  const show2 = Math.min(showRate + 0.14, 1.0), close2 = Math.min(closeRate + 0.04, 1.0);
  const rev1 = p1.prospects * p1.reg * p1.attend * p1.book * show1 * close1 * ltv;
  const rev2 = p2.prospects * p2.reg * p2.attend * p2.book * show2 * close2 * ltv;
  const revRamp = (rev1 + rev2) / 2;
  // Webinar schedule: bi-weekly starting week 5
  // Phase 1: weeks 5,7,9,11 → 4 webinars
  // Ramp: weeks 13,15,17,19 → 4 webinars
  // Phase 2: weeks 21,23,... → bi-weekly
  function totalRevenue(maxWeeks) {
    let total = 0;
    for (let w = 5; w <= maxWeeks; w += 2) {
      if (w <= 12)        total += rev1;
      else if (w <= 20)   total += revRamp;
      else                total += rev2;
    }
    return Math.round(total);
  }
  return {
    revenue_6mo:  totalRevenue(26),
    revenue_12mo: totalRevenue(52),
    revenue_24mo: totalRevenue(104),
    rev1_per_webinar: Math.round(rev1),
    rev2_per_webinar: Math.round(rev2)
  };
}

// ── Load a prompt from DB by slug, with hardcoded fallback ───────────────────
async function loadPromptFromDB(slug, fallback) {
  try {
    const r = await supabaseRequest('GET', `/rest/v1/prompts?slug=eq.${encodeURIComponent(slug)}&limit=1`);
    if (r?.body?.[0]?.content) {
      console.log(`[prompts] Loaded "${slug}" from DB`);
      return r.body[0].content;
    }
  } catch(e) {
    console.warn(`[prompts] Could not load "${slug}" from DB, using fallback:`, e.message);
  }
  return fallback;
}

// ── Calendar visual: reminder emails ─────────────────────────────────────────
async function generateReminderEmails(title, hostName, resultDelivered, customerPain, prospectCompany) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const fallback = `You are writing short reminder email previews for a webinar registration confirmation sequence. Return valid JSON only. No markdown.

Generate 3 reminder email previews for this webinar:

Webinar title: ${title}
Host name: ${hostName}
What attendees will learn: ${resultDelivered || 'practical strategies'}
Who this is for: ${customerPain || 'business owners looking to grow'}
Prospect company being served: ${prospectCompany || 'the attendee\'s firm'}

Requirements:
- Email 1 (1 week before): Confirm registration, build excitement, reference what they will specifically learn
- Email 2 (24 hours before): Create urgency, mention host opens room early
- Email 3 (1 hour before): Very punchy, 1-2 sentences max

Return this exact JSON:
{"emails":[{"timing":"1 week before","subject":"string — max 10 words","preview":"string — 2-3 sentences, reference the webinar topic specifically"},{"timing":"24 hours before","subject":"string — max 10 words","preview":"string — 2-3 sentences, create urgency"},{"timing":"1 hour before","subject":"string — max 10 words","preview":"string — 1-2 sentences, very punchy"}]}`;
  const promptText = await loadPromptFromDB('email_reminder', fallback);
  const userContent = promptText
    .replace(/\{\{webinar_title\}\}/g, title || '')
    .replace(/\{\{host_name\}\}/g, hostName || '')
    .replace(/\{\{result_delivered\}\}/g, resultDelivered || 'practical strategies')
    .replace(/\{\{customer_pain\}\}/g, customerPain || 'business owners looking to grow')
    .replace(/\{\{prospect_company\}\}/g, prospectCompany || 'the attendee\'s firm');
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 700, temperature: 0.7,
    messages: [{ role: 'user', content: userContent }]
  });
  const raw = msg.content[0].text;
  try { return JSON.parse(raw); }
  catch(e) { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return null; }
}

// ── Webinar mock: live chat messages ─────────────────────────────────────────
async function generateChatMessages(title, icp, customerPain, resultDelivered, hostName) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const fallback = `You are generating realistic live chat messages for a webinar. Return valid JSON only. No markdown.

Generate 18 live chat messages for this webinar:

Webinar title: ${title}
Target audience role: ${icp?.role || 'business owners'}
Target audience industry: ${icp?.industry || 'B2B'}
Core problem they face: ${customerPain || 'growing their business'}
Result they want: ${resultDelivered || 'more revenue'}
Host / company name: ${hostName}

Requirements:
- 14 attendee messages: realistic first names, short messages (max 15 words), mix of questions + reactions + struggles that reference the specific industry and pain points above
- 4 support team messages from "${hostName} Team": encourage booking a call, answer questions naturally
- Messages should feel chronologically natural
- Attendee questions MUST reference the webinar topic and industry specifically

Return:
{"messages":[{"sender":"string","text":"string — max 15 words","is_team":boolean,"timestamp":"string e.g. 12:14 PM"}]}`;
  const promptText = await loadPromptFromDB('chat_messages', fallback);
  const userContent = promptText
    .replace(/\{\{webinar_title\}\}/g, title || '')
    .replace(/\{\{icp_role\}\}/g, icp?.role || 'business owners')
    .replace(/\{\{icp_industry\}\}/g, icp?.industry || 'B2B')
    .replace(/\{\{customer_pain\}\}/g, customerPain || 'growing their business')
    .replace(/\{\{result_delivered\}\}/g, resultDelivered || 'more revenue')
    .replace(/\{\{host_name\}\}/g, hostName || 'Your Host');
  const msg = await anthropic.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 900, temperature: 0.7,
    messages: [{ role: 'user', content: userContent }]
  });
  const raw = msg.content[0].text;
  try { return JSON.parse(raw); }
  catch(e) { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return null; }
}

// ── TASK HANDLERS ─────────────────────────────────────────────────────────────

// ── Phase 3: Read approved calls from DB before hitting Fireflies API ────────
async function findApprovedCallsFromDB(email) {
  if (!email) return [];
  try {
    const r = await supabaseRequest(
      'GET',
      `/rest/v1/calls?status=eq.approved&order=date.desc&limit=20`,
      null,
      { 'Accept-Profile': 'public' }
    );
    if (r.status !== 200 || !Array.isArray(r.body)) return [];
    // Filter client-side: attendee email must match
    const emailLower = email.toLowerCase();
    const matched = r.body.filter(call => {
      let att = call.attendees || [];
      if (typeof att === 'string') { try { att = JSON.parse(att); } catch(e) { att = []; } }
      return att.some(a => (a.email || '').toLowerCase() === emailLower);
    });
    console.log(`[extract] DB approved calls for ${email}: ${matched.length} found`);
    return matched;
  } catch(e) {
    console.warn('[extract] findApprovedCallsFromDB error:', e.message);
    return [];
  }
}

// Convert a DB call row into the same shape handleExtract expects from Fireflies
function dbCallToTranscript(call) {
  let summary = call.summary || {};
  if (typeof summary === 'string') { try { summary = JSON.parse(summary); } catch(e) { summary = {}; } }
  return {
    id:         call.id,
    title:      call.title || '(untitled)',
    duration:   call.duration || 0,
    dateString: call.date ? new Date(call.date).toLocaleDateString('en-US') : '',
    summary
  };
}

async function handleExtract(task, job) {
  const email = job.prospect_email || '';
  const defaultDomain = job.prospect_website || email.split('@')[1];
  const contactInfo = {
    name:    job.prospect_name    || null,
    company: job.prospect_company || null,
    website: defaultDomain        || null
  };
  console.log(`[extract] Processing job ${job.id} for ${email}`);

  // Step 1: transcript source — approved calls from DB first, live Fireflies as fallback
  let transcripts = [];
  let transcriptSource = 'none';

  const dbApproved = await findApprovedCallsFromDB(email);
  if (dbApproved.length > 0) {
    transcripts = dbApproved.map(dbCallToTranscript);
    transcriptSource = 'db_approved';
    console.log(`[extract] Using ${transcripts.length} approved DB call(s) for ${email}`);
  } else {
    transcripts = await findFirefliesTranscripts(email);
    transcriptSource = transcripts.length > 0 ? 'live_fireflies' : 'none';
    console.log(`[extract] DB approved: 0 — falling back to live Fireflies (${transcripts.length} found)`);
  }

  const transcriptFound = transcripts.length > 0;

  // Step 2: Website
  const website = await scrapeWebsite(defaultDomain);

  // Step 3: Build extraction content — aggregate ALL call summaries into one block
  const parts = [];

  if (transcripts.length) {
    transcripts.forEach((transcript, idx) => {
      const s = transcript.summary || {};
      const label = transcripts.length > 1 ? `CALL ${idx + 1} OF ${transcripts.length}` : 'CALL';
      parts.push([
        `${label}: ${transcript.title} (${(transcript.duration || 0).toFixed(0)} min)`,
        s.shorthand_bullet ? `DETAILED NOTES:\n${s.shorthand_bullet}` : '',
        s.overview         ? `METRICS OVERVIEW:\n${s.overview}` : '',
        s.short_summary    ? `SUMMARY:\n${s.short_summary}` : '',
        s.action_items     ? `ACTION ITEMS:\n${s.action_items}` : ''
      ].filter(Boolean).join('\n\n'));
    });
  }

  if (website.bodyText || website.title) {
    parts.push([
      `WEBSITE (${defaultDomain}):`,
      website.title    ? `Title: ${website.title}` : '',
      website.metaDesc ? `Description: ${website.metaDesc}` : '',
      website.bodyText ? `Content:\n${website.bodyText}` : ''
    ].filter(Boolean).join('\n'));
  }
  // Always include domain-derived name as anchor for Claude
  const domainAnchor = defaultDomain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  parts.unshift(`DOMAIN: ${defaultDomain}\nDERIVED NAME FROM DOMAIN: ${domainAnchor}\n(Use this as the company name if a clearer branded name is not found in the content below)`);

  if (!parts.length) parts.push(`Prospect email: ${email}\nDomain: ${defaultDomain}`);

  // Step 4: Claude extraction (extractBriefFromTranscript is the only extractor defined)
  const extracted = await extractBriefFromTranscript(parts.join('\n\n---\n\n'), website.bodyText || '', contactInfo);

  // Company name cleanup: vague descriptions → use domain
  if (extracted.prospect) {
    const rawCompany = (extracted.prospect.company || '').trim();
    const isVague = rawCompany.split(/\s+/).length > 2 ||
                    /name not provided|not (given|stated|mentioned|found)|unknown|n\/a/i.test(rawCompany) ||
                    /^(a |the )?(boutique|management|project|consulting|advisory|professional|services?|company|firm|business|organization|agency)\b/i.test(rawCompany);
    if (isVague) {
      extracted.prospect.company = domainAnchor;
      console.log(`[extract] Company cleanup: "${rawCompany}" → "${domainAnchor}"`);
    }
  }

  // Embed transcript + website meta into extracted
  const firstT = transcripts[0] || null;
  extracted._meta = {
    transcript: firstT
      ? { id: firstT.id, title: firstT.title, date: firstT.dateString, found: true, source: transcriptSource, count: transcripts.length }
      : { found: false, source: 'none' },
    website: { domain: defaultDomain, title: website.title, scraped: !!(website.bodyText) }
  };

  // Update prospect_company on the job row
  const company = extracted.prospect?.company || contactInfo.company || defaultDomain;
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${job.id}`, {
    prospect_company: company,
    prospect_name:    extracted.prospect?.contact_name || contactInfo.name || null,
    updated_at:       new Date().toISOString()
  });
  await updateJobExtractedData(job.id, extracted);

  return { extracted, transcriptFound, transcriptSource, websiteScraped: !!(website.bodyText), company };
}

async function handleProspectResearch(task, job) {
  const linkedinUrl = job.prospect_linkedin_url;
  console.log(`[prospect_research] ${linkedinUrl ? 'Scraping ' + linkedinUrl : 'No LinkedIn URL — completing with null'}`);

  if (!linkedinUrl) {
    await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: null }, scraped: false });
    return { host: null, scraped: false };
  }

  try {
    // LinkedIn profile via Apify — harvestapi/linkedin-profile-scraper (LpVuK3Zozwuipa5bp)
    // Confirmed working: input key is 'urls' (not 'profileUrls')
    // Output schema: firstName, lastName, headline, about, profilePicture/photo
    const items = await runApifyActor('LpVuK3Zozwuipa5bp', {
      urls: [linkedinUrl]
    }, 90000);

    const profile = items?.[0];
    if (!profile) {
      console.warn('[prospect_research] Apify returned no profile');
      await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: linkedinUrl }, scraped: false });
      return { host: null, scraped: false };
    }

    // Normalise field names — harvestapi uses firstName + lastName (no combined fullName)
    const fullName = (profile.firstName && profile.lastName)
      ? `${profile.firstName} ${profile.lastName}`.trim()
      : (profile.fullName || profile.name || null);
    const headline = profile.headline || profile.title || null;
    const photo    = profile.profilePicture || profile.photo || profile.photoUrl || null;
    const summary  = profile.about || profile.summary || '';

    if (!fullName) {
      console.warn('[prospect_research] Apify profile missing name:', JSON.stringify(profile).slice(0,200));
      await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: linkedinUrl }, scraped: false });
      return { host: null, scraped: false };
    }

    // Use Claude Haiku to write a short professional bio
    let bio = null;
    if (headline) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6', max_tokens: 300, temperature: 0,
        system: 'You are writing a short professional bio for a webinar host. Write in third person. 2–3 sentences maximum. Confident and credible tone. Focus on their expertise and who they help. Do not mention the webinar.',
        messages: [{ role: 'user', content: `Write a short host bio from this LinkedIn data:\n\nName: ${fullName}\nHeadline: ${headline}\nSummary: ${summary}\n\nReturn only the bio text. No labels, no markdown.` }]
      });
      bio = msg.content[0].text.trim();
    }

    const researchData = {
      host: {
        name:         fullName,
        title:        headline || null,
        bio,
        headshot_url: photo || null,
        linkedin_url: linkedinUrl
      },
      scraped: true
    };
    await updateJobResearchData(job.id, researchData);
    console.log(`[prospect_research] Done via Apify: name=${fullName}, headshot=${!!photo}, bio=${!!bio}`);
    return researchData;
  } catch(e) {
    console.warn('[prospect_research] Apify failed:', e.message);
    await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: linkedinUrl }, scraped: false });
    return { host: null, scraped: false };
  }
}

// ── Image-based color extraction — extract dominant colors from an image URL ──
async function extractColorsFromImage(imageUrl) {
  try {
    const response = await fetch(imageUrl, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return [];
    const buffer = Buffer.from(await response.arrayBuffer());
    const { data } = await sharp(buffer)
      .resize(50, 50, { fit: 'cover' })
      .raw()
      .toBuffer({ resolveWithObject: true });

    // Count quantized color frequencies
    const colorCounts = {};
    for (let i = 0; i < data.length; i += 3) {
      const r = Math.round(data[i] / 16) * 16;
      const g = Math.round(data[i+1] / 16) * 16;
      const b = Math.round(data[i+2] / 16) * 16;
      const hex = `#${r.toString(16).padStart(2,'0')}${g.toString(16).padStart(2,'0')}${b.toString(16).padStart(2,'0')}`;
      colorCounts[hex] = (colorCounts[hex] || 0) + 1;
    }

    // Filter out near-white, near-black, near-gray
    const isNearNeutral = (hex) => {
      const r = parseInt(hex.slice(1,3), 16);
      const g = parseInt(hex.slice(3,5), 16);
      const b = parseInt(hex.slice(5,7), 16);
      const max = Math.max(r, g, b), min = Math.min(r, g, b);
      const saturation = max === 0 ? 0 : (max - min) / max;
      if (saturation < 0.15 && (max > 200 || max < 50)) return true; // near white/black/gray
      return false;
    };

    return Object.entries(colorCounts)
      .sort((a, b) => b[1] - a[1])
      .filter(([hex]) => !isNearNeutral(hex))
      .slice(0, 3)
      .map(([hex]) => hex);
  } catch(e) {
    console.warn('[extractColorsFromImage] error:', e.message);
    return [];
  }
}

async function handleBrandScrape(task, job) {
  const website = job.prospect_website;
  console.log(`[brand_scrape] ${website ? 'Scraping ' + website : 'No website — completing with null'}`);

  const nullOutput = { logo_url: null, favicon_url: null, primary_color: null, secondary_color: null, accent_color: null, all_colors: [], tagline: null, company_name: null, website_summary: null, images: [], scraped: false, source: 'none' };

  if (!website) {
    await updateJobBrandData(job.id, nullOutput);
    return nullOutput;
  }

  const domain = website.replace(/^https?:\/\//, '').replace(/\/$/, '');

  // Use existing scrapeWebsite() — already runs Jina + raw HTML in parallel, no extra cost
  let scraped = { html: '', bodyText: '', title: '', metaDesc: '' };
  try { scraped = await scrapeWebsite(domain); }
  catch(e) { console.warn('[brand_scrape] scrapeWebsite failed:', e.message); }

  const html     = scraped.html     || '';
  const bodyText = scraped.bodyText || '';

  if (!html && !bodyText) {
    await updateJobBrandData(job.id, { ...nullOutput, scraped: false });
    return nullOutput;
  }

  // ── 1. LOGO: 4-path waterfall ────────────────────────────────────────────────
  const resolveUrl = (src) => {
    if (!src) return null;
    src = src.split(' ')[0].trim();
    if (src.startsWith('http')) return src;
    if (src.startsWith('//'))   return 'https:' + src;
    if (src.startsWith('/'))    return `https://${domain}${src}`;
    return `https://${domain}/${src}`;
  };

  let logoUrl = null;

  // Path 1: og:image
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
  if (ogImage) logoUrl = resolveUrl(ogImage);

  // Path 2: <img> / <source> with "logo" in class, id, alt, or src
  if (!logoUrl) {
    const logoPatterns = [
      /<img[^>]+(?:class|id|alt)=["'][^"']*logo[^"']*["'][^>]+src=["']([^"']+)["']/i,
      /<img[^>]+src=["']([^"']+)["'][^>]+(?:class|id|alt)=["'][^"']*logo[^"']*["']/i,
      /<img[^>]+src=["']([^"']*logo[^"'"]*)["']/i,
      /<source[^>]+srcset=["']([^"']*logo[^"'"]+\.(?:png|svg|webp|jpg)[^"' ]*)["' ]/i,
    ];
    for (const p of logoPatterns) {
      const m = html.match(p);
      if (m?.[1]) { logoUrl = resolveUrl(m[1]); break; }
    }
  }

  // Path 3: Apple touch icon or high-res <link rel="icon">
  if (!logoUrl) {
    const iconMatch =
      html.match(/<link[^>]+rel=["']apple-touch-icon(?:-precomposed)?["'][^>]+href=["']([^"']+)["']/i) ||
      html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']apple-touch-icon(?:-precomposed)?["']/i) ||
      html.match(/<link[^>]+rel=["']icon["'][^>]+sizes=["'](?:192|180|128|96|64)x\d+["'][^>]+href=["']([^"']+)["']/i);
    if (iconMatch?.[1]) logoUrl = resolveUrl(iconMatch[1]);
  }

  // Path 4: Google Favicon CDN — guaranteed, free, no API key (already used in portal nav)
  const faviconUrl = `https://www.google.com/s2/favicons?domain=${domain}&sz=256`;
  if (!logoUrl) logoUrl = faviconUrl;

  // ── 2. COLORS: 4-path waterfall ──────────────────────────────────────────────
  const isValidColor = (c) => {
    if (!c || !/^#[0-9a-fA-F]{3,8}$/.test(c)) return false;
    // Normalize 3-char hex to 6-char
    let hex = c.replace('#','');
    if (hex.length === 3) hex = hex[0]+hex[0]+hex[1]+hex[1]+hex[2]+hex[2];
    if (hex.length < 6) return false;
    const r = parseInt(hex.substr(0,2), 16), g = parseInt(hex.substr(2,2), 16), b = parseInt(hex.substr(4,2), 16);
    // Filter near-white (luminance > 0.92) and near-black (luminance < 0.08)
    const lum = (0.299*r + 0.587*g + 0.114*b) / 255;
    if (lum > 0.92 || lum < 0.08) return false;
    // Filter grays with no saturation
    const max = Math.max(r,g,b), min = Math.min(r,g,b);
    if ((max - min) < 20) return false;
    return true;
  };
  const allColors = [];
  let primaryColor = null, secondaryColor = null, accentColor = null;

  // Path 1: theme-color meta
  const themeColor =
    html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
    html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i)?.[1];
  if (isValidColor(themeColor)) { primaryColor = themeColor; allColors.push(themeColor); }

  // Path 2: CSS variables in inline <style> blocks
  const styleBlocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(m => m[1]).join('\n');
  const parseCssColors = (css) => ({
    primary:   [...css.matchAll(/--(?:primary|brand-primary|color-primary|theme-primary|main-color|key-color|color-brand)\s*:\s*(#[0-9a-fA-F]{3,8})/gi)].map(m=>m[1]).filter(isValidColor),
    secondary: [...css.matchAll(/--(?:secondary|brand-secondary|color-secondary|theme-secondary)\s*:\s*(#[0-9a-fA-F]{3,8})/gi)].map(m=>m[1]).filter(isValidColor),
    accent:    [...css.matchAll(/--(?:accent|highlight|cta|button-color|action|color-cta|link-color)\s*:\s*(#[0-9a-fA-F]{3,8})/gi)].map(m=>m[1]).filter(isValidColor),
  });
  const inline = parseCssColors(styleBlocks);
  if (!primaryColor   && inline.primary[0])   { primaryColor   = inline.primary[0];   allColors.push(primaryColor); }
  if (!secondaryColor && inline.secondary[0]) { secondaryColor = inline.secondary[0]; allColors.push(secondaryColor); }
  if (!accentColor    && inline.accent[0])    { accentColor    = inline.accent[0];    allColors.push(accentColor); }

  // Path 3: Fetch linked CSS files — KEY FIX for Wix/Webflow/Squarespace
  // Modern builders load all CSS variables from external .css files, never inline.
  if (!primaryColor) {
    const cssLinks = [...html.matchAll(/<link[^>]+rel=["']stylesheet["'][^>]+href=["']([^"']+\.css[^"']*)["']/gi)]
      .map(m => m[1])
      .map(h => h.startsWith('http') ? h : h.startsWith('//') ? 'https:'+h : `https://${domain}${h.startsWith('/')?h:'/'+h}`)
      .slice(0, 3);
    if (cssLinks.length) {
      const cssTexts = await Promise.all(cssLinks.map(async url => {
        try { const r = await fetch(url, {signal:AbortSignal.timeout(3000)}); return r.ok ? await r.text() : ''; }
        catch { return ''; }
      }));
      const ext = parseCssColors(cssTexts.join('\n'));
      if (!primaryColor   && ext.primary[0])   { primaryColor   = ext.primary[0];   allColors.push(primaryColor); }
      if (!secondaryColor && ext.secondary[0]) { secondaryColor = ext.secondary[0]; allColors.push(secondaryColor); }
      if (!accentColor    && ext.accent[0])    { accentColor    = ext.accent[0];    allColors.push(accentColor); }
      console.log(`[brand_scrape] CSS files: ${cssLinks.length} checked, primary=${primaryColor || 'none'}`);
    }
  }

  // Path 4: Background colors from inline style attributes (last resort)
  if (!primaryColor) {
    const bgMatches = [...html.matchAll(/background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,8})/gi)].map(m=>m[1]).filter(isValidColor);
    if (bgMatches[0]) { primaryColor = bgMatches[0]; allColors.push(bgMatches[0]); }
  }

  // Path 5: Extract dominant colors from hero/og:image pixels (no external API)
  if (!primaryColor) {
    const imgUrl = ogImage ? resolveUrl(ogImage) : null;
    if (imgUrl) {
      try {
        const imgColors = await extractColorsFromImage(imgUrl);
        if (imgColors.length >= 1 && !primaryColor)   { primaryColor   = imgColors[0]; allColors.push(imgColors[0]); }
        if (imgColors.length >= 2 && !secondaryColor)  { secondaryColor = imgColors[1]; allColors.push(imgColors[1]); }
        if (imgColors.length >= 3 && !accentColor)     { accentColor    = imgColors[2]; allColors.push(imgColors[2]); }
        console.log(`[brand_scrape] Image color extraction: ${imgColors.length} colors from og:image`);
      } catch(e) { console.warn('[brand_scrape] Image color extraction failed:', e.message); }
    }
  }

  // ── 3. IMAGE COLLECTION (max 8, typed: hero / team / general) ────────────────
  const images = [];
  const skipImg  = /icon|flag|avatar|pixel|tracking|analytics|sprite|arrow|chevron|placeholder|spacer|blank/i;
  const heroImg  = /hero|banner|header|main|cover|background|bg-|slide/i;
  const teamImg  = /team|people|staff|about|office|founder|headshot|portrait/i;
  const seenImgs = new Set();

  const addImage = (url, alt = '') => {
    if (!url || !url.startsWith('http') || seenImgs.has(url) || skipImg.test(url)) return;
    seenImgs.add(url);
    const sig = (url + ' ' + alt).toLowerCase();
    images.push({ url, alt: alt.slice(0, 100), type: heroImg.test(sig) ? 'hero' : teamImg.test(sig) ? 'team' : 'general' });
  };

  // og:image and twitter:image (highest quality — curated by site owner)
  [...html.matchAll(/<meta[^>]+(?:property=["']og:image["']|name=["']twitter:image["'])[^>]+content=["']([^"']+)["']/gi)]
    .forEach(m => addImage(m[1]));

  // Large or meaningfully-alt'd <img> tags
  [...html.matchAll(/<img([^>]+)>/gi)].forEach(m => {
    if (images.length >= 8) return;
    const attrs = m[1];
    const src = attrs.match(/src=["']([^"']+)["']/i)?.[1];
    const alt = attrs.match(/alt=["']([^"']*)["']/i)?.[1] || '';
    const w   = parseInt(attrs.match(/width=["']?(\d+)/i)?.[1]  || '0');
    const h   = parseInt(attrs.match(/height=["']?(\d+)/i)?.[1] || '0');
    if (!src) return;
    const resolved = resolveUrl(src);
    if (resolved && (w >= 200 || h >= 150 || alt.length >= 5) && !skipImg.test(resolved)) addImage(resolved, alt);
  });

  // ── 4. METADATA + WEBSITE SUMMARY ────────────────────────────────────────────
  const tagline = scraped.metaDesc?.slice(0, 200) ||
    html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,})["']/i)?.[1]?.slice(0, 200) || null;

  const siteName    = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
  const titleTag    = scraped.title?.split(/[|\-\u2013\u2014]/)[0]?.trim();
  const companyName = siteName || titleTag || job.prospect_company || null;

  // website_summary: first 600 chars of Jina-rendered text — shown in Source Intelligence panel
  const websiteSummary = bodyText.slice(0, 600) || null;

  const brandData = {
    scraped:          true,
    source:           'html',
    domain:           domain,           // raw domain scraped (e.g. xeleratio.com)
    company_name:     companyName,
    tagline:          tagline?.trim() || null,
    website_summary:  websiteSummary,
    logo_url:         logoUrl,
    favicon_url:      faviconUrl,
    primary_color:    primaryColor,
    secondary_color:  secondaryColor,
    accent_color:     accentColor,
    all_colors:       [...new Set(allColors)].filter(isValidColor).slice(0, 6),
    images:           images.slice(0, 8),
  };

  await updateJobBrandData(job.id, brandData);
  console.log(`[brand_scrape] Done: logo=${!!logoUrl}, color=${primaryColor||'none'}, images=${images.length}, summary=${websiteSummary?.length||0}chars`);
  return brandData;
}

// ── Website quality filter — verify leads match ICP ──────────────────────────
async function filterLeadsByWebsite(leads, icpKeywords) {
  const CONCURRENCY = 5;
  const TIMEOUT_MS  = 4000;
  const qualified   = [];

  for (let i = 0; i < leads.length; i += CONCURRENCY) {
    const batch = leads.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async (lead) => {
      if (!lead.website) return lead; // No website — keep (benefit of doubt)
      try {
        const domain  = lead.website.replace(/^https?:\/\//, '').split('/')[0];
        const scraped = await Promise.race([
          scrapeWebsite(domain),
          new Promise(resolve => setTimeout(() => resolve(null), TIMEOUT_MS))
        ]);
        if (!scraped?.bodyText) return lead; // Can't scrape — keep
        const content = (scraped.bodyText + ' ' + (scraped.title || '') + ' ' + (scraped.metaDesc || '')).toLowerCase();
        const hits    = icpKeywords.filter(kw => content.includes(kw));
        if (!icpKeywords.length || hits.length > 0) return lead;
        console.log(`[filter] Dropped: ${domain} (no ICP keyword match)`);
        return null;
      } catch(e) { return lead; } // Scrape error — keep
    }));
    qualified.push(...results.filter(Boolean));
  }
  return qualified.slice(0, 25);
}

async function handleLeadList(task, job) {
  // Brief is stored in extracted_data — confirmed by rep before job was created
  const brief = job.extracted_data || {};
  const icp   = brief.icp || {};

  // Pass the full ICP — do NOT reconstruct a subset. apollo_geography, apollo_employee_ranges,
  // apollo_keyword, person_seniorities are all needed by fetchLeadsFromApollo.
  console.log('[lead_list] ICP from brief:', JSON.stringify(icp));

  // ── B2C short-circuit ─────────────────────────────────────────────────────
  // Apollo is a B2B contact database. If the prospect's target audience is consumers
  // (homeowners, residents, end-users), no amount of filter relaxation produces leads.
  // Detect via explicit flag from extractor, OR via heuristic on titles.
  const B2C_TITLE_TOKENS = /\b(homeowner|home\s?owner|resident|tenant|consumer|customer|end[-\s]?user|buyer|individual|prospect)\b/i;
  const titleLooksB2C = Array.isArray(icp.apollo_titles) &&
    icp.apollo_titles.length > 0 &&
    icp.apollo_titles.every(t => B2C_TITLE_TOKENS.test(String(t || '')));
  const isB2C = icp.target_audience_type === 'b2c' || titleLooksB2C;
  if (isB2C) {
    const msg = 'Target audience is consumers (B2C). Apollo is a B2B contact database — manual list or alternate data source needed.';
    console.warn('[lead_list] B2C target detected — routing to needs_input:', msg);
    if (task?.id) await needsInputTask(task.id, msg);
    return null; // signal needs_input — worker will not mark completed
  }

  // ICP Translator (translateIcpForApollo) was previously called here to expand
  // titles + map industries via Sonnet. Removed because the non-deterministic
  // output frequently introduced over-restrictive fields (e.g.
  // person_department_or_subdepartments) that returned 0 leads, forcing reps
  // to manually re-run. Skipping it makes first-run identical to rerun:
  // fetchLeadsFromApollo sees icp.apollo_payload === undefined and uses
  // legacyPayload built from the rep's exact ICP fields.
  const result = await fetchLeadsFromApollo(icp);
  const leads  = result?.leads || [];
  // fetchLeadsFromApollo returns { total }; legacy callers used { totalAvailable }
  const tam    = result?.total ?? result?.totalAvailable ?? 0;
  // Lloyd's rep-proof outreach formula:
  // TAM > 300K → cap at 100K/mo (QS practical maximum)
  // TAM ≤ 300K → exhaust market in exactly 3 months
  const recommendedOutreach = tam > 300000
    ? 100000
    : tam > 0 ? Math.max(1000, Math.round(tam / 3 / 1000) * 1000) : 30000;
  console.log(`[lead_list] Apollo returned ${leads.length} classified leads, TAM: ${tam}, Outreach: ${recommendedOutreach}/mo`);
  // Phase 4: fire apollo_warning notification if fewer than 5 leads
  if (leads.length < 5) {
    await createNotification({
      type:  'apollo_warning',
      title: `Low leads: only ${leads.length} found`,
      body:  `Apollo returned fewer than 5 leads. Consider broadening the ICP filters.`,
      jobId: task?.job_id || null
    });
  }
  return { 
    leads, 
    total: tam, 
    recommendedOutreach, 
    tamSource: 'apollo_api_live',
    apollo_diagnostics: {
      wasRelaxed: result?.wasRelaxed || false,
      relaxationLog: result?.relaxationLog || [],
      finalPayload: result?.finalPayload || {}
    }
  };
}

async function handleWebinarTitles(task, job) {
  const extracted = job.extracted_data;
  if (!extracted) throw new Error('webinar_titles: extracted_data missing');
  const company = extracted.prospect?.company || job.prospect_company || job.prospect_website || 'Your Company';
  const result = await generateWebinarTitles(extracted, company);
  return result;
}

async function handleRoiModel(task, job) {
  const extracted = job.extracted_data;
  // Brief schema stores under metrics; spec schema uses business — support both
  const rawLtv = extracted?.metrics?.ltv || extracted?.business?.ltv;

  if (!rawLtv) {
    await needsInputTask(task.id, 'Missing: LTV — rep must enter manually');
    return null; // signal needs_input
  }
  const ltv = parseLtv(rawLtv);
  if (!ltv) {
    await needsInputTask(task.id, `Could not parse LTV from "${rawLtv}" — rep must enter manually`);
    return null;
  }

  const closeRate = parseRate(extracted?.metrics?.close_rate || extracted?.business?.close_rate, 0.20);
  const showRate  = parseRate(extracted?.metrics?.show_rate  || extracted?.business?.show_rate,  0.70);
  const projections = calcRoiProjections(ltv, closeRate, showRate);

  if (!ROI_MODEL_TEMPLATE) throw new Error('roi_model.html template not loaded');

  const company = extracted?.prospect?.company || job.prospect_company || 'Your Company';
  const htmlContent = interpolate(ROI_MODEL_TEMPLATE, {
    COMPANY_NAME:     company,
    LTV:              ltv,
    CLOSE_RATE:       Math.round(closeRate * 100),
    SHOW_RATE:        Math.round(showRate * 100),
    REVENUE_6MO:      projections.revenue_6mo.toLocaleString(),
    REVENUE_12MO:     projections.revenue_12mo.toLocaleString(),
    REVENUE_24MO:     projections.revenue_24mo.toLocaleString(),
    REV1_PER_WEBINAR: projections.rev1_per_webinar.toLocaleString(),
    REV2_PER_WEBINAR: projections.rev2_per_webinar.toLocaleString(),
    CLOSE_RATE_SOURCE: (extracted?.metrics?.close_rate || extracted?.business?.close_rate) ? 'extracted from transcript' : 'default (20%)',
    SHOW_RATE_SOURCE:  (extracted?.metrics?.show_rate  || extracted?.business?.show_rate)  ? 'extracted from transcript' : 'default (70%)'
  });

  const storagePath = `${job.id}/roi_model.html`;
  const publicUrl = await storageUpload(storagePath, htmlContent);
  console.log(`[roi_model] Uploaded: ${publicUrl}`);

  return {
    url: publicUrl,
    inputs_used: {
      ltv, close_rate: closeRate, show_rate: showRate,
      close_rate_source: (extracted?.metrics?.close_rate || extracted?.business?.close_rate) ? 'extracted' : 'default',
      show_rate_source:  (extracted?.metrics?.show_rate  || extracted?.business?.show_rate)  ? 'extracted' : 'default'
    },
    projections
  };
}

async function handleCalendarVisual(task, job) {
  // Fetch dependencies
  const webinarTitlesTask = await getTaskOutput(job.id, 'webinar_titles');
  if (!webinarTitlesTask || webinarTitlesTask.status !== 'completed') {
    throw new Error('DEPS_PENDING: calendar_visual waiting for webinar_titles');
  }
  const titles = webinarTitlesTask.output_data?.variants || webinarTitlesTask.output_data?.titles || [];
  const variant = titles[0];
  if (!variant) throw new Error('calendar_visual: no title variant found');

  const extracted = job.extracted_data || {};
  const hostName  = job.research_data?.host?.name || extracted.prospect?.name || job.prospect_company || 'Your Host';
  const hostBio   = job.research_data?.host?.bio  || `${hostName} helps businesses grow through proven webinar strategies.`;

  const prospectCompany = extracted.prospect?.company || job.prospect_company || '';

  // Generate reminder emails via AI prompt
  const emailsResult = await generateReminderEmails(
    variant.title, hostName,
    extracted.result_delivered || extracted.angle?.result,
    extracted.customer_pain   || extracted.angle?.pain,
    prospectCompany
  ).catch(e => { console.warn('[calendar_visual] email gen failed:', e.message); return null; });
  const emails = emailsResult?.emails || [];

  // Next Tuesday ~3 weeks from now
  const eventDate = new Date();
  eventDate.setDate(eventDate.getDate() + 21);
  while (eventDate.getDay() !== 2) eventDate.setDate(eventDate.getDate() + 1);
  const dateStr = eventDate.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' }) + ' · 7:00 – 8:00pm';

  if (!CALENDAR_VISUAL_TEMPLATE) throw new Error('calendar_visual.html template not loaded');

  const description = variant.description || [
    variant.hook || '',
    ...(variant.bullets || []).map(b => `• ${b}`),
    variant.for_line ? `\nFor: ${variant.for_line}` : ''
  ].filter(Boolean).join('\n');

  const htmlContent = interpolate(CALENDAR_VISUAL_TEMPLATE, {
    EVENT_TITLE:       (variant.title || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    EVENT_DATE:        dateStr,
    EVENT_DESCRIPTION: (description || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\n/g, '<br>'),
    HOST_NAME:         (hostName || '').replace(/</g, '&lt;'),
    HOST_BIO:          (hostBio  || '').replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    EMAILS_JSON:       JSON.stringify(emails)
  });

  const storagePath = `${job.id}/calendar_visual.html`;
  const publicUrl   = await storageUpload(storagePath, htmlContent);
  console.log(`[calendar_visual] Uploaded: ${publicUrl}`);
  // Store full generated data in output_data so portal can read it directly
  return {
    url:        publicUrl,
    title:      variant.title,
    host_name:  hostName,
    event_date: dateStr,
    emails:     emails,          // ← portal reads this for reminder email copy
    hook:       variant.hook || '',
    bullets:    variant.bullets || [],
    for_line:   variant.for_line || ''
  };
}

async function handleWebinarMock(task, job) {
  // Fetch dependencies
  const webinarTitlesTask = await getTaskOutput(job.id, 'webinar_titles');
  if (!webinarTitlesTask || webinarTitlesTask.status !== 'completed') {
    throw new Error('DEPS_PENDING: webinar_mock waiting for webinar_titles');
  }
  const titles = webinarTitlesTask.output_data?.variants || webinarTitlesTask.output_data?.titles || [];
  const variant = titles[0];
  if (!variant) throw new Error('webinar_mock: no title variant found');

  const extracted = job.extracted_data || {};
  const brandData  = job.brand_data   || {};
  const research   = job.research_data?.host || {};
  // Rep customizations from the Webinar Experience editor (edit-mode UI).
  // Each field below reads override-first, then falls back to brand_data / AI defaults.
  // Republish endpoint re-runs this handler so the public asset reflects edits.
  const overrides = extracted._webinar_overrides || {};
  const ov = (k) => (overrides[k] !== undefined && overrides[k] !== null && overrides[k] !== '') ? overrides[k] : null;

  const primaryColor   = ov('primary_color')   || brandData.primary_color   || '#0D9488';
  const secondaryColor = ov('secondary_color') || brandData.secondary_color || '#1F2937';
  const logoUrl        = ov('logo_url')        ?? brandData.logo_url        ?? '';
  const companyName    = ov('company_name')    || brandData.company_name    || extracted.prospect?.company || job.prospect_company || 'Your Company';
  const hostName       = ov('host_name')       || research.name             || extracted.prospect?.name    || companyName;

  // Find best hero image from brand scrape; rep override takes precedence
  const heroImage = (brandData.images || []).find(i => i.type === 'hero') || (brandData.images || [])[0];
  const heroImageUrl = ov('background_url') || heroImage?.url || '';

  // Generate chat messages via AI prompt
  const chatResult = await generateChatMessages(
    variant.title, extracted.icp,
    extracted.customer_pain   || extracted.angle?.pain,
    extracted.result_delivered || extracted.angle?.result,
    hostName
  ).catch(e => { console.warn('[webinar_mock] chat gen failed:', e.message); return null; });
  const messages = chatResult?.messages || [];

  // Generate timestamps starting 12:05 PM, 30-90s apart
  let startTime = 12 * 60 + 5;
  const timedMessages = messages.map((m) => {
    const t = startTime;
    startTime += 30 + Math.floor(Math.random() * 60);
    const h = Math.floor(t / 60) % 12 || 12;
    const min = (t % 60).toString().padStart(2, '0');
    const ampm = Math.floor(t / 60) >= 12 ? 'PM' : 'AM';
    return { ...m, timestamp: `${h}:${min} ${ampm}` };
  });

  // Attendee count: rep override or randomized in 750-1050 range
  const attendeeCount = (Number.isFinite(ov('attendee_count')) ? ov('attendee_count') : null)
    || (750 + Math.floor(Math.random() * 300));

  if (!WEBINAR_MOCK_TEMPLATE) throw new Error('webinar_mock.html template not loaded');

  const slide1Title    = ov('title')    || variant.title || '';
  const slide1Subtitle = ov('subtitle') || `How ${companyName} Grows Your Business`;
  const slide2Title    = ov('slide2_heading') || 'What You\'ll Learn Today';
  const bulletsList    = Array.isArray(ov('bullets')) && ov('bullets').length
    ? ov('bullets')
    : (variant.bullets || ['Proven system for getting clients', 'Step-by-step framework', 'How to scale predictably']).slice(0, 4);

  let htmlContent = interpolate(WEBINAR_MOCK_TEMPLATE, {
    EVENT_TITLE:      slide1Title.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    SLIDE1_TITLE:     slide1Title.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    SLIDE1_SUBTITLE:  slide1Subtitle.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    SLIDE2_TITLE:     slide2Title,
    BULLETS_JSON:     JSON.stringify(bulletsList),
    COMPANY_NAME:     companyName.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    HOST_NAME:        hostName.replace(/</g, '&lt;').replace(/>/g, '&gt;'),
    PRIMARY_COLOR:    primaryColor,
    SECONDARY_COLOR:  secondaryColor,
    LOGO_URL:         logoUrl,
    HERO_IMAGE_URL:   heroImageUrl,
    ATTENDEE_COUNT:   attendeeCount,
    MESSAGES_JSON:    JSON.stringify(timedMessages)
  });

  if (logoUrl) {
    htmlContent = htmlContent.replace(/\{\{#LOGO_URL\}\}([\s\S]*?)\{\{\/LOGO_URL\}\}/g, '$1');
    htmlContent = htmlContent.replace(/\{\{\^LOGO_URL\}\}[\s\S]*?\{\{\/LOGO_URL\}\}/g, '');
  } else {
    htmlContent = htmlContent.replace(/\{\{#LOGO_URL\}\}[\s\S]*?\{\{\/LOGO_URL\}\}/g, '');
    htmlContent = htmlContent.replace(/\{\{\^LOGO_URL\}\}([\s\S]*?)\{\{\/LOGO_URL\}\}/g, '$1');
  }

  const storagePath = `${job.id}/webinar_mock.html`;
  const publicUrl   = await storageUpload(storagePath, htmlContent);
  console.log(`[webinar_mock] Uploaded: ${publicUrl}`);
  // Store full generated data in output_data so portal can read it directly
  return {
    url:            publicUrl,
    title:          variant.title,
    host_name:      hostName,
    attendee_count: attendeeCount,
    messages:       timedMessages   // ← portal reads this for live chat
  };
}

// ── Stage orchestration — spawn new tasks when dependencies are met ───────────
async function checkAndSpawnStageTasks(jobId) {
  const tasks = await getTasksByJobId(jobId);
  const byType = {};
  tasks.forEach(t => { byType[t.task_type] = t; });

  const isTerminal = s => ['completed', 'failed', 'needs_input'].includes(s);

  // Stage 2: spawn when extract is completed
  const extractDone = byType['extract']?.status === 'completed';
  if (extractDone) {
    const stage2Types = ['brand_scrape', 'lead_list', 'webinar_titles', 'roi_model'];
    const toCreate = stage2Types.filter(t => !byType[t]);
    if (toCreate.length) {
      console.log(`[orchestrator] Spawning Stage 2 tasks: ${toCreate.join(', ')}`);
      await createTasks(jobId, toCreate);
    }
  }

  // Stage 3: spawn when brand_scrape is terminal AND webinar_titles completed AND prospect_research terminal
  const brandScrapeTerminal = byType['brand_scrape'] && isTerminal(byType['brand_scrape'].status);
  const webinarTitlesDone   = byType['webinar_titles']?.status === 'completed';
  const prospectResearchTerminal = !byType['prospect_research'] || isTerminal(byType['prospect_research'].status);

  if (brandScrapeTerminal && webinarTitlesDone && prospectResearchTerminal) {
    const stage3Types = ['calendar_visual', 'webinar_mock'];
    const toCreate = stage3Types.filter(t => !byType[t]);
    if (toCreate.length) {
      console.log(`[orchestrator] Spawning Stage 3 tasks: ${toCreate.join(', ')}`);
      await createTasks(jobId, toCreate);
    }
  }

  // Update job status: completed when all created tasks are terminal
  const allTasks = await getTasksByJobId(jobId);
  if (allTasks.length > 0 && allTasks.every(t => isTerminal(t.status))) {
    const anyFailed = allTasks.some(t => t.status === 'failed');
    const finalStatus = anyFailed ? 'failed' : 'completed';
    await updateJobStatus(jobId, finalStatus);
    // Phase 4: fire job_complete notification
    if (finalStatus === 'completed') {
      const jobRow = await supabaseRequest('GET', `/rest/v1/jobs?id=eq.${jobId}&select=prospect_email,prospect_company,rep_name`);
      const j = (jobRow.body || [])[0] || {};
      const label = j.prospect_company || j.prospect_email || jobId;
      await createNotification({
        type:  'job_complete',
        title: `Analysis complete: ${label}`,
        body:  `Deal Forge job finished for ${j.prospect_email || 'unknown'}`,
        jobId: jobId,
        repId: j.rep_name || null
      });
    }
  }
}

// ── Worker loop ───────────────────────────────────────────────────────────────
let workerBusy = false;

async function processNextTask() {
  if (workerBusy) return;
  workerBusy = true;
  try {
    const pending = await getPendingTasks(1);
    if (!pending.length) return;

    const task = pending[0];
    const claimed = await claimTask(task.id);
    if (!claimed) return; // another worker claimed it (shouldn't happen on single-server but safe)

    const job = await getJob(task.job_id);
    if (!job) { await retryOrFailTask(task, 'Parent job not found'); return; }

    console.log(`[worker] Running ${task.task_type} (task ${task.id}) for job ${task.job_id}`);

    try {
      let output = null;
      let assetUrl = null;

      switch (task.task_type) {
        case 'extract':           output = await handleExtract(task, job);           break;
        case 'prospect_research': output = await handleProspectResearch(task, job);  break;
        case 'brand_scrape':      output = await handleBrandScrape(task, job);       break;
        case 'lead_list':         output = await handleLeadList(task, job);          break;
        case 'webinar_titles':    output = await handleWebinarTitles(task, job);     break;
        case 'roi_model':         output = await handleRoiModel(task, job);          break;
        case 'calendar_visual':   output = await handleCalendarVisual(task, job);    break;
        case 'webinar_mock':      output = await handleWebinarMock(task, job);       break;
        default: throw new Error(`Unknown task type: ${task.task_type}`);
      }

      // null output = handler set its own status (needs_input) — don't override
      if (output !== null) {
        if (output?.url) assetUrl = output.url;
        await completeTask(task.id, output, assetUrl);
        console.log(`[worker] ✓ ${task.task_type} completed`);
      }

    } catch(e) {
      console.error(`[worker] ✗ ${task.task_type} failed:`, e.message);
      // DEPS_PENDING = dependency not ready yet, reschedule in ~15s (not a real failure)
      if (e.message?.includes('not yet completed') || e.message?.includes('DEPS_PENDING')) {
        await supabaseRequest('PATCH', `/rest/v1/tasks?id=eq.${task.id}`, {
          status: 'pending', started_at: null, updated_at: new Date().toISOString()
        });
        console.log(`[worker] ↻ ${task.task_type} rescheduled (deps not ready)`);
      } else {
        // Retry up to max_attempts, then fail permanently
        await retryOrFailTask(task, e.message);
      }
    }

    // Always check if new stage tasks should be spawned
    await checkAndSpawnStageTasks(task.job_id);

  } catch(e) {
    console.error('[worker] Uncaught error:', e.message);
  } finally {
    workerBusy = false;
  }
}

// ── Recovery cron — reset stuck processing tasks (>10 min) ───────────────────
async function resetStuckTasks() {
  try {
    const cutoff = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    const r = await supabaseRequest('PATCH',
      `/rest/v1/tasks?status=eq.processing&started_at=lt.${cutoff}`,
      { status: 'pending', started_at: null, updated_at: new Date().toISOString() },
      { 'Prefer': 'return=minimal' }
    );
    if (r.status < 400) console.log('[recovery] Reset stuck tasks (if any)');
  } catch(e) { console.warn('[recovery] Failed:', e.message); }
}

// ── PHASE 2: Call Library sync ─────────────────────────────────────────────────
// Pulls the most recent 100 Fireflies transcripts, computes a Q-Score (0-100)
// based on structural signals (no Claude call — fast + free), classifies call type,
// then upserts into the Supabase `calls` table.
// Rules for Q-Score:
//   +25  has shorthand_bullet notes (action items / detailed notes)
//   +20  has overview (metrics overview summary)
//   +15  has short_summary
//   +10  duration >= 20 min  (longer = more context)
//   +10  has >= 1 attendee with email
//   +5   title contains known call keywords (discovery, strategy, BEC, evaluation)
//   +5   has action_items
//   Deductions:
//   -20  duration < 5 min (likely accidental recording)
//   -10  title contains admin/internal keywords (standup, sync, team)
// Score range: 0–100 (clamped)
// Call type classification rules:
//   'bec'       — title matches: discovery, evaluation, bec, strategy session, call 1, consultation
//   'follow_up' — title matches: follow.?up, call 2, call 3, debrief, check.?in, proposal
//   'admin'     — title matches: standup, team, sync, internal, interview, 1.?on.?1
//   'unclassified' — default fallback
function classifyCallType(title = '') {
  const t = title.toLowerCase();
  if (/discovery|evaluation|bec|strategy session|call[\s_-]?1\b|consultation|intro call|intake/i.test(t)) return 'bec';
  if (/follow[\s-]?up|call[\s_-]?[23456]|debrief|check[\s-]?in|proposal|closing|pitch/i.test(t)) return 'follow_up';
  if (/standup|stand-up|team|internal|interview|1[\s-]on[\s-]1|onboard|training/i.test(t)) return 'admin';
  return 'unclassified';
}

function computeQScore(transcript) {
  let score = 0;
  const reasons = [];
  const s = transcript.summary || {};
  const dur = transcript.duration || 0;
  const title = (transcript.title || '').toLowerCase();
  const attendees = (transcript.meeting_attendees || []).filter(a => a.email);

  if (s.shorthand_bullet && s.shorthand_bullet.trim().length > 50) { score += 25; reasons.push('has detailed notes'); }
  if (s.overview         && s.overview.trim().length > 30)          { score += 20; reasons.push('has metrics overview'); }
  if (s.short_summary    && s.short_summary.trim().length > 30)     { score += 15; reasons.push('has summary'); }
  if (s.action_items     && s.action_items.trim().length > 10)      { score +=  5; reasons.push('has action items'); }
  if (dur >= 20)  { score += 10; reasons.push(`long call (${dur.toFixed(0)} min)`); }
  if (attendees.length >= 1) { score += 10; reasons.push(`${attendees.length} attendee email(s)`); }
  if (/discovery|evaluation|bec|strategy|consultation/i.test(title)) { score += 5; reasons.push('BEC/strategy keyword in title'); }

  // Deductions
  if (dur > 0 && dur < 5) { score -= 20; reasons.push('very short call (<5 min)'); }
  if (/standup|internal|team sync|interview/i.test(title)) { score -= 10; reasons.push('admin/internal call'); }

  return { q_score: Math.max(0, Math.min(100, score)), q_reasons: reasons };
}

async function syncFirefliesToCallLibrary() {
  console.log('[CallLib] Starting Fireflies sync...');
  const FULL_FIELDS = `id title duration date meeting_attendees { name email }
    summary { shorthand_bullet overview short_summary action_items }`;
  let allTranscripts = [];
  try {
    const d1 = await firefliesQuery(`{ transcripts(limit: 50) { ${FULL_FIELDS} } }`, {});
    allTranscripts.push(...(d1?.transcripts || []));
    const d2 = await firefliesQuery(`{ transcripts(limit: 50, skip: 50) { ${FULL_FIELDS} } }`, {});
    allTranscripts.push(...(d2?.transcripts || []));
  } catch(e) {
    console.error('[CallLib] Fireflies fetch error:', e.message);
    return [];
  }
  console.log(`[CallLib] Fetched ${allTranscripts.length} transcripts from Fireflies`);

  const upserted = [];
  for (const t of allTranscripts) {
    if (!t.id) continue;
    const { q_score, q_reasons } = computeQScore(t);
    const call_type = classifyCallType(t.title);
    // default status: admin → skipped, BEC/follow_up with q >= 50 → pending_review, else → pending_review
    const status = call_type === 'admin' && q_score < 30 ? 'skipped' : 'pending_review';

    const row = {
      id:           t.id,
      title:        t.title || '(untitled)',
      duration:     t.duration || null,
      date:         t.date ? new Date(t.date).toISOString() : null,
      attendees:    JSON.stringify(t.meeting_attendees || []),
      summary:      JSON.stringify(t.summary || {}),
      call_type,
      q_score,
      q_reasons:    JSON.stringify(q_reasons),
      status,
      synced_at:    new Date().toISOString(),
      raw_fireflies: JSON.stringify(t)
    };

    try {
      const r = await supabaseRequest('POST', '/rest/v1/calls', row,
        { 'Prefer': 'return=minimal,resolution=merge-duplicates', 'Content-Profile': 'public' });
      if (r.status < 300) { upserted.push({ id: t.id, title: t.title, call_type, q_score, status }); }
      else {
        if (upserted.length === 0) console.warn(`[CallLib] First upsert error body:`, JSON.stringify(r.body).slice(0,300));
        console.warn(`[CallLib] Upsert failed for ${t.id}: ${r.status}`);
      }
    } catch(e) { console.warn(`[CallLib] Upsert error for ${t.id}:`, e.message); }
  }
  console.log(`[CallLib] Sync complete: ${upserted.length}/${allTranscripts.length} upserted`);

  // Phase 4: fire in-app notifications for newly upserted BEC calls
  const newBecs = upserted.filter(u => u.call_type === 'bec');
  for (const bec of newBecs.slice(0, 5)) { // cap at 5 per sync to avoid flood
    await createNotification({
      type:   'new_bec',
      title:  `New BEC: ${bec.title}`,
      body:   `Q-Score: ${bec.q_score} · Status: ${bec.status}`,
      callId: bec.id
    });
  }
  if (newBecs.length > 0) console.log(`[CallLib] Fired ${Math.min(newBecs.length,5)} new_bec notifications`);

  return upserted;
}

// Start worker + recovery loops
if (USE_SUPABASE) {
  // Wrap each invocation in .catch() so a network error (ECONNRESET, ETIMEDOUT)
  // in one task cycle doesn't propagate to the top-level interval and silently
  // stop the worker. The outer try/catch in processNextTask already handles most
  // cases, but an unhandled rejection from an async timer edge-case can bypass it.
  setInterval(() => processNextTask().catch(e => console.error('[worker] Interval error:', e.message)), 3000);
  setInterval(() => resetStuckTasks().catch(e => console.error('[recovery] Interval error:', e.message)), 2 * 60 * 1000);
  // Phase 2: 6-hour background Fireflies sync safety net
  setInterval(() => syncFirefliesToCallLibrary().catch(e => console.error('[CallLib] Cron error:', e.message)), 6 * 60 * 60 * 1000);
  console.log('[worker] Started (3s interval)');
  console.log('[recovery] Started (2min interval)');
  console.log('[CallLib] 6-hour background sync scheduled');
} else {
  console.warn('[worker] NOT started — no Supabase config');
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    setCors(res); res.writeHead(204); res.end(); return;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // PHASE 2 — CALL LIBRARY API
  // ══════════════════════════════════════════════════════════════════════════

  // ── POST /api/calls/sync — pull recent Fireflies transcripts into `calls` table ──
  // Called manually from the Call Library tab, and by the 6-hour background cron.
  if (req.method === 'POST' && urlPath === '/api/calls/sync') {
    setCors(res);
    try {
      const synced = await syncFirefliesToCallLibrary();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ synced: synced.length, calls: synced }));
    } catch(e) {
      console.error('[POST /api/calls/sync]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/calls — list all calls with optional filters ────────────────
  if (req.method === 'GET' && urlPath === '/api/calls') {
    setCors(res);
    try {
      const qs     = new URLSearchParams(req.url.includes('?') ? req.url.split('?')[1] : '');
      const status = qs.get('status') || '';
      const type   = qs.get('type') || '';
      const limit  = Math.min(parseInt(qs.get('limit') || '100', 10), 200);

      let query = `/rest/v1/calls?order=date.desc&limit=${limit}`;
      if (status) query += `&status=eq.${encodeURIComponent(status)}`;
      if (type)   query += `&call_type=eq.${encodeURIComponent(type)}`;

      const r = await supabaseRequest('GET', query, null, { 'Accept-Profile': 'public' });
      const calls = (r.status === 200 && Array.isArray(r.body)) ? r.body : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(calls));
    } catch(e) {
      console.error('[GET /api/calls]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/calls/:id/status — rep manually overrides status ──────────
  if (req.method === 'PATCH' && urlPath.match(/^\/api\/calls\/[^/]+\/status$/)) {
    setCors(res);
    const callId = urlPath.split('/')[3];
    try {
      const body      = await parseBody(req);
      const newStatus = body.status; // approved|skipped|pending_review
      const VALID = new Set(['approved','skipped','pending_review']);
      if (!VALID.has(newStatus)) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `Invalid status. Must be: ${[...VALID].join('|')}` }));
        return;
      }
      const r = await supabaseRequest('PATCH', `/rest/v1/calls?id=eq.${callId}`,
        { status: newStatus }, { 'Prefer': 'return=representation', 'Content-Profile': 'public' });
      if (r.status >= 400) throw new Error(`Supabase PATCH calls: ${r.status}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ updated: true, status: newStatus }));
    } catch(e) {
      console.error('[PATCH /api/calls/:id/status]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Phase 4: GET /api/notifications — list recent notifications ─────────────
  if (req.method === 'GET' && urlPath === '/api/notifications') {
    setCors(res);
    try {
      const qs    = new URLSearchParams(req.url.split('?')[1] || '');
      const limit = parseInt(qs.get('limit') || '50', 10);
      const unreadOnly = qs.get('unread') === '1';
      let query = `/rest/v1/notifications?order=created_at.desc&limit=${limit}`;
      if (unreadOnly) query += '&read=eq.false';
      const r = await supabaseRequest('GET', query, null, { 'Accept-Profile': 'public' });
      const rows = (r.status === 200 && Array.isArray(r.body)) ? r.body : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(rows));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Phase 4: PATCH /api/notifications/read-all — mark all read ──────────────
  if (req.method === 'PATCH' && urlPath === '/api/notifications/read-all') {
    setCors(res);
    try {
      await supabaseRequest('PATCH', '/rest/v1/notifications?read=eq.false',
        { read: true }, { 'Prefer': 'return=minimal', 'Content-Profile': 'public' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Phase 4: PATCH /api/notifications/:id/read — mark one read ──────────────
  if (req.method === 'PATCH' && urlPath.match(/^\/api\/notifications\/[^/]+\/read$/)) {
    setCors(res);
    const notifId = urlPath.split('/')[3];
    try {
      await supabaseRequest('PATCH', `/rest/v1/notifications?id=eq.${notifId}`,
        { read: true }, { 'Prefer': 'return=minimal', 'Content-Profile': 'public' });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── Phase 4: GET /api/prospect/:email — Prospect Intelligence File data ──────
  if (req.method === 'GET' && urlPath.match(/^\/api\/prospect\/.+/)) {
    setCors(res);
    const email = decodeURIComponent(urlPath.split('/api/prospect/')[1] || '').toLowerCase();
    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Valid email required' })); return;
    }
    try {
      // Parallel: fetch calls and jobs for this email
      const [callsR, jobsR, fileR] = await Promise.all([
        supabaseRequest('GET',
          `/rest/v1/calls?order=date.desc&limit=20`,
          null, { 'Accept-Profile': 'public' }),
        supabaseRequest('GET',
          `/rest/v1/jobs?prospect_email=eq.${encodeURIComponent(email)}&order=created_at.desc&limit=10`),
        supabaseRequest('GET',
          `/rest/v1/prospect_files?email=eq.${encodeURIComponent(email)}&limit=1`,
          null, { 'Accept-Profile': 'public' })
      ]);

      // Filter calls by attendee email client-side
      const emailLower = email.toLowerCase();
      const allCalls = (callsR.status === 200 && Array.isArray(callsR.body)) ? callsR.body : [];
      const matchedCalls = allCalls.filter(c => {
        let att = c.attendees || [];
        if (typeof att === 'string') { try { att = JSON.parse(att); } catch(e) { att = []; } }
        return att.some(a => (a.email || '').toLowerCase() === emailLower);
      });

      const jobs = (jobsR.status === 200 && Array.isArray(jobsR.body)) ? jobsR.body : [];
      const file = (fileR.status === 200 && Array.isArray(fileR.body) && fileR.body[0]) ? fileR.body[0] : null;

      // Add portal_url to each job (format matches dashboard: /?job=ID)
      const jobsWithPortal = jobs.map(j => ({
        ...j,
        portal_url: j.portal_url || `/?job=${j.id}`
      }));

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ email, calls: matchedCalls, jobs: jobsWithPortal, file }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/prefetch — fetch Fireflies + extract brief (no job created) ──
  if (req.method === 'POST' && urlPath === '/api/prefetch') {
    setCors(res);
    try {
      const body    = await parseBody(req);
      const email   = (body.email || '').trim().toLowerCase();
      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid email required' })); return;
      }
      // Step 0: GHL lookup to get real contact name/company (used to improve Fireflies matching)
      const [ghlContact, historicalContext] = await Promise.all([
        lookupGHLContact(email),
        getHistoricalContextByEmail(email)
      ]);

      const contactInfo = {
        name:    body.name    || ghlContact?.name    || historicalContext?.name || null,
        company: body.company || ghlContact?.company || historicalContext?.company || null,
        title:   ghlContact?.title || null,
        website: (body.website || ghlContact?.website || historicalContext?.website || email.split('@')[1] || '').replace(/^https?:\/\//, '').split('/')[0]
      };

      // Phase 3: also check DB for approved calls — used for count badge in UI
      const dbApproved = await findApprovedCallsFromDB(email);
      const approvedCallCount = dbApproved.length;

      // Parallel: Fireflies lookup (with contact info for better matching) + website scrape
      const [transcript, website] = await Promise.all([
        findFirefliesTranscript(email, contactInfo),
        contactInfo.website ? scrapeWebsite(contactInfo.website) : Promise.resolve(null)
      ]);

      let brief           = null;
      let transcriptFound = false;
      let transcriptTitle = null;

      if (transcript) {
        transcriptFound = true;
        transcriptTitle = transcript.title || null;

        // Fetch full detail (sentences) for just this one transcript
        const detail = await fetchTranscriptDetail(transcript.id);
        const s = (detail?.summary || transcript.summary) || {};

        // Build verbatim content from raw sentences (speaker-tagged, preserves exact words)
        const rawSentences = ((detail || transcript).sentences || [])
          .filter(s => s.text && s.text.trim().length > 0)
          .map(s => `${s.speaker_name || 'Speaker'}: ${s.text.trim()}`)
          .join('\n');

        // Combine verbatim sentences + summary fields for max context
        // Sentences get priority (verbatim), summaries fill if sentences empty
        const summaryParts = [s.shorthand_bullet, s.overview, s.short_summary, s.action_items].filter(Boolean).join('\n\n');
        const txContent = rawSentences
          ? `VERBATIM TRANSCRIPT:\n${rawSentences.slice(0, 12000)}\n\nSUMMARY NOTES:\n${summaryParts.slice(0, 2000)}`
          : summaryParts.slice(0, 14000);

        const webContent = website?.bodyText || '';
        console.log(`[prefetch] Transcript context: ${txContent.length} chars (${rawSentences.length} verbatim + summaries)`);
        brief = await extractBriefFromTranscript(txContent, webContent, contactInfo);
        // Promote extracted contact info back to contactInfo
        if (brief?.prospect?.company      && !body.company) contactInfo.company = brief.prospect.company;
        if (brief?.prospect?.contact_name && !body.name)    contactInfo.name    = brief.prospect.contact_name;
      } else if (historicalContext?.brief) {
        brief = historicalContext.brief;
        console.log(`[prefetch] Reusing historical brief from job ${historicalContext.jobId || 'unknown'} for ${email}`);
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        transcript_found:   transcriptFound,
        transcript_title:   transcriptTitle,
        approved_call_count: approvedCallCount,
        contact: contactInfo,
        brief:   brief || emptyBrief(contactInfo)
      }));
    } catch(e) {
      console.error('[POST /api/prefetch]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs — create job with confirmed brief, spawn full pipeline ──
  if (req.method === 'POST' && urlPath === '/api/jobs') {
    setCors(res);
    try {
      const body       = await parseBody(req);
      const email      = (body.email || '').trim().toLowerCase();
      const websiteUrl = (body.websiteUrl || '').trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      const brief      = body.brief || null;
      const repName    = (body.repName || body.rep_name || '').trim() || null; // B5 fix

      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid email required' }));
        return;
      }

      const job = await createJob(email, websiteUrl || null, brief, repName);
      // Spawn the full pipeline immediately:
      // - extract + prospect_research run now (re-extract with fresh transcript + LinkedIn)
      // - lead_list runs now (uses brief ICP which is already confirmed by rep)
      // - Stage 2 (brand_scrape, webinar_titles, roi_model) spawned by orchestrator when extract completes
      // - Stage 3 (calendar_visual, webinar_mock) spawned when Stage 2 completes
      await createTasks(job.id, ['extract', 'prospect_research', 'lead_list']);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: job.id, portal_url: `/?job=${job.id}` }));
    } catch(e) {
      console.error('[POST /api/jobs]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/jobs — list recent jobs (dashboard) ─────────────────────────
  if (req.method === 'GET' && urlPath === '/api/jobs') {
    setCors(res);
    try {
      const r = await supabaseRequest('GET', '/rest/v1/jobs?order=created_at.desc&limit=100');
      console.log(`[GET /api/jobs] Supabase status=${r.status} rows=${Array.isArray(r.body) ? r.body.length : 'non-array'} USE_SUPABASE=${USE_SUPABASE}`);
      if (r.status >= 400) console.error('[GET /api/jobs] Supabase error body:', JSON.stringify(r.body));
      const jobs = (r.status === 200 && Array.isArray(r.body)) ? r.body : [];
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(jobs.map(j => ({
        job_id:          j.id,
        status:          j.status,
        prospect_email:  j.prospect_email,
        prospect_company: j.prospect_company,
        prospect_name:   j.prospect_name,
        assigned_rep:    j.rep_name || null,
        portal_url:      `/?job=${j.id}`,
        created_at:      j.created_at,
        updated_at:      j.updated_at
      }))));
    } catch(e) {
      console.error('[GET /api/jobs]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/jobs/:id — poll job status + task outputs ───────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/jobs/')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length);
    try {
      const job = await getJob(jobId);
      if (!job) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Job not found' }));
        return;
      }
      const tasks = await getTasksByJobId(jobId);
      const taskMap = {};
      tasks.forEach(t => { taskMap[t.task_type] = { status: t.status, output: t.output_data, asset_url: t.asset_url, error: t.error_message }; });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id:          job.id,
        status:          job.status,
        prospect_email:  job.prospect_email,
        prospect_company: job.prospect_company,
        prospect_name:   job.prospect_name,
        extracted_data:  job.extracted_data,
        brand_data:      job.brand_data,
        research_data:   job.research_data,
        tasks:           taskMap,
        created_at:      job.created_at,
        updated_at:      job.updated_at
      }));
    } catch(e) {
      console.error('[GET /api/jobs/:id]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── DELETE /api/jobs/:id — hard delete job + tasks ───────────────────────
  if (req.method === 'DELETE' && urlPath.startsWith('/api/jobs/')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length);
    try {
      // Delete tasks first (avoid FK constraint violation)
      await supabaseRequest('DELETE', `/rest/v1/tasks?job_id=eq.${jobId}`);
      const r = await supabaseRequest('DELETE', `/rest/v1/jobs?id=eq.${jobId}`);
      console.log(`[DELETE /api/jobs] Deleted job ${jobId} status=${r.status}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ deleted: true }));
    } catch(e) {
      console.error('[DELETE /api/jobs]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/jobs/:id/webinar-overrides ─────────────────────────────────
  // Webinar Experience editor — persists rep customizations to extracted_data._webinar_overrides.
  // Single JSON blob (not individual fields) because the shape is wide and nested
  // (slide 2 cards, color swatches, etc.). Schema is rep-driven, not enum-locked.
  // Replace semantics: PATCH body fully replaces the existing override blob, so
  // "reset" is a PATCH with {}.
  if (req.method === 'PATCH' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/webinar-overrides')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/webinar-overrides'.length);
    try {
      const body = await parseBody(req);
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const existingData = job.extracted_data || {};
      const newOverrides = (body && typeof body === 'object') ? { ...body, _updated_at: new Date().toISOString() } : {};
      const updatedData = { ...existingData, _webinar_overrides: newOverrides };
      const r = await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
        { extracted_data: updatedData, updated_at: new Date().toISOString() },
        { 'Prefer': 'return=minimal' }
      );
      if (r.status >= 400) throw new Error(`Supabase PATCH failed: ${r.status}`);
      console.log(`[PATCH /api/jobs/${jobId}/webinar-overrides] Saved (${Object.keys(newOverrides).length} keys)`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, webinar_overrides: newOverrides }));
    } catch(e) {
      console.error('[PATCH /api/jobs/webinar-overrides]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs/:id/upload-image ─────────────────────────────────────────
  // Accepts a base64-encoded image payload (smaller blast radius than multipart),
  // uploads to Supabase Storage under {jobId}/uploads/{filename}, returns public URL.
  // Used by the Webinar Experience editor for custom logo + background uploads.
  // Limits: 5MB decoded, image/* content types only.
  if (req.method === 'POST' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/upload-image')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/upload-image'.length);
    try {
      const body = await parseBody(req);
      const dataUrl = body?.data_url || body?.dataUrl || '';
      const filenameRaw = body?.filename || 'upload.png';
      const m = String(dataUrl).match(/^data:(image\/[a-z+.-]+);base64,(.+)$/i);
      if (!m) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Body must contain data_url as a base64 image data URL' })); return;
      }
      const contentType = m[1];
      const buf = Buffer.from(m[2], 'base64');
      if (buf.length > 5 * 1024 * 1024) {
        res.writeHead(413, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Image exceeds 5MB limit' })); return;
      }
      // Sanitize filename: keep alphanumeric, dot, dash, underscore only
      const safeName = String(filenameRaw).replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80) || 'upload.png';
      const ts = Date.now();
      const storagePath = `${jobId}/uploads/${ts}-${safeName}`;
      const publicUrl = await storageUpload(storagePath, buf, contentType);
      console.log(`[upload-image] Job ${jobId}: uploaded ${buf.length} bytes → ${publicUrl}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: publicUrl, size: buf.length, content_type: contentType }));
    } catch(e) {
      console.error('[POST /api/jobs/upload-image]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs/:id/republish-webinar ────────────────────────────────────
  // Regenerates the public webinar_mock.html asset using the latest
  // _webinar_overrides + brand_data + extracted_data. Used after the rep saves
  // changes in the Webinar Experience editor and wants the prospect-facing
  // shareable URL refreshed. Returns the same public URL (we re-upload).
  if (req.method === 'POST' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/republish-webinar')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/republish-webinar'.length);
    try {
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const fakeTask = { id: null, job_id: jobId };
      const result = await handleWebinarMock(fakeTask, job);
      if (!result || !result.url) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Republish failed — handleWebinarMock returned no URL' })); return;
      }
      console.log(`[republish-webinar] Job ${jobId}: republished → ${result.url}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, url: result.url }));
    } catch(e) {
      console.error('[POST /api/jobs/republish-webinar]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/jobs/:id/overrides — rep field override system ──────────────────
  // Stores rep manual edits in extracted_data._overrides (separate from AI-generated data).
  // Overrides persist across pipeline re-runs. Portal reads _overrides first, then _generated.
  // Allowed fields: tam_total, recommended_outreach, webinar_title, roi_ltv, roi_show_rate, roi_close_rate
  if (req.method === 'PATCH' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/overrides')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/overrides'.length);
    try {
      const body = await parseBody(req);
      const ALLOWED = ['tam_total','recommended_outreach','webinar_title','roi_ltv','roi_show_rate','roi_close_rate'];
      const safeOverrides = {};
      for (const k of ALLOWED) {
        if (body[k] !== undefined) safeOverrides[k] = body[k];
      }
      if (!Object.keys(safeOverrides).length) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: `No valid override fields. Allowed: ${ALLOWED.join(', ')}` }));
        return;
      }
      // Fetch current job to merge overrides
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const existingData = job.extracted_data || {};
      const existingOverrides = existingData._overrides || {};
      const mergedOverrides = { ...existingOverrides, ...safeOverrides, _updated_at: new Date().toISOString() };
      const updatedData = { ...existingData, _overrides: mergedOverrides };
      const r = await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
        { extracted_data: updatedData, updated_at: new Date().toISOString() },
        { 'Prefer': 'return=minimal' }
      );
      if (r.status >= 400) throw new Error(`Supabase PATCH failed: ${r.status}`);
      console.log(`[PATCH /api/jobs/${jobId}/overrides] Saved:`, safeOverrides);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, overrides: mergedOverrides }));
    } catch(e) {
      console.error('[PATCH /api/jobs/overrides]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PATCH /api/jobs/:id/icp — update Apollo ICP filters manually ──────────
  if (req.method === 'PATCH' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/icp')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/icp'.length);
    try {
      const body = await parseBody(req);
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const existingData = job.extracted_data || {};
      const existingIcp = existingData.icp || {};
      const ICP_FIELDS = ['apollo_titles', 'apollo_keyword', 'apollo_geography', 'apollo_employee_ranges', 'person_seniorities', 'target_audience_type'];
      const updatedIcp = { ...existingIcp };
      for (const k of ICP_FIELDS) {
        if (body[k] !== undefined) updatedIcp[k] = body[k];
      }
      const updatedData = { ...existingData, icp: updatedIcp };
      const r = await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
        { extracted_data: updatedData, updated_at: new Date().toISOString() },
        { 'Prefer': 'return=minimal' }
      );
      if (r.status >= 400) throw new Error(`Supabase PATCH failed: ${r.status}`);
      console.log(`[PATCH /api/jobs/${jobId}/icp] Updated ICP filters`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, icp: updatedIcp }));
    } catch(e) {
      console.error('[PATCH /api/jobs/icp]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/jobs/:id/rerun-apollo — re-run lead search with current ICP ──
  if (req.method === 'POST' && urlPath.startsWith('/api/jobs/') && urlPath.endsWith('/rerun-apollo')) {
    setCors(res);
    const jobId = urlPath.slice('/api/jobs/'.length, -'/rerun-apollo'.length);
    try {
      const job = await getJob(jobId);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Job not found' })); return; }
      const icp = (job.extracted_data || {}).icp || {};
      const hasKeyword = (typeof icp.apollo_keyword === 'string' && icp.apollo_keyword.trim().length > 0)
        || (Array.isArray(icp.apollo_industries) && icp.apollo_industries.length > 0); // legacy
      if (!icp.apollo_titles?.length && !hasKeyword) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'No ICP filters set — nothing to search' }));
        return;
      }
      // Run the Apollo search (async — respond immediately, save results when done)
      res.writeHead(202, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, message: 'Apollo search started — poll job status for results' }));
      // Background: run search and save results
      (async () => {
        try {
          console.log(`[rerun-apollo] Starting for job ${jobId}`);
          const result = await fetchLeadsFromApollo(icp);
          if (result && result.leads) {
            // Mirror handleLeadList's outreach calculation so the "Recommended/month"
            // stat refreshes with the rerun. TAM > 300K → cap at 100K/mo;
            // otherwise exhaust the market in 3 months.
            const tam = result.total || 0;
            const recommendedOutreach = tam > 300000
              ? 100000
              : tam > 0 ? Math.max(1000, Math.round(tam / 3 / 1000) * 1000) : 30000;

            const existingData = job.extracted_data || {};
            // Field names here MUST match what mockup-portal.html reads from
            // existingGen (see line ~2074: `existingGen.leads`, `tam_total`, etc).
            // Earlier this block wrote `lead_list` instead of `leads`, so the rerun
            // never updated the visible lead table.
            const updatedData = {
              ...existingData,
              _generated: {
                ...(existingData._generated || {}),
                leads:                result.leads,
                tam_total:            tam,
                tam_source:           result.tamSource,
                recommendedOutreach:  recommendedOutreach,
                leadsTaskStatus:     'completed',
                apollo_diagnostics:   result.diagnostics
              }
            };
            await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${jobId}`,
              { extracted_data: updatedData, updated_at: new Date().toISOString() },
              { 'Prefer': 'return=minimal' }
            );
            console.log(`[rerun-apollo] Job ${jobId}: saved ${result.leads.length} leads, TAM=${tam}, outreach=${recommendedOutreach}/mo`);
          } else {
            console.warn(`[rerun-apollo] Job ${jobId}: search returned no result`);
          }
        } catch(e) {
          console.error(`[rerun-apollo] Job ${jobId} error:`, e.message);
        }
      })();
    } catch(e) {
      console.error('[POST /api/jobs/rerun-apollo]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── POST /api/generate — backwards-compat shim → creates job, polls extract ─
  if (req.method === 'POST' && urlPath === '/api/generate') {
    setCors(res);
    try {
      const body       = await parseBody(req);
      const email      = (body.email || '').trim().toLowerCase();
      const websiteUrl = (body.websiteUrl || '').trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();

      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Valid email required' })); return;
      }

      // Create job + Stage 1 tasks
      const job = await createJob(email, websiteUrl || null, null);
      await createTasks(job.id, ['extract', 'prospect_research']);

      // Poll until extract completes or 90s timeout
      const deadline = Date.now() + 90000;
      let finalJob = null;
      while (Date.now() < deadline) {
        await new Promise(r => setTimeout(r, 2000));
        finalJob = await getJob(job.id);
        if (finalJob?.extracted_data) break;
      }

      const extracted  = finalJob?.extracted_data || {};
      const company    = extracted.prospect?.company || websiteUrl || email.split('@')[1];
      const name       = extracted.prospect?.contact_name || extracted.prospect?.name || null;
      const industry   = extracted.icp?.industry || 'consulting';
      const meta       = extracted._meta || {};

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        job_id:          job.id,
        sessionToken:    job.id,  // portal reads ?job= or ?session= — both supported
        company,
        name,
        industry,
        transcriptFound: meta.transcript?.found || false,
        websiteScraped:  meta.website?.scraped  || false,
        portalUrl:       `/?job=${job.id}`
      }));
    } catch(err) {
      console.error('[/api/generate]', err.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
    return;
  }

  // ── GET /api/prompts — list all prompts ─────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/prompts') {
    setCors(res);
    try {
      const r = await supabaseRequest('GET', '/rest/v1/prompts?order=category.asc,slug.asc');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(r.body));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/prompts/:slug — single prompt ──────────────────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/prompts/') && !urlPath.endsWith('/history')) {
    setCors(res);
    const slug = decodeURIComponent(urlPath.slice('/api/prompts/'.length));
    try {
      const r = await supabaseRequest('GET', `/rest/v1/prompts?slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const prompt = Array.isArray(r.body) ? r.body[0] : null;
      if (!prompt) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(prompt));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/prompts/:slug/history — version history ────────────────────────
  if (req.method === 'GET' && urlPath.startsWith('/api/prompts/') && urlPath.endsWith('/history')) {
    setCors(res);
    const slug = decodeURIComponent(urlPath.slice('/api/prompts/'.length, -'/history'.length));
    try {
      const pr = await supabaseRequest('GET', `/rest/v1/prompts?slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const prompt = Array.isArray(pr.body) ? pr.body[0] : null;
      if (!prompt) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const vr = await supabaseRequest('GET', `/rest/v1/prompt_versions?prompt_id=eq.${prompt.id}&order=version.desc`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(vr.body));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── PUT /api/prompts/:slug — update prompt + save version ───────────────────
  if (req.method === 'PUT' && urlPath.startsWith('/api/prompts/')) {
    setCors(res);
    const slug = decodeURIComponent(urlPath.slice('/api/prompts/'.length));
    try {
      const body = await parseBody(req);
      const pr = await supabaseRequest('GET', `/rest/v1/prompts?slug=eq.${encodeURIComponent(slug)}&limit=1`);
      const prompt = Array.isArray(pr.body) ? pr.body[0] : null;
      if (!prompt) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const newVersion = prompt.version + 1;
      // Save current version to history
      await supabaseRequest('POST', '/rest/v1/prompt_versions', {
        prompt_id:      prompt.id,
        version_number: prompt.version,
        content:        prompt.content,
        notes:          prompt.notes   || null,
        created_by:     prompt.updated_by || 'system'
      });
      // Update the prompt
      await supabaseRequest('PATCH', `/rest/v1/prompts?id=eq.${prompt.id}`, {
        content: body.content || prompt.content,
        notes: body.notes || null,
        updated_by: body.updated_by || 'sales_rep',
        version: newVersion,
        updated_at: new Date().toISOString()
      }, { 'Prefer': 'return=minimal' });
      console.log(`[prompts] Updated ${slug} to v${newVersion}`);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true, version: newVersion }));
    } catch(e) {
      console.error('[PUT /api/prompts]', e.message);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── GET /api/portal-data — legacy session endpoint ────────────────────────
  if (req.method === 'GET' && urlPath === '/api/portal-data') {
    setCors(res);
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const token  = params.get('session') || params.get('job');
    if (!token) {
      res.writeHead(400, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'session or job param required' })); return;
    }
    try {
      const job   = await getJob(token);
      if (!job) { res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'Not found' })); return; }
      const extracted = job.extracted_data || {};
      const meta      = extracted._meta || {};
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        email:      job.prospect_email,
        domain:     job.prospect_website,
        transcript: meta.transcript || { found: false },
        website:    meta.website    || { domain: job.prospect_website, scraped: false },
        extracted
      }));
    } catch(e) {
      res.writeHead(500, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ── LinkedIn avatar proxy ─────────────────────────────────────────────────
  if (urlPath === '/lloyd-avatar') {
    const linkedinUrl = 'https://media.licdn.com/dms/image/v2/C4E03AQEtIxMkjlDmyA/profile-displayphoto-shrink_200_200/0/1638042721905';
    let headersSent = false;
    https.get(linkedinUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.linkedin.com/', 'Accept': 'image/*' }
    }, (upstream) => {
      if (upstream.statusCode === 200) {
        headersSent = true;
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        upstream.pipe(res);
        upstream.on('error', () => res.destroy());
      } else {
        headersSent = true;
        res.writeHead(404); res.end();
      }
    }).on('error', () => {
      if (!headersSent) { headersSent = true; res.writeHead(404); res.end(); }
      else { res.destroy(); }
    });
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  if (urlPath === '/' || urlPath === '') urlPath = '/mockup-portal.html';
  if (urlPath === '/dashboard')          urlPath = '/mockup-dashboard.html';
  if (urlPath === '/calls')              urlPath = '/calls.html';
  if (urlPath === '/prompts')            urlPath = '/prompts.html';
  if (urlPath === '/prospect' || urlPath.startsWith('/prospect?')) urlPath = '/prospect.html';
  const filePath = path.join(__dirname, urlPath);
  const ext      = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const isHtml = (MIME[ext] || '').includes('html');
    const headers = { 'Content-Type': MIME[ext] || 'text/plain' };
    if (isHtml) headers['Cache-Control'] = 'no-store';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Deal Forge running on port ${PORT}`);
  console.log(`Supabase: ${USE_SUPABASE ? 'connected' : 'NOT configured — worker disabled'}`);
});
