# Task Spec: prospect_research

**Pipeline stage:** 1 — Enrichment (parallel with `extract`)
**Depends on:** Job record created (reads `job.prospect_linkedin_url`)
**Blocks:** `reg_page`, `calendar_visual` (need host bio)
**Model:** Claude Haiku (bio synthesis only)
**Temperature:** 0
**Max tokens:** 300
**Status:** SIGNED OFF

---

## 1. What This Task Does

Scrapes the prospect's LinkedIn profile to build a host profile: name, title, headshot URL, and a Claude-synthesized 2–3 sentence bio blurb.

This data feeds `reg_page` (host bio section) and `calendar_visual` (host name + headshot).

Website scraping is handled entirely by `brand_scrape` — no overlap here.

This task runs in parallel with `extract`. Neither blocks the other. Stage 2 tasks wait for both Stage 1 tasks.

---

## 2. Inputs

| Field | Source | Required | Null handling |
|-------|--------|----------|---------------|
| `job.prospect_linkedin_url` | jobs table | Optional | null → skip entirely, write all-null output, mark completed |
| `job.prospect_company` | jobs table | Required | Used as fallback label if LinkedIn returns no data |

If `prospect_linkedin_url` is null: task completes immediately with all-null output. No failure.

---

## 3. External API Call — Apify LinkedIn Scraper

- **Actor:** `apify/linkedin-profile-scraper` (same actor used in `lead_list`)
- **Input:** `{ "profileUrls": ["<prospect_linkedin_url>"] }`
- **Auth:** `APIFY_API_TOKEN` env var
- **Fields read from response:** `fullName`, `headline`, `summary`, `profilePicture`, `experiences[0].title`, `experiences[0].company`
- **On 401:** hard fail — invalid Apify key
- **On actor timeout (>60s):** mark task completed with all-null output, log warning
- **On empty/private profile:** mark task completed with all-null output, log warning
- **On 429:** retry once after 30s; if still rate-limited, complete with null output

---

## 4. Claude Call — Bio Synthesis

Called only if LinkedIn returned usable data (`fullName` + at least one of `summary` or `headline`).

Skipped entirely (no API call) if LinkedIn data is missing or profile was private.

### System prompt
```
You are writing a short professional bio for a webinar host. Write in third person. 2–3 sentences maximum. Confident and credible tone — not hype. Focus on their expertise and who they help. Do not mention the webinar.
```

### User prompt
```
Write a short host bio from this LinkedIn data:

Name: {{fullName}}
Headline: {{headline}}
Summary: {{summary}}
Most recent role: {{experiences[0].title}} at {{experiences[0].company}}

Return only the bio text. No labels, no markdown.
```

### Output
Plain text string, 2–3 sentences. Stored in `host.bio`.

---

## 5. Processing Logic

1. Read `job.prospect_linkedin_url` from jobs table
2. If null: write all-null output to `jobs.research_data`, mark task `completed`, exit
3. Call Apify LinkedIn scraper with the URL
4. If result is empty or profile is private: write all-null output, mark `completed`, log warning, exit
5. Extract: `fullName`, `headline`, `summary`, `profilePicture`, `experiences[0]`
6. If name + at least one of summary/headline present: call Claude Haiku to generate bio
7. If LinkedIn data insufficient for bio: set `host.bio = null`
8. Write output to `jobs.research_data`
9. Mark task `completed`

---

## 6. Output Schema

Written to: `jobs.research_data` (new JSONB column on jobs table — migration required before deploy)

```json
{
  "host": {
    "name": "string | null",
    "title": "string | null — LinkedIn headline",
    "bio": "string | null — Claude-synthesized 2-3 sentence blurb",
    "headshot_url": "string | null — LinkedIn profilePicture URL",
    "linkedin_url": "string | null — echoed from job input"
  },
  "scraped": "boolean — true if Apify returned data, false if null/private/skipped"
}
```

---

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| LinkedIn URL null | Complete immediately, all-null output |
| Profile private or not found | Complete with all-null output, log warning |
| Apify 401 | Hard fail — invalid key, needs admin fix |
| Apify actor timeout >60s | Complete with null output, log warning |
| Apify 429 | Retry once after 30s; if still failing, complete with null |
| Claude bio call fails | Set `host.bio = null`, task still completes |

This task **never fails** due to scrape issues. Hard fail only on Apify auth error (requires admin intervention regardless).

---

## 8. Timeout & Recovery

- **p50 execution time:** ~8 seconds (Apify call + Haiku synthesis)
- **p99 execution time:** ~25 seconds (slow Apify response)
- **Task timeout:** 90 seconds
- **Retry idempotent?** Yes — re-running overwrites `jobs.research_data`

---

## 9. Idempotency

- Writes to `jobs.research_data` on the parent job record — overwrite on re-run
- Apify scrapes same public profile → same result
- Claude at temperature 0 → deterministic bio output
- Safe to retry without cleanup

---

## 10. Data Flow

```
[job.prospect_linkedin_url]
         ↓
[Apify LinkedIn scraper]
         ↓
  name, title, headshot, summary
         ↓
[Claude Haiku — bio synthesis]
         ↓
       host.bio
         ↓
  jobs.research_data
    ├── [reg_page]        — host.name, host.title, host.bio, host.headshot_url
    └── [calendar_visual] — host.name, host.headshot_url
```

Website scraping → handled by `brand_scrape`. No overlap.

---

## 11. Sign-Off Checklist

- [x] Dependency graph complete — parallel with extract, blocks reg_page + calendar_visual
- [x] Every input field named, typed, sourced, null-handled
- [x] LinkedIn-only — website scraping removed (owned by brand_scrape)
- [x] External API call specified (Apify)
- [x] Claude prompt written — bio synthesis only, called conditionally
- [x] Processing logic numbered step-by-step
- [x] Output schema defined — new `jobs.research_data` column (migration required)
- [x] Task never hard-fails on scrape issues
- [x] Timeout set (90s) and justified
- [x] Idempotency confirmed
- [x] Data flow diagram drawn

**Status:** SIGNED OFF
