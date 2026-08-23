# CompanionCommons — Project Context

This is CompanionCommons, a pet health data intelligence platform. Full details, decisions, and history are in these reference docs — read them at the start of any session working on something they cover:

@docs/CompanionCommons_Build_Log.md — day-by-day session history of everything built and fixed
@docs/SENIOR_DOGS_MVP_CHECKLIST.md — current status and next steps
@docs/CompanionCommons_Strategy_and_Legal_Aug20.md — business positioning, data governance decisions, lawyer prep
@docs/Multi_Dog_Signup_Build.md — the multi-dog owner architecture project (all 5 stages complete)
@docs/All_SMS_Communications.md — reference for every real SMS template's final copy, character counts, and trigger conditions
@docs/CompanionCommons_Health_Instrument_Design.md — locked spec for the redesigned health check-in instrument (STEP P10), literature grounding, legal position
@docs/Health_Instrument_Redesign_Build.md — the STEP P10 build project (in progress) — schema, shared helpers, and stage-by-stage rollout

## Key standing rules, always apply:
- Never diagnose or interpret health data — show data, never a health judgment or recommendation
- No consumer-facing predictions or risk scores, ever — only the owner's own dog's real data/trends
- Free-text fields (notes, observations) must never flow into any B2B/licensing data export — structured scores only
- Always verify empirically before reporting something works (measure/query live state, don't just infer from a success message)
- Migrations: write the SQL file, do NOT run it — John runs migrations manually in Supabase's SQL Editor
- Before committing: show the diff for review first
- Before starting any local dev server for testing, check for and kill any existing node processes first (Get-Process node on Windows) — stray leftover servers from earlier sessions share the same live Supabase database as fresh test runs and can race against them, producing false-looking test failures (confirmed real occurrence: Aug 22, Stage 4 SMS-combining verification)

## Current in-progress work
**STEP P10 — Health check-in instrument redesign** — see Health_Instrument_Redesign_Build.md for full detail. Pre-beta blocker, sequenced ahead of STEP P8. Stages 1-3 complete (schema/helpers, signup surfaces, check-in surfaces), all verified live in the browser. Migration still NOT run against Supabase — every save route currently 500s on real submission for exactly that reason (confirmed, not a bug). Stage 4 (the sign-flip work, highest-risk part of the whole build) split into 4a/4b given its size: **4a (generatePostLogInsight, detectHealthAlerts sign-flip + two-check threshold retune, segment fix) is complete**, verified via direct unit tests against the exact extracted code (not reachable live yet — the DB insert fails before this code ever runs, migration or not). **4b (dashboard display — trend text, chart axis, peer/community card, Journey Summary, breed guide) not started.** Stages 5-6 (Google Sheets headers, verification pass) also not started.

Multi-dog owner architecture project — see Multi_Dog_Signup_Build.md for full detail. **All 5 stages complete and shipped** (owner entity, owners table, signup rewrite with returning-owner detection, combined churn emails + combined SMS reminders + /checkins/:owner_id page, and an additive-only owner-session dashboard dog-switcher). No open items on this project.
