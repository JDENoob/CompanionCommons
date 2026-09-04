**ARCHIVAL — process notes from the Sept 2 2026 drafting phase.**
Every 🔴 open item flagged in this outline was resolved in the final
shipped Privacy_Policy_Draft.md / Terms_of_Service_Draft.md (both live
in production as of Sept 3 2026 — see docs/Legal_Pages_Publish_Build.md
for the full history). Kept for reference on how those drafts were
built, not as a source of current open questions.

---

# Privacy Policy & Terms of Service — Rewrite Outline
**Compiled September 2, 2026**

This is a section-by-section outline for rewriting `privacy.html` and `terms.html`, built from comparison against four real companies (Basepaws, PatientsLikeMe, mydogforlife.com/Buddy AI) plus CompanionCommons's own already-established standing rules. Each item below is tagged with where the language pattern comes from. **This is a drafting outline, not final legal copy** — items marked 🔴 are genuine open gaps that need either a deliberate decision or real lawyer input before anything is finalized; nothing here should be treated as ready to ship without that review, per the existing legal scoping document.

---

## PRIVACY POLICY

### 1. Introduction / Scope
- Who CompanionCommons is, what this policy covers (the website, the account, communications).
- **[Basepaws #2, adapted]** Jurisdiction sentence: *"CompanionCommons is controlled and operated from the United States and is not intended to subject us to the laws and jurisdictions of any state, country, or territory other than the United States."* Ties directly into the already-built US-residents-only gate (Twilio geo-restriction, ZIP validation, phone validation).

### 2. What We Collect
- Real, current, complete list (post-Sept-1 schema fix): dog name, breed, age, sex, weight, spayed/neutered status, zip code, phone, email, SMS consent, diet type, pet insurance status, medication/supplement category (structured dropdown, not free text), condition treated (structured dropdown + "other" free-text escape valve), weekly structured health scores (mobility/energy/appetite/cognitive), medication start/stop dates.
- **Explicitly, separately called out:** free-text fields (owner notes, medication "other" detail, weekly medication-update notes) — collected, stored, but governed by a different set of rules than everything else (see Section 5).
- **No passive or hardware-collected data, ever** — worth stating as a plain differentiating fact, not just an absence: no sensors, no biometrics, no continuous tracking. Data exists only via deliberate active logging.

### 3. The Personal-Information / Pet-Information Distinction — written carefully, not copied from Basepaws
- **[mydogforlife.com #11, near-verbatim]** *"Your dog's health and behavior data is not legally classified as 'sensitive personal information' under most current frameworks — but we treat it with comparable care regardless."* This is the deliberate opposite move from Basepaws' approach (which used the same underlying legal fact to exclude pet data from protection entirely). Say plainly that this is a voluntary choice, not a legal requirement.
- **[PatientsLikeMe #7, adapted]** Introduce the two-tier framing here: "Identifying Information" (name, email, phone, zip — tied to you as the account holder) vs. "Pet Health Information" (everything about your dog's structured health data) — sets up the account/pet-identity/pet-health separation described later and in the architecture proposal.

### 4. How We Use Information
- Operate the service, send communications you've consented to, compute the composite scores and trend features shown on your dashboard.
- **Never** diagnose, interpret, or make recommendations based on findings (existing standing rule — restate explicitly here, don't just imply it).
- **Never** use your dog's health data to target advertising or product recommendations at you (existing standing rule, now also reflected in site copy — restate in the policy itself, not just marketing copy).
- Aggregate and de-identify structured data for the purposes described in Section 6.

### 5. Free-Text Data — a dedicated section, not a buried footnote
This deserves its own section given how much of this project's actual engineering work this session went into enforcing it structurally, not just as policy:
- Owner notes, medication "other" condition detail, and weekly medication-update notes are **never included in any aggregate export, licensing dataset, or analysis pipeline** — a structural rule enforced in the codebase itself (the analytics/export pipeline has no code path that reads these fields), not just a promise.
- These fields remain visible to you in your own dashboard and are used only to help you track your own dog's journey.

### 6. How We Share Information — the section that needs the most honest, direct language
- **🔴 [Gap flagged in original comparison — none of the four sources solve this well]** This needs to be more direct than any of the four examples reviewed. State plainly and specifically: CompanionCommons licenses **de-identified, aggregated** structured health data and derived predictive models to companies in the pharmaceutical, pet insurance, and supplement industries. Name the categories explicitly — do not bury this in "third parties" language.
- **[PatientsLikeMe #8, directly applicable]** Use named-category disclosure as the model: *"Our Partners include, but are not limited to: pharmaceutical companies, pet insurance companies, and supplement manufacturers."*
- State explicitly: personal/identifying information (name, email, phone, zip) is **never** included in anything shared externally.
- State explicitly: **never** sold to or shared with advertisers. **Never** used for ad targeting. No exceptions.
- **[PatientsLikeMe #9]** What happens to data already included in a completed or in-progress license/analysis if you later opt out — matches the position already established in the site's trust-box copy ("what's already been shared stays de-identified and anonymous").

### 7. De-Identification Commitment
- **[Basepaws #3, near-verbatim]** *"Where we maintain or use de-identified information, we will continue to maintain and use it only in a de-identified fashion and will not attempt to re-identify it."*
- Reference the account/pet-identity/pet-health architecture (even if not yet fully built) as the structural mechanism behind this commitment, once it exists — for now, describe the current real structure (separate database concerns, RLS) honestly, without overclaiming a full separation that isn't built yet.

### 8. Communications (SMS & Email)
- **[Basepaws #5, structurally]** Use as a template for legal-language clarity: what triggers a message, opt-in confirmation, how to opt out (Reply STOP for SMS — already real; the unsubscribe link for email — already real and built), message frequency, "message and data rates may apply."
- State plainly that both opt-out mechanisms are genuinely functional (a claim that's now actually true, post-Sept-1 fix — this project has specifically had the experience of promising this before it was true, so make sure the copy only claims what's real at time of publishing).

### 9. Data Retention
- **[mydogforlife.com #12, structurally — needs real numbers, not vague language]** Replace any Basepaws-style "as long as needed" language with concrete windows. **🔴 Needs a real decision, not borrowed numbers** — how long is data retained after account closure? Does structured health data get deleted, de-identified, or retained indefinitely for the existing dataset's integrity (likely the right answer, given research-dataset practices, but needs to be a deliberate choice, stated plainly)?

### 10. Consent
- **🔴 [Real, pre-existing unfixed gap from the Aug 20 audit — worth resolving now, not deferring further]** No persisted consent record currently exists (the checkbox blocks submission but nothing is stored — timestamp, policy version shown). This needs an actual fix, not just new policy language describing a mechanism that doesn't exist yet.
- **🔴 [PatientsLikeMe #10 / legal scoping doc Q9]** Still-open question: should participation consent (logging data at all) and licensing consent (including your data in the B2B pool) be two separate, granular checkboxes? Worth deciding before finalizing this section, since it changes what the section actually says.

### 11. Your Rights & Choices
- Access, correct, or request deletion of your identifying information.
- Opt out of communications (both channels now genuinely functional).
- Note the retention/already-shared-data caveat from Section 6/9 here too, so it's not just buried once.

### 12. Age Eligibility
- **[Basepaws #4, adopted outright]** Explicit statement: you must be 18 or older to create an account or provide information about your dog.

### 13. Data Storage & Security
- **[Basepaws #6, adapted]** Plain, one-line disclosure: your information is stored in our database (Supabase/PostgreSQL — no need to name the vendor in consumer-facing copy, but be accurate that it's a real, named storage system, not vague).
- Reference real security practices already in place (RLS site-wide) at a level of detail appropriate for a consumer audience — no need to over-explain, but don't be vague either.

### 14. Changes to This Policy / Contact Information
- Standard, low-risk boilerplate — any of the four sources' versions are fine as a base.

---

## TERMS OF SERVICE

### 1. Acceptance of Terms
- Standard boilerplate, any source works as a base.

### 2. Description of the Service
- **[Basepaws #1, restructured]** What CompanionCommons is and isn't: a self-reported health-tracking platform, not a diagnostic tool, not a substitute for veterinary care. Reframe Basepaws' genetics-specific disclaimer language into trend/survey-specific language: *"CompanionCommons's check-in scores are self-reported observations over time and are not a diagnosis. Always consult your veterinarian for any health concerns about your dog."*

### 3. Eligibility
- 18+ (Section 12 of the Privacy Policy, restated here as a binding term, not just a disclosure).
- **US residents only**, referencing the existing Terms language already built this session (zip/phone validation, Twilio geo-restriction) — this section already substantially exists; confirm current wording still matches Privacy Policy Section 1's jurisdiction language exactly, don't let them drift.

### 4. No Medical Advice / No Recommendations
- **[Basepaws #1, most directly reusable section found across all four sources]** Adapt the "No Recommendations and Endorsements" language directly — reframed from genetics to self-reported trend data, but the legal structure (educational/informational only, not a substitute for a vet, reliance is at your own risk) transfers cleanly.

### 5. User Accounts
- Responsibility for account security, accuracy of information provided, one account per household (or whatever the real multi-dog-owner policy is — confirm against the actual multi-dog architecture built this project).

### 6. User-Submitted Content (Notes) — deliberately much narrower than Basepaws
- **Do NOT adopt Basepaws' sweeping "Uploads" license** (irrevocable, perpetual, sublicensable, for any commercial purpose, including your name/likeness). This is disproportionate and contradicts the free-text-data governance rule in Privacy Policy Section 5.
- Instead: a narrow statement that notes are yours, stored for your own use, and — per Section 5 of the Privacy Policy — never included in any aggregate, licensed, or exported dataset.

### 7. Communications / SMS Terms
- **[Basepaws #5]** Same structural template as Privacy Policy Section 8, stated here as a binding term (opt-in, opt-out, message rates).

### 8. Prohibited Uses
- Standard boilerplate (no illegal use, no attempting to access others' accounts, no scraping, etc.) — any source's version works as a base, trimmed to what's actually relevant for a platform this size.

### 9. Intellectual Property
- Standard, low-risk boilerplate.

### 10. Disclaimers & Limitation of Liability
- Standard "AS IS," no warranty of accuracy/completeness language — present in all reviewed sources in similar form, low-risk to adapt.

### 11. Termination
- Standard boilerplate — reasons CompanionCommons might terminate an account (violation of terms, legal requirement, etc.).

### 12. Governing Law & Dispute Resolution
- **[Basepaws #2 pattern, but with CompanionCommons's own actual state]** Basepaws uses New Jersey; use CompanionCommons's own real state of formation/operation once that's confirmed — **🔴 needs a real answer, don't guess or default to Basepaws' state.**

### 13. Changes to These Terms / Contact
- Standard boilerplate.

---

## Summary of Real Open Items Before This Can Be Finalized

These are the genuine decisions or fixes needed — not just copy to write, but real product/legal work:

1. **🔴 Persist a real consent record** at signup (timestamp + policy version) — a pre-existing, still-unfixed gap from the Aug 20 privacy audit, not new to this exercise.
2. **🔴 Decide the granular-consent question** — separate participation vs. licensing consent, or one bundled checkbox (legal scoping doc Q9).
3. **🔴 Decide real data retention windows** — don't borrow another company's numbers; this needs to reflect CompanionCommons's actual intended practice.
4. **🔴 Confirm CompanionCommons's actual state of formation** for the governing-law clause.
5. **🔴 Write Section 6 (How We Share Information) with real specificity** — this is the one section where none of the four researched comparables provide a directly adaptable template; it needs to be written fresh, honestly naming the B2B licensing model in plain language.

Items 1-4 are good candidates for the upcoming attorney conversation (already covered in `CompanionCommons_Legal_Scoping_Aug31.md`); item 5 is a writing task that can happen independently of the legal review, though the lawyer should review the final language regardless.
