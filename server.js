'use strict';
const http    = require('http');
const https   = require('https');
const fs      = require('fs');
const path    = require('path');
const Anthropic = require('@anthropic-ai/sdk');

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
async function createJob(email, websiteUrl, brief) {
  const domain          = websiteUrl || email.split('@')[1];
  const prospectCompany = brief?.prospect?.company || null;
  const prospectName    = brief?.prospect?.contact_name || null;
  const r = await supabaseRequest('POST', '/rest/v1/jobs', {
    prospect_email:   email,
    prospect_website: domain || null,
    prospect_company: prospectCompany,
    prospect_name:    prospectName,
    extracted_data:   brief || null,   // brief IS the extracted data
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

async function getTasksByJobId(jobId) {
  const r = await supabaseRequest('GET', `/rest/v1/tasks?job_id=eq.${jobId}&order=created_at.asc`);
  if (r.status !== 200) return [];
  return Array.isArray(r.body) ? r.body : [];
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
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

// 6-strategy exhaustive Fireflies search. Failure modes covered:
//   1. Email prefix not a name (sgoldstucker) → use GHL name from contactInfo
//   2. Domain keyword doesn't match title → accept any result from domain/company search
//   3. Attendee emails missing from Fireflies → loosen match tier-by-tier
//   4. Transcript title has no searchable keywords → Pass 6: recent scan of 100 transcripts
//   5. Only one email part tried → all email segments are tried as keywords
//   6. API error in one pass → try/catch per pass, continue to next strategy
//   7. Wrong transcript returned → prefer exact email > domain attendee > loose keyword
async function findFirefliesTranscript(email, contactInfo = {}) {
  const domain     = (email.split('@')[1] || '').toLowerCase();
  const domainBase = domain.split('.')[0];
  const emailLocal = email.split('@')[0].toLowerCase();
  const NON_GENERIC    = new Set(['info','admin','contact','hello','sales','support','team','office','mail','noreply','no-reply','hi','hey']);
  const GENERIC_DOMAINS = new Set(['gmail','yahoo','hotmail','outlook','icloud','proton','me','live','aol']);

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

  function pickBest(results, acceptLoose, source) {
    const exact = results.filter(isExactEmail);
    if (exact.length)  { console.log(`[FF] ✓ exact email (${source}): "${exact[0].title}"`);  return exact[0]; }
    const dom   = results.filter(isDomainEmail);
    if (dom.length)    { console.log(`[FF] ✓ domain email (${source}): "${dom[0].title}"`);   return dom[0]; }
    if (acceptLoose && results.length) { console.log(`[FF] ✓ loose match (${source}): "${results[0].title}"`); return results[0]; }
    return null;
  }

  // ── Passes 1–5: keyword searches ──────────────────────────────────────────
  const searchGql = `query Search($keyword: String) { transcripts(keyword: $keyword, limit: 30) { ${TRANSCRIPT_LIST_FIELDS} } }`;
  const searched  = new Set();

  for (const { keyword, source, acceptLoose } of terms) {
    if (searched.has(keyword)) continue;
    searched.add(keyword);
    try {
      const data  = await firefliesQuery(searchGql, { keyword });
      const found = pickBest(data?.transcripts || [], acceptLoose, source);
      if (found) return found;
    } catch(e) { console.warn(`[FF] Pass ${source} error:`, e.message); }
  }

  // ── Pass 6a: recent scan — page 1 (most recent 50, Fireflies API max is 50)
  // Catches transcripts titled "Discovery Call" with no searchable domain/name
  console.log('[FF] Trying recent transcript scan pass 6a (limit 50)...');
  try {
    const recentGql = `{ transcripts(limit: 50) { ${TRANSCRIPT_LIST_FIELDS} } }`;
    const data      = await firefliesQuery(recentGql, {});
    const transcripts = data?.transcripts || [];
    console.log(`[FF] Pass 6a: got ${transcripts.length} transcripts`);
    // Log all attendee emails for debugging
    transcripts.forEach(t => {
      const attendees = (t.meeting_attendees || []).map(a => a.email).filter(Boolean);
      if (attendees.length) console.log(`[FF]   "${t.title}": ${attendees.join(', ')}`);
    });
    const found = pickBest(transcripts, false, 'recent_scan_6a');
    if (found) return found;
    // Also try loose match (title/content keyword) in case attendees are missing
    const foundLoose = pickBest(transcripts, true, 'recent_scan_6a_loose');
    if (foundLoose && (foundLoose.meeting_attendees || []).length === 0) return foundLoose;
  } catch(e) { console.warn('[FF] Pass 6a scan error:', e.message); }

  // ── Pass 6b: recent scan — page 2 (transcripts 51–100 via skip)
  console.log('[FF] Trying recent transcript scan pass 6b (skip 50, limit 50)...');
  try {
    const recentGql2 = `{ transcripts(limit: 50, skip: 50) { ${TRANSCRIPT_LIST_FIELDS} } }`;
    const data2      = await firefliesQuery(recentGql2, {});
    const transcripts2 = data2?.transcripts || [];
    console.log(`[FF] Pass 6b: got ${transcripts2.length} transcripts`);
    transcripts2.forEach(t => {
      const attendees = (t.meeting_attendees || []).map(a => a.email).filter(Boolean);
      if (attendees.length) console.log(`[FF]   "${t.title}": ${attendees.join(', ')}`);
    });
    const found2 = pickBest(transcripts2, false, 'recent_scan_6b');
    if (found2) return found2;
  } catch(e) { console.warn('[FF] Pass 6b scan error:', e.message); }

  console.log('[FF] No transcript found for', email, '— searched:', [...searched].join(', '));
  return null;
}

// ── Website scraper ───────────────────────────────────────────────────────────
async function scrapeWebsite(domain) {
  try {
    const url = `https://${domain}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' },
      signal: AbortSignal.timeout(8000)
    });
    const html = await res.text();
    const title    = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim() || '';
    const metaDesc = (
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) ||
      html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i)
    )?.[1]?.trim() || '';
    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '').replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '').replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ').replace(/\s+/g, ' ').trim().slice(0, 3000);
    console.log(`[scrape] ${domain} — "${title.slice(0, 60)}"`);
    return { html, title, metaDesc, bodyText };
  } catch(e) {
    console.log(`[scrape] Failed for ${domain}:`, e.message);
    return { html: '', title: '', metaDesc: '', bodyText: '' };
  }
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
    "apollo_titles": "array of strings | null — EXACTLY 3-6 standalone job titles for Apollo API search. STRICT RULES: (1) Each entry must be a real job title a person would hold — 2-4 words max. (2) NEVER include sentence fragments, descriptions, qualifiers, or phrases. If the transcript says 'senior decision-makers at organizations with 50+ employees, particularly in government, large enterprises, who need to manage strategy execution, goals, accountability' — that is a DESCRIPTION, not a list of titles. Extract titles from it: ['CEO', 'Director of Strategy', 'Chief Strategy Officer', 'Head of Operations']. (3) Self-check each entry: would this appear verbatim on a LinkedIn profile or business card? If not — it is wrong, replace it. VALID: ['CEO', 'Managing Director', 'VP Sales', 'Head of Strategy', 'Chief Operating Officer']. INVALID: ['particularly in government', 'large enterprises', 'goals', 'accountability', 'who need to manage']. If titles not stated, INFER from role/industry context. Null ONLY if buyer role is completely indeterminate.",
    "apollo_industries": "array of 1-5 strings | null — Apollo-compatible industry tags for ALL sectors the prospect's TARGET CLIENT companies could be in. Think broadly — if they target 'government and large enterprises', their clients span multiple sectors. Examples: strategy software targeting govt/enterprise → ['government administration', 'financial services', 'information technology and services', 'nonprofit organization management']. Marketing agency targeting e-commerce → ['retail', 'consumer goods', 'apparel and fashion']. Use specific Apollo-searchable terms: 'government administration', 'financial services', 'management consulting', 'healthcare', 'education management', 'real estate', 'software development', 'marketing and advertising', 'retail', 'manufacturing', 'banking', 'insurance', 'nonprofit organization management', 'legal services', 'construction', 'telecommunications', 'information technology and services', 'consumer goods', 'pharmaceuticals', 'hospitality', 'transportation/trucking/railroad'. Null ONLY if sector completely indeterminate.",
    "industry":      "string | null — single best-fit sector tag from apollo_industries (first/most representative one), for display only",
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
    icp:       { role: null, apollo_titles: null, apollo_industries: null, industry: null, company_size: null, apollo_employee_ranges: null, geography: null, apollo_geography: null, person_seniorities: null, company_revenue: null, kpis: null },
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
  // Industry base: sum across all sectors in apollo_industries array, with diminishing returns
  const industries = Array.isArray(icp?.apollo_industries) && icp.apollo_industries.length
    ? icp.apollo_industries
    : [(icp?.industry || '')];
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
  // Each additional industry adds 60% of its base (avoid double-counting overlapping markets)
  let base = industries.reduce((sum, ind, i) => sum + getIndBase(ind) * Math.pow(0.6, i), 0);

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
  if (raw < 10000) return Math.round(raw / 500) * 500;
  if (raw < 100000) return Math.round(raw / 5000) * 5000;
  return Math.round(raw / 25000) * 25000;
}
const PARKING_SIGNALS = ['domain for sale','this domain is for sale','buy this domain','coming soon','under construction','parked by','domain parking'];
// ── Jina AI Reader — JS-rendering-aware website scraper ─────────────────────
// Replaces raw fetch() + HTML parser. Jina runs a headless browser on their end,
// so React/Next.js/Vue sites return actual content instead of empty shells.
// No API key required. Format: https://r.jina.ai/{full-url}
async function websiteQualityCheck(url) {
  if (!url) return null;
  const jinaFetch = async (targetUrl) => {
    try {
      const res = await fetch(`https://r.jina.ai/${targetUrl}`, {
        headers: { 'Accept': 'text/plain', 'X-Return-Format': 'text' },
        signal: AbortSignal.timeout(7000)
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
async function classifyLeadsWithHaiku(leads, icp) {
  if (!leads.length) return [];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // The sector is the primary classification signal.
  // Titles/seniority are already pre-filtered by Apollo — we only need to confirm
  // the company is genuinely in the right industry sector.
  const targetSector  = icp.industry || icp.role || 'the target sector';
  const targetTitles  = icp.apollo_titles?.join(', ') || icp.role || null;
  const targetGeo     = icp.apollo_geography?.join(', ') || icp.geography || null;

  const leadLines = leads.map((l, i) => {
    const lines = [`Lead ${i+1}: ${l.name} | ${l.title} | ${l.company}${l.company_size ? ' (' + l.company_size + ')' : ''}`];
    if (l._headline) lines.push(`  Headline: "${l._headline}"`);
    if (l._excerpt)  lines.push(`  Website:  ${l._excerpt.slice(0, 300)}`);
    if (!l._headline && !l._excerpt) lines.push(`  (no additional signal available)`);
    return lines.join('\n');
  }).join('\n\n');

  const userMsg = [
    `TARGET SECTOR: ${targetSector}`,
    targetTitles ? `TARGET ROLES: ${targetTitles}` : null,
    targetGeo    ? `TARGET GEOGRAPHY: ${targetGeo}` : null,
    '',
    'LEADS TO CLASSIFY:',
    leadLines,
    '',
    'Return a JSON array — one entry per lead:',
    '[{ "index": N, "match": true/false, "confidence": "high"|"medium"|"low", "reason": "one sentence" }]',
    'Valid JSON only, no markdown.'
  ].filter(l => l !== null).join('\n');

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 2000, temperature: 0,
      system: `You are a strict B2B lead classifier. Your job: determine if each company matches the target ICP on TWO dimensions — sector AND geography (if specified).

Rules:
1. PRIMARY SIGNAL — website content: does the copy, tone, and services described match the target sector? An agency writes about campaigns, clients, creative work. A university mentions students, courses, faculty, admissions. A consulting firm mentions strategy, engagements, frameworks.
2. SECONDARY SIGNAL — LinkedIn headline: if the person's headline explicitly references the company type or sector, weight it heavily.
3. SECTOR MISMATCH = NO MATCH. A CEO title does not overcome a wrong-sector company.
4. GEOGRAPHY CHECK (HARD REJECT): If TARGET GEOGRAPHY is specified AND the company's apparent location is CLEARLY not in that geography — based on company name, domain (.co.uk, .com.au etc.), or website content mentioning a different region — reject it. Examples: TARGET GEOGRAPHY = Baltic states/Europe → company named "Bank of Africa" or "Bank of China" → reject. TARGET = Europe → US/Australian/African company with no EU presence → reject. Only reject on geography if you are confident. If geography is ambiguous or unknown, do NOT reject on geo alone.
5. NO SIGNAL RULE: If no website content AND no headline → default match: false.
6. CONFIDENCE: "high" = website/headline clearly confirms BOTH sector AND geo. "medium" = sector confirmed, geo plausible but not explicit. "low" = company name plausible but no confirmation.
7. Return valid JSON only. No markdown.`,
      messages: [{ role: 'user', content: userMsg }]
    });
    const raw = msg.content[0].text;
    return JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || raw);
  } catch(e) {
    console.warn('[Haiku classify] Failed:', e.message);
    return leads.map((_, i) => ({ index: i+1, match: false, confidence: 'low', reason: 'classification unavailable' }));
  }
}
// ── Path A: Industry pre-filter — fast keyword gate before AI classifier ─────
// Removes obvious mismatches by company name before spending tokens on Haiku.
// Better to miss an edge case than to show a client "Maple Online Learning" as a consulting lead.
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
  const out = leads.filter(l => {
    if (pattern.test(l.company || '')) {
      console.log(`[PreFilter] Excluded "${l.company}" — wrong industry for ${industry} ICP`);
      return false;
    }
    return true;
  });
  console.log(`[PreFilter] ${out.length}/${leads.length} passed industry name check`);
  return out;
}

function normalizePerson(p, source) {
  // Normalize contact shape from people/search and contacts/search into one format
  const org = p.organization || p.account || {};
  return {
    name: p.name,
    title: p.title,
    company: p.organization_name || org.name || '',
    company_size: fmtEmp(org.estimated_num_employees),
    website: org.primary_domain ? `https://${org.primary_domain}` : null,
    linkedin_url: p.linkedin_url || null,
    // LinkedIn headline — Apollo scrapes this from LinkedIn profiles. Far more specific
    // than org.industry tags. "VP Strategy at Gov of Estonia | EU Policy Advisor" is
    // an instant sector signal without any additional web request.
    _headline: p.headline || null,
    _source: source
  };
}

async function fetchLeadsFromApollo(icp) {
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) { console.log('[Apollo] No API key — skipping'); return null; }

  const apolloTitles    = Array.isArray(icp?.apollo_titles) && icp.apollo_titles.length ? icp.apollo_titles : null;
  const apolloIndustries = Array.isArray(icp?.apollo_industries) && icp.apollo_industries.length
    ? icp.apollo_industries
    : (icp?.industry ? [icp.industry] : null); // fallback: legacy single-industry briefs
  if (!apolloIndustries?.length && !apolloTitles?.length) { console.log('[Apollo] No ICP — skipping'); return null; }

  const apolloHeaders = { 'Content-Type': 'application/json', 'Accept': 'application/json', 'x-api-key': APOLLO_KEY };
  // Clean geo: Apollo understands country names and city names, but NOT "Europe" or "European Union" as region values.
  // Strip those → they silently match nothing, wasting the primary geo slot.
  // We handle the Europe-level fallback explicitly in the tiered retry below.
  const EU_COUNTRIES = [
    'Germany','France','Netherlands','Sweden','Denmark','Finland','Norway','Poland',
    'Czech Republic','Austria','Belgium','Spain','Italy','Portugal','Switzerland',
    'Estonia','Latvia','Lithuania','Romania','Hungary','Slovakia','Croatia','Slovenia',
    'Serbia','Montenegro','Bosnia and Herzegovina','Albania','North Macedonia','Bulgaria','Greece'
  ];
  const rawGeo = Array.isArray(icp?.apollo_geography) && icp.apollo_geography.length ? icp.apollo_geography : null;
  const apolloGeo = rawGeo
    ? rawGeo
        .flatMap(g => (g === 'European Union' || /^europe$/i.test(g)) ? [] : [g]) // strip "Europe"/"EU" — handled by fallback
        .filter((g, i, a) => a.indexOf(g) === i) // dedupe
    : null;
  // Prefer LLM-extracted Apollo ranges; fall back to mapCompanySize for legacy briefs
  const sizeRanges    = (Array.isArray(icp?.apollo_employee_ranges) && icp.apollo_employee_ranges.length)
    ? icp.apollo_employee_ranges
    : (icp?.company_size ? mapCompanySize(icp.company_size) : null);
  const seniorities   = Array.isArray(icp?.person_seniorities) && icp.person_seniorities.length ? icp.person_seniorities : null;

  console.log('[Apollo] Starting org-first lead search:', JSON.stringify({ apolloIndustries, apolloTitles, apolloGeo }));
  const timeout270s = new Promise(resolve => setTimeout(() => { console.warn('[Apollo] 4.5min timeout'); resolve(null); }, 270000));

  const apolloCore = async () => {
    let total = null;
    let orgIds = [];
    let geoUsed = 'original'; // tracks which geo tier was actually used for org search

    // ── Step 1: organizations/search — validates companies AND gets org IDs for Step 2 ──
    // This is the quality anchor: we confirm company industry+size+geo BEFORE finding people.
    // GEO FALLBACK: small geographic markets (e.g. Baltic states) have sparse Apollo coverage.
    // If geo-restricted search returns < 5 orgs, retry without geo and let the classifier
    // do geo verification via website content + headline. Better to over-fetch and classify
    // than to under-fetch and show 0 leads.
    const runOrgSearch = async (withGeo) => {
      const orgBody = { per_page: 50 };
      if (apolloIndustries) orgBody.q_organization_keyword_tags      = apolloIndustries;
      if (sizeRanges)       orgBody.organization_num_employees_ranges = sizeRanges;
      if (withGeo && apolloGeo) orgBody.q_organization_locations     = apolloGeo;
      const orgRes = await fetch('https://api.apollo.io/v1/organizations/search', {
        method: 'POST', headers: apolloHeaders,
        body: JSON.stringify(orgBody), signal: AbortSignal.timeout(10000)
      });
      if (!orgRes.ok) return { orgCount: null, orgIds: [] };
      const orgData = await orgRes.json();
      return {
        orgCount: orgData.pagination?.total_entries || null,
        orgIds:   (orgData.organizations || []).map(o => o.id).filter(Boolean)
      };
    };
    try {
      let result = await runOrgSearch(true);

      if (result.orgIds.length < 5) {
        const hasBaltic = apolloGeo?.some(g => /estonia|latvia|lithuania|balti/i.test(g));
        const originalHadEurope = rawGeo?.some(g => /^europe$/i.test(g) || g === 'European Union');

        // Step 2a: when original ICP included Europe/Baltic but returned sparse results,
        // retry with explicit EU country names. Apollo matches country names reliably;
        // "Europe" as a single value matches nothing in their geo index.
        if (hasBaltic || originalHadEurope) {
          console.log(`[Apollo] Only ${result.orgIds.length} orgs with primary geo — retrying with explicit EU countries`);
          const euBody = { per_page: 50 };
          if (apolloIndustries) euBody.q_organization_keyword_tags      = apolloIndustries;
          if (sizeRanges)       euBody.organization_num_employees_ranges = sizeRanges;
          euBody.q_organization_locations = EU_COUNTRIES;
          try {
            const er = await fetch('https://api.apollo.io/v1/organizations/search', { method: 'POST', headers: apolloHeaders, body: JSON.stringify(euBody), signal: AbortSignal.timeout(12000) });
            if (er.ok) {
              const ed = await er.json();
              const euIds = (ed.organizations || []).map(o => o.id).filter(Boolean);
              console.log(`[Apollo] EU countries retry: ${euIds.length} orgs`);
              if (euIds.length > result.orgIds.length) {
                result = { orgCount: ed.pagination?.total_entries || null, orgIds: euIds };
                geoUsed = 'europe';
              }
            }
          } catch(e) { console.warn('[Apollo] EU countries retry error:', e.message); }
        }

        // Step 2b: if still thin after EU retry, go fully global
        if (result.orgIds.length < 5) {
          console.log(`[Apollo] Still only ${result.orgIds.length} orgs — retrying globally (classifier will verify geo)`);
          const globalResult = await runOrgSearch(false);
          if (globalResult.orgIds.length > result.orgIds.length) {
            result = globalResult;
            geoUsed = 'global';
          }
        }
      }
      const { orgCount, orgIds: fetchedIds } = result;
      if (orgCount) total = orgCount * 2;
      orgIds = fetchedIds;
      console.log(`[Apollo] TAM: ${orgCount} orgs → ${total} est. contacts; extracted ${orgIds.length} org IDs`);
    } catch(e) { console.warn('[Apollo] Org search error:', e.message); }

    // ── Step 2: people/search at validated org IDs (Path B) ──────────────────
    // people/search searches globally, not just CRM. If plan doesn't allow it (403),
    // fall back to contacts/search with the same filters.
    let allPeople = [];
    let usedPeopleSearch = false;

    if (orgIds.length) {
      try {
        const peopleBody = { organization_ids: orgIds, per_page: 25 };
        if (apolloTitles?.length) peopleBody.person_titles      = apolloTitles;
        if (seniorities)          peopleBody.person_seniorities = seniorities;
        // NOTE: person_locations intentionally omitted — geo filtering on people is unreliable
        // for non-US markets. Classifier verifies geography via website + headline instead.
        const peopleRes = await fetch('https://api.apollo.io/v1/people/search', {
          method: 'POST', headers: apolloHeaders,
          body: JSON.stringify(peopleBody), signal: AbortSignal.timeout(15000)
        });
        if (peopleRes.ok) {
          const peopleData = await peopleRes.json();
          const PLACEHOLDER_NAMES = new Set(['n/a', 'na', 'unknown', 'no name', '(no name)', 'none', 'null', 'anonymous']);
          const people = (peopleData.people || []).filter(p => {
            const n = (p.name || '').trim();
            return n.length > 2 && !PLACEHOLDER_NAMES.has(n.toLowerCase()) && p.title && (p.organization_name || p.organization?.name);
          });
          allPeople = people.map(p => normalizePerson(p, 'people/search'));
          usedPeopleSearch = true;
          console.log(`[Apollo] people/search: ${allPeople.length} contacts from ${orgIds.length} validated orgs`);
        } else {
          const errText = await peopleRes.text().catch(() => '');
          console.warn(`[Apollo] people/search HTTP ${peopleRes.status} — falling back to contacts/search. ${errText.slice(0,120)}`);
        }
      } catch(e) { console.warn('[Apollo] people/search error:', e.message); }
    }

    // ── Fallback: contacts/search (CRM-only, but workable) ───────────────────
    if (!usedPeopleSearch) {
      const contactsBody = { per_page: 25 };
      if (apolloTitles?.length) contactsBody.person_titles                   = apolloTitles;
      if (apolloIndustries)     contactsBody.q_organization_keyword_tags      = apolloIndustries;
      if (sizeRanges)           contactsBody.organization_num_employees_ranges = sizeRanges;
      if (apolloGeo)            contactsBody.person_locations                 = apolloGeo;
      if (seniorities)          contactsBody.person_seniorities               = seniorities;
      try {
        for (let page = 1; page <= 4; page++) {
          const res = await fetch('https://api.apollo.io/v1/contacts/search', {
            method: 'POST', headers: apolloHeaders,
            body: JSON.stringify({ ...contactsBody, page }), signal: AbortSignal.timeout(12000)
          });
          if (!res.ok) { console.warn(`[Apollo] contacts/search HTTP ${res.status} p${page}`); break; }
          const data = await res.json();
          const PLACEHOLDER_NAMES_C = new Set(['n/a', 'na', 'unknown', 'no name', '(no name)', 'none', 'null', 'anonymous']);
          const batch = (data.contacts || []).filter(p => {
            const n = (p.name || '').trim();
            return n.length > 2 && !PLACEHOLDER_NAMES_C.has(n.toLowerCase()) && p.title && (p.organization_name || p.organization?.name);
          });
          allPeople.push(...batch.map(p => normalizePerson(p, 'contacts/search')));
          if (batch.length < 25) break;
        }
        console.log(`[Apollo] contacts/search fallback: ${allPeople.length} candidates`);
      } catch(e) {
        console.warn('[Apollo] contacts/search error:', e.message);
        if (!allPeople.length) return { leads: [], total: total || estimateGlobalTAM(icp) };
      }
    }

    if (!allPeople.length) return { leads: [], total: total || estimateGlobalTAM(icp) };

    // ── Path A: Industry keyword pre-filter ───────────────────────────────────
    const rawLeads    = preFilterLeadsByIndustry(allPeople, icp);
    if (!rawLeads.length) return { leads: [], total: total || estimateGlobalTAM(icp) };

    // ── Website excerpts — bonus signal, not a gate ───────────────────────────
    console.log(`[Apollo] Fetching website excerpts for ${rawLeads.length} pre-filtered leads...`);
    const qualityResults = [];
    for (let i = 0; i < rawLeads.length; i += 10) {
      const batch = rawLeads.slice(i, i + 10);
      const batchResults = await Promise.all(batch.map(l => websiteQualityCheck(l.website)));
      qualityResults.push(...batchResults);
    }
    const leadsForClassification = rawLeads.map((l, i) =>
      qualityResults[i] ? { ...l, _excerpt: qualityResults[i].excerpt } : l
    );
    console.log(`[Apollo] Classifying ${leadsForClassification.length} leads (${leadsForClassification.filter(l => l._excerpt).length} with excerpts, source: ${usedPeopleSearch ? 'people/search' : 'contacts/search'})...`);

    // ── Haiku ICP classifier — always runs, fail-closed by default ──────────
    // When we fell back to EU or global search, pass the effective geo so the
    // classifier can apply appropriate strictness (EU-wide accept vs hard Baltic-only).
    const icpForClassifier = (geoUsed === 'europe')
      ? { ...icp, apollo_geography: EU_COUNTRIES }
      : (geoUsed === 'global' ? { ...icp, apollo_geography: null } : icp);
    const classifications = await classifyLeadsWithHaiku(leadsForClassification, icpForClassifier);
    const classMap = {};
    classifications.forEach(c => { classMap[c.index] = c; });
    const anyMatch = classifications.some(c => c.match);
    // Outage detection: classifier returns all match:false with reason 'classification unavailable'
    // (from the catch block in classifyLeadsWithHaiku). Distinguish from genuine rejection.
    const isClassifierOutage = !anyMatch && classifications.length > 0 &&
      classifications.every(c => c.reason === 'classification unavailable');
    if (!anyMatch && !isClassifierOutage) {
      console.log('[Apollo] Classifier rejected all leads (genuine mismatch — not outage). Returning 0 leads.');
    }
    if (isClassifierOutage) {
      console.warn('[Apollo] Classifier outage detected — returning pre-filtered leads unverified.');
    }
    const classified = leadsForClassification
      .map((l, i) => {
        const c = classMap[i+1] || { match: false, confidence: 'low', reason: 'unclassified' };
        return { ...l, _match: c.match, confidence: c.confidence, match_reason: c.reason };
      })
      // Confidence floor: only show high + medium ICP-confirmed leads.
      // Outage exception: classifier down → show pre-filtered leads (better than nothing).
      // Genuine rejection → return empty (better than showing wrong leads).
      .filter(l => isClassifierOutage ? true : (l._match && l.confidence !== 'low'));

    const ORDER = { high: 0, medium: 1, low: 2 };
    classified.sort((a, b) => (ORDER[a.confidence] || 1) - (ORDER[b.confidence] || 1));
    const finalLeads = classified.slice(0, 25).map(({ _match, _excerpt, _source, ...l }) => l);
    // total = org count × 2 from organizations/search (global Apollo DB), or estimated fallback
    const tam = total || estimateGlobalTAM(icp);
    console.log(`[Apollo] Final: ${finalLeads.length} leads, TAM: ${tam}`);
    return { leads: finalLeads, total: tam };
  };
  return Promise.race([apolloCore(), timeout270s]);
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

// ── Calendar visual: reminder emails ─────────────────────────────────────────
async function generateReminderEmails(title, hostName, resultDelivered, customerPain) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 600, temperature: 0.7,
    system: 'You are writing short reminder email previews for a webinar registration confirmation sequence. Return valid JSON only. No markdown.',
    messages: [{ role: 'user', content: `Generate 3 reminder email previews for this webinar:\n\nWebinar title: ${title}\nHost name: ${hostName}\nWhat attendees will learn: ${resultDelivered || 'practical strategies'}\nWho this is for: ${customerPain || 'business owners looking to grow'}\n\nReturn this exact JSON:\n{"emails":[{"timing":"1 week before","subject":"string — max 10 words","preview":"string — 2-3 sentences"},{"timing":"24 hours before","subject":"string — max 10 words","preview":"string — 2-3 sentences, create urgency"},{"timing":"1 hour before","subject":"string — max 10 words","preview":"string — 1-2 sentences, very punchy"}]}` }]
  });
  const raw = msg.content[0].text;
  try { return JSON.parse(raw); }
  catch(e) { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return null; }
}

// ── Webinar mock: live chat messages ─────────────────────────────────────────
async function generateChatMessages(title, icp, customerPain, resultDelivered, hostName) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const msg = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001', max_tokens: 800, temperature: 0.7,
    system: 'You are generating realistic live chat messages for a webinar. Return valid JSON only. No markdown.',
    messages: [{ role: 'user', content: `Generate 18 live chat messages for this webinar:\n\nWebinar title: ${title}\nTarget audience role: ${icp?.role || 'business owners'}\nTarget audience industry: ${icp?.industry || 'B2B'}\nCore problem they face: ${customerPain || 'growing their business'}\nResult they want: ${resultDelivered || 'more revenue'}\n\nRequirements:\n- 14 attendee messages: realistic first names, short messages, mix of questions + reactions + struggles\n- 4 support team messages from "Support" or "Team ${hostName}": encourage booking a call\n- Messages should feel chronologically natural\n- Attendee questions should reference the webinar topic\n\nReturn:\n{"messages":[{"sender":"string","text":"string — max 15 words","is_team":boolean,"timestamp":"string e.g. 12:14 PM"}]}` }]
  });
  const raw = msg.content[0].text;
  try { return JSON.parse(raw); }
  catch(e) { const m = raw.match(/\{[\s\S]*\}/); if (m) return JSON.parse(m[0]); return null; }
}

// ── TASK HANDLERS ─────────────────────────────────────────────────────────────

async function handleExtract(task, job) {
  const email = job.prospect_email || '';
  const scrapeDomain = job.prospect_website || email.split('@')[1];
  console.log(`[extract] Processing job ${job.id} for ${email}`);

  // Step 1: Fireflies
  const transcript = await findFirefliesTranscript(email);

  // Step 2: Website
  const website = await scrapeWebsite(scrapeDomain);

  // Step 3: Build extraction content
  const parts = [];
  if (transcript) {
    const s = transcript.summary || {};
    parts.push([
      `MEETING: ${transcript.title}`,
      s.shorthand_bullet ? `DETAILED NOTES:\n${s.shorthand_bullet}` : '',
      s.overview         ? `METRICS OVERVIEW:\n${s.overview}` : '',
      s.short_summary    ? `SUMMARY:\n${s.short_summary}` : '',
      s.action_items     ? `ACTION ITEMS:\n${s.action_items}` : ''
    ].filter(Boolean).join('\n\n'));
  }
  if (website.bodyText || website.title) {
    parts.push([
      `WEBSITE (${scrapeDomain}):`,
      website.title    ? `Title: ${website.title}` : '',
      website.metaDesc ? `Description: ${website.metaDesc}` : '',
      website.bodyText ? `Content:\n${website.bodyText}` : ''
    ].filter(Boolean).join('\n'));
  }
  // Always include domain-derived name as anchor for Claude
  const domainAnchor = scrapeDomain.split('.')[0].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
  parts.unshift(`DOMAIN: ${scrapeDomain}\nDERIVED NAME FROM DOMAIN: ${domainAnchor}\n(Use this as the company name if a clearer branded name is not found in the content below)`);

  if (!parts.length) parts.push(`Prospect email: ${email}\nDomain: ${scrapeDomain}`);

  // Step 4: Claude extraction (extractBriefFromTranscript is the only extractor defined)
  const extracted = await extractBriefFromTranscript(parts.join('\n\n---\n\n'), '', { name: null, company: null, website: scrapeDomain });

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
  extracted._meta = {
    transcript: transcript ? { id: transcript.id, title: transcript.title, date: transcript.dateString, found: true } : { found: false },
    website: { domain: scrapeDomain, title: website.title, scraped: !!(website.bodyText) }
  };

  // Update prospect_company on the job row
  const company = extracted.prospect?.company || scrapeDomain;
  await supabaseRequest('PATCH', `/rest/v1/jobs?id=eq.${job.id}`, {
    prospect_company: company,
    prospect_name:    extracted.prospect?.name || null,
    updated_at:       new Date().toISOString()
  });
  await updateJobExtractedData(job.id, extracted);

  return { extracted, transcriptFound: !!(transcript), websiteScraped: !!(website.bodyText), company };
}

async function handleProspectResearch(task, job) {
  const linkedinUrl = job.prospect_linkedin_url;
  console.log(`[prospect_research] ${linkedinUrl ? 'Scraping ' + linkedinUrl : 'No LinkedIn URL — completing with null'}`);

  if (!linkedinUrl) {
    await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: null }, scraped: false });
    return { host: null, scraped: false };
  }

  try {
    const items = await runApifyActor('apify/linkedin-profile-scraper', { profileUrls: [linkedinUrl] }, 60000);
    const profile = items?.[0];
    if (!profile || !profile.fullName) {
      await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: linkedinUrl }, scraped: false });
      return { host: null, scraped: false };
    }

    let bio = null;
    if (profile.fullName && (profile.summary || profile.headline)) {
      const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
      const msg = await anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001', max_tokens: 300, temperature: 0,
        system: 'You are writing a short professional bio for a webinar host. Write in third person. 2–3 sentences maximum. Confident and credible tone. Focus on their expertise and who they help. Do not mention the webinar.',
        messages: [{ role: 'user', content: `Write a short host bio from this LinkedIn data:\n\nName: ${profile.fullName}\nHeadline: ${profile.headline || ''}\nSummary: ${profile.summary || ''}\nMost recent role: ${profile.experiences?.[0]?.title || ''} at ${profile.experiences?.[0]?.company || ''}\n\nReturn only the bio text. No labels, no markdown.` }]
      });
      bio = msg.content[0].text.trim();
    }

    const researchData = {
      host: {
        name:         profile.fullName,
        title:        profile.headline || null,
        bio,
        headshot_url: profile.profilePicture || null,
        linkedin_url: linkedinUrl
      },
      scraped: true
    };
    await updateJobResearchData(job.id, researchData);
    return researchData;
  } catch(e) {
    console.warn('[prospect_research] Apify failed:', e.message);
    await updateJobResearchData(job.id, { host: { name: null, title: null, bio: null, headshot_url: null, linkedin_url: linkedinUrl }, scraped: false });
    return { host: null, scraped: false };
  }
}

async function handleBrandScrape(task, job) {
  const website = job.prospect_website;
  console.log(`[brand_scrape] ${website ? 'Scraping ' + website : 'No website — completing with null'}`);

  const nullOutput = { logo_url: null, primary_color: null, secondary_color: null, tagline: null, company_name: null, scraped: false };

  if (!website) {
    await updateJobBrandData(job.id, nullOutput);
    return nullOutput;
  }

  // Try Apify web scraper first, fall back to direct HTTP
  let html = '';
  try {
    const url = website.startsWith('http') ? website : `https://${website}`;
    if (process.env.APIFY_API_TOKEN) {
      const items = await runApifyActor('apify/web-scraper', {
        startUrls: [{ url }], maxCrawlPages: 1, maxCrawlDepth: 0
      }, 60000);
      html = items?.[0]?.html || items?.[0]?.content || '';
    }
    if (!html) {
      const scraped = await scrapeWebsite(website);
      html = scraped.html || '';
    }
  } catch(e) {
    console.warn('[brand_scrape] Scrape failed, trying direct:', e.message);
    try { const scraped = await scrapeWebsite(website); html = scraped.html || ''; } catch(_) {}
  }

  if (!html) {
    await updateJobBrandData(job.id, nullOutput);
    return nullOutput;
  }

  // Extract brand assets from HTML
  // 1. Logo URL
  let logoUrl = null;
  const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                  html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)?.[1];
  if (ogImage) logoUrl = ogImage;
  else {
    const logoImgMatch = html.match(/<img[^>]+(?:class|id|src)=["'][^"']*logo[^"']*["'][^>]*src=["']([^"']+)["']/i) ||
                         html.match(/<img[^>]+src=["']([^"']*logo[^"']*)["']/i);
    if (logoImgMatch) logoUrl = logoImgMatch[1];
  }
  if (logoUrl && !logoUrl.startsWith('http')) {
    const base = `https://${website}`;
    logoUrl = logoUrl.startsWith('/') ? base + logoUrl : `${base}/${logoUrl}`;
  }

  // 2. Primary color
  let primaryColor = null;
  const themeColor = html.match(/<meta[^>]+name=["']theme-color["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                     html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']theme-color["']/i)?.[1];
  if (themeColor) primaryColor = themeColor;
  else {
    const cssVar = html.match(/--(?:primary|brand)-color\s*:\s*(#[0-9a-fA-F]{3,6})/i)?.[1];
    if (cssVar) primaryColor = cssVar;
    else {
      const headerColors = [];
      const headerBg = html.match(/(?:header|nav)[^{]*\{[^}]*background(?:-color)?\s*:\s*(#[0-9a-fA-F]{3,6})/ig) || [];
      headerBg.forEach(m => { const c = m.match(/#[0-9a-fA-F]{3,6}/); if (c) headerColors.push(c[0]); });
      if (headerColors.length) {
        const notWhiteBlack = headerColors.filter(c => !['#fff','#ffffff','#FFF','#FFFFFF','#000','#000000'].includes(c));
        primaryColor = notWhiteBlack[0] || null;
      }
    }
  }

  // 3. Tagline
  const tagline = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})["']/i)?.[1] ||
                  html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']{10,})["']/i)?.[1] || null;

  // 4. Company name from og:site_name or title
  const siteName = html.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i)?.[1] ||
                   html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:site_name["']/i)?.[1];
  const titleTag  = html.match(/<title[^>]*>([^<]+)<\/title>/i)?.[1]?.split(/[|\-–—]/)[0]?.trim();
  const companyName = siteName || titleTag || job.prospect_company || null;

  const brandData = { logo_url: logoUrl, primary_color: primaryColor, secondary_color: null, tagline: tagline?.slice(0, 200) || null, company_name: companyName, scraped: true };
  await updateJobBrandData(job.id, brandData);
  console.log(`[brand_scrape] Done: logo=${!!logoUrl}, color=${primaryColor}`);
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
  // apollo_industries, person_seniorities are all needed by fetchLeadsFromApollo.
  console.log('[lead_list] ICP from brief:', JSON.stringify(icp));

  // fetchLeadsFromApollo already runs website quality gate + Haiku classification internally.
  // Do NOT call filterLeadsByWebsite here — that would re-scrape every site a second time.
  const result = await fetchLeadsFromApollo(icp);
  const leads  = result?.leads || [];
  console.log(`[lead_list] Apollo returned ${leads.length} classified leads, TAM: ${result?.total}`);
  return { leads, total: result?.total || 0 };
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

  // Generate reminder emails
  const emailsResult = await generateReminderEmails(variant.title, hostName,
    extracted.result_delivered || extracted.angle?.result,
    extracted.customer_pain   || extracted.angle?.pain
  ).catch(() => null);
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
  return { url: publicUrl, title: variant.title, host_name: hostName, event_date: dateStr, email_count: emails.length };
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

  const primaryColor   = brandData.primary_color   || '#0D9488';
  const secondaryColor = brandData.secondary_color  || '#1F2937';
  const logoUrl        = brandData.logo_url         || '';
  const companyName    = brandData.company_name     || extracted.prospect?.company || job.prospect_company || 'Your Company';
  const hostName       = research.name              || extracted.prospect?.name    || companyName;

  // Generate chat messages
  const chatResult = await generateChatMessages(variant.title, extracted.icp,
    extracted.customer_pain   || extracted.angle?.pain,
    extracted.result_delivered || extracted.angle?.result,
    hostName
  ).catch(() => null);
  const messages = chatResult?.messages || [];

  // Generate timestamps starting 12:05 PM, 30-90s apart
  let startTime = 12 * 60 + 5;
  const timedMessages = messages.map((m, i) => {
    const t = startTime;
    startTime += 30 + Math.floor(Math.random() * 60);
    const h = Math.floor(t / 60) % 12 || 12;
    const min = (t % 60).toString().padStart(2, '0');
    const ampm = Math.floor(t / 60) >= 12 ? 'PM' : 'AM';
    return { ...m, timestamp: `${h}:${min} ${ampm}` };
  });

  // Attendee count: realistic fake
  const attendeeCount = 750 + Math.floor(Math.random() * 300);

  if (!WEBINAR_MOCK_TEMPLATE) throw new Error('webinar_mock.html template not loaded');

  const slide1Title = variant.title || '';
  const slide1Subtitle = `How ${companyName} Grows Your Business`;
  const slide2Title = 'What You\'ll Learn Today';
  const bulletsList = (variant.bullets || ['Proven system for getting clients', 'Step-by-step framework', 'How to scale predictably']).slice(0, 4);

  const htmlContent = interpolate(WEBINAR_MOCK_TEMPLATE, {
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
    ATTENDEE_COUNT:   attendeeCount,
    MESSAGES_JSON:    JSON.stringify(timedMessages)
  });

  const storagePath = `${job.id}/webinar_mock.html`;
  const publicUrl   = await storageUpload(storagePath, htmlContent);
  console.log(`[webinar_mock] Uploaded: ${publicUrl}`);
  return { url: publicUrl, title: variant.title, host_name: hostName, attendee_count: attendeeCount };
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
    await updateJobStatus(jobId, anyFailed ? 'failed' : 'completed');
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
    if (!job) { await failTask(task.id, 'Parent job not found'); return; }

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

// Start worker + recovery loops
if (USE_SUPABASE) {
  setInterval(processNextTask, 3000);
  setInterval(resetStuckTasks, 2 * 60 * 1000);
  console.log('[worker] Started (3s interval)');
  console.log('[recovery] Started (2min interval)');
} else {
  console.warn('[worker] NOT started — no Supabase config');
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];

  if (req.method === 'OPTIONS') {
    setCors(res); res.writeHead(204); res.end(); return;
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
      const ghlContact = await lookupGHLContact(email);

      const contactInfo = {
        name:    body.name    || ghlContact?.name    || null,
        company: body.company || ghlContact?.company || null,
        title:   ghlContact?.title || null,
        website: (body.website || ghlContact?.website || email.split('@')[1] || '').replace(/^https?:\/\//, '').split('/')[0]
      };

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
      }

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        transcript_found: transcriptFound,
        transcript_title: transcriptTitle,
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

  // ── POST /api/jobs — create job with confirmed brief, spawn lead_list ────
  if (req.method === 'POST' && urlPath === '/api/jobs') {
    setCors(res);
    try {
      const body       = await parseBody(req);
      const email      = (body.email || '').trim().toLowerCase();
      const websiteUrl = (body.websiteUrl || '').trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      const brief      = body.brief || null;

      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid email required' }));
        return;
      }

      const job = await createJob(email, websiteUrl || null, brief);
      await createTasks(job.id, ['lead_list']);  // Phase 1: lead list only

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
        assigned_rep:    j.assigned_rep || null,
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
      const name       = extracted.prospect?.name || null;
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
    https.get(linkedinUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0', 'Referer': 'https://www.linkedin.com/', 'Accept': 'image/*' }
    }, (upstream) => {
      if (upstream.statusCode === 200) { res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' }); upstream.pipe(res); }
      else { res.writeHead(404); res.end(); }
    }).on('error', () => { res.writeHead(404); res.end(); });
    return;
  }

  // ── Static files ──────────────────────────────────────────────────────────
  if (urlPath === '/' || urlPath === '') urlPath = '/mockup-portal.html';
  if (urlPath === '/dashboard')          urlPath = '/mockup-dashboard.html';
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
