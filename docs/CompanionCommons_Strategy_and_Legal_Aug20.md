# CompanionCommons — Strategy & Legal Discussion
**Date:** August 20, 2026
**Purpose:** This document captures a significant strategic re-grounding conversation that happened mid-build-session on Aug 20 — prompted by John wanting to confirm the product was still tracking the original business vision after a day that had been almost entirely bug fixes and site polish. It resulted in real, load-bearing decisions on business positioning, data governance, and beta structure, plus a full set of prepared questions for the eventual lawyer review. This is meant to be referenced directly in future sessions, not re-derived.

---

## 1. Why This Conversation Happened

After a full day of bug fixes, security fixes, and visual polish, John asked directly whether the project was still aligned with the original vision — a real, healthy check to run periodically, not a sign anything had gone wrong. The honest answer at the time: the original plan's two stated Priority 1 items (business model / data licensing framework, and validating real user retention) had sat almost untouched for over a week of sessions in favor of necessary-but-secondary engineering work. This conversation was the course-correction.

A direct tension was named and worked through: John wants to launch to validate the business (the urgent thing), but will not launch until he's confident in (a) backend readiness, (b) the actual data being collected is valuable, and (c) the logger experience is genuinely good — not just "shipped." The risk flagged: "I'll launch when I'm comfortable" is not a bounded criterion, and a real product always has more things worth polishing. The resolution was to split the backlog into **gate items** (must be true before even a small beta) versus **iteration items** (real, but not blockers) — see Section 5.

---

## 2. Competitive Positioning Research

Web research was conducted on three real comparables to sharpen how CompanionCommons is actually different, not just "better":

### Basepaws (pet DNA/health testing)
Closest existing precedent for CompanionCommons' actual shape — collects health-adjacent data from consumers, monetizes via research/commercial use. Key precedent found: Basepaws explicitly separates "Personal Information" (owner-identifying) from the pet's health/genetic data in their own legal terms, stating pet data used for research/commercial purposes is governed separately from the Privacy Policy. They also require specific, opt-in consent for named research projects — not one bundled signup checkbox.

### Whistle (pet activity/health tracker)
Public Apple App Store privacy disclosures show the same instinct — data linked to identity is explicitly separated from data that isn't, at the product level, not just in policy language.

### DTC genetic-testing industry standard (Future of Privacy Forum best practices)
The broader industry norm: **separate, specific express consent required before sharing data with third parties**, beyond whatever consent covers basic service use. Reinforces that bundled consent (one checkbox covering both "use the app" and "include my data in licensing") is below the standard other companies in adjacent spaces already follow.

### How CompanionCommons Actually Differs (confirmed with John)

1. **100% self-reported survey data — never hardware, sensor, biometric, or genetic data.** This is a real, lower regulatory risk tier than either comparable (biometric/genetic data are their own explicit legal categories under laws like CCPA). John confirmed no near-term intent to ever add electronic/device monitoring.
2. **Business model is inverted from both comparables.** Basepaws and Whistle sell directly to the pet owner. CompanionCommons is free-forever on the consumer side, monetizing entirely through B2B licensing to pharma/insurance/supplement companies. This is *less-charted legal territory* than either comparable, despite the lower data-sensitivity — flagged as its own explicit framing point for the lawyer conversation, not something to gloss over.
3. **Never interprets, diagnoses, or makes recommendations based on findings or outcomes** — a standing rule John reaffirmed explicitly in this conversation. Comparables like Whistle Health and Basepaws both make health-risk or diagnostic-adjacent claims; CompanionCommons deliberately does not.
4. **No passive or continuous tracking.** Data only exists via a deliberate, active logging action — never collected without the owner consciously choosing to provide it in that moment.
5. **The brand name doesn't signal "pet company"** — unlike Basepaws, Whistle, Fi, or Fido's Bark. Confirmed as correct, intentional positioning given the actual business is data intelligence with pets as the data source, not a pet product with data as a side effect.

---

## 3. Real-World Evidence (RWE) Positioning — The Core Strategic Decision

**The decision:** CompanionCommons is now positioned front-and-center as a **Real-World Evidence platform for pet health**, modeled on how Flatiron Health built structured, longitudinal, real-world treatment data for oncology (sold to Roche for $1.9B specifically because pharma wanted real-world signal beyond controlled clinical trials). This was identified as the single clearest gap in the current pet-health market — no comparable company (Basepaws, Whistle, Fi) is systematically correlating interventions (medications, supplements) against standardized outcome data at population scale over time. CompanionCommons' existing data model — `treatment_category` + weekly scores + a 12-week cadence — is already structurally close to an RWE product, even though it wasn't originally framed that way.

**Two firm rules that define how this gets built, both explicitly confirmed by John:**

1. **No consumer-facing scoring or predictions, ever.** A logger only ever sees their own dog's real data, real trends, and anonymized comparative context (how they stack up to others) — never a forward-looking claim or risk score about their specific dog. This directly preserves the existing "never diagnose or interpret" standing rule and was stated as non-negotiable.
2. **Predictive AI modeling — trained on the aggregate dataset — is intended as a major, deliberate part of the B2B data licensing product.** Not just raw anonymized data exports, but actual trained models sold to pharma/insurance/supplement buyers (e.g., predicting likely trajectory under different intervention patterns). This is explicitly framed as "sell bread, not flour" — a materially more valuable and defensible license than simple data resale.

**Implications flagged, not yet acted on:**
- Predictive models require real data volume and real longitudinal depth to be worth anything — this raises the stakes on actually launching and validating retention with real founding members. As of Aug 20, there are still zero real users; the site remains password-locked.
- This makes the already-flagged data-model separation work (identifiable owner data structurally separated from health/behavioral data) more important than it already was, since training predictive models on unseparated data increases liability surface well beyond simple anonymized aggregate export.

**A second, related differentiator John wants reflected in the product** (distinct from the RWE/licensing decision, but connected): giving loggers a select set of anonymized comparative data points (e.g., "how does your dog compare to other dogs," plus a few similar insights) as the core value-exchange on the free consumer side. This must be genuinely useful and engaging enough to drive retention — but must not be so generous that it substitutes for what buyers actually pay to license. This tension is not yet resolved and is flagged as a real, open product question — see Section 6.

**What to explicitly avoid, flagged during this conversation:** anything that starts to resemble risk-scoring or underwriting (e.g., flagging a dog as "high-risk" for an insurer's benefit) crosses directly into the "never interpret or diagnose" line. If any future consumer-directed data-sharing feature is considered (an owner choosing to share their own dog's record with their own insurer, discussed as a speculative future idea, not decided), it must stay strictly "owner shares their own data for their own benefit," never "we score risk on behalf of the insurer."

---

## 4. Individual Connection vs. Community — Resolving the Beta Scope Tension

John named a real, specific challenge directly: the business is "data, data, data" on the back end, but the product needs to create genuine emotional connection, a sense of community, and a feeling of contributing to something meaningful — rooted in legitimate business practice, not just framed that way. He identified this as the actual source of prior scope disagreement between him and Claude on what the beta should include.

**The resolution reached:** this is a sequencing problem, not a contradiction, and it's largely a function of beta size. Two real categories of feature exist:

- **Individual-value features — buildable and validatable right now, even at a beta of 8-10 people.** Anything that makes *one person* feel something about *their own dog's journey*, independent of whether anyone else exists in the system: streaks, milestones, the Journey Summary as a real artifact, the breed guide unlock, whether logging itself feels good and easy. This is what the current beta can and should test.
- **Community/movement features — structurally premature until real volume exists.** Peer comparisons, rank, "join the movement" messaging, breed-cohort comparisons, leaderboards. A comparison against 8-10 dogs isn't a believable community regardless of how well it's built — this isn't a feature-completeness problem, it's a function of scale that no amount of building can solve early.

This directly explains the "no catch-22" conclusion also reached in this conversation: retention risk from lacking community/scale features is not actually a trap, because a well-established category of retention mechanics (habit loops, personal trend visibility, individual milestone/reward psychology) works on an individual level and requires no other users to exist. The real open question the beta needs to answer is whether *that* individual hook works — not whether community features are complete.

**Honest caveat named:** a beta this small, especially with 2-3 people who already know John personally, can both undersell and oversell what a genuine stranger would feel. The qualitative follow-up (asking real beta users directly why they did or didn't keep logging) was flagged as more valuable at this scale than the raw retention percentage alone, since John has the rare ability to personally call every beta participant and ask.

---

## 5. Beta Structure — Final Decision

**Locked in:** 10 people total.
- **8 real strangers**, not personally known to John, sourced from the actual target persona (senior-dog owners) — intended to test genuine product-market signal, not just goodwill from people who already like John.
- **2-3 close friends** John trusts to give honest, critical feedback — intended as the qualitative-depth channel (why retention worked or didn't), not just additional headcount.

This is an increase from the originally discussed 6-7, made deliberately, not as scope creep — the reasoning: more confidence that any retention signal is real rather than noise, and slightly more room for persona diversity, while still small enough that John can personally follow up with every single participant.

**"Gate items" vs. "iteration items" — the resolution to the launch-readiness tension from Section 1:**

Real gate items, named directly by John, in order:
1. Are the data points currently being collected going to produce the most valuable dataset possible?
2. Legally, is the app allowed to collect this information as currently structured?
3. What are the actual legal ramifications — requires the lawyer conversation (Section 7).
4. If medical-category data collection is confirmed sound: are the systems in place to manage this type of data responsibly, and is logging still easy?

Of these, #1 ("most valuable dataset possible") was flagged as **not actually a bounded, pre-launch-answerable question** — there is no closable answer to "most valuable" before real buyers react to real data or real volume exists. Reframed: this is a question the beta itself should help answer, not a gate that blocks starting the beta.

Genuinely-current gate items, as resolved: (1) legal review scoped specifically to what's collected today, (2) fixing the missing consent-record gap before any lawyer review means anything, (3) fixing the stored-XSS bug (security, not optional). Everything else — visual polish, drug-name data, "most valuable dataset" optimization — is real, valuable work, but it's **iteration work**, sequenced after the beta launches with 8-10 people who already trust or are willing to try the product, not before.

---

## 6. Open Product Question, Not Yet Resolved

**How much comparative insight to give loggers for free, without undercutting licensed data value.** This is the practical tension underneath the "select anonymized data points" differentiator from Section 3. It surfaced concretely when reviewing the current dashboard's peer-comparison card, which — even before real breed-level comparisons exist — already shows raw rank and community average score to every logger for free, with no gating. Flagged as arguably already on the generous end of the give-away/protect line. Not resolved in this conversation; queued as a real design/business decision for a future session, alongside the medication-data and data-model-separation questions — all three are variations of the same underlying question: where does the free/paid line actually sit in the data model.

---

## 7. Medication Data — Deep Dive and Decision

**The question:** should CompanionCommons move from collecting medication/treatment *category* only (current state: `joint_supplement`, `NSAID`, `steroid`, etc., no drug names or dosage) to collecting actual drug names, with or without dosage?

**Dosage: rejected outright, not just deferred.** Self-reported dosage from a pet owner (not verified against an actual prescription) is not clinically meaningful data — no way to know if it reflects the actual prescribed dose, a rounded guess, or a misremembered number. It adds real legal exposure for close to zero analytical value. This is treated as a closed question, not open for reconsideration without a real change in circumstances.

**Drug name, without dosage: real commercial upside, but decided NOT to add yet.** The case for it: "dogs on this joint supplement improved" is a category-level insight; "dogs on Rimadyl outperformed dogs on Galliprant" is a brand-level competitive signal — genuinely more valuable to a pharma buyer's market research team. The case against building it now, three real blockers:

1. **Data quality.** Free-text drug names from pet owners would be unreliable (brand vs. generic, misspellings, vague descriptions). A real fix requires an actual autocomplete against a verified veterinary drug list, not a text box — not yet built.
2. **Meaningful sensitivity jump.** Named drug + specific pet + specific owner is a genuinely bigger jump in data sensitivity than the current category system — this changes the company's overall risk profile, not just its data richness, and that should be an eyes-open decision, not something that happens by default.
3. **The real underlying blocker: no structural separation between identifiable owner data and health/medication data.** Every field currently sits on one flat `senior_dogs` row. Before adding a more sensitive field, the actual fix needed is architectural — health data needs to be structurally separable from owner PII, so "anonymized for licensing" is true at the database level, not just a promise made in privacy copy. Adding drug names on top of the current flat structure would make this gap worse, not better.

**Recommendation, agreed:** get lawyer review specifically scoped to this exact question before building anything, and treat the data-model separation work as a genuine prerequisite architecture task — not a nice-to-have that can happen alongside or after.

---

## 8. Free-Text Notes Containing Medical History — Decision

**The question:** notes and observations (baseline, weekly, and the mid-week notes feature) are entirely free-text with zero content filtering or moderation. Should this continue, be restricted, or be automatically filtered?

**Decision: keep allowing freely.** Reasoning: this matches the actual product purpose — the Journey Summary feature exists specifically to help an owner prepare for a vet conversation, and a note like "stopped the Rimadyl two weeks ago, seems stiffer since" is exactly the kind of thing that feature is for. Filtering or restricting notes would meaningfully weaken the product to chase a marginal safety gain, and there's nothing unique to CompanionCommons about the general risk that a free-text field can contain sensitive information — that's true of any text box on the internet.

**Two hardening conditions attached to this decision, both now shipped as of Aug 20:**

1. **An in-context disclosure directly under the notes textarea itself** — not just buried in `privacy.html` — stating notes aren't reviewed or filtered before storage and asking users to avoid including anything they wouldn't want stored as plain text. Shipped in this session's privacy-page rewrite.
2. **A hard architectural rule: free-text fields (notes, baseline/weekly observations) must never flow into the enterprise/B2B licensing export — only structured, validated scores do.** This is framed as more than a safety measure — it's also a *stronger* governance pitch to enterprise buyers ("we only license structured, validated fields, never raw text"), which their own compliance teams are likely to view favorably compared to a vaguer promise.

---

## 9. Prepared Questions for Lawyer Review

**Type of lawyer needed:** a privacy/data attorney with experience in **consumer data monetization and data licensing** — not a generalist business or contract lawyer. CompanionCommons' actual business model (collect consumer data, sell anonymized/aggregated versions to third parties) sits closer to "data broker" legal territory than a typical small SaaS company. Look for:
- CCPA/CPRA experience, plus awareness of the growing patchwork of other state privacy laws (relevant since signups can come from any US state)
- Ideally, some familiarity with data broker registration law specifically (California, Vermont, Oregon, and Texas all have one) — worth knowing whether the current model triggers a registration requirement
- Veterinary-specific privacy experience is not required and is genuinely rare — pet health data isn't HIPAA-covered, so a human-health privacy lawyer's instincts won't map perfectly either. General consumer-data-monetization experience matters more.
- A generic business-formation/contract lawyer is not the right fit for this specific set of questions, though one may be worth engaging separately for entity structure.

**Data collection & disclosure**
1. Is everything currently collected (breed, age, gender, weight, spay/neuter status, zip code, email, phone, baseline + weekly health scores, medication *category* checkboxes, free-text notes) legal to collect from consumers as currently structured?
2. What specific disclosures does `privacy.html` need to contain to be legally adequate — is general "we collect X for Y purpose" language sufficient, or is more specificity required?
3. Zip code was previously mislabeled on the privacy page as not collected, when it actually is (now corrected as of this session) — is there any obligation to notify anyone about the prior inaccuracy, or is the correction itself sufficient?

**Consent**
4. The consent checkbox currently blocks signup submission but is never persisted anywhere — no timestamp, no record of what version of the policy was shown. Is a persisted consent record legally required, and what should it capture?
5. Should participation consent (logging data at all) and licensing consent (including a user's data in the B2B/research pool) be separated into distinct, granular checkboxes instead of one bundled checkbox?
6. The one-time SMS verification text is sent regardless of the SMS-reminder opt-in checkbox's state — is this a compliance gap, or is one-time account-verification texting generally exempt from consent requirements under TCPA?

**Data licensing / business model**
7. Given the model sells anonymized/aggregated data to pharma, insurance, and supplement companies, does this classify the company as a "data broker" under any applicable state law, and if so, is registration required?
8. What legally qualifies as sufficient "anonymization"? Is excluding direct identifiers (name, email, phone) enough, or are there minimum-group-size aggregation thresholds required before publishing any statistic, to avoid realistic re-identification risk?
9. Free-text notes could contain identifiable medical detail even though structured fields don't (see Section 8). Given notes are now excluded from the B2B export by architectural rule, does the in-context disclaimer provide sufficient legal cover for the consumer-facing storage of that data, or is more required?
10. If drug-name-level data is added at some future point (not decided — see Section 7), how would that change legal exposure or classification compared to the current category-level system? Worth asking now so the answer can inform whether the data-model separation work needs to happen before or can happen alongside that future decision.

**Multi-state / general exposure**
11. Since signups can come from any US state, which state's privacy law actually governs, and is a "build to the strictest applicable state standard" approach the right general posture?
12. Does the FTC's stance on deceptive privacy practices create exposure given the current stated promise ("we will never sell your identifiable personal information for marketing or advertising")? The actual technical data flow needs to be confirmed as matching that claim exactly, not just approximately.

**Structure**
13. Given health-adjacent data collection, does the current business structure create meaningful personal liability exposure that a different structure (LLC, corporation) would reduce — and if so, should that change happen before or can it reasonably happen after the initial closed beta?

**Practical note for the actual meeting:** bring the real, current `privacy.html` text and a genuine description of the actual data flow (not a hypothetical) — lawyers give sharper, more useful answers against real artifacts than against described scenarios.

---

## 10. Summary of Concrete Decisions Made This Session

For quick reference — full reasoning for each is in the sections above:

| Decision | Status |
|---|---|
| Adopt Real-World Evidence (RWE) platform positioning | ✅ Decided |
| No consumer-facing scoring/predictions, ever | ✅ Decided (firm rule) |
| Predictive modeling as a core part of B2B licensing | ✅ Decided |
| Drug-name/dosage medication data | ❌ Not now — pending lawyer review + data-model separation |
| Free-text notes with medical content | ✅ Keep allowing, with two hardening conditions (both shipped) |
| Beta structure: 8 strangers + 2-3 friends | ✅ Decided, locked in |
| "Senior dog" wedge vs. all-ages data collection | ✅ Resolved — senior stays the pitch/marketing wedge, data collection opens to all ages |
| Free-vs-licensed comparative data line | ⏳ Open, not resolved — queued for future discussion |
| Data-model separation (identifiable vs. de-identifiable) | ⏳ Flagged as a real prerequisite, not yet started |
