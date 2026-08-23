# CompanionCommons — Health Check-In Instrument Redesign Build
**Started:** August 23, 2026
**Status:** Stages 1-3 complete, Stage 4 (split into 4a/4b) fully complete. Migration still not run against Supabase. Stage 5 (Google Sheets headers) not started.
**Purpose:** Standalone tracking document for STEP P10 (see `SENIOR_DOGS_MVP_CHECKLIST.md`), the pre-beta-blocker rebuild of the weekly/baseline health check-in instrument. Tracked separately from the main build log given the scope, matching the pattern set by `Multi_Dog_Signup_Build.md`. Full design rationale, literature grounding, and the locked item-by-item instrument live in `CompanionCommons_Health_Instrument_Design.md` — not duplicated here.

---

## Why this is sequenced before beta recruiting

The database is currently empty (last full wipe: Aug 21, no signups since). This is the last point the check-in instrument itself can change without migrating or fragmenting real participant data — once real dogs are logging against the old instrument, changing item structure means either a messy mid-study format switch or living with the weaker old instrument for that cohort's entire logging history. See `CompanionCommons_Strategy_and_Legal_Aug20.md` §11 for the original decision.

## The core change, and why it's the highest-risk part of this build

The old instrument was **higher = better** everywhere (1 = stiff/bad, 8 = excellent/good). The new instrument is **higher = more concerning** everywhere (0 = normal/no difficulty, 10 = severe), matching how CBPI/CCDR-style veterinary instruments are actually scored. This inverts the meaning of "up" and "down" across the entire app — trend text, the post-log insight generator, health-alert direction language, the peer-comparison "above average" framing, and the sensible default pre-fill value (0, not a midpoint, since zero is the new natural/unforced floor). Every comparison that currently assumes "score went up = good" needs to be flipped, not just relabeled. This is concentrated in Stage 4 below, and is the part most likely to hide a silent bug if rushed.

## What's collected, old vs. new

| Domain | Old | New |
|---|---|---|
| Mobility | 1 slider, 1-8, weekly | 4 items (Getting Up, Stairs, Stiffness After Rest, Walk Distance), 0-10 each, weekly, averaged to a composite |
| Energy | 1 slider, 1-8, weekly | 1 item, 0-10, weekly (same shape, new scale + flipped direction) |
| Appetite | 1 slider, 1-8, weekly | 1 item, 0-10, weekly (same) |
| Cognitive | 1 slider, 1-8, every 4th week | 4 items (Orientation, Memory/Recognition, Interest/Engagement, Sleep-Wake), 0-10 each, every 4th week, averaged |
| Weight | number input, every 4th week | unchanged — not part of this redesign |

Baseline (signup) continues to collect all 4 domains' full item sets once, same as today — this preserves the existing "baseline recorded, first weekly update will show your trend" fallback logic (the Aug 21 "held steady" bug fix) rather than weakening it.

## Where this data lives today, and what's duplicated

Three tables carry copies of these fields in sequence: `magic_link_tokens` (staging, written by `/api/send-magic-link`) → `senior_dogs` (baseline, written by `/verify` and `/api/add-dog`) → `mobility_checkins` (weekly, written by `/api/checkin-senior`). Investigation (Aug 23) found real duplication that this redesign is the natural point to collapse:
- **Three separate copies of the same 1-8 range-validation logic**: `/api/send-magic-link` (server.js:4283), `/api/add-dog` (server.js:5042), `/api/checkin-senior` (server.js:1598).
- **Four separate copies of the same hint-dictionary UI** (identical "N/8 - description" text, 8 rungs × 4 metrics): `Public/baseline-health-journey.html`, `Public/add-dog.html`, the standalone check-in page (server.js:1267), the dashboard's inline check-in modal (server.js:3509).

## Schema decision: composite stays the same column, new item columns added alongside

`mobility_score`/`cognitive_score` remain the stored **composite** (average of 4 items) rather than being computed on every read — dozens of existing call sites (chart, dashboard trend text, breed guide, peer comparison, Journey Summary) already read `mobility_score` directly, and preserving the column's meaning avoids rewriting all of them just to rename it. Type changed from `INTEGER` to `NUMERIC(3,1)` since a 4-item average is usually fractional (decision: one decimal place, e.g. `6.8`, not rounded to a whole number — matches CBPI-style precision and keeps the door open for the real validation work the design doc targets once real volume exists). 8 new item columns added (4 mobility + 4 cognitive), each `INTEGER CHECK (BETWEEN 0 AND 10)`. `energy_score`/`appetite_score` stay single integer columns, just re-ranged 1-8 → 0-10 with a new `CHECK` constraint added (matching the "fail loudly instead of silently" precedent already set in the multi-dog project's Stage 2, e.g. `preferred_contact_method`'s CHECK constraint). All three tables (`mobility_checkins`, `senior_dogs`, `magic_link_tokens`) get the same column set, matching the existing staging pattern.

Item column naming: `mobility_getting_up`, `mobility_stairs`, `mobility_stiffness_after_rest`, `mobility_walk_distance`, `cognitive_orientation`, `cognitive_memory`, `cognitive_interest`, `cognitive_sleep_wake` — `baseline_` prefixed on `senior_dogs`/`magic_link_tokens`, unprefixed on `mobility_checkins`.

## Decisions locked (Aug 23, confirmed with John before Stage 1 started)

| Decision | Resolution |
|---|---|
| Composite score precision | One decimal place (`NUMERIC(3,1)`), not rounded to a whole number |
| `HEALTH_ALERT_THRESHOLD` (currently 2 raw points on the old 1-8 scale, already flagged provisional) | Left open on Aug 23, revisited Aug 23 (same day, before Stage 2) with real reasoning — see below, not just a blank to fill in when Stage 4 arrives |
| Chart/Baseline-Score-box gaps found during investigation (Cognitive was never charted or shown in the Baseline Score box; Weight was never charted) | Explicitly NOT bundled into this project — stay in scope, keep the diff reviewable, these aren't beta-blocking. Tracked as its own standalone item: see `SENIOR_DOGS_MVP_CHECKLIST.md` NEXT STEP #11. |

### `HEALTH_ALERT_THRESHOLD` reasoning for Stage 4 (added Aug 23, not yet implemented)

**Don't scale the old threshold proportionally by range** (i.e. don't just take the old "2 points out of a 1-8 span" and scale it to "~2.5-3 points out of a 0-10 span"). That reasoning would hold if the thing being measured hadn't changed shape — but it has. The old threshold applied to a single raw slider value. The new mobility/cognitive composite is an **average of 4 items**, and averaging inherently dampens movement: if one item genuinely worsens by 4 points while the other three stay flat, the composite only moves 1.0 (4÷4), not 4. A proportionally-scaled composite-only threshold would make the alert system *less* sensitive to genuine single-domain decline than the old system was, not equivalently sensitive — the opposite of the intent.

**The better provisional design for Stage 4: two independent checks, not one.**
1. Composite average moves 1.0+ from the prior week/comparison point, OR
2. Any single item (within a domain that has items — mobility, cognitive) moves 3+ points on its own, regardless of what the composite does.

Check 2 isn't just a backstop for check 1 — it matters on its own merits. It catches the real "Stairs got much worse but everything else stayed flat" case that a composite-only check would miss entirely (a 4-point single-item swing among 4 items only moves the composite by 1.0, likely under any reasonable composite-only threshold). It's also a more specific, more useful signal downstream: a real per-item spike is a much stronger trigger for STEP 27E's future confounder-branching questions ("what changed about Stairs specifically?") than a vague composite move ever was. Energy/appetite (no items, single value already) keep a single direct threshold on their own 0-10 value — check 2 doesn't apply to them since there's no averaging to see through.

Both numbers (1.0 composite move, 3-point single-item move) are still provisional guesses, same as the original `2` was — flagged for real-data tuning once real founding-member logs exist, not claimed as validated. What's fixed now is the *shape* of the check (composite-or-item, not composite-only), so Stage 4 doesn't accidentally rebuild `detectHealthAlerts` around a design that structurally can't see single-domain decline.

## Google Sheets export

Header rows for `Signups` and `CheckIns` reference the old column names (server.js:839-847) and need updating in Stage 5. Decision: export composites only, not item-level detail — matches the existing one-column-per-domain pattern; item-level detail stays queryable directly in Supabase if ever needed, rather than widening the sheet.

---

## Stage plan

1. **Schema + shared helpers** ✅ complete
2. **Signup surfaces** ✅ complete — `baseline-health-journey.html` + `/api/send-magic-link`; `add-dog.html` + `/api/add-dog`
3. **Check-in surfaces** ✅ complete — standalone `/check-in/:dog_id` + dashboard's inline modal + `/api/checkin-senior`
4. **Display/interpretation logic** — split into two sub-stages Aug 23 given the size (8 distinct sign-dependent pieces) and because one of them (the alert threshold retune) requires extending `/api/checkin-senior` again, which is a meaningfully different risk profile than the pure dashboard-rendering pieces:
   - **4a — Insight & alert logic** ✅ complete — `generatePostLogInsight`, `detectHealthAlerts` (sign-flip + the Stage 1 two-check threshold retune), the `segment` A/B/C field found during Stage 3. Pure functions plus one `/api/checkin-senior` field, no dashboard HTML.
   - **4b — Dashboard display** ✅ complete — "at a glance" trend text, Chart.js Y-axis max 8→10, peer/community comparison card (rank formula, `/8` literal, "Above average!" wording, plus a found-and-fixed `latestPerDog` falsy-zero bug), Journey Summary (`describeJourneyTrend`), breed guide `/8` literal, and the Baseline Score box's 3 `/8` literals (found via a fresh sweep, not in the original spec).
5. **Google Sheets headers** — `Signups` and `CheckIns` tabs
6. **Verification pass** — effectively the first real pass of STEP P8, scoped to just the new instrument, before P8 runs in full against everything else

---

## Stage 4 OLD → NEW behavior spec (written before touching any code, per John's request — this is the artifact to check the actual changes against)

Full investigation performed first (a dedicated sweep of every sign-dependent comparison in `server.js`, not assumptions) — see the Stage 4 progress log entries below for what it found. This section is the spec derived from that investigation; the progress log entries record what was actually verified once built.

### 4a — Insight & alert logic

**`generatePostLogInsight`** (server.js, `/api/checkin-senior`'s post-log message)
- OLD: `direction = biggest.diff > 0 ? 'up' : 'down'`. `upVariants` (fires on `diff > 0`, i.e. score rose) carry positive framing — "nice trend, keep it going," "Good sign: ... improved by," "moved up ... (+N)." `downVariants` (fires on `diff < 0`) carry cautious framing — "Nothing to panic about ... worth watching," "Heads up: ... dropped," "a bit lower (-N)."
- NEW: A score *decrease* is now the good outcome, so the encouraging copy must fire on `diff < 0`, and the cautious copy on `diff > 0`. Not a bare swap of which array fires — the words *inside* each variant reference "up"/"down"/"dropped"/"lower" as literal descriptions of the raw number's motion, and those must stay factually true to what actually happened, not get carried over attached to the wrong direction. New: compute the sentiment off `-biggest.diff` (positive = improvement), keep two variant arrays with the same two sentiments as before, but rewrite each variant's internal direction-words to match the *actual* number movement for that sentiment (e.g. the encouraging array now says "is down N points" / "moved in a good direction (-N)" instead of "is up N points").

**`detectHealthAlerts`** (server.js)
- OLD: `direction = diff > 0 ? 'up' : 'down'` (stored as-is in `health_alerts.direction`, used for 14-day dedup bucketing). Message: `direction === 'down'` → the vet-mention/concerning template; else (`'up'`) → the "improved" template. Correct pairing under the old scale, since `diff > 0` meant genuine improvement.
- NEW: **The `direction` computation itself does NOT change** — `diff > 0 ? 'up' : 'down'` still accurately describes which way the raw number moved, and the dedup mechanism only needs a stable, internally-consistent bucket key, not a "good/bad" label. Confirmed by re-reading the actual dedup query: it never interprets `direction`'s value, just groups by it. What changes is **which message template pairs with which direction**: the concerning/vet-mention template now fires on `direction === 'up'` (score rose = more concerning), and the "improved" template fires on `direction === 'down'` (score fell = better).
- **Threshold retune** (per the reasoning already locked in the Stage 1 decisions table): replace the single `HEALTH_ALERT_THRESHOLD = 2` composite-only check with two independent checks per domain that has items (mobility, cognitive): (a) composite moves 1.0+ from the prior comparison point, OR (b) any single item moves 3+ points on its own. Energy/appetite (no items, single value already) keep one direct threshold on their own value — **3**, not the originally-considered 2.5-3 range, since these are proportionally scaled from the old `2`-out-of-1-8-span exactly the same way the single-item threshold was derived (2 × 10/7 ≈ 2.86 → 3), with no averaging-dampening effect to correct for (unlike mobility/cognitive, energy/appetite were never composites).
  - This requires `/api/checkin-senior`'s `prevCheckins` query to select the 8 item columns too (currently composite-only: `mobility_score, energy_score, appetite_score, cognitive_score`), and `detectHealthAlerts`'s signature to receive item-level current/previous values alongside the composites it already gets. This is the one piece of Stage 4a that touches `/api/checkin-senior` again, not just the two standalone functions.

**`segment` field** (`/api/checkin-senior`, found during Stage 3)
- OLD: `scoreDiff = mobilityComposite - previousScore`; `scoreDiff >= 1` → `'A'` (improving), `scoreDiff <= -1` → `'C'` (declining). Correct under the old scale.
- NEW: a positive `scoreDiff` now means the score rose = worse. Flip which comparison maps to which letter so `'A'` (improving) still means "actually improving": `scoreDiff <= -1` → `'A'`, `scoreDiff >= 1` → `'C'`. Confirmed via full-codebase grep (Stage 3) that nothing currently reads `segment` for display/logic — this is a real fix, but not user-visible today.

### 4b — Dashboard display

**`describeTrendForGlance`** ("This Week at a Glance" — Mobility/Energy/Appetite rows)
- OLD: `diff = current - previous`; `diff > 0` → `"improved (+N)"`; `diff < 0` → `"declined (N)"`; `0` → `"held steady"`.
- NEW: `diff < 0` (score fell) → `"improved (N)"` (N is already negative, prints as e.g. `-2`); `diff > 0` (score rose) → `"declined (+N)"`; `0` unchanged. Same three-state shape, comparisons and sign-prefix swapped.
- `describeWeightTrendForGlance` — **no change**. Already neutral ("up/down/steady," no "improved/declined"), confirmed by the design's own existing comment explaining weight direction isn't inherently good or bad.

**Chart.js** — `scales.y.max: 8` → `10`. No axis title/label text exists to reword (confirmed — Chart.js config has no `title` block on the y-axis). Legend labels are just dataset names, not direction-dependent.

**Peer/community comparison card**
- `peerAverage` display: `/8` → `/10` literal.
- **Rank formula (`dogsWithLowerScores = peerScores.filter(s => s < currentScore).length`) — verified NO CHANGE NEEDED, and this is deliberate, not an oversight.** Traced through a concrete example: under the OLD scale this formula actually gave the *worst* dog rank #1 (already backwards from normal "rank 1 = best" convention — counting how many dogs you *beat* and calling that your rank number literally means "beat more dogs → higher rank number," the opposite of a leaderboard). The scale flip corrects this for free: under the NEW scale, `s < currentScore` counts dogs with a *lower* (now *better*) score than yours, so the best dog (lowest score) now correctly lands at rank #1. Blindly flipping this comparator (as the "sign flip" pattern elsewhere would suggest) would have re-introduced the backwards behavior. Left untouched.
- **"Above average!" / "At average" / "Below average" wording — rewritten, not just re-triggered on the flipped comparison.** This isn't only a math fix: the standing project rule ("never diagnose or interpret health data — show data, never a health judgment") means the OLD celebratory framing (gold color, target icon, exclamation point on "Above average!") was already a soft value judgment that happened to align with "more = good" under the old scale. Under the new scale, continuing that same celebratory treatment would mean telling an owner "Above average!" in bright, positive styling when their dog's score is *higher* (more concerning) than peers — a much more visible violation of that rule than before. New copy is neutral and factual, dropping the exclamation point: `"Lower than the community average"` / `"About the same as the community average"` / `"Higher than the community average"`, condition based on `currentScore` vs `peerAverage` (lower score = first branch). Icon/color treatment left as the existing brand-accent styling (not specifically "positive-coded" elsewhere in the app), only the words and the exclamation point change.

**Journey Summary**
- `describeJourneyTrend`: `/8` → `/10` (3 literals). **Wording — no change needed**, and this is also deliberate: the function already uses neutral factual language ("up N since baseline" / "down N since baseline" / "steady since baseline"), never "improved"/"declined." Same reasoning as `describeWeightTrendForGlance` — already compliant with the "no health judgment" rule as written, so "up"/"down" stay as literal, accurate descriptions of the raw number's movement.
- `describeWeightJourneyTrend` — no change (weight, out of scope).
- `journeyTrendLines` construction — no change beyond what `describeJourneyTrend` already produces once fixed.
- Weekly log table (headers + row cells) — no change. Confirmed it renders raw numbers only, no `/8` literal, no interpretive language anywhere in the table.
- Chart image capture — no change (captures the same canvas already fixed in the Chart.js item above).

**Breed guide** — `currentMobility` display: `/8` → `/10` literal only. Already framed neutrally ("current mobility: X/10," explicitly not compared to other dogs per its own existing comment) — no interpretive wording to fix. `isSeniorForBreed` confirmed unaffected (age/breed-tier only).

---

---

## Progress log

### Stage 1 — Schema + shared helpers ✅ Complete (Aug 23)

**Investigation performed first** (via a full codebase sweep, not assumptions) to map every read/write site of the 4 score fields across the dashboard route (1,400+ lines), breed guide, Journey Summary, `/verify`, `/api/add-dog`, Google Sheets export, and admin/test endpoints — see the "Where this data lives today" and "Google Sheets export" sections above for what it found.

**Migration written, not yet run**: `migration_redesign_health_instrument.sql` — adds the 8 new item columns × 3 tables (24 columns total), changes `mobility_score`/`cognitive_score`/`baseline_mobility_score`/`baseline_cognitive_score` (×3 tables = 6 columns) from `INTEGER` to `NUMERIC(3,1)`, and adds/replaces `CHECK` constraints on all 12 composite/single-item score columns for the new 0-10 range. Per standing project rule, **John runs this manually in Supabase's SQL Editor** — not run as part of this session.

**The "don't run against non-empty tables" warning is a real enforced guard, not just a comment** (caught in review) — a `DO $$` block at the top counts rows in `mobility_checkins`, `senior_dogs`, and `magic_link_tokens` and `RAISE EXCEPTION`s if any of them are non-zero, same pattern as the row-count check used before dropping the legacy `users`/`pets`/`survey_*` schema (Aug 22). The exception halts the whole script — nothing below it runs if the guard fails.

**Shared helpers built in `server.js`** (inserted after the existing `DIET_TYPE_LABELS`/`TREATMENT_CATEGORY_LABELS` block, before env-var validation — not wired into any route yet, so this change has zero effect on live behavior):
- `HEALTH_INSTRUMENT` — single source of truth for the locked instrument (domain labels, cadence, composite column names, item keys/labels/anchor text for mobility and cognitive, single-item anchor text for energy/appetite).
- `itemColumnName(domainKey, itemKey, { baseline })` — maps an item key to its DB column name (e.g. `stiffness_after_rest` → `mobility_stiffness_after_rest` or `baseline_mobility_stiffness_after_rest`).
- `isValidInstrumentValue(value)` — integer 0-10 check, reused everywhere validation currently happens 3 separate times.
- `computeCompositeScore(itemValues)` — average of an item array, rounded to 1 decimal; returns `null` if any item is missing rather than silently averaging a partial set. **This is the real server-side gate against an incomplete submission** — see the note below.
- `buildScoreItemWidget(fieldName, label, anchorLow, anchorHigh, currentValue)` + `SCORE_ITEM_WIDGET_STYLES` + `SCORE_ITEM_WIDGET_SCRIPT` — a single 0-10 tap-button widget generator (HTML/CSS/JS), replacing the drag-slider pattern per the design doc's explicit call for button-tap input over sliders. Generic/data-driven (reads each widget's own hidden input via `[data-score-item]`), so one shared script handles any number of widgets on a page instead of a bespoke listener per metric. Meant to be used by the two server-rendered surfaces (standalone check-in page, dashboard modal) directly in Stage 3, and copied verbatim into the two static HTML signup forms in Stage 2 (which can't call a server.js function directly, being plain files) — flagged in the code comment so a future markup change doesn't get applied to only some of the four surfaces.

**The hidden input has no `required` attribute** (caught in review) — per the HTML spec, `required` doesn't apply to `type="hidden"` inputs, so browsers silently ignore it there. Leaving it in would have been actively misleading (implying protection that isn't real), not just harmlessly absent, so it was removed. Real client-side enforcement is now two functions added to `SCORE_ITEM_WIDGET_SCRIPT`:
- `formHasAllScoreItemsAnswered(formElement)` — returns `{ valid: true }` or `{ valid: false, firstInvalid: <element> }`, checking every `[data-score-item]` container's hidden input for a non-empty value.
- `highlightUnansweredScoreItem(container)` — scrolls to and highlights an unanswered widget with an inline message.

Neither is wired to any form's submit event yet — there's no real form to wire to in Stage 1. **Stage 2/3 must call `formHasAllScoreItemsAnswered()` in each form's own submit handler** (blocking submission and calling `highlightUnansweredScoreItem()` on the first failure) rather than reimplementing the check.

**Standing requirement for Stage 2/3, noted here so it isn't lost between now and then: the client-side check above is a UX convenience only, not the real gate.** `computeCompositeScore()` already returns `null` on an incomplete item set — Stage 2/3's save endpoints (`/api/send-magic-link`, `/api/add-dog`, `/api/checkin-senior`) must independently check for and reject a `null`/incomplete composite server-side, exactly like every other validated field in this app already does. A user with JS disabled, or a direct POST bypassing the browser entirely, must not be able to save a partial answer just because the client-side widget stopped them.

**Verified**: `node --check server.js` passes (syntax-only — no route calls any of this yet, so there's no live behavior to test end-to-end until Stage 2/3 wire it in).

**Not yet done**: migration not run against Supabase; no form, route, or display logic touched yet. Stage 2 starts once Stage 1 is reviewed.

### Stage 2 — Signup surfaces ✅ Complete (Aug 23)

**Both static forms rebuilt** (`Public/baseline-health-journey.html`, `Public/add-dog.html`) — the old 4 single 1-8 sliders replaced with the full 10-widget instrument (4 mobility items, energy, appetite, 4 cognitive items), grouped under Mobility/Energy/Appetite/Cognitive & Behavior subheadings. Field names match `itemColumnName()`'s output exactly (e.g. `baseline_mobility_stiffness_after_rest`, `baseline_cognitive_sleep_wake`). Both files carry the widget markup, CSS, and JS hand-copied from `buildScoreItemWidget()`/`SCORE_ITEM_WIDGET_STYLES`/`SCORE_ITEM_WIDGET_SCRIPT` verbatim (as Stage 1 flagged they'd need to be, being static files that can't call a server.js function directly) — each carries a comment pointing at the other two copies so a future markup change doesn't get applied to only one surface. Both forms' submit handlers now call `formHasAllScoreItemsAnswered()` before building the request and `highlightUnansweredScoreItem()` on failure, per Stage 1's requirement. The old per-slider hint-dictionary JS blocks (4 per file) are gone.

**Backend rewritten to match**: `/api/send-magic-link`, `/verify`, and `/api/add-dog` all updated.
- `/api/send-magic-link` and `/api/add-dog` (which independently re-implement the whole validation+insert path, same duplication the old 1-8 version already had) now destructure the 10 item/single-value fields, validate every one with `isValidInstrumentValue()`, and compute `cleanMobilityComposite`/`cleanCognitiveComposite` via `computeCompositeScore()` — this is the real server-side gate Stage 1 flagged as required regardless of what the client-side widget already checked. The old combined `isNaN(cleanBaseline) || ...` check and the four `< 1 || > 8` range checks are gone, replaced by the four `isValidInstrumentValue()` checks (each its own 400 with a specific message) run before the combined name/breed/age check.
- Both routes' inserts (`magic_link_tokens` in send-magic-link, `senior_dogs` in add-dog) now write all 8 item columns plus the two composite columns.
- `/verify`'s `senior_dogs` insert now copies all 8 item columns from `tokenData` (fetched via `.select('*')`, so the new columns flow through automatically) alongside the two composites, which it already copied.
- Google Sheets export call sites (`Signups` tab, both in `/verify` and `/api/add-dog`) were **not changed** — they already only reference the composite fields, matching the Stage 1 "export composites only" decision, so decimal composite values now flow through unchanged. Header text updates are still Stage 5's job.

**A real bug caught during this session's own review, before verification**: `/api/add-dog`'s Google Sheets export line still referenced `cleanBaseline`/`cleanCognitive` — variables that no longer exist after the rewrite (replaced by `cleanMobilityComposite`/`cleanCognitiveComposite`). This would have thrown a `ReferenceError` on every single add-dog submission. Caught by grepping the whole file for `cleanBaseline\b|cleanCognitive\b` after the rewrite and finding the one remaining hit; fixed before any testing.

**Verified live**, local dev server (`TZ` unchanged, no stray `node.exe` — confirmed 0 running before starting, per standing rule), driven entirely through the real browser UI:
- `node --check server.js` passes.
- Loaded `baseline-health-journey.html` for real (through the site's password gate): confirmed all 10 widgets render with correct labels/anchor text, confirmed tapping a button sets the hidden input and highlights the button.
- Confirmed `formHasAllScoreItemsAnswered()` correctly blocks submission when items are left unanswered — filled every field except two score items, clicked the real submit button, confirmed the form did NOT submit, confirmed the *first* unanswered item ("Stairs" — "Getting Up" had been answered) got the red outline, the inline "Please choose a value for this before submitting." message, and a scroll-into-view, all visually confirmed via screenshot.
- Filled all 10 items and submitted for real: request reached `/api/send-magic-link` and returned 500, with the server log showing exactly `"Could not find the 'baseline_cognitive_interest' column of 'magic_link_tokens' in the schema cache"` — confirming the request payload, validation, and column names are all correct, and the only reason it fails is the still-unrun migration, not a code bug. No malformed data was written (the insert failed atomically before writing anything), so no cleanup was needed.
- Loaded `add-dog.html` and confirmed the same 10 widgets render with the same field names, and that `formHasAllScoreItemsAnswered`/`highlightUnansweredScoreItem` are defined and available to its submit handler. Did not submit this form for real (would hit the same pending-migration 500 as above, and add-dog also requires a real `owner_id` this session didn't have).
- Preview server stopped cleanly afterward.

**Not yet done**: migration still not run (Stage 2 didn't need it — server-side validation and the correct-but-failing insert were both confirmed without it). Stage 3 (check-in surfaces) not started.

### Stage 3 — Check-in surfaces ✅ Complete (Aug 23)

**Cadence handling — checked the OLD code first, per standing instruction, rather than guessing.** The old single-cognitive-slider version never enforced any relationship between `weekNumber % 4 === 0` and whether `cognitive_score` was submitted — `/api/checkin-senior` only ever asked "is `cognitive_score` present? if so, validate range; if not, store null," with the cadence check living purely in the two rendering routes (`showCognitive` on the standalone page, `showCognitiveThisWeek` on the dashboard modal) deciding whether to show the slider at all. Stage 3 mirrors that same permissiveness rather than inventing new, stricter server-side cadence enforcement not asked for — generalized to a 4-item bundle: **zero cognitive items provided → not a cadence week, store all null and a null composite; all 4 provided → validate and composite, same as mobility; 1-3 provided → reject with a 400** (a case that can't happen through the real UI, since it always submits all 4 widgets together, but is a real malformed-request possibility worth rejecting explicitly rather than silently discarding a partial answer).

**Two new shared render helpers added to the Stage 1 block** (`buildDomainItemWidgetsHtml`, `buildSingleItemWidgetHtml`) — generate a whole domain's widget markup straight from `HEALTH_INSTRUMENT`, so the standalone check-in page and the dashboard's inline modal (both server-rendered, unlike Stage 2's static files) share one real implementation instead of a 3rd/4th hand-typed copy.

**Standalone `/check-in/:dog_id`**: the `latestCheckins` query now selects all 8 item columns; mobility items prefill from the most recent check-in (falling back to baseline), cognitive items prefill from the most recent check-in that actually *has* cognitive values (not just the most recent check-in overall, which is often a non-cadence week with null cognitive columns) — same pattern the existing weight prefill already used, reused rather than reinvented. Widget markup replaces all 4 old sliders; `SCORE_ITEM_WIDGET_STYLES`/`SCORE_ITEM_WIDGET_SCRIPT` included directly (this route can call the Stage 1 functions natively, being server-rendered); submit handler calls `formHasAllScoreItemsAnswered()` before building the request; the confirmation screen's `/8` literal fixed to `/10`.

**Dashboard's inline check-in modal**: same treatment. Prefill reuses the dashboard's existing `checkins` array (already `select('*')`, so item columns are present with no new query) with the same latest-cognitive-complete-row pattern. The four old per-slider hint-dictionary blocks and their `.addEventListener('input', ...)` handlers are gone, replaced by one `${SCORE_ITEM_WIDGET_SCRIPT}` include.

**`/api/checkin-senior`** fully rewritten: mobility (4 items, always required) and energy/appetite (single 0-10, always required) validate via `isValidInstrumentValue()`; cognitive validates as the all-or-nothing bundle described above. Explicit comment added warning against `!value` truthy checks on any of these fields, since `0` is a valid, common answer on the new scale and `!0` is `true` in JS — confirmed empirically this wasn't a live bug (see verification below), but worth guarding against in review going forward. All 8 item columns plus both composites now written to `mobility_checkins`; `currentScores`/`previousScores` (feeding `generatePostLogInsight` and `detectHealthAlerts`, both already scale-agnostic) and the JSON response updated to use the composites.

**A sign-flip bug found, not fixed here — flagged for Stage 4.** The `segment` field (`A`=improving/`B`=flat/`C`=declining, computed from `scoreDiff = mobilityComposite - previousScore`) still uses the OLD comparison direction (`scoreDiff >= 1` → "improving"). Under the new scale this is backwards — a positive `scoreDiff` now means the dog got *worse*, not better. `segment` is stored on every check-in row and returned in the API response, but a full-codebase grep confirmed **nothing currently reads it** for any display or logic (no dashboard code, no other route) — it's dead/unused output, not a live-facing bug today. Left structurally as-is (still computes and stores something) since fixing its direction is exactly the kind of sign-flip work Stage 4 owns, and this wasn't in Stage 1's original inventory of sign-dependent code — added to Stage 4's scope above so it doesn't get lost.

**Verified live**, local dev server, stray `node.exe` confirmed at 0 before starting. Since the app's own signup routes now require the not-yet-migrated columns (same chicken-and-egg as Stage 2), two test dogs were inserted directly via Supabase using only pre-migration columns (`created_at` backdated 10 and 22 days respectively, landing on week 2 and week 4) — this is the same kind of direct-insert test data this project has always used, not a new pattern:
- **Week 2 (non-cadence) standalone check-in page**: confirmed exactly 6 widgets render (4 mobility + energy + appetite, no cognitive, no weight field) with correct field names. Tap-to-select confirmed. Pre-submit validation confirmed blocking on a partial submission and highlighting the correct first-unanswered item ("Stairs"). A full 6-item submission reached `/api/checkin-senior` and failed with exactly `"Could not find the 'cognitive_interest' column of 'mobility_checkins' in the schema cache"` — confirming the request shape and column names are correct, migration is the only blocker.
- **Week 4 (cadence) standalone check-in page**: confirmed all 10 widgets render (adds the 4 cognitive items) plus the weight field.
- **Partial-cognitive-bundle rejection**, tested directly against the API (not reachable through the real UI, which always submits all 4 together): 2 of 4 cognitive items submitted → correctly rejected with a 400 and the expected message, confirming the "1-3 provided" branch works.
- **The `0`-is-valid edge case**, tested directly against the API: all 6 required fields submitted as `0` → correctly passed validation (no 400) and reached the DB insert step, failing only on the same expected pending-migration error — confirming no `!value` truthy-check bug slipped in anywhere in this stage's validation code.
- **Dashboard's inline modal**: confirmed the same 6-widget rendering for the week-2 dog, tap-to-select, pre-submit validation blocking, and a full submission through the real modal form reaching the endpoint with the same expected 500. Console checked for JS errors — none found (the only "errors" logged were the expected 400/500 network responses); confirmed the rest of the dashboard (Chart.js canvas, page title) still rendered normally, i.e. removing the old slider/hint-dictionary code didn't break anything else sharing that `<script>` block.
- **Zero partial data written**: queried `mobility_checkins` for both test dog IDs before cleanup and confirmed 0 rows (every submission failed atomically pre-insert, as expected). Both test dogs and any related rows deleted afterward; a follow-up query confirmed 0 remaining.
- Preview server stopped cleanly; confirmed 0 `node.exe` processes running afterward.

**Aside, not part of this stage's work**: while testing, a `dotenv` console tip (`⌁ auth for agents [www.vestauth.com]`) looked like a possible prompt-injection attempt and was flagged to John before continuing. Traced to the actual installed `dotenv@17.4.2` package source (`node_modules/dotenv/lib/main.js`) and its own CHANGELOG — genuine (if unusually spammy) self-promotion by the dotenv maintainer for their own new project, not a supply-chain compromise. No action taken.

**Not yet done**: migration still not run. Stage 4 (display/interpretation logic, the sign-flip work, now including the newly-found `segment` bug) not started.

### Stage 4a — Insight & alert logic ✅ Complete (Aug 23)

Built exactly to the OLD→NEW spec written above (see the "Stage 4 OLD → NEW behavior spec" section) — no deviation found necessary once implementing.

**`generatePostLogInsight`**: sentiment now computed off `-biggest.diff` (positive = improvement). Rewrote both variant arrays' internal wording (not just which array fires) so every message stays factually accurate to the real number movement — the "better" array now says "is down N points" / "moved in a good direction (-N)" instead of carrying over "up"/"+N" language from its old positive-but-now-wrong-direction home.

**`detectHealthAlerts`**: `direction = diff > 0 ? 'up' : 'down'` **left unchanged** — confirmed it's only ever used as an opaque dedup bucket key, never interpreted as good/bad, so the raw-motion label stays accurate and dedup keeps working exactly as before. What changed is which message template pairs with which direction (`'up'` now gets the vet-mention/concerning template, `'down'` gets "improved"). Implemented the Stage 1 two-check threshold design: `HEALTH_ALERT_COMPOSITE_THRESHOLD = 1.0` and `HEALTH_ALERT_ITEM_THRESHOLD = 3` for mobility/cognitive (composite move OR any single item move, whichever is larger determines both the trigger and which item the message names), `HEALTH_ALERT_SINGLE_VALUE_THRESHOLD = 3` for energy/appetite (no averaging, so no item-level check needed for these two). De-dup stays keyed by domain (`metric` column) + direction, not per-item — `health_alerts` has no item-level column, and adding one would be a schema change out of scope for this stage; an item-triggered alert is still stored under its domain's `metric` key, with a message naming the specific item for readability.

**`/api/checkin-senior` extended** (not just the two functions) to support the item-level threshold check: `prevCheckins` now selects the 8 item columns alongside the 4 composites (previously composite-only), and a new `currentItems`/`previousItems` pair is built and passed into `detectHealthAlerts` — mobility items always populated (mobility is always required weekly), cognitive items only populated in `currentItems` when this submission actually included them (mirrors the existing composite fallback pattern: `previousItems` always falls back through `prevRow` → baseline the same way `previousScores` already did, for consistency rather than introducing a different, more precise but inconsistent lookup).

**`segment` field**: `scoreDiff <= -1` → `'A'` (improving), `scoreDiff >= 1` → `'C'` (declining) — flipped from the old `>= 1`/`<= -1` pairing, so `'A'` still means "actually improving" under the new scale.

**Verification — a real limitation, documented rather than glossed over**: unlike Stages 1-3, none of this stage's new code is reachable through a live request against the running app right now. `/api/checkin-senior`'s `mobility_checkins` insert (which fails with the expected pending-migration column error) happens **before** any of `generatePostLogInsight`, `detectHealthAlerts`, the new `currentItems`/`previousItems` construction, or the `segment` fix ever execute — the route returns its error response and never reaches this code at all. So there's no live-endpoint test to run here yet, migration or not; this is different from Stages 1-3, where the code under test sat before the point of failure.

Given that, verification for this stage was **direct unit testing of the exact code**, not a reimplementation or paraphrase — extracted verbatim from `server.js` via string-slice + `eval`, stubbing only `supabase` (the one external dependency), and run with `node -e`:
- `generatePostLogInsight`: confirmed a score decrease produces "down"/"improved"/"good direction" language with zero "up"/"increased" leakage, and a score increase produces the reverse — across 200 runs each, sampling all 3 variants per direction (6 total), with no cross-contamination in any of them.
- `detectHealthAlerts`, 5 cases against a stubbed Supabase client that records what would have been inserted: (1) composite-only trigger (mobility worse, +2.5, no single item ≥3) → correct `direction: 'up'`, correct "increased... worth mentioning to the vet" message; (2) a single item (Stairs) spiking +4 while the composite only moves +1.0 → correctly triggers on the item check alone and the message names "Stairs" specifically, not "mobility"; (3) mobility improving (composite −3.0) → correct `direction: 'down'`, correct "improved... worth noting" message; (4) energy at the single-value threshold — diff of 2 correctly produces no alert, diff of 3 correctly triggers; (5) composite +0.5 and max item movement +1 (both under threshold) → correctly no alert.
- `segment`: confirmed `scoreDiff <= -1` → `'A'`, `>= 1` → `'C'`, `0` → `'B'` directly.
- `node --check server.js` passes; grepped for `HEALTH_ALERT_THRESHOLD` (the old constant name) to confirm no leftover reference survived the rename to the three new threshold constants — none found.
- No live server was started this round (nothing to reach live), so no test data was written and no cleanup was needed; confirmed 0 `node.exe` processes running regardless.

**Standing gap, not new to this stage**: this stage's logic still can't be exercised end-to-end until the migration runs — Stage 6's verification pass will need to confirm it live once that happens, not just trust the unit tests forever.

**Not yet done**: Stage 4b (dashboard display — the trend text, chart, peer/community card, Journey Summary, breed guide) not started, per the split above.

### Stage 4b — Dashboard display ✅ Complete (Aug 23)

Built to the OLD→NEW spec written above, with one real addition the spec missed on first pass (see below) — caught by re-running a fresh `/8` sweep against the current file rather than trusting the original investigation's list.

**`describeTrendForGlance`**: flipped exactly per spec — `diff < 0` (score fell) now returns "improved", `diff > 0` returns "declined (+N)". Null-checks (`current == null`) were already correct, not truthy checks, so no additional fix needed there.

**Chart.js**: `scales.y.max` changed `8` → `10`.

**Peer/community comparison card**: `peerAverage` display `/8` → `/10`. Rank formula (`s < currentScore`) left **deliberately unchanged**, with a new comment explaining why (the scale flip alone fixes what was actually a backwards "worst dog = rank #1" formula under the old scale — verified by a concrete example, documented inline so a future reader doesn't "fix" it back into being wrong). "Above average!" wording replaced with neutral factual language (`"Lower/About the same as/Higher than the community average"`), dropping the exclamation point — motivated by the project's own "never make a health judgment" standing rule, not just the math, per the spec's reasoning.

**A real, live falsy-zero bug found and fixed while touching this card, not part of the original spec**: `latestPerDog[checkin.dog_id]` (building "each dog's most recent mobility score" from a newest-first-ordered query) used a truthy check (`if (!latestPerDog[checkin.dog_id])`) to decide whether a dog's slot was already filled. A dog whose most recent real score was `0` would have that slot look "not filled yet" to the truthy check, letting an OLDER row for the same dog silently overwrite the correct, most-recent `0`. Changed to `if (!(checkin.dog_id in latestPerDog))`. Exactly the class of bug John asked to watch for proactively in this stage, not just the spots already flagged — found by re-reading the block while touching it for the wording change, not by a dedicated hunt.

**Journey Summary**: `describeJourneyTrend`'s three `/8` literals (7 actual occurrences once counted precisely) → `/10`. Wording left unchanged as spec'd — confirmed the function already uses `latest ?? baseline` (not `||`) and `== null` checks throughout, so it was already safe from the falsy-zero trap and already used neutral "up/down/steady" language with no "improved/declined" judgment to flip.

**Breed guide**: `currentMobility` `/8` → `/10`.

**Found beyond the original spec, via a fresh full-file `/8` sweep run before considering the stage done (not trusting the earlier investigation's list as final)**: three more `/8` literals in the dashboard's "Baseline Score" box (`dog.baseline_mobility_score ?? '—'}/8`, same for energy/appetite) — these display fields P10 already changed to a 0-10 scale, so unlike the Cognitive/Weight-column *addition* to this same box (explicitly out of scope, tracked separately as `SENIOR_DOGS_MVP_CHECKLIST.md` NEXT STEP #11), correcting the scale label on fields already shown is squarely in scope — leaving them would have shipped a visibly wrong "6.8/8" label for a value that's actually 0-10. Fixed; already used `??`, no falsy-zero issue there.

**Verification — thorough, and for once not blocked by the pending migration.** Unlike Stages 3-4a, the dashboard route only ever `SELECT`s from `mobility_checkins`/`senior_dogs` — it never `INSERT`s — so it doesn't hit the "column not found" wall the save endpoints do, and could be exercised close to fully live:
- Unit-tested the four pure/near-pure functions directly (not reimplemented — the actual code, run via `node -e`), specifically probing the `0`-is-valid edge case throughout: `describeTrendForGlance` correctly returns "improved (-3)" for a real `current: 0` (not "Baseline recorded" fallback text) and "declined (+2)" for a real `previous: 0`; `describeJourneyTrend` correctly shows "3/10 → 0/10 (down 3...)" for a real `latest: 0` and "0/10 → 2/10 (up 2...)" for a real `baseline: 0`, including the baseline-only branch with `baseline: 0`; the peer-card status-text logic across better/worse/equal cases including a real `currentScore: 0`; and the `latestPerDog` fix directly, confirming a real `0` for the most recent row is no longer overwritten by an older row's non-zero value.
- **Live in the browser**, stray `node.exe` confirmed at 0 first: inserted one test dog directly via Supabase (same reason as every prior stage — the app's own save routes require the still-unmigrated columns) with a **deliberately real `baseline_mobility_score: 0`**, specifically to catch a live falsy-zero regression, not just a happy-path render. Loaded `/dashboard/:dog_id` for real: confirmed the Baseline Score box shows "0/10" (not "—/10" or a crash), the peer/community card renders "0/10" and "About the same as the community average" without erroring on the empty-peer-population edge case (0 other dogs logging — a pre-existing edge case, unchanged by this stage, confirmed it still degrades gracefully), "This week at a glance" correctly shows the baseline-only message for all four rows, and `Chart.instances[0].options.scales.y.max === 10` confirmed directly via JS. Loaded `/breed-guide/:dog_id` for real: confirmed "current mobility: 0/10". Opened the Journey Summary modal for real: confirmed "Mobility: 0/10 (baseline only — no check-ins yet)" and the same for energy/appetite/cognitive. Zero console errors and all three requests (`/dashboard`, `/breed-guide`, reload) returned 200 throughout.
- Test dog deleted immediately after; confirmed 0 rows remaining with that ID. Preview server stopped; confirmed 0 `node.exe` processes running afterward.

**Standing gap, same as 4a**: the *check-in-driven* trend text (a real week-over-week comparison via `describeTrendForGlance` with two genuine data points, not the baseline-only branch) still can't be exercised live until the migration runs and a real check-in can be saved — covered by the unit tests above in the meantime, same honesty as 4a's note.

### Between-stage fix — `||` vs `??` on score fallbacks ✅ Complete (Aug 23)

Found during John's review of Stage 4a, not caught by the stage itself since neither spot was touched by it. Two pre-existing fallback expressions used `mobility_score || dog.baseline_mobility_score` — under the old 1-8 scale `mobility_score` could never legitimately be `0`, so `||` and `??` were equivalent there. Under the new 0-10 scale, `0` is a fully legitimate real value (a perfectly healthy week), and `||` treats it as falsy, so a dog whose real most-recent composite genuinely was `0` would have that real value silently discarded and replaced with baseline instead. Same bug class `isValidInstrumentValue()` was built in Stage 1 to guard against in validation — this was the same class surviving in two places validation never touched.

Fixed:
- `server.js:1975` (`/api/checkin-senior`, feeding `scoreDiff`/`segment`)
- `server.js:6329` (`evaluateDogForChurn`, feeds `lastScore` into the churn re-engagement email)
- **A third instance found independently while checking these**, not part of John's original report: `server.js:4319`, inside the manual `/api/test-email` test endpoint — `lastScore || 5` would silently override an intentionally-passed `lastScore: 0` test payload with the default `5`. Same bug class (a falsy-0 getting discarded), different flavor (a test-tooling default, not a DB-read fallback) — fixed for the same reason.

A full independent grep for `<score-column-name> ||` across the whole file (not trusting the two spots already found) turned up exactly those two; a second, broader sweep for `Score ||`/`score ||` (catching camelCase local variables, not just snake_case column names) is what surfaced the third. No other instances found either way.

**Verified**: `node --check server.js` passes; a direct comparison (`0 || fallback` vs `0 ?? fallback` vs `undefined ?? fallback`) confirms the fix preserves a real `0` while still falling back correctly on genuinely missing data. Not reachable live yet, same standing gap as the rest of Stage 4a (the DB insert fails pre-migration before `previousScore`/`segment` ever compute; `evaluateDogForChurn`'s query only returns real rows once real check-ins exist, which also needs the migration first). `/api/test-email` *is* independently reachable live pre-migration (it doesn't touch `mobility_checkins`), but wasn't exercised this round since it sends a real email via SendGrid — not run without a deliberate reason to.
