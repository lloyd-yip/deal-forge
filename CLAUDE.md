# Deal Forge — Claude Code Context

## What This Project Is

Deal Forge is an AI-powered sales asset generation pipeline for Quantum Scaling. After a rep completes Call 1 (Business Audit), they trigger Deal Forge with the Fireflies meeting ID. An 8-task pipeline runs and generates custom prospect-specific assets before Call 2 — increasing show rates and close rates.

## Project State File

All phase tracking, decisions, milestones, and resume points live at:
`project-control/project_state.json`

**Read this file at the start of every session.** It tells you exactly where to pick up.

**Update it when:**
- A phase or status changes
- A milestone is completed (capability-level, not code-level)
- An architectural decision is confirmed
- A known issue is discovered or fixed
- The next steps change

## Architecture Overview

**Pipeline: 8 tasks across 3 stages**

| Stage | Tasks | Trigger |
|-------|-------|---------|
| Stage 1 | `extract` | Job created |
| Stage 2 (parallel) | `brand_scrape`, `lead_list`, `webinar_titles`, `roi_model`, `email_sequence` | extract completes |
| Stage 3 (parallel) | `calendar_visual`, `reg_page` | brand_scrape completes |

**Infrastructure:**
- Railway project ID: `8839ef6c-015c-455e-a75a-8bb8f82c43a2`
- Supabase project: `lcryrllxityssyamcvst` (eu-west-1, schema: `sales_assets`)
- Supabase Storage bucket: `sales-assets` (public)
- GitHub: `lloyd-yip/deal-forge`

**Key design decisions:**
- `extract` writes to `jobs.extracted_data` (not tasks.output_data) — all Stage 2 tasks read from it
- `roi_model` + `reg_page` generate HTML files stored in Supabase Storage with public URLs
- `roi_model` has rep view (progressive disclosure) + prospect view (`?view=prospect`)
- Hard delete on jobs (no soft delete)
- Graceful degradation: brand_scrape failure → unbranded fallback; roi_model failure → rep manually populates

## Current Phase

See `project-control/project_state.json` → `resume_here` for exact re-entry point.

As of last update: `/task-spec` in progress. `extract` fully specced. Working through remaining 7 tasks before UX design begins.

## Rules

- **No UX work until `/task-spec` is complete for all 8 tasks**
- **No task code until its 11-section spec is signed off**
- **Run `/schema-review` before any migration**
- **Run `/api-isolation` before writing any API handler**
- Every session: read `project_state.json` before touching anything
