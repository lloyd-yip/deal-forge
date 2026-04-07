# Task Spec: extract

**Stage:** 1
**Status:** Specced (updated with Section 2.5 copy-gen fields)
**Last updated:** 2026-04-06

---

## Section 1 — Identity & Stage

- **Task name:** `extract`
- **Stage:** 1 (first task — all Stage 2 tasks are blocked until this completes)
- **Trigger:** Job created with a valid `fireflies_meeting_id`
- **Depends on:** Nothing (first in pipeline)
- **Blocks:** All Stage 2 tasks: `brand_scrape`, `lead_list`, `webinar_titles`, `roi_model`, `email_sequence`
- **Parallel with:** `prospect_research` (also Stage 1, reads from job record independently)

---

## Section 2 — Input Contract

| Field | Type | Source | Required | Null handling |
|---|---|---|---|---|
| `job.fireflies_meeting_id` | string | jobs table | Required | Job fails at creation if missing |
| `job.prospect_company` | string | jobs table | Required | Job fails at creation if missing |
| `job.prospect_website` | string | jobs table | Optional | null → downstream tasks degrade gracefully |

**Primary extraction source:** Fireflies `notes` field (the AI-generated meeting summary/transcript notes).
Fallback if `notes` is empty: use `transcript` field (raw transcript text).
If both empty: task fails with `"No Fireflies content available"` — hard fail, no retry.

---

## Section 3 — External API Calls

**Fireflies GraphQL API**
- Endpoint: `https://api.fireflies.ai/graphql`
- Auth: `Authorization: Bearer <FIREFLIES_API_KEY>` (env var)
- Query: fetch transcript by `id`, read `notes` field (primary), `transcript` field (fallback)
- On 401: hard fail — invalid key
- On 404: hard fail — meeting ID not found, rep entered wrong ID
- On 429: retry with 30s backoff, max 3 attempts
- On 500: retry with 60s backoff, max 2 attempts

---

## Section 4 — Claude Prompt Design

**Model:** claude-haiku (extraction task — deterministic, no creativity needed)
**Temperature:** 0
**Max tokens:** 1500

### System prompt

```
You are a data extraction assistant. Extract structured business information from a sales call transcript or meeting notes.

Return valid JSON only. No markdown, no explanation, no preamble.

Null rules (critical):
- If a field was not discussed on this call, return null — never infer, guess, or hallucinate
- If numbers are mentioned but vague ("a lot", "significant"), return null for that field — only extract verbatim figures
- case_study: if no specific client story with real numbers was shared, return null for the entire object
- icp.geography: null unless explicitly mentioned
```

### User prompt template

```
Extract the following from this sales call transcript/notes:

---
{{FIREFLIES_NOTES}}
---

Return this exact JSON structure:

{
  "prospect": {
    "name": "string | null — prospect's full name if mentioned",
    "company": "string — company name",
    "website": "string | null — website if mentioned"
  },
  "icp": {
    "industry": "string — industry or vertical of their target customers",
    "role": "string — job title or role of the buyer in their target company",
    "company_size": "string — revenue range, headcount, or stage as described",
    "geography": "string | null — only if explicitly mentioned"
  },
  "business": {
    "revenue": "string | null — approximate annual revenue if mentioned",
    "growth_rate": "string | null — trajectory described",
    "active_clients": "number | null",
    "sales_cycle": "string | null — duration from first contact to payment",
    "ltv": "string | null — lifetime value per client, verbatim",
    "deal_size": "string | null — average deal value",
    "positioning": "string | null — how they describe their differentiation",
    "close_rate": "string | null — current closing percentage if mentioned, verbatim (e.g. '20%')",
    "show_rate": "string | null — current call show rate if mentioned, verbatim (e.g. '70%')"
  },
  "customer_pain": "string | null — the core problem or frustration their ICP experiences, in customer language — not the prospect's solution language",
  "result_delivered": "string | null — the specific outcome or transformation the prospect provides to clients",
  "case_study": {
    "client_description": "string | null — type of client, no names needed",
    "result": "string | null — what changed for that client",
    "numbers": "string | null — verbatim figures only, e.g. '$180K in 90 days'"
  },
  "webinar_angle": "string | null — the topic or teaching angle they described for their webinar",
  "current_marketing": "string | null — how they currently generate leads/clients",
  "goals": "string | null — what they want to achieve in the next 6-12 months"
}
```

---

## Section 5 — Processing Logic

1. Read `job.fireflies_meeting_id` from the jobs table
2. Call Fireflies GraphQL API to fetch the meeting record
3. Extract `notes` field. If empty or null, fall back to `transcript` field
4. If both empty: mark task `failed`, set error `"No Fireflies content available for meeting {id}"`, hard fail
5. Build Claude user prompt by injecting the notes/transcript text
6. Call Claude Haiku with system + user prompt, temperature 0, max_tokens 1500
7. Parse the JSON response
8. If JSON parse fails: retry once with a "return only valid JSON" correction prompt. If still fails: hard fail
9. Write parsed object to `jobs.extracted_data`
10. Mark task `completed`

---

## Section 6 — Output Schema

Written to: `jobs.extracted_data` (JSONB column on the jobs table — not tasks.output_data)

Reason: all 5 Stage 2 tasks need this data. Storing on the job record avoids joins.

```json
{
  "prospect": {
    "name": "string | null",
    "company": "string",
    "website": "string | null"
  },
  "icp": {
    "industry": "string",
    "role": "string",
    "company_size": "string",
    "geography": "string | null"
  },
  "business": {
    "revenue": "string | null",
    "growth_rate": "string | null",
    "active_clients": "number | null",
    "sales_cycle": "string | null",
    "ltv": "string | null",
    "deal_size": "string | null",
    "positioning": "string | null",
    "close_rate": "string | null",
    "show_rate": "string | null"
  },
  "customer_pain": "string | null",
  "result_delivered": "string | null",
  "case_study": {
    "client_description": "string | null",
    "result": "string | null",
    "numbers": "string | null"
  } ,
  "webinar_angle": "string | null",
  "current_marketing": "string | null",
  "goals": "string | null"
}
```

**Retro-patch support:** Reps can patch individual fields in `extracted_data` via a dashboard UI after job creation (e.g., add a case study found post-call). Patching `case_study`, `customer_pain`, `result_delivered`, or `webinar_angle` should allow manual re-trigger of affected tasks: `webinar_titles`, `email_sequence`, `calendar_visual`. This is a Phase 3 (dashboard) feature — not required for the worker build.

---

## Section 7 — Error Handling

| Failure | Probability | Task status | Job status | Rep sees |
|---|---|---|---|---|
| Fireflies 401 (bad key) | Low | failed, no retry | failed | "Fireflies API key invalid. Contact admin." |
| Fireflies 404 (bad meeting ID) | Medium | failed, no retry | failed | "Meeting not found. Check the Fireflies meeting ID and try again." |
| Fireflies 429 (rate limit) | Low | failed → retry | unchanged | Nothing (retrying) |
| Fireflies empty notes + empty transcript | Medium | failed, no retry | failed | "No transcript found for this meeting. Check that Fireflies was active on the call." |
| Claude JSON parse failure (2 attempts) | Low | failed, no retry | failed | "Could not extract data from transcript. Try re-running or contact support." |
| Claude 529 (overloaded) | Low | failed → retry | unchanged | Nothing (retrying) |

---

## Section 8 — Timeout & Recovery

- **p50 execution time:** ~8 seconds (Fireflies fetch + Claude Haiku call)
- **p99 execution time:** ~25 seconds (slow Fireflies response + Claude latency)
- **Task timeout:** 2 minutes (well above p99; recovery cron fires after this)
- **Retry idempotent?** Yes — re-running extract overwrites `extracted_data` with the same result

---

## Section 9 — Idempotency

- Running extract twice produces identical output (same transcript → same Claude output at temp 0)
- No duplicate records created — writes to `jobs.extracted_data` on the parent job record (upsert behavior)
- Safe to retry without cleanup

---

## Section 10 — Data Flow

```
[Fireflies API]
  --notes/transcript-->
    [extract task]
      --jobs.extracted_data.icp-->              [lead_list]
      --jobs.extracted_data.business.ltv-->         [roi_model]
      --jobs.extracted_data.business.close_rate-->  [roi_model]
      --jobs.extracted_data.business.show_rate-->   [roi_model]
      --jobs.extracted_data.icp-->              [webinar_titles]
      --jobs.extracted_data.customer_pain-->    [webinar_titles]
      --jobs.extracted_data.result_delivered--> [webinar_titles]
      --jobs.extracted_data.case_study-->       [webinar_titles]
      --jobs.extracted_data.webinar_angle-->    [webinar_titles]
      --jobs.extracted_data.*-->                [email_sequence]
      --jobs.extracted_data.icp-->              [brand_scrape] (for website fallback)
```

---

## Section 11 — Sign-Off Checklist

- [x] Dependency graph complete
- [x] Every input field named, typed, sourced, null-handled
- [x] Fireflies API tested and validated (isolated in previous session — Notes field confirmed)
- [x] Full Claude prompt written
- [x] Processing logic numbered step-by-step
- [x] Output schema fully defined
- [x] Every failure mode has defined status + rep-visible message
- [x] Timeout set and justified (2 min >> p99 of 25s)
- [x] Idempotency confirmed
- [x] Data flow diagram drawn with named fields

**Signed off:** Lloyd Yip — 2026-04-04 (original) / updated 2026-04-06 (Section 2.5 fields added)
