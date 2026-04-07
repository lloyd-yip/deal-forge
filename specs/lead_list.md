# Task Spec: lead_list

**Pipeline stage:** 2 — parallel with brand_scrape, webinar_titles, roi_model
**Depends on:** `extract` completed (`jobs.extracted_data.icp` populated)
**Blocks:** Nothing (Stage 3 tasks do not depend on lead_list)
**Model:** Claude Haiku (ICP classification only)
**Temperature:** 0
**Max tokens:** 200 per lead (batch classification)
**Status:** PARTIALLY SPECCED — blocked on Ample Leads actor ID + credentials

---

## 1. What This Task Does

Generates a list of 25 verified, ICP-matched leads for the prospect — people who look exactly like their ideal customer.

The rep uses this list to demonstrate to the prospect on Call 2: "Here are 25 real people in your exact target market who we could be inviting to your webinar right now."

This is a 5-step sub-pipeline run sequentially within a single task:

1. **ICP extraction** — read ICP fields from `jobs.extracted_data`
2. **Lead fetch** — call Ample Leads (via Apify actor) to pull raw leads matching ICP criteria
3. **Website quality gate** — for each lead with a website URL, run deterministic quality checks to filter out broken, thin, or parked pages
4. **Website crawl** — for leads that pass quality gate, fetch company website content for ICP classification context
5. **ICP classification** — Claude Haiku scores each lead against the ICP; keep top 25

Without the 5-step filter, raw Ample Leads results are ~50% irrelevant. The quality gate eliminates garbage leads deterministically (fast, free). The website crawl + Claude filter is what makes the final list credible enough to put in front of a prospect.

**Design principle:** It is better to have a smaller list of quality-verified leads than a full list padded with weak matches. If we pull 50 raw records and 25 pass the quality gate and ICP filter, that is the correct output. We do not pad with lower-quality leads to hit 25.

---

## 2. Inputs

| Field | Source | Required | Null handling |
|-------|--------|----------|---------------|
| `extracted_data.icp.industry` | jobs.extracted_data | Required | null → needs_input status |
| `extracted_data.icp.role` | jobs.extracted_data | Required | null → needs_input status |
| `extracted_data.icp.company_size` | jobs.extracted_data | Required | null → needs_input status |
| `extracted_data.icp.geography` | jobs.extracted_data | Optional | null → omit geographic filter |

**Scope constraint:** Deal Forge only supports standard B2B ICPs — those targetable by industry, job title, company size, and geography via a lead database. Edge-case ICPs (e.g., "parents of SAT tutoring students") that are not resolvable through a B2B lead database are out of scope. If ICP fields are present but describe a non-B2B audience, the rep should manually note this and skip lead_list.

If any required ICP field is null: set task status `needs_input`, surface to rep dashboard for manual entry. Do not attempt lead fetch with incomplete ICP.

---

## 3. External API Calls

### 3a. Ample Leads via Apify Actor

⚠️ **BLOCKED — credentials and actor ID pending from team member**

What is known:
- Ample Leads is a B2B lead database accessible via an Apify actor
- Input will include ICP filters: industry, job title/role, company size, geography
- Output will be raw lead records: name, title, company, company size, website URL, LinkedIn URL
- Expected raw result size: 50–200 records before filtering

What is unknown (must be resolved before build):
- Apify actor ID (e.g. `username/actor-name`)
- Exact input schema (field names for industry, title, company_size filters)
- Output schema (field names in returned records)
- Rate limits and pricing per run
- Whether geography filter is supported or must be post-filtered

**Placeholder in code:** `AMPLE_LEADS_ACTOR_ID` env var. Input schema to be filled in once isolated and tested via `/api-isolation`.

### 3b. Website Quality Gate (deterministic — no external API)

Runs **before** the Apify crawl to eliminate leads that won't yield useful classification context. This is pure code — no model involved.

A lead's website **fails** the quality gate if ANY of the following are true:
1. HTTP response is not 200 OK (unreachable, redirects to error page, domain expired)
2. `<title>` tag is missing, empty, or matches the bare domain name only (e.g., `example.com`)
3. None of the following are present: `<meta name="description">`, `<h1>`, or body text
4. Body text word count is under 50 words
5. Page contains any of the following parking/placeholder signals:
   - "this domain is for sale"
   - "domain for sale"
   - "coming soon"
   - "under construction"
   - "buy this domain"
   - "parked by"

**On failure:** Lead is dropped from the pipeline entirely. Next lead from the raw pool is pulled. No fallback to Claude with thin data.

**Leads with no website URL at all:** Also dropped. We require a working website to verify ICP fit. A lead without a verifiable web presence is not a lead we want in this demo.

**Timeout per quality check:** 10 seconds. If a site doesn't respond in 10s, treat as failed (rule 1).

### 3c. Website Crawl — Apify (per lead that passes quality gate)

- **Actor:** `apify/web-scraper`
- **Input:** `{ "startUrls": [{ "url": "<lead.company_website>" }], "maxCrawlPages": 1 }`
- **What we extract:** `<title>`, `<meta name="description">`, `<h1>`, first body paragraph
- **Concurrency:** up to 10 website crawls in parallel
- **Per-lead timeout:** 15 seconds. If a site doesn't respond in 15s: mark lead `website_unavailable` and drop (do not pass to Claude with no content — quality gate already filtered out thin sites, so a timeout here is a different failure)

---

## 4. Claude Call — ICP Classification

Called once per lead (batched — all passing leads in one pass).

**Input per lead:** name, title, company name, company size, company website content (title + description + h1 + first paragraph)
**Output per lead:** `{ "match": true/false, "confidence": "high/medium/low", "reason": "one sentence" }`

### System prompt
```
You are an ICP (Ideal Customer Profile) classifier. Given a lead's profile and a target ICP definition, determine if this lead is a strong match.

Return valid JSON only. No markdown, no explanation.
```

### User prompt (per lead in batch)
```
Target ICP:
- Industry: {{icp.industry}}
- Role: {{icp.role}}
- Company size: {{icp.company_size}}
{{if icp.geography}}- Geography: {{icp.geography}}{{/if}}

Lead:
- Name: {{lead.name}}
- Title: {{lead.title}}
- Company: {{lead.company}}
- Company size: {{lead.company_size}}
- Website content: {{lead.website_excerpt}}

Return: { "match": true/false, "confidence": "high/medium/low", "reason": "one sentence" }
```

### Selection logic
1. Keep all `match: true` leads, sorted: `high` confidence first, then `medium`, then `low`
2. Take top 25
3. If fewer than 25 matches: return what's available (partial list is correct — do not pad)
4. Mark `completed` regardless of whether 25 were reached

---

## 5. Processing Logic

1. Read ICP fields from `jobs.extracted_data`
2. If any required ICP field is null: set task `needs_input`, list missing fields, exit
3. Call Ample Leads actor with ICP filters → receive raw leads (50–200 records)
4. If Ample Leads returns 0 results: retry once with loosened filters (drop geography if present). If still 0: mark task `failed` with `"No leads found for this ICP"`
5. For each raw lead: run website quality gate (Step 3b). Drop leads that fail any quality check
6. If fewer than 10 leads pass quality gate: retry Ample Leads with broader filters (e.g., loosen company_size range). If still fewer than 10 pass: continue with what's available
7. For each lead that passes quality gate: crawl website via Apify (up to 10 concurrent, 15s timeout)
8. If crawl times out for a lead: drop that lead (quality gate passed but crawl failed)
9. Call Claude Haiku to classify all crawled leads against the ICP — batch all leads in one prompt call
10. Sort by match=true, then confidence (high → medium → low)
11. Take top 25 (or all matches if fewer than 25)
12. Write to `tasks.output_data`
13. Mark task `completed`

---

## 6. Output Schema

Written to: `tasks.output_data` (JSONB on tasks table — not jobs table, unlike extract/prospect_research/brand_scrape)

Reason: lead_list output is not needed by any other task. Writing to tasks.output_data keeps the jobs table lean.

```json
{
  "leads": [
    {
      "name": "string",
      "title": "string",
      "company": "string",
      "company_size": "string",
      "website": "string — verified working URL",
      "linkedin_url": "string | null",
      "confidence": "high | medium | low",
      "match_reason": "string — one sentence from Claude"
    }
  ],
  "total_raw": "number — leads returned by Ample Leads before filtering",
  "total_quality_passed": "number — leads that passed deterministic quality gate",
  "total_matched": "number — leads that passed ICP classification",
  "total_returned": "number — leads in final list (max 25)",
  "icp_used": {
    "industry": "string",
    "role": "string",
    "company_size": "string",
    "geography": "string | null"
  }
}
```

**Display columns (rep dashboard spreadsheet view):** Name, Title, Company, Company Size, Website (clickable), LinkedIn (clickable), Confidence.

Industry is not displayed — it is implied by the ICP and would be the same for every row.

---

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| Required ICP field null | `needs_input` status, error lists missing fields |
| Non-B2B edge case ICP | Rep manually skips — out of scope for Deal Forge |
| Ample Leads 401 | Hard fail — invalid credentials |
| Ample Leads 0 results | Retry with loosened filters; if still 0 → `failed` |
| Ample Leads actor timeout | Hard fail after 2 attempts |
| Lead fails website quality gate | Dropped from pipeline — not a failure |
| Lead has no website URL | Dropped from pipeline — not a failure |
| Website crawl timeout per lead | Drop lead — not a failure |
| Claude returns invalid JSON | Retry once with JSON-only instruction; if still invalid → `failed` |
| Fewer than 25 matches | Return partial list, mark `completed` (not failed) |

---

## 8. Timeout & Recovery

- **p50 execution time:** ~90 seconds (Ample Leads fetch + quality checks + parallel website crawls + Claude batch)
- **p99 execution time:** ~4 minutes (slow Ample Leads + many slow sites)
- **Task timeout:** 8 minutes (longest task in the pipeline by far)
- **Retry idempotent?** Yes — re-running overwrites `tasks.output_data`

---

## 9. Idempotency

- Writes to `tasks.output_data` — overwrite on re-run
- Ample Leads query with same ICP → same result pool
- Quality gate is deterministic — same site, same result
- Claude at temperature 0 → deterministic classification
- Website crawls → same content (assuming no major site changes between runs)
- Safe to retry

---

## 10. Data Flow

```
[jobs.extracted_data.icp]
         ↓
[Ample Leads actor] → raw leads (50-200)
         ↓
[Website quality gate — deterministic] → drop broken/parked/thin sites
         ↓
[Apify website crawls] → company context per lead (parallel, 10 concurrent)
         ↓
[Claude Haiku — ICP classification] → match: true/false, confidence
         ↓
  top 25 matched leads
         ↓
  tasks.output_data
         ↓
     [rep dashboard] — displayed as lead list spreadsheet asset
```

---

## 11. Open Items (must resolve before build)

- [ ] Obtain Ample Leads Apify actor ID from team member
- [ ] Obtain Apify API key scoped to Ample Leads actor
- [ ] Run `/api-isolation` on Ample Leads actor with a test ICP to validate input/output schema
- [ ] Confirm: does Ample Leads support geography filter natively, or is post-filter required?
- [ ] Confirm: does Ample Leads return company_size in lead records? (required for output schema)
- [ ] Validate cost per Ample Leads run (Apify actor compute units)

---

## 12. Sign-Off Checklist

- [x] Dependency graph complete — Stage 2 parallel, blocks nothing
- [x] Input contract defined with needs_input handling for null ICP
- [x] B2B scope constraint documented (edge case ICPs out of scope)
- [x] 5-step sub-pipeline fully described
- [x] Ample Leads section marked BLOCKED with known unknowns listed
- [x] Website quality gate: 5 deterministic rejection rules defined
- [x] Drop-on-fail policy explicit: no fallback to thin-data classification
- [x] Website crawl concurrency and timeout defined
- [x] Claude classification prompt written (Haiku, temp 0)
- [x] Selection logic defined — partial list is correct, not padded
- [x] Output schema defined — writes to tasks.output_data (not jobs table)
- [x] Display columns defined: Name, Title, Company, Company Size, Website, LinkedIn, Confidence
- [x] Error handling table complete
- [x] Timeout set (8 min) — justified as longest task in pipeline
- [x] Idempotency confirmed
- [x] Open items listed explicitly

**Status:** PARTIALLY SPECCED — architecture complete, blocked on Ample Leads credentials
