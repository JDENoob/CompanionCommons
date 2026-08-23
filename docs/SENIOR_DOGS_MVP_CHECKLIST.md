# CompanionCommons MVP - Hybrid Launch Checklist
**Strategy:** Web Launch (Weeks 1-2) → Parallel App Build (Weeks 3-7) → App Launch (Week 8) → Scale (Weeks 9+)

---

## ✅ COMPLETED (August 18, session 2): AI Retention Features — 27B, 27C, 27D, P1B

**Built and shipped four features in the revised priority order: Post-Log Micro-Insights → Streak Gamification → Health Alert Triggers → Smart Defaults. Two real bugs found and fixed during testing (not just happy-path checks). Wiped all test data mid-session for a clean slate going forward. All four confirmed live in production.**

### STEP 27B: Post-Log Micro-Insights — DONE
- Compares all 4 metrics (mobility, energy, appetite, cognitive) against last week, not just mobility — picks whichever metric moved the most and writes a varied sentence about it (3 phrasing variants per direction, plus a "held steady" case)
- Cognitive falls back to baseline score on weeks it isn't asked (only collected every 4th week)
- Removed data-platform language ("building real data") from consumer-facing copy per John's direction — this is a health journey for the owner, not a dataset contribution
- Tested: up/down/flat/graceful-skip-when-missing, confirmed live

### STEP 27C: Streak Gamification — DONE
- **Deliberately did NOT store `current_streak`** — it's calculated live from `mobility_checkins` (same logic dashboard already used), so there's nothing to get out of sync. Only `longest_streak` is stored (new column on `senior_dogs`), since that's a historical fact that can't be recomputed once a streak breaks
- Milestone messages at 2/4/8/12 weeks, "data" language scrubbed same as 27B
- 🔥 flame badge on confirmation screen (only shows above 1 week) and dashboard
- **Real bug found and fixed:** `/api/checkin-senior`'s `weekNumber` calculation had no floor, unlike the display page which already clamped to `Math.max(1, ...)`. A `created_at` slightly in the future (timezone quirk during manual test-data entry) produced `week_number: 0`, which then silently broke streak counting (the countdown loop assumed `maxWeek >= 1`). Fixed both the save endpoint and the streak-counting loop (in two places — the shared function and the dashboard's own copy) with defensive floors
- Tested: streak counting across consecutive weeks, badge display threshold, milestone trigger, and the week-0 edge case specifically, confirmed live

### STEP 27D: Health Alert Triggers (merged with P1E) — DONE
- Dashboard-only, no SMS (deliberate scope decision — the two source specs disagreed on this, resolved in favor of not touching SMS given the TCPA consent work from Aug 17-18)
- Fires on 2+ point swings in **either** direction (both decline and improvement, per John's call) — provisional threshold, no real user data yet to tune it
- 14-day de-dup, and **direction-aware** — a decline alert doesn't suppress a later improvement alert for the same metric, and vice versa (John's call: a recovery is worth surfacing even if a drop fired recently)
- Safe, non-diagnostic messaging following the project's compliance framework — never interprets what a change "means," always points to the vet
- **Real bug found and fixed:** de-dup was initially checking only `dog_id + metric`, not direction — meaning a decline alert would silently suppress a later improvement alert for 14 days. Added a `direction` column (follow-up migration, since the table already existed) and made the de-dup query direction-specific. Confirmed via temporary debug logging (added and then removed) that traced the exact diff/threshold/de-dup decision per metric
- Tested: both directions, de-dup blocking correctly, de-dup NOT blocking the opposite direction, confirmed live

### STEP P1B: Smart Defaults — DONE (smaller than originally scoped)
- Found that most of this already existed: energy/appetite already defaulted to last check-in's value on the standalone check-in page. Real gaps were: mobility hardcoded to `4` in the dashboard modal, cognitive hardcoded to `4` in both entry points, and the fallback-when-no-prior-checkin defaulted to a generic `4` instead of the dog's actual baseline score
- Decision: last check-in's value, not a 4-week rolling average (simpler, matches existing energy/appetite behavior, and the difference would usually be marginal on an 8-point scale)
- Fixed both check-in entry points (standalone `/check-in/:dog_id` page and the dashboard's inline modal) consistently
- Tested with a fresh dog with deliberately distinct per-metric baselines (5/6/7) to unambiguously confirm each slider reads its own field correctly, confirmed live

### Data cleanup — all test data wiped
- Deleted all rows from `health_alerts`, `mobility_checkins`, `sms_queue`, `magic_link_tokens`, `churn_flags`, `senior_dogs`, plus legacy tables (`survey_baselines`, `sms_preferences`, `pets`, `users`) — confirmed with John that zero real founding members existed yet (site still password-locked)
- Reason: accumulated test data (Max, streak_test) had a tangled history from repeated manual `created_at` edits across sessions, making further testing error-prone
- **Current state: all tables empty.** Next test dog should be created fresh.

### P1/27 checklist reconciliation (carried from earlier this session)
- STEP P1A retired — was a duplicate of STEP 27E (Contextual Logging Questions), never built
- STEP P1E retired — merged into STEP 27D (built, see above)
- P1B, P1C, P1D remain as originally scoped; P1C is blocked on real breed-cohort data (a "breed average" from 2-3 test dogs isn't meaningful) — flagged as a real dependency, not yet started

---

## ✅ COMPLETED (August 17-18): Check-In Expansion, SMS System Fix, First Production Deployment, Twilio A2P Submission, Full Email Migration

**Biggest session yet — the site went from "runs on John's PC only" to "live on the real internet at companioncommons.com," the Twilio A2P 10DLC campaign was submitted for approval, and every business account got migrated off a Gmail account that got locked mid-session. Details below; commits pushed to `origin/main` throughout.**

### Weekly check-in + baseline expanded to match what the Pet Health Library page promises
- Weekly check-in now collects mobility + energy + appetite every week (all required, 1-8 scale), plus cognitive/behavior every 4th week only (weeks 4, 8, 12 — calculated server-side from `dog.created_at`)
- Baseline form (`baseline-health-journey.html`) got matching energy/appetite/cognitive sliders so there's a baseline to compare weekly trends against
- Fixed a pre-existing bug: check-in UI and API text said "X/10" despite being a 1-8 scale — now consistently "/8" everywhere
- DB columns added via `migration_add_weekly_health_fields.sql` (run) — `senior_dogs`, `mobility_checkins`, and `magic_link_tokens` all got the 3 new score columns

### Fixed the weekly reminder SMS system — it was completely non-functional since inception
- Root cause: the reminder system queued `sms_queue` rows and joined against disconnected `users`/`pets` tables that the real `senior_dogs`-based signup flow never populated — every reminder silently failed with no phone number
- Fixed by adding `phone`/`email` directly to `senior_dogs` and `phone` to `sms_queue`, rewriting all queueing/sending logic to use these columns directly
- Every queued message now includes a real working check-in link (previously said "click the link" with no URL)
- **Known limitation, not yet addressed:** dogs created before this fix have no `phone` on their row and won't get reminders until re-verified or backfilled — not urgent while testing, flag before real users are live

### Fixed a real TCPA/SMS compliance gap
- `sms_consent` was captured on signup but never actually checked before sending reminder texts — anyone with a phone number got texted regardless of their checkbox choice
- Fixed: all reminder queueing (both the "queue next week" logic and the churn-detection cron) now gated on `dog.sms_consent === true`
- Migration `migration_add_sms_consent.sql` run — added `sms_consent BOOLEAN DEFAULT false` to `senior_dogs`

### Legal pages discovered to already exist (own earlier claim in project notes was wrong)
- `terms.html` and `privacy.html` were assumed missing per an old status doc — actually already existed, dated Aug 16, genuinely comprehensive (17 sections in Terms covering SMS, data, liability, etc.)
- Corrected course mid-session rather than shipping a duplicate/inferior Terms page
- Added footer links to both pages across all 9 other site pages (previously only reachable from `trust-and-data.html`) — `index.html`, `about.html`, `faqs.html`, `pet-health-library.html`, `public-insights.html`, `founding.html`, `dashboard.html`, `how-it-works.html`, `baseline-health-journey.html`
- Added SMS disclosure language next to the signup form's consent checkbox: "Msg & data rates may apply. Reply STOP to cancel, HELP for help." + link to Terms & Privacy
- **Note:** this work was done locally on Aug 17 but never actually pushed to GitHub — discovered and fixed Aug 18 (see Gmail migration section below, "found via git status")

### Built a sitewide "Coming Soon" password lock
- Controlled entirely by one environment variable, `SITE_PASSWORD` — set it and the whole site (every page, every form) shows a password screen instead; unset it and the site behaves 100% normally, no code changes needed either way
- `privacy.html`, `terms.html`, and site CSS/JS assets are specifically excluded from the lock — required, since Twilio's A2P 10DLC rules (updated June 30, 2026) mandate live, publicly-reachable-with-no-auth Privacy Policy/Terms URLs even while the rest of a pre-launch site stays private
- Twilio's own webhook endpoint (`/api/sms/webhook`) and the hosting platform's health check also bypass the lock, so delivery-status tracking and uptime monitoring keep working while locked

### Fixed the hardcoded LAN IP blocker (was flagged since Aug 16, now resolved)
- Every link sent to users (verify link, check-in link, dashboard link) was hardcoded to `http://192.168.1.19:3000` — only reachable on John's home wifi, meaning zero real users could ever have used a link from a text message
- Replaced all 7 occurrences with a `BASE_URL` environment variable — defaults to the old LAN IP locally, set to `https://companioncommons.com` in production

### First production deployment — live on Railway at companioncommons.com
- Deployed to Railway (connected via GitHub, auto-deploys on push)
- Fixed a Node.js version crash: `package.json` pinned Node 18, but Supabase's realtime client requires Node 22+ for native WebSocket support — bumped `engines.node` to `"22"`
- Fixed a folder-casing bug: code referenced `public` (lowercase) but the actual folder is `Public` (capital P) — invisible on Windows (case-insensitive), fatal on Railway's Linux containers (case-sensitive) — every page 404'd until fixed
- Domain `companioncommons.com` (owned via Porkbun, previously unpointed) now points at the Railway deployment via an ALIAS record (root CNAMEs aren't allowed, Porkbun's Cloudflare-backed DNS uses ALIAS instead) + a `_railway-verify` TXT record
- SSL certificate auto-issued by Railway, site confirmed loading at `https://companioncommons.com` with the password gate working correctly (locks everything except `privacy.html`/`terms.html`, exactly as designed)

### Twilio A2P 10DLC Campaign Registration — submitted
- Brand Registration: approved (Sole Proprietor, using SSN)
- Messaging Service created, phone number added as sender
- Campaign Registration: filled out completely and submitted (had to redo once after a Twilio session logout lost the in-progress form — second pass went fast since all answers were already finalized)
  - Terms/Privacy URLs now point to the real live domain (`https://companioncommons.com/terms.html` and `/privacy.html`), not a placeholder or file-hosting link
  - Message Flow description explicitly states all 4 required SMS disclosures (message type, frequency, rate disclaimer, opt-out) and explicitly states SMS consent is optional/unbundled from general signup — confirmed against the actual live form code that this is true, not just claimed
  - Opt-in evidence submitted as a screenshot (required since the real signup form is intentionally behind the password lock right now)
- **Now waiting on Twilio's review — typically days, sometimes longer. Nothing to do here but wait.**

### Gmail lockout → full business-account email migration (Aug 18)
- John's Gmail account (`companioncommons.com@gmail.com`) got locked/put under review mid-session, with no email verification access. Rather than wait, migrated everything off it to a new address, `companioncommons@gmail.com`.
- **Real bug found and fixed along the way:** the churn-detection cron's alert email (sent to a dog owner when they've gone quiet) had `ownerEmail` **hardcoded to the old Gmail address for every single dog** — every churn alert was going to one fixed test address regardless of who actually owned the dog. Comment in the code literally said `// TODO: Query users table for real owner email`. Fixed: added `email` to the churn cron's `senior_dogs` query (real column since the Aug 17 SMS fix, just wasn't selected here) and swapped in `dog.email`. Dogs with no email on file (pre-Aug-17 signups) now safely skip the alert instead of emailing the wrong address.
- Made the SendGrid "from" address a proper env var (`SENDGRID_FROM_EMAIL`, defaults to `companioncommons@gmail.com`) instead of a second hardcoded string — same pattern as `BASE_URL`/`SITE_PASSWORD`, so it can be changed from Railway's dashboard without a code change next time.
- SendGrid re-verified as Single Sender under the new address — confirmed working.
- Checked every connected business account for whether the old Gmail was its login/recovery email, one by one:
  - **GitHub** — was the actual risk, old Gmail was the primary email. Fixed (primary email updated; login method is username/password, not "Sign in with Google," so no OAuth exposure).
  - **Supabase** — updated for consistency; wasn't actually a risk since login was via GitHub OAuth (and GitHub's now fixed).
  - **Twilio** — both account login and Brand Registration business contact email were already on John's Outlook, never touched the old Gmail. Clean.
  - **Porkbun** (domain registrar) — confirmed clean.
  - **Railway** — connected via GitHub OAuth, so covered by the GitHub fix; not independently re-verified, low risk.
- Set up Porkbun free Email Forwarding: `hello@companioncommons.com` → `companioncommons@gmail.com`. This makes the contact promise in `terms.html`, `privacy.html`, and `governance.html` ("Email us at hello@companioncommons.com") actually real for the first time — that inbox never existed before. **Status as of Aug 18: forward is configured and shows active in Porkbun's dashboard, but a test email sent to confirm delivery hadn't landed after 30+ minutes — worth a follow-up check next session to make sure it's actually working, not just configured.**
- John's Gmail appeal has since resolved; since nothing depends on the old account anymore, no action needed either way.
- **Found via `git status` while doing this work:** a batch of real, finished changes from Aug 17 (the footer Terms/Privacy links across 9 pages, plus SMS disclosure text) had been made locally but never actually pushed to GitHub — meaning the live site was missing them despite the checklist marking that work complete. Pushed and deployed for real during this session.
- **Not affected by any of this:** the Google Sheets export feature uses a service-account key file (a robot credential), not a personal Gmail login — separate system, but broken for other reasons, see below. No Google Drive dependency exists anywhere in the codebase either — John's OneDrive use throughout this session was already the correct substitute.

### Google Sheets export — investigated, needs a real rebuild (flagged Aug 18, not started)
- John wants every weekly check-in/log to dump into a Google Sheet, under the new `companioncommons@gmail.com` account. Investigated the existing code to scope the work; found two separate problems, not one:
  1. **It only ever fires on signup.** There's exactly one call site for the export function in the whole codebase — new pet signups. Weekly check-ins/logs have never once exported, even back when the feature worked.
  2. **Its credentials aren't on Railway at all.** The code looks on disk for a Google service-account key file with "companioncommons" in the filename; `.gitignore` excludes all `.json` files, so that key file was never deployed. It's been silently skipping the whole feature in production the entire time — separate issue from the Gmail lockout, this one's just a deployment gap.
- **Plan for when we pick this up:** create a new Google Sheet under the new Gmail account, set up a Google Cloud service account with Sheets API access and share edit access to the sheet (John's manual Google Cloud Console steps, need walkthrough), paste the service-account key into Railway as an env var instead of a file on disk (same pattern as `BASE_URL`/`SENDGRID_FROM_EMAIL`), update the code to read from that env var, and add the missing export call into the check-in endpoint so logs actually flow in too.
- **Not started — explicitly banked for a later session per John, Aug 18.**

**Still open / carried forward:**
- Toll-free number + Toll-Free Verification as a faster alternative — mentioned early on, not pursued since long-code Campaign registration was already well underway; worth reconsidering only if Campaign review drags on
- ~~`/api/signup` and `/api/checkin` — both confirmed dead/orphaned legacy endpoints~~ — `/api/signup` **deleted Aug 19** as part of the Google Sheets rebuild. `/api/checkin` (plain, not `-senior`) is still there, still unused, still a candidate for deletion later.
- `Public/_to_delete/` — safe to delete manually, John's own task
- Backfilling `phone` on `senior_dogs` rows created before the SMS reminder fix (see above)
- Actual lawyer review of `terms.html`/`privacy.html` — still not done, flagged repeatedly, matters more now that the site is genuinely live
- ~~Google Sheets export rebuild~~ — **done Aug 19**, see dedicated section below

---

# 🎯 HYBRID LAUNCH ROADMAP OVERVIEW

## Timeline Summary
- **Weeks 1-2:** Web MVP launch (retention essentials only)
- **Weeks 3-7:** Parallel app build (minimal, retention-focused)
- **Week 8:** App launch + compare retention metrics
- **Weeks 9+:** Add engagement features to both platforms

## Phase Success Criteria
- **Phase 1 ✅:** Web launch with >65% Week 2 retention
- **Phase 2 ✅:** App built, no regressions in web retention
- **Phase 3 ✅:** App retention 15%+ higher than web (push notifications work)
- **Phase 4 ✅:** Week 12 retention reaches 70%+ target (engagement features added)

---

# PHASE 1: WEB MVP LAUNCH (Weeks 1-2)

## ✅ COMPLETED: Core Infrastructure

### Database Setup
- [x] **STEP 1:** Add senior_dogs table to Supabase ✅ COMPLETE
- [x] **STEP 2:** Add mobility_checkins table to Supabase ✅ COMPLETE
- [x] **STEP 3:** Add churn_flags table to Supabase ✅ COMPLETE

### Check-In Form
- [x] **STEP 4:** Create /check-in/:dog_id endpoint (form page) ✅ COMPLETE
- [x] **STEP 5:** Create POST /api/checkin-senior endpoint (save data) ✅ COMPLETE
- [x] **STEP 6:** Test check-in form with 3 test dogs ✅ COMPLETE

### Dashboard
- [x] **STEP 7:** Create GET /dashboard/:dog_id endpoint (metrics + Chart.js) ✅ COMPLETE
- [x] **STEP 8:** Test dashboard displays trends correctly with all 3 dogs ✅ COMPLETE

### SMS Reminders (Production-Ready)
- [x] **STEP 26A:** Implement three-tier SMS reminder system ✅ COMPLETE
- [x] **STEP 26B:** Fix database constraints ✅ COMPLETE
- [x] **STEP 26C:** Add error logging + verify functionality ✅ COMPLETE
- [x] **STEP 26D:** Set churn detection to production interval ✅ COMPLETE
- [x] **STEP 26F:** Dashboard Modal Check-In Flow ✅ COMPLETE
- [x] **STEP 26G:** Dashboard Styling Refinement ✅ COMPLETE
- [x] **STEP 26H:** Hero Community Visual Geometry ✅ COMPLETE
- [x] **(Aug 17)** Fixed reminder system's broken phone-number linkage — see completed section above ✅ COMPLETE
- [x] **(Aug 17)** Enforced `sms_consent` before sending any reminder — see completed section above ✅ COMPLETE

### Authentication (Production-Ready)
- [x] **STEP 19:** Create baseline survey form ✅ COMPLETE (renamed Aug 16 to `baseline-health-journey.html`; expanded Aug 17 with energy/appetite/cognitive fields)
- [x] **STEP 20:** Create /api/send-magic-link endpoint ✅ COMPLETE (expanded Aug 16 with weight/ZIP/diet/insurance/treatment fields, Aug 17 with energy/appetite/cognitive)
- [x] **STEP 21:** Create /verify route ✅ COMPLETE (Aug 16: fixed missing reminder-day/time columns; Aug 17: added phone/email/sms_consent storage)
- [x] **STEP 22:** Test magic link flow end-to-end ✅ COMPLETE
- [x] **STEP 25:** Create real /dashboard.html page ✅ COMPLETE

### Website Copy System (Production-Ready)
- [x] **WEBSITE COPY SYSTEM:** Created JSON-based copy management ✅ COMPLETE
- [x] **COPY CHANGES APPLIED:** Validated & deployed 7 JSON files ✅ COMPLETE

### Churn Detection (Production-Ready)
- [x] **STEP 9:** Set up SendGrid account (email) ✅ COMPLETE
- [x] **STEP 10:** Create churn-detection.js cron job ✅ COMPLETE
- [x] **STEP 11:** Test churn detection sends email alerts ✅ COMPLETE

---

## 🚨 PHASE 1: MUST COMPLETE BEFORE LAUNCH (Weeks 1-2)

### Web Launch Dependencies

**Database Tables (NEW):**
- [ ] **STEP L1:** Add smart_questions table (cache questions per user)
- [ ] **STEP L2:** Add smart_defaults table (typical scores per user)
- [ ] **STEP L3:** Add breed_aggregate_stats table (seed with initial data)
- [ ] **STEP L4:** Add content_rewards table (track breed guide unlocks)
- [ ] **STEP L5:** Add detected_patterns table (AI pattern alerts)
- [ ] **STEP L6:** Add sms_logs table (track sent/opened)
- [ ] **STEP L7:** Add email_logs table (track sent/opened)

**Core AI Features (L1, L5, L6, L7):**
> **RECONCILED Aug 18:** This P1 list and the STEP 27A-27F list below were two separate feature lists from two different planning sessions, with real overlap. Reconciled as follows — build off STEP 27's version in each duplicate pair; this P1 list is kept for the non-duplicate items (Smart Defaults, Comparative Feedback, Content Rewards) and cross-referenced where it overlaps.

- [ ] **STEP P1A:** ~~Implement L1 Smart Questions~~ **= STEP 27E (Contextual Logging Questions), same feature. Build under 27E, not here. Do not build twice.**

- [x] **STEP P1B:** Implement L5 Smart Defaults ✅ COMPLETE (Aug 18) — built as "last check-in's value" not a 4-week average (John's call: simpler, matches existing energy/appetite behavior, difference would be marginal on an 8-point scale anyway). Fixed hardcoded-4 fallbacks across both check-in entry points (standalone page + dashboard modal); fallback-with-no-prior-checkin now uses the dog's real baseline score instead of a generic 4.

- [ ] **STEP P1C:** Implement L6 Comparative Feedback — **blocked on real data.** Needs an actual breed cohort to be meaningful; a "breed average" computed from 2-3 test dogs isn't a real comparison. Revisit once real founding members are logging.
  - [ ] GET /api/compare-to-breed/{dog_id}
  - [ ] Return breed averages + percentile
  - [ ] Show on dashboard during/after logging
  - QA: Display breed context without medical claims

- [x] **STEP P1D:** Implement L7 Content Rewards ✅ COMPLETE (Aug 19) — built as a static 30-breed guide library (John's own weight-organized breed list), no AI generation, no database table for "unlocked" status (computed live from week number, same pattern as `current_streak`). Guide page shows the dog's own photo, breed history/temperament/senior health patterns, weight range, and the exact canonical vet disclaimer pulled from `terms.html`/`privacy.html`. Deliberately skipped cohort-comparison claims — no real breed data exists yet (same blocker as P1C). Deploy was delayed several hours by a genuine Railway platform outage, unrelated to the code — see full write-up in the Aug 18-19 session section.
  - [x] ~~Database schema for content_rewards~~ — not needed, unlock status computed live
  - [x] ~~POST /api/generate-content-reward~~ — not needed, static content, no generation step
  - [x] Breed guides built for all 30 breeds John specified, plus Mixed Breed and a generic fallback
  - [x] Display on dashboard when unlocked (Week 2+) ✅
  - QA: Locked/unlocked states tested, correct content per breed confirmed, fallback for uncovered breeds confirmed, confirmed live in production

- [x] **STEP P1E:** ~~Implement L3 Pattern Alerts~~ **= STEP 27D, merged and COMPLETE (Aug 18) — see full write-up at top of doc.**

---

## STEP P8: Full End-to-End Testing Pass ⏳ NOT YET STARTED

**Build Effort:** N/A — this is a verification pass, not a build.
**When:** Before beta recruiting begins. The last gate before real strangers touch the site.

**Why this is being formally scoped now:** STEP P8 was referenced across multiple sessions' NEXT STEP lists as "full end-to-end testing" but never actually given a task list, unlike every other STEP entry in this doc. Worth defining properly given what's shipped since the last full pass: the entire multi-dog owner architecture (Stages 1-5, see `Multi_Dog_Signup_Build.md`) and, most recently, the consent record, sitewide XSS sweep, and legacy schema removal (Aug 22, Session 2).

Note: there is an unrelated "FEATURE P8" elsewhere in this doc (Phase 4, Wave 3 — "Implement #8 Data Companion (chatbot)"). Different item, different numbering scheme, do not confuse the two.

Note: the self-service "resend my dashboard link" flow (`POST /api/resend-dashboard-link` + `find-my-dashboard.html`, Aug 22 Session 3) was already verified end-to-end during its own build — real phone normalization, real SMS/email sends confirmed, rate limiting confirmed against its actual threshold. This P8 pass doesn't need to re-treat it as untested ground, just confirm it still works alongside everything else shipped since.

**Note (Aug 23) — STEP P10's own Stage 6 verification already covers a real chunk of this list, against the new instrument specifically.** Not a formal P8 run (this was scoped to P10's own risk, not a general pre-beta QA gate), but the overlap is real and shouldn't be re-derived from scratch when P8 is actually run. Already verified live, with real data, per `Health_Instrument_Redesign_Build.md`'s Stage 6 write-up: the full signup flow (new owner + returning owner via Add Another Dog + `consent_given_at`), both check-in surfaces, a dog with real 2-week history (streak + trend, not mid-week notes), all 3 multi-dog items (combined check-ins page, switcher with/without session), and breed guide across 2 breeds (not the locked state). **Genuinely still open, not covered by any pass yet**: Journey Summary print-to-PDF (this project's local tooling can't drive a native print dialog — needs your own direct testing, same as every prior print verification here), mid-week notes display, and the whole Communications section (reminder SMS, churn alert email).

**Tasks:**

Signup flow:
- [ ] New owner, first dog — full path: /api/send-magic-link → email received → /verify → dashboard
- [ ] Returning owner, second dog via "Add Another Dog" — same phone number, confirm no duplicate signup, consent checkbox, or verification text
- [ ] Confirm `consent_given_at` is actually populated on both paths — spot-check the real row in Supabase, don't just trust the code path

Check-in flow:
- [ ] Standalone check-in page (/check-in/:dog_id)
- [ ] Dashboard check-in modal
- [ ] A dog with real multi-week history (not a fresh signup) — confirm streak, trend, and mid-week notes all display correctly

Multi-dog specific:
- [ ] Combined /checkins/:owner_id page for a real two-dog owner — correct status per dog, correct action link per state
- [ ] Dashboard dog-switcher appears correctly for the owner's own session
- [ ] Dashboard dog-switcher does NOT appear when the same dashboard link is opened with no session — confirms vet/family sharing links still work unaffected

Journey Summary:
- [ ] View on-screen, on a dog with several weeks of check-ins and at least one note
- [ ] Print to PDF — confirm chart appears, no page-break/duplicate-page issues, note text renders as safe escaped text

Breed guide:
- [ ] View for at least 2-3 different breeds, confirm correct locked/unlocked state by week number

Communications — confirm received on a real phone/inbox, not just server logs:
- [ ] Signup confirmation SMS/email
- [ ] Check-in confirmation
- [ ] At least one reminder (or manually trigger via the test endpoint)
- [ ] Churn alert email, triggered manually via the safe test endpoint (sends to SENDGRID_FROM_EMAIL only)

Cleanup:
- [ ] Delete all test data created during this pass — senior_dogs, owners, mobility_checkins, health_alerts, churn_flags, dog_notes, sms_queue, magic_link_tokens rows, plus the Dog_Photos storage folder. Same pattern as every prior test-data wipe this project.

**QA Checklist:**
- [ ] No console errors on any page tested
- [ ] No 500s on any route tested
- [ ] Any real bug found gets fixed before beta recruiting begins, not deferred to "later"

---

## STEP P10: Health Check-In Instrument Redesign (Build) ✅ COMPLETE (Aug 23)

**🚨 PRE-BETA BLOCKER — sequenced BEFORE STEP P8 and before beta recruiting, not alongside them.** The real reasoning: the database is currently empty, and this is the last point where the check-in instrument itself can change without migrating or fragmenting real participant data. Once real dogs are logging against the old instrument, changing item structure means either a messy mid-study format switch or living with the weaker old instrument for that cohort's entire logging history.

**Full spec:** `CompanionCommons_Health_Instrument_Design.md` — the complete design rationale, literature grounding, locked item-by-item instrument, and downstream code dependencies all live there. Not duplicated here.

**What this build covers, at a high level** (see the dedicated doc's "Downstream dependencies" section for the full list):
- New check-in form fields for all 4 domains — Mobility Impact Score and Cognitive Impact Score each become 4-item composites (0-10 per item); Energy and Appetite move from the old 1-8 scale to a single 0-10 item each
- Composite scoring logic (average of items per domain)
- A schema migration to store item-level data, not just one score per domain
- Dashboard, Journey Summary, and breed guide "current status" displays updated to the new composite structure — all three currently reference the old single-score fields

**STEP P8 (Full End-to-End Testing) needs to be re-run against this new instrument once it's built** — P8's existing scope was written against the old single-slider design and doesn't yet reflect this.

**All 6 stages complete — full build tracked in `Health_Instrument_Redesign_Build.md`.** Schema + shared helpers, signup surfaces, check-in surfaces, dashboard/Journey Summary/breed-guide display logic + sign-convention flip (split into 4a insight/alert-logic and 4b dashboard-display given its size), Google Sheets headers, and a real verification pass covering signup, check-in (single and multi-week), multi-dog ownership, resend-dashboard-link, dashboard, Journey Summary, and breed guide. Both migrations run against real Supabase. Two real bugs found and fixed along the way, neither part of the original plan: a pre-existing legacy DB constraint (`mobility_check`) still enforcing the old 1-8 range, found via the first real post-migration signup; and a falsy-zero bug in the peer-comparison card's `latestPerDog` tracking, found during Stage 4b's own review. **Manual follow-up still needed from John**: add "(0-10)" to the 8 score column headers on the live Google Sheet (code only updates a freshly-created tab, not the existing one).

---

**SMS Optimization:**
- [ ] **STEP P2:** Optimize SMS reminder copy (personalized, compelling)
  - [ ] Test 2 subject lines (measure click rate)
  - [ ] Template: "Hey [name]! How's [dog_name] doing this week? [Log Now]"
  - QA: SMS sends to right phone, links work

**Email Optimization:**
- [ ] **STEP P3:** Implement L9 Weekly Digest Email
  - [ ] Cron job runs Sunday 7pm
  - [ ] Format: Dog's data, user's observations, breed context
  - [ ] Include vet talking points
  - [ ] Test with 3 test dogs
  - QA: Email displays correctly in Gmail/Outlook/mobile

**Frontend Updates:**
- [ ] **STEP P4:** Update logging form
  - [ ] Display L1 smart questions instead of generic sliders
  - [ ] Pre-fill with L5 smart defaults
  - [ ] Mobile responsive (priority: works on 375px+)
  - [ ] Test on iPhone SE, Android
  - QA: Form loads, submits, displays on mobile

- [ ] **STEP P5:** Add post-log insights display
  - [ ] Show L6 breed comparison immediately after log
  - [ ] Show L7 content reward unlock ("You earned a breed guide!")
  - [ ] Show L3 pattern alert if detected
  - [ ] Mobile responsive
  - QA: All insights display, no layout breaks

- [ ] **STEP P6:** Create breed guide viewer
  - [ ] Display PDF or HTML guides
  - [ ] Test on mobile and desktop
  - [ ] "Share with vet" button (tracks if shared)
  - QA: Guides display, sharable, downloadable

**Legal Review (MUST BEFORE LAUNCH):**
- [x] **STEP P7A:** Write/review Terms of Service (includes "not a vet") ✅ COMPLETE (discovered Aug 17 to already exist, comprehensive — see completed section above)
- [x] **STEP P7B:** Write/review Privacy Policy (data handling, anonymization) ✅ COMPLETE (same discovery)
- [x] **STEP P7C:** Write customer-facing disclaimers (prominent, clear) ✅ COMPLETE (SMS disclosure added to signup form Aug 17)
- [ ] **STEP P7D:** Lawyer review (have actual lawyer sign off) — **still not done, matters more now that the site is genuinely live**
- [x] **STEP P7E:** Post legal pages on website ✅ COMPLETE (footer links added across all 9 pages Aug 17, actually deployed Aug 18)

**Testing:**
- [ ] **STEP P8:** ~~End-to-end flow testing~~ **this thin, pre-multi-dog-architecture task list is stale — see the real `## STEP P8` section above for the current, actually-scoped spec. Do not build against this one.**

**Deployment:**
- [x] **STEP P9:** Deploy to production ✅ MOSTLY COMPLETE (Aug 17-18)
  - [x] Backend to Railway ✅ COMPLETE (frontend is served by the same Express app, no separate Vercel deploy needed)
  - [x] Environment variables set correctly ✅ COMPLETE (includes the `BASE_URL` fix, resolving the Aug 16 hardcoded-LAN-IP blocker)
  - [ ] Database backups configured — not yet confirmed
  - [ ] Error logging working (Sentry or console) — currently just Railway's console logs, no dedicated error tracking yet
  - QA: Production URL responds, no 500 errors — ✅ confirmed working at companioncommons.com, currently intentionally behind a password lock (see completed section above)

---

## PHASE 1 LAUNCH CRITERIA ✅

**DO NOT LAUNCH unless ALL are true:**
- [ ] Dashboard loads in <3 seconds (mobile)
- [ ] Logging form submits without errors (10x tested)
- [ ] SMS sends and opens (tested with real phone — **blocked until Twilio A2P 10DLC Campaign registration is approved; submitted Aug 18, awaiting review**)
- [ ] Email sends and displays correctly (Gmail, Outlook, mobile)
- [ ] Smart questions load (<2 seconds)
- [ ] Breed guides display (PDF + HTML)
- [ ] Database backups working
- [ ] No unhandled errors in logs
- [x] Legal review completed — **pages exist and are comprehensive, but still need actual lawyer sign-off (see STEP P7D)**
- [x] Privacy policy + TOS posted ✅ COMPLETE

**If any fails: Delay 3-5 days. Don't launch broken.**

---

## PHASE 1 EXPECTED METRICS (Weeks 1-2)

### Launch Day (Monday)
- 50-100 sign-ups (if you have email list)
- 30-50 baselines completed (60% conversion)
- 10-20 first logs (20% logging same day)

### Week 1 (Mon-Sun)
- Total sign-ups: 100-150
- Week 1 logging rate: 65-75%
- SMS open rate: 35-45%
- Email open rate: 20-30%
- Week 1 retention (Mon→Sun): >65%

### Week 2 (Mon-Sun)
- **CRITICAL METRIC:** Week 2 retention (Mon→Mon) = target >65%
- If <50%: Diagnose problem (form too complex? SMS not compelling? No value?)
- If >65%: GREEN FLAG → Proceed to Phase 2

---

## PHASE 1 SUCCESS DECISION POINT (End of Week 2)

### PROCEED TO PHASE 2 IF:
- ✅ Week 2 retention >65%
- ✅ SMS click rate >35%
- ✅ No critical bugs
- ✅ Users logging consistently

### PIVOT IF:
- ❌ Week 2 retention <50%
- ❌ SMS click rate <20%
- ❌ Critical bugs blocking logging
- ❌ Logging completion <40%

**If pivoting:** Diagnose before Phase 2:
- Is form too complicated? (simplify for mobile)
- Is SMS copy not compelling? (rewrite)
- Is logging value not clear? (add immediate insight)
- Is SMS timing wrong? (test different times)

---

# PHASE 2: PARALLEL APP BUILD (Weeks 3-7)

> ## ⚠️ SUPERSEDED (Aug 23, 2026) — this section's plan is not the current plan
>
> The parallel-native-build plan below (React Native + Expo, weeks 3-7, launching by week 8, deciding between web/app via a retention A/B comparison) is **not what's happening this beta.** Kept below for reference only — the tech-stack notes and QA checklist structure may still be useful later — but do not build against it as written.
>
> **The actual decision, made Aug 23, 2026:** a PWA layer (manifest, service worker, push notifications, install prompt) layered onto the existing web app, scoped for **mid-beta, roughly weeks 4-6**, once initial beta churn settles. No native build during this beta, and no retention A/B test deciding whether to go native. Native iOS/Android apps are deferred to a later, separate **Petwella** phase — decided explicitly and separately from this beta's retention numbers, not pulled forward and not decided by default. See the NEXT STEP list above for the current, standing pointer to this decision.

## 🎯 Minimal App Strategy

**Philosophy:** Build ONLY what drives retention. Everything else stays on web or waits.

**What App Does:**
- Native login/signup (same as web)
- Logging form (reuse smart questions + defaults from web)
- Push notification handling (Sunday evening)
- View weekly digest
- Settings (toggle push, toggle SMS)

**What App Does NOT (save for later):**
- Community feed
- Challenges/leaderboards
- Data Companion chatbot
- User profiles
- Social sharing

**Expected Retention Impact:**
- Web: 65% Week 2 retention
- App: 78% Week 2 retention
- Difference: 13% lift from push notifications + app habit

---

## PHASE 2: APP BUILD CHECKLIST

### Tech Stack Confirmation
- [ ] Frontend: React Native + Expo (for speed)
- [ ] Backend: Same Node/Express (reuse /api endpoints)
- [ ] Database: Supabase (same as web)
- [ ] Push: Expo push notifications
- [ ] Analytics: Supabase events table

### Weeks 3-4: Setup + Login
- [ ] **APP P1:** Expo project initialization
- [ ] **APP P2:** Login/signup screens (reuse web auth logic)
- [ ] **APP P3:** Baseline survey (if first time)
- [ ] **APP P4:** Test on iOS simulator + Android emulator
- [ ] **APP P5:** Deploy to Expo Go for testing on real phone

### Weeks 4-5: Logging Flow
- [ ] **APP P6:** Logging form screen
  - [ ] Load L1 smart questions from backend
  - [ ] Pre-fill L5 smart defaults
  - [ ] Submit saves to Supabase
  - [ ] Test on real device
  
- [ ] **APP P7:** Post-log insights screen
  - [ ] Display L3 pattern alerts
  - [ ] Display L6 breed comparison
  - [ ] Display L7 reward unlock
  - [ ] Test layout on various screen sizes

- [ ] **APP P8:** Navigation between screens
- [ ] **APP P9:** Handle offline gracefully (queue log if no connection)

### Weeks 5-6: Push Notifications + Digest
- [ ] **APP P10:** Request push permission (iOS + Android)
- [ ] **APP P11:** Receive push notifications from backend
- [ ] **APP P12:** Push notification click → opens app + specific screen
- [ ] **APP P13:** Weekly digest screen (display digests)
- [ ] **APP P14:** Settings screen (toggle push, toggle SMS)
- [ ] **APP P15:** Test on real iOS/Android device
- [ ] **APP P16:** Test push notifications at different times

### Weeks 6-7: Polish + Testing
- [ ] **APP P17:** Mobile responsiveness (test SE, Plus, Pro, Android)
- [ ] **APP P18:** Error handling (network down, API timeout, auth fail)
- [ ] **APP P19:** Performance (app loads <2 seconds)
- [ ] **APP P20:** Analytics events (login, log, view digest, push clicked)
- [ ] **APP P21:** App icon + splash screen
- [ ] **APP P22:** Final bug fixes
- [ ] **APP P23:** QA sign-off (zero unhandled errors)

### Backend Changes (Parallel)

**Weeks 4-5: Push Infrastructure**
- [ ] **BACKEND P1:** Endpoint to store Expo push tokens
  - [ ] POST /api/register-push-token
  - [ ] Store: user_id, push_token, platform (iOS/Android)
  
- [ ] **BACKEND P2:** Endpoint to send push notifications
  - [ ] POST /api/send-push
  - [ ] Send to specific user or batch

**Weeks 5-6: Push Scheduling**
- [ ] **BACKEND P3:** Push notification job (runs Sunday 6pm)
  - [ ] Send: "See [Dog]'s weekly digest"
  - [ ] Link opens app to digest view
  
- [ ] **BACKEND P4:** SMS reminder job (Monday 2pm, Thursday 5pm)
  - [ ] Only send if push enabled (avoid duplication)
  - [ ] Or run both (test which is better)

**Weeks 6-7: Analytics**
- [ ] **BACKEND P5:** Track push notification sends
- [ ] **BACKEND P6:** Track push opens/clicks
- [ ] **BACKEND P7:** Track app screen views
- [ ] **BACKEND P8:** Track logging source (web vs app)

---

## PHASE 2 QA CHECKLIST

### Functional
- [ ] Login works (new user + returning)
- [ ] Baseline survey saves
- [ ] Logging form pre-fills (smart defaults work)
- [ ] Smart questions load (<2 seconds)
- [ ] Post-log insights show (patterns, comparisons, rewards)
- [ ] Digest loads (view old digests)
- [ ] Push notification received (real device)
- [ ] Push notification click opens app to digest
- [ ] Settings save (toggles persist after restart)

### Performance
- [ ] App launches in <3 seconds (real device)
- [ ] Form submits in <2 seconds
- [ ] No lag when scrolling
- [ ] No memory leaks (restart 10x, memory stable)

### Compatibility
- [ ] iOS 14+ (latest 2 versions)
- [ ] Android 10+ (latest 2 versions)
- [ ] Various screen sizes (SE, Plus, Pro, Android small/large)

### Errors
- [ ] No unhandled exceptions
- [ ] Network timeout handled
- [ ] OpenAI API failure handled (fallback)
- [ ] Auth failure handled (log out gracefully)

---

## PHASE 2 SUCCESS DECISION POINT (Week 8)

### App Readiness for Launch
- [ ] Zero critical bugs
- [ ] Push notifications working on real iOS + Android
- [ ] Performance acceptable (<3 sec launch)
- [ ] No crashes during 1-hour usage test

### If any of above fail:
- Fix before proceeding
- Delay Phase 3 by 1 week if necessary

---

# PHASE 3: APP LAUNCH (Week 8)

## Week 8a: Internal Testing (Days 1-2)

- [ ] **APP LAUNCH P1:** You + 2-3 beta users test on real phones
- [ ] **APP LAUNCH P2:** Report bugs
- [ ] **APP LAUNCH P3:** Fix critical bugs only
- [ ] **APP LAUNCH P4:** OK to have minor issues (can fix in Week 9)

## Week 8b: Cohort Rollout (Days 3-7)

- [ ] **APP LAUNCH P5:** Email existing web users
  ```
  "We built a native app! Install it for better experience.
   iOS: [TestFlight link]
   Android: [APK link or Google Play beta]"
  ```
  - Target: 50% of web users (50-75 people)

- [ ] **APP LAUNCH P6:** Monitor retention of app cohort
  - [ ] Compare Week 2 retention: web vs app
  - [ ] Track push notification open rates
  - [ ] Fix any bugs reported

## Week 8 End: Make Decision

### Compare Metrics

**WEB COHORT (Weeks 1-8):**
- Week 2 retention: 65-70%?
- Logging frequency: 1-2x per week?
- SMS open rate: 40-50%?

**APP COHORT (Week 8):**
- Push open rate: 60-70%? (should be higher than SMS)
- Week 2 retention: 75-80%? (should be higher)
- Daily active users: Higher or lower than web?

### Decision Framework

| Metric | Decision | Next Step |
|--------|----------|-----------|
| App retention 15%+ higher | ✅ PROCEED | Full launch, plan app store |
| App retention 10-15% higher | ⚠️ PROCEED CAUTIOUSLY | Watch Week 3-4 data, fix engagement |
| App retention <10% higher | ❓ INVESTIGATE | Something else matters (engagement features?) |
| App has critical bugs | ❌ DELAY | Fix before scaling |

---

# PHASE 4: SCALE & ADD FEATURES (Weeks 9+)

## Feature Rollout Priority (App + Web)

### Wave 1 (Weeks 9-10): Retention Anchors
- [ ] **FEATURE P1:** Implement L4 AI Streak Predictions (dashboard display)
- [ ] **FEATURE P2:** Implement L7 Tier 2 Content Rewards (Week 4 health insights)
- [ ] **FEATURE P3:** Improve breed guide designs (more visually appealing)

### Wave 2 (Weeks 11-12): Engagement
- [ ] **FEATURE P4:** Implement #11 Weekly Challenges (leaderboards)
- [ ] **FEATURE P5:** Improve #9 Weekly Digest
- [ ] **FEATURE P6:** Add community forum (web first, link from app)

### Wave 3 (Weeks 13-15): Full Features
- [ ] **FEATURE P7:** Implement #10 Community (full with moderation)
- [ ] **FEATURE P8:** Implement #8 Data Companion (chatbot)
- [ ] **FEATURE P9:** Implement L7 Tier 3 Expert guides (Week 8 unlock)
- [ ] **FEATURE P10:** Implement L2 Voice logging (app only)

### Wave 4 (Weeks 16+): Polish
- [ ] **FEATURE P11:** Wearables integration (prep)
- [ ] **FEATURE P12:** Analytics dashboard (for you to track)
- [ ] **FEATURE P13:** Admin tools (user management)
- [ ] **FEATURE P14:** Referral system (if retention strong)

---

# 🚨 AI LOGGING RETENTION SYSTEM (FEATURES #1-6)

**Timeline:** Build in Phase 1 (before web launch)  
**Build Effort:** 20-25 hours total  
**Status:** 🔄 PLANNED (Implement STEPS 27A-27F)

## BUILD ORDER (Aug 18 revision)
Reordered from a straight cheapest-first pass to lead with the feature that gives logging itself immediate payoff, before layering gamification on top of it:

1. **STEP 27B — Post-Log Micro-Insights** (build first). Makes logging feel like it did something from the very first repeat log. This is the actual retention lever; everything else is a wrapper around it.
2. **STEP 27C — Streak Gamification** (build second). Only worth showing off once there's something underneath it — do this after Micro-Insights, not before.
3. **STEP 27D — Health Alert Triggers** (build third, dashboard-only per the P1E/27D reconciliation above). The real differentiator, but needs 2+ weeks of data and touches health-adjacent territory, so it's last and deliberately scoped down (no SMS, thresholds treated as provisional guesses until real founding-member data exists to tune them — see QA note below).

27A, 27E, 27F remain useful but are not part of this three-feature push; sequence them after 27D or fold in opportunistically.

---

## STEP 27A: AI Predictive Logging Timing ⏳ PHASE 1
**Build Effort:** 5-6 hours  
**When:** Week 1-2 (before launch)

**Tasks:**
- [ ] Create `logging_pattern` JSONB column in users table
- [ ] Add `submission_hour` INT column to check_ins table
- [ ] Write `calculateLoggingPattern()` function
- [ ] Create weekly cron job: `updateLoggingPatternsForAllUsers()`
- [ ] Modify Twilio SMS logic: Check user's logging window before sending
- [ ] Test with 3 test dogs
- [ ] Deploy to GitHub

**QA Checklist:**
- [ ] User with pattern (Wed-Fri 8-9am) receives reminder ONLY those times
- [ ] User without pattern (< 2 logs) falls back to fixed 2pm
- [ ] Pattern updates when user changes habits
- [ ] Confidence score reflects pattern reliability
- [ ] No reminders sent with confidence < 0.5

---

## STEP 27B: Immediate Post-Log Micro-Insights ✅ COMPLETE (Aug 18)
**Actual approach:** No separate `/api/generate-insight` endpoint — generated inline within `/api/checkin-senior`'s existing response instead (simpler, no extra round trip, reuses the `change_text` field that already existed from an earlier, more primitive version of this same idea).

**Tasks:**
- [x] Create insight template library (3 variants per direction, plus a flat/steady case — not 15-20, but enough for real variety) ✅
- [x] Create `generatePostLogInsight()` function ✅ (named differently than spec'd `generateInsight()`)
- [x] ~~Create `/api/generate-insight` POST endpoint~~ — not built, folded into existing check-in response instead
- [x] Confirmation screen displays insight (not a separate modal — same screen as the existing "Check-In Submitted!" message) ✅
- [x] Test with test dogs ✅
- [ ] ~~A/B test~~ — not applicable, no real users yet

**QA Checklist:**
- [x] Insight appears immediately after form submission ✅
- [x] Insight references dog's name correctly ✅
- [x] Insight references score change correctly — and picks whichever of the 4 metrics moved MOST, not always mobility ✅
- [x] Displays well (tested on desktop; mobile not separately verified this session)

---

## STEP 27C: AI Logging Streak Gamification ✅ COMPLETE (Aug 18)
**Actual approach (John's call, to minimize bug surface):** Only `longest_streak` is a stored column. `current_streak` is deliberately calculated live from `mobility_checkins` every time — same logic the dashboard already had — so there's no second source of truth that can drift out of sync.

**Tasks:**
- [x] Add database columns: ~~current_streak,~~ longest_streak ✅ (current_streak intentionally NOT stored, see above)
- [x] Create streak calculation (shared function used by both the check-in endpoint and the dashboard, so they can't disagree) ✅
- [x] Create streak milestone messages (2/4/8/12 weeks) ✅
- [x] Streak badge on confirmation screen (🔥, only shows above 1 week) + dashboard ("Current Streak" / "Best Streak") ✅
- [x] Test with test dogs ✅

**QA Checklist:**
- [x] Streak counter displays correctly ✅
- [x] Milestone message changes at correct thresholds ✅
- [x] Badge shows/hides correctly ✅
- [x] Streak resets properly if user misses week ✅ (tested via the week-0 bug investigation, see below)
- [ ] Mobile styling not separately verified this session

**Real bug found and fixed:** `/api/checkin-senior`'s `weekNumber` calculation had no floor at 1, unlike the check-in *display* page which already used `Math.max(1, ...)`. A `created_at` slightly in the future (timezone conversion quirk when manually setting test data in Supabase) produced `week_number: 0` on save. The streak-counting loop (`for (let i = maxWeek; i >= 1; i--)`) assumed `maxWeek >= 1` — when it was 0, the loop never executed at all, silently reporting streak 0 even though a real check-in existed. Fixed both: added the same `Math.max(1, ...)` floor to the save endpoint, and added a defensive floor to the streak-counting loop itself (in both places it's duplicated — the shared function and the dashboard's separate copy) so a stray bad week_number can't zero out a streak in the future either.

---

## STEP 27D: AI Health Alert Triggers (= merged with P1E, Pattern Alerts) ✅ COMPLETE (Aug 18)
**Build Effort:** 4-5 hours  
**Scope decision (Aug 18):** Dashboard-only, no SMS. The two source specs for this feature disagreed — resolved in favor of not touching SMS. You just closed a real TCPA gap this session (consent wasn't gated before sending reminders); adding a new SMS trigger type here means re-auditing consent logic again for a "nice to have." Not worth it yet.
**Additional scope decision (Aug 18):** Fires on BOTH directions (decline AND improvement), not declines-only as originally proposed — John's call. Detection happens at check-in submission time, not via a separate weekly cron — consistent with 27B/27C, one less async system to keep in sync.

**Tasks:**
- [x] Create `health_alerts` table (with a `direction` column added via follow-up migration — see bug note below) ✅
- [x] Create `detectHealthAlerts()` function ✅
- [x] Create alert message templates (non-diagnostic, "mention to your vet" framing per compliance docs) ✅
- [x] Create spam prevention (14-day de-dup, direction-aware — see bug note below) ✅
- [x] ~~Create weekly cron job~~ — not built, detection happens inline at check-in submission instead (see scope decision above)
- [x] Create dashboard banner component (orange "⚠️ Worth a look" banner, shows most recent active alert) ✅
- [x] Test with test dogs ✅
- [x] ~~Alert SMS~~ — explicitly out of scope, not built

**QA Checklist:**
- [x] Alert only triggers when thresholds met ✅
- [x] Alert doesn't display twice within 14 days for the same metric+direction ✅
- [x] Dashboard banner appears when alert active ✅
- [x] **Thresholds (2+ points) are placeholders, not tuned values — no real user data exists yet. Revisit after 2-3 weeks of real founding-member logs.**

**Real bug found and fixed:** de-dup was initially keyed on `dog_id + metric` only, not direction. That meant a decline alert would silently suppress a later improvement alert for the same metric for 14 days (and vice versa) — a real problem, since a recovery is exactly the kind of thing worth surfacing even if a decline fired recently. Added a `direction` column (the original table had already been created without it, so this required a follow-up migration rather than editing the first one), made the de-dup query direction-specific. Confirmed the fix with temporary debug logging (added, used to trace the exact diff/threshold/de-dup decision per metric across several test submissions, then removed before shipping).

---

## STEP 27E: AI Contextual Logging Questions ⏳ PHASE 1
**Build Effort:** 2-3 hours  
**When:** Week 1-2 (before launch)

**Tasks:**
- [ ] Add `user_notes` TEXT column to check_ins table
- [ ] Create contextual question templates
- [ ] Create `generateContextualQuestion()` function
- [ ] Add optional textarea below score slider
- [ ] Test with 3 test dogs

**QA Checklist:**
- [ ] Contextual question changes based on score direction
- [ ] Question references dog's name correctly
- [ ] Notes field is optional (no friction)
- [ ] Notes stored correctly in database

---

## STEP 27F: AI Accountability Messaging ⏳ PHASE 1
**Build Effort:** 2-3 hours  
**When:** Week 1-2 (before launch)

**Tasks:**
- [ ] Create `calculateLoggingPattern()` function (4-week rolling average)
- [ ] Create mid-week accountability message logic
- [ ] Create message templates (ahead, behind, on pace, struggling)
- [ ] Create weekly cron job: `sendMidWeekAccountability()` (Wednesday)
- [ ] Test with 3 test dogs

**QA Checklist:**
- [ ] Message selects correct template based on pace
- [ ] Projection calculation is accurate
- [ ] Message sends at right time
- [ ] Positive framing only (no guilt)

---

# 🟠 AI ENGAGEMENT SYSTEM (FEATURES #8-11)

**Timeline:** Build in Phase 4 (after proving retention)  
**Build Effort:** 17-22 hours total  
**Status:** 🔄 PLANNED (Implement STEPS 28A-28D after Phase 3)

**Legal Framework:** DATA PLATFORM, not medical provider. Every feature includes disclaimers, never makes medical claims, always directs to vet.

---

## STEP 28A: AI Data Companion ⏳ PHASE 4 (Week 10+)
**Build Effort:** 4-5 hours

- [ ] Create `companion_questions` table
- [ ] Create `/api/companion-question` POST endpoint
- [ ] Implement legal-safe response logic
- [ ] Create frontend modal
- [ ] Test with 3 test dogs

---

## STEP 28B: Weekly Data Digest ⏳ PHASE 4 (Week 10+)
**Build Effort:** 4-5 hours

- [ ] Create `weekly_digests` table
- [ ] Create `generateWeeklyDigest()` function
- [ ] Create weekly cron job
- [ ] Create email template
- [ ] Create in-app notification
- [ ] Test digest generation

---

## STEP 28C: Breed Community ⏳ PHASE 4 (Week 11+)
**Build Effort:** 6-8 hours

- [ ] Create community tables (posts, replies, moderation_log)
- [ ] Implement moderation AI (OpenAI)
- [ ] Create `/api/community/post` endpoint
- [ ] Create community UI
- [ ] Create community guidelines
- [ ] Test moderation

---

## STEP 28D: Weekly Challenges ⏳ PHASE 4 (Week 11+)
**Build Effort:** 3-4 hours

- [ ] Create challenge tables
- [ ] Implement legal-safe challenges
- [ ] Create leaderboard UI
- [ ] Create badge/reward system
- [ ] Test with 3 test dogs

---

# SUCCESS METRICS BY PHASE

## Phase 1: Web Launch (Weeks 1-2)
```
GOAL: Prove logging works
✅ Success: >100 sign-ups, >65% Week 2 retention, <5% Week 1 churn
❌ Failure: <50 sign-ups, <50% retention, >20% Week 1 churn
```

## Phase 2: App Build (Weeks 3-7)
```
GOAL: Build without breaking web
✅ Success: App builds, no regressions in web retention
❌ Failure: App bugs block launch, or web retention drops
```

## Phase 3: App Launch (Week 8)
```
GOAL: Prove push notifications improve retention
✅ Success: App cohort Week 2 retention 75%+ (vs web 65%)
❌ Failure: App retention same as web (means push didn't matter)
```

## Phase 4: Scale (Weeks 9+)
```
GOAL: 12-week retention reaches 70%+ target
✅ Success: Week 12 retention 70%+ (combined app + web)
❌ Failure: Week 12 retention <50% (engagement features didn't drive it)
```

---

# PRE-LAUNCH CHECKLIST

Before Week 1 begins, confirm:

### Infrastructure
- [x] Supabase project initialized (auth, database) ✅ COMPLETE
- [ ] Twilio account ready (SMS sending) — **paid account, A2P 10DLC Campaign registration submitted Aug 18, awaiting Twilio's review before real SMS can send to arbitrary numbers**
- [x] SendGrid account ready (email) ✅ COMPLETE (re-verified under new sender address Aug 18)
- [ ] OpenAI API key ready (smart questions, etc) — not yet needed, tied to unbuilt AI features
- [x] Hosting plan ✅ COMPLETE (Railway, live at companioncommons.com — no separate frontend host needed, Express serves everything)
- [ ] Database backups configured — not yet confirmed
- [ ] Error logging (Sentry or console) — currently just Railway's console logs

### Product
- [ ] Design/branding finalized (colors, logo, fonts)
- [x] Domain registered for web ✅ COMPLETE (companioncommons.com, owned via Porkbun, now pointed and live)
- [x] Privacy policy written ✅ COMPLETE (comprehensive, exists — lawyer review still pending)
- [x] TOS written ✅ COMPLETE (comprehensive, exists — lawyer review still pending)
- [x] Customer-facing disclaimers written ✅ COMPLETE (SMS disclosure on signup form, veterinary disclaimer in footer — lawyer review still pending)
- [ ] Launch email list built (100+ people?)

### Team
- [ ] Decision: You code or hire? (or both?) — currently hybrid: John + AI-assisted coding
- [ ] Do you have a backend dev? (essential)
- [ ] Timeline confirmed: Can you commit 20-30 hrs/week for 8 weeks?
- [ ] Who's supporting early users? (critical for Phase 1)

### Known Blockers
- ✅ ~~Hardcoded LAN IP~~ — **RESOLVED Aug 17-18**, now uses `BASE_URL` env var
- ✅ ~~Twilio trial account~~ — **RESOLVED Aug 16**, upgraded to paid
- ✅ ~~Churn alert emails hardcoded to one Gmail test address~~ — **RESOLVED Aug 18**, now uses the real dog owner's `email` from `senior_dogs`
- ✅ ~~John locked out of Gmail, business accounts tied to it~~ — **RESOLVED Aug 18**: migrated to `companioncommons@gmail.com` (SendGrid re-verified, GitHub primary email updated, Supabase updated, Twilio/Porkbun confirmed already clean); `hello@companioncommons.com` now forwards to the new address via Porkbun (forward confirmed active in Porkbun's dashboard, delivery still pending final test-email confirmation as of Aug 18). Appeal on the old account has since resolved too, but nothing depends on it anymore either way.
- ✅ ~~Footer Terms/Privacy links + SMS disclosure never actually deployed~~ — **RESOLVED Aug 18**, found via `git status` (was done locally Aug 17, never pushed), now pushed and live
- ⚠️ **Twilio A2P 10DLC Campaign still pending Twilio's review** (submitted Aug 18) — real SMS to arbitrary US numbers blocked until approved (Error 30034)
- ⚠️ **Site is intentionally password-locked right now** (`SITE_PASSWORD` set in Railway) — nobody but people with the password can use the real product; this is deliberate ("website needs work before people see it," per John Aug 17), remove the env var when ready to actually launch
- ⚠️ Photo upload storage: Needs SUPABASE_SERVICE_ROLE_KEY in .env (should already be set — confirm still present in Railway's variables, not just the local `.env`)
- ⚠️ **Google Sheets export needs a full rebuild** — doesn't fire on check-ins/logs (only ever wired to signup) and its credentials file isn't deployed to Railway at all (git-ignored). Not launch-blocking. John wants a fresh sheet under the new Gmail account when this gets picked up — see dedicated section above for the full plan. Explicitly banked for later, not started.

---

# BUILD COST/TIME SUMMARY

```
Phase 1 (Web): 80-100 hours of coding
  - Your time + contracted dev if needed
  - Cost: $0-5k (depends if you code or hire)

Phase 2 (App): 60-80 hours of coding
  - React Native/Expo (fast)
  - Your time or contractor
  - Parallel to web running
  - Cost: $0-4k (depends if you code or hire)

Phase 3 (App Launch): <10 hours
  - Setup testing, monitor, fix bugs
  - Your time

Phase 4 (Scaling): 150-200 hours (next 6 weeks)
  - Add engagement features
  - Your time or contractor

TOTAL TIME TO RETENTION-VALIDATED PRODUCT: 8 weeks
TOTAL COST: $0-9k (depends on hiring vs DIY)
```

---

# CURRENT STATUS

**Active Phase:** Phase 1 - Web Launch (Weeks 1-2), infrastructure production-deployed, full AI retention feature set live, real-time Google Sheets logging live, Twilio confirmed working end-to-end. Primary build workflow in Claude Code (direct local file access) since Aug 20 — this chat used for planning, review, and strategy. **All message content (SMS + email) has now been fully audited and hardened** — real content bugs, ordering bugs, and SMS segment-length issues found and fixed via offline dry-run tracing rather than a risky live test. **Test data fully wiped Aug 21** for a clean baseline going forward.  
**Major shift this session:** two known Aug 19 bugs closed, a real live bug found (false breed-comparison claims on the dashboard), a genuine security hole found and fixed (admin panel password was sent in plaintext), a full site-wide typography/heading/emoji polish pass shipped, a ground-truth privacy audit surfaced several real gaps beyond the original copy issue, and — most significantly — a full strategic re-grounding conversation that produced real, load-bearing decisions on business positioning, beta structure, and product scope.  
**Next:** Get lawyer review (full question list now prepared — see the new legal/strategy document); decide when to actually remove `SITE_PASSWORD`; fix the remaining real gaps found in today's privacy audit (missing consent record, orphaned `users` table, stored-XSS bug)  
**Then:** STEP P1C (Comparative Feedback) once real breed-cohort data exists; STEP P8 full end-to-end testing; begin actual recruiting for the now-locked-in beta structure (8 strangers + 2-3 known friends)

**Previously Completed:** ✅ All backend infrastructure, auth, SMS, churn detection, copy system  
**Completed Aug 16 (cleanup pass):** ✅ Fixed broken signup CTAs, retired orphaned founding.html modal, renamed baseline survey, fixed missing DB columns, added data-licensing fields, fixed .gitignore  
**Completed Aug 17-18 session 1:** ✅ Expanded weekly check-ins to mobility+energy+appetite+cognitive, fixed the completely non-functional SMS reminder system, fixed a real TCPA compliance gap, discovered and linked existing Terms/Privacy pages sitewide, built a password-lock system, fixed the hardcoded-LAN-IP blocker, **deployed to production on Railway for the first time**, **pointed and live at companioncommons.com**, **submitted the Twilio A2P 10DLC Campaign registration**, fixed the churn-alert email bug and migrated all business accounts off a locked Gmail address  
**Completed Aug 18-19 session 2:** ✅ **STEP 27B, 27C, 27D, P1B, P1D** — all five AI features built, tested, live in production. Reconciled P1/27 duplicate checklist entries. Wiped all test data for a clean slate. Confirmed `hello@companioncommons.com` email forwarding works. Diagnosed and resolved a real Railway platform outage.  
**Completed Aug 19 (continued):** ✅ Rebuilt Google Sheets integration from scratch, added a Dog ID join key across all three tabs. **Twilio A2P campaign approved and confirmed genuinely working** with a real phone. **Rebuilt the dashboard**: removed the old confusing empty-state page, added a real 7-day gate with live countdown, relabeled the progress indicator. Built a new **mid-week notes feature**. **Found and fixed five real bugs surfaced only by real end-to-end testing** (photo bucket name mismatch, fake "at a glance" text, literal placeholder text, mobile overflow, chart overlap). Installed real homepage photos/illustrations. Added real baseline survey data to the dashboard that had been collected but never displayed.  
**Completed Aug 20 session:** ✅ Fixed the "Week #0" reminder bug (missing floor guard in two of three `currentWeek` calculations) and built the Journey Summary feature for real (trends, weekly table, notes, alerts, printable, brand/photo header, full baseline profile) — the two carried-over open items from Aug 19. ✅ Found and fixed a real live bug: dashboard peer-comparison card was claiming breed-specific comparisons ("similar Labradoodle") off a query with no breed filter at all — relabeled honestly as community-wide with a disclaimer. ✅ Migrated primary build workflow to **Claude Code**. ✅ Site-wide typography audit and fix: Google Fonts were only loading on `index.html`, 11 other pages silently falling back to system fonts — fixed across all pages; set and applied a real site-wide heading-capitalization rule (sentence case for H2/H3, Title Case for H1s). ✅ Fixed a broken founder photo path on `about.html`. ✅ Replaced 60+ decorative emoji site-wide with a real Lucide SVG icon set. ✅ **Found and fixed a real security hole**: the admin panel password was being sent in plaintext to the browser with zero server-side check — rebuilt using the same server-side pattern as the `SITE_PASSWORD` gate, verified in production. ✅ Removed the orphaned `Public/_to_delete/` folder (confirmed unreferenced anywhere, was still publicly reachable with no access control). ✅ Ran a full ground-truth privacy audit against actual code — found and fixed stale/inaccurate collected-data lists on `privacy.html` (zip code, weight, spay/neuter, diet, insurance, medication category were missing or mislabeled), and surfaced three real unfixed gaps: no consent record is ever persisted, an orphaned `users` table duplicates PII with a broken schema, and a stored-XSS gap exists in the Journey Summary's note rendering. ✅ **Major strategic decisions made** — see `CompanionCommons_Strategy_and_Legal_Aug20.md` for full detail: adopted Real-World-Evidence (RWE) platform positioning; locked in "no consumer-facing scoring, predictive modeling as a core licensing product" as a firm rule; resolved the medication-data question (category-level only for now, pending lawyer review and data-model separation); resolved free-text notes (keep allowing, with new hardening: in-context disclosure + hard rule that free text never reaches the B2B export); locked in beta structure (8 real strangers + 2-3 known friends, up from original 6-7); resolved "senior dog" as intentional positioning (not leftover naming) with data collection opened to all ages. ✅ Built and shipped the senior-by-breed-size flag and recurring weight tracking (every 4th week, matching the cognitive cadence) that followed directly from that decision, including breed-typical-weight-range comparison and a new weight trend line alongside the existing three metrics.

**Completed Aug 21 session:** ✅ Fixed the mobile-fit overflow on the 4-column baseline score box (traced to a real, unrelated button-row bug, not the Weight column itself — fixed, verified at real 375px viewport, desktop confirmed unaffected). ✅ Found and fixed four real dashboard bugs via direct visual review on a newly phone-linked test setup: missing vet disclaimer, a false "held steady" trend claim during the baseline period, a visible empty area in the Current Streak box (now filled with real contextual copy), and a "Notes" label relabeled to "Baseline Notes" for clarity. ✅ **Found and fixed a real live bug**: the churn-detection re-engagement email was firing during a dog's 7-day baseline period, before a first check-in was even possible — added the same baseline gate already used by the check-in routes, verified live under matching production timezone conditions. ✅ **Refactored churn-detection into one shared function** (`processDogForChurn`) after discovering a second, duplicate copy of the same logic existed at a manual test endpoint and would have silently drifted out of sync with today's fix. ✅ **Found and fixed a silent email-failure logging gap** — a failed SendGrid send was being logged as a false success and blocking legitimate retries for 24 hours; fixed and verified against SendGrid's real, currently-failing state. ✅ **Ran a full offline dry-run audit of every SMS/email message** across two complete 12-week scenarios (on-time logging, and missing every week) — avoided a costly, confusing live compressed test by tracing the actual code instead. This surfaced and fixed: a churn email that cited a stale, unchanging signup date forever; the email firing out of order before any SMS reminder; two real grammar errors; and silent (unacknowledged) weight/cognitive data collection on 4th-week check-ins. Also confirmed a second, fully dead duplicate reminder system exists (unreachable by real users, flagged for future cleanup) and that milestone messages land on weeks 3/5/9/13, not the "2/4/8/12" one might assume. ✅ **Found and fixed a real SMS segment-length bug** — 3 of 5 SMS templates were already splitting into 2 segments in production; trimmed four templates to fit a single 160-char segment even at long dog names, and added a structural 40-character max-length cap on `dog_name` (client + server-side) so this margin can't erode again later. ✅ **Full test data wipe** — all 9 test dogs and every related row across 7 Supabase tables (including `churn_flags`, missed in the original audit but caught and included), plus Google Sheets data rows cleared with headers preserved — giving a genuinely clean baseline for future SMS timing testing. ✅ Set up Microsoft Phone Link (iPhone) for real-time SMS/notification visibility during testing — directly enabled catching several of this session's bugs. ✅ Created `All_SMS_Communications.md` as a standing reference document for every real SMS template's final copy, character counts, and trigger conditions. ✅ **Unified dashboard card styling** — fixed two competing, inconsistent card systems (shadow-only vs. barely-visible-border-only) into one consistent border+shadow+radius treatment across every card, plus cleaned up a visually mismatched photo-upload button row. ✅ **Journey Summary printout given real "official document" treatment** — full frame border, letterhead rule, section dividers, document-metadata-styled date line. ✅ **Found and fixed a second missing floor-guard bug** ("Week -1 of 12"), same family as the earlier "Week #0" fix — confirmed the original multi-site fix hadn't covered every call site, now it does. ✅ **Found and fixed three further real print bugs through direct PDF testing**: a 3-page duplicate-page bug (root-caused to `visibility:hidden` preserving layout height, fixed with a `display:none`-based approach), added a real chart image to the printout (captured from the live dashboard chart, not a duplicate), and fixed a page-break/spacing issue that was stranding the disclaimer alone on a near-empty second page (tightened spacing + `break-inside: avoid` safety net on every section). ✅ **Fixed a real on-screen/print mismatch** — the chart was only generated at print-click time, invisible in the on-screen modal; moved to generate on modal-open so what's seen always matches what prints. Final state confirmed against multiple real generated PDFs, not assumptions.

**Last Updated:** August 23, 2026 (later same day) — **STEP P10 built and shipped, all 6 stages**, following up on the planning pass captured earlier this same day (see entry below). Full detail in `Health_Instrument_Redesign_Build.md`. Schema migration + shared helpers, both signup forms, both check-in surfaces, the sign-flip work across the dashboard/insight/alert logic, Google Sheets headers, and a real verification pass — signup, single- and multi-week check-in, a real multi-dog-owner scenario (second dog via Add Another Dog, combined check-ins page, dashboard switcher confirmed both with and without a session), resend-dashboard-link, and a genuine second cadence cycle exercising real checkin-to-checkin trend text and alert logic. Both migrations run against real Supabase. Two real bugs found and fixed along the way, neither part of the original plan: a pre-existing legacy DB constraint (`mobility_check`) still enforcing the old 1-8 range on one column, found via the first real signup after the main migration ran; and a falsy-zero bug in the dashboard's peer-comparison card, found during self-review. One manual follow-up remains for John: add "(0-10)" to the Google Sheet's live score-column headers.

**Earlier the same day:** Documentation-only pass capturing the health check-in instrument redesign from a planning conversation: new `CompanionCommons_Health_Instrument_Design.md` (CBPI/CCDR-inspired multi-item mobility and cognitive composites, replacing the old single ad-hoc slider per domain), a matching addendum in the Strategy/Legal doc, and a new **STEP P10** here, flagged as a pre-beta blocker sequenced ahead of STEP P8. No code changed yet at that point — the build came later the same day, per above.

**August 22, 2026 (Session 3):** Added a self-service "resend my dashboard link" flow (`POST /api/resend-dashboard-link` + `find-my-dashboard.html`), closing a real gap: no way back into a lost dashboard link short of waiting for day 7's reminder to fire incidentally. Reuses the existing `/checkins/:owner_id` page as the destination, never reveals whether a phone number is registered, and gave the previously-unused `smsRateLimit()` its first real call site. Verified end-to-end with real sends. Also fixed a dead `#signin` homepage nav link found along the way.

**August 22, 2026 (Session 2):** Real consent record persisted (both `magic_link_tokens` and `senior_dogs`), a full site-wide `escapeHtml()` sweep closed the Journey Summary XSS gap plus two more real findings (`activeAlert.message`, `dog.baseline_notes`), and the entire dead legacy schema (`users`/`pets`/`survey_baselines`/`survey_weekly_checkins`/`survey_enrichment`/`sms_preferences`) is dropped along with its last two dead routes. Closes checklist items 2, 8, 9, and 11 from the prior list. Test data fully wiped for a clean slate.

**August 21, 2026 (end of session):** All four remaining Aug 20 open items closed, plus a full message-content/timing audit and a full dashboard + Journey Summary visual polish pass, both producing real bugs found and fixed along the way (not just cosmetic work). Journey Summary is now a genuinely finished, verified feature: styled, chart-equipped, print-tested across multiple real PDFs, on-screen/print parity confirmed. Test data fully wiped for a clean slate.

---

# NEXT STEP

**Resolved this session (Aug 22, commit `102798a`):**
- ~~Fix the three remaining real gaps from the Aug 20 privacy audit: persist a real consent record, remove or fix the orphaned `users` table, fix the stored-XSS gap in the Journey Summary's note rendering~~ — **all three done.** `consent_given_at` now persisted on both `magic_link_tokens` and `senior_dogs` (migration run, verified via a real end-to-end signup). The orphaned `users` table and the entire dead `users`/`pets`/`survey_baselines`/`survey_weekly_checkins`/`survey_enrichment`/`sms_preferences` schema is dropped — confirmed live in Supabase (querying any of the six now returns "could not find the table"), not just decided. The Journey Summary stored-XSS gap is fixed, plus a full site-wide `escapeHtml()` sweep well beyond that one spot — see the Build Log entry for the two real findings it turned up beyond the original checklist.
- ~~Minor cleanup, lower priority: remove the confirmed-dead duplicate reminder system (`/api/checkin`, `survey_weekly_checkins`)~~ — **done.** Both `/api/checkin` and `/api/enrichment` routes deleted outright, confirmed zero live callers first (grepped `Public/` for both).
- ~~Run `git log --oneline` as a sanity check~~ — **done.** Every migration file referenced anywhere in the project docs cross-referenced against actual commit history; all accounted for, nothing found run-but-uncommitted this time.
- ~~Site-wide audit needed: unescaped user-controlled fields rendered into HTML without `escapeHtml()`~~ — **done**, a real sweep rather than another one-off patch. Two genuine findings beyond the original checklist: `activeAlert.message` (the health-alert banner, both the dashboard and Journey Summary) and `dog.baseline_notes` — the latter was the actually-exploitable one, since it only goes through `sanitizeString()` (trim + length cap) rather than `sanitizeName()` (which allowlists letters/spaces/hyphens/apostrophes only — meaning `dog_name`/`breed` were never really exploitable; those fixes are defense-in-depth, not closing a live hole). Verified empirically: a test dog was created with real `<script>`/`<img onerror>`/`<svg onload>` payloads inserted directly into the DB, bypassing the app's own input sanitization entirely, and confirmed to render as inert escaped text on every page. Test data (including Storage) cleaned up afterward.

**Still open, renumbered:**

1. **Get actual lawyer review** — full, specific question list prepared in `CompanionCommons_Strategy_and_Legal_Aug20.md`, not yet scheduled
2. **Decide when to remove `SITE_PASSWORD`** — still genuinely just a decision
3. **STEP P1C (Comparative Feedback)** — still blocked until real breed-cohort data exists
4. ~~STEP P10 (Health Check-In Instrument Redesign)~~ — **done (Aug 23)**, all 6 stages, both migrations run, verified live end-to-end including a real multi-dog scenario and a genuine second cadence cycle. Full detail in `Health_Instrument_Redesign_Build.md`. One manual follow-up remains: add "(0-10)" to the 8 score column headers on the live Google Sheet (code only updates a freshly-created tab).
5. **STEP P8 (full end-to-end testing)** — now unblocked. STEP P10's own Stage 6 verification already covered a real chunk of this against the new instrument (see the note under STEP P8's own heading above) — what's left before beta recruiting: Journey Summary print-to-PDF, mid-week notes display, and the Communications section (reminder SMS, churn alert email)
6. **Begin recruiting for the beta** — 8 real strangers matching the actual target persona, plus 2-3 close friends
7. **Begin scoping the data-model separation work** (identifiable vs. de-identifiable fields) — still flagged as a real prerequisite before any future drug-name-level data collection
8. Cosmetic, lower priority: fix the churn-cron startup log message ("1 minute for testing" when it's actually 60 minutes) — not part of this session's cleanup, still outstanding

9. **Multi-dog owner project (see `Multi_Dog_Signup_Build.md` for full detail)** — all 5 stages complete: owner entity, `owners` table, signup flow rewritten with returning-owner detection, message consolidation (combined churn emails, combined SMS reminders via `/checkins/:owner_id`, migration run and live-verified), and an additive-only owner-session dashboard dog-switcher (`/dashboard/:dog_id` renders identically for anyone with no session — vets/family sharing links unaffected — and only adds a switcher when a session cookie matches the dog's own owner, verified adversarially against a cross-owner mismatch). A real unescaped-`dog_name` gap found during Stage 5's own build was fixed on the spot (`buildDogSwitcherHtml`). No open items on this project.
10. **Mobile strategy decision (Aug 23):** PWA layer (manifest, service worker, push notifications, install prompt) — scoped for mid-beta, roughly weeks 4-6, once initial beta churn settles. Native iOS/Android apps stay Phase 2 (Petwella), not pulled forward — decided explicitly, not by default. This supersedes the parallel-native-build plan in the "PHASE 2: PARALLEL APP BUILD" section below (React Native/Expo, weeks 3-7, week-8 A/B decision) — see the superseded notice at the top of that section, kept for reference only.
11. ~~Chart Cognitive and Weight in the dashboard, and add Cognitive to the Baseline Score box~~ — **fully resolved (Aug 23).** Cognitive piece done first: Baseline Score box's 5th Cognitive mini-column, the "Exact values by week" mobile mini-table's matching Cognitive row, the Chart.js line's 4th Cognitive dataset (distinct color/star markers/dash-dot pattern, null on non-cadence weeks so `spanGaps:false` leaves genuine gaps), and the Journey Summary's Weekly log table's new Weight column (value + "lb", em-dash when not collected). Weight-on-chart resolved as its own small, conditionally-shown mini-chart per John's decision (separate chart, not a secondary y-axis on the main one): `isOverweightForBreed(currentWeight, breedName)` — direct parallel to `isSeniorForBreed`, reuses the existing `parseWeightRange`/`getBreedGuide` helpers, no added margin, nothing stored. The weight mini-chart (own y-axis in lbs, `beginAtZero:false`, same x-axis weeks as the main chart so a weight change lines up against that week's mobility/energy movement, neutral brand-tan color so it doesn't read as a 5th score metric) only renders when the dog is currently overweight for its breed AND has at least 2 real recorded weight points (baseline + cadence-week check-ins) — below that, the existing static Journey Summary weight line already covers it. A contextual line ("You're seeing this graph because...") explains the chart's presence specifically, same disclaimer register as the breed guide's own weight mention. Verified live across all 4 gating states with a dedicated test dog (hidden at 1 point despite being overweight, appears at 2 points while overweight, correctly disappears again once a later real weight comes back under the breed's range) — cleaned up afterward, no test data left behind. Confirmed via the real breed-guide lookup that this is a genuine boolean gate, not just data-point counting: Winston's breed ("Beagle") isn't in the breed guide list at all so his flag is always false regardless of weight, and Daisy's real weight (64→63 lb) is well within Golden Retriever's 55-75 lb range — both correctly show no chart.


