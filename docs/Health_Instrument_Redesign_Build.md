# CompanionCommons — Health Check-In Instrument Redesign Build
**Started:** August 23, 2026
**Status:** Stages 1-2 complete (schema/helpers, signup surfaces). Migration still not run against Supabase. Stage 3 (check-in surfaces) not started.
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
3. **Check-in surfaces** ← next — standalone `/check-in/:dog_id` + dashboard's inline modal + `/api/checkin-senior`
4. **Display/interpretation logic** — dashboard "at a glance" trend text, Chart.js (Y-axis max 8→10), peer/community comparison card (currently mobility-only, has a literal `/8`), Journey Summary (trend lines, week-by-week table, chart image capture), breed guide "current status" (one `/8` literal), `generatePostLogInsight`, `detectHealthAlerts` + threshold retune. This is where the sign-flip work concentrates.
5. **Google Sheets headers** — `Signups` and `CheckIns` tabs
6. **Verification pass** — effectively the first real pass of STEP P8, scoped to just the new instrument, before P8 runs in full against everything else

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
