# Deal Forge

**AI-powered sales asset generation pipeline for Quantum Scaling**

Deal Forge solves a specific problem: Quantum Scaling's Call 2 show rate is 37.5%. Prospects feel informed after Call 1 and have no strong reason to return. Deal Forge bridges the gap by generating 8 highly personalized assets for each prospect — making Call 2 feel like a reveal of something already built specifically for them.

## What It Does

After a rep completes Call 1 (Business Audit), they open Deal Forge, select the meeting from their auto-loaded Fireflies calls, and click **Generate**. Within ~20 minutes, 8 custom assets are ready:

| Asset | What it is |
|-------|-----------|
| **Lead List** | 25 ICP-verified prospects scraped, enriched, and filtered by website content analysis |
| **Webinar Titles** | 3 custom webinar title options tailored to their industry and pain points |
| **ROI Calculator** | Interactive HTML calculator pre-populated with their deal size — shareable with prospect |
| **Email Sequence** | Follow-up sequence written for their specific situation |
| **Calendar Invite Visual** | Branded Google Calendar invite mock for their webinar |
| **Registration Page Mock** | Branded registration page showing what their webinar landing page will look like |

## Architecture

8-task pipeline across 3 stages:

```
[Job Created]
     │
     ▼
[Stage 1] extract ─────────────────────────────────────────────────────┐
     │                                                                   │
     ▼                                                                   ▼
[Stage 2] brand_scrape ─┐     lead_list     webinar_titles    jobs.extracted_data
           (parallel)    │     (parallel)    (parallel)
                         │     roi_model     email_sequence
                         │     (parallel)    (parallel)
                         ▼
[Stage 3] calendar_visual  reg_page
           (parallel)      (parallel)
```

**Stack:**
- **Worker:** Node.js on Railway
- **Database:** Supabase (`sales_assets` schema, `jobs` + `tasks` tables)
- **Storage:** Supabase Storage (`sales-assets` bucket) for ROI model + reg page HTML
- **AI:** Claude Haiku (extraction, classification) + Claude Sonnet (email copy)
- **Data:** Fireflies (transcripts), Ample Leads (lead generation), Apify (web scraping)

## Status

See `project-control/project_state.json` for current phase, known issues, and exact resume point.

Current phase: **Backend Architecture** — task specification in progress.

## Infrastructure

| Service | Details |
|---------|---------|
| Railway | Project ID: `8839ef6c-015c-455e-a75a-8bb8f82c43a2` |
| Supabase | Project: `lcryrllxityssyamcvst` (eu-west-1) |
| GitHub | `lloyd-yip/deal-forge` |
