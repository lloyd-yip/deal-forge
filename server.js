const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');

const PORT = process.env.PORT || 3000;
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.jpg': 'image/jpeg' };

// ── Session store (in-memory, 24h TTL) ──────────────────────────────────────
const sessions = new Map();
function generateToken() { return Math.random().toString(36).slice(2) + Date.now().toString(36); }

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

    if (!email || !email.includes('@')) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Valid email required' }));
      return;
    }

    try {
      const domain = email.split('@')[1];
      console.log(`\n=== Generating portal for ${email} ===`);

      // Step 1: Fireflies transcript
      const transcript = await findFirefliesTranscript(email);

      // Step 2: Website scrape (parallel-safe, transcript lookup already done)
      const website = await scrapeWebsite(domain);

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
          `WEBSITE (${domain}):`,
          website.title ? `Title: ${website.title}` : '',
          website.metaDesc ? `Description: ${website.metaDesc}` : '',
          website.bodyText ? `Content:\n${website.bodyText}` : ''
        ].filter(Boolean).join('\n');
        extractionParts.push(websiteContent);
      }

      if (!extractionParts.length) {
        extractionParts.push(`Prospect email: ${email}\nDomain: ${domain}`);
      }

      const extractionContent = extractionParts.join('\n\n---\n\n');

      // Step 4: Claude extraction
      const extracted = await extractWithClaude(extractionContent);
      console.log('Extracted:', JSON.stringify(extracted, null, 2));

      // Step 5: Build and store session
      const sessionToken = generateToken();
      const sessionData = {
        email,
        domain,
        transcript: transcript ? {
          id: transcript.id,
          title: transcript.title,
          date: transcript.dateString,
          found: true
        } : { found: false },
        website: {
          domain,
          title: website.title,
          scraped: !!(website.bodyText)
        },
        extracted
      };

      sessions.set(sessionToken, sessionData);
      setTimeout(() => sessions.delete(sessionToken), 24 * 60 * 60 * 1000);

      const company = extracted.prospect?.company || domain;
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
    const data = sessions.get(sessionToken);

    if (!data) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found or expired' }));
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

server.listen(PORT, '0.0.0.0', () => console.log(`Deal Forge running on port ${PORT}`));
