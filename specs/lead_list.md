# Task Spec: lead_list

**Pipeline stage:** 2 — parallel with brand_scrape, webinar_titles, roi_model
**Depends on:** `extract` completed (`jobs.extracted_data.icp` populated)
**Blocks:** Nothing (Stage 3 tasks do not depend on lead_list)
**Model:** Claude Haiku (ICP classification only)
**Temperature:** 0
**Max tokens:** 200 per lead (batch classification)
**Status:** FULLY SPECCED — Apollo.io API (replaces Ample Leads/Apify)

---

## 1. What This Task Does

Generates a list of 25 verified, ICP-matched leads for the prospect — people who look exactly like their ideal customer.

The rep uses this list to demonstrate to the prospect on Call 2: "Here are 25 real people in your exact target market who we could be inviting to your webinar right now."

This is a 5-step sub-pipeline run sequentially within a single task:

1. **ICP extraction** — read ICP fields from `jobs.extracted_data`
2. **Lead fetch** — call Apollo.io People Search API to pull raw leads matching ICP criteria
3. **Website quality gate** — for each lead with a website URL, run deterministic quality checks to filter out broken, thin, or parked pages
4. **Website crawl** — for leads that pass quality gate, fetch company website content for ICP classification context
5. **ICP classification** — Claude Haiku scores each lead against the ICP; keep top 25

Without the 5-step filter, raw Apollo results are ~50% irrelevant (title mismatches, wrong industry, stale data). The quality gate eliminates garbage leads deterministically (fast, free). The website crawl + Claude filter is what makes the final list credible enough to put in front of a prospect.

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

### 3a. Apollo.io People Search API

- **Endpoint:** `POST https://api.apollo.io/api/v1/mixed_people_search`
- **Auth:** `api_key` in request body (env var: `APOLLO_API_KEY`)
- **Expected raw result size:** 50–100 records per request (paginated, `per_page: 25` max per page)

**Request body — ICP filter mapping:**

| ICP field from extracted_data | Apollo parameter |
|-------------------------------|-----------------|
| `icp.role` | `person_titles[]` — array with the role string |
| `icp.industry` | `q_organization_keyword_tags[]` — industry keywords |
| `icp.company_size` | `organization_num_employees_ranges[]` — ranges like `"1,10"`, `"11,50"`, `"51,200"`, `"201,500"`, `"501,1000"` |
| `icp.geography` | `person_locations[]` — city, state, or country strings |

**Company size mapping (extracted_data string → Apollo range):**

| extracted_data says | Apollo ranges |
|---------------------|--------------|
| "solopreneur", "1-person", "solo" | `["1,1"]` |
| "small", "1-10", "under 10" | `["1,10"]` |
| "10-50", "startup", "small team" | `["1,10","11,50"]` |
| "50-200", "mid-size", "growing" | `["51,200"]` |
| "200-500", "mid-market" | `["201,500"]` |
| "500+", "enterprise", "large" | `["501,1000","1001,10000"]` |

If company_size string doesn't map cleanly: use `["11,50","51,200"]` as default (typical QS ICP sweet spot).

**Response fields used:**

| Apollo field | Maps to |
|-------------|---------|
| `people[].name` | `lead.name` |
| `people[].title` | `lead.title` |
| `people[].organization.name` | `lead.company` |
| `people[].organization.estimated_num_employees` | `lead.company_size` |
| `people[].organization.primary_domain` | `lead.company_website` (prepend `https://` if no scheme) |
| `people[].linkedin_url` | `lead.linkedin_url` |

**Pagination strategy:** Fetch pages 1–4 (`per_page: 25`, `page: 1..4`) = up to 100 raw leads. Stop early if fewer than 25 results on any page (end of results).

**Rate limits:** Apollo free/basic plan allows ~100 requests/month. Each lead_list run uses 4 requests. At scale (25 jobs/month), this is 100 requests — right at the limit. If credits become constrained, reduce to 2 pages (50 leads) — still sufficient for quality filtering to 25.

**Error handling:**

| Status | Behavior |
|--------|----------|
| 401 | Hard fail — invalid API key |
| 422 | Hard fail — ICP filters produced invalid query |
| 429 | Retry after 60s, max 2 attempts |
| 0 results across all pages | Retry with loosened filters (drop geography if present). If still 0 → `failed` |

**Pre-build required:** Run `/api-isolation` with a test ICP before writing integration code. Validate: input schema matches Apollo docs, `primary_domain` field consistently populated, company size returned correctly.

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
3. Call Apollo People Search API with ICP filters → paginate pages 1–4, collect up to 100 raw leads
4. If Apollo returns 0 results across all pages: retry once with loosened filters (drop geography if present). If still 0: mark task `failed` with `"No leads found for this ICP"`
5. For each raw lead: run website quality gate (Step 3b). Drop leads that fail any quality check
6. If fewer than 10 leads pass quality gate: retry Apollo with broader filters (e.g., loosen company_size range). If still fewer than 10 pass: continue with what's available
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
| Apollo 401 | Hard fail — invalid API key |
| Apollo 0 results | Retry with loosened filters; if still 0 → `failed` |
| Apollo 429 | Retry after 60s, max 2 attempts |
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

- [ ] Run `/api-isolation` on Apollo People Search API with a test ICP — confirm `primary_domain` is consistently populated and company size is returned
- [ ] Validate ICP-to-Apollo-filter mapping with a real transcript (does Claude's company_size output map cleanly to Apollo ranges?)
- [ ] Monitor Apollo credit usage once live — 100 credits/month is tight at 25 jobs/month; may need to upgrade plan or reduce pages fetched per run
- [x] Apollo API key obtained: `APOLLO_API_KEY` env var

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

**Status:** FULLY SPECCED — run `/api-isolation` on Apollo before building
