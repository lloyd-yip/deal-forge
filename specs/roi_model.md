# Task Spec: roi_model

**Pipeline stage:** 2 — parallel with brand_scrape, lead_list, webinar_titles
**Depends on:** `extract` completed (`jobs.extracted_data.business.ltv` populated)
**Blocks:** Nothing (Stage 3 tasks do not depend on roi_model)
**Model:** None — no LLM call. This is a template-fill + math task.
**Status:** FULLY SPECCED

---

## 1. What This Task Does

Generates a pre-populated interactive ROI calculator as a self-contained HTML file, uploaded to Supabase Storage with a public URL.

The rep uses it two ways:
1. **During Call 2 (screen-share):** Opens the URL, walks the prospect through the revenue projections live. Rep adjusts inputs in real-time ("Want to be more conservative on the closing rate?") until they land on numbers the prospect believes.
2. **After Call 2 (shared link):** Rep sends the public URL to the prospect so they can revisit and adjust the numbers themselves.

This is the same tool for both purposes — one URL, one file. The interactivity is handled entirely by JavaScript in the HTML. No server calls after the file is generated.

**No LLM call.** The math is deterministic. Claude already extracted the prospect's LTV (and optionally their close rate and show rate) in the extract task. This task's only job is to inject those values into an HTML template, run the initial calculation, and upload the file.

---

## 2. Inputs

| Field | Source | Required | Default if null |
|-------|--------|----------|-----------------|
| `extracted_data.business.ltv` | jobs.extracted_data | Required | null → `needs_input` status |
| `extracted_data.business.close_rate` | jobs.extracted_data | Optional | 20% |
| `extracted_data.business.show_rate` | jobs.extracted_data | Optional | 70% |

**Extract spec dependency note:** `close_rate` and `show_rate` are not currently in the extract task spec. The extract spec must be updated to include these two optional fields:
- `business.close_rate`: `"string | null"` — verbatim percentage if mentioned (e.g., "20%")
- `business.show_rate`: `"string | null"` — verbatim percentage if mentioned (e.g., "70%")

If not updated, roi_model falls back to defaults. Both approaches work — the inputs are editable live regardless.

**LTV parsing:** `business.ltv` is a string (e.g., `"$10,000"`, `"$10K"`, `"10000"`). The task must parse it to a numeric value before injection. Parsing rules:
- Strip `$`, `,`, spaces
- Convert `K` → × 1000, `M` → × 1,000,000
- If unparseable: mark task `needs_input` with error `"Could not parse LTV from extracted data — please enter manually"`

---

## 3. The ROI Model (Baked Into the HTML Template)

All model parameters below are fixed QS methodology benchmarks. Only LTV, close_rate, and show_rate are prospect-specific inputs.

### Fixed parameters (not editable by rep or prospect)

| Parameter | Phase 1 (Learning) | Phase 2 (Ramped) |
|-----------|-------------------|------------------|
| Prospects per webinar | 7,500 | 50,000 |
| Registration rate | 0.5% | 0.8% |
| Attendance rate | 35% | 50% |
| Booking rate | 8% | 18% |
| Call show rate improvement | +0% | +14% (84% vs 70%) |
| Closing rate improvement | +0% | +4% (24% vs 20%) |

### Revenue calculation

```
Revenue per webinar = Prospects × Reg% × Attendance% × Booking% × Show% × Close% × LTV
```

Phase 1 example at $10K LTV, 70% show, 20% close:
- 7,500 × 0.005 × 0.35 × 0.08 × 0.70 × 0.20 × $10,000 = ~$1,470

Phase 2 example at $10K LTV, 84% show, 24% close:
- 50,000 × 0.008 × 0.50 × 0.18 × 0.84 × 0.24 × $10,000 = ~$72,576

### Timeline (bi-weekly webinars)

- Weeks 1–4: Setup & onboarding (no webinars)
- Weeks 5–12: 4 × Phase 1 webinars (learning phase)
- Weeks 13–20: Ramp (25% → 50% toward Phase 2 scale)
- Week 21+: Fully ramped Phase 2 webinars (bi-weekly)

### Headline outputs

- **Revenue at 6 months** — cumulative from weeks 1–26
- **Revenue at 12 months** — cumulative from weeks 1–52
- **Revenue at 24 months** — cumulative from weeks 1–104
- **ROI** — (Total Revenue − Program Investment) / Program Investment × 100 (calculated only after Program Investment is entered)

---

## 4. HTML Template Design

Self-contained single HTML file. All CSS and JavaScript inline — no external dependencies, no CDN calls. File must render correctly offline.

### Layout (two-panel)

**Left panel — Inputs:**
- Customer LTV (editable, pre-populated from extracted_data)
- Call Show Rate (editable, pre-populated or defaulted to 70%)
- Closing Rate (editable, pre-populated or defaulted to 20%)
- Program Investment (editable, blank by default — intentional sales mechanic)

**Right panel — Outputs:**
- Revenue at 6 months (large, bold)
- Revenue at 12 months (large, bold)
- Revenue at 24 months (large, bold)
- ROI (displays "—" until Program Investment is entered)

**Bottom section (collapsed by default, expandable):**
- Phase comparison table (Phase 1 vs Phase 2 side-by-side)
- Phase 1: registrations, attendees, bookings, showed calls, closed deals, revenue per webinar
- Phase 2: same columns

The collapsed section lets the rep show just the headline numbers first (high impact), then expand to explain the methodology if the prospect asks "how did you get there?"

### Interactivity

- All four input fields are editable
- Any change instantly recalculates all outputs (JavaScript `input` event listener, no debounce needed)
- Revenue figures formatted as `$XXX,XXX` (no decimals)
- ROI formatted as `XXX%`
- Program Investment: if entered, shows ROI; if cleared, ROI returns to "—"

### Visual tone

- Clean, minimal — functional tool, not a marketing page
- Dark numbers on white background
- Phase 2 revenue per webinar clearly labeled ("at full scale")
- No QS branding on the prospect-facing version (this is their numbers, not a pitch deck)

---

## 5. Processing Logic

1. Read `extracted_data.business.ltv`, `extracted_data.business.close_rate`, `extracted_data.business.show_rate` from `jobs.extracted_data`
2. If `ltv` is null: set task `needs_input`, surface to rep dashboard, exit
3. Parse `ltv` string to numeric value (per parsing rules in Section 2)
4. If unparseable: set task `needs_input` with specific error, exit
5. Parse `close_rate` string to decimal (e.g., "20%" → 0.20). If null: default 0.20
6. Parse `show_rate` string to decimal (e.g., "70%" → 0.70). If null: default 0.70
7. Load the HTML template from the worker's template directory
8. Inject parsed values into the template (replace `{{LTV}}`, `{{CLOSE_RATE}}`, `{{SHOW_RATE}}` placeholders)
9. Pre-calculate all outputs (6-month, 12-month, 24-month revenue) server-side and inject into the template as initial state — JavaScript recalculates on any user edit
10. Upload the rendered HTML file to Supabase Storage at path `{job_id}/roi_model.html` (public bucket: `sales-assets`)
11. Retrieve the public URL from Supabase Storage
12. Write URL + input summary to `tasks.output_data`
13. Mark task `completed`

---

## 6. Output Schema

Written to: `tasks.output_data` (JSONB on tasks table)

```json
{
  "url": "https://[supabase-project].supabase.co/storage/v1/object/public/sales-assets/{job_id}/roi_model.html",
  "inputs_used": {
    "ltv": 10000,
    "close_rate": 0.20,
    "show_rate": 0.70,
    "close_rate_source": "extracted | default",
    "show_rate_source": "extracted | default"
  },
  "projections": {
    "revenue_6mo": 255118,
    "revenue_12mo": 1258582,
    "revenue_24mo": 2978806
  }
}
```

`close_rate_source` and `show_rate_source` help the rep know whether these numbers came from the transcript or are defaults. If a rep sees "default" in the dashboard, they know to verify the rates with the prospect before anchoring to them.

---

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| `ltv` null in extracted_data | `needs_input` — rep enters manually via dashboard |
| `ltv` present but unparseable | `needs_input` — rep enters manually |
| `close_rate` null | Default 20%, mark `close_rate_source: "default"` in output |
| `show_rate` null | Default 70%, mark `show_rate_source: "default"` in output |
| Supabase Storage upload fails | Retry once. If still fails: mark task `failed` with `"Storage upload failed — retry"` |
| Template file missing from worker | Hard fail — deployment error, not a runtime error |

---

## 8. Timeout & Recovery

- **p50 execution time:** ~3 seconds (template fill + Supabase Storage upload)
- **p99 execution time:** ~15 seconds (slow Supabase Storage)
- **Task timeout:** 2 minutes (generous — this is a fast task)
- **Retry idempotent?** Yes — re-upload overwrites the same path in Supabase Storage, URL is unchanged

---

## 9. Idempotency

- Same job_id → same storage path (`{job_id}/roi_model.html`) → overwrites on retry
- URL is stable — the rep's link doesn't change if the task is re-run
- Safe to retry without cleanup

---

## 10. Data Flow

```
[jobs.extracted_data.business.ltv]
[jobs.extracted_data.business.close_rate]  → [roi_model task]
[jobs.extracted_data.business.show_rate]         ↓
                                       [HTML template filled]
                                                  ↓
                                     [Supabase Storage upload]
                                                  ↓
                                    [tasks.output_data → public URL]
                                                  ↓
                              [rep dashboard → shareable link asset card]
                                                  ↓
                              [rep screen-shares Call 2] / [sends to prospect]
```

---

## 11. Sign-Off Checklist

- [x] Dependency graph complete — Stage 2 parallel, blocks nothing
- [x] All inputs named, typed, sourced, null-handled with explicit defaults
- [x] Extract spec dependency noted (close_rate + show_rate fields to add)
- [x] LTV parsing rules fully defined (K/M conversion, strip symbols)
- [x] No LLM call — pure template-fill + math
- [x] ROI model math documented (Phase 1 / Phase 2 parameters, formula)
- [x] Timeline documented (4-week setup, learning, ramp, fully ramped)
- [x] HTML template design specified (two-panel layout, collapsed phase table)
- [x] Processing logic numbered step-by-step
- [x] Output schema defined — writes to tasks.output_data with source tracking
- [x] Error handling table complete — needs_input for LTV issues, defaults for rates
- [x] Supabase Storage path defined — stable, idempotent on re-run
- [x] Timeout set (2 min) — justified as fast task
- [x] Idempotency confirmed
- [x] Data flow diagram complete — shows both use cases (Call 2 screen-share + prospect link)

**Status:** FULLY SPECCED
