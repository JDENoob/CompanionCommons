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
**STEP P10 — Health check-in instrument redesign** — see Health_Instrument_Redesign_Build.md for full detail. Pre-beta blocker, sequenced ahead of STEP P8. Stages 1-4 all complete. Main migration (`migration_redesign_health_instrument.sql`) has been run. A real end-to-end signup attempt immediately after (deliberately using a real all-zero mobility answer) found a live-blocking bug: `magic_link_tokens` has a pre-existing constraint named `mobility_check` (not one this project created) still enforcing the old 1-8 range underneath the new 0-10 one — the redesign migration never checked for pre-existing constraints before adding its own alongside it. Isolated empirically to exactly that one column on that one table (every other composite column across all three tables tested clean at 0 and 10). Fix written (`migration_drop_legacy_mobility_check.sql`), **not yet run** — real signups with a composite landing outside 1-8 (including the common all-zero case) can't be saved until it lands. Stage 5 (Google Sheets headers) is blocked on this fix; Stage 6 also needs it before real end-to-end verification can proceed.

Multi-dog owner architecture project — see Multi_Dog_Signup_Build.md for full detail. **All 5 stages complete and shipped** (owner entity, owners table, signup rewrite with returning-owner detection, combined churn emails + combined SMS reminders + /checkins/:owner_id page, and an additive-only owner-session dashboard dog-switcher). No open items on this project.
