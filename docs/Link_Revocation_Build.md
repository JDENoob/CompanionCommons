# CompanionCommons — Link Revocation & Access-Token Build
**Started:** September 3, 2026
**Status:** Phases 1–3 complete — code written, and fully live-verified end to end, including both dependency migrations (`migration_add_owner_access_token.sql`, `migration_add_owner_recovery_tokens.sql`) now run. No known unverified checks remain. Not committed as of this write-up. One deprioritized item tracked in the Backlog section at the end of this doc.
**Purpose:** Standalone tracking document for the link-revocation / recovery-flow project — replacing today's "possession of the raw `dog_id`/`owner_id` UUID equals full access" model with something that can be revoked, matching the pattern set by `Multi_Dog_Signup_Build.md` and `Health_Instrument_Redesign_Build.md`.

**Note on history:** a "Phase 1" was referenced once in passing in the Sep 2 Build Log entry for the `/api/get-all-dogs` removal ("Found in passing during the link-revocation Phase 1 audit"). That was an ad hoc scan that got redirected into the security-route cleanup (checklist items 37–39) and was never completed or written up as its own deliverable — no findings from it were ever recorded anywhere. This document supersedes that false start; the audit below was run fresh, from scratch, on Sep 3.

---

## The problem this project exists to fix

Every dashboard-family route in this app (`/dashboard/:dog_id`, `/check-in/:dog_id`, `/breed-guide/:dog_id`, `/checkins/:owner_id`, `/unsubscribe/:owner_id`, and several write-capable APIs) grants full access on nothing but knowledge of a raw UUID — no session, no proof of possession beyond having the string. This was a deliberate, documented design choice early in the project (a real product requirement: a vet or family member should be able to open a shared dashboard link with no login) and it's a reasonable one for *read* access to a single dog's data shared deliberately. But it has two real consequences that were never fully worked through:

1. **Nothing can ever be revoked.** Once a link has gone out (SMS, email, or shared by the owner themselves), it is valid forever — there is no way to invalidate one link without regenerating every dog's ID, which isn't realistic. If a link is ever leaked through some channel outside the app's control (a forwarded email, a screenshot, a compromised inbox), there is no recourse.
2. **Several of the routes carrying this same "UUID alone = access" pattern are not read-only.** `POST /api/add-dog`, `POST /api/upload-dog-photo`, and `GET /unsubscribe/:owner_id` all *change* real state on nothing but the UUID — see Finding 2 below for the full list and why the write-capable ones are a materially different risk than the read-only ones.

This project's actual scope (to be locked in Phase 2) is expected to be: introduce a real `access_token` per dog/owner that can be issued, rotated, and revoked, sent instead of (or alongside) the raw ID in every outbound link, while keeping the existing "no login required" product requirement intact — this is additive/revocable, not a login system, matching how the Aug 22 owner-session cookie was deliberately built as *additive* on top of the existing no-login model rather than replacing it (see `Multi_Dog_Signup_Build.md`, Stage 5). That precedent — a real session mechanism already shipped and already proven not to break the vet/family-share requirement — is the most relevant piece of prior art for Phase 2 to build from, not a fresh design.

---

## Phase 1 — Audit — ✅ Complete (Sep 3, 2026)

Pure investigation. No `.sql` file was written, no code was touched. Everything below was confirmed directly against the current `server.js` and the live Supabase schema, not inferred from older docs.

### Finding 1 — every place a dashboard/check-in/dog-specific link is constructed

Organized by where the link actually travels, since that's what matters for revocation — a link inside an SMS or email is the real risk (it leaves the app's control and can be forwarded/leaked); a link rendered inside a page the visitor already reached isn't a new exposure, it's just in-app navigation.

**Sent via SMS:**

| Link | File : Line | URL pattern | Notes |
|---|---|---|---|
| Signup/add-dog verification link | `server.js:7364` | `${BASE_URL}/verify?token=${token}` | **Already token-based, not ID-based.** Real 64-hex-char random token, 15-min expiry, single-use (`magic_link_tokens.used_at`). Not part of this project's problem — it's the existing pattern Phase 2 should look to for conventions (random token, not a raw row ID). |
| Proactive next-week reminder | `server.js:2961` | `${BASE_URL}/check-in/${dog_id}` | Queued immediately after a successful check-in, fires ~7 days later. |
| Missed-check-in reminder, tier 1 | `server.js:9179` (link built), `9198` (embedded) | `${BASE_URL}/check-in/${dog.id}` | Same `reminderCheckinLink` variable feeds all 3 tiers below — one construction site, three separate queued messages. |
| Missed-check-in reminder, tier 2 | `server.js:9179` (link built), `9218` (embedded) | `${BASE_URL}/check-in/${dog.id}` | |
| Missed-check-in reminder, tier 3 | `server.js:9179` (link built), `9238` (embedded) | `${BASE_URL}/check-in/${dog.id}` | |
| Combined multi-dog reminder (2+ dogs, same owner, same tier) | `server.js:9541` | `${BASE_URL}/checkins/${group[0].owner_id}` | Built in the SMS-sending cron's grouping pass; replaces the individual per-dog link above when 2+ sibling dogs are due for the same tier at once. |
| Resend-dashboard-link SMS | `server.js:8525` (link built), `8532` (embedded) | `${BASE_URL}/checkins/${owner.id}` | `POST /api/resend-dashboard-link` — reuses `/checkins/:owner_id`, doesn't build its own destination. |

**Sent via email:**

| Link | File : Line | URL pattern | Notes |
|---|---|---|---|
| Single-dog churn/re-engagement email | `server.js:8960` | `${BASE_URL}/dashboard/${dogId}` | `sendChurnAlertEmail`. |
| Combined churn/re-engagement email (2+ overdue dogs) | `server.js:9019` | `${BASE_URL}/dashboard/${dog.id}` | `sendCombinedChurnAlertEmail`, one link per dog block in the email. |
| Resend-dashboard-link email | `server.js:8525` (link built), `8543` (passed into `sendDashboardLinkEmail`) | `${BASE_URL}/checkins/${owner.id}` | Same `checkinsLink` as the SMS variant above — one construction, two channels. |
| Unsubscribe footer link (appears on both churn templates) | `server.js:8916` | `${BASE_URL}/unsubscribe/${ownerId}` | `buildEmailUnsubscribeFooter(ownerId)`. This is itself a **state-changing** link (see Finding 2) — worth Phase 2 treating with real care, since accidentally requiring a token here that then expires would silently break a real owner's ability to ever unsubscribe. |

**In-app navigation only (rendered inside an already-loaded page, never sent anywhere) — listed for completeness per the task's "any others found," but out of scope for token embedding since nothing here is a fresh exposure:**

| Link | File : Line | Context |
|---|---|---|
| Dashboard dog-switcher tabs | `server.js:901` | Only rendered when a matching owner-session cookie is already present (see Finding 2's note on the switcher) — genuinely gated, not a bare-UUID exposure. |
| "View Dashboard" (various confirmation/error screens) | `server.js:2011`, `2091`, `2329`, `4713`, `4898`, `8241` | Rendered after the visitor already has the dog's page loaded. |
| "Back to Check-In" / "View All My Dogs" | `server.js:5956`, `5958` | Same — rendered inside a page reached via a real (already-valid) link. |
| "Complete Week Update →" | `server.js:5991` | Rendered inside `/checkins/:owner_id`, one row per dog. |
| "Check In Now" action link | `server.js:8244` | Same page, different status branch. |
| `/verify` success redirect | `server.js:7877` | `res.redirect('/dashboard/${dogId}')` — happens server-side, after a real single-use token has already been validated. Not a link sent anywhere; it's the outcome of one.

**Medication-event banners — confirmed in-app only, correctly need no token embedding:**

Checked specifically per the task's ask. Both the check-in confirmation screen's inline prompt (`server.js:2298-2303`, `respondToMedOptIn()` at `2222`) and the dashboard's persistent pending-banner (`server.js:5528-5551`) call `POST /api/medication-response-windows/:id/respond` via same-origin `fetch()`, keyed on the response-window's own ID — never a `BASE_URL`-qualified link, never sent via SMS or email. Confirmed via a full grep for `medication_opt_in_prompt`/`medication-response-windows`/`medication_milestones` — every reference is either server-side JSON payload construction or a `fetch()` call embedded in HTML already being viewed. **Correctly out of scope for link-revocation token embedding**, exactly as the task predicted.

### Finding 2 — routes that grant access on `owner_id`/`dog_id` alone, no other validation

Every route below does the identical shape of check: pull an ID from the URL param or POST body, look it up with `.eq('id', <id>)`, and proceed if a row comes back. No session check, no secondary token, no proof of anything beyond "the caller typed/pasted the right UUID." Grouped by whether the route only *reads* or actually *writes* — the write-capable ones are the more urgent half of this list, since a leaked read-only link exposes one dog's data, but a leaked write-capable link lets a stranger *change* something.

**Read-only (exposure = one dog/owner's data, if the ID leaks):**

| Route | File : Line | Check |
|---|---|---|
| `GET /check-in/:dog_id` | `server.js:1955`, lookup `1960-1964` | `senior_dogs.eq('id', dog_id).single()` |
| `GET /breed-guide/:dog_id` | `server.js:4667`, lookup `4671-4675` | `senior_dogs.eq('id', dog_id).single()` |
| `GET /dashboard/:dog_id` | `server.js:5110`, lookup `5116-5120` | `senior_dogs.eq('id', dog_id).single()` |
| `GET /checkins/:owner_id` | `server.js:8187`, lookup `8191-8195` | `senior_dogs.eq('owner_id', owner_id)` — lists every dog for that owner |

**Write-capable (exposure = a stranger with the UUID can change real state, not just view it):**

| Route | File : Line | Check | What it changes |
|---|---|---|---|
| `POST /api/checkin-senior` | `server.js:2638`, `dog_id` from body, lookup `2733-2737` | `senior_dogs.eq('id', dog_id).single()` | Writes a real `mobility_checkins` row for that dog — someone with a leaked `dog_id` could submit fabricated weekly health data. |
| `POST /api/notes/:dog_id` | `server.js:4918` | **No existence check of any kind** — `dog_notes` insert fires directly off the URL param, not even confirming the dog exists first. The weakest instance of this whole pattern. | Inserts an arbitrary free-text note against that dog. |
| `POST /api/medications` | `server.js:4951`, `dog_id` from body, lookup `4968-4972` | `senior_dogs.eq('id', dog_id).maybeSingle()` | Adds a real medication row to that dog. |
| `POST /api/medications/:id/stop` | `server.js:5015`, lookup `5022-5026` | `medications.eq('id', id).maybeSingle()` — note: this is a *medication* ID, not `dog_id`/`owner_id` directly, but the same one-ID-no-other-check pattern one level removed | Marks a real medication stopped. |
| `POST /api/medication-response-windows/:id/respond` | `server.js:5071`, lookup `5080-5084` | `medication_response_windows.eq('id', id).maybeSingle()` — same one-level-removed pattern | Records a real opt-in/opt-out answer. |
| `POST /api/add-dog` | `server.js:7924`, `owner_id` from body, lookup `7973-7977` | `owners.eq('id', owner_id).maybeSingle()` | **Creates a brand-new dog (plus medications) under whichever `owner_id` is supplied.** Anyone holding or guessing a real `owner_id` can add a fabricated dog to a real owner's account. This is the most consequential single finding in this list — it's not "view data you shouldn't" or "edit one field," it's "attach new fabricated records to a real account." |
| `POST /api/upload-dog-photo` | `server.js:8757`, `dog_id` from body, lookup `8780-8784` | `senior_dogs.eq('id', dog_id).single()` | Overwrites `photo_url` for that dog. |
| `GET /unsubscribe/:owner_id` | `server.js:8355`, lookup `8358-8362` | `owners.eq('id', owner_id).single()` | **A `GET` request alone unsubscribes the real owner from all future email.** Worth flagging specifically: this is a state change triggered by a simple link visit (no POST, no confirmation step), reachable by anyone with the UUID — a real, if low-severity, nuisance vector (silently unsubscribing someone else's account by sending them a crafted link, or a link-preview bot/scanner pre-fetching the URL and triggering it unintentionally — a known general risk with GET-triggered state changes). Flagged for Phase 2/3 to weigh: keep GET for the sake of a zero-friction one-click unsubscribe (the current, deliberate design per the Sep 1 build), or require a token here too now that token issuance exists for other purposes anyway.

**Not part of this pattern, noted for completeness:** `POST /api/clear-owner-session` (`server.js:984`) takes no ID at all — it only clears whatever session cookie the caller already has. Not a candidate for token embedding.

**Existing precedent worth reusing, not reinventing:** the dashboard dog-switcher (`server.js:5110` route body, session-cookie logic from the Aug 22 multi-dog project) already does real proof-of-possession — it checks a signed, httpOnly session cookie's `owner_id` against the dog's own `owner_id` before showing the switcher, and is explicitly *additive* (absence or mismatch of the cookie never blocks the base page). This is the one place in the codebase today that isn't just "raw ID = access," and it was built specifically to avoid breaking the no-login vet/family-share requirement. Phase 2 should treat this as the existing playbook, not a separate concern to design around.

### Finding 3 — live schema confirmation (queried directly from Supabase, not inferred from docs)

Confirmed via a live, read-only introspection call against Supabase's PostgREST schema endpoint (`GET {SUPABASE_URL}/rest/v1/`, using the service-role key in-process — the key itself was never printed, only the resulting schema JSON, per the project's standing credential-handling rules) on Sep 3, 2026.

**`owners`** (10 columns):

| Column | Type | Required (NOT NULL) | Default |
|---|---|---|---|
| `id` | uuid, **PK** | true | `gen_random_uuid()` |
| `email` | text | true | — |
| `phone` | text | true | — |
| `preferred_contact_method` | text | false | — |
| `zip_code` | text | false | — |
| `preferred_reminder_day` | integer | false | — |
| `preferred_reminder_time` | text | false | — |
| `created_at` | timestamp (no tz) | false | `now()` |
| `name` | text | false | — |
| `email_opt_out` | boolean | true | `false` |

**`senior_dogs`** (37 columns): `id` (uuid, **PK**, `gen_random_uuid()`), `dog_name`, `breed`, `age_years`, `baseline_mobility_score`, `cohort` (default `senior-mobility`), `created_at`, `age`, `gender`, `baseline_notes`, `photo_url`, `weight_lbs`, `spayed_neutered`, `zip_code`, `diet_type`, `pet_insurance`, `treatment_category` (array), `preferred_reminder_day`, `preferred_reminder_time`, `baseline_energy_score`, `baseline_appetite_score`, `baseline_cognitive_score`, `phone`, `email`, `sms_consent` (default `false`), `longest_streak` (default `0`), `owner_id` (uuid, **FK → owners.id**), `consent_given_at`, `baseline_mobility_getting_up`, `baseline_mobility_stairs`, `baseline_mobility_stiffness_after_rest`, `baseline_mobility_walk_distance`, `baseline_cognitive_orientation`, `baseline_cognitive_memory`, `baseline_cognitive_interest`, `baseline_cognitive_sleep_wake`, `consent_policy_version`.

**No `access_token` (or any equivalently-named) column exists on either table today**, under any name — confirmed by reading the full live column list above, not just grepping for the literal string. This project's future `access_token` (or similarly-named) column will be a genuinely new addition in Phase 2, not a rename or a rediscovery of something already there.

### Finding 4 — `owners.email` uniqueness, confirmed empirically

`owners.phone` is already known to carry a real `UNIQUE` constraint (`migrations/migration_add_owners_table.sql:49` — `phone text NOT NULL UNIQUE`), and is the field the app already treats as the real dedup/lookup key (`/api/resend-dashboard-link` looks up by phone first, falling back to email only if no phone is submitted).

**`owners.email` carries no such constraint.** Confirmed two ways, not just one:
1. **Source of truth:** `migrations/migration_add_owners_table.sql:48` declares `email text NOT NULL` — no `UNIQUE` keyword, unlike the `phone` column two lines below it.
2. **Empirical, live test** (Sep 3, 2026): inserted a real disposable `owners` row with a test email and phone A, then inserted a second real row with the *identical* email and a different phone B. **Both inserts succeeded** — the second one was not rejected. Both rows were deleted immediately afterward and a follow-up query confirmed 0 rows remain with that test email. This directly rules out any live constraint the migration source might not have fully captured (e.g., a constraint added later by a hand-run `ALTER TABLE` that was never committed as its own migration file — this project has had exactly that kind of gap before, see the `mobility_check` legacy-constraint incident in `Health_Instrument_Redesign_Build.md`).

**Recommendation for the future recovery-page email-lookup path:**

Do not build an email-lookup path that assumes one email maps to one owner — it doesn't, today, and there's no guarantee John wants that changed (a shared household email across two separately-registered owners is a plausible real scenario this app has never had to think about, since `/api/resend-dashboard-link` already prefers phone specifically to sidestep this). Three real options for Phase 2 to decide between, not resolve silently:

- **(a) Keep phone as the sole real lookup key**, matching `/api/resend-dashboard-link`'s existing precedent, and treat any future "recovery by email" entry point as unsupported rather than building around the ambiguity. Simplest, and consistent with what's already shipped.
- **(b) If email lookup is genuinely wanted, handle multiple matches by fanning out**, not picking one arbitrarily — e.g., if a recovery request matches 2 owner rows by email, send a real link/token to *both* real associated phones/emails on file (never disclosing to the requester how many matched, same anti-enumeration posture `/api/resend-dashboard-link` already uses). More work, but doesn't silently drop or misdirect one of two legitimate accounts.
- **(c) Add a real `UNIQUE` constraint to `owners.email`** as part of the Phase 2 migration, if the product decision is that one email should only ever belong to one owner going forward. This is a real behavior change (an owner reusing an email across two signups — which the current schema silently allows — would start failing), and would need a decision on how to handle any already-existing duplicate emails in production data before the constraint could be added (today's live `owners` table should be checked for existing duplicates before this path is chosen, not assumed clean).

No recommendation is locked here — this is deliberately left as a real, named decision for Phase 2, not resolved as a side effect of the audit.

---

## Phase 1 status: ✅ Complete

All 4 requested findings are documented above, with file:line precision throughout. No `.sql` file was written. No route, schema, or shared helper in `server.js` was modified. Phase 2 (schema — the `access_token` column/table design, and the `owners.email` decision from Finding 4) has not started. Phase 3 (build — issuing tokens, embedding them in the links from Finding 1, adding token validation to the routes in Finding 2) has not started.

---

## Phase 2 — Schema + one standalone hardening fix — ✅ Complete (Sep 3, 2026)

Two parts, done in the order requested: a standalone route fix unrelated to the token system itself, then the schema migration (written, not run).

### Part A — `GET /unsubscribe/:owner_id` no longer mutates on a bare GET

**The gap, from Finding 2:** the route unsubscribed the real owner from all future email on nothing but a `GET` request completing — no confirmation step, no POST. A link-prefetching email client or a security scanner following every link in an email (a real, common behavior, not a hypothetical) would trigger the real unsubscribe without any human ever clicking anything.

**The fix:** split into two routes at the same path, `server.js:8355` (GET) and a new `server.js:8432` (POST):
- **`GET /unsubscribe/:owner_id`** now only reads (`owners.select('id, email_opt_out')`) and renders a page — never writes. Three real branches: unknown owner → the existing 404 page, unchanged; already opted out → the same terminal "You've been unsubscribed" page shown directly (skips a pointless re-confirmation for an action there's nothing left to confirm); not yet opted out → a new confirmation page with one `<form method="POST" action="/unsubscribe/${owner_id}">` and a single submit button.
- **`POST /unsubscribe/:owner_id`** carries the actual `email_opt_out = true` update — byte-for-byte the same update/logging/response logic the old GET handler had, just moved. Only reachable by an explicit form submission (or a deliberately crafted POST), never a passive link visit.
- `renderUnsubscribeDonePage()` extracted as a small shared function so the "already unsubscribed" short-circuit on GET and the real success response on POST render the identical page from one implementation, not two copies that could drift.

**Verified live**, not just by inspection — stray `node.exe` confirmed at 0 first, per standing rule, local dev server started (`b3codd83z`), one disposable test owner created directly via Supabase:
- `GET /unsubscribe/:id` on a fresh (not-yet-opted-out) owner: response contains the confirmation copy and `method="POST"`, not the success page. Queried the row directly afterward — `email_opt_out` still `false`, confirming the GET made zero database change.
- `POST /unsubscribe/:id` on the same owner: response shows the real success page; re-queried the row directly — `email_opt_out` now `true`.
- `GET /unsubscribe/:id` again, now that the owner is opted out: response shows the terminal "You've been unsubscribed" page directly, not the confirmation form — confirms the idempotent short-circuit branch.
- Nonexistent owner ID: both `GET` and `POST` correctly return `404`.
- Test owner deleted afterward, confirmed 0 remaining rows with that ID. Dev server stopped, confirmed 0 `node.exe` processes running afterward.

`node --check server.js` passes. Diff shown and reviewed before any commit — not committed yet as of this write-up (per standing project rule: commits happen only when explicitly requested).

**Scope note:** this fix stands on its own regardless of whether the access-token project ever ships — it closes a real GET-triggered state-change gap using the exact same trust model the route already had (owner_id alone), not the token system Part B below adds. Not dependent on Phase 3.

### Part B — `migration_add_owner_access_token.sql` — written, NOT run

File: `migrations/migration_add_owner_access_token.sql`. Adds exactly one column, `owners.access_token text NOT NULL DEFAULT gen_random_uuid()::text UNIQUE`, declared as a single `ADD COLUMN IF NOT EXISTS ... UNIQUE` statement — no separate backfill statement, no separate index statement, matching the request.

**`gen_random_uuid()` availability — confirmed, not assumed, and reported honestly about how:** Supabase's REST API has no path to query `pg_extension`/`pg_available_extensions` directly (this project has hit that same raw-SQL limitation before — see `Multi_Dog_Signup_Build.md` and the Build Log's Aug 20 weight-migration entry). What's confirmed instead is stronger than a metadata check: `owners.id` and `senior_dogs.id` **already** default to `gen_random_uuid()` (see Finding 3's live schema dump) and have generated real values on every single insert this project has ever made — including several disposable test rows created during this same session's Part A verification pass above. A function that has already executed successfully, repeatedly, on live inserts *is* the function being available — whether it's coming from Postgres core (built in since v13) or the `pgcrypto` extension (which Supabase enables by default on new projects either way) doesn't change that it works today. This reasoning is written directly into the migration file's own header comment, not just here, so a future reader doesn't have to take it on faith.

**Index:** confirmed, not assumed, that a `UNIQUE` constraint in Postgres always auto-creates a backing unique B-tree index — this is documented core Postgres behavior, not something specific to this schema. No `CREATE INDEX` was added. The migration's own verification block includes a `pg_indexes` query specifically so this gets confirmed for real once John runs it, rather than trusted from memory.

**The `owners.email` uniqueness decision from Finding 4 — recorded, not built.** Per direction: the recovery-flow account lookup will be phone-only (reusing the existing real `UNIQUE` constraint on `owners.phone`), with dual-channel *delivery* (send the regenerated/rotated link to both phone and email once the account is found by phone) still happening — email is a delivery channel here, never a lookup key. This needed no schema change and none was made. Recorded here so Phase 3 builds the recovery-page lookup against phone specifically, not email, and doesn't silently re-open the ambiguity Finding 4 flagged.

**Not done, deliberately, per instruction:** the migration has not been run against Supabase. No access-check route (any of Finding 2's list) reads or validates `access_token` yet — that's Phase 3. `senior_dogs` was not touched — the request scoped this column to `owners` only.

---

## Phase 2 status: ✅ Complete

Part A (the unsubscribe GET/POST split) was coded and verified live, then committed on its own (`7a9c964`) after a separate review pass — see that commit for the isolated diff. Part B (`migration_add_owner_access_token.sql`) was written, reviewed, and — per a later, separate confirmation — **has since been run** in Supabase; its live shape (column, auto-created unique index, RLS posture) was independently re-verified against the real database (empirical duplicate-token rejection test, real anon-key probes against a real row) before Phase 3 began building on top of it. Full detail in that verification pass, not duplicated here.

---

## Phase 3 — Build — ✅ Complete, not yet committed (Sep 3, 2026)

Builds directly on Phase 1's two findings and Phase 2's live `owners.access_token` column. Four parts, done in the order requested.

### The core access-control design (read this before the four parts below)

Every dog/owner-scoped route now authorizes on **token OR owner-session cookie**, not token alone. This wasn't optional scope creep — it's the mechanism that makes hard token validation deployable at all without breaking the app:

- **`authorizeOwnerScope(req, ownerId, providedToken)`** (new shared helper, next to the existing owner-session code) — checks the session cookie first (reusing the exact `sessionOwnerId === dog.owner_id` comparison the dashboard's dog-switcher already trusted), falling back to a live `owners.access_token` comparison. Returns the owner's real, current access_token on success (so the caller can embed it in its own page's internal links) or `null` on denial. A `null`/missing `ownerId` (an ownerless legacy dog — none live in this app today, per the Phase 1 audit) always denies, since there's no owner row to hold a token or session against.
- **Why the session fallback is necessary, not just convenient:** the Aug 22 owner-session cookie (`OWNER_SESSION_COOKIE`) was built to be purely additive — its own standing comment says "it never gates access to anything." Its only job was deciding whether to show a bonus dog-switcher. If token validation had been added as the *sole* gate, every link that cookie's own feature already relies on (the switcher's own tabs, "Back to Dashboard," the `/verify` success redirect, `/api/add-dog`'s post-signup redirect) would have broken the instant Phase 3 shipped, since none of them were ever built to carry a token. The OR-path preserves 100% of that existing behavior for a session-holder while still giving mailed/shared links something real to be gated on. **This is a deliberate design decision beyond the literal task wording, flagged here rather than applied silently** — the `OWNER_SESSION_COOKIE` block's own header comment was updated in the same diff to describe its new role honestly.
- **Scope actually touched, beyond the literal "6 link sites" / "12 routes":** making token validation *hard* on the 12 Finding-2 routes required propagating the resolved token into every internal same-app link/fetch those routes render too — the dashboard's own "Back to Check-In"/"View All My Dogs"/"+ Add Another Dog"/breed-guide-unlock/check-in-due links, the medication pending-banner buttons, the notes/checkin-senior/upload-photo fetch bodies, the `/checkins/:owner_id` and breed-guide pages' own back-links, and `add-dog.html` (a static file, updated to read `?token=` from its URL and forward it in its POST body). Skipping this would have meant a visitor who arrived via a mailed token link (no session cookie) hit a dead end on their very next click — breaking exactly the no-login vet/family-share model this project exists to protect. `withToken(path, token)` (new helper) is the one implementation used everywhere this was needed, so it can't drift per-callsite.
- **What did *not* need touching:** the dog-switcher's own tab links (`buildDogSwitcherHtml`) — those only ever render when a session cookie already matches, and clicking to a sibling dog carries that same cookie forward automatically (same owner_id), so the OR-path authorizes it with no token needed. Confirmed, not assumed, during live verification.

### Part 1 — the 6 mailed/emailed link-construction sites (Finding 1)

All 6 now embed the owner's live `access_token` via `withToken()`:

1. **Verification/magic-link** — unchanged (already token-based via `magic_link_tokens`, not in scope).
2. **Proactive next-week reminder** (`server.js`, `/api/checkin-senior`) — `nextCheckinLink` now resolves and embeds the token.
3. **Missed-check-in reminders, all 3 tiers** — one shared `reminderCheckinLink` construction (inside `evaluateDogForChurn`) now resolves the token once, used by all three queued messages.
4. **Combined multi-dog SMS reminder** (`buildCombinedSmsBody`) — token resolved once per group (every message in a group shares one owner, by construction).
5. **Single-dog churn/re-engagement email** (`sendChurnAlertEmail`) — token resolved once, used for both the dashboard link and the unsubscribe footer (see below).
6. **Combined churn email** (`sendCombinedChurnAlertEmail`) — token resolved once (shared owner across the group), used for every dog's link in the email plus the footer.

**A 7th link, not originally enumerated as one of the "6," got the same treatment for correctness:** the unsubscribe footer itself (`buildEmailUnsubscribeFooter`, appears on both churn templates) now also embeds the token — it's a real state-changing link (per Phase 2's GET/POST split) and would otherwise 403 for anyone without a session. **8th:** `/api/resend-dashboard-link`'s `checkinsLink` (used for both its SMS and email sends) — the owner lookup query was widened to also select `access_token`.

### Part 2 — the 12 access-check routes (Finding 2)

All 4 read-only and 8 write-capable routes now call `authorizeOwnerScope` (or, for the two routes keyed by a medication/window id rather than `dog_id`/`owner_id` directly, resolve the owning dog first, then call it) and return a distinct denial on mismatch — `403` + `renderLinkInvalidPage()` (HTML, pointing to `/recover.html`) for GET routes, `403 { success:false, code:'invalid_access_token' }` for POST/API routes — never a raw 500 or an unhandled crash.

**`POST /api/add-dog`, the explicitly prioritized one:** previously created a real dog (plus any submitted medications) under whatever `owner_id` was supplied in the body, with zero proof beyond knowing the UUID — the single most consequential finding in the whole Phase 1 audit. Now requires a matching token or session; verified live that a request with the real `owner_id` but a wrong or missing token is rejected before any row is written, while the identical request with the real current token passes the access check cleanly (confirmed by watching it proceed to real field-level validation rather than the access-denial branch).

**`POST /api/notes/:dog_id`** picked up a second fix in the same pass: it previously had no existence check *at all* (not even confirming the dog was real before inserting) — the dog lookup this access check requires now closes that gap as a side effect.

### Part 3 — public recovery flow

Phone-only lookup, per the Phase 1 Finding 4 decision (`owners.email` has no `UNIQUE` constraint — recorded, not re-litigated here). New table `owner_recovery_tokens` (`migration_add_owner_recovery_tokens.sql`, **written, not run**) — a short-lived (15 min), single-use token, deliberately **separate from `owners.access_token`**: recovery's job is getting someone back to their *existing* real link, not rotating it (rotation is Part 4's job, and doing both from the same mechanism would mean every recovery request silently invalidates any other link the owner — or a vet, or family member — might still have saved, which recovery has no business doing on its own).

- **`Public/recover.html`** — new static page, phone-only input (no email toggle, unlike the older `find-my-dashboard.html`, deliberately — this flow doesn't accept email as a lookup key at all), posts to `/api/recover-account`.
- **`POST /api/recover-account`** — reuses the exact rate-limiting pair already proven by `/api/resend-dashboard-link` (`resendLookupIpRateLimit` + `perContactRateLimit`) rather than inventing new limiters, same generic-response-regardless-of-outcome anti-enumeration posture. On a real match: generates a random 32-byte hex token, inserts it with a 15-minute expiry, then sends the **same token value** to both phone and email unconditionally (not gated by `preferred_contact_method` — recovery prioritizes deliverability over a stored preference).
- **`GET /recover`** — looks up the token, rejects (via the shared `renderLinkInvalidPage()`) if missing/expired/already-used, consumes it (`used_at`, with an `is('used_at', null)` guard specifically against a same-instant double-consume race — e.g. an email client prefetching the link at the same moment a real click lands), grants the same owner-session cookie every other real proof-of-ownership moment in this app grants, and redirects to the owner's real `/checkins/:owner_id` page with their **real, current** `access_token` embedded — handing back a working link, not a rotated one.
- **Deliberately left alone:** `find-my-dashboard.html` / `/api/resend-dashboard-link` — a different, already-shipped, complementary flow ("re-send my still-valid link") that continues to work unmodified. Recovery is for "my link stopped working entirely," most realistically after Part 4's regenerate button.

**Verified live in two passes, matching this project's established two-session pattern for every migration-gated feature.** First pass (migration not yet run): a real `POST /api/recover-account` call against a real disposable test owner returned the correct generic response and, per the server log, found the real owner and reached the exact expected failure point — `Could not find the table 'public.owner_recovery_tokens' in the schema cache` — confirming the rate-limiting, lookup, and token-generation logic were all correct before the table existed. `GET /recover` with a bogus token correctly rendered the invalid-link page rather than crashing.

**Second pass (Sep 3, 2026, after the migration ran), the real send → click → land sequence, fully exercised:**
- Confirmed `owner_recovery_tokens` reachable live before building anything on it.
- A real `POST /api/recover-account` against a real disposable owner (Twilio's reserved test number, `+15005550006` — guaranteed never to actually deliver, same number this project's own history already uses for this exact purpose) produced a real Twilio SID in the server log, confirming a genuine send attempt, not a stubbed one. The real generated token was read directly from the `owner_recovery_tokens` row (not guessed or reconstructed).
- `GET /recover?token=<real token>` returned a real `302`, with a `Set-Cookie` carrying the new HMAC-signed session format and a `Location` header of `/checkins/<owner_id>?token=<the owner's real, current access_token>` — confirmed the embedded token matched the owner's actual live `access_token` exactly, not a stale or reconstructed value. Following that redirect target directly returned a real `200` with the real test dog's name present in the response — a genuinely working landing page, not just a redirect that was never followed through.
- **Single-use, proven, not assumed:** the identical token, replayed a second time, returned `410`. Verified via direct query that this was because `used_at` was now genuinely set (timestamp matching the first successful request) — not a coincidental failure for some other reason.
- **Expiry, proven independently of the single-use check:** requested a second fresh token, backdated its `expires_at` to one minute in the past via a direct, disposable DB update (the only practical way to test a 15-minute expiry without waiting 15 real minutes), then confirmed `GET /recover` with it returned `410`. Verified via direct query that `used_at` was still `null` on that row — confirming the rejection came from the expiry check specifically, and that a rejected expired attempt does not incorrectly mark the token as consumed.
- All test data deleted afterward; **table-wide** `owner_recovery_tokens` row count confirmed at 0 — proof this pass is the only data that table has ever held since the migration ran, same rigor already established for `medications`/`medication_response_windows` earlier in this project.

### Part 4 — dashboard "Regenerate My Link"

**`POST /api/regenerate-access-token`** — deliberately authorizes on the **owner-session cookie alone**, not the token/session OR-path every other route uses. Reasoning, not just following the literal instruction: allowing a *token* to authorize its own replacement would mean anyone merely holding a copy of a mailed/shared link — exactly the scenario this button exists to defend against — could rotate the owner's real token themselves, silently invalidating it for the real owner without their knowledge or action. Session-cookie-only means rotation has to be a real, intentional act by someone who already proved ownership the same way this app has always proven it (completing signup, or a real recovery click) — not something a leaked link alone can trigger.

- Resolves the dog → `owner_id`, checks `ownerSessionMatches(req, dog.owner_id)` directly (not `authorizeOwnerScope`, since that would admit the token path this route specifically excludes), generates a new token via `crypto.randomUUID()` (same shape as the DB's own `gen_random_uuid()` default, so an application-level rotation looks no different from the original value), `UPDATE`s `owners.access_token`, and returns `new_dashboard_url` with the new token embedded.
- Dashboard button (`server.js`, rendered only inside the same session-matched branch that already gates the dog-switcher — no point showing a button that would just 403) calls it via `fetch()`, with a `confirm()` dialog first since this is a real, immediately-effective action that invalidates every other outstanding link (a vet's, a family member's, an old text) — not just a cosmetic toggle.

**Verified live, and this is the actual proof the whole project works:** with a real disposable test owner/dog — (1) the original token opened the dashboard successfully; (2) calling regenerate with no session cookie was correctly rejected (403); (3) calling it with a real matching session cookie succeeded and returned a genuinely new token; (4) **the original token, which worked one step earlier, was immediately rejected (403)**; (5) the new token worked. Old link revoked, new link live, in one real, observed cycle — not inferred from code review.

### Full live verification pass — what was and wasn't covered

Real dev server, stray `node.exe` confirmed at 0 first per standing rule. Two disposable owners/dogs (A and B, to test cross-owner isolation) created directly via Supabase.

**Confirmed, via real HTTP requests against the real running server, not assumed:**
- All 4 read-only routes: 403 with no token, 200 with the correct token, 403 with a wrong token, **403 when dog B's owner's real (but wrong-for-this-dog) token is used against dog A's dashboard** — no cross-owner leak.
- Session-cookie fallback: dashboard opens with zero token given a matching session cookie; **a session cookie belonging to a *different* owner viewing dog A's dashboard is correctly denied (403)**, not just ignored — the cross-owner guard holds under the new access-check logic exactly as it did for the switcher-only version.
- Internal link propagation: fetched the dashboard's own rendered HTML and confirmed its "+ Add Another Dog," "Back to Check-In," and "View All My Dogs" links all genuinely carry the resolved token in their `href`; fetched the check-in page's HTML and confirmed both `PAGE_ACCESS_TOKEN` and the `checkin-senior` fetch body's `access_token` field carry the real value.
- Write-capable routes, each with a real wrong-token 403 and a real correct-token success: `/api/checkin-senior` (a genuine check-in was saved — streak, week number, everything downstream worked), `/api/notes/:dog_id`, `/api/add-dog` (both a missing-token and a wrong-token attempt correctly blocked before any row was written; a correct-token attempt passed the access check and reached real field validation), `/api/medications`, `/api/medications/:id/stop`, `/api/medication-response-windows/:id/respond` (all three exercised against **real** medication/window rows created during this same pass, not just 404-on-nonexistent-id checks), `/api/upload-dog-photo` (confirmed reachable and still hitting its own pre-existing "no file uploaded" 400 correctly — the multipart file-upload path itself wasn't exercised, see below).
- Unsubscribe GET/POST: no-token 403 on both verbs; the GET's rendered confirmation form's `action` URL genuinely carries the resolved token; POSTing with that same token (mimicking the real form submit) succeeded.
- `/api/regenerate-access-token`'s full revoke-and-replace cycle (see Part 4 above).
- `/api/recover-account` and `GET /recover`, up to the pending migration at the time (see Part 3 above).

**Originally flagged as not exercised in this same pass — all 3 since closed, in later follow-up passes, not left open:**
- `/api/upload-dog-photo`'s access-check branch with a real file attached — closed same day, real PNG uploaded through it (wrong token correctly 403's before any storage write; correct token succeeds with a real `photo_url`, confirmed landed in Supabase Storage).
- `/breed-guide/:dog_id`'s two internal "Back to Dashboard" links, independently re-fetched — closed same day; needed a second test dog (the route's locked and unlocked states are mutually exclusive, so one dog only ever exercises one link) — both confirmed carrying the correct resolved token.
- The full recovery send → click → land sequence — closed Sep 3, 2026 after the migration ran; see Part 3's second verification pass above for the real send/click/land/reuse/expiry detail.

All test data (2 owners, 2 dogs, 1 medication, 2 medication_response_windows, 1 mobility_checkins row, 1 dog_notes row) deleted afterward; every table involved confirmed back to 0 remaining rows for those IDs by direct follow-up query. Dev server stopped, confirmed 0 `node.exe` processes running afterward. (The 3 follow-up closures above have their own separate cleanup/confirmation, noted in their own passes.)

### Not committed

Per instruction, nothing from Phase 3 has been committed — `server.js`, `Public/add-dog.html` (modified), and `Public/recover.html`, `migrations/migration_add_owner_recovery_tokens.sql` (new) are all sitting as pending changes for review.

---

## Phase 3 status: ✅ Code complete and live-verified (up to the pending migration) — not committed

The access-control redesign itself (Parts 1, 2, and 4) is fully built and fully verified live, including the actual end-to-end revoke-and-replace cycle. Part 3 (public recovery) is fully built and verified as far as the missing `owner_recovery_tokens` table allows — the real send/click/land sequence needs that migration run first, same two-session pattern this project has used for every prior migration-gated feature. Two real, separate action items before this can ship: (1) review and commit the code (this write-up), (2) run `migration_add_owner_recovery_tokens.sql`, after which a short follow-up pass should exercise the real recovery send/click sequence end-to-end, matching how every other migration-gated feature in this project has gotten its second verification pass once its migration landed.

---

## Phase 3 follow-up — session cookie forgeability, closed (Sep 3, 2026)

A real gap found in review of Phase 3, before anything was committed: `OWNER_SESSION_COOKIE`'s value was the bare, plaintext `ownerId` — unsigned. Two consequences, one asked about directly, one surfaced by investigating it:

1. **The question asked: does the cookie tie to `access_token` at all?** No. `setOwnerSessionCookie(res, ownerId)` just wrote `ownerId` verbatim; verification was `cookies[OWNER_SESSION_COOKIE] === ownerId`. Regenerating `access_token` (the "Regenerate My Link" button, Phase 3 Part 4) had zero effect on any session cookie already sitting in another browser — the actual lost/stolen-device scenario "Regenerate" exists to defend against kept full access after the button was clicked.
2. **What investigating it turned up beyond the question asked:** since `ownerId` is not itself a secret in this app (it's in plain sight in every `/checkins/:owner_id`/`/unsubscribe/:owner_id` link ever sent), and the cookie was unsigned, **anyone who had ever seen any link for a given owner could forge a valid session cookie themselves** (a raw `Cookie:` header, no access_token needed) and get full access through the session path — a real authentication bypass of the entire token system, inherited the moment Phase 3 made the session cookie an alternative full-access path rather than a pure UI convenience.

**Approach proposed and approved before any code was written** (per instruction): HMAC-sign the cookie, keyed by both the owner and their live `access_token`, using a secret that never leaves the server. Two naive alternatives were considered and rejected first — a cookie value built purely from `ownerId + access_token` (raw or hashed) ties to the token correctly, but a link-holder already has both inputs and could forge it themselves, which would also let a mere link-holder self-authorize `/api/regenerate-access-token` if that route ever trusted the same cookie shape (it deliberately doesn't accept a token at all, specifically to prevent this).

### What was built

- **New required env var, `SESSION_SIGNING_SECRET`** — a real 48-byte random value, generated with `crypto.randomBytes` and appended to `.env` (confirmed git-ignored via `git check-ignore` before writing; the value itself was never printed to any tool output or chat response, only its length). Added to `requiredEnvVars` so a deploy missing it fails loudly at boot rather than silently accepting unsigned/unverifiable sessions. **Railway needs the same variable added separately for production** — this is a real, separate action item, same category as `SUPABASE_SERVICE_ROLE_KEY`; nothing here can set that remotely.
- **Cookie value:** `${ownerId}.${signature}`, where `signature = HMAC-SHA256(`${ownerId}:${accessToken}`, SESSION_SIGNING_SECRET)` (`computeSessionSignature`, next to the cookie constants).
- **`setOwnerSessionCookie`** is now `async` — it looks up the owner's current `access_token` before signing, and sets no cookie at all if that lookup fails (no owner, no token) rather than minting something that could never verify. All 4 call sites (`/verify`, `/api/add-dog`, `/recover`, the dashboard's session-renewal branch) updated to `await` it.
- **`ownerSessionMatches`** is now `async`: parses `ownerId`/`signature` out of the cookie (a missing `.` — malformed, or a pre-signing-era plain-ownerId cookie — is rejected immediately, not crashed on), confirms the embedded `ownerId` matches the target (a plain, non-constant-time compare is fine here — `ownerId` isn't secret), fetches the *current* `access_token`, recomputes the expected signature, and compares via `crypto.timingSafeEqual` — **required, not optional**, per this project's own prior timing side-channel finding (Aug 29 audit, the `find-my-dashboard` lookup); a naive `===`/byte-loop here would have been the same class of bug a second time. Buffer lengths are compared before calling `timingSafeEqual` (which throws rather than returning `false` on a length mismatch) — this only leaks "was the length right," never anything about the signature's actual content, which is the part that has to stay constant-time.
- **`authorizeOwnerScope`** and the one other `ownerSessionMatches` call site (`/api/regenerate-access-token`) updated to `await` the now-async check.
- The `OWNER_SESSION_COOKIE` header comment and the "Denied only when neither is true" comment (which used to say the owner's session "keeps working right through the rotation" — that was the bug) both rewritten to describe the real, current behavior.

**Not touched, flagged rather than silently expanded into:** `authorizeOwnerScope`'s plain-token comparison (`realToken === providedToken`, comparing a caller-supplied `access_token` against the real stored value) is the same *class* of non-constant-time comparison, technically. Left alone — the task's scope was specifically the session-signature comparison, and access_token is a 36-char random UUID already transmitted in plaintext via SMS/email/URLs (unlike a password, it was never designed to resist being *seen*, only to be hard to *guess*), making a timing attack against it a materially different, lower-priority risk than the session-signature forgery gap just closed. Worth a look in a future pass, not silently fixed here.

### Live verification — all 4 required checks, against the real running server

Real disposable owner/dog, real session cookie minted via a genuine `POST /api/add-dog` call (captured with curl's cookie jar, not synthesized):

1. **Real cookie works normally** — `GET /dashboard/:dog_id` with zero token, only the real signed cookie: `200`.
2. **The actual bug, proven fixed, not just proven-to-compile:** confirmed the same cookie still returned `200` immediately before regenerating; called `POST /api/regenerate-access-token` (authorized by that same session cookie, per Part 4's design); **the identical cookie that worked one request earlier now returned `403`** on the very next request. The new token from the response's `new_dashboard_url` was independently confirmed to work. This is the literal scenario from the review finding — "another device with a lingering session" — closed and directly observed, not inferred.
3. **Forged/malformed cookies, all rejected, none crashed:** `ownerId` alone with no signature (`403`); `ownerId` + a made-up 68-char signature (`403`); `ownerId` + a same-length-but-wrong signature — the case that actually reaches `timingSafeEqual` (`403`); `ownerId` + a signature of the *wrong length* (`403`, confirming the length-mismatch guard fires before `timingSafeEqual` would throw); a cookie with no `.` separator at all — the old pre-signing format — (`403`, confirming old-format cookies fail closed rather than being silently accepted or crashing).
4. **`timingSafeEqual` confirmed on the execution path, plus a rough empirical check:** `grep` confirms `crypto.timingSafeEqual` is the sole comparison operator on the return path (`server.js`, inside `ownerSessionMatches`) — this is the reliable proof, not the timing numbers themselves, which at real network+DB latency (~300ms/request) can't meaningfully distinguish a constant-time compare from a naive one either way (the actual operation being timed is sub-microsecond). For a rough sanity check anyway: computed the real signature independently (in-process, using the same secret, values never printed), built a same-length "near-miss" (differs only in the final character — the case a naive early-exit loop would be slowest to reject) and a same-length "far-miss" (differs from the first character), and measured 40 real HTTP requests each. Median difference: **1.4ms on a ~305ms median request** (~0.5%) — no gross gap, consistent with (though not formal proof of) constant-time comparison; nothing resembling the clear per-character signal a genuinely naive compare would eventually show at scale.

All test data (1 owner, 2 dogs — the original plus one created via the `/api/add-dog` call used to mint the cookie) deleted afterward, confirmed at 0 remaining. Dev server stopped, confirmed 0 `node.exe` processes running. `node --check server.js` passes.

### Not committed

Same as the rest of Phase 3 — this fix is sitting in the same uncommitted `server.js`/`.env` state, pending review. `.env`'s new `SESSION_SIGNING_SECRET` line was never at risk of being committed (confirmed git-ignored before writing it), but is called out here since it's a real new deployment dependency Railway needs independently.

---

## Phase 3 — final closure: recovery flow, migration run (Sep 3, 2026)

`migration_add_owner_recovery_tokens.sql` has been run. The one remaining unexercised check from the original Phase 3 pass — the real recovery send → click → land sequence — is now fully closed; see Part 3's own section above (rewritten in place) for the complete real-request-by-real-request detail: a real Twilio send attempt (real SID logged), a real token read from the live table, a real `302` landing on a real, rendered `200` dashboard-list page carrying the owner's real current `access_token`, single-use enforcement proven via a real second attempt (`410`, `used_at` confirmed genuinely set), and expiry proven independently via a backdated `expires_at` (`410`, `used_at` confirmed still `null` — the rejection was genuinely the expiry check, not conflated with reuse). Table-wide `owner_recovery_tokens` count confirmed at 0 after cleanup.

**With this closed, every check flagged as "not exercised" anywhere in this document across all of Phase 3 is now resolved.** Nothing from the original build or its two follow-ups (session signing, recovery closure) remains unverified. Still not committed — that decision remains yours.

---

## Backlog — known, deliberately deprioritized, not lost

Real findings surfaced during this project's own work that were consciously not acted on, recorded here so they don't quietly disappear once this doc stops being actively read every session.

### `authorizeOwnerScope`'s access_token comparison uses `===`, not `crypto.timingSafeEqual`

Found while implementing the session-cookie HMAC signature fix (the "Phase 3 follow-up" section above) — the plain-token comparison `realToken === providedToken` inside `authorizeOwnerScope` is the same *class* of non-constant-time string comparison the session-signature fix was built to close.

**Deliberately left as `===`, not fixed alongside the signature comparison:**
- **Why:** `owners.access_token` is a 36-character random UUID that this app already transmits in plaintext by design — in every mailed/texted dashboard link, in email bodies, in URLs. Unlike a password (never meant to be seen, only known) or the session signature just fixed (a value that should never leave the server at all), the access_token's whole threat model is "hard to *guess*," not "resistant to being *observed*." A timing side-channel lets an attacker narrow down an unknown secret faster than brute force by exploiting *comparison* timing — but here the realistic attack path is guessing a 128-bit-equivalent random value outright, which a timing side-channel does essentially nothing to make more tractable (unlike the session signature bug, where the cookie's own plaintext `ownerId` gave an attacker a real, non-random anchor to iterate against). This is a materially different, much lower-priority risk than the session-cookie forgery gap that prompted the actual fix.
- **How to apply:** revisit if this app's threat model ever changes to include an attacker who can make a very large volume of precisely-timed requests against a single guessed-`ownerId`+partial-token combination cheaply (e.g., no rate limiting on the routes that accept a token) — worth checking against the current per-route rate-limiting posture (see checklist item 22, `/checkins/:owner_id` has none, though enumerating a full random 36-char token via timing would still require an impractical request volume even so). Not urgent; recorded so a future security pass doesn't have to rediscover it.

### `npm audit`: 3 moderate `qs` vulnerabilities via `body-parser` → `express`, no non-breaking fix available — RESOLVED Sep 4, 2026

Found during the pre-deploy security sweep of this build. `npm audit` reports 3 moderate-severity advisories in `qs` (array-limit bypass, a DoS via attacker-controlled `isBuffer`), pulled in transitively through `body-parser` → `express`.

**`npm audit fix` (run, not forced) made zero changes** — confirmed via `git diff --stat` showing no change to either `package.json` or `package-lock.json`. Root cause, traced before concluding "nothing to do": the patched `qs` version is `6.16.0`; the currently-installed, latest-available `body-parser@1.20.6` pins its own `qs` dependency to `~6.15.1`, which cannot resolve to `6.16.0` under normal semver rules. The only path to a genuinely patched `qs` is `body-parser@2.3.0`, which itself requires `express@5.x` — a major upgrade of this app's core web framework, well outside this build's scope, and not something to do as a side effect of a routine audit fix.

**Left open at the time, tracked with two real remediation paths — the second one taken:**
- **Force the Express 5 / body-parser 2 upgrade** (`npm audit fix --force`) — the complete fix, but a real breaking-change surface across every route in the app; needs a full regression pass before it's safe to run. Still not done, and deliberately not bundled into this fix — see below.
- **A targeted `overrides` entry in `package.json`** pinning `qs` to `6.16.0` directly while keeping Express 4 / body-parser 1.x otherwise unchanged — this is what was applied Sep 4, 2026.

**Resolution (Sep 4, 2026):** `"overrides": { "qs": "6.16.0" }` added to `package.json`, `npm install` run. Confirmed the override actually took, not just that install succeeded silently: `node_modules/qs/package.json` reports `"version": "6.16.0"`, and `npm audit` now reports 0 vulnerabilities (down from 3). Since this overrides `body-parser`'s own declared compatibility range rather than a change it or Express itself made, real verification was done rather than trusting a clean install alone: started the actual dev server and exercised both code paths in this app that route through `qs` — a real GET request with bracket/array-notation query params (`?a[b]=1&arr[]=x&arr[]=y`, the same shape the array-limit-bypass advisory concerns), and real POST requests with both a JSON body and an `application/x-www-form-urlencoded` body (`bodyParser.urlencoded({ extended: true })` is what pulls `qs` into the urlencoded-parsing path) — all returned correct, non-error responses, with zero errors in the server logs. Separately, called the pinned `qs` module directly (`qs.parse('a[b]=1&a[c]=2&arr[]=x&arr[]=y')`) and confirmed it produces the exact expected nested-object/array shape, not merely "didn't throw." `node --check server.js` passed and a clean local boot was confirmed before considering this closed.

**Explicitly not done as part of this fix, and not implied by it:** the Express 5 / body-parser 2 upgrade remains a separate, deliberately deferred future decision. This fix closes the specific `qs` advisory only — it does not revisit whether or when to move off Express 4.
