# Task Spec: lead_list

**Pipeline stage:** 2 — parallel with `brand_scrape`, `webinar_titles`, `roi_model`
**Depends on:** `extract` completed (`jobs.extracted_data` populated)
**Blocks:** Nothing downstream
**Primary goal:** turn a Fireflies-derived brief into a commercially credible top-25 lead list
**Reality standard:** a human rep should look at the first page and say “yes, these are the kinds of people and companies this prospect should target”
**Status:** RE-SPECIFIED — replaces the old “single Apollo search + cleanup” design

---

## 1. Product Standard

The lead list is not successful because Apollo returned records.

It is successful only if:
- the final 25 clearly match the prospect’s actual buyer
- the list feels commercially useful, not merely title-compatible
- the system can explain why each lead is present
- the system tells the truth when the market is broad, sparse, or ambiguous

For Deal Forge, “amazing” means:
- good retrieval for straightforward ICPs
- sensible retrieval for nuanced ICPs
- graceful degradation when data is sparse
- no fake precision

The system must optimize for **relevance first, volume second**.

---

## 2. Hard Constraint

We do **not** get unlimited discovery context.

The lead system may use only:
- the Fireflies-derived brief already produced by `extract`
- the prospect’s own website
- candidate company / person data available from Apollo
- lightweight candidate-site verification/enrichment

We do **not** assume:
- extra manual rep input
- hidden CRM history
- richer sales notes
- custom human-written ICP logic per prospect

This means the system must get much better at **translating** the existing brief, not just asking for more information.

---

## 3. Root Problem This Spec Solves

The current design fails on nuanced ICPs because it flattens a rich brief into blunt Apollo filters, then asks the classifier to rescue quality afterward.

That creates three predictable failure modes:

1. **Bad retrieval**
- broad geos
- broad sectors
- title-only matching
- shallow Apollo sampling

2. **Bad interpretation**
- the prospect’s buyer nuance is not encoded strongly enough
- negative constraints are mostly absent
- “PE/VC-backed”, “operator”, “founder-led”, “not giant public tech” are treated as soft vibes instead of real fit signals

3. **Bad ranking**
- candidates are filtered late rather than scored well
- the system chooses “acceptable” records instead of the best 25

The result is what we saw on Peter:
- Apollo can find lots of CEOs
- the system still returns the wrong CEOs

---

## 4. What The New System Must Do

The lead system must become a deterministic pipeline with five clear responsibilities:

1. Normalize the Fireflies brief into a lead-generation-ready representation
2. Enrich that representation using the prospect’s website
3. Decompose the ICP into multiple Apollo search slices
4. Retrieve and verify candidates across those slices
5. Score, rank, diversify, and explain the final 25

The crucial change is:

**The brief should not directly become one Apollo query.**

It must first become a **query plan**.

---

## 5. Inputs

### 5a. Required source record

`jobs.extracted_data`

Use the full extracted object, not a partial ICP subset.

Relevant current fields already available:
- `prospect.company`
- `prospect.contact_name`
- `prospect.contact_title`
- `icp.role`
- `icp.apollo_titles`
- `icp.apollo_industries`
- `icp.industry`
- `icp.company_size`
- `icp.apollo_employee_ranges`
- `icp.geography`
- `icp.apollo_geography`
- `icp.person_seniorities`
- `icp.company_revenue`
- `icp.kpis`
- `angle.pain`
- `angle.result`
- `angle.methodology`
- `angle.proof`
- `context.goals`
- `context.why_webinar`
- `situation.current_lead_gen`
- `situation.biggest_challenge`
- `verbatim.*`

### 5b. Required enrichment source

Prospect website content, fetched at lead-list runtime if needed.

Recommended source order:
1. Jina Reader on homepage
2. Jina Reader on `/about`, `/services`, `/solutions`, `/case-studies`, `/industries` when available
3. Firecrawl fallback only if Jina is too thin or missing core pages

Goal:
- not to rewrite the brief
- to validate what kind of buyer/company the prospect actually serves

### 5c. Candidate sources

Apollo candidate data:
- org search
- people search
- direct people search fallback
- contacts search only as a last resort

Candidate website verification:
- Jina or similar render-aware text extraction

---

## 6. Derived Internal Schema

The lead system should derive a normalized `lead_profile` object from the Fireflies brief plus prospect website.

This is **not** new source data. It is a structured translation layer.

### 6a. `lead_profile.hard_constraints`

Hard constraints are conditions that should usually reject a candidate if violated.

Fields:
- `target_geographies`
- `target_titles`
- `target_seniorities`
- `target_employee_ranges`
- `must_be_b2b`
- `must_be_operator` (when applicable)
- `must_not_be_obviously_wrong_class`

Examples of wrong class:
- student
- freelancer
- recruiter
- creator
- government body
- university
- giant public institution

### 6b. `lead_profile.strong_preferences`

These are central to fit, but often cannot be expressed as a single Apollo filter.

Fields:
- `company_profile`
- `ownership_profile`
- `buyer_environment`
- `business_model_signals`
- `growth_stage_signals`

Examples:
- PE/VC-backed
- founder-led
- mid-market operator
- complex B2B sale
- multi-stakeholder buying context

### 6c. `lead_profile.soft_signals`

Signals that help rank and explain, but should not hard-reject alone.

Fields:
- `pain_language`
- `goal_language`
- `service_keywords`
- `case_study_signals`
- `transformation_signals`
- `proof_signals`

### 6d. `lead_profile.negatives`

This is a major missing piece today.

The system must derive likely exclusions, even if they are not phrased as explicit “do not target” statements.

Fields:
- `excluded_company_classes`
- `excluded_market_signals`
- `excluded_role_variants`
- `excluded_size_extremes`

Examples:
- giant public tech companies
- agencies
- universities
- municipalities
- solo operators
- obviously consumer-facing businesses

### 6e. `lead_profile.search_hypotheses`

This is the bridge between brief and query planner.

Each hypothesis is a concrete belief like:
- “investor-backed operator in UK/US”
- “founder-led consulting firm”
- “mid-market software CEO under growth pressure”

These are not the final search slices yet. They are the planning inputs.

---

## 7. Prospect Website Enrichment

This is one of the biggest missing pieces in the current design.

The prospect website should be used to derive a **fit signature**.

### 7a. Pages to fetch

Attempt in this order:
1. homepage
2. about
3. services / solutions
4. industries / who-we-serve
5. case studies / clients / results

Stop once enough signal is gathered.

### 7b. What to extract

Extract concise structured signals:
- who they say they serve
- how they describe those buyers
- what transformations they promise
- business model clues
- company stage clues
- investor/board/shareholder language
- named industries
- named client types
- exclusions implied by the copy

### 7c. Output

Persist as something like:

```json
{
  "buyer_phrases": [],
  "company_phrases": [],
  "offer_type": null,
  "case_study_industries": [],
  "business_model_signals": [],
  "growth_signals": [],
  "ownership_signals": [],
  "negative_signals": [],
  "evidence_quotes": []
}
```

This should feed the query planner and ranking logic.

---

## 8. Query Planner

This is the single most important missing system today.

The planner converts `lead_profile` into **3–6 search slices**.

### 8a. Why slices are required

A sharp human does not run one broad Apollo search for a nuanced ICP.
They run several narrower searches, then merge and judge results.

Deal Forge must do the same.

### 8b. Search slice schema

Each slice should include:

```json
{
  "label": "investor-backed software operators",
  "priority": 1,
  "titles": [],
  "seniorities": [],
  "industries": [],
  "employee_ranges": [],
  "org_locations": [],
  "person_locations": [],
  "keywords_include": [],
  "keywords_exclude": [],
  "company_profile_hint": null,
  "reason": "why this slice exists"
}
```

### 8c. Planner rules

1. Generate multiple slices when the ICP spans multiple buyer shapes
2. Keep slices narrow enough to retrieve relevant candidates
3. Avoid forcing every nuance into Apollo filters
4. Encode what Apollo cannot express as downstream scoring hints
5. Include at least one “conservative/high precision” slice
6. Include at least one “broad recall” slice for sparse markets

### 8d. Example behavior

For a Peter-like ICP, valid slices might look like:
- founder/CEO at consulting or advisory firms
- investor-backed B2B software operators
- mid-market operating leaders in growth-stage firms
- companies with leadership/growth/shareholder pressure signals

The exact slices are data-dependent, but the planner must produce them explicitly.

---

## 9. Retrieval

Retrieval should happen per slice, not just once globally.

### 9a. Apollo retrieval ladder

For each slice:
1. org search using geo + size + industry
2. people search over validated org IDs
3. direct people search with org/person geo when org search is thin
4. relaxed-title / seniority-first fallback
5. CRM contacts search only as the final fallback

### 9b. Market-aware behavior

Different markets need different retrieval behavior.

- US / UK large markets:
  - tighter slices
  - deeper pagination
  - stronger precision bias

- EU / Baltics / sparse geos:
  - faster region expansion
  - earlier direct people search fallback
  - more tolerance for low-volume slices

### 9c. Retrieval volume target

The goal is not “get 25 and stop.”

The goal is to produce a candidate pool large enough for ranking quality.

Recommended candidate target before scoring:
- 80–200 deduped candidates total across all slices

### 9d. Per-candidate source attribution

Every candidate must carry:
- source slice label
- source endpoint
- why they were retrieved

This is required for diagnostics and later quality tuning.

---

## 10. Candidate Verification

The current system relies too much on Apollo surface fields.

We need a stronger verification step before ranking.

### 10a. Verification inputs

For each candidate, collect:
- Apollo person title
- Apollo org name
- Apollo org domain
- Apollo org employee estimate
- LinkedIn headline if present
- candidate company website excerpt

### 10b. Deterministic filters

Reject before model scoring when clearly wrong:
- no usable company website
- parked/thin site
- obvious geography mismatch
- obvious wrong company class
- title/seniority mismatch
- duplicate company-person pair

### 10c. Structured fit scoring

Replace pure pass/fail classification with a scorecard.

Each candidate should get subscores for:
- `role_fit`
- `company_type_fit`
- `size_fit`
- `geo_fit`
- `ownership_fit`
- `offer_buyability_fit`
- `negative_risk`
- `evidence_strength`

Suggested score range:
- 0–100 total

### 10d. Evidence-first judgment

The scorer must cite why a lead passed:
- title evidence
- website/company evidence
- buyer-context evidence

If the model cannot point to evidence, the score should stay low.

---

## 11. Ranking And Final 25

The final output should come from ranking, not just “match=true.”

### 11a. Ranking objectives

Choose leads that are:
- high fit
- commercially plausible buyers
- evidence-backed
- reasonably diverse

### 11b. Diversity rules

Avoid a list dominated by:
- one company
- one narrow title variant
- one slice only

Recommended constraints:
- max 2 people from the same company
- preserve multiple good slices in the final set

### 11c. Final output shape

Every lead should include:
- name
- title
- company
- size
- website
- linkedin
- overall match score
- top 1–2 reasons it matches
- source slice

Optional but useful:
- evidence badges like `Investor-backed`, `Founder-led`, `Growth-stage`, `Consulting`, `Mid-market`

---

## 12. Diagnostics

The system must expose where quality was won or lost.

### 12a. Required diagnostics

- normalized lead profile
- search slices generated
- candidates per slice
- survivors after deterministic verification
- candidates scored
- score distribution
- final leads selected
- rejection reasons summary

### 12b. Distinguish these cases clearly

1. `No market found`
- Apollo retrieval failed or returned near-zero

2. `Market exists, but fit was weak`
- plenty of candidates retrieved
- low scores after verification

3. `System too broad`
- many candidates but wrong kinds of companies

4. `Brief ambiguity`
- source brief could plausibly describe multiple markets

The UI should never collapse these into one generic “no leads found.”

---

## 13. Eval Strategy

This system cannot be trusted without regression fixtures.

### 13a. Golden cases

Start with a small fixed set:
- Peter Ryding
- PlanPro
- Purpose Brand
- one simple US B2B ICP
- one sparse-market EU ICP

### 13b. What to save per case

- extracted brief
- prospect-site fit signature
- generated search slices
- candidate pool sample
- final top 25
- human pass/fail notes

### 13c. Success metrics

Track:
- `retrieval_precision_at_25`
- `human_accept_rate`
- `obvious_mismatch_rate`
- `same-company_duplication_rate`
- `zero-lead_false_negative_rate`

The key metric is not “Apollo returned records.”
It is “would a human rep confidently show this list to the prospect?”

---

## 14. Implementation Gaps Versus Current Code

Today’s code already has some useful pieces:
- broad Apollo retrieval
- Jina-based website verification
- lead diagnostics
- classifier using more of the brief than before

But it is still missing the core architecture.

### 14a. Missing now

1. **No explicit normalized lead profile**
- we still treat the extracted brief too directly

2. **No prospect-site fit signature**
- website scraping exists, but not as a deliberate ICP-shaping stage

3. **No query planner**
- this is the biggest gap

4. **No multi-slice merge-and-rank design**
- retrieval is still essentially one broad path

5. **No structured scoring model**
- we still lean too much on boolean-ish classification

6. **Weak negatives**
- the system does not know strongly enough what to avoid

7. **No gold eval harness**
- we are still learning from live failures

### 14b. Consequence

This is why a human using the same brief in Apollo can outperform the app:
- the human creates slices
- the human notices wrong-company-class mismatches
- the human ranks nuance better

The system currently does not.

---

## 15. Build Order

Implement in this order:

1. **Lead profile normalization**
- derive hard constraints, preferences, negatives, and search hypotheses from the existing brief

2. **Prospect-site fit signature**
- Jina-first enrichment over homepage/about/services/case-study pages

3. **Query planner**
- generate 3–6 search slices

4. **Slice-based Apollo retrieval**
- retrieve per slice and dedupe centrally

5. **Structured candidate scoring**
- replace pure binary classifier output with subscore + evidence

6. **Ranking and diversity selection**
- choose the best 25, not just any passing 25

7. **Eval harness**
- freeze golden cases and measure drift

---

## 16. Definition Of Done

This task is done when:
- nuanced ICPs no longer collapse into broad CEO spam
- the system can explain why each lead matches
- the final 25 feel visibly tighter than raw Apollo
- Peter-like cases stop requiring ad hoc hand-tuning
- diagnostics clearly identify whether a failure is in retrieval, verification, or ranking

If those are not true, the task is not done even if Apollo returns leads.
