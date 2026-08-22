# CompanionCommons — Multi-Dog Signup Build
**Started:** August 21, 2026
**Status:** Stage 1 — Investigation (in progress)
**Purpose:** Standalone tracking document for a major architecture fix — introducing a real "Owner" entity so multi-dog owners get one signup, one set of messages, and one dashboard with a dog-switcher, instead of duplicating everything per dog. This is tracked separately from the main build log because of its scope; see `CompanionCommons_Build_Log.md` for the day-to-day session record and `CompanionCommons_Strategy_and_Legal_Aug20.md` for the broader business context this connects to.

---

## The problem

The system currently has no concept of an "owner" independent of a dog. Every `senior_dogs` row carries its own copy of contact info (email, phone, `sms_consent`). A person with two dogs currently gets:
- Two separate signup flows, two separate verification texts
- Two separate consent checkboxes
- Two separate weekly reminder texts and churn emails, even when both dogs are due the same week
- No way to switch between their dogs on one dashboard — each dog's URL is its own island

Given a real, large share of dog owners have more than one dog, this isn't an edge case — it's a mainstream experience currently being handled badly. Decided (Aug 21) to fix this properly before beta launch, not scope around it. At least one real multi-dog owner is now a requirement for the 8-stranger beta group, specifically to validate this fix against a real person, not just internal testing.

**Connection to other work:** this data-model separation (owner-level identifiable info vs. dog-level health data) is largely the same architectural prerequisite already flagged as necessary before any future drug-name-level medication data or predictive-modeling licensing work. This build makes real progress on both problems at once.

---

## The plan

**Stage 1 — Investigation** *(current stage)*
Full audit of the current schema and every place `senior_dogs.email`, `.phone`, and `.sms_consent` are read or written — signup, verification, reminders, churn detection, the Sheets export, the admin panel, anywhere else. No changes yet; this stage exists to make sure the later stages are built against reality, not assumptions.

**Stage 2 — `owners` table + migration**
New table: email, phone, a real preferred-contact-method setting (replacing the current blunt `sms_consent` boolean), zip code, preferred reminder day/time. Every dog record gets an `owner_id` foreign key instead of its own copy of contact fields.

**Stage 3 — Signup rewrite**
Two-phase flow: owner info entered once (email, phone, consent, zip), then the baseline health survey repeats per dog via an "add another dog" option — no re-verification, no re-consent per dog. Dedup on phone number: if a phone number already has an owner record, a new signup links to it instead of creating a duplicate.

**Stage 4 — Message consolidation**
Reminders and churn-detection emails become owner-scoped instead of dog-scoped — one combined message per contact touchpoint ("Bailey and Max both have check-ins ready") instead of separate messages per dog on the same day.

**Stage 5 — Owner session + dashboard switcher**
A lightweight, owner-scoped session/cookie (extending the existing magic-link/passwordless pattern — not a new login system), so the dashboard can identify which dogs belong to the current visitor. Dashboard gets a real switcher UI (tabs/dropdown) at the top, populated from that session.

---

## Progress log

### Stage 1 — Investigation ✅ Complete (Aug 21)

**Full audit performed against the live schema and actual `server.js` code** — not assumptions. Key findings:

**1. `senior_dogs`'s real schema, confirmed live.** Contains 27 columns. Two dead ones found in passing: `owner_id`, `owner_name`, `owner_email`, `owner_phone` exist on the table but are referenced **zero times** anywhere in `server.js` — a dead, never-finished stub of exactly this owner concept. `age_years` is a second, unrelated dead column (the app always uses `age`). The real, actively-used contact fields are the plain `phone`, `email`, `sms_consent` columns.

**2. Every read/write of `phone`/`email`/`sms_consent` mapped.** Full list: signup validation and storage (`/api/send-magic-link`, `/verify`), the SMS-reminder gate and destination in `processDogForChurn`, the churn-email recipient resolution, the proactive next-week-reminder gate. Confirmed: `senior_dogs.email/phone/sms_consent` are written in exactly one place (`/verify`) and read in a small, fully-enumerated set of places — no hidden surprises.

**3. Full current signup flow traced end-to-end.** Confirmed the root cause directly: `/verify`'s dog-record creation **never checks whether the submitted email/phone already belongs to an existing owner** — every signup unconditionally creates a new `senior_dogs` row. This is the exact mechanism producing duplicate signups/messages for multi-dog owners.

**4. The orphaned `users` table — confirmed to be an earlier, abandoned owner-entity attempt, not just guessed.** Its insert has silently failed on **100% of signups, every time, forever** — a schema mismatch (`sms_consent` sent, but that column doesn't exist on `users`), caught and swallowed non-fatally. Further investigation found a **complete parallel relational schema** (`users` → `pets` → `survey_baselines`/`survey_weekly_checkins`/`survey_enrichment`, plus a separate `sms_preferences` table) — a real owner/pet structure that was clearly built once and then abandoned in favor of the current flat model. All six tables confirmed at **0 rows** — nothing to migrate, safe to drop entirely.

**Decision made (Aug 21):** don't repurpose the dead `owner_id`/`owner_name`/`owner_email`/`owner_phone` columns or the legacy parallel schema — drop both, build a clean new `owners` table with a real foreign key instead. Reviving either half-finished attempt risks ending up with two competing owner mechanisms.

**Side finding, fixed as its own quick task (not part of this project):** `governance.html`'s public transparency stats were reading from the dead legacy tables above, showing permanently zeroed-out numbers to any real visitor regardless of actual signup activity. Fixed separately to read from live `senior_dogs` data instead.

**5. Magic-link/verification system fully mapped.** `magic_link_tokens`: 64-hex-char random token, 15-minute expiry, single-use (enforced via `used_at`), payload is the *entire* baseline submission copied field-by-field at verify-time — no FK to `senior_dogs`. Important for Stage 5: this token is purpose-built for **one pending dog signup**, not an owner or a returning session — it can't directly represent "which of my 3 dogs do you want" in its current shape. Stage 5 will need either a materially different, owner-scoped token payload, or a second parallel mechanism reusing the same random-token/expiry/single-use pattern. Also noted: a real (currently harmless) race window exists between the `used_at` check and the update — worth hardening if this pattern gets reused for anything session/auth-related, where the stakes of a double-use would be higher.

**6. Six structural single-owner assumptions confirmed, not incidental:** the churn-detection cron (loops dogs flat, zero cross-dog grouping — confirmed this is the exact mechanism that would send a two-dog owner 2 separate churn emails and 6 separate reminder texts in the same week), the proactive next-week reminder, the `/verify` signup-creation route itself, the Google Sheets export (its own code comment already acknowledges awareness that multi-dog owners exist, but only solved the spreadsheet-key problem, not the messaging-dedup problem), the admin panel (no owner concept at all, flat dog list), and every dashboard/check-in/breed-guide route (keyed purely by `dog_id` in the URL, no owner-level routing concept anywhere).

**Stage 1 conclusion:** the investigation didn't just confirm the plan — it de-risked it. We now know exactly what to build against, what to avoid reviving, and what Stage 5 will specifically need to solve that a naive reuse of the current token system wouldn't handle.

---

### Stage 2 — `owners` table + migration ✅ Complete (Aug 21)

**Schema:** `owners` table created — `id` (uuid PK), `email` (NOT NULL), `phone` (NOT NULL, UNIQUE — the real dedup key), `preferred_contact_method` (text, CHECK-constrained to `sms`/`email`/`both`), `zip_code`, `preferred_reminder_day`, `preferred_reminder_time`, `created_at`. Field types confirmed matching `senior_dogs`' existing conventions exactly (not "upgraded" mid-migration) to avoid introducing a hidden parsing dependency elsewhere in the app.

**`senior_dogs` changes:** the four dead, never-used stub columns (`owner_id`/`owner_name`/`owner_email`/`owner_phone` as plain text) dropped; a new, real `owner_id` (uuid) added with a foreign key to `owners.id`. Drop-then-add ordering confirmed collision-free (two sequential `ALTER TABLE` statements, not combined). `phone`/`email`/`sms_consent` deliberately left untouched on `senior_dogs` — still the fields actually read by the churn cron, reminder gates, and check-in route; rewiring that logic to read from `owners` instead is Stage 3+ work, not this stage.

**Two design decisions changed from the original proposal, both toward "fail loudly instead of silently":**
- `preferred_contact_method` got a database-level `CHECK` constraint added (not just app-layer validation) — a bad value here wouldn't just be cosmetic, it could silently mean a real message never gets delivered through any channel.
- The `owner_id` foreign key uses `ON DELETE RESTRICT`, not the originally-proposed `SET NULL` — deleting an owner who still has linked dogs now fails with a clear error instead of silently orphaning those dogs' `owner_id` with no signal anything broke.

**Backfill, run against real (test) data:** deduped by phone, one `owners` row per distinct phone, sourced from each phone's earliest `senior_dogs` row. `preferred_contact_method` derived from the existing `sms_consent` boolean as a placeholder mapping (`true` → `'sms'`, `false`/`null` → `'email'`) — explicitly flagged as provisional until Stage 3's signup form actually asks for a real 3-way preference.

**Known, deliberate gap, not yet resolved:** any `senior_dogs` row with a `NULL` phone (pre-dates phone being required at signup) can't be deduped or linked by this migration — those dogs' `owner_id` stays `NULL`. Real decision needed in Stage 3 (manual backfill, prompt for re-verification, or accept they stay ownerless until next contact).

**Verified live, not just assumed from the "success" message:** queried the real post-migration schema directly — confirmed the dead columns are genuinely gone (not just excluded from a query), confirmed the new `owner_id` is a real UUID correctly pointing at the new owner row, confirmed `phone`/`email`/`sms_consent` untouched. Both constraints were proven under actual violation attempts, not just confirmed to exist: an invalid `preferred_contact_method` value was correctly rejected (HTTP 400), and deleting an owner while a dog still referenced it was correctly blocked (HTTP 409). `server.js` confirmed completely untouched — no live application behavior has changed yet; the app hasn't been rewired to actually use `owners`.

---

### Stage 3 — Signup rewrite ✅ Complete (Aug 21)

**Design finalized first, then built in reviewable pieces** — form restructuring and both branched routes shown separately for review rather than one large diff, given this is the most user-facing and highest-risk stage of the project.

**Final design decisions:**
- **Two-phase field split, Option A routing:** the signup form stays a single page/single submit for the common case (Phase A owner fields + Phase B dog fields together) — byte-for-byte matching today's UX and SMS count for a brand-new owner's first dog. "Add another dog" is a separate, secondary flow, not a wizard step every new user has to pay for.
- **Owner name added, optional field, Phase A.** Required its own small migration (`migration_add_owner_name.sql`) since `owners` already existed live from Stage 2 — editing the original Stage 2 migration file wouldn't have retroactively added the column to the already-created table. Good catch by Claude Code stopping to ask rather than guessing at this gap.
- **Contact preference:** the old SMS-only checkbox replaced with a real 3-way choice (SMS/Email/Both), matching `owners.preferred_contact_method` from Stage 2.
- **Returning-owner detection:** at submission time, phone number checked against `owners` before any token is generated. Match found → different SMS copy ("add {dog} to your existing account"), `existing_owner_id` stored on the pending `magic_link_tokens` row (new nullable FK column) instead of full owner fields. No match → today's exact behavior, unchanged.
- **Security principle, verified under an actual adversarial test, not just designed:** a phone match is never treated as proof of identity — real verification (tapping the link) is still required either way, and on the existing-owner path, `/verify` pulls contact info from the real `owners` record, never from the resubmitted form fields. This matters because anyone could type a stranger's real phone number into the public form; the system must not let that resubmission silently overwrite or impersonate the real owner.
- **New "Add another dog" flow:** `Public/add-dog.html` (Phase B fields only) → new `POST /api/add-dog`, reached via a link on the dashboard gated on `dog.owner_id` existing. No SMS/token round-trip needed for this path — consistent with the app's existing no-login, link-based security model (explicitly not scope-creeping real auth into this stage; that's Stage 5's job).
- **NULL-phone gap:** confirmed via a real read-only count (0 affected rows in production) to be a non-issue — no dedicated handling built, the existing defensive `owner_id = NULL` fallback from Stage 2 is sufficient and free.

**Three migrations, all confirmed run and landed in the live schema before verification began:**
1. `migration_add_existing_owner_id.sql` — `magic_link_tokens.existing_owner_id` (nullable, FK to `owners.id`)
2. `migration_add_owner_name.sql` — `owners.name` (nullable, optional field)
3. `migration_add_token_contact_preference.sql` — `magic_link_tokens.contact_preference` + `.owner_name` (a second gap caught and folded into this file rather than spawning a fourth migration unnecessarily)

**A real bug caught and fixed along the way, not part of the original design brief:** the Google Sheets export in `/verify` was still using the resubmitted `tokenData.email` instead of the resolved real owner's email — meaning a returning owner's spreadsheet row would have recorded whichever email they happened to type on the second signup, not their real one. Fixed to use the resolved `ownerEmail` consistently.

**Verified live, through the real browser UI, not direct API calls — three full scenarios, including a deliberate adversarial test:**
1. **New-owner signup:** real form submission, real token created and fetched directly (Twilio rejected the synthetic test number as expected, but the token row is written before the SMS attempt, so verification could proceed the same way a real click would). Confirmed: correct `owners` row created, `senior_dogs` correctly linked via `owner_id`, dashboard renders the new "+ Add Another Dog" link with the correct `owner_id`.
2. **Add another dog, same session:** followed the link, submitted Phase-B-only fields, landed directly on the second dog's dashboard with no SMS step. Confirmed: still exactly one `owners` row (no duplicate created), second dog's contact info correctly pulled from the owner record rather than re-asked.
3. **Returning owner — the actual bug this project exists to fix, tested adversarially:** resubmitted the main signup form using the same phone number but a deliberately wrong email/zip/name, specifically to try to break the "don't trust resubmitted data" guarantee. Confirmed: `existing_owner_id` correctly matched on the token, still exactly one `owners` row total after verification, the third dog correctly received the *real* owner's stored email/zip — the falsified resubmitted values were correctly discarded and the real owner's stored data was left untouched.

All test data (3 dogs, 1 owner, 2 tokens) confirmed cleaned up afterward.

**This is the core fix landing:** a multi-dog owner can now add a second (or third) dog without a duplicate signup, a duplicate verification text, or a duplicate consent checkbox — and a stranger typing in someone else's real phone number can't hijack or overwrite that person's real account data.

---

**To-do before/alongside Stage 4:** run `git log --oneline` as a sanity sweep — Stage 2's migration file sat run-and-verified against Supabase but uncommitted for an entire session before being caught and bundled into the Stage 3 commit. Worth confirming nothing else is in the same state before continuing.

---

### Stage 4 — Message consolidation ✅ Complete (Aug 22)

**Investigation, done first:** confirmed Stage 3 already guarantees the invariant this whole stage depends on — both `/verify` (returning-owner path) and `/api/add-dog` write `phone`/`email`/`sms_consent` onto every new `senior_dogs` row directly from the linked `owners` record, not from resubmitted form data. So for any real multi-dog owner, every one of their dogs already carries identical contact info and a populated `owner_id`. Grouping by `owner_id` is therefore a reliable, ready-to-use key — no new sync mechanism needed.

**The real design fork, surfaced before writing code:** combining the churn re-engagement **email** across an owner's dogs is unconstrained (no character limit). Combining the missed-check-in **SMS reminders** is not — each check-in link alone runs ~75 characters, and every SMS template was already trimmed to the 160-character single-segment limit for one dog (see `All_SMS_Communications.md`). Two dog names plus two separate links don't fit. Raised this directly rather than guessing; decided (John, Aug 22) to build a small combined-checkins landing page now, so the SMS only ever needs to carry ONE link regardless of dog count — solves the constraint cleanly and doubles as a stepping stone toward Stage 5's real dashboard switcher, without pulling any of Stage 5's session/login scope forward.

**What got built:**

1. **`GET /checkins/:owner_id`** — a new, no-login landing page (same link-based security model as `/check-in/:dog_id` and `/dashboard/:dog_id`, both already reachable by anyone with the right UUID) listing every dog under one owner, each with its live status — "check-in ready," "already checked in this week ✓," or "first check-in available in N days" — and the right action link per state. This is the single link every combined SMS now points to.

2. **Churn-detection cron and the manual `/api/test-churn-detection` endpoint, both restructured into two passes.** `processDogForChurn` was split: the renamed `evaluateDogForChurn` now only *decides* whether one dog needs an alert (baseline gate, current week, this-week-checkin check, per-dog SMS queueing, 24h dedup — all unchanged) and returns that decision instead of sending anything. Both callers now run this per dog first, then group the dogs that need an alert by `owner_id` (a dog with no `owner_id` — legacy/ownerless — forms its own solo group, so it still gets an individual email exactly as before this change), then call a new `sendChurnAlertsForOwnerGroup` once per group. A solo group still uses the original, unmodified single-dog email template and copy — nothing about the already-tested wording changed for the common single-dog-owner case. A group of 2+ uses a new `sendCombinedChurnAlertEmail`, one email listing every overdue dog with its own "since we heard from you" line and its own dashboard link. On success, a `churn_flags` row is still written per dog (not per email), so each dog's existing 24h dedup keeps working independently regardless of how it was delivered.

3. **SMS reminder combining, done at the point sends actually happen, not at queue time.** Each of the 3 missed-check-in reminder tiers and the proactive next-week reminder still queue one `sms_queue` row per dog exactly as before — all existing per-dog dedup/tracking logic is untouched. The new part: the 60-second SMS-sending cron now groups pending rows by `owner_id` + message "kind" (the week number is stripped for grouping — `week_3_reminder_1` and `week_2_reminder_1` both normalize to `reminder_1`, since sibling dogs can legitimately be on different weeks and still be due for the same tier at the same moment). A group of 1 sends its pre-built `message_body` exactly as before. A group of 2+ builds a fresh combined body naming the dogs and linking to the new `/checkins/:owner_id` page instead of any individual check-in link — deliberately omitting the week number, since it can differ per dog in the group. One Twilio send per group; every queued row in that group is marked `sent` with the same `twilio_sid`, or all marked `failed` together if the send errors.

4. **Dashboard:** added a "View All My Dogs" link next to the existing "+ Add Another Dog" link (both gated on `dog.owner_id` existing), so the new page is reachable from inside the product itself, not only from a text or email.

**Schema change:** `migration_add_sms_queue_owner_id.sql` — one nullable `sms_queue.owner_id` (FK to `owners.id`), populated at every insert site going forward. **Not yet run** — per standing project rule, John runs migrations manually in Supabase's SQL Editor. **This one has a real deployment-ordering consequence, unlike some earlier migrations**: the SMS-sending cron's `select` now names this column explicitly, and querying a column that doesn't exist yet returns a hard Postgres error (`42703`, confirmed directly against the live database during this session, not assumed) — which means `pending` silently resolves to `null` and the cron's early-return path fires, i.e. **all pending SMS sends silently stop going out**, for every dog, until the migration runs. This must be run in Supabase *before* (or in the very same window as) this code goes live — not casually afterward. This is exactly the class of bug the Aug 20 weight-migration incident already taught this project to watch for.

**Verified live, against real (test) Supabase data, local dev server run under `TZ=UTC` matching production:**
- Created one owner with two dogs (Bailey, Max), both past their baseline period with no check-ins yet. Ran `/api/test-churn-detection`: log output confirmed **exactly one** combined email was sent ("Combined churn alert email sent to \[address\] for Bailey and Max"), not two separate sends — the actual bug this stage exists to fix.
- Loaded `/checkins/:owner_id` directly and confirmed all three status states render correctly against real data: "Week 2 check-in is ready" with a working `/check-in/:dog_id` link (verified via the rendered `href`, not just the visible label), "Week 2 — already checked in ✓" with a dashboard link after inserting a real check-in, and "First check-in available in 7 days" after resetting a dog's `created_at` to simulate a fresh signup.
- The SMS-sending cron's new combining logic and `buildCombinedSmsBody` could not be exercised end-to-end locally, since it depends on the not-yet-run `sms_queue.owner_id` migration — verified by code review and by directly confirming the Postgres error described above, rather than by a live send. Worth one more real pass (create 2 dogs under one owner, force both into the missed-check-in window, confirm one combined text arrives) once the migration is live.
  - **Update (Aug 22, follow-up session):** migration run, live pass completed. First attempt showed two separate sends with two different `twilio_sid`s and unfused individual text — traced to a stray, already-running `node server.js` process (left over from earlier local work) racing the fresh test server against the same live Supabase `sms_queue`, each grabbing one row before the other could group them. A full process sweep (confirmed zero `node.exe` running) followed by one clean instance produced the correct result: one Twilio call, both `sms_queue` rows sharing the identical `twilio_sid`, fetched-back body confirmed as `"Bailey & Max have check-ins ready: {checkins link}"`, 1 segment. This is now the source of the standing CLAUDE.md rule to check for and kill stray node processes before any local test run.
- Found and cleaned up one stray leftover test dog (`DogTest`) from an earlier session's Stage 3 verification that hadn't actually been fully cleaned up as that session's notes claimed — removed along with this session's own test data. All tables confirmed back to zero rows afterward.

**This is the core fix landing:** a multi-dog owner who goes quiet now gets one email mentioning all their overdue dogs instead of a separate email per dog, and — once the pending migration is run — a combined text with one link instead of a flurry of individual reminders on the same day.

---

### Stage 5 — Owner session + dashboard switcher ✅ Complete (Aug 22)

**Locked decision, stated by John before any design work started, non-negotiable:** the owner session is additive-only, never gating. `/dashboard/:dog_id` must show exactly what it shows today — full dog data, no login wall, no block of any kind — for anyone with no session (no cookie, expired cookie, different device, an old bookmark). This directly protects an already-shipped feature: sharing a dashboard or Journey Summary link with a vet or family member, built earlier in the project specifically to need no login. A vet will never have an owner session and must still be able to open a shared link and see the dog's data. The explicit anti-pattern to avoid: writing the route as "get session → if none, reject → query dog → render," which would accidentally make session mandatory for the whole page as a side effect of building the switcher.

**Investigation, done first:**
- Journey Summary is not a separate route — it's a client-side modal (`journeySummaryModal`) rendered inside `/dashboard/:dog_id` itself, populated from data the dashboard route already loaded. This meant Stage 5's entire surface area is really just the one route, not two.
- `/verify` (both the new-owner and returning-owner branches) already resolves `ownerId` before its final `res.redirect('/dashboard/${dogId}')` — this is the one point in the app where the browser has just proven real phone ownership (a valid, single-use, time-limited magic-link click), the same trust bar everything else in the app already uses. No new verification mechanism needed, and no changes to `magic_link_tokens` — this resolves the open question Stage 1 flagged about needing "a materially different, owner-scoped token payload" more simply than expected: a session cookie is just set as a side effect of the existing verify success, not a second token system.
- The codebase already has an established cookie idiom to match: `SITE_UNLOCK_COOKIE` plus a shared `parseCookies(req)` helper (both near the top of `server.js`) — httpOnly, `sameSite: 'lax'`, plain value, no session-store dependency. Stage 5 reuses this exact shape rather than introducing a new pattern.
- The dashboard route already does `select('*')` on the dog by `dog_id`, so `dog.owner_id` is available for the session-match check at zero extra query cost on the unconditional base render.

**One real edge case surfaced during investigation, confirmed with John before building:** a *valid* session cookie for a *different* owner than the dog being viewed must also render with no switcher — not just an absent/expired cookie. Example: a vet has their own dog and their own session on their own device, then opens a client's shared dashboard link. If the switcher rendered for "any valid cookie," it would stitch the vet's own dog list onto the client's shared page — wrong data in the wrong context, and a minor leak of the vet's own dogs into an unrelated share. Confirmed: the check must be "cookie's owner_id equals `dog.owner_id` for the dog on screen," not merely "cookie present." Any mismatch behaves identically to no cookie at all.

**Other decisions, confirmed with John before building:**
- Cookie duration: 90 days, **sliding** — refreshed on every render where a valid, matching session is used, not counted down from a fixed grant time. An owner who keeps visiting effectively never sees the switcher lapse; one who doesn't simply stops getting the convenience, never a functional loss either way (consistent with "additive-only").
- Add a simple "Not your device? Clear saved account" link, shown only when the switcher itself renders, POSTing to a new `/api/clear-owner-session` endpoint that clears the cookie. Given the cookie never gates access to anything, clearing it only ever removes the bonus switcher on future visits.

**What got built, all additive on top of the unchanged dog fetch/render:**
1. `OWNER_SESSION_COOKIE` (`cc_owner_session`) + `setOwnerSessionCookie(res, ownerId)` helper (90-day sliding `httpOnly`/`sameSite: 'lax'` cookie, matching `SITE_UNLOCK_COOKIE`'s shape) and `buildDogSwitcherHtml(ownersDogs, currentDogId)` — a horizontal pill-tab strip, one tab per dog (photo + name), the current dog highlighted in the brand color, others neutral, each linking to that dog's own `/dashboard/:dog_id`.
2. `/dashboard/:dog_id`: right after the existing, unconditional dog fetch (nothing above this point changed), a new block parses cookies, and **only** if `sessionOwnerId === dog.owner_id`, refreshes the cookie (sliding renewal) and queries `senior_dogs where owner_id = sessionOwnerId`. If that owner has more than one dog, `dogSwitcherHtml` gets built and spliced into the header next to the existing "+ Add Another Dog" / "View All My Dogs" links; otherwise it stays `''` and the page is byte-for-byte what it was before this stage. No other code path in the route was touched.
3. `/verify`: `setOwnerSessionCookie(res, ownerId)` added immediately before the existing `res.redirect`, covering both the new-owner and returning-owner branches since `ownerId` is resolved either way by that point.
4. `/api/add-dog`: same grant/refresh added before its JSON response — belt-and-suspenders alongside `/verify`, not a second mechanism, since this route is only ever reached from a link the owner already holds.
5. `POST /api/clear-owner-session`: clears the cookie, used by the new "Not your device?" link.

**Verified live, local dev server (`TZ=UTC`), after applying the new standing CLAUDE.md rule to kill any stray `node.exe` first:**
- **No cookie at all, viewing Bailey's dashboard:** full page rendered ("Bailey's Mobility Dashboard" present), zero occurrences of the switcher's "Not your device" marker — the critical no-regression check for the vet/family sharing behavior this stage must not touch.
- **Matching session cookie (owner A, who has two dogs Bailey and Max), viewing Bailey's dashboard:** switcher rendered with both dogs; Bailey's tab carried the active brand-color style, Max's the neutral style — confirmed via the actual rendered `style` attributes, not just presence/absence.
- **Owner A's session cookie, but viewing owner B's dog (Rex) — the cross-owner mismatch case:** Rex's full dashboard rendered normally, zero switcher markup, zero leaked `/dashboard/:dog_id` tab links of any kind. This is the direct, adversarial-style proof of the locked decision and the confirmed edge case both holding under real conditions.
- **Sliding renewal:** a matching valid render re-issued `Set-Cookie: cc_owner_session=...; Max-Age=7776000; HttpOnly; SameSite=Lax` (7776000s = 90 days) on every request, not just at grant time.
- **`/api/clear-owner-session`:** confirmed it issues an immediately-expired `Set-Cookie` correctly.
- **`/api/add-dog`:** confirmed it also sets/refreshes the same cookie on a real add-dog call.

All test data (2 owners, 4 dogs across both) cleaned up afterward; tables confirmed back to zero rows.

**This is the core deliverable landing:** a returning multi-dog owner now gets a real, low-friction way to move between their dogs' dashboards — while every already-shipped no-login sharing path (vet links, family links, old bookmarks) is provably untouched, not just assumed safe.
