# Task Spec: brand_scrape

**Pipeline stage:** 2 — parallel with lead_list, webinar_titles, roi_model
**Depends on:** `extract` completed
**Blocks:** `reg_page` (needs brand data for visual styling)
**Model:** None (no Claude call — pure scrape)
**Status:** SIGNED OFF

---

## 1. What This Task Does

Scrapes the prospect's website to extract visual brand assets needed by `reg_page`:
- Logo URL
- Primary and secondary brand colors (hex)
- Tagline / meta description
- Company name (as it appears on-site, for display)

No LLM involved. Pure Apify scrape + deterministic extraction from HTML/CSS.

`calendar_visual` does NOT need this data — it uses only webinar content and host bio.
`reg_page` is the sole consumer of brand_data.

---

## 2. Inputs

| Field | Source | Required | Null handling |
|-------|--------|----------|---------------|
| `job.prospect_website` | jobs table | Optional | null → skip entirely, write all-null output, mark completed |
| `job.prospect_company` | jobs table | Required | Fallback display name if site scrape fails |

If `prospect_website` is null: complete immediately with all-null output. `reg_page` will use generic/neutral styling.

---

## 3. External API Call — Apify Web Scraper

- **Actor:** `apify/web-scraper` (handles JS-rendered sites — Webflow, Squarespace, etc.)
- **Input:** `{ "startUrls": [{ "url": "<prospect_website>" }], "maxCrawlPages": 1 }`
- **Auth:** `APIFY_API_TOKEN` env var
- **What we extract from the response:**
  - Logo: `<img>` tags with `logo` in class/id/src, or Open Graph `og:image`
  - Colors: inline CSS, `<meta name="theme-color">`, or CSS variables on `:root`
  - Tagline: `<meta name="description">`, `og:description`, or first visible `<h1>` / `<h2>` after the logo
  - Company name: `og:site_name`, `<title>` tag (first word group before separator), or `alt` attribute of logo image
- **On 401:** hard fail — invalid Apify key
- **On actor timeout (>90s):** complete with null output, log warning
- **On non-200 or unreachable site:** complete with null output, log warning
- **On empty result:** complete with null output

Color extraction logic (in order of preference):
1. `<meta name="theme-color">` — most reliable if present
2. CSS variable `--primary-color` or `--brand-color` on `:root`
3. Most frequent non-white/non-black hex color in `background-color` styles on header/nav elements
4. Null if none found

---

## 4. Processing Logic

1. Read `job.prospect_website` from jobs table
2. If null: write all-null output to `jobs.brand_data`, mark `completed`, exit
3. Call Apify web scraper with single-page crawl of the prospect website
4. From the scraped HTML:
   - Extract logo URL (absolute URL — resolve relative paths)
   - Extract primary color (hex) using priority order above
   - Extract tagline from meta description or first heading
   - Extract company name from og:site_name or title tag
5. Write output to `jobs.brand_data`
6. Mark task `completed`

Partial results are valid — if logo found but no colors, write what's available. Never fail due to missing individual fields.

---

## 5. Output Schema

Written to: `jobs.brand_data` (new JSONB column on jobs table — migration required)

```json
{
  "logo_url": "string | null — absolute URL to logo image",
  "primary_color": "string | null — hex code e.g. #2D6BE4",
  "secondary_color": "string | null — hex code",
  "tagline": "string | null — meta description or first heading",
  "company_name": "string | null — display name as it appears on site",
  "scraped": "boolean — true if Apify returned usable content"
}
```

If `scraped` is false, `reg_page` falls back to a neutral default theme (white background, dark gray text, no logo).

---

## 6. Error Handling

| Scenario | Behavior |
|----------|----------|
| `prospect_website` null | Complete immediately, all-null output |
| Site unreachable / non-200 | Complete with null output, log warning |
| Apify 401 | Hard fail — invalid key, needs admin fix |
| Apify timeout >90s | Complete with null output, log warning |
| No logo found | `logo_url: null` — not a failure |
| No colors found | `primary_color: null` — reg_page uses defaults |

This task **never fails** due to scrape content issues. Hard fail only on Apify auth error.

---

## 7. Timeout & Recovery

- **p50 execution time:** ~12 seconds (Apify single-page crawl)
- **p99 execution time:** ~45 seconds (slow site + JS rendering)
- **Task timeout:** 2 minutes
- **Retry idempotent?** Yes — overwrites `jobs.brand_data`

---

## 8. Idempotency

- Writes to `jobs.brand_data` on parent job record — overwrite on re-run
- Apify scrapes same URL → same result (deterministic)
- Safe to retry without cleanup

---

## 9. Data Flow

```
[job.prospect_website]
         ↓
[Apify web scraper — single page]
         ↓
  logo_url, primary_color, secondary_color, tagline, company_name
         ↓
  jobs.brand_data
         ↓
     [reg_page] — logo, colors, tagline for visual styling
```

`calendar_visual` does NOT read brand_data.

---

## 10. Migration Required

New column on jobs table:
```sql
ALTER TABLE sales_assets.jobs
ADD COLUMN brand_data JSONB;
```

Along with the previously noted `research_data` column migration, these two run together before Phase 2 deploy.

---

## 11. Sign-Off Checklist

- [x] Dependency graph complete — Stage 2 parallel, blocks reg_page only
- [x] Input fields named, typed, sourced, null-handled
- [x] No LLM call — pure deterministic scrape
- [x] Apify actor specified with single-page crawl config
- [x] Color extraction priority order defined
- [x] Processing logic step-by-step
- [x] Output schema defined — new `jobs.brand_data` column (migration required)
- [x] Task never hard-fails on scrape content issues
- [x] Timeout set (2 min) and justified
- [x] Idempotency confirmed
- [x] Migration SQL included

**Status:** SIGNED OFF
