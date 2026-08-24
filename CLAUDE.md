# CompanionCommons — Project Context

This is CompanionCommons, a pet health data intelligence platform. Full details, decisions, and history are in these reference docs — read them at the start of any session working on something they cover:

@docs/CompanionCommons_Build_Log.md — day-by-day session history of everything built and fixed
@docs/SENIOR_DOGS_MVP_CHECKLIST.md — current status and next steps
@docs/CompanionCommons_Strategy_and_Legal_Aug20.md — business positioning, data governance decisions, lawyer prep
@docs/Multi_Dog_Signup_Build.md — the multi-dog owner architecture project (all 5 stages complete)
@docs/All_SMS_Communications.md — reference for every real SMS template's final copy, character counts, and trigger conditions
@docs/CompanionCommons_Health_Instrument_Design.md — locked spec for the redesigned health check-in instrument (STEP P10), literature grounding, legal position
@docs/Health_Instrument_Redesign_Build.md — the STEP P10 build project (complete) — schema, shared helpers, stage-by-stage rollout, and the real end-to-end verification pass

## Key standing rules, always apply:
- Never diagnose or interpret health data — show data, never a health judgment or recommendation
- No consumer-facing predictions or risk scores, ever — only the owner's own dog's real data/trends
- Free-text fields (notes, observations) must never flow into any B2B/licensing data export — structured scores only
- Always verify empirically before reporting something works (measure/query live state, don't just infer from a success message)
- Migrations: write the SQL file, do NOT run it — John runs migrations manually in Supabase's SQL Editor
- Before committing: show the diff for review first
- Before starting any local dev server for testing, check for and kill any existing node processes first (Get-Process node on Windows) — stray leftover servers from earlier sessions share the same live Supabase database as fresh test runs and can race against them, producing false-looking test failures (confirmed real occurrence: Aug 22, Stage 4 SMS-combining verification)

## Current in-progress work
**STEP P10 — Health check-in instrument redesign — ✅ DONE (Aug 23).** See Health_Instrument_Redesign_Build.md for full detail. All 6 stages complete, both migrations run against real Supabase, verified live end-to-end: signup, single- and multi-week check-in, a real multi-dog-owner scenario (second dog via Add Another Dog, combined `/checkins/:owner_id` page, dashboard switcher confirmed both with and without a session — the "no session" case required explicitly clearing the cookie via `/api/clear-owner-session`, since a fresh browser tab turned out to share the existing session), resend-dashboard-link, and a genuine second cadence cycle (real checkin-to-checkin trend text and a real `detectHealthAlerts` dedup case, confirmed correct via direct DB inspection rather than assumed). Two real bugs found and fixed, neither part of the original plan: a pre-existing legacy DB constraint (`mobility_check`) still enforcing the old 1-8 range, and a falsy-zero bug in the peer-comparison card's `latestPerDog` tracking. A local dev-environment timezone quirk was also found and fixed (`TZ=UTC` added to `.env`, git-ignored, local-only) — same class of issue already documented in this project's Aug 22 history. **One manual follow-up remains for John**: add "(0-10)" to the Google Sheet's live score-column headers (code only updates a freshly-created tab). Next: a real live-device testing pass (Aug 23, commits `913784b`–`4e42abd`) found and fixed several real bugs (invisible score buttons, missing dashboard link on check-in confirmation, Journey Summary print-to-PDF pagination + a week-number mismatch + alert grammar, silent health-alert data loss on fractional magnitudes, float-noise display noise) and closed the Weight/Cognitive display gap with a new conditional weight-vs-breed mini-chart. STEP P8's print-to-PDF item is now genuinely verified and closed. **STEP P8 is now fully done (Aug 23)** — a follow-up pass verified mid-week notes (real note added through the dashboard UI, escaping confirmed at the raw HTTP response level) and the Communications section (the `45785fb` invisible-button bug is itself proof of a genuine real-device reminder-SMS-to-checkin flow; John confirmed direct receipt of the churn alert email) — see SENIOR_DOGS_MVP_CHECKLIST.md's STEP P8 section for detail. Next up: beta recruiting.

Multi-dog owner architecture project — see Multi_Dog_Signup_Build.md for full detail. **All 5 stages complete and shipped** (owner entity, owners table, signup rewrite with returning-owner detection, combined churn emails + combined SMS reminders + /checkins/:owner_id page, and an additive-only owner-session dashboard dog-switcher). No open items on this project.
