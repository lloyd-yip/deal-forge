# Task Spec: calendar_visual

**Pipeline stage:** 3 — parallel with reg_page
**Depends on:** `webinar_titles` completed + `prospect_research` completed
**Blocks:** Nothing (final stage)
**Model:** Claude Haiku (reminder email copy only)
**Temperature:** 0.7 (slight creativity for email tone)
**Max tokens:** 600 (2-3 short reminder emails)
**Status:** FULLY SPECCED

---

## 1. What This Task Does

Generates a self-contained interactive HTML file that mimics a Google Calendar event popup — cleaner and more polished than a real Google Calendar invite.

The rep screen-shares this on Call 2 to demonstrate exactly what the webinar funnel looks like from the prospect's attendee perspective. The copy is already generated (webinar title + description from webinar_titles, host bio from prospect_research) — this task injects it into a visual template and adds one new generation: 2-3 reminder email previews.

**The interactive element:** When the prospect clicks "Yes" in the RSVP row, a reminder email sequence slides in — 2-3 email cards showing what automated reminders they'd receive after registering. This makes the funnel tangible: "This is what your registrants experience."

**Two uses (same file):**
1. Rep screen-shares during Call 2
2. Rep can send the URL to the prospect as a follow-up asset

---

## 2. Inputs

| Field | Source | Required | Null handling |
|-------|--------|----------|---------------|
| `webinar_titles.output_data.titles[0]` | tasks.output_data (webinar_titles task) | Required | null → `needs_input` |
| `prospect_research.output_data.bio` | tasks.output_data (prospect_research task) | Required | null → use fallback bio from extracted_data.prospect.name + business.positioning |
| `prospect_research.output_data.name` | tasks.output_data (prospect_research task) | Required | null → use extracted_data.prospect.name |
| `jobs.extracted_data.customer_pain` | jobs.extracted_data | Optional | null → reminder emails omit pain hook |
| `jobs.extracted_data.result_delivered` | jobs.extracted_data | Optional | null → reminder emails omit outcome hook |
| `jobs.extracted_data.prospect.company` | jobs.extracted_data | Optional | null → omit company name from emails |

**Which title variant:** Default to Variant A (`titles[0]`). Rep can request a different variant in Phase 3 via dashboard — not required for Phase 2.

**Dependency resolution:** This task's worker handler must query the tasks table to find the completed webinar_titles and prospect_research task records for this job_id and read their output_data. It does not read from jobs.extracted_data for the webinar copy.

---

## 3. Claude Call — Reminder Email Generation

The only LLM call in this task. Generates 3 short reminder email previews shown after the prospect clicks "Yes."

**Model:** Claude Haiku
**Temperature:** 0.7
**Max tokens:** 600

### System prompt
```
You are writing short reminder email previews for a webinar registration confirmation sequence. Each email is truncated — enough to convey the tone and value, not a full email. Write in first person from the host's perspective.

Return valid JSON only. No markdown, no explanation.
```

### User prompt
```
Generate 3 reminder email previews for this webinar:

Webinar title: {{title}}
Host name: {{host_name}}
What attendees will learn: {{result_delivered}}
Who this is for: {{customer_pain}}

Return this exact JSON:
{
  "emails": [
    {
      "timing": "1 week before",
      "subject": "string — max 10 words",
      "preview": "string — 2-3 sentences max, first-person from host"
    },
    {
      "timing": "24 hours before",
      "subject": "string — max 10 words",
      "preview": "string — 2-3 sentences max, create urgency"
    },
    {
      "timing": "1 hour before",
      "subject": "string — max 10 words",
      "preview": "string — 1-2 sentences max, very punchy"
    }
  ]
}
```

---

## 4. HTML Template Design

Self-contained HTML file. All CSS and JavaScript inline. No external dependencies, no CDN. Renders correctly offline.

### Visual style

- Clean white modal/card, centered on a blurred calendar-style background
- Rounded corners, subtle drop shadow
- Typography: system font stack (San Francisco / Segoe UI / Helvetica)
- Color palette: white card, dark gray text, teal/green accent for the event color chip and action elements
- RSVP buttons: minimal pill style (not the blocky Google default)
- More elegant than a real Google Calendar popup — same structure, better execution

### Calendar event structure (top to bottom)

1. **Color chip + event title** — teal square chip + webinar title (from webinar_titles.titles[0].title)
2. **Date/time** — placeholder calculated at generation time: next Tuesday ~3 weeks from today, 7:00–8:00pm (formatted as "Tuesday, [Month] [Day], [Year] · 7:00 – 8:00pm")
3. **Location row** (pin icon) — placeholder text: "Webinar link will be sent upon registration"
4. **Guests row** (people icon) — "Guest list hidden (large event)" + host name chip
5. **Description row** (lines icon):
   - Bold: webinar title (full, from webinar_titles)
   - Body: webinar description (from webinar_titles.titles[0].description, rendered as-is)
   - Divider line
   - **Notifications section** (static copy):
     > **Notifications:**
     > Pick **Yes** or **Maybe** — to receive reminder emails for this event.
     > **No** — Not interested? You won't hear from us again.
   - Divider line
   - **About the Host:** header + host bio (from prospect_research)
6. **RSVP row** — "Going?" label + **Yes** | **No** | **Maybe** buttons

### "Yes" click interaction

When the prospect clicks "Yes":
1. The RSVP row updates — Yes button highlighted/selected state
2. A reminder sequence panel slides in below the calendar card (CSS transition, ~300ms ease)
3. The panel shows 3 email cards stacked vertically, each with:
   - Timing label (e.g., "1 week before") — small, muted
   - Subject line — bold
   - Preview text — body copy, truncated with "..." if needed
   - A thin envelope icon or subtle left border in the teal accent color
4. Panel header: "Here's what your registrants will receive:"

Clicking "No" or "Maybe" closes the email panel if open. Clicking "Yes" again while panel is open re-opens/keeps it open.

No navigation away from the page. Everything happens inline.

---

## 5. Processing Logic

1. Query tasks table: find `webinar_titles` task for this `job_id` where `status = 'completed'`. Read `output_data.titles[0]`
2. Query tasks table: find `prospect_research` task for this `job_id` where `status = 'completed'`. Read `output_data.bio` and `output_data.name`
3. If either required task is not yet completed: set status `pending`, reschedule check in 30s (do not fail — dependency may still be processing)
4. If either required task is `failed` or `needs_input`: set this task `failed` with `"Required upstream task [name] did not complete"`
5. Read `customer_pain`, `result_delivered`, `prospect.company` from `jobs.extracted_data`
6. Call Claude Haiku to generate 3 reminder email previews
7. If Claude returns invalid JSON: retry once. If still invalid: use fallback static email previews (see Section 7)
8. Calculate placeholder date: next Tuesday 3 weeks from `NOW()`, formatted as full string
9. Load HTML template from worker's `templates/calendar_visual.html`
10. Inject all values into template (title, description, host bio, host name, date, reminder emails)
11. Upload rendered HTML to Supabase Storage at `{job_id}/calendar_visual.html`
12. Retrieve public URL
13. Write URL to `tasks.output_data`
14. Mark task `completed`

---

## 6. Output Schema

Written to: `tasks.output_data` (JSONB on tasks table)

```json
{
  "url": "https://[supabase].supabase.co/storage/v1/object/public/sales-assets/{job_id}/calendar_visual.html",
  "webinar_title": "string — title variant A used",
  "host_name": "string — injected host name",
  "reminder_emails_generated": true,
  "placeholder_date": "Tuesday, May 5, 2026 · 7:00 – 8:00pm"
}
```

---

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| webinar_titles task not yet completed | Reschedule in 30s (pending, not failed) |
| prospect_research task not yet completed | Reschedule in 30s (pending, not failed) |
| Either upstream task failed | This task `failed` — surface upstream task error to rep |
| prospect_research bio null | Fallback: generate bio from `extracted_data.prospect.name + business.positioning` (no Claude call — template text) |
| Claude JSON invalid (2 attempts) | Use static fallback reminder emails (hardcoded generic copy) — task still completes |
| Supabase Storage upload fails | Retry once. If still fails: `failed` with "Storage upload failed" |

**Fallback reminder emails (static, used if Claude fails):**
```
Email 1 — "1 week before": "See you in 7 days! Just a reminder that [webinar title] is coming up next week. Make sure you've blocked the time."
Email 2 — "24 hours before": "Tomorrow's the day! Your spot is confirmed for [webinar title]. We'll see you there."
Email 3 — "1 hour before": "We're starting in 1 hour. Check your email for the join link."
```

---

## 8. Timeout & Recovery

- **p50 execution time:** ~10 seconds (Claude Haiku call + Storage upload)
- **p99 execution time:** ~30 seconds
- **Task timeout:** 3 minutes
- **Retry idempotent?** Yes — re-upload overwrites same path in Supabase Storage, URL is stable

---

## 9. Idempotency

- Same `job_id` → same storage path → overwrites on re-run
- URL is stable — rep's link doesn't change on retry
- Placeholder date recalculates on re-run (minor drift acceptable)
- Safe to retry

---

## 10. Data Flow

```
[webinar_titles.output_data.titles[0]]  ─────────┐
[prospect_research.output_data.bio]     ─────────┤
[prospect_research.output_data.name]    ─────────┤→ [calendar_visual task]
[extracted_data.customer_pain]          ─────────┤         ↓
[extracted_data.result_delivered]       ─────────┘  [Claude Haiku — 3 reminder emails]
                                                              ↓
                                                   [HTML template injection]
                                                              ↓
                                                   [Supabase Storage upload]
                                                              ↓
                                               [tasks.output_data → public URL]
                                                              ↓
                                     [rep dashboard → calendar visual asset card]
                                                              ↓
                              [screen-share Call 2] / [send to prospect as follow-up]
```

---

## 11. Sign-Off Checklist

- [x] Dependency graph complete — Stage 3, depends on webinar_titles + prospect_research
- [x] Pending-not-failed logic for upstream task timing
- [x] All inputs named, typed, sourced, null-handled
- [x] Default variant A documented — override deferred to Phase 3
- [x] Claude call: Haiku, temp 0.7, reminder emails only — prompt written
- [x] Fallback static emails defined — task completes even if Claude fails
- [x] HTML template design specified: layout, visual style, component order
- [x] "Yes" click interaction described: slide-in panel, 3 email cards, 300ms transition
- [x] Placeholder date calculation defined (next Tuesday ~3 weeks out)
- [x] Processing logic numbered step-by-step
- [x] Output schema defined — writes to tasks.output_data
- [x] Error handling table complete
- [x] Timeout set (3 min) — justified
- [x] Idempotency confirmed
- [x] Wireframes deferred to /ux-design phase (Phase 3)

**Status:** FULLY SPECCED
