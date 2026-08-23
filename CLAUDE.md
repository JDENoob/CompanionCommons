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
**STEP P10 — Health check-in instrument redesign** — see Health_Instrument_Redesign_Build.md for full detail. Pre-beta blocker, sequenced ahead of STEP P8. Stages 1-4 all complete (schema/helpers, signup surfaces, check-in surfaces, and Stage 4's sign-flip work split into 4a insight/alert-logic + 4b dashboard-display, both done). Migration still NOT run against Supabase — every save route (send-magic-link, add-dog, checkin-senior) still 500s on real submission for exactly that reason. The dashboard/breed-guide routes, unlike the save routes, are SELECT-only and don't hit that wall — both fully verified live, including a deliberate real `0` mobility score to catch falsy-zero regressions (found and fixed one: `latestPerDog`'s truthy check in the peer-comparison card would have silently let a dog's real `0` get overwritten by an older, non-zero row). Stages 5-6 (Google Sheets headers, verification pass) not started.

Multi-dog owner architecture project — see Multi_Dog_Signup_Build.md for full detail. **All 5 stages complete and shipped** (owner entity, owners table, signup rewrite with returning-owner detection, combined churn emails + combined SMS reminders + /checkins/:owner_id page, and an additive-only owner-session dashboard dog-switcher). No open items on this project.
