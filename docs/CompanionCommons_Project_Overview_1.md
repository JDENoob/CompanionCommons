# CompanionCommons Project Overview

**Rewritten:** September 1, 2026 (previous version dated August 12, 2026 — substantially out of date, including a business-model contradiction corrected below)
**Status:** Pre-beta. Site live at companioncommons.com, password-locked. Zero real users.
**Goal:** Build the largest independent, structured, longitudinal pet health dataset — a real-world-evidence (RWE) platform for pet health, structurally inspired by how Flatiron Health built longitudinal oncology data (acquired by Roche, 2018, for $1.9B). 7-year horizon, revenue via B2B data/insight licensing, not consumer monetization.

---

## Business Model — corrected

**Previous version of this document listed "affiliate marketing" as Priority 1. This is no longer the plan and should not be treated as current.** After explicit discussion, the decision was made to protect a stricter, more differentiated position: **CompanionCommons will never sell or promote a product, and will never use a dog's health data to target advertising or product recommendations at its owner.** This is stated directly in the site's own founder copy and trust messaging. Revisiting affiliate marketing (even non-personalized, retailer-level affiliate links) was explicitly considered and explicitly declined — see the Build Log for the full reasoning, but the short version: it directly contradicts a public commitment already made, and the value of that differentiated trust position outweighed the near-term revenue.

**The real, current model:**
- **Consumer side: free, forever.** Dog owners log structured weekly health check-ins. No ads, no affiliate links, no product promotion, no data-driven targeting of any kind.
- **Revenue: B2B licensing of de-identified, aggregated data and trained predictive models** to pharma, insurance, and supplement companies. "Sell bread, not flour" — the product is population-level insight, not raw data exports.
- **Near-term revenue bridge (pre-scale), under consideration, not yet pursued:** sponsored research modules (a company pays to add specific survey questions for a defined study period, in exchange for early access to findings — real precedent in patient-registry research) and/or a donation model. Both compatible with the no-ads/no-product-promotion positioning; affiliate marketing and targeted advertising are not.

---

## Current State (as of September 1, 2026)

### Live and shipped
- **Multi-dog owner architecture** — phone-deduplicated owner accounts, one owner can have multiple dogs, consolidated messaging per owner (not per dog).
- **Redesigned health check-in instrument** — CBPI/CCDR-inspired, independently written (not copied, for IP-safety reasons), multi-item 0-10 scales across four domains: Mobility (weekly), Energy (weekly), Appetite (weekly), Cognitive (every 4th week). Composite scores. Neutral, non-evaluative language throughout (no "improved"/"declined"/"concerning").
- **Senior-by-breed-size classification** — computed live from age + real breed-size-tier thresholds (not a flat age cutoff), shown as a dashboard badge, framed as classification only, never a health judgment.
- **Medication/supplement tracking system** — category-level (not drug-name-level; see "Deliberately not yet built" below), repeating structure supporting multiple concurrent medications per dog, structured condition-treated dropdown, provenance metadata (owner-observed vs. vet-reported), zero owner-identifying columns by design. Includes event-triggered engagement: when a medication starts, stops, or changes, the owner is offered an in-app opt-in to see a real computed trend recap 4/8/12+ weeks later — built on top of the program's existing (and deliberately unbounded) week-13+ logging support.
- **Logging is genuinely open-ended, not capped at 12 weeks.** The 12-week framing is the design cadence for the initial program arc (reminders, milestones, Journey Summary), not a hard stop — reminders, check-ins, and streak tracking all continue correctly past week 12 if an owner keeps logging.
- **Full custom brand identity** — paw-based icon family, double-C+paw logo mark, and a from-scratch hero graphic (US map, five dog-photo positions, center logo, dashed connectors) replacing an earlier six-dog hub design.
- **US-residents-only gate**, built in layers (no single point of failure): Twilio account-level geographic SMS permissions restricted to US+Canada (Twilio cannot separate the two, since both share the +1 country code), app-layer phone validation via `libphonenumber-js` specifically closing the Canada gap Twilio's setting can't, ZIP format validation, and explicit Terms-of-Service eligibility language.
- **Email opt-out** — a real, working unsubscribe mechanism for the automatic churn/re-engagement email (previously promised in the privacy policy but not actually functional). SMS opt-out (Reply STOP) already worked correctly via Twilio.
- **Churn email cadence fixed** — previously could re-fire up to ~7 times per missed week (a real, found bug); now capped at once per missed week, matching the SMS reminder cascade's own restraint.
- **Google Sheets export schema completed** — several structured fields (phone, zip, spayed/neutered status, diet type, pet insurance, SMS consent) were collected at signup but never reached the Sheets export; fixed. Free-text fields (owner notes, medication "other" detail, weekly update notes) are deliberately excluded from Sheets and any future export, on a firm architectural rule, not just a policy statement — see "Data governance" below.

### Deliberately not yet built (blocked on a real prerequisite, not forgotten)
- **Medication/supplement *name*-level collection.** Category-level only for now. Real drug-name collection needs (1) an actual autocomplete UI against a real veterinary drug reference source — candidate sources researched: the FDA's Animal Drugs @ FDA database (free, official, best starting point) and openFDA; (2) lawyer review specifically on the added sensitivity of named-drug-plus-pet-plus-owner data; (3) the data-model separation architecture (below) as a structural prerequisite.
- **Dosage** — rejected outright, not just deferred. Self-reported dosage is clinically meaningless (owners misreport units/frequency) and pure legal exposure with no analytical upside.
- **Account/Pet-Identity/Pet-Health database separation.** A specific architecture has been proposed (Account DB → Pet Identity linkage table → Pet Health DB → Analytics environment → External licensed export, with private notes held completely outside the research/analytics pipeline) but not built. This is the real structural prerequisite for medication-name collection and for any serious predictive-modeling licensing work. The single most sensitive component in that proposed design is the Account↔Pet-ID linkage table — if that table and the Pet Health DB are ever queryable together, de-identification is undone in one query, so it would need RLS stricter than any other table in the system, near-zero legitimate code paths that join across it, and real audit logging.
- **Native iOS/Android app.** Intentionally deferred until after beta validates retention — a real engineering commitment (two more codebases, app store review processes) not worth making before there's evidence the underlying product retains people.
- **Full psychometric instrument validation** (internal consistency/Cronbach's alpha, factor analysis, responsiveness testing). See `Data_Analysis_Methodology.md` for the full plan — each method has a real minimum sample size (roughly 30-50 dogs for internal consistency, 100-250+ for factor analysis and responsiveness testing) that beta scale doesn't reach. The honest current claim is "well-designed, structurally inspired by validated instruments, not yet independently proven" — not "validated."

### Open decisions, not yet made
- Whether medication data (the relational, repeating kind — multiple medications per dog, weekly updates) should be exported to Google Sheets at all, or stay Supabase-only. A draft implementation exists but was deliberately held back pending more thought, since Sheets' flat-tab structure doesn't represent relational data well.
- When to remove the site's password lock ahead of beta.

---

## Data Governance — the core, non-negotiable rules

These are structural commitments, checked and enforced repeatedly across this project's history, not just stated policy:

- **Free-text fields never flow into any Sheets export or future B2B/licensing export.** This covers owner notes, medication "other" condition detail, and medication weekly-update notes. Structured scores and categories only.
- **Never diagnose, interpret, or recommend based on findings.** No health-risk or diagnostic-adjacent claims, unlike some comparables in this space.
- **No passive/continuous tracking.** Data only exists via deliberate active logging — no hardware, sensors, biometric, or genetic data collected, ever.
- **Never sell personal information, never promote or sell a product, never use health data to target advertising.**
- **US residents only**, for now — enforced in multiple independent layers (see above), not a single point of failure.

---

## Competitive Positioning (researched, current as of Sept 1 2026)

- **Basepaws** — one-time genetic/microbiome testing (not longitudinal), acquired by Zoetis in 2022 after raising almost nothing independently; currently contracting (18 employees, down 25% YoY under Zoetis ownership).
- **Whistle** — hardware/sensor-based activity tracking, acquired by Mars Petcare in 2016 for ~$117M; **sold to Tractive and permanently discontinued as of August 31, 2025.** No longer an active product or company. Its associated "Pet Insight Project" (a Mars/Banfield real-world-data initiative) is very likely dormant given Whistle's shutdown, though not independently confirmed.
- **GreatPetCare** — a content/media site (1M monthly readers, not registered longitudinal users) owned by Covetrus, a ~$4B-valuation animal-health distribution/practice-management conglomerate. Not a data-collection competitor today, but Covetrus's underlying practice-management software gives it a latent, structurally significant advantage (real vet-EHR access) that CompanionCommons cannot easily replicate — worth monitoring, not currently a threat.
- **Dog Aging Project (DAP)** — the real north-star comparable for data credibility: 53,800+ dogs enrolled (May 2026), academic/NIH-funded, fully open-data. Annual survey cadence (vs. CompanionCommons's weekly) — genuinely complementary, not duplicative: DAP answers lifetime genetic/environmental questions, CompanionCommons answers short-term trend changes. DAP's own methodology (a validated shortened C-BARQ, owner-reported-vs-vet-record accuracy studies) is a citable precedent for CompanionCommons's own validation approach. Worth knowing DAP nearly lost all federal funding in 2024 — even the best-resourced academic longitudinal pet study is not immune to funding fragility.
- **Snout** — a well-funded ($110M+) US prevention-care financing startup, philosophically closer to a fit than an insurer like Lassie (which is EU/UK-only and therefore not currently relevant given the US-residents restriction) — Snout's core thesis (preventive care improves outcomes) is something CompanionCommons's longitudinal data could help validate.
- **Saanroo** — a B2B nutraceutical ingredient supplier (Levagen+/PEA) with a real, recent (April 2026) peer-reviewed companion-animal clinical trial on joint mobility. First real outreach target — contacted directly (Pavitra Viswanath, Director of Clinical Affairs) as the person whose actual job is evaluating exactly this kind of real-world evidence complement to their existing trial data.

---

## Tech Stack

- **Backend:** Node.js/Express (`server.js`), hosted on Railway (auto-deploys from GitHub `main`).
- **Database:** Supabase (PostgreSQL + Storage). Row-Level Security enabled site-wide.
- **Communications:** Twilio (SMS, A2P 10DLC approved, geo-restricted to US+Canada), SendGrid (email).
- **Frontend:** Vanilla HTML/CSS/JS, static pages in `Public/` (capital P).
- **Data export:** Google Sheets, 5 tabs as of Sept 1 2026 (Signups, CheckIns, Notes, Medications, MedicationUpdates — the latter two currently held back from real use pending the open Sheets-vs-Supabase decision above).
- **Version control:** GitHub (`JDENoob/CompanionCommons`), `CLAUDE.md` at repo root for persistent session context.
- **Repo organization:** `/migrations` (one-time schema-change SQL, run manually in Supabase's SQL Editor per standing rule — never auto-run), `/sql-utilities` (reusable test-data wipe/verify scripts), `/docs` (Build Log, checklist, SMS/Email reference docs).
- **Build tools:** Claude Code (claude.ai/code) for all file edits; a separate Claude.ai chat for planning/review.

---

## Standing Operating Rules

- **Verify empirically, don't infer from a prior report.** This project has repeatedly caught real bugs this way (dashboard/confirmation-screen text disagreeing, a stale header row claim, an unverified assumption about which endpoint leaked a credential) — the standing instinct is to check the live code/live data directly rather than trust a description of it, including this document.
- **Migrations are written by Claude Code, reviewed, and run manually by the project owner in Supabase's SQL Editor.** Never auto-run.
- **Security sweeps are a standing, recurring process** (established after 3 real credential-exposure incidents across this project's history): a lightweight credential-exposure check at the end of every session before pushing, and a full security sweep (credential inventory, RLS check, dependency audit, endpoint auth review) before any real go-live event or major deploy.
- **Git discipline:** scratch files deleted before committing, unrelated changes kept in separate commits, nothing committed without a real diff review first.

---

## Next Real Steps (see `docs/SENIOR_DOGS_MVP_CHECKLIST.md` for the full, current, line-item list)

1. Schedule the actual privacy/data attorney conversation — scoping document ready (`CompanionCommons_Legal_Scoping_Aug31.md`).
2. Decide the medication-data-in-Sheets question.
3. Recruit for closed beta — target 10 loggers (8 real strangers matching the senior-dog-owner persona, 2-3 close friends), including at least one real multi-dog household.
4. Decide when to remove the site's password lock ahead of beta.
5. Scope the Account/Pet-Identity/Pet-Health data-model separation as a real, deliberate project — not something to let drift into "a few new tables" scattered across other feature work.
