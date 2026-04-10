# Task Spec: webinar_titles

**Pipeline stage:** 2 — Copy Generation
**Depends on:** `extract` (completed, `jobs.extracted_data` populated)
**Model:** Claude Sonnet (claude-sonnet-4-5 or latest Sonnet)
**Temperature:** 0.7
**Max tokens:** 2000
**Status:** SIGNED OFF

---

## 1. What This Task Does

Generates 3 variants of a webinar calendar blocker (title + description) for the prospect's specific webinar offer. Each variant uses a different direct-response copywriting style (Curiosity, Outcome, Mechanism). The output is what Quantum Scaling reps hand off to the prospect as ready-to-use calendar invite copy for their webinar promotion.

This is a persona-swapped port of the CompeteIQ calendar_event generation engine. In CompeteIQ, QS writes for itself. Here, QS writes for the prospect's business, targeting the prospect's ICP.

---

## 2. Inputs

All inputs come from `jobs.extracted_data` (populated by the `extract` task).

### 2.1 Required Fields (null → `needs_input` status)

| Field | Source | Purpose |
|-------|--------|---------|
| `icp.industry` | extracted_data | Who the webinar targets |
| `icp.role` | extracted_data | Job title / decision-maker type |
| `icp.company_size` | extracted_data | Sizing qualifier in copy |
| `customer_pain` | extracted_data | Core pain the webinar addresses |
| `result_delivered` | extracted_data | Outcome the prospect delivers to clients |

### 2.2 Optional Fields (improve quality, not required)

| Field | Source | Fallback if null |
|-------|--------|-----------------|
| `icp.geography` | extracted_data | Omit geographic qualifier from copy |
| `case_study.client_description` | extracted_data | Use segment-agnostic framing |
| `case_study.result` | extracted_data | Skip social proof section |
| `case_study.numbers` | extracted_data | Skip specific proof numbers |
| `webinar_angle` | extracted_data | Use mechanism-based angle from extracted topic |
| `prospect_company_name` | jobs table | Use "your firm" as fallback |
| `prospect_first_name` | jobs table | Skip personalized greeting |

### 2.3 Format Rules (runtime-loaded)

Format rules are NOT hardcoded in this spec or in the prompt file. They are loaded at task execution time from:

- **Source:** CompeteIQ Supabase (`format_brains` table)
- **Query:** `WHERE format_key = 'calendar_event' AND is_active = true`
- **Fields used:** `brain_content` (9-part description structure, injected into system prompt), `example_outputs` (up to 3 few-shot examples)
- **Connection:** `COMPETEIQ_DB_URL` env var in Deal Forge
- **Fallback:** If CompeteIQ DB is unreachable, use embedded fallback rules from `prompts/webinar_titles_fallback_format.txt` — task proceeds with degraded (non-personalized format) rather than failing

---

## 3. Null / Missing Field Handling

If any required field from Section 2.1 is null after `extract` completes:

1. Set `tasks.status = 'needs_input'` (new enum value — see Section 9)
2. Set `tasks.error_message` to list which fields are missing (e.g., `"Missing: icp.industry, customer_pain"`)
3. Do NOT mark the task failed
4. Dashboard displays an input form for the rep to manually enter the missing values
5. When rep submits the form, system writes values back to `jobs.extracted_data`, sets task status back to `pending`, and re-queues for execution

Optional fields that are null are silently skipped — no `needs_input` trigger, no UI form.

---

## 4. Prompt Architecture

### 4.1 System Prompt Structure (mirrors CompeteIQ generation.py `_build_system_prompt`)

```
You are a direct-response copywriter working on behalf of Quantum Scaling (QS),
a B2B growth agency. You are writing calendar blocker copy for [prospect_company_name]'s
webinar — targeting [icp.role]s in the [icp.industry] industry.

Your job is to write LinkedIn/Google calendar invites that get [icp.role]s to click
YES or MAYBE to attend [prospect_company_name]'s webinar.

## Prospect's Business Context
- Company: [prospect_company_name]
- Their clients are: [icp.role]s at [icp.company_size] companies in [icp.industry]
- Core pain they solve: [customer_pain]
- Result they deliver: [result_delivered]
- Case study (use verbatim numbers only): [case_study.numbers] — [case_study.result]
- Webinar angle: [webinar_angle]

## Format Rules
[format_brains.brain_content — loaded from CompeteIQ Supabase at runtime]

## Copywriting Principles
[copywriting_principles — loaded from CompeteIQ Supabase at runtime, all active principles]

## Real Examples (study these — match this voice and structure exactly)
[format_brains.example_outputs — up to 3 few-shot examples]

## Output Format
Respond with valid JSON only. No markdown, no explanation, no preamble.

{
  "variants": [
    {
      "variant": "A",
      "style": "Curiosity-first (Revealed style)",
      "title": "...",
      "description": "..."
    },
    {
      "variant": "B",
      "style": "Outcome-first (Hormozi style)",
      "title": "...",
      "description": "..."
    },
    {
      "variant": "C",
      "style": "Mechanism-first (Kennedy style)",
      "title": "...",
      "description": "..."
    }
  ]
}

Rules:
- Generate exactly 3 variants (A, B, C)
- Titles: max 60 characters. Front-load the most critical signal (ICP role or outcome)
  in the first 40 characters — the title must make sense if truncated at 40 chars.
- Descriptions: max 300 words. Follow the 9-part structure from Format Rules above.
- All proof numbers must be verbatim from the brief — never fabricate
- Each title must pass the gut check: a [icp.role] reads it and thinks "oh shit, that's for me"
```

### 4.2 User Prompt

```
Generate calendar blocker copy for this prospect's webinar:
- Prospect company: [prospect_company_name]
- Target segment: [icp.role]s at [icp.company_size] [icp.industry] companies
[if geography] - Geography: [icp.geography]
- Pain they solve: [customer_pain]
- Result they deliver: [result_delivered]
[if case_study] - Client proof: [case_study.client_description] achieved [case_study.result] ([case_study.numbers])
[if webinar_angle] - Webinar angle: [webinar_angle]
[if no case_study] - No specific case study provided — use best-fit framing from examples or segment-agnostic language
```

### 4.3 Prompt File Location

System prompt template: `deal-forge/prompts/webinar_titles_system.txt`
User prompt template: `deal-forge/prompts/webinar_titles_user.txt`
Fallback format rules: `deal-forge/prompts/webinar_titles_fallback_format.txt`

Prompts are plain text templates with `[bracket]` placeholders. They are NOT hardcoded in application code — loaded at runtime and interpolated before sending to Claude.

---

## 5. Output Schema

Stored in `tasks.output_data` (JSONB column on `tasks` table).

```json
{
  "variants": [
    {
      "variant": "A",
      "style": "Curiosity-first (Revealed style)",
      "title": "string — max 60 chars, first 40 must make sense if truncated",
      "hook": "string — 2 sentences, opens with client pain, written as prospect company hosting",
      "bullets": ["string — transformation promise", "string", "string"],
      "for_line": "string — who should attend, 1 sentence"
    },
    {
      "variant": "B",
      "style": "Outcome-first (Hormozi style)",
      "title": "string — max 60 chars, leads with the result",
      "hook": "string — 2 sentences, opens with outcome or promise",
      "bullets": ["string", "string", "string"],
      "for_line": "string"
    },
    {
      "variant": "C",
      "style": "Mechanism-first (Kennedy style)",
      "title": "string — max 60 chars, leads with the system or mechanism",
      "hook": "string — 2 sentences, opens with how the mechanism works",
      "bullets": ["string", "string", "string"],
      "for_line": "string"
    }
  ],
  "generated_at": "ISO timestamp",
  "model": "claude-sonnet-4-6",
  "format_brain_version": "integer — snapshot of format brain version used"
}
```

---

## 6. Output Validation (Post-Generation)

Run these checks before marking task `completed`. If any check fails, retry once with a stricter prompt addendum. If second attempt fails, mark task `failed` with error detail.

| Check | Rule | Retry Prompt Addendum |
|-------|------|-----------------------|
| Variant count | Exactly 3 variants present | "You must return exactly 3 variants." |
| Title length | Each title ≤ 60 characters | "All titles must be 60 characters or fewer." |
| Title front-load | First 40 chars make sense in isolation | Log warning only (no retry — hard to validate programmatically) |
| Description word count | Each description ≤ 300 words | "Each description must be 300 words or fewer." |
| No fabricated numbers | If case_study was null, no numeric proof claims | Log warning for human review |
| Valid JSON | `json.loads()` succeeds | Retry with "Output must be valid JSON only, no markdown." |

---

## 7. State Machine Transitions

```
pending
  ↓ (extract completed, check required fields)
  ├─ required fields present → processing
  └─ required fields missing → needs_input
       ↓ (rep submits missing fields via dashboard)
     pending → processing
       ↓
  ├─ generation + validation succeeds → completed
  └─ generation fails after retry → failed
```

---

## 8. Error Handling

| Scenario | Behavior |
|----------|----------|
| Required ICP/pain fields null | `needs_input` status, no Claude call made |
| CompeteIQ DB unreachable | Log warning, fall back to `webinar_titles_fallback_format.txt`, continue |
| Claude API timeout | Retry once after 5s; if second timeout → `failed` |
| Claude returns invalid JSON | Retry once with JSON-only instruction; if still invalid → `failed` |
| Word count > 220 | Retry once with explicit word limit; if still over → truncate + log warning |
| No format brain found | Use fallback format rules, log warning |

---

## 9. Schema Change Required: `needs_input` Status

The `tasks.status` enum needs a new value. Current enum (assumed):
```sql
CHECK (status IN ('pending', 'processing', 'completed', 'failed'))
```

Required migration:
```sql
ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
ALTER TABLE tasks ADD CONSTRAINT tasks_status_check
  CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'needs_input'));
```

This migration must run before the `webinar_titles` task handler is deployed. All other tasks that do NOT need this status are unaffected — they never set it.

The `needs_input` status also applies to any future copy generation task that depends on fields a rep must supply manually (e.g., `email_sequence`, `calendar_visual`).

---

## 10. Idempotency

- Task ID is the unique key. Re-running a completed task overwrites `tasks.output_data` (upsert, not duplicate)
- Re-running a `needs_input` task after fields are populated works normally — treated as fresh `pending`
- `format_brain_version` is captured in output to enable re-generation if format rules change

---

## 11. Cost Estimate

| Item | Estimate |
|------|----------|
| Input tokens per call | ~800 (system prompt ~600, user prompt ~200) |
| Output tokens per call | ~600 (3 variants × title + 220-word description) |
| Cost per job (Sonnet) | ~$0.011 ($0.0024 input + $0.009 output) |
| Cost per 100 jobs | ~$1.10 |

Cost is negligible at this volume. No pre-flight cost gate needed.

---

## 12. What's Not in v1

- Streaming SSE (generate and show in real-time) — added in Phase 2 when dashboard is built
- Per-rep brand voice customization — same format brain for all reps in v1
- Regeneration button per variant — Phase 2 dashboard feature
- Scoring / evaluation of variants — Phase 3
- Automatic re-generation when format brain is updated — Phase 3
