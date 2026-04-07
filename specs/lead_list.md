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

This is a 4-step sub-pipeline run sequentially within a single task:

1. **ICP extraction** — read ICP fields from `jobs.extracted_data`
2. **Lead fetch** — call Ample Leads (via Apify actor) to pull raw leads matching ICP criteria
3. **Website crawl** — for each raw lead, fetch their company website to get enough context for ICP matching
4. **ICP classification** — Claude Haiku scores each lead against the ICP; keep top 25

Without the 4-step filter, raw Ample Leads results are ~50% irrelevant. The website crawl + Claude filter is what makes the list credible enough to put in front of a prospect.

---

## 2. Inputs

| Field | Source | Required | Null handling |
|-------|--------|----------|---------------|
| `extracted_data.icp.industry` | jobs.extracted_data | Required | null → needs_input status |
| `extracted_data.icp.role` | jobs.extracted_data | Required | null → needs_input status |
| `extracted_data.icp.company_size` | jobs.extracted_data | Required | null → needs_input status |
| `extracted_data.icp.geography` | jobs.extracted_data | Optional | null → omit geographic filter |

If any required ICP field is null: set task status `needs_input`, surface to rep dashboard for manual entry. Do not attempt lead fetch with incomplete ICP — list quality will be garbage.

---

## 3. External API Calls

### 3a. Ample Leads via Apify Actor

⚠️ **BLOCKED — credentials and actor ID pending from team member**

What is known:
- Ample Leads is a B2B lead database accessible via an Apify actor
- Input will include ICP filters: industry, job title/role, company size, geography
- Output will be raw lead records: name, title, company, website URL, LinkedIn URL
- Expected raw result size: 50–200 records before filtering

What is unknown (must be resolved before build):
- Apify actor ID (e.g. `username/actor-name`)
- Exact input schema (field names for industry, title, company_size filters)
- Output schema (field names in returned records)
- Rate limits and pricing per run
- Whether geography filter is supported or must be post-filtered

**Placeholder in code:** `AMPLE_LEADS_ACTOR_ID` env var. Input schema to be filled in once isolated and tested via `/api-isolation`.

### 3b. Website Crawl — Apify (per lead)

- **Actor:** `apify/web-scraper`
- **Input:** `{ "startUrls": [{ "url": "<lead.company_website>" }], "maxCrawlPages": 1 }`
- **What we extract:** `<title>`, `<meta name="description">`, `<h1>`, first body paragraph — enough for ICP classification
- **Concurrency:** run up to 10 website crawls in parallel (Apify handles this natively)
- **Per-lead timeout:** 15 seconds. If a site doesn't respond in 15s, skip it — mark that lead as `website_unavailable`, still pass to Claude with available data
- **Skip if:** lead has no website URL in their record

---

## 4. Claude Call — ICP Classification

Called once per lead (batched — up to 50 leads in one pass).

**Input per lead:** name, title, company name, company website content (title + description + h1)
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
- Website content: {{lead.website_excerpt}}

Return: { "match": true/false, "confidence": "high/medium/low", "reason": "one sentence" }
```

### Selection logic
1. Keep all `match: true` leads, sorted: `high` confidence first, then `medium`, then `low`
2. Take top 25
3. If fewer than 25 high/medium matches: include low confidence matches to reach 25
4. If fewer than 25 total matches: return what's available (partial list is better than nothing)

---

## 5. Processing Logic

1. Read ICP fields from `jobs.extracted_data`
2. If any required ICP field is null: set task `needs_input`, set error message listing missing fields, exit
3. Call Ample Leads actor with ICP filters → receive raw leads (50–200 records)
4. If Ample Leads returns 0 results: retry once with loosened filters (drop geography if present). If still 0: mark task `failed` with `"No leads found for this ICP"`
5. For each raw lead with a website URL: crawl website (up to 10 concurrent, 15s timeout each)
6. For leads without website URL or where crawl timed out: use available data only (name + title + company name)
7. Call Claude Haiku to classify all leads against the ICP — batch all leads in one prompt call
8. Sort by match=true, then confidence (high → medium → low)
9. Take top 25
10. Write to `tasks.output_data` (NOT jobs table — this output is task-specific, not shared across tasks)
11. Mark task `completed`

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
      "website": "string | null",
      "linkedin_url": "string | null",
      "confidence": "high | medium | low",
      "match_reason": "string — one sentence from Claude"
    }
  ],
  "total_raw": "number — leads returned by Ample Leads before filtering",
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

---

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| Required ICP field null | `needs_input` status, error lists missing fields |
| Ample Leads 401 | Hard fail — invalid credentials |
| Ample Leads 0 results | Retry with loosened filters; if still 0 → `failed` |
| Ample Leads actor timeout | Hard fail after 2 attempts |
| Website crawl timeout per lead | Skip site, pass lead to Claude with available data only |
| Claude returns invalid JSON | Retry once with JSON-only instruction; if still invalid → `failed` |
| Fewer than 25 matches | Return partial list, mark `completed` (not failed) |

---

## 8. Timeout & Recovery

- **p50 execution time:** ~90 seconds (Ample Leads fetch + 50 parallel website crawls + Claude batch)
- **p99 execution time:** ~4 minutes (slow Ample Leads + many slow sites)
- **Task timeout:** 8 minutes (longest task in the pipeline by far)
- **Retry idempotent?** Yes — re-running overwrites `tasks.output_data`

---

## 9. Idempotency

- Writes to `tasks.output_data` — overwrite on re-run
- Ample Leads query with same ICP → same result pool
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
[Apify website crawls] → company context per lead (parallel, 10 concurrent)
         ↓
[Claude Haiku — ICP classification] → match: true/false, confidence
         ↓
  top 25 matched leads
         ↓
  tasks.output_data
         ↓
     [rep dashboard] — displayed as lead list asset card
```

---

## 11. Open Items (must resolve before build)

- [ ] Obtain Ample Leads Apify actor ID from team member
- [ ] Obtain Apify API key scoped to Ample Leads actor
- [ ] Run `/api-isolation` on Ample Leads actor with a test ICP to validate input/output schema
- [ ] Confirm: does Ample Leads support geography filter natively, or is post-filter required?
- [ ] Confirm: does Ample Leads return website URLs in lead records? (required for website crawl step)
- [ ] Validate cost per Ample Leads run (Apify actor compute units)

---

## 12. Sign-Off Checklist

- [x] Dependency graph complete — Stage 2 parallel, blocks nothing
- [x] Input contract defined with needs_input handling for null ICP
- [x] 4-step sub-pipeline fully described
- [x] Ample Leads section marked BLOCKED with known unknowns listed
- [x] Website crawl concurrency and timeout defined
- [x] Claude classification prompt written
- [x] Selection logic for top 25 defined
- [x] Output schema defined — writes to tasks.output_data (not jobs table)
- [x] Error handling table complete
- [x] Timeout set (8 min) — justified as longest task in pipeline
- [x] Idempotency confirmed
- [x] Open items listed explicitly

**Status:** PARTIALLY SPECCED — architecture complete, blocked on Ample Leads credentials
