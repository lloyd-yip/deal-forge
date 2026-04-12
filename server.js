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
async function createJob(email, websiteUrl, linkedinUrl) {
  const domain = websiteUrl || email.split('@')[1];
  const r = await supabaseRequest('POST', '/rest/v1/jobs', {
    prospect_email:        email,
    prospect_website:      domain || null,
    prospect_linkedin_url: linkedinUrl || null,
    status:                'processing'
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

const TRANSCRIPT_FIELDS = `
  id title dateString duration
  summary { short_summary overview action_items shorthand_bullet }
  meeting_attendees { email displayName }
`;

async function findFirefliesTranscript(email) {
  const local = email.split('@')[0];
  const domain = email.split('@')[1];
  const NON_PERSONAL = new Set(['info','admin','contact','hello','sales','support','team','office','mail','noreply','no-reply']);
  let rawFirst = local.split(/[._\-+]/)[0].toLowerCase().replace(/\d+$/, '');
  const firstName = (rawFirst.length >= 3 && !NON_PERSONAL.has(rawFirst)) ? rawFirst : null;
  const domainBase = domain.split('.')[0].toLowerCase();

  function findExact(transcripts) {
    return transcripts.filter(t => {
      const attendees = (t.meeting_attendees || []).map(a => (a.email || '').toLowerCase());
      return attendees.includes(email.toLowerCase());
    });
  }

  const searchGql = `query Search($keyword: String) { transcripts(keyword: $keyword, limit: 20) { ${TRANSCRIPT_FIELDS} } }`;

  if (firstName && firstName.length >= 3) {
    const data = await firefliesQuery(searchGql, { keyword: firstName });
    const results = data?.transcripts || [];
    const exact = findExact(results);
    if (exact.length) { console.log(`[Fireflies] Found by first name: "${exact[0].title}"`); return exact[0]; }
  }

  if (domainBase && domainBase.length >= 4 && !['gmail','yahoo'].includes(domainBase)) {
    const data = await firefliesQuery(searchGql, { keyword: domainBase });
    const results = data?.transcripts || [];
    const exact = findExact(results);
    if (exact.length) { console.log(`[Fireflies] Found by domain: "${exact[0].title}"`); return exact[0]; }
    const domainMatch = results.filter(t => {
      const attendees = (t.meeting_attendees || []).map(a => (a.email || '').toLowerCase());
      return attendees.some(a => a.endsWith('@' + domain));
    });
    if (domainMatch.length) { console.log(`[Fireflies] Found by domain attendee`); return domainMatch[0]; }
  }

  console.log('[Fireflies] No transcript found for', email);
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

// ── Claude extraction ─────────────────────────────────────────────────────────
async function extractWithClaude(content) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are a data extraction assistant. Extract structured business information from a sales call transcript and/or website content.

Return valid JSON only. No markdown, no explanation, no preamble.

CRITICAL — Who is the prospect:
The "prospect" is the CLIENT company — the external business being pitched to. The prospect is NOT Lloyd Yip, NOT Quantum Scaling, and NOT any QS team member. Extract the client's information as the prospect fields.

Null rules: If a field was not discussed or found, return null — never infer or hallucinate. If numbers are vague, return null — only extract verbatim figures. icp.geography: null unless explicitly mentioned.`;

  const userPrompt = `Extract the following from this sales information:

---
${content}
---

Return this exact JSON structure:

{
  "prospect": {
    "name": "string | null — prospect's full name if mentioned",
    "company": "string — company name (required)",
    "website": "string | null — website domain if found"
  },
  "icp": {
    "industry": "string — best match: consulting, software, coaching, agency, ecommerce, healthcare, real_estate, finance, or other",
    "role": "string | null — job title of their target buyer",
    "company_size": "string | null — revenue range or headcount of their target clients"
  },
  "business": {
    "revenue": "string | null — prospect company annual revenue if mentioned",
    "ltv": "string | null — client lifetime value, verbatim (e.g. '$48,000')",
    "deal_size": "string | null — average deal value, verbatim",
    "close_rate": "string | null — current close rate, verbatim (e.g. '20%')",
    "show_rate": "string | null — current show rate, verbatim (e.g. '70%')"
  },
  "customer_pain": "string | null — the core problem their ICP experiences, in customer language",
  "result_delivered": "string | null — the transformation the prospect delivers to their clients",
  "goals": "string | null — what the prospect wants to achieve in next 6-12 months",
  "webinar_angle": "string | null — topic or teaching angle for their webinar if discussed",
  "personalized_title": "string — a compelling webinar title written specifically for this company. Reference their exact industry, their clients' specific pain point, or their specific growth goal. Make it feel like it was written just for them. Format: How [specific type of company] [achieve specific outcome] Without [the frustration they face]. Max 90 characters. REQUIRED — always generate one even if data is sparse."
}`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const raw = message.content[0].text;
  try { return JSON.parse(raw); }
  catch(e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude returned unparseable JSON');
  }
}

// ── Apollo helpers ────────────────────────────────────────────────────────────
function mapCompanySize(sizeStr) {
  if (!sizeStr) return ['11,50', '51,200'];
  const s = sizeStr.toLowerCase();
  if (/solo|1.person|solopreneur/.test(s)) return ['1,1'];
  if (/1.10|under 10|fewer than 10/.test(s)) return ['1,10'];
  if (/10.50|startup|small.*team/.test(s)) return ['1,10', '11,50'];
  if (/50.200|mid.size|growing/.test(s)) return ['51,200'];
  if (/200.500|mid.market/.test(s)) return ['201,500'];
  if (/500\+?|enterprise|large/.test(s)) return ['501,1000', '1001,10000'];
  return ['11,50', '51,200'];
}
function fmtEmp(n) {
  if (!n) return '';
  if (n <= 10) return `${n} emp`;
  if (n <= 200) return `${Math.round(n/10)*10} emp`;
  if (n <= 1000) return `~${Math.round(n/100)*100} emp`;
  return `${Math.round(n/1000)}K+ emp`;
}
const PARKING_SIGNALS = ['domain for sale','this domain is for sale','buy this domain','coming soon','under construction','parked by','domain parking'];
async function websiteQualityCheck(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, { method: 'GET', headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000), redirect: 'follow' });
    if (!res.ok) return false;
    const html = await res.text();
    const lower = html.toLowerCase();
    if (PARKING_SIGNALS.some(s => lower.includes(s))) return false;
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (!titleMatch || !titleMatch[1].trim()) return false;
    const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (bodyText.split(' ').length < 50) return false;
    return { title: titleMatch[1].trim(), excerpt: bodyText.slice(0, 500) };
  } catch(e) { return false; }
}
async function classifyLeadsWithHaiku(leads, icp) {
  if (!leads.length) return [];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const icpDesc = [
    icp.industry     ? `Industry: ${icp.industry}` : '',
    icp.role         ? `Role: ${icp.role}` : '',
    icp.company_size ? `Company size: ${icp.company_size}` : '',
    icp.geography    ? `Geography: ${icp.geography}` : ''
  ].filter(Boolean).join('\n');
  const leadLines = leads.map((l, i) =>
    `Lead ${i+1}: ${l.name} | ${l.title} | ${l.company} (${l.company_size || 'unknown size'})` +
    (l._excerpt ? ` | Site: ${l._excerpt.slice(0, 200)}` : '')
  ).join('\n');
  const userMsg = `Target ICP:\n${icpDesc}\n\nLeads to classify:\n${leadLines}\n\nReturn a JSON array: [{ "index": N, "match": true/false, "confidence": "high"|"medium"|"low", "reason": "one sentence" }]. Valid JSON only, no markdown.`;
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 1200, temperature: 0,
      system: 'You are an ICP classifier. Return valid JSON only. No markdown.',
      messages: [{ role: 'user', content: userMsg }]
    });
    const raw = msg.content[0].text;
    return JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || raw);
  } catch(e) {
    console.warn('[Haiku classify] Failed:', e.message);
    return leads.map((_, i) => ({ index: i+1, match: true, confidence: 'medium', reason: 'classification unavailable' }));
  }
}
async function fetchLeadsFromApollo(icp) {
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) { console.log('[Apollo] No API key — skipping'); return null; }
  const role = icp?.role, industry = icp?.industry;
  if (!role && !industry) { console.log('[Apollo] No ICP — skipping'); return null; }
  const baseBody = { api_key: APOLLO_KEY, per_page: 25 };
  if (role)            baseBody.person_titles = [role];
  if (industry)        baseBody.q_organization_keyword_tags = [industry];
  if (icp?.company_size) baseBody.organization_num_employees_ranges = mapCompanySize(icp.company_size);
  if (icp?.geography)  baseBody.person_locations = [icp.geography];
  console.log('[Apollo] Searching pages 1–2:', JSON.stringify({ role, industry }));
  const timeout35s = new Promise(resolve => setTimeout(() => { console.warn('[Apollo] 35s timeout'); resolve(null); }, 35000));
  const apolloCore = async () => {
    const allPeople = []; let total = null;
    try {
      for (let page = 1; page <= 2; page++) {
        const res = await fetch('https://api.apollo.io/api/v1/mixed_people_search', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
          body: JSON.stringify({ ...baseBody, page }), signal: AbortSignal.timeout(12000)
        });
        if (!res.ok) { console.warn(`[Apollo] HTTP ${res.status} p${page}`); break; }
        const data = await res.json();
        if (!total) total = data.pagination?.total_entries || null;
        const people = (data.people || []).filter(p => p.name && p.title && p.organization?.name);
        allPeople.push(...people);
        if (people.length < 25) break;
      }
    } catch(e) { console.warn('[Apollo] Fetch error:', e.message); if (!allPeople.length) return null; }
    if (!allPeople.length) return null;
    const rawLeads = allPeople.map(p => ({
      name: p.name, title: p.title, company: p.organization?.name || '',
      company_size: fmtEmp(p.organization?.estimated_num_employees),
      website: p.organization?.primary_domain ? `https://${p.organization.primary_domain}` : null,
      linkedin_url: p.linkedin_url || null
    }));
    console.log(`[Apollo] Quality gate on ${rawLeads.length} leads...`);
    const qualityResults = [];
    for (let i = 0; i < rawLeads.length; i += 10) {
      const batch = rawLeads.slice(i, i + 10);
      const batchResults = await Promise.all(batch.map(l => websiteQualityCheck(l.website)));
      qualityResults.push(...batchResults);
    }
    const qualifiedLeads = rawLeads.map((l, i) => qualityResults[i] ? { ...l, _excerpt: qualityResults[i].excerpt } : null).filter(Boolean);
    console.log(`[Apollo] Quality: ${qualifiedLeads.length}/${rawLeads.length} passed`);
    if (!qualifiedLeads.length) return { leads: rawLeads.slice(0, 25).map(l => ({ ...l, confidence: 'medium' })), total };
    const classifications = await classifyLeadsWithHaiku(qualifiedLeads, icp);
    const classMap = {};
    classifications.forEach(c => { classMap[c.index] = c; });
    const classified = qualifiedLeads
      .map((l, i) => { const c = classMap[i+1] || { match: true, confidence: 'medium', reason: '' }; return { ...l, _match: c.match, confidence: c.confidence, match_reason: c.reason }; })
      .filter(l => l._match);
    const ORDER = { high: 0, medium: 1, low: 2 };
    classified.sort((a, b) => (ORDER[a.confidence] || 1) - (ORDER[b.confidence] || 1));
    const finalLeads = classified.slice(0, 25).map(({ _match, _excerpt, ...l }) => l);
    console.log(`[Apollo] Final: ${finalLeads.length} leads, TAM: ${total}`);
    return { leads: finalLeads, total };
  };
  return Promise.race([apolloCore(), timeout35s]);
}

// ── Webinar titles generation ─────────────────────────────────────────────────
async function generateWebinarTitles(extracted, companyName) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const icp = extracted.icp || {};
  const role = icp.role || 'business owners', industry = icp.industry || 'B2B';
  const size = icp.company_size || '', geo = icp.geography;
  const pain = extracted.customer_pain || 'unpredictable client acquisition';
  const result = extracted.result_delivered || 'predictable revenue growth';
  const cs = extracted.case_study;
  const outputSchema = `\nRuntime rules: write as ${companyName} hosting — NEVER as Quantum Scaling • titles HARD LIMIT 60 chars • bullets = specific transformations, not topics • ${cs?.numbers ? 'proof numbers verbatim: ' + cs.numbers : 'no fabricated proof numbers'}\nReturn valid JSON only matching the Output Format schema above.`;
  let systemPrompt, userPrompt;
  if (WEBINAR_SYSTEM_TEMPLATE) {
    const businessContext = [
      `- Company: ${companyName}`,
      `- Their clients are: ${role}s at ${size ? size + ' ' : ''}companies in ${industry}`,
      `- Core pain they solve: ${pain}`,
      `- Result they deliver: ${result}`,
      cs?.numbers ? `- Client proof: ${cs.client_description || 'A client'} — ${cs.result || ''} (${cs.numbers})` : null,
      extracted.webinar_angle ? `- Webinar angle: ${extracted.webinar_angle}` : null
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
      webinar_angle_block: extracted.webinar_angle ? `**Webinar angle:** ${extracted.webinar_angle}` : ''
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

  // Step 4: Claude extraction
  const extracted = await extractWithClaude(parts.join('\n\n---\n\n'));

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
  await supabaseRequest('PATCH', `/rest/v1/sales_assets.jobs?id=eq.${job.id}`, {
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

async function handleLeadList(task, job) {
  const extracted = job.extracted_data;
  // Build ICP with fallbacks so Apollo always has something to search
  const icp = {
    industry: extracted?.icp?.industry || 'consulting',
    role:     extracted?.icp?.role     || null,
    company_size: extracted?.icp?.company_size || null
  };
  console.log('[lead_list] ICP:', JSON.stringify(icp));
  const result = await fetchLeadsFromApollo(icp);
  return { leads: result?.leads || [], total: result?.total || 0 };
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
  const rawLtv = extracted?.business?.ltv;

  if (!rawLtv) {
    await needsInputTask(task.id, 'Missing: business.ltv — rep must enter manually');
    return null; // signal needs_input
  }
  const ltv = parseLtv(rawLtv);
  if (!ltv) {
    await needsInputTask(task.id, `Could not parse LTV from "${rawLtv}" — rep must enter manually`);
    return null;
  }

  const closeRate = parseRate(extracted?.business?.close_rate, 0.20);
  const showRate  = parseRate(extracted?.business?.show_rate,  0.70);
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
    CLOSE_RATE_SOURCE: extracted?.business?.close_rate ? 'extracted from transcript' : 'default (20%)',
    SHOW_RATE_SOURCE:  extracted?.business?.show_rate  ? 'extracted from transcript' : 'default (70%)'
  });

  const storagePath = `${job.id}/roi_model.html`;
  const publicUrl = await storageUpload(storagePath, htmlContent);
  console.log(`[roi_model] Uploaded: ${publicUrl}`);

  return {
    url: publicUrl,
    inputs_used: {
      ltv, close_rate: closeRate, show_rate: showRate,
      close_rate_source: extracted?.business?.close_rate ? 'extracted' : 'default',
      show_rate_source:  extracted?.business?.show_rate  ? 'extracted' : 'default'
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
  const emailsResult = await generateReminderEmails(variant.title, hostName, extracted.result_delivered, extracted.customer_pain).catch(() => null);
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
  const chatResult = await generateChatMessages(variant.title, extracted.icp, extracted.customer_pain, extracted.result_delivered, hostName).catch(() => null);
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

  // ── POST /api/jobs — create job, return immediately ───────────────────────
  if (req.method === 'POST' && urlPath === '/api/jobs') {
    setCors(res);
    try {
      const body       = await parseBody(req);
      const email      = (body.email || '').trim().toLowerCase();
      const websiteUrl = (body.websiteUrl || '').trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();
      const linkedinUrl = body.linkedinUrl || null;

      if (!email || !email.includes('@')) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Valid email required' }));
        return;
      }

      const job = await createJob(email, websiteUrl || null, linkedinUrl);
      // Spawn Stage 1 tasks
      await createTasks(job.id, ['extract', 'prospect_research']);

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ job_id: job.id, portal_url: `/?job=${job.id}` }));
    } catch(e) {
      console.error('[POST /api/jobs]', e.message);
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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Deal Forge running on port ${PORT}`);
  console.log(`Supabase: ${USE_SUPABASE ? 'connected' : 'NOT configured — worker disabled'}`);
});
