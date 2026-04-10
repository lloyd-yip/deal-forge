const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };

// ── Prompt templates — loaded from files at startup ───────────────────────────
const PROMPTS_DIR = path.join(__dirname, 'prompts');
let WEBINAR_SYSTEM_TEMPLATE = '';
let WEBINAR_USER_TEMPLATE   = '';
let WEBINAR_FALLBACK_FORMAT = '';
try {
  WEBINAR_SYSTEM_TEMPLATE = fs.readFileSync(path.join(PROMPTS_DIR, 'webinar_titles_system.txt'), 'utf8');
  WEBINAR_USER_TEMPLATE   = fs.readFileSync(path.join(PROMPTS_DIR, 'webinar_titles_user.txt'), 'utf8');
  WEBINAR_FALLBACK_FORMAT = fs.readFileSync(path.join(PROMPTS_DIR, 'webinar_titles_fallback_format.txt'), 'utf8');
  console.log('[Prompts] Loaded webinar title templates from files');
} catch(e) {
  console.warn('[Prompts] Could not load template files — using inline fallback:', e.message);
}
function interpolate(template, vars) {
  return template.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] !== undefined ? vars[k] : '');
}

// ── Session store — Supabase persistent + in-memory fallback ─────────────────
const sessions = new Map(); // fallback when Supabase not configured
function generateToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const USE_SUPABASE = !!(SUPABASE_URL && SUPABASE_SERVICE_KEY);

async function supabaseRequest(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(SUPABASE_URL + path);
    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: {
        'apikey': SUPABASE_SERVICE_KEY,
        'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': method === 'POST' ? 'return=minimal' : ''
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

async function ensureSessionsTable() {
  if (!USE_SUPABASE) return;
  // Create table via Supabase REST DDL (idempotent)
  const sql = `CREATE TABLE IF NOT EXISTS portal_sessions (
    token TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    domain TEXT,
    transcript JSONB,
    website JSONB,
    extracted JSONB,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );`;
  try {
    await supabaseRequest('POST', '/rest/v1/rpc/exec_sql', { sql });
  } catch(e) {
    // exec_sql may not exist — table must be created manually. That's fine.
    console.log('[Supabase] Could not auto-create sessions table:', e.message);
  }
}

async function saveSession(token, data) {
  if (USE_SUPABASE) {
    try {
      const r = await supabaseRequest('POST', '/rest/v1/portal_sessions', {
        token,
        email: data.email,
        domain: data.domain,
        transcript: data.transcript,
        website: data.website,
        extracted: data.extracted
      });
      if (r.status >= 400) throw new Error(`Supabase insert ${r.status}`);
      console.log('[Supabase] Session saved:', token);
      return;
    } catch(e) {
      console.warn('[Supabase] Save failed, falling back to memory:', e.message);
    }
  }
  sessions.set(token, data);
  setTimeout(() => sessions.delete(token), 24 * 60 * 60 * 1000);
}

async function getSession(token) {
  if (USE_SUPABASE) {
    try {
      const r = await supabaseRequest('GET', `/rest/v1/portal_sessions?token=eq.${encodeURIComponent(token)}&limit=1`, null);
      if (r.status === 200 && Array.isArray(r.body) && r.body.length > 0) {
        const row = r.body[0];
        return { email: row.email, domain: row.domain, transcript: row.transcript, website: row.website, extracted: row.extracted };
      }
      return null;
    } catch(e) {
      console.warn('[Supabase] Read failed, trying memory:', e.message);
    }
  }
  return sessions.get(token) || null;
}

// ── Helpers ──────────────────────────────────────────────────────────────────
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

// Transcript fields we need
// NOTE: 'notes' does not exist on Transcript type in Fireflies GraphQL
// Use summary sub-fields instead: shorthand_bullet has richest structured data
const TRANSCRIPT_FIELDS = `
  id title dateString duration
  summary { short_summary overview action_items shorthand_bullet }
  meeting_attendees { email displayName }
`;

// ── Fireflies: find transcript by attendee email ─────────────────────────────
// NOTE: The Fireflies `participants` filter is broken — it ignores the email
// and returns recent meetings regardless. We use keyword search on the prospect's
// name/domain extracted from their email, then exact-match the email in attendees.
async function findFirefliesTranscript(email) {
  const local = email.split('@')[0];
  const domain = email.split('@')[1];

  // Non-personal email prefixes — skip name search for these
  const NON_PERSONAL = new Set(['info', 'admin', 'contact', 'hello', 'sales', 'support', 'team', 'office', 'mail', 'noreply', 'no-reply']);

  // Extract first name from email local part:
  // karsten → karsten, john.doe → john, scottb → scottb (try as-is), j.doe → skip
  let rawFirst = local.split(/[._\-+]/)[0].toLowerCase();
  // Strip trailing digits only (john2 → john), not letters (don't mangle karsten → karste)
  rawFirst = rawFirst.replace(/\d+$/, '');
  const firstName = (rawFirst.length >= 3 && !NON_PERSONAL.has(rawFirst)) ? rawFirst : null;

  // Extract domain company name
  const domainBase = domain.split('.')[0].toLowerCase();

  // Check exact attendee match in results from a keyword search
  function findExact(transcripts) {
    return transcripts.filter(t => {
      const attendees = (t.meeting_attendees || []).map(a => (a.email || '').toLowerCase());
      return attendees.includes(email.toLowerCase());
    });
  }

  // Strategy 1: keyword search on first name (most reliable)
  if (firstName && firstName.length >= 3) {
    const gql = `query Search($keyword: String) {
      transcripts(keyword: $keyword, limit: 20) { ${TRANSCRIPT_FIELDS} }
    }`;
    const data = await firefliesQuery(gql, { keyword: firstName });
    const results = data?.transcripts || [];
    console.log(`Fireflies keyword "${firstName}": ${results.length} results`);
    const exact = findExact(results);
    if (exact.length) {
      console.log(`Found by first name: "${exact[0].title}"`);
      return exact[0];
    }
  }

  // Strategy 2: keyword search on domain company name
  if (domainBase && domainBase.length >= 4 && domainBase !== 'gmail' && domainBase !== 'yahoo') {
    const gql = `query Search($keyword: String) {
      transcripts(keyword: $keyword, limit: 20) { ${TRANSCRIPT_FIELDS} }
    }`;
    const data = await firefliesQuery(gql, { keyword: domainBase });
    const results = data?.transcripts || [];
    console.log(`Fireflies keyword "${domainBase}": ${results.length} results`);
    const exact = findExact(results);
    if (exact.length) {
      console.log(`Found by domain: "${exact[0].title}"`);
      return exact[0];
    }
  }

  // Strategy 3: domain fallback — any attendee from same domain
  if (domainBase && domainBase.length >= 4 && domainBase !== 'gmail' && domainBase !== 'yahoo') {
    const gql = `query Search($keyword: String) {
      transcripts(keyword: $keyword, limit: 20) { ${TRANSCRIPT_FIELDS} }
    }`;
    const data = await firefliesQuery(gql, { keyword: domainBase });
    const results = data?.transcripts || [];
    const domainMatch = results.filter(t => {
      const attendees = (t.meeting_attendees || []).map(a => (a.email || '').toLowerCase());
      return attendees.some(a => a.endsWith('@' + domain));
    });
    if (domainMatch.length) {
      console.log(`Found by domain attendee: "${domainMatch[0].title}"`);
      return domainMatch[0];
    }
  }

  console.log('No Fireflies transcript found for', email);
  return null;
}

// ── Website scraper ───────────────────────────────────────────────────────────
async function scrapeWebsite(domain) {
  try {
    const url = `https://${domain}`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36' },
      signal: AbortSignal.timeout(8000)
    });
    const html = await res.text();

    const title = (html.match(/<title[^>]*>([^<]+)<\/title>/i) || [])[1]?.trim() || '';
    const metaDesc = (
      html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']{10,})/i) ||
      html.match(/<meta[^>]+content=["']([^"']{10,})["'][^>]+name=["']description["']/i)
    )?.[1]?.trim() || '';

    const bodyText = html
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<nav[\s\S]*?<\/nav>/gi, '')
      .replace(/<footer[\s\S]*?<\/footer>/gi, '')
      .replace(/<header[\s\S]*?<\/header>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&[a-z]+;/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 3000);

    console.log(`Website scraped: ${domain} — title: "${title.slice(0, 60)}"`);
    return { title, metaDesc, bodyText };
  } catch(e) {
    console.log(`Website scrape failed for ${domain}:`, e.message);
    return { title: '', metaDesc: '', bodyText: '' };
  }
}

// ── Claude extraction ─────────────────────────────────────────────────────────
async function extractWithClaude(content) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const systemPrompt = `You are a data extraction assistant. Extract structured business information from a sales call transcript and/or website content.

Return valid JSON only. No markdown, no explanation, no preamble.

Null rules (critical):
- If a field was not discussed or found in the content, return null — never infer or hallucinate
- If numbers are vague ("a lot", "significant"), return null for that field — only extract verbatim figures
- icp.geography: null unless explicitly mentioned`;

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
  "personalized_title": "string — a compelling webinar title written specifically for this company. Reference their exact industry, their clients' specific pain point, or their specific growth goal. Make it feel like it was written just for them. Format: How [specific type of company] [achieve specific outcome] Without [the frustration they face]. Example for a life sciences consultant: 'How Life Sciences Consultancies Add $2M Without Growing Their Field Sales Team'. Max 90 characters. REQUIRED — always generate one even if data is sparse."
}`;

  const message = await anthropic.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1500,
    temperature: 0,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const raw = message.content[0].text;
  try {
    return JSON.parse(raw);
  } catch(e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('Claude returned unparseable JSON');
  }
}

// ── Company size → Apollo range mapper ───────────────────────────────────────
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

// ── Lead quality gate (deterministic — no model) ─────────────────────────────
const PARKING_SIGNALS = ['domain for sale', 'this domain is for sale', 'buy this domain',
  'coming soon', 'under construction', 'parked by', 'domain parking'];

async function websiteQualityCheck(url) {
  if (!url) return false;
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10000),
      redirect: 'follow'
    });
    if (!res.ok) return false;
    const html = await res.text();
    const lower = html.toLowerCase();
    // Parking page signal
    if (PARKING_SIGNALS.some(s => lower.includes(s))) return false;
    // Must have a non-empty title
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    if (!titleMatch || !titleMatch[1].trim()) return false;
    // Must have meaningful body text (strip tags, count words)
    const bodyText = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (bodyText.split(' ').length < 50) return false;
    return { title: titleMatch[1].trim(), excerpt: bodyText.slice(0, 500) };
  } catch(e) {
    return false;
  }
}

// ── Claude Haiku ICP classification ──────────────────────────────────────────
async function classifyLeadsWithHaiku(leads, icp) {
  if (!leads.length) return [];
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const icpDesc = [
    icp.industry ? `Industry: ${icp.industry}` : '',
    icp.role     ? `Role: ${icp.role}` : '',
    icp.company_size ? `Company size: ${icp.company_size}` : '',
    icp.geography ? `Geography: ${icp.geography}` : ''
  ].filter(Boolean).join('\n');

  const leadLines = leads.map((l, i) =>
    `Lead ${i+1}: ${l.name} | ${l.title} | ${l.company} (${l.company_size || 'unknown size'})` +
    (l._excerpt ? ` | Site: ${l._excerpt.slice(0, 200)}` : '')
  ).join('\n');

  const userMsg = `Target ICP:\n${icpDesc}\n\nLeads to classify:\n${leadLines}\n\nReturn a JSON array where each element is { "index": N, "match": true/false, "confidence": "high"|"medium"|"low", "reason": "one sentence" }. Valid JSON only, no markdown.`;

  try {
    const msg = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1200,
      temperature: 0,
      system: 'You are an ICP classifier. Return valid JSON only. No markdown.',
      messages: [{ role: 'user', content: userMsg }]
    });
    const raw = msg.content[0].text;
    const parsed = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || raw);
    return parsed;
  } catch(e) {
    console.warn('[Haiku classify] Failed:', e.message);
    return leads.map((_, i) => ({ index: i+1, match: true, confidence: 'medium', reason: 'classification unavailable' }));
  }
}

// ── Apollo People Search — pages 1–4 + quality gate + Haiku classification ───
async function fetchLeadsFromApollo(icp) {
  const APOLLO_KEY = process.env.APOLLO_API_KEY;
  if (!APOLLO_KEY) { console.log('[Apollo] No API key — skipping'); return null; }

  const role = icp?.role;
  const industry = icp?.industry;
  if (!role && !industry) { console.log('[Apollo] No ICP role/industry — skipping'); return null; }

  const baseBody = { api_key: APOLLO_KEY, per_page: 25 };
  if (role)            baseBody.person_titles = [role];
  if (industry)        baseBody.q_organization_keyword_tags = [industry];
  if (icp?.company_size) baseBody.organization_num_employees_ranges = mapCompanySize(icp.company_size);
  if (icp?.geography)  baseBody.person_locations = [icp.geography];

  console.log('[Apollo] Searching pages 1–4:', JSON.stringify({ role, industry, size: icp?.company_size, geo: icp?.geography }));

  // Step 1: Fetch pages 1–4 (up to 100 raw leads)
  const allPeople = [];
  let total = null;
  try {
    for (let page = 1; page <= 4; page++) {
      const res = await fetch('https://api.apollo.io/api/v1/mixed_people_search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ ...baseBody, page }),
        signal: AbortSignal.timeout(25000)
      });
      if (!res.ok) { console.warn(`[Apollo] HTTP ${res.status} on page ${page}`); break; }
      const data = await res.json();
      if (!total) total = data.pagination?.total_entries || null;
      const people = (data.people || []).filter(p => p.name && p.title && p.organization?.name);
      allPeople.push(...people);
      console.log(`[Apollo] Page ${page}: ${people.length} leads (total so far: ${allPeople.length})`);
      if (people.length < 25) break; // end of results
    }
  } catch(e) {
    console.warn('[Apollo] Fetch error:', e.message);
    if (!allPeople.length) return null;
  }

  if (!allPeople.length) { console.warn('[Apollo] No leads returned'); return null; }

  // Step 2: Map to lead objects
  const rawLeads = allPeople.map(p => ({
    name: p.name,
    title: p.title,
    company: p.organization?.name || '',
    company_size: fmtEmp(p.organization?.estimated_num_employees),
    website: p.organization?.primary_domain ? `https://${p.organization.primary_domain}` : null,
    linkedin_url: p.linkedin_url || null
  }));

  // Step 3: Quality gate — parallel checks (drop leads with bad/no website)
  console.log(`[Apollo] Running quality gate on ${rawLeads.length} raw leads...`);
  const qualityResults = await Promise.all(rawLeads.map(l => websiteQualityCheck(l.website)));
  const qualifiedLeads = rawLeads
    .map((l, i) => qualityResults[i] ? { ...l, _excerpt: qualityResults[i].excerpt } : null)
    .filter(Boolean);
  console.log(`[Apollo] Quality gate: ${qualifiedLeads.length}/${rawLeads.length} passed`);

  if (!qualifiedLeads.length) {
    console.warn('[Apollo] No leads passed quality gate — returning raw top-25 as fallback');
    return { leads: rawLeads.slice(0, 25).map(l => ({ ...l, confidence: 'medium' })), total };
  }

  // Step 4: Claude Haiku ICP classification
  console.log(`[Apollo] Running Haiku ICP classification on ${qualifiedLeads.length} leads...`);
  const classifications = await classifyLeadsWithHaiku(qualifiedLeads, icp);
  const classMap = {};
  classifications.forEach(c => { classMap[c.index] = c; });

  const classified = qualifiedLeads
    .map((l, i) => {
      const c = classMap[i+1] || { match: true, confidence: 'medium', reason: '' };
      return { ...l, _match: c.match, confidence: c.confidence, match_reason: c.reason };
    })
    .filter(l => l._match);

  // Sort high → medium → low, take top 25
  const ORDER = { high: 0, medium: 1, low: 2 };
  classified.sort((a, b) => (ORDER[a.confidence] || 1) - (ORDER[b.confidence] || 1));
  const finalLeads = classified.slice(0, 25).map(({ _match, _excerpt, ...l }) => l);

  console.log(`[Apollo] Final: ${finalLeads.length} ICP-matched leads (TAM total_entries: ${total})`);
  return { leads: finalLeads, total };
}

// ── Webinar title generation (Claude Sonnet) — prompts loaded from files ──────
async function generateWebinarTitles(extracted, companyName) {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const icp = extracted.icp || {};
  const role     = icp.role         || 'business owners';
  const industry = icp.industry     || 'B2B';
  const size     = icp.company_size || '';
  const geo      = icp.geography;
  const pain     = extracted.customer_pain   || 'unpredictable client acquisition';
  const result   = extracted.result_delivered || 'predictable revenue growth';
  const cs       = extracted.case_study;

  // Runtime rules injected at end of system prompt (company name + proof constraint are runtime values).
  const outputSchema = `
Runtime rules: write as ${companyName} hosting — NEVER as Quantum Scaling • titles HARD LIMIT 60 chars • bullets = specific transformations, not topics • ${cs?.numbers ? 'proof numbers verbatim from brief: ' + cs.numbers : 'no fabricated proof numbers'}
Return valid JSON only matching the Output Format schema above.`;

  let systemPrompt, userPrompt;

  if (WEBINAR_SYSTEM_TEMPLATE) {
    const businessContext = [
      `- Company: ${companyName}`,
      `- Their clients are: ${role}s at ${size ? size + ' ' : ''}companies in ${industry}`,
      `- Core pain they solve: ${pain}`,
      `- Result they deliver: ${result}`,
      cs?.numbers ? `- Client proof: ${cs.client_description || 'A client'} — ${cs.result || 'strong results'} (${cs.numbers})` : null,
      extracted.webinar_angle ? `- Webinar angle: ${extracted.webinar_angle}` : null
    ].filter(Boolean).join('\n');

    systemPrompt = interpolate(WEBINAR_SYSTEM_TEMPLATE, {
      prospect_company_name: companyName,
      icp_role:              role,
      icp_industry:          industry,
      business_context_block: businessContext,
      format_rules_block:    WEBINAR_FALLBACK_FORMAT || '(use best-practice direct-response structure)',
      principles_block:      '- Write as the prospect company hosting, never Quantum Scaling\n- Front-load ICP role in title first 40 chars\n- Every bullet is a transformation promise, not a topic',
      examples_block:        '(none loaded — generate based on context and format rules)'
    }) + outputSchema;

    userPrompt = interpolate(WEBINAR_USER_TEMPLATE, {
      prospect_company_name: companyName,
      icp_role:              role,
      icp_company_size:      size,
      icp_industry:          industry,
      icp_geography_line:    geo ? `\n**Geography:** ${geo}` : '',
      customer_pain:         pain,
      result_delivered:      result,
      case_study_block:      cs?.result ? `**Client proof:** ${cs.client_description || 'A client'} — ${cs.result}${cs.numbers ? ' (' + cs.numbers + ')' : ''}` : '',
      webinar_angle_block:   extracted.webinar_angle ? `**Webinar angle:** ${extracted.webinar_angle}` : ''
    });
  } else {
    // Inline fallback if prompt files unavailable
    systemPrompt = `You are a direct-response copywriter writing calendar blocker copy for ${companyName}'s webinar targeting ${role}s in ${industry}. Write as ${companyName} hosting — never as Quantum Scaling. Return valid JSON only.` + outputSchema;
    userPrompt   = `Generate 3 calendar blocker variants for ${companyName}'s webinar targeting ${role}s in ${industry}${size ? ' (' + size + ' companies)' : ''}.\nPain: ${pain}\nResult: ${result}${cs?.numbers ? '\nProof: ' + cs.numbers : ''}`;
  }

  console.log(`[webinar_titles] Calling Claude Sonnet (prompts from ${WEBINAR_SYSTEM_TEMPLATE ? 'files' : 'inline fallback'})...`);
  const message = await anthropic.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    temperature: 0.7,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }]
  });

  const raw = message.content[0].text;
  try {
    return JSON.parse(raw);
  } catch(e) {
    const m = raw.match(/\{[\s\S]*\}/);
    if (m) return JSON.parse(m[0]);
    throw new Error('webinar_titles: unparseable JSON from Claude');
  }
}

// ── HTTP Server ───────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  let urlPath = req.url.split('?')[0];

  // CORS preflight
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // ── POST /api/generate — real extraction pipeline ──────────────────────────
  if (req.method === 'POST' && urlPath === '/api/generate') {
    setCors(res);
    const body = await parseBody(req);
    const email = (body.email || '').trim().toLowerCase();
    const websiteUrl = (body.websiteUrl || '').trim().replace(/^https?:\/\//, '').split('/')[0].toLowerCase();

    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Valid email required' }));
      return;
    }

    try {
      const emailDomain = email.split('@')[1];
      const scrapeDomain = websiteUrl || emailDomain;
      console.log(`\n=== Generating portal for ${email} | website: ${scrapeDomain} ===`);

      // Step 1: Fireflies transcript
      const transcript = await findFirefliesTranscript(email);

      // Step 2: Website scrape — prefer explicit websiteUrl over email domain
      const website = await scrapeWebsite(scrapeDomain);

      // Step 3: Build extraction content
      let extractionParts = [];

      if (transcript) {
        const s = transcript.summary || {};
        // shorthand_bullet is the richest source — timestamped, structured, includes numbers
        const transcriptContent = [
          `MEETING: ${transcript.title}`,
          s.shorthand_bullet ? `DETAILED NOTES (structured):\n${s.shorthand_bullet}` : '',
          s.overview        ? `KEY METRICS OVERVIEW:\n${s.overview}` : '',
          s.short_summary   ? `SUMMARY:\n${s.short_summary}` : '',
          s.action_items    ? `ACTION ITEMS:\n${s.action_items}` : ''
        ].filter(Boolean).join('\n\n');

        extractionParts.push(transcriptContent);
      }

      if (website.bodyText || website.title) {
        const websiteContent = [
          `WEBSITE (${scrapeDomain}):`,
          website.title ? `Title: ${website.title}` : '',
          website.metaDesc ? `Description: ${website.metaDesc}` : '',
          website.bodyText ? `Content:\n${website.bodyText}` : ''
        ].filter(Boolean).join('\n');
        extractionParts.push(websiteContent);
      }

      if (!extractionParts.length) {
        extractionParts.push(`Prospect email: ${email}\nDomain: ${scrapeDomain}`);
      }

      const extractionContent = extractionParts.join('\n\n---\n\n');

      // Step 4: Claude extraction
      const extracted = await extractWithClaude(extractionContent);
      console.log('Extracted:', JSON.stringify(extracted, null, 2));

      const company = extracted.prospect?.company || scrapeDomain;

      // Step 5: Stage 2 — parallel generation (graceful degradation via allSettled)
      console.log('[Pipeline] Running Stage 2: webinar_titles + lead_list in parallel...');
      const [titlesResult, leadsResult] = await Promise.allSettled([
        generateWebinarTitles(extracted, company),
        fetchLeadsFromApollo(extracted.icp)
      ]);

      if (titlesResult.status === 'rejected') console.warn('[webinar_titles] Failed:', titlesResult.reason?.message);
      else console.log('[webinar_titles] Generated', titlesResult.value?.variants?.length, 'variants');

      const apolloResult = leadsResult.status === 'fulfilled' ? leadsResult.value : null;
      if (leadsResult.status === 'rejected') console.warn('[lead_list] Failed:', leadsResult.reason?.message);
      else console.log('[lead_list] Got', apolloResult?.leads?.length ?? 0, 'leads, TAM:', apolloResult?.total);

      // Embed generated assets in extracted JSONB (no schema change needed)
      extracted._generated = {
        webinarTitles: titlesResult.status === 'fulfilled' ? titlesResult.value : null,
        leads: apolloResult?.leads || null,
        apolloTotal: apolloResult?.total || null
      };

      // Step 6: Build and store session
      const sessionToken = generateToken();
      const sessionData = {
        email,
        domain: scrapeDomain,
        transcript: transcript ? {
          id: transcript.id,
          title: transcript.title,
          date: transcript.dateString,
          found: true
        } : { found: false },
        website: {
          domain: scrapeDomain,
          title: website.title,
          scraped: !!(website.bodyText)
        },
        extracted
      };

      await saveSession(sessionToken, sessionData);

      const name = extracted.prospect?.name;
      const industry = extracted.icp?.industry || 'consulting';

      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        sessionToken,
        company,
        name,
        industry,
        transcriptFound: !!(transcript),
        websiteScraped: !!(website.bodyText),
        portalUrl: `/?session=${sessionToken}`
      }));

    } catch(err) {
      console.error('Generate pipeline error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Pipeline failed' }));
    }
    return;
  }

  // ── GET /api/portal-data — serve session data to portal ───────────────────
  if (req.method === 'GET' && urlPath === '/api/portal-data') {
    setCors(res);
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const sessionToken = params.get('session');
    const data = await getSession(sessionToken);

    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
    return;
  }

  // ── LinkedIn avatar proxy ──────────────────────────────────────────────────
  if (urlPath === '/lloyd-avatar') {
    const linkedinUrl = 'https://media.licdn.com/dms/image/v2/C4E03AQEtIxMkjlDmyA/profile-displayphoto-shrink_200_200/0/1638042721905';
    const options = {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.linkedin.com/',
        'Accept': 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
      }
    };
    https.get(linkedinUrl, options, (upstream) => {
      if (upstream.statusCode === 200) {
        res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=86400' });
        upstream.pipe(res);
      } else { res.writeHead(404); res.end(); }
    }).on('error', () => { res.writeHead(404); res.end(); });
    return;
  }

  // ── Static file serving ───────────────────────────────────────────────────
  if (urlPath === '/' || urlPath === '') urlPath = '/mockup-portal.html';
  if (urlPath === '/dashboard') urlPath = '/mockup-dashboard.html';

  const filePath = path.join(__dirname, urlPath);
  const ext = path.extname(filePath);

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
    res.end(data);
  });
});

server.listen(PORT, '0.0.0.0', async () => {
  console.log(`Deal Forge running on port ${PORT}`);
  console.log(`Session store: ${USE_SUPABASE ? 'Supabase (persistent)' : 'In-memory (no SUPABASE_URL/SUPABASE_SERVICE_KEY set)'}`);
  await ensureSessionsTable();
});
