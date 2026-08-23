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
**STEP P10 — Health check-in instrument redesign** — see Health_Instrument_Redesign_Build.md for full detail. Pre-beta blocker, sequenced ahead of STEP P8. Stages 1-4 all complete. Both migrations run (`migration_redesign_health_instrument.sql`, then `migration_drop_legacy_mobility_check.sql` after real testing caught a pre-existing stale constraint the first migration didn't know to remove). A full real end-to-end pass (real signup with an all-zero mobility answer → real verify → real check-in on a cadence week → real dashboard load) is now confirmed working live for the first time — including `detectHealthAlerts` firing two real alerts with correct sign/threshold behavior and `describeTrendForGlance` showing correctly-flipped live trend text ("declined (+4)"). All test data cleaned up afterward. Stage 5 (Google Sheets headers) starting now, with no remaining doubt about the underlying pipeline. Stage 6 (verification pass) after that.

Multi-dog owner architecture project — see Multi_Dog_Signup_Build.md for full detail. **All 5 stages complete and shipped** (owner entity, owners table, signup rewrite with returning-owner detection, combined churn emails + combined SMS reminders + /checkins/:owner_id page, and an additive-only owner-session dashboard dog-switcher). No open items on this project.
