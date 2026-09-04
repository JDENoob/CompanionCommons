# CompanionCommons — Internal Ops Dashboard: Investigation & Plan
**Started:** September 4, 2026
**Status:** Investigation and planning only. No `.sql` file written, no route or page built. Everything below is confirmed directly against the current `server.js` (10,441 lines) and the live schema, not inferred from older docs.
**Purpose:** Standalone tracking document for a real internal operations dashboard — headline metrics plus a growing library of report queries John can actually use to answer real questions about the beta, distinct from the existing `/admin` page (which only edits marketing-site copy) and the existing `/api/governance/stats` endpoint (a small, public-facing trust-metric endpoint with no auth of its own — see Finding 2). Matches the tracking-doc pattern set by `Multi_Dog_Signup_Build.md`, `Link_Revocation_Build.md`, and this session's companion `Data_Model_Separation_Build.md`.

---

## Finding 1 — the existing admin panel's auth pattern, confirmed, to be reused as-is

`server.js:1210-1249` (`ADMIN PANEL AUTH` section). This is the pattern fixed on Aug 20 (the plaintext-password bug — the panel used to send the real password to the browser and check it client-side; now it's a real server-side check, same shape as the `SITE_PASSWORD` "Coming Soon" gate that predates it):

- **`ADMIN_PASSWORD`** — a separate env var from `SITE_PASSWORD`, read once at startup (`server.js:1222`).
- **`ADMIN_UNLOCK_COOKIE = 'cc_admin_access'`** — a distinct cookie name from both `SITE_UNLOCK_COOKIE` (`cc_site_access`) and `OWNER_SESSION_COOKIE` (`cc_owner_session`), so all three gates are independent and don't accidentally satisfy each other.
- **`isAdminUnlocked(req)`** (`server.js:1225-1229`) — `cookies[ADMIN_UNLOCK_COOKIE] === siteUnlockHash(ADMIN_PASSWORD)`, reusing the exact same `siteUnlockHash()` SHA-256 helper the `SITE_PASSWORD` gate already uses (`server.js:855-857`), not a separate hashing scheme.
- **`POST /api/admin-unlock`** (`server.js:1231-1243`) — checks `password === ADMIN_PASSWORD` (plain string compare; not a timing-side-channel concern in the same class as `access_token`/session-signature, since this is a single, rarely-attempted internal login, not a per-request comparison against externally-suppliable values on a hot path — worth noting for completeness, not treated as a gap), sets the cookie on success, 30-day `httpOnly`/`sameSite: 'lax'` cookie — identical shape to `SITE_UNLOCK_COOKIE`'s own cookie options.
- **`POST /api/admin-logout`** (`server.js:1245-1248`) — clears the cookie.
- **A real, deliberate difference from `SITE_PASSWORD`, worth carrying forward**: leaving `ADMIN_PASSWORD` unset does **not** open the gate (unlike `SITE_PASSWORD`, where unset means the whole site is unlocked by design) — it returns `503` and locks the panel out entirely. The existing comment at `server.js:1218-1221` states this explicitly: "Admin is a sensitive internal tool, not something that should ever be reachable by default." **The ops dashboard must follow this same fail-closed default**, not the `SITE_PASSWORD` fail-open one.

**Recommendation: reuse this exact mechanism, not a new one.** A new `OPS_PASSWORD`/`cc_ops_access` pair, or reusing `ADMIN_PASSWORD`/`ADMIN_UNLOCK_COOKIE` directly — both are reasonable; the real decision is whether the ops dashboard should be reachable by the same password as the marketing-copy editor (simpler, one fewer secret to manage) or a separate one (cleaner separation between "can edit public site text" and "can see real user data," which is a meaningfully different privilege). **Flagged as a real, named decision for whoever scopes the actual build — not resolved here.** Whichever is chosen, the guard function (`isAdminUnlockedForOps(req)` or reusing `isAdminUnlocked(req)` directly) and the fail-closed-when-unset behavior should be copied verbatim, not reimplemented.

---

## Finding 2 — `/api/governance/stats` already exists, is public, and computes real (if limited) headline metrics

`server.js:7308-7370`. This is **not currently gated by `ADMIN_PASSWORD` or any auth at all** — it's a deliberately public endpoint (per the Sep 2 checklist decision, item 39: "a real, public, numbers-only trust page," deferred to post-beta since "0 loggers" undermines the trust-building point). It already computes:

| Metric | Query | Real today? |
|---|---|---|
| `foundingMembers` / `petsRegistered` | `senior_dogs` row count | Yes, but **the code's own comment is now stale**: "Today's model is one dog per signup, so founding members and pets registered are the same count" (`server.js:7323-7326`) — this was written before the multi-dog owner project shipped (`Multi_Dog_Signup_Build.md`, complete since Aug 22). An owner can now have multiple dogs, so `foundingMembers` (should mean unique *owners*) and `petsRegistered` (unique *dogs*) are conflated into the same number today, silently wrong the moment a real multi-dog owner signs up. **A real, concrete gap this investigation surfaces, not something to fix here** — flagged for whoever builds the actual ops dashboard, since the same query pattern (a real `owners` count vs. `senior_dogs` count) is needed there too. |
| `smsOptInRate` | `senior_dogs.sms_consent = true` count / total | Yes, real and correct — reads the actual live consent field, not a dead legacy one. |
| `weeklyCheckIns` | `mobility_checkins` row count | Yes, real total, not week-scoped despite the name — it's a running total, not "check-ins this week." |
| `totalDataPoints` | `memberCount + weeklyCheckIns` | Yes, a simple derived sum. |

**Recommendation: the ops dashboard's headline-metrics section should NOT rebuild these from scratch** — either call this same endpoint internally, or (better, since the ops dashboard needs the *owner-vs-dog* distinction this endpoint currently lacks) extract the shared counting logic into a function both endpoints call, fixing the stale "one dog per signup" assumption once, in one place, rather than drifting two copies of a similar-but-not-identical stats query.

---

## Finding 3 — what's already cleanly queryable for the requested headline metrics, and what genuinely needs a new query

| Requested metric | Queryable today? | How |
|---|---|---|
| **Total signups over time** | Yes, raw data exists (`senior_dogs.created_at`) | **Not directly groupable via PostgREST** — see Finding 4. Fetch all `created_at` values and bucket by week/day in Node (fine at current/beta scale), or a Postgres view (see Finding 4). |
| **Check-in completion rate by week** | Partially — the raw data exists, the "rate" doesn't | This is a genuinely computed metric, not a stored one: for a given calendar week number, "completion rate" means *(dogs that actually submitted a check-in for that week) / (dogs for whom that week was actually due, i.e. already past their signup + baseline period by that week)*. The denominator requires per-dog date math (`created_at` + 7-day baseline + weekly cadence), not a simple count — the same `Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1)` calculation already duplicated across this codebase for `currentWeek`. **Real query/view work needed, not a trivial addition.** |
| **Active/longest streaks** | `longest_streak` — yes, directly (`senior_dogs.longest_streak`, a stored column, `MAX()`/`AVG()` over it is a plain query). **Active/current streaks — no**, not stored anywhere; `calculateCurrentStreak(dog_id)` (`server.js:2642-2664`) is a real, already-correct, per-dog computation, but it's written to run for one dog at a time (one query per dog, `.eq('dog_id', dog_id)`). An aggregate "active streaks across all dogs" headline number would mean running this once per dog (fine at beta scale — a handful of dogs — genuinely not fine once real volume exists, an O(N) query pattern) or rewriting the same logic as a single query grouped by `dog_id` in Node from one bulk `mobility_checkins` fetch. **Reuse the existing function's logic, don't reimplement the streak algorithm a second time** — but it does need a bulk-shaped version, not N calls to the existing per-dog one. |
| **`churn_flags` count** | Yes, directly — a plain `count` query (`.from('churn_flags').select('id', { count: 'exact', head: true })`), same shape `/api/governance/stats` already uses for two other counts. Genuinely trivial. |
| **Medication-entry completion rate** | Partially | "Completion rate" needs a definition decision, not just a query — candidates: (a) % of dogs with at least one `medications` row (crude — doesn't distinguish "genuinely has no medications" from "never got asked/never bothered"), (b) % of *eligible* weekly check-ins (dogs with 1+ active medications, per `getActiveMedicationsForDog`) that included a real medication-update answer, which is the more meaningful number but requires joining `mobility_checkins`/`medication_weekly_updates` against active-medication state at the time of each check-in — real, non-trivial work. **Flagged as a real open question for whoever scopes the actual metric, not resolved here.** A simpler, real-today query — "medication category breakdown" (count of `medications` rows grouped by `category`) — is directly queryable with no ambiguity, and was explicitly requested as a report example (see Finding 5). |

---

## Finding 4 — a real, structural constraint: this app has never used Postgres views or RPC functions, only plain PostgREST filters

Confirmed via a full grep: **zero occurrences of `supabase.rpc(` anywhere in `server.js`.** Every single database interaction in this entire project, across every feature ever built, is a plain `.select()`/`.insert()`/`.update()`/`.delete()` call with `.eq()`/`.in()`/`.order()`/`.limit()` filters — never a call to a stored Postgres function, never a query against a database view.

**This matters directly for the "phased report-query library" ask**, because PostgREST (the API layer Supabase's REST client talks to) does not support arbitrary `GROUP BY` aggregation through its normal filter syntax — you can get a `count`, but not "count grouped by week" or "average grouped by breed" as a single REST call. Two real paths, both worth naming explicitly rather than picking one silently:

1. **Fetch raw rows, aggregate in Node** — e.g., pull every `senior_dogs.created_at`, bucket into weeks in application code. This is exactly what this project already does everywhere else (see `computeDueMedicationMilestones`, `calculateCurrentStreak`, `evaluateDogForChurn` — all pull raw rows and compute in JS, never push aggregation into the database). **Consistent with the codebase's own established style, zero new infrastructure, but doesn't scale indefinitely** — fine at beta size (a handful to a few dozen dogs), would need revisiting if this app ever reaches real production volume (thousands of rows fetched per report-page load).
2. **Introduce real Postgres views** (`CREATE VIEW weekly_signup_counts AS SELECT date_trunc('week', created_at) AS week, count(*) FROM senior_dogs GROUP BY 1;`) queried via `supabase.from('weekly_signup_counts').select('*')` — PostgREST can query a view exactly like a table, so this needs no `rpc()` call, no new client capability, just a new migration defining the view. **This would be a genuine first for this project** (its first database-side aggregation object of any kind) but is a small, well-contained addition per report, not a structural risk.

**Recommendation: start with option 1 (Node-side aggregation) for Phase 1's initial query library, given real beta volume is still zero (per checklist item 47) and will stay small for a long time.** Revisit option 2 specifically if/when a particular report's raw-row fetch actually becomes slow in practice — a real, measurable trigger, not a preemptive optimization. This mirrors the project's own repeated pattern of not building ahead of real need (STEP P1C comparative feedback, the ops dashboard idea itself per checklist item 39, both explicitly deferred pending real volume).

---

## Finding 5 — proposed phased approach

### Phase 1 — headline metrics + a small, named, extensible report-query library

A single new file, e.g. `lib/ops-reports.js` (or a clearly-delimited section of `server.js`, matching how `HEALTH_INSTRUMENT`/`BREED_GUIDES` and similar large constant/helper blocks already live directly in `server.js` today — the project has no existing precedent for splitting logic into separate required files, so keeping this in `server.js` may actually be more consistent with the codebase's own style than introducing a new module pattern for the first time here; a real, small decision worth naming rather than assuming). Each report is a small, independently-callable async function with a fixed shape: a name, a short description (shown in the UI), and a function returning rows/a single aggregate.

**Headline metrics** (the "always visible" summary row):
- Total signups (owners + dogs, corrected per Finding 2's stale-comment fix)
- SMS opt-in rate (already real via `/api/governance/stats`'s existing logic)
- Total check-ins logged
- `churn_flags` count (trivial, Finding 3)
- Longest streak across all dogs (trivial — `MAX(longest_streak)`, Finding 3)

**Initial report-query library, beyond headline metrics** (matching the task's own named examples, each independently useful and independently small):
- Signups by week (Finding 4, option 1)
- Check-in completion rate by week (Finding 3 — the one genuinely non-trivial metric in this list; scope this one first if a real definition decision is wanted before building the rest)
- Completion rate by dog age bracket (straightforward join: `mobility_checkins` count per dog vs. `senior_dogs.age`/`age_months`, bucketed)
- Completion rate by breed (same shape, bucketed by `senior_dogs.breed` — note breed is free text, not enumerated, so this report's output will have a long tail of near-duplicate breed strings unless it reuses the existing breed-matching layer from `Breed_Guide_Expansion_Build.md` to normalize first; flagged, not resolved)
- Medication category breakdown (trivial — `medications` grouped by `category`, Finding 3)

**Each report function is added to the library independently, as new questions come up** — the task's own framing ("easy to extend as new questions come up") is satisfied by keeping each report a small, standalone function with no shared mutable state, not by building a generic query engine (that's Phase 2, below, and deliberately not this phase's job).

### Phase 2 — a genuine ad-hoc/filter-based query interface — flagged, not built

The task explicitly asked this be named but not built. Worth stating plainly why it's a materially bigger undertaking than Phase 1, so the size difference is clear when it's revisited: a real ad-hoc query tool means either (a) exposing enough of PostgREST's own filter syntax through a UI that John can build arbitrary `.eq()`/`.gt()`/`.in()` combinations without writing code — real UI/UX design work, plus real thought about what should be off-limits (should `owner_pet_links`, once it exists per `Data_Model_Separation_Build.md`, ever be reachable through an ad-hoc tool? almost certainly not) — or (b) a genuine SQL-like query box, which is a much bigger scope (parsing, safety/injection review, likely read-only-role enforcement given Finding 4's observation that this app's one DB credential currently has no read-only variant). **Revisit once real beta usage shows which specific questions recur often enough to justify either path** — consistent with how this same document's Phase 1 was scoped (build the named, concrete reports first; don't build a generic tool speculatively).

---

## Finding 6 — proposed route + page structure, matching the existing admin panel's style

No build — this is the plan only, per instruction.

- **`GET /ops`** (or `/admin/ops`, nested under the existing admin path — a real, small naming decision, not resolved here) — same two-branch shape as `GET /admin` (`server.js:1625-1673` unlocked-form / `1676+` real content): unlocked → login form posting to a new or reused unlock endpoint (Finding 1); locked → the real dashboard.
- **The real dashboard page**: headline metrics row at the top (Finding 5), rendered server-side as plain HTML/inline styles — matching the existing `/admin` page's own approach (a single `res.send()`-returned template string, no client-side framework, no build step) rather than introducing a new frontend pattern into a codebase that has never used one.
- **The report-query library, surfaced as a simple list/dropdown + "Run" pattern** — closely mirroring `/admin`'s own existing `loadPage()`/`savePage()` shape (a `<select>` of named items, a fetch to load/act on the selected one) rather than a new UI paradigm: a `<select>` of report names (Finding 5's library), a "Run" button, results rendered as a plain HTML table below. Each report's own name/description (already part of its definition per Finding 5) populates the dropdown directly from the same library object the backend uses, so the UI list and the real callable set can't drift apart.
- **New routes**: `GET /api/ops/metrics` (headline numbers, Finding 5), `GET /api/ops/reports` (lists available reports — names/descriptions only), `POST /api/ops/reports/:name/run` (executes one named report, returns rows) — all gated by the same admin-auth check as `/ops` itself (Finding 1), not independently.

---

## What this investigation deliberately did not do

Per instruction: no route was built, no migration was written, no view was created. No decision was made on the `ADMIN_PASSWORD`-reuse-vs-separate-credential question (Finding 1) or the completion-rate metric definition (Finding 3) — both flagged as real, named open questions for whoever scopes the actual build, not resolved here.

---

## Status: ✅ Investigation Phase 1 complete

All 6 findings above are documented with file:line precision where applicable. No code, schema, or route has been touched.

---

## Investigation Phase 2 — Concrete Proposal — ✅ Complete (Sep 4, 2026)

**Proposal only. No route built, no migration written, no code changed.** A naming note before anything else: **this document's own Finding 5 already uses "Phase 1"/"Phase 2" to describe two different *scopes of the eventual feature*** (Phase 1 = headline metrics + named report library, Phase 2 = a future ad-hoc query tool, deliberately not built). This section is a different axis entirely — the *investigation's* second stage, turning Finding 5's Phase 1 feature scope into concrete route signatures and real query code. To avoid confusion between the two: everywhere below, "the feature's Phase 1" refers to Finding 5's report-library scope; this whole section is what that phase would concretely look like if built.

### Route/page structure — concrete, expanding Finding 6

```
GET  /ops                              — unlocked: login form (mirrors GET /admin exactly)
                                          locked: the real dashboard page (headline metrics + report picker)
POST /api/ops-unlock                   — same shape as /api/admin-unlock; see Finding 1's open question on
                                          whether this reuses ADMIN_PASSWORD/ADMIN_UNLOCK_COOKIE directly or
                                          gets its own OPS_PASSWORD/cc_ops_access pair
POST /api/ops-logout                   — same shape as /api/admin-logout
GET  /api/ops/metrics                  — returns the 5 headline numbers as one JSON object (Finding 3/5)
GET  /api/ops/reports                  — returns [{ name, description }] for every report in the library —
                                          drives the <select> dropdown so the UI list can never drift from
                                          what's actually callable
POST /api/ops/reports/:name/run        — executes one named report, returns { columns: [...], rows: [...] }
```

All four `/api/ops/*` routes gated by the same auth check as `/ops` itself (Finding 1) — a single `requireOpsAuth` middleware-style guard, not four independent checks that could drift.

**Page structure**, matching `/admin`'s own established shape (`server.js:1676+`) — one `res.send()`-returned template string, no client framework, no build step:

```html
<div class="container">
  <h1>Companion Commons — Ops</h1>
  <button onclick="logout()">Logout</button>

  <!-- Headline metrics: 5 stat boxes, populated on page load -->
  <div class="metrics-row">
    <div class="stat"><div id="m-founding">—</div><div>Founding Members</div></div>
    <div class="stat"><div id="m-pets">—</div><div>Pets Registered</div></div>
    <div class="stat"><div id="m-checkins">—</div><div>Total Check-Ins</div></div>
    <div class="stat"><div id="m-churn">—</div><div>Churn Flags</div></div>
    <div class="stat"><div id="m-streak">—</div><div>Longest Streak</div></div>
  </div>

  <!-- Report library: dropdown + run button, mirrors /admin's page-select/loadPage pattern -->
  <div class="form-group">
    <label>Report:</label>
    <select id="report" onchange="describeReport()"></select>
    <p id="report-desc" style="color:#666;"></p>
    <button onclick="runReport()">Run Report</button>
  </div>
  <table id="report-results"></table>
</div>
<script>
  async function loadMetrics() { /* fetch /api/ops/metrics, fill the 5 stat boxes */ }
  async function loadReportList() { /* fetch /api/ops/reports, populate <select> + keep descriptions in memory */ }
  async function runReport() { /* POST /api/ops/reports/<selected>/run, render columns/rows into <table> */ }
</script>
```

### Headline metrics — real Node-side query code

```js
async function getOpsHeadlineMetrics() {
  const [
    { count: ownerCount },
    { count: dogCount },
    { count: smsOptIns },
    { count: checkinCount },
    { count: churnFlagCount },
    { data: streakRows },
  ] = await Promise.all([
    supabase.from('owners').select('id', { count: 'exact', head: true }),
    supabase.from('senior_dogs').select('id', { count: 'exact', head: true }),
    supabase.from('senior_dogs').select('id', { count: 'exact', head: true }).eq('sms_consent', true),
    supabase.from('mobility_checkins').select('id', { count: 'exact', head: true }),
    supabase.from('churn_flags').select('id', { count: 'exact', head: true }),
    supabase.from('senior_dogs').select('longest_streak').order('longest_streak', { ascending: false }).limit(1),
  ]);

  return {
    foundingMembers: ownerCount || 0,            // real unique owners — see the governance/stats fix below
    petsRegistered: dogCount || 0,                // real unique dogs, may exceed foundingMembers
    smsOptInRate: dogCount ? Math.round(((smsOptIns || 0) / dogCount) * 100) : 0,
    totalCheckIns: checkinCount || 0,
    churnFlagCount: churnFlagCount || 0,
    longestStreak: streakRows?.[0]?.longest_streak || 0,
  };
}
```

Six independent count-only queries run in parallel via `Promise.all` — every one is a `head: true` count query (no rows transferred except the one-row `longest_streak` fetch), so this stays cheap regardless of table size, unlike the report-library queries below (which do need real rows).

### The feature's Phase 1 report library — real Node-side aggregation queries per report

**Signups by week** (Finding 4, option 1 — fetch raw, bucket in Node):
```js
async function reportSignupsByWeek() {
  const { data: dogs } = await supabase.from('senior_dogs').select('created_at').order('created_at');
  const buckets = {};
  for (const { created_at } of dogs || []) {
    const weekStart = getISOWeekStart(new Date(created_at)); // Monday-anchored, matching this app's existing week-number convention
    const key = weekStart.toISOString().slice(0, 10);
    buckets[key] = (buckets[key] || 0) + 1;
  }
  return Object.entries(buckets).sort().map(([week, count]) => ({ week, signups: count }));
}
```

**Check-in completion rate by week** — the one genuinely non-trivial report (Finding 3). Proposed concrete definition, not just a code shape, since the task's own ask flagged this needs a real decision: *for calendar week number W (2 through the current max across all dogs — week 1 is baseline-only, never due), the denominator is every dog whose own computed `currentWeek` (the same `Math.max(1, floor((now - created_at)/7days) + 1)` calculation already duplicated across `server.js` for display purposes) is `>= W`; the numerator is how many of those dogs have a real `mobility_checkins` row with `week_number = W`.*
```js
async function reportCompletionRateByWeek() {
  const { data: dogs } = await supabase.from('senior_dogs').select('id, created_at');
  const { data: checkins } = await supabase.from('mobility_checkins').select('dog_id, week_number');
  const checkinSet = new Set((checkins || []).map(c => `${c.dog_id}:${c.week_number}`));
  const dogCurrentWeek = new Map(
    (dogs || []).map(d => [d.id, Math.max(1, Math.floor((Date.now() - new Date(d.created_at)) / (7 * 24 * 60 * 60 * 1000)) + 1)])
  );
  const maxWeek = Math.max(2, ...dogCurrentWeek.values());
  const rows = [];
  for (let w = 2; w <= maxWeek; w++) {
    const eligibleDogIds = [...dogCurrentWeek.entries()].filter(([, cw]) => cw >= w).map(([id]) => id);
    const completedCount = eligibleDogIds.filter(id => checkinSet.has(`${id}:${w}`)).length;
    rows.push({ week: w, eligible: eligibleDogIds.length, completed: completedCount, rate: eligibleDogIds.length ? Math.round((completedCount / eligibleDogIds.length) * 100) : null });
  }
  return rows;
}
```
Two full-table fetches (`senior_dogs`, `mobility_checkins`), everything else computed in memory — consistent with Finding 4's recommendation and this codebase's own established style (`evaluateDogForChurn` and `calculateCurrentStreak` both already fetch-then-compute rather than pushing logic into SQL).

**Completion rate by dog age bracket:**
```js
async function reportCompletionRateByAgeBracket() {
  const { data: dogs } = await supabase.from('senior_dogs').select('id, age, age_months');
  const { data: checkinCounts } = await supabase.from('mobility_checkins').select('dog_id');
  const checkinCountByDog = {};
  for (const { dog_id } of checkinCounts || []) checkinCountByDog[dog_id] = (checkinCountByDog[dog_id] || 0) + 1;
  const bracketOf = (years) => years < 1 ? 'under 1' : years < 3 ? '1-3' : years < 7 ? '3-7' : years < 10 ? '7-10' : '10+';
  const buckets = {};
  for (const dog of dogs || []) {
    const years = (dog.age || 0) + (dog.age_months || 0) / 12;
    const bracket = bracketOf(years);
    buckets[bracket] ??= { dogCount: 0, totalCheckins: 0 };
    buckets[bracket].dogCount++;
    buckets[bracket].totalCheckins += checkinCountByDog[dog.id] || 0;
  }
  return Object.entries(buckets).map(([bracket, v]) => ({ bracket, dogCount: v.dogCount, avgCheckinsPerDog: v.dogCount ? +(v.totalCheckins / v.dogCount).toFixed(1) : 0 }));
}
```
Reports an average check-ins-per-dog per bracket rather than a "rate" against a due-count (that precision belongs to the week-by-week report above) — a simpler, still genuinely useful engagement signal by age group.

**Completion rate / volume by breed** — same shape as the age-bracket report, bucketed by `senior_dogs.breed` instead. **Flagged, not resolved, per Finding 5's own note**: breed is free text, so a naive `GROUP BY breed` will fragment "Golden Retriever" / "golden retriever" / "Golden Retriever mix" into separate buckets. A real implementation should route each dog's `breed` string through the same layered exact/substring/alias/fuzzy matching chain already built for `getBreedGuide()` (`Breed_Guide_Expansion_Build.md`, Stage 2) before bucketing, reusing that matcher rather than writing a second one — not sketched in full here since it's a direct reuse of existing code, not new logic.

**Medication category breakdown** (trivial, Finding 3):
```js
async function reportMedicationCategoryBreakdown() {
  const { data: meds } = await supabase.from('medications').select('category');
  const buckets = {};
  for (const { category } of meds || []) buckets[category] = (buckets[category] || 0) + 1;
  return Object.entries(buckets).map(([category, count]) => ({ category, count }));
}
```

**The report library object**, tying names/descriptions to their functions so `GET /api/ops/reports` and `POST /api/ops/reports/:name/run` share one source of truth (can't drift, matching the same discipline `withToken()`/`getOwnerIdForDog()` established elsewhere in this project's docs):
```js
const OPS_REPORTS = {
  signups_by_week: { description: 'New dog signups, bucketed by calendar week', run: reportSignupsByWeek },
  checkin_completion_by_week: { description: 'Check-in completion rate per calendar week', run: reportCompletionRateByWeek },
  completion_by_age_bracket: { description: 'Average check-ins per dog, by age bracket', run: reportCompletionRateByAgeBracket },
  medication_category_breakdown: { description: 'Medication/supplement entries by category', run: reportMedicationCategoryBreakdown },
};
```

### `/api/governance/stats`'s stale multi-dog assumption — fix proposed, not applied

**The gap, restated precisely (Finding 2):** `server.js:7316-7327` computes `memberCount` from a `senior_dogs` count, then sets `petsRegistered = memberCount` verbatim, with a comment stating "today's model is one dog per signup" — false since `Multi_Dog_Signup_Build.md` shipped (Aug 22). `foundingMembers` (which should mean unique *people*) and `petsRegistered` (unique *dogs*) are silently the same number today, and will read wrong the moment any real multi-dog owner exists in production.

**Proposed fix** (not applied — shown as a diff-shaped sketch for review):
```diff
-        // Signup count from senior_dogs — the real, live table. This used
-        // to read from `users`, which is a fully abandoned parallel schema
-        // ...
-        const { count: dogCount, error: dogsError } = await supabase
-            .from('senior_dogs')
-            .select('id', { count: 'exact', head: true });
-
-        if (dogsError) throw dogsError;
-        const memberCount = dogCount || 0;
-
-        // Today's model is one dog per signup, so "founding members" and
-        // "pets registered" are the same count for now. These will only
-        // diverge once a real Owner entity exists (see the multi-dog-owner
-        // project) and can distinguish unique owners from unique dogs.
-        const petsRegistered = memberCount;
+        // Real owner count and real dog count, independently — these
+        // diverge for any owner with more than one dog (Multi_Dog_Signup_
+        // Build.md, shipped Aug 22). Previously conflated into one number
+        // under a stale "one dog per signup" assumption written before
+        // that project existed.
+        const { count: ownerCount, error: ownersError } = await supabase
+            .from('owners')
+            .select('id', { count: 'exact', head: true });
+        const { count: dogCount, error: dogsError } = await supabase
+            .from('senior_dogs')
+            .select('id', { count: 'exact', head: true });
+
+        if (ownersError) throw ownersError;
+        if (dogsError) throw dogsError;
+        const memberCount = ownerCount || 0;
+        const petsRegistered = dogCount || 0;
```

The rest of the function (`smsOptInRate`, `weeklyCheckIns`, `totalDataPoints`) needs **no change** — `smsOptInRate`'s denominator was already correctly using the dog count (SMS consent is genuinely per-dog, not per-owner, matching the same design decision made for `owner_pet_links.sms_consent` in the companion `Data_Model_Separation_Build.md`'s Phase 2), and `totalDataPoints = memberCount + weeklyCheckIns` should now read `petsRegistered + weeklyCheckIns` (baseline assessments are per-*dog*, not per-owner) — a second small, real correction surfaced by fixing the first one, included in the same proposed diff rather than left as a second silent bug:
```diff
-        const totalDataPoints = memberCount + weeklyCheckIns;
+        const totalDataPoints = petsRegistered + weeklyCheckIns;

         res.status(200).json({
-            foundingMembers: memberCount,
+            foundingMembers: memberCount,   // now = real owner count
             petsRegistered,
             totalDataPoints,
```

**Recommendation for whoever builds the ops dashboard**: apply this fix as its own small, standalone commit — it's a real, independently-shippable bug fix unrelated to the ops-dashboard build itself, and the ops dashboard's own headline-metrics function (above) should call the same corrected counting logic (or the fixed endpoint directly) rather than duplicating a second, parallel version of "count owners vs. dogs."

---

## Status: ✅ Investigation Phase 2 complete

Concrete route signatures, real (if illustrative) query code for all 5 headline metrics and 4 of the feature's Phase 1 report-library entries (the breed report deliberately left as "reuse the existing matcher" rather than duplicated), and a fully-specified, diff-shaped fix proposal for `/api/governance/stats`'s stale assumption are all above. Nothing has been applied — `server.js` is untouched, no migration exists, no route is live. Awaiting review before any of this moves to real schema/code changes.

---

## Build shipped (Sep 4, 2026) — then a real, previously-undetected production gap found during its own verification

`/ops`, `/api/ops/metrics`, `/api/ops/reports`, and `/api/ops/reports/:name/run` were built per the plan above (commit `ff7e086`), reusing the existing `ADMIN_PASSWORD`/`isAdminUnlocked`/`cc_admin_access` mechanism directly rather than a separate credential — the decision Finding 1 flagged as open, resolved in favor of "simpler, one fewer secret to manage." Initial verification was run against a **local** dev server with `ADMIN_PASSWORD` set in `.env` — real disposable test data, every headline metric and report row checked against independently hand-computed expected values, auth gating confirmed both ways. That local pass was genuine and correct, but it never touched production.

**The gap:** when this session went to verify the exact same behavior against production (`companioncommons.com`), `POST /api/admin-unlock` returned `503 {"success":false,"error":"Admin panel is not configured"}` — `ADMIN_PASSWORD` had never actually been set in Railway's environment variables, only locally. Confirmed via the code itself (`server.js:1226`, `:1232`): `isAdminUnlocked()` returns `false` unconditionally when the env var is unset, and the unlock endpoint fails closed with that exact 503, by design (see the comment at `server.js:1218-1221` — this is the correct, intended fail-closed behavior, not a bug in the gate itself).

**Real scope of the gap: this predates the ops dashboard entirely and affected `/admin` too.** `/admin` (the pre-existing marketing-copy editor, live since Aug 20's plaintext-password security fix) shares the exact same `ADMIN_PASSWORD`/`isAdminUnlocked` check. Since the same env var was missing in Railway, **`/admin` had been silently unreachable in production the entire time since Aug 20** — over two weeks — with nothing surfacing this anywhere, because a 503 on an internal tool nobody was actively using in production doesn't page anyone or fail any user-facing flow. This was found only because building `/ops` gave a fresh reason to actually test the admin-auth path against the real deployed environment, not because anything alerted on it.

**Fixed:** John generated a real `ADMIN_PASSWORD` value and set it in Railway's environment variables, then independently verified via a real PowerShell `POST /api/admin-unlock` request (using the real site-unlock cookie) that it now returns `{"success":true}` with a real `Set-Cookie: cc_admin_access=...` — confirmed working before this session's own verification pass ran.

### Full production verification, this session — all 5 checks pass

Run directly against `https://companioncommons.com` using the two real cookie values John provided (never the raw passwords — same pattern already established in this project for prior production checks behind `SITE_PASSWORD`, e.g. the Sep 4 puppy-signup structure check). No test data created or mutated at any point — every check was a `GET`, or a `POST` to the unlock/report-run endpoints that either reads existing data or sets an auth cookie, nothing that writes to `senior_dogs`/`mobility_checkins`/etc.

1. **`POST /api/admin-unlock`** — done by John directly (not this session, to avoid this session ever handling the raw password); confirmed `{"success":true}` with a real `cc_admin_access` cookie returned. ✅ PASS
2. **`GET /ops`, both cookies** — `200`, real dashboard HTML (`<title>CompanionCommons Ops</title>`), all 5 stat boxes present (`m-founding`/`m-pets`/`m-checkins`/`m-churn`/`m-streak`), report `<select>` present, logout button present, no password field. ✅ PASS
3. **`GET /api/ops/metrics` and `GET /api/ops/reports`, both cookies** — both `200` with real JSON. Metrics: `{"foundingMembers":0,"petsRegistered":0,"smsOptInRate":0,"totalCheckIns":0,"churnFlagCount":0,"longestStreak":0}` — genuinely all zero, consistent with the real, current pre-beta state (checklist item 47: zero real users as of Sep 4). Reports: all 4 shipped reports listed with correct names/descriptions (`signups_by_week`, `checkin_completion_by_week`, `completion_by_age_bracket`, `medication_category_breakdown`). ✅ PASS
4. **Site cookie only (no admin cookie)** — `GET /ops` returns `200` with the ops panel's *own* login form (`<title>CompanionCommons Ops — Login</title>`, real `type="password"` field) — confirmed distinct from the outer site gate's "Coming Soon" page (independently checked with zero cookies at all, which correctly shows "Coming Soon" instead). All three `/api/ops/*` routes (`metrics`, `reports`, and a `POST .../signups_by_week/run`) correctly return `401 {"error":"Not authorized"}` — the app's own `isAdminUnlocked` check, distinguishable from the outer gate's `401 {"error":"Site is locked"}` message. ✅ PASS
5. **`GET /admin`, both cookies** — `200`, real editor page (`<title>CompanionCommons Admin</title>`, real page-select dropdown with genuine page slugs: `home`/`about`/`independent`/`privacy`/`faq`/`founding`), no password field. Followed up with a real (read-only) `GET /api/page/home` using the same cookie — `200`, real live content returned (`hero_headline`, `hero_subheading`, etc., with real `created_at`/`updated_at` timestamps) — confirming the content API `/admin` depends on is also now genuinely reachable in production, not just the shell page. This is the first time `/admin` has been confirmed working against production since the Aug 20 security fix. ✅ PASS

**All 5 checks pass.** Both `/ops` and `/admin` are now genuinely live and correctly gated in production, for the first time. No test data was created, read, or modified against `senior_dogs`/`mobility_checkins`/any real-user table during this verification — only the static `page_content` row for `home` (pre-existing marketing copy, not user data) was read, never written.

**Standing lesson for future sessions, worth generalizing beyond this one incident:** a feature gated behind a Railway-only environment variable can pass every local test perfectly and still be completely broken in production if that variable was never actually set there — and unlike a missing *code* deploy (which this project already has a standing rule to verify via a real live request, per the Aug 26 RLS-remediation entry in the Build Log), a missing *env var* produces no error anywhere unless something specifically tries to exercise the gated path against the real deployed environment. `/admin` sat broken for over two weeks with zero signal. Any future feature gated behind a new Railway env var should get one real production smoke-test as part of its own rollout — not deferred until the next unrelated feature happens to need the same gate.
