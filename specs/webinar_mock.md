# Task Spec: webinar_mock

**Pipeline stage:** 3 — parallel with calendar_visual
**Depends on:** `brand_scrape` completed + `webinar_titles` completed + `prospect_research` completed
**Blocks:** Nothing (final stage)
**Model:** Claude Haiku (live chat message generation)
**Temperature:** 0.7
**Max tokens:** 800
**Status:** FULLY SPECCED

---

## 1. What This Task Does

Generates a self-contained HTML file that simulates a live webinar interface — the "oh shit" moment on Call 2 where the prospect sees exactly what their branded webinar will look like in production.

**Layout:** Two-panel interface mimicking a real webinar platform (WebinarGeek / Zoom Webinar / GoToWebinar aesthetic):
- **Left panel (80%):** Presentation slides — 2 slides, prospect's brand colors and logo applied, slide-navigable with Previous / Next arrows
- **Right panel (20%):** Live chat — AI-generated attendee messages from people matching the prospect's ICP, asking real questions about the topic, with support team messages closing conversions

**The "live" signals:** LIVE badge, attendee count (realistic fake number, e.g. 847), timestamp-style chat messages — all reinforcing that this is a live event, not a recording. This is deliberate: QS's live webinar retention is 2× pre-recorded. The mock needs to communicate that energy.

**What this replaces:** reg_page (cut from pipeline). The calendar invite IS the registration mechanism ("just click Yes"). A reg page would contradict that frictionless narrative. This asset serves the same brand-application purpose while being far more powerful — it shows the full webinar experience, not just a signup form.

---

## 2. Inputs

| Field | Source | Required | Null handling |
|-------|--------|----------|---------------|
| `brand_scrape.output_data.primary_color` | tasks.output_data | Optional | null → use QS default teal (#0D9488) |
| `brand_scrape.output_data.secondary_color` | tasks.output_data | Optional | null → use dark gray (#1F2937) |
| `brand_scrape.output_data.logo_url` | tasks.output_data | Optional | null → omit logo, use company name text instead |
| `brand_scrape.output_data.company_name` | tasks.output_data | Optional | null → use extracted_data.prospect.company |
| `webinar_titles.output_data.titles[0]` | tasks.output_data | Required | null → `needs_input` |
| `prospect_research.output_data.name` | tasks.output_data | Required | null → use extracted_data.prospect.name |
| `prospect_research.output_data.bio` | tasks.output_data | Optional | null → use extracted_data.business.positioning |
| `prospect_research.output_data.linkedin_photo_url` | tasks.output_data | Optional | null or low-res → omit photo entirely |
| `extracted_data.icp.role` | jobs.extracted_data | Required for chat generation | null → generic ICP attendee names |
| `extracted_data.icp.industry` | jobs.extracted_data | Required for chat generation | null → generic |
| `extracted_data.customer_pain` | jobs.extracted_data | Optional | null → chat messages omit pain hooks |
| `extracted_data.result_delivered` | jobs.extracted_data | Optional | null → chat messages omit outcome hooks |

**LinkedIn photo quality check:** Before injecting the photo, perform a HEAD request to the URL. If the response is not 200 OK, or if width/height metadata indicates under 100×100px, omit the photo. No placeholder shown — just cleaner slide without image.

**Dependency resolution:** Query tasks table for completed brand_scrape, webinar_titles, and prospect_research tasks for this job_id. If any required task is still processing: reschedule in 30s. If any required task failed: this task fails with upstream error surfaced.

---

## 3. Claude Call — Live Chat Generation

Generates realistic attendee chat messages that feel like real people from the prospect's ICP engaging live with the webinar content.

**Model:** Claude Haiku
**Temperature:** 0.7
**Max tokens:** 800

### System prompt
```
You are generating realistic live chat messages for a webinar. These messages should feel authentic — real attendees asking questions, sharing their situations, and responding to content. Include a mix of: questions about the topic, comments about their own struggles, positive reactions, and 2-3 messages where a support team member drives a booking.

Return valid JSON only. No markdown, no explanation.
```

### User prompt
```
Generate 18 live chat messages for this webinar:

Webinar title: {{title}}
Target audience role: {{icp.role}}
Target audience industry: {{icp.industry}}
Core problem they face: {{customer_pain}}
Result they want: {{result_delivered}}

Requirements:
- 14 attendee messages: realistic first names, short messages, mix of questions + reactions + struggles
- 4 support team messages from "Support" or "Team [Host Name]": encourage booking a call, celebrate attendees who booked
- Messages should feel chronologically natural (building engagement over time)
- Attendee questions should reference the webinar topic and feel like someone in {{icp.industry}} would ask them

Return:
{
  "messages": [
    {
      "sender": "string — first name only for attendees, 'Support' for team messages",
      "text": "string — message content, max 15 words",
      "is_team": boolean,
      "timestamp": "string — e.g. '12:14 PM'"
    }
  ]
}
```

### Timestamp generation
Start at a realistic webinar time (e.g., 12:05 PM) and space messages 30-90 seconds apart. Generated server-side before injection.

---

## 4. HTML Template Design

Self-contained HTML. All CSS and JavaScript inline. No external dependencies. Renders correctly offline.

### Overall layout

Full-width interface, dark-themed (webinar platform aesthetic):
- Dark background (#0F1117 or similar near-black)
- Top bar: LIVE badge (red pill, pulsing dot), webinar title (truncated), attendee count
- Left panel (75-80%): slide viewer
- Right panel (20-25%): live chat

### Top bar

```
[● LIVE]  [Webinar Title — truncated]  [👥 847 attending]
```

- LIVE badge: red background, white text, small pulsing red dot (CSS animation)
- Attendee count: randomized between 600–1200 at generation time (realistic for a QS-scale webinar)

### Left panel — Slide viewer

Two slides, navigable with Previous / Next arrow buttons (left/right edges of panel).

**Slide 1 — Hero slide:**
- Background: prospect's primary_color (or gradient from primary to secondary)
- Logo: top-left corner (if available and quality check passes)
- Webinar title: large, centered, white text
- Subtitle: first sentence of webinar description
- Bottom strip: host name + "LIVE Masterclass" label

**Slide 2 — Problem/Promise slide:**
- Background: dark variation of primary_color (darken by 20%)
- Section header: "What You'll Discover" or "Why [ICP's Core Problem] Happens"
- 3 bullet points extracted from webinar description (first 3 sentences/points reformatted)
- Host photo (bottom right corner, circular crop, ~80px) — only if quality check passes
- Host name + title below photo

**Slide navigation:**
- Current slide indicator: "1 / 2" centered below slides
- Arrow buttons: subtle, appear on hover
- Keyboard arrows also work (left/right)

### Right panel — Live chat

- Dark panel (#1A1D27 or similar)
- "Live Chat" header with green online indicator
- Scrollable message list (newest at bottom, auto-scroll on load)
- Messages: sender name (bold, colored differently for team vs attendee), timestamp (small, muted), message text
- Team messages: slightly different background tint to distinguish from attendees
- Input field at bottom (disabled/placeholder only — "Chat is view-only in this preview")

---

## 5. Processing Logic

1. Query tasks table: find completed brand_scrape, webinar_titles, prospect_research for this job_id
2. If any required task (webinar_titles, prospect_research) not completed: reschedule in 30s
3. If brand_scrape not completed: proceed with null brand values (use defaults)
4. If any required task failed: set this task `failed`, surface upstream error
5. Extract all input values from task output_data and jobs.extracted_data
6. Run LinkedIn photo quality check (HEAD request, dimension check if possible)
7. Generate timestamps: start at randomized realistic time (11am–2pm), space 30-90s apart for 18 messages
8. Call Claude Haiku to generate 18 live chat messages
9. If Claude returns invalid JSON: retry once. If still invalid: use static fallback chat (see Section 7)
10. Randomize attendee count between 600–1200
11. Load HTML template from `templates/webinar_mock.html`
12. Inject all values (slides content, colors, logo, host info, chat messages, attendee count, timestamps)
13. Upload to Supabase Storage at `{job_id}/webinar_mock.html`
14. Retrieve public URL
15. Write to `tasks.output_data`
16. Mark `completed`

---

## 6. Output Schema

Written to: `tasks.output_data` (JSONB on tasks table)

```json
{
  "url": "https://[supabase].supabase.co/storage/v1/object/public/sales-assets/{job_id}/webinar_mock.html",
  "webinar_title": "string — title used",
  "host_name": "string",
  "brand_applied": true,
  "photo_injected": true,
  "attendee_count": 847,
  "chat_messages_generated": 18
}
```

---

## 7. Error Handling

| Scenario | Behavior |
|----------|----------|
| webinar_titles or prospect_research not completed | Reschedule 30s (not failed) |
| brand_scrape not completed | Proceed with defaults (no failure) |
| Either required upstream task failed | This task `failed`, surface upstream error |
| LinkedIn photo fails quality check | Omit photo, continue |
| Claude JSON invalid (2 attempts) | Use static fallback chat messages |
| Supabase Storage upload fails | Retry once. If fails: `failed` |

**Static fallback chat (18 messages, used if Claude fails):**
Generic ICP-adjacent questions and support responses that make the demo functional without personalization. Hardcoded in the template as default content, overwritten when Claude succeeds.

---

## 8. Timeout & Recovery

- **p50 execution time:** ~12 seconds (photo check + Claude call + Storage upload)
- **p99 execution time:** ~35 seconds
- **Task timeout:** 3 minutes
- **Retry idempotent?** Yes — re-upload overwrites same Storage path, URL stable. Attendee count may change slightly on retry (re-randomized) — acceptable.

---

## 9. Idempotency

- Same job_id → same storage path → overwrite on retry
- URL stable across retries
- Chat messages may differ slightly (temp 0.7) — acceptable, both outputs are valid
- Safe to retry

---

## 10. Data Flow

```
[brand_scrape.output_data]            ─────────┐
  (colors, logo, company_name)                  │
[webinar_titles.output_data.titles[0]]─────────┤
  (title, description)                          │
[prospect_research.output_data]       ─────────┤→ [webinar_mock task]
  (name, bio, linkedin_photo_url)               │         ↓
[extracted_data.icp]                  ─────────┤  [LinkedIn photo quality check]
[extracted_data.customer_pain]        ─────────┤         ↓
[extracted_data.result_delivered]     ─────────┘  [Claude Haiku — 18 chat messages]
                                                           ↓
                                              [HTML template injection]
                                                           ↓
                                             [Supabase Storage upload]
                                                           ↓
                                         [tasks.output_data → public URL]
                                                           ↓
                                   [rep dashboard → webinar mock asset card]
                                                           ↓
                                         [screen-share Call 2 — "wow" moment]
```

---

## 11. Sign-Off Checklist

- [x] Replaces reg_page — decision documented (calendar invite IS the reg mechanism)
- [x] Dependency graph complete — Stage 3, parallel with calendar_visual
- [x] Pending-not-failed logic for upstream task timing
- [x] All inputs named, typed, sourced, null-handled (brand defaults defined)
- [x] LinkedIn photo quality check defined (HEAD request + dimension check, omit on failure)
- [x] Claude call: Haiku, temp 0.7, 18 chat messages, prompt written
- [x] Chat message split: 14 attendee + 4 team/support
- [x] Static fallback chat defined — task always completes
- [x] HTML template design specified: dark webinar platform aesthetic, 2-panel layout
- [x] Slide 1 (hero) and Slide 2 (problem/promise) content defined
- [x] Slide navigation: arrow buttons + keyboard, "1/2" indicator
- [x] LIVE badge, pulsing dot, attendee count (600-1200 randomized)
- [x] Chat panel: team messages distinguished, auto-scroll, view-only input
- [x] Timestamp generation: server-side, 30-90s spacing
- [x] Processing logic numbered step-by-step
- [x] Output schema complete
- [x] Error handling table complete
- [x] Timeout set (3 min) — justified
- [x] Idempotency confirmed
- [x] Wireframes deferred to /ux-design phase

**Status:** FULLY SPECCED
