# CompanionCommons — Data Model Separation: Phase 1 Investigation
**Started:** September 4, 2026
**Status:** Phase 1 (investigation only) complete. No `.sql` file written, no code touched. Everything below is confirmed directly against the current `server.js` (10,441 lines) and the live schema as documented in `Link_Revocation_Build.md`'s Finding 3, not inferred from older docs or memory.
**Purpose:** Standalone tracking document for the identifiable/de-identifiable data-model separation project — flagged as a real architectural prerequisite since `CompanionCommons_Strategy_and_Legal_Aug20.md` Section 7 (medication data), reinforced in Section 12 (three-stream business structure), and named specifically in checklist item 7. This is the foundational work that has to exist before any future drug-name-level medication data, before predictive-model licensing can honestly claim "anonymized," and before an internal ops dashboard (see the companion `Internal_Ops_Dashboard_Build.md` investigation from this same session) can safely distinguish "who can see identity" from "who can see health data." Matches the tracking-doc pattern set by `Multi_Dog_Signup_Build.md` and `Link_Revocation_Build.md`.

---

## The problem this project exists to fix

`senior_dogs` is not just a health-data table with an `owner_id` foreign key bolted on — it directly stores a real chunk of owner-identifying data alongside the health data, duplicated from `owners` rather than joined to it: `phone`, `email`, `zip_code`, and `sms_consent` are all live columns on `senior_dogs` itself (confirmed in Finding 1 below), not looked up from `owners` when needed. This means today, "give me this dog's health data" and "give me this dog's owner's contact info" are the exact same query with the exact same access — there is no code path, no credential, and no database boundary that can honestly return one without the other. Any future claim that licensed/exported data is "anonymized" rests entirely on manual per-field discipline in application code (the existing free-text-export-ban pattern), not on the schema making the separation structurally true. This project's job is to make that separation real at the schema level, the way the medication tables (`medications`, `medication_weekly_updates`) were deliberately built "separation-compatible" from day one (see `migration_add_medications.sql`'s own header comment) — `senior_dogs` itself was never given that treatment, since it predates that discipline.

---

## Phase 1 — Audit — ✅ Complete (Sep 4, 2026)

### Finding 1 — every `senior_dogs` column that is itself owner-identifying, not just the `owner_id` FK

Confirmed against the live schema dump already recorded in `Link_Revocation_Build.md`'s Finding 3 (37 columns), cross-checked against real insert statements in `server.js`. **`owner_id` is not the only identity leak on this table — it's one of five:**

| Column | Type | Written at | Also independently duplicated on |
|---|---|---|---|
| `owner_id` | uuid, FK → `owners.id` | `/verify` (`server.js:8130`), `/api/add-dog` (`server.js:~8500`) | — (this is the FK itself) |
| `phone` | text | Same two insert sites, copied from `owners.phone` (or the pending token's staged value) at insert time | `sms_queue.phone` (see Finding 5) |
| `email` | text | Same two insert sites | `magic_link_tokens.email` (staging only, pre-dog) |
| `zip_code` | text | Same two insert sites | — |
| `sms_consent` | boolean | Same two insert sites | Read directly at `server.js:9969` (`dog.phone && dog.sms_consent`) for every reminder decision |

**Why this matters for scoping the rest of this project:** removing `owner_id` alone from `senior_dogs` would still leave `phone`/`email`/`zip_code`/`sms_consent` sitting directly on every health-data row. A query that fetches "this dog's mobility scores for the last 12 weeks" already, today, has the owner's phone number and email address sitting in the same result row — `owner_id` is the least of the four in terms of raw PII sensitivity (a phone number and email are directly, immediately identifying; a UUID foreign key requires a second lookup to become identifying). **The task's literal scope was `owner_id` specifically — this finding is reported because it directly determines what "no identity requirement" actually means in Finding 2's classification below.** A code path that reads `senior_dogs.select('*')` today gets all five identity-adjacent fields whether it asked for them or not, regardless of whether it also happens to read `owner_id`.

### Finding 2 — every site that reads or writes `senior_dogs.owner_id`, classified

22 total references to `.from('senior_dogs')` in `server.js`; `owner_id` is explicitly selected, written, or checked at the sites below (confirmed via direct read of each, not grep-count alone — one real site, `/api/add-dog`'s access check, uses `owner.id` rather than the literal string `owner_id` and was missed by a first-pass grep for the literal substring; recovered by cross-checking against `Link_Revocation_Build.md`'s own route inventory, which is the exact kind of gap this "confirm nothing's missed" instruction exists to catch).

**Writes (2 sites — both real dog-creation paths, no others exist):**

| Site | File:line | Needs identity? |
|---|---|---|
| `/verify` (magic-link signup completion) | `server.js:8100-8136` | **Yes, unavoidably** — this is the moment identity (the real owner row) and a new health record (the new dog row) first become linked. This is the one write that must resolve identity by construction, in any schema shape. |
| `POST /api/add-dog` | `server.js:8485-~8520` | **Yes, unavoidably** — same reasoning, second dog under an existing owner. |

**Reads — resolving `owner_id` *for an access-control decision* (13 of the 14 real `authorizeOwnerScope`/`ownerSessionMatches` call sites go through a `senior_dogs` or `medications` lookup first):**

| Route | File:line (current) | Resolves `owner_id` via |
|---|---|---|
| `GET /check-in/:dog_id` | `server.js:2143` route, `2149` lookup (`select('*')`) | Direct dog lookup |
| `POST /api/checkin-senior` | `server.js:2839` route, `2935` lookup (`select('*')`) | Direct dog lookup |
| `GET /breed-guide/:dog_id` | `server.js:4912` route, `4917` lookup (`select('*')`) | Direct dog lookup |
| `POST /api/notes/:dog_id` | `server.js:5170` route, `5183` lookup (`select('id, owner_id')`) | Direct dog lookup |
| `POST /api/medications` | `server.js:5218` route, `5237` lookup (`select('id, dog_name, created_at, owner_id')`) | Direct dog lookup |
| `POST /api/medications/:id/stop` | `server.js:5288` route, `5310` lookup (`select('owner_id')`) | **Indirect** — resolves `medication.dog_id` first, then `senior_dogs.owner_id` from that dog |
| `POST /api/medication-response-windows/:id/respond` | `server.js:5358` route, `5379` lookup (`select('owner_id')`) | **Indirect** — resolves `window.dog_id` first, same chain |
| `GET /dashboard/:dog_id` | `server.js:5408` route, `5415` lookup (`select('*')`) | Direct dog lookup |
| `GET /checkins/:owner_id` | `server.js:8596` route, `8601` lookup (`select(...).eq('owner_id', owner_id)`) | **This route already keys directly on `owner_id`, not `dog_id`** — the one access-checked route where "identity" is the primary key of the request, not a side lookup |
| `GET /unsubscribe/:owner_id` | `server.js:8778` route, direct `owners.eq('id', owner_id)` lookup | Not a `senior_dogs` read at all — this route never touches a dog row, only `owners` |
| `POST /unsubscribe/:owner_id` | `server.js:8858` route, same | Same — `owners` only |
| `POST /api/upload-dog-photo` | `server.js:9528` route, `9552` lookup (`select('id, owner_id')`) | Direct dog lookup |
| `POST /api/add-dog` | `server.js:8300` route, access check at `8396` via `owner.id` (owner already resolved by the earlier existence check at `8376-8380`) | **Not a `senior_dogs` read at all for the access check** — this route resolves identity from `owners` directly, since the dog doesn't exist yet |
| `POST /api/regenerate-access-token` | `server.js:9286` route, `9294` lookup (`select('id, owner_id')`), checked at `9302` | **A 14th checkpoint, calling `ownerSessionMatches` directly rather than `authorizeOwnerScope`** — deliberately session-only, not token-eligible, per the Phase 4 design rationale in `Link_Revocation_Build.md` (a leaked token must never be able to authorize its own replacement). Missed by an initial grep for `authorizeOwnerScope` specifically; recovered by grepping `ownerSessionMatches` directly and finding this second, real call site beyond the one inside `authorizeOwnerScope` itself. |

**This is 14 real, distinct authorization checkpoints, not the "12" figure `Link_Revocation_Build.md` states.** Reconciled, not just noted as a discrepancy: that doc's "12" is Finding 2's *original* pre-split count (4 read + 8 write, written before Phase 2 split the single `/unsubscribe/:owner_id` route into a GET-confirm + POST-mutate pair, and before this audit's own second pass found `/api/regenerate-access-token`'s direct `ownerSessionMatches` call, which the original doc's Finding 2 table never listed as a distinct row at all — its Part 4 section describes the route's *behavior* but Finding 2's own inventory table stops at the original 12). The real current total is 14 (5 read-only: check-in, breed-guide, dashboard, checkins, unsubscribe-GET; 8 write-capable: checkin-senior, notes, medications, medications-stop, medication-response-windows-respond, add-dog, upload-dog-photo, unsubscribe-POST; plus regenerate-access-token as a distinct 14th, session-only checkpoint). Not a bug in the existing doc — it accurately described the state its own Finding 2 table set out to cover — but this count matters for scoping Finding 7 below, so it's corrected here.

**Reads — resolving `owner_id` for a *product feature*, not access control:**

| Site | File:line | Purpose |
|---|---|---|
| Dashboard dog-switcher sibling query | `server.js:5489` (`select('id, dog_name, photo_url').eq('owner_id', sessionOwnerId)`) | Lists an owner's other dogs, once the viewer is already proven to be that owner (session cookie already matched) |
| Combined multi-dog SMS/churn grouping | `server.js:10260` (full dog list including `owner_id`), `10294` (groups by `alert.dog.owner_id`) | Groups sibling dogs' reminders/churn alerts into one message per owner — see Finding 5 |

**No reads found that need `owner_id` for a pure health-data purpose** — every single reference to `senior_dogs.owner_id` in the codebase exists either to answer "does this request have permission" or "which other dogs belong to this same owner." This is a genuinely clean picture: nothing in the actual health-tracking logic (score calculation, streak calculation, trend text, breed guide content, health alerts) ever reads `owner_id` for its own sake.

### Finding 3 — `senior_dogs.select('*')` is the real, larger exposure surface, not individual `owner_id` reads

Of the 22 `senior_dogs` references, **7 use a bare `select('*')`** (`server.js:2149, 2935, 4917, 5415`, plus the two inserts' `.select()` return value, plus the churn cron's earlier full-list query before it was narrowed at `10260`). Every one of these routes — the standalone check-in page, the check-in save endpoint, the breed guide page, the dashboard — pulls all 37 columns including `phone`, `email`, `zip_code`, `sms_consent`, and `owner_id` regardless of whether the route's actual downstream logic ever touches any of them beyond the one `dog.owner_id` reference the access check needs. **This is the real shape of the problem this project has to solve, more than the `owner_id` column specifically**: even a route that only ever *displays* `dog.baseline_mobility_score` and `dog.breed` today receives the owner's phone number and email address in the same query result, whether or not it's ever rendered. Separation has to change these `select('*')` calls to name explicit health/display columns, not just relocate `owner_id`.

### Finding 4 — everywhere else identity and health data currently sit in the same row/table

Beyond `senior_dogs` itself, three more tables carry the same pattern — identity fields living directly alongside operational data, rather than joined:

- **`sms_queue`** — carries `pet_id`, `owner_id`, **and `phone`** on every queued message row (`server.js:3185-3187`, `9983`, `10003`, `10023`). A message queue arguably *needs* a phone number to function (it has to know where to send the text), but today that need is met by copying `dog.phone` onto the queue row rather than resolving it at send-time from a single source of truth — meaning `sms_queue` is itself a third place a phone number lives, not counting `owners.phone`.
- **`magic_link_tokens`** — the pre-signup staging table, carries `email`/`phone`/`zip_code` directly (expected — there's no `owner_id` to link to yet at this stage, since the owner may not exist until `/verify` resolves it). Not a separation problem in the same sense as `senior_dogs`, since this table's entire purpose is temporary identity staging before a real account exists — flagged for completeness, not as a finding requiring the same fix.
- **`Google Sheets export`** (`buildSignupSheetsExtraColumns`, `server.js:1977-1988`) — reads `phone`/`zipCode`/`smsConsent` as plain function parameters, sourced directly from the `senior_dogs` row (or the pending token) at write time, not via any join. This confirms the Sheets export's known design (per the standing "free text never reaches the B2B/licensing export" rule, and the Aug 31 audit that added these very columns) already treats `senior_dogs` as its single source for both health and identity data in one row — exactly the coupling this project needs to break.

**Tables already clean, confirmed by direct read, not assumed:** `mobility_checkins` (keyed by `dog_id` only, no identity field of any kind — confirmed via its real insert/select statements around `server.js:2989-3009`), `dog_notes`, `health_alerts`, `medications`, `medication_weekly_updates`, `medication_response_windows` — all built or already-known "separation-compatible" (the medication tables explicitly say so in their own migration header comment). These are the model to match, not the problem to fix.

### Finding 5 — the churn/reminder system is the single largest identity-and-health consumer in the app, and it's structurally reasonable that it is

`evaluateDogForChurn`, `sendChurnAlertsForOwnerGroup`, and the SMS-queue grouping pass (`server.js:~9950-10370`) read `dog.phone`, `dog.email`, `dog.sms_consent`, `dog.owner_id`, `dog.dog_name`, `dog.baseline_mobility_score`, and `dog.created_at` all in the same pass, for every dog, on every cron tick. This is not a design flaw — a reminder system's *entire job* is "resolve identity, decide based on health-adjacent state (did they check in this week), then contact the identity." Any real separation has to keep this exact join reachable in one place; the goal isn't to make the reminder system stop knowing phone numbers, it's to make every *other* code path (dashboard display, breed guide, Sheets export, a future ops dashboard's health-only reports) not need to.

---

## Finding 6 — classification: what breaks vs. what's unaffected, by category

| Category | Sites | Needs identity resolution? | Impact of moving `owner_id`+identity fields off `senior_dogs` |
|---|---|---|---|
| **Access control** (14 checkpoints, Finding 2) | `authorizeOwnerScope`, `ownerSessionMatches`, every route listed above | **Yes, structurally** — this is literally what the whole link-revocation system exists to check | **Real rework required** — every site currently reads `dog.owner_id` off an already-fetched `senior_dogs` row for free; under separation, each would need a second query against the new linkage table. See Finding 7. |
| **Dog-creation** (2 sites) | `/verify`, `/api/add-dog` | **Yes, unavoidably** | Insert becomes two writes (a `senior_dogs` health-only row, plus a linkage-table row) instead of one — a real but mechanical change, not a design problem. Both already resolve a real `owner_id`/owner row before inserting, so the linkage insert has everything it needs at the same moment. |
| **Health display/computation** (dashboard body, breed guide, Journey Summary, streak/trend logic, health alerts) | All of `mobility_checkins`/`dog_notes`/`health_alerts` logic, plus the health-data portions of every dashboard-family route | **No** | **Unaffected**, once the `select('*')` calls (Finding 3) are narrowed. This is the majority of the app's actual logic and it never needed identity in the first place. |
| **Sibling-dog features** (dog-switcher, combined SMS/churn grouping) | `server.js:5489`, `10260`, `10294` | **Yes** — "find this owner's other dogs" is inherently an identity-keyed query | **Real but contained rework** — both already explicitly select `owner_id` for exactly this purpose; under separation they'd query the linkage table instead of `senior_dogs.eq('owner_id', ...)`. Same shape of change, different table. |
| **`GET /checkins/:owner_id`** | `server.js:8596-8601` | **Yes** — the route's entire purpose is "list this owner's dogs" | Same as above — becomes a linkage-table query instead of `senior_dogs.eq('owner_id', owner_id)`. |
| **Reminder/churn system** | Finding 5 | **Yes, and appropriately so** | **Rework required, but concentrated** — this is already the one place in the app that legitimately needs both identity and health-adjacent state together; separation should make this the *designated* join point, not eliminate it. |
| **Google Sheets export** | `buildSignupSheetsExtraColumns` | **Yes, currently** | Needs its own explicit linkage-table lookup at write time, replacing today's "just read it off the same row" shortcut. Real but small — one function, two real call sites (`/verify`, `/api/add-dog`), both of which already have the owner row in hand at insert time regardless. |
| **Governance/stats, future ops dashboard health-only reports** | `/api/governance/stats` (`server.js:7308-7368`) | **Mostly no** — signup count, SMS opt-in rate, check-in count are all countable without ever resolving an individual identity | **Unaffected for aggregate counts.** `smsOptInRate` specifically reads `senior_dogs.sms_consent` directly (`server.js:7333-7336`) — under separation this would need to move to wherever `sms_consent` actually lives (see the open question in Finding 8), but stays a pure count, never resolves to an individual owner. |

---

## Finding 7 — what changes in `authorizeOwnerScope` and the link-revocation flow, and how big that rework actually is

**The core mechanism (`authorizeOwnerScope`, `ownerSessionMatches`, `getOwnerAccessToken`, `computeSessionSignature`, `server.js:880-1049`) does not need to change its own logic at all.** It already takes `ownerId` as a parameter, resolved by the *caller* — it has no idea today whether that `ownerId` came from `dog.owner_id`, a URL param, or anywhere else. This is a real, structural advantage: the access-control layer is already decoupled from *how* identity gets resolved, only *that* it gets resolved before being handed in.

**What actually changes is every call site's own dog-lookup step — 14 of them (Finding 2), plus the 2 write sites, plus the 2 sibling-dog sites (Finding 6).** Each one currently does the equivalent of:

```js
const { data: dog } = await supabase.from('senior_dogs').select('owner_id').eq('id', dog_id).maybeSingle();
// ... await authorizeOwnerScope(req, dog.owner_id, providedToken)
```

Under separation, this becomes a second query against the new linkage table:

```js
const { data: dog } = await supabase.from('senior_dogs').select('id, dog_name, ...health fields...').eq('id', dog_id).maybeSingle();
const { data: link } = await supabase.from(LINKAGE_TABLE).select('owner_id').eq('dog_id', dog_id).maybeSingle();
// ... await authorizeOwnerScope(req, link?.owner_id, providedToken)
```

**This is real, mechanical rework across every one of the 14+4 sites, not a small patch** — every one needs a second round-trip added, and every `select('*')`/`select('id, owner_id')` needs to drop `owner_id` from its own query (Finding 3). But it's *uniform* rework — the same two-line change, repeated, not eighteen different problems. The honest sizing: **a real, multi-site but low-conceptual-risk refactor**, closer in shape to the original Phase 3 link-revocation build (many call sites, one repeated pattern, `withToken()`-style shared helper worth extracting) than to a novel design problem. A natural mitigation, worth proposing directly rather than leaving implicit: **a single shared helper, e.g. `getOwnerIdForDog(dogId)`, wrapping the linkage-table lookup** — exactly the same "one implementation everywhere this was needed, so it can't drift per-callsite" discipline `withToken()` already established in the link-revocation build, reused here rather than reinvented.

**One real design fork worth flagging now, not discovered mid-build:** should `senior_dogs.select('*')`-style routes fetch health data and resolve identity as two *sequential* queries (simple, two round-trips, matches the existing codebase's style throughout — no route in this app currently does a single joined query across tables), or should the linkage lookup be batched/cached per-request where a route needs it twice (none currently do, but worth checking during Phase 2 design rather than assuming)? Recommendation: sequential, matching every existing pattern in this codebase — this app has never used PostgREST's embedded-resource join syntax (`select=*,owners(*)`) anywhere, and introducing it for the first time specifically on the most sensitive table would be a bigger, riskier change than two plain queries.

---

## Finding 8 — proposed new linkage table shape, and why its access control has to be reasoned about differently than "another RLS-enabled table"

### Shape

```sql
CREATE TABLE IF NOT EXISTS owner_pet_links (
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,
  dog_id   uuid NOT NULL REFERENCES senior_dogs(id) ON DELETE CASCADE,
  created_at timestamp DEFAULT now(),
  PRIMARY KEY (dog_id)  -- one owner per dog, matching today's 1:1 owner_id FK exactly; NOT (owner_id, dog_id), since dog_id must stay unique
);
```

Deliberately minimal — three columns, nothing else. No `updated_at` (a link, once made at dog-creation, is never edited in today's app — a dog is never reassigned to a different owner anywhere in the current product). `ON DELETE RESTRICT` on `owner_id` and `ON DELETE CASCADE` on `dog_id` exactly mirror the existing `senior_dogs.owner_id` FK's own current behavior (confirmed in `Multi_Dog_Signup_Build.md`'s Stage 2 progress log: `RESTRICT`, chosen specifically so deleting an owner with linked dogs fails loudly rather than silently orphaning them) — separation should not silently change this safety behavior as a side effect.

**Table name:** `owner_pet_links`, matching the task's own suggested name and this project's existing naming convention (`snake_case`, descriptive, no abbreviation) — no better alternative found worth proposing instead.

### Why "the same RLS pattern as every other table" is not actually meaningful protection here — a finding, not just a caveat

Every table in this schema, including `owners` and `senior_dogs`, currently has RLS **enabled with zero policies** (the Aug 26 RLS remediation — see `CompanionCommons_Build_Log.md`'s Aug 26 entry). This works today because the entire application runs on exactly **one** Supabase client, authenticated with the **service role key**, which bypasses RLS unconditionally by design (Postgres RLS has no effect on a role with `BYPASSRLS`, which the service role carries). There is no second, lower-privilege credential anywhere in this codebase's real request path — every single line of `server.js`, including the purely health-data-display routes, uses the same `supabase` client constant declared once near the top of the file.

**This means: adding RLS policies to `owner_pet_links` alone — even genuinely restrictive ones — provides zero additional real-world protection against this app's own backend**, because the backend's one and only database credential bypasses RLS entirely, on every table, already. RLS in this architecture only ever protected against a *different* threat (a browser using the anon key directly, which the Aug 26 audit confirmed had never happened and structurally couldn't, since no client-side Supabase usage exists anywhere in `Public/*.html`). Proposing "the linkage table just needs its own RLS policy" would be describing a control that sounds stricter but isn't, given how this app is actually built — worth stating plainly rather than recommending something with no real teeth.

**What would actually make this table's access control stricter, genuinely, not just nominally — two real options, neither built here, both flagged for a real decision in Phase 2:**

1. **Introduce a second, deliberately lower-privileged Supabase client (or a second, narrower Postgres role) reserved for code paths that only ever need health data** — dashboard display, breed guide, Journey Summary, streak/trend computation, the future ops dashboard's health-only reports. This second client would have genuine RLS enforcement against it (real `GRANT`/`RLS` policies denying `owner_pet_links` and `owners` outright), while the existing service-role client stays reserved for the genuinely-identity-needing code paths (signup, access control, reminders, recovery). This is the only approach that makes "stricter than everything else" true in a way that actually constrains *this app's own code*, not just a hypothetical external attacker who was never the real threat model here (per the Aug 26 finding). This is a real architectural change — a second client/role/credential to manage, provision in Railway, and keep in sync — sized as its own Phase, not a one-line addition to a migration file.
2. **Short of that, treat `owner_pet_links` as a documented invariant, enforced by code convention and review, not by the database**: a standing rule (matching the project's existing "free text never reaches the B2B export" pattern) that this table is never read by anything outside the small, named set of functions Finding 7 identifies (`getOwnerIdForDog`, the two dog-creation sites, the sibling-dog/churn-grouping sites), and never joined into any Sheets-export or future licensing-export query, full stop — with a code comment on the table's own migration file stating this as plainly as the medication tables' own header comment states their scoping rules. This is real today, achievable immediately, and is honestly closer to how this project already protects sensitive things in practice (the free-text export ban is exactly this kind of convention-enforced rule, not a database-enforced one).

**Recommendation for Phase 2 to decide, not resolved here:** option 2 is realistic to build alongside the rest of this project; option 1 is the only version of "genuinely stricter" that's real rather than cosmetic, but is a substantially larger architectural undertaking (a new credential, new provisioning, and — critically — auditing every existing route to confirm which client it should actually use) that probably deserves to be its own later phase, informed by whether this app's threat model ever changes enough to need it (e.g., a future contractor/employee getting narrower read-only DB access, which does not exist today). Building option 1 now, before it's needed, risks the same "sounds secure, isn't actually load-bearing yet" trap already identified above.

### Owner-scoped uniqueness

No `UNIQUE` constraint needed beyond the `PRIMARY KEY (dog_id)` already declared — since a dog belongs to exactly one owner (today's product model, confirmed nowhere in the app allows a dog to be reassigned or shared across owners), `dog_id` as the primary key is both the identity of the row and the uniqueness guarantee. `owner_id` intentionally has no uniqueness constraint of its own — one owner legitimately has multiple dogs (the entire premise of `Multi_Dog_Signup_Build.md`).

---

## What this investigation deliberately did not do

Per instruction: no medication/drug-name schema was proposed (that's explicitly a later phase, once separation exists to build safely on top of — the existing medication tables already demonstrate what "separation-compatible from day one" looks like, and are the template, not something needing rework here). No migration file was written. No `server.js` code was touched. No decision was made on the `owners.email` uniqueness question (already a separate, explicitly-deferred item from `Link_Revocation_Build.md`'s Finding 4 — unrelated to this project, not re-litigated here).

---

## Phase 1 status: ✅ Complete

All 8 findings above are documented with file:line precision throughout, cross-checked against `Link_Revocation_Build.md` where their scopes overlap (and one real discrepancy in that doc's own route count reconciled, not silently repeated). Phase 2 (locking the `owner_pet_links` schema decision, the RLS/credential-separation question from Finding 8, and the `getOwnerIdForDog`-style shared-helper design from Finding 7) is complete — see below. Phase 3 (writing and running the actual migration, the real call-site rework) has not started.

---

## Phase 2 — Target Schema & Rework Proposal — ✅ Complete (Sep 4, 2026)

**Proposal only. No `.sql` file written, no `server.js` code changed.** Every code sketch below is illustrative of the proposed shape, not a diff to be applied.

### A correction, made before proposing anything, not glossed over

Phase 1's Finding 3 stated "7 use a bare `select('*')`." That count was wrong, caught while verifying exact column needs for this Phase — **the real number is 4.** Two things inflated the original count: the two dog-creation inserts' trailing `.select()` (with no argument) were miscounted as `select('*')`-style over-fetches, when they're actually just confirming the row that insert statement itself just wrote (a different, smaller concern — addressed in its own subsection below, not conflated with the display-route problem); and a vague, inaccurate parenthetical about "the churn cron's earlier full-list query" that doesn't correspond to any real unnarrowed site (the churn cron's actual query, `server.js:10260-10261`, was already an explicit narrow column list, not `select('*')`, when Phase 1 was written). **The 4 real bare-`select('*')` sites are `server.js:2149, 2935, 4917, 5415`** — exactly the ones named in Finding 3's own file:line citations, which were correct; only the summary count above them was wrong. Caught by a second, more rigorous verification pass below (tracing each route's *real* body boundary via its actual matching next top-level declaration, not just "the next `app.get`/`app.post` in the file" — three of these four routes have large, unrelated helper *function definitions* sitting textually between them and the next route, e.g. `getBreedGuide`, `isSeniorForBreed`, `buildHealthSummary`; a naive line-range grep across those gaps silently vacuums up fields from functions the route never actually calls with its own `dog` object).

### Target `senior_dogs` schema — 5 columns removed, 32 remain

Removed: `owner_id`, `phone`, `email`, `zip_code`, `sms_consent`. Every other column is unchanged — `dog_name`, `breed`, `age`, `age_months`, `gender`, `weight_lbs`, `spayed_neutered`, `diet_type`, `pet_insurance`, `treatment_category`, `photo_url`, `baseline_notes`, `longest_streak`, `created_at`, `cohort`, `consent_given_at`, `consent_policy_version`, `preferred_reminder_day`, `preferred_reminder_time`, and all 12 baseline score columns (4 mobility items + 4 cognitive items + 4 composites: `baseline_mobility_score`, `baseline_energy_score`, `baseline_appetite_score`, `baseline_cognitive_score`). Every one of these 32 is genuine health/product data with no identity content — confirmed against Finding 1/3's own audit, not reassessed here.

`consent_given_at`/`consent_policy_version` deliberately **stay** on `senior_dogs`, not moved to `owner_pet_links` — worth stating explicitly since they're adjacent to the identity question. Reasoning: consent here is "did this specific dog's baseline submission include agreement to the Terms/Privacy Policy at the time it was submitted" — a fact about *that submission event*, not about the owner as a person or about the owner-dog relationship as an ongoing link. It has no bearing on who to contact or how (unlike `sms_consent`, which is a live communication-preference flag consulted on every reminder cycle). Keeping it on `senior_dogs` also matches how the field is actually used today — read once, by the Journey Summary and dashboard, as a health-record provenance fact, never joined against `owners` for any purpose.

### `owner_pet_links` — final proposed schema

```sql
CREATE TABLE IF NOT EXISTS owner_pet_links (
  -- PK, not just NOT NULL UNIQUE: a dog belongs to exactly one owner in
  -- today's product (no reassignment/sharing feature exists anywhere),
  -- so dog_id IS the row's real identity, not an incidental unique column.
  dog_id uuid PRIMARY KEY REFERENCES senior_dogs(id) ON DELETE CASCADE,

  -- RESTRICT, not CASCADE -- mirrors senior_dogs.owner_id's own current
  -- FK behavior exactly (Multi_Dog_Signup_Build.md, Stage 2): deleting an
  -- owner who still has linked dogs must fail loudly, never silently
  -- orphan them. Separation must not change this safety behavior as an
  -- accidental side effect of moving the column to a new table.
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE RESTRICT,

  -- A real, deliberate design choice, not an oversight -- see the
  -- reasoning below. This is the one field beyond the bare owner<->dog
  -- link itself that this table carries.
  sms_consent boolean NOT NULL DEFAULT false,

  created_at timestamp DEFAULT now()
);

-- owner_id has no UNIQUE constraint of its own -- one owner legitimately
-- has multiple dogs (Multi_Dog_Signup_Build.md's entire premise). An
-- index still matters for getDogsForOwner()'s lookup direction, since
-- the PK only indexes dog_id:
CREATE INDEX IF NOT EXISTS idx_owner_pet_links_owner_id ON owner_pet_links(owner_id);

ALTER TABLE owner_pet_links ENABLE ROW LEVEL SECURITY;
```

**Why `sms_consent` lives here, not on `owners` — a real design fork, decided, not left implicit:** the task's own instruction listed `sms_consent` among the columns to strip from `senior_dogs`, but didn't say where it should land. Two options were weighed:

- **(a) Move it to `owners`** — simpler table shape for `owner_pet_links` (just the bare link), but a **real product behavior change**: today, `sms_consent` is captured fresh on every baseline submission (both `/verify` for a first dog and `/api/add-dog` for an additional one), meaning it's genuinely stored *per dog* right now, not per owner — nothing in the current schema or UI prevents an owner from theoretically having different consent per dog (even though in practice the same checkbox flow makes this unlikely to diverge). Moving it to `owners` would silently collapse this to one value for every dog an owner has, the moment separation ships — a real behavior change bundled into a data-model refactor that was never asked to change behavior.
- **(b) Keep it on the link record (`owner_pet_links`)** — **chosen.** Preserves today's real per-dog granularity exactly, requires no decision about what happens to an owner's *existing* dogs' consent when a new one is added (each dog's own row keeps its own value, unchanged), and is arguably the semantically correct home for it regardless: "consent to text about this specific dog's reminders" is a property of the *relationship* between one owner and one dog, which is exactly what this table exists to represent — not a property of the owner as a person (which would apply uniformly to marketing communications, for instance, the way `owners.email_opt_out` already correctly does apply uniformly across an owner's whole account).

`phone`/`email`/`zip_code` get **no column here at all** — unlike `sms_consent`, these are pure owner attributes with zero dog-specific meaning (an owner has one phone number regardless of how many dogs they have), so they simply stay solely on `owners`, resolved via a join when a dog-scoped code path needs them (Finding below).

### Verification, requested before this schema is treated as final: which `sms_consent` value does the real SMS-sending code actually read?

**`owners.sms_consent` does not exist as a column anywhere in this schema.** Confirmed two ways, not assumed from the Phase 1 schema dump alone: a full grep of `server.js` for `sms_consent` (12 occurrences, all listed below) and a full grep of every file in `/migrations` — zero results define, add, or reference an `owners.sms_consent` column at any point in this project's history. The premise in the verification request ("if `owners.sms_consent` is already authoritative") does not hold, because that column was never created — this isn't a case of stale/dead duplicate data, it's a case of the field genuinely only ever having lived in one place.

**`senior_dogs.sms_consent` is the real, live, actually-consulted value — confirmed by tracing every read, not just every write:**

| Site | What it does |
|---|---|
| `server.js:3181` (`if (dog.sms_consent && dog.phone)`) | Gates whether the proactive next-check-in reminder gets queued, inside `/api/checkin-senior` |
| `server.js:9969, 9973` (`canTextThisDog = !!(dog.phone && dog.sms_consent)`) | Gates the missed-check-in reminder cascade (all 3 tiers) |
| `server.js:7333-7336` | `/api/governance/stats`'s `smsOptInRate` counts `senior_dogs.sms_consent = true` directly |
| `server.js:10261` | The churn cron's own dog-list query selects `sms_consent` alongside `phone`/`email`/`owner_id` for its per-dog send decision |

**No code path anywhere reads `senior_dogs.sms_consent` from a stale/unused location, and no code path reads a nonexistent `owners.sms_consent`.** This is the single, real, live gate for every automatic SMS reminder this app sends.

**A related, genuinely different field does exist on `owners` — `preferred_contact_method`** (a real 3-way `sms`/`email`/`both` column, confirmed live per Phase 1's Finding 3 schema dump) — but it is **not** the same thing and is **not** read by the reminder pipeline above. Traced its only two real call sites: `/api/resend-dashboard-link` (`server.js:9042-9043`, deciding which channel(s) to use for that one self-service action) and the recovery flow (`server.js:9093`, which explicitly sends to both channels *unconditionally*, bypassing `preferred_contact_method` on purpose, per its own comment). **`senior_dogs.sms_consent` is derived from `preferred_contact_method`/`contact_preference` at the exact moment each dog is created** (`server.js:7712` for a new signup's token, `8052`/`8482` for a returning owner adding a second dog) — both fields are set from the same source value in the same request, so they start in sync by construction. Confirmed **neither field is ever updated after creation**: a full grep of `.from('owners').update(...)` across the whole file shows only `access_token` (regenerate) and `email_opt_out` (unsubscribe) are ever touched — `preferred_contact_method` is fixed forever once an owner is created, and nothing updates `senior_dogs.sms_consent` post-creation either. So there's no live drift risk today, but this is worth naming as a latent design fact for later: if a future "change my contact preference" feature is ever built, it will need to decide whether updating `owners.preferred_contact_method` cascades to every already-linked dog's `sms_consent` or not — a real decision, not yet needed, not resolved here.

**Conclusion: the schema proposal above stands unchanged.** `senior_dogs.sms_consent` is not dead or duplicate data — it is the one live value the automatic reminder pipeline actually consults, and migrating it onto `owner_pet_links` (option (b), already chosen above) is the correct call, now confirmed against real read-site evidence rather than the write-site evidence alone that the original proposal was built on. `owners.preferred_contact_method` requires no schema change under this project — it already lives on `owners`, is not identity-adjacent health data, and is out of scope for `senior_dogs`/`owner_pet_links` entirely.

### The small set of named functions — the only code allowed to touch `owner_pet_links`, matching the free-text-export-ban convention

Per the task's explicit direction: **not a second credential** (Phase 1's Finding 8 flagged that as a real, much larger undertaking, deliberately not what's being decided here) — a **documented, named-function convention**, the same shape as the existing "free text never reaches the B2B/licensing export" rule already enforced by code review and a standing comment, not by a database permission.

```js
// The ONLY functions in this codebase permitted to query owner_pet_links.
// Every dog/owner-scoped route resolves identity through one of these
// four -- never a direct .from('owner_pet_links') call anywhere else.
// Matches this project's existing free-text-export-ban convention:
// enforced by this comment + code review, not a database permission
// (see Data_Model_Separation_Build.md Finding 8 for why a real database-
// enforced boundary would need a second, lower-privileged credential --
// a materially larger, separate undertaking, not what this is).

// 1. Read: resolve a dog's owner_id, for access-control decisions only.
//    Used by every authorizeOwnerScope/ownerSessionMatches call site
//    that starts from a dog_id (10 of the 14 checkpoints -- see the
//    checkpoint table below).
async function getOwnerIdForDog(dogId) {
  const { data } = await supabase.from('owner_pet_links').select('owner_id').eq('dog_id', dogId).maybeSingle();
  return data?.owner_id || null;
}

// 2. Read: resolve a dog's owner's real contact info, for the reminder/
//    churn system and any future export that legitimately needs to
//    reach the owner. The one function allowed to join owner_pet_links
//    to owners for phone/email -- everything else must go through this,
//    not construct its own join.
async function getOwnerContactForDog(dogId) {
  const { data: link } = await supabase.from('owner_pet_links').select('owner_id, sms_consent').eq('dog_id', dogId).maybeSingle();
  if (!link) return null;
  const { data: owner } = await supabase.from('owners').select('phone, email').eq('id', link.owner_id).maybeSingle();
  if (!owner) return null;
  return { owner_id: link.owner_id, phone: owner.phone, email: owner.email, sms_consent: link.sms_consent };
}

// 3. Read: list an owner's dogs (display fields only -- id/name/photo,
//    not full health records), for the dashboard dog-switcher and
//    /checkins/:owner_id.
async function getDogsForOwner(ownerId) {
  const { data: links } = await supabase.from('owner_pet_links').select('dog_id').eq('owner_id', ownerId);
  if (!links || links.length === 0) return [];
  const dogIds = links.map(l => l.dog_id);
  const { data: dogs } = await supabase.from('senior_dogs').select('id, dog_name, photo_url, created_at').in('id', dogIds);
  return dogs || [];
}

// 4. Write: the ONLY insert path. Called exactly twice in the whole app
//    -- /verify (new dog via magic link) and /api/add-dog (additional
//    dog for an existing owner) -- both already have a real, confirmed
//    owner row in hand at the moment they call this.
async function createOwnerPetLink(ownerId, dogId, smsConsent) {
  const { error } = await supabase.from('owner_pet_links').insert({ owner_id: ownerId, dog_id: dogId, sms_consent: !!smsConsent });
  if (error) throw error; // dog creation should fail loudly if its link can't be created -- an unlinked dog is a real, not a cosmetic, bug
}
```

**No update or delete function is proposed** — nothing in the current app ever changes which owner a dog belongs to, or updates `sms_consent` after initial creation (confirmed: no route anywhere calls `.from('owners').update(...)` for anything but `access_token`/`email_opt_out`, and no route updates `senior_dogs.sms_consent` post-creation either). Deletion is handled entirely by the `ON DELETE CASCADE`/`RESTRICT` FK behavior already declared in the schema — no application code needs to delete a link row directly. **If a future feature needs to change consent or reassign a dog, it adds a fifth named function to this same short list — it does not get a general-purpose `updateOwnerPetLink()` escape hatch**, which would defeat the whole point of a small, named, auditable set.

### Checkpoint-by-checkpoint: exactly which of the 14 change, and how

Corrected framing from Phase 1: **10 of the 14 checkpoints need their dog-lookup step changed** (from reading `dog.owner_id` off an already-fetched row to calling `getOwnerIdForDog(dog_id)`); **4 need no change to the authorization call itself**, because they already have `owner_id` as their own URL parameter, never resolved from a dog in the first place.

**Unaffected (4) — already own `owner_id` directly, no dog-lookup involved in the auth check:**

| Checkpoint | Why unaffected |
|---|---|
| `GET /checkins/:owner_id` | `owner_id` is the URL param itself — `authorizeOwnerScope(req, owner_id, token)` is called with it directly today (`server.js:8630`) and needs no change. **Its dog-*listing* query does change** — see below, this is a Finding 6-adjacent change, not an auth-check change. |
| `GET /unsubscribe/:owner_id` | Same — `owner_id` from the URL, never touches `senior_dogs` at all (only `owners`). No change. |
| `POST /unsubscribe/:owner_id` | Same. No change. |
| `POST /api/add-dog` | Resolves `owner.id` from a direct `owners` lookup (the owner already has to exist before a dog can be added to them) — never reads `senior_dogs` for its access check, since the dog doesn't exist yet at that point. No change. |

**Changed (10) — dog-lookup step rewritten to call `getOwnerIdForDog()` instead of reading `dog.owner_id`:**

| Checkpoint | Old dog-lookup | New dog-lookup |
|---|---|---|
| `GET /check-in/:dog_id` | `select('*')` (includes `owner_id`) | `select(<health-only columns — see below>)` for display, **+** `getOwnerIdForDog(dog_id)` for the auth check — two calls instead of one |
| `POST /api/checkin-senior` | `select('*')` | `select(<health-only columns>)` **+** `getOwnerContactForDog(dog_id)` (not the bare `getOwnerIdForDog` — this route also needs `phone`/`sms_consent` to queue the next reminder, `server.js:3181-3187`) |
| `GET /breed-guide/:dog_id` | `select('*')` | `select(<health-only columns>)` **+** `getOwnerIdForDog(dog_id)` |
| `POST /api/notes/:dog_id` | `select('id, owner_id')` | `select('id')` (existence check only — this route never displays anything about the dog) **+** `getOwnerIdForDog(dog_id)` |
| `POST /api/medications` | `select('id, dog_name, created_at, owner_id')` | `select('id, dog_name, created_at')` **+** `getOwnerIdForDog(dog_id)` |
| `POST /api/medications/:id/stop` | Resolves `medication.dog_id`, then `senior_dogs.select('owner_id').eq('id', dog_id)` | Resolves `medication.dog_id`, then `getOwnerIdForDog(medication.dog_id)` directly — **collapses from 2 raw queries to 1 helper call**, since this site only ever needed the bare `owner_id`, nothing else from `senior_dogs` |
| `POST /api/medication-response-windows/:id/respond` | Same shape as above (`window.dog_id` → `senior_dogs.select('owner_id')`) | Same collapse — `getOwnerIdForDog(window.dog_id)` |
| `GET /dashboard/:dog_id` | `select('*')` | `select(<health-only columns — the largest list, see below>)` **+** `getOwnerIdForDog(dog_id)` |
| `POST /api/upload-dog-photo` | `select('id, owner_id')` | `select('id')` **+** `getOwnerIdForDog(dog_id)` |
| `POST /api/regenerate-access-token` | `select('id, owner_id')` | `select('id')` **+** `getOwnerIdForDog(dog_id)` — note this checkpoint calls `ownerSessionMatches` directly (session-only, by design, per Phase 1 Finding 2), not `authorizeOwnerScope`; only the *resolution* of `ownerId` changes, not which function checks it |

**`authorizeOwnerScope` and `ownerSessionMatches` themselves need zero internal changes.** Both already take a plain `ownerId` string parameter with no assumption about where it came from (Phase 1 Finding 7 already established this) — this Phase 2 pass confirms that holds for all 14 real checkpoints, not just in the abstract. The entire rework is contained to each *caller's* own resolution step, exactly as scoped.

**Also changed, not a checkpoint but adjacent — the 2 sibling-dog identity reads (Phase 1 Finding 6):**

- Dashboard dog-switcher (`server.js:5489`, `senior_dogs.select('id, dog_name, photo_url').eq('owner_id', sessionOwnerId)`) → `getDogsForOwner(sessionOwnerId)`.
- `GET /checkins/:owner_id`'s own dog-listing query (`server.js:8601`, same `.eq('owner_id', owner_id)` shape) → `getDogsForOwner(owner_id)`.

Both become direct callers of the same named function (#3 above) rather than two independent `senior_dogs.eq('owner_id', ...)` queries that could otherwise drift apart in which columns they select.

### The 4 real `select('*')` sites — exact proposed replacement columns, verified per-route, not estimated

Each list below was built by tracing every real `dog.<field>` reference within that route's **actual** body (confirmed via its real closing boundary — the next top-level `function`/`app.get`/`app.post` declaration, not just "the next route," since three of these four routes have unrelated helper-function definitions sitting textually between them and the next real route) — including calls that pass the whole `dog` object into a helper (e.g. `getDogAgeInYears(dog)`), not just direct `dog.field` property access.

**`GET /check-in/:dog_id` (`server.js:2149`) — real body spans `2143-2568`:**
```js
.select('dog_name, created_at, weight_lbs, baseline_mobility_getting_up, baseline_mobility_stairs, baseline_mobility_stiffness_after_rest, baseline_mobility_walk_distance, baseline_energy_score, baseline_appetite_score, baseline_cognitive_orientation, baseline_cognitive_memory, baseline_cognitive_interest, baseline_cognitive_sleep_wake')
```
Notably needs the 4 mobility *item* columns (for smart-default prefill) but **not** the mobility composite — this route never displays or computes with `baseline_mobility_score` directly, only its own live-computed prefill values.

**`POST /api/checkin-senior` (`server.js:2935`) — real body spans `2839-4170`:**
```js
.select('dog_name, created_at, longest_streak, baseline_mobility_score, baseline_energy_score, baseline_appetite_score, baseline_cognitive_score, baseline_cognitive_orientation, baseline_cognitive_memory, baseline_cognitive_interest, baseline_cognitive_sleep_wake')
```
The inverse of the check-in GET page: needs the mobility *composite* (for `scoreDiff`/segment calculation against the new submission) but not the mobility items, plus the cognitive composite *and* items (both used — items as a cadence-gated fallback comparison, per the existing STEP P10 logic). Also needs contact info via `getOwnerContactForDog(dog_id)`, not `getOwnerIdForDog`, per the checkpoint table above.

**`GET /breed-guide/:dog_id` (`server.js:4917`) — real body spans `4912-5170`:**
```js
.select('dog_name, created_at, breed, photo_url, weight_lbs, age, age_months, baseline_mobility_score, baseline_energy_score, baseline_appetite_score, baseline_cognitive_score')
```
All 4 composites, none of the 8 items — this page only ever shows aggregate current-status numbers, never item-level breakdowns. `age`/`age_months` needed for `getDogAgeInYears(dog)` → `isSeniorForBreed()`, confirmed by tracing the helper call, not just direct field access.

**`GET /dashboard/:dog_id` (`server.js:5415`) — real body spans `5408-7204`, by far the largest route in the app:**
```js
.select('dog_name, breed, age, age_months, gender, weight_lbs, photo_url, diet_type, spayed_neutered, pet_insurance, treatment_category, baseline_notes, longest_streak, created_at, baseline_mobility_getting_up, baseline_mobility_stairs, baseline_mobility_stiffness_after_rest, baseline_mobility_walk_distance, baseline_mobility_score, baseline_energy_score, baseline_appetite_score, baseline_cognitive_orientation, baseline_cognitive_memory, baseline_cognitive_interest, baseline_cognitive_sleep_wake, baseline_cognitive_score')
```
Needs essentially every remaining column — the dashboard is a genuine "everything about this dog except identity" consumer, confirming Finding 3's original prediction. `consent_given_at`/`consent_policy_version` were **not** found referenced anywhere in this route's real body — not currently displayed on the dashboard itself (only inside the Journey Summary modal's own logic, which is rendered from this same fetched `dog` object in practice, so a real implementation should double-check whether Journey Summary needs anything beyond this list before finalizing it, flagged rather than assumed).

### The 2 insert-return-value `.select()` calls — a smaller, related concern, addressed on its own terms

`/verify` (`server.js:8137`) and `/api/add-dog` (near `8548`) both end their `senior_dogs.insert({...}).select()` with no column argument, returning every column of the row just written — including, under the current schema, the very `phone`/`email`/`owner_id` fields being inserted in that same call. **This is a different shape of concern than the 4 display-route sites above**: it's not an unrelated route over-fetching identity data it never asked for, it's a route momentarily holding the exact identity data it just validated and wrote, in the same request, for the sole purpose of confirming the insert succeeded and (in `/verify`'s case) getting the new `id` to redirect to. Once `owner_id`/`phone`/`email`/`zip_code`/`sms_consent` are removed from `senior_dogs` entirely, this concern resolves itself structurally — the insert's return value can only ever contain what's still a column on the stripped table, so no explicit narrowing is even required here; noted for completeness, not proposed as a separate fix.

### Migration shape — named, sequenced, not written

Per instruction, no `.sql` file is included — but the real migration this project would need, when Phase 3 starts, has three real ordering dependencies worth naming now so Phase 3 doesn't have to rediscover them: (1) create `owner_pet_links` and backfill it from every existing `senior_dogs.owner_id`/computed `sms_consent` value **before** dropping anything from `senior_dogs` — a backfill-then-drop, not a drop-then-rebuild, so no data is ever unrecoverable mid-migration; (2) update `server.js` to use the new named functions and narrowed selects **before** running the column-drop half of the migration, matching this project's own established two-step pattern for every prior schema change (code deployed first, migration run once the code no longer depends on the old shape — see the Aug 26 RLS remediation's own documented sequencing lesson); (3) confirm zero remaining code references to `senior_dogs.owner_id`/`.phone`/`.email`/`.zip_code`/`.sms_consent` via a full grep sweep before the drop, the same "confirm nothing's missed" discipline this Phase 1/2 investigation itself was built on.

---

## Phase 2 status: ✅ Complete

Target schema, `owner_pet_links`' final shape and the `sms_consent`-placement decision, the 4-function convention, the full 14-checkpoint mapping, and the corrected (4, not 7) `select('*')` replacement columns are all proposed above, with the "7" miscount from Phase 1 caught and corrected rather than silently carried forward. Nothing has been written to a `.sql` file and no line of `server.js` has changed. Phase 3 (writing the real migration, applying the call-site rework) has not started — awaiting review of this proposal.

---

## Real finding, Batch 1 test cleanup (Sep 4): `dog_notes` is NOT cascade-linked to `senior_dogs`

Confirmed empirically while deleting Phase 4 Batch 1's test data, not assumed from the schema docs above: `dog_notes.dog_id`'s foreign key to `senior_dogs(id)` is a plain `RESTRICT`, not `ON DELETE CASCADE` like `medications`, `medication_response_windows`, and `owner_pet_links` all are. A `DELETE FROM senior_dogs WHERE id = ...` failed outright (`23503`, "is still referenced from table \"dog_notes\"") until the two `dog_notes` rows created during that test session were deleted first — the delete is atomic, so nothing else cascaded either until that blocker was cleared.

**Worth remembering for Phase 5 (the eventual `senior_dogs` column drop) and any future cleanup/deletion logic that touches `senior_dogs`:** `dog_notes` rows for a given dog must be deleted explicitly, before the dog row itself, or the delete is blocked — it will not silently cascade or silently fail on the notes table, it fails loudly on the whole operation. This is a real, standing fact about this table's schema, not specific to the Phase 4 test that surfaced it.
