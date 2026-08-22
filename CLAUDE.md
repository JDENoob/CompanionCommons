# CompanionCommons — Project Context

This is CompanionCommons, a pet health data intelligence platform. Full details, decisions, and history are in these reference docs — read them at the start of any session working on something they cover:

@docs/CompanionCommons_Build_Log.md — day-by-day session history of everything built and fixed
@docs/SENIOR_DOGS_MVP_CHECKLIST.md — current status and next steps
@docs/CompanionCommons_Strategy_and_Legal_Aug20.md — business positioning, data governance decisions, lawyer prep
@docs/Multi_Dog_Signup_Build.md — the multi-dog owner architecture project (in progress, Stages 1-3 complete)
@docs/All_SMS_Communications.md — reference for every real SMS template's final copy, character counts, and trigger conditions

## Key standing rules, always apply:
- Never diagnose or interpret health data — show data, never a health judgment or recommendation
- No consumer-facing predictions or risk scores, ever — only the owner's own dog's real data/trends
- Free-text fields (notes, observations) must never flow into any B2B/licensing data export — structured scores only
- Always verify empirically before reporting something works (measure/query live state, don't just infer from a success message)
- Migrations: write the SQL file, do NOT run it — John runs migrations manually in Supabase's SQL Editor
- Before committing: show the diff for review first
- Before starting any local dev server for testing, check for and kill any existing node processes first (Get-Process node on Windows) — stray leftover servers from earlier sessions share the same live Supabase database as fresh test runs and can race against them, producing false-looking test failures (confirmed real occurrence: Aug 22, Stage 4 SMS-combining verification)

## Current in-progress work
Multi-dog owner architecture project — see Multi_Dog_Signup_Build.md for full detail. Stages 1-4 complete (owner entity, owners table, signup rewrite with returning-owner detection, combined churn emails + combined SMS reminders + new /checkins/:owner_id page). **Stage 4 has one pending migration (`migration_add_sms_queue_owner_id.sql`) that must be run before/with deploy — until it runs, the SMS-sending cron will silently stop sending any pending SMS.** Stage 5 (owner session + dashboard dog-switcher) not yet started.
