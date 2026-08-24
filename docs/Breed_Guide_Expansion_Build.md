# CompanionCommons — Breed Guide Expansion Build
**Started:** August 24, 2026
**Status:** Planning complete. Stage 1 not yet started — this document is the finished output of a documentation-only planning pass, matching how `Health_Instrument_Redesign_Build.md` (STEP P10) began.
**Purpose:** Standalone tracking document for STEP P11 — turning the breed guide from a single one-time unlock into a progressive, personalized retention mechanic spread across the 12-week program, plus fixing the breed-matching coverage gap it's built on top of. Tracked separately from the main build log given the scope, matching the pattern set by `Multi_Dog_Signup_Build.md` and `Health_Instrument_Redesign_Build.md`.

---

## Why this is being built

The breed guide today is a one-shot artifact. `/breed-guide/:dog_id` unlocks once, at week 2, shows History + Temperament + a senior-or-not-yet-senior section in a single unconditional block, and then never changes again for the remaining 10 weeks of the program. Nothing pulls an owner back to it a second time. This is a real gap given the project's own stated retention strategy (Section 4 of `CompanionCommons_Strategy_and_Legal_Aug20.md`: individual-value features — milestones, personal trend visibility, real artifacts — are what a beta this size can actually test) — the breed guide is exactly the kind of individual-value surface that strategy calls for, but it's currently built to be read once and forgotten.

At the same time, the checklist's own NEXT STEP list (item 14) has been flagging a real, silent coverage gap since the weight-chart work: `getBreedGuide()` only ever does an exact string match (trim + lowercase) against a fixed list of ~30 curated breeds. Breed is a free-text field at signup — no dropdown, no autocomplete — so anything that doesn't match exactly (a typo, "Golden Retriever mix," "Lab" instead of "Labrador Retriever," or a real breed genuinely outside the curated list) silently falls through to the generic fallback. This has been invisible the whole time — no logging, no error, nothing telling anyone it happened — and it doesn't just weaken the breed guide itself: `isSeniorForBreed` and `isOverweightForBreed` both depend on the exact same lookup, so a bad match quietly degrades two other features at once.

Fixing both together, not separately, because the unlock-structure rebuild makes the matching gap *more* consequential, not less: today a bad match costs a dog one weak experience (a generic guide instead of a real one, once). Once there are four real touchpoints depending on the same lookup (weeks 2, 4, 8, 12) plus a dashboard card retriggering at each one, a bad match compounds across the whole program instead of costing one moment. Same "fix the foundation before building more on top of it" reasoning that put STEP P10 ahead of beta recruiting.

---

## Investigation done before writing this doc (Aug 24)

Read `BREED_GUIDES`, `getBreedGuide`, `isSeniorForBreed`, `isOverweightForBreed`, the `/breed-guide/:dog_id` route, and the dashboard's breed-guide-unlocked card in full before locking anything below. Two findings changed what "just call the existing function" actually means in practice:

**The dashboard's "Breed guide unlocked" card is a persistent `>=` check, not a one-time pulse.** Its current condition is `nextCheckinWeekNumber >= 2` — which means it doesn't fire once and disappear, it shows on *every* dashboard view from week 2 onward, forever. Copying that pattern literally for weeks 4/8/12 would mean a dog at week 12 satisfies `>=2`, `>=4`, `>=8`, and `>=12` all at once — every banner stacking simultaneously, not a real "something new" prompt. Given the "no new stored state" constraint rules out tracking whether a chapter has been *read*, the natural fix is an exact-week match (`[2, 4, 8, 12].includes(nextCheckinWeekNumber)`) instead of a floor — the card only appears during the actual unlock week itself. Locked below as part of Decision 2.

**`describeJourneyTrend`, `describeTrendForGlance`, `describeWeightTrendForGlance`, and `describeWeightJourneyTrend` are all private closures defined inside the `/dashboard/:dog_id` route handler — not top-level functions.** They close over `checkins`, `roundToOneDecimal`, and each other's neighboring variables. This means `/breed-guide/:dog_id` cannot literally call `describeJourneyTrend` today — it doesn't exist outside that one route's function body. Decision 3's plan to "generate from existing, already-tested helpers" is correct in spirit, but it requires a real extraction step first, not just a new call site. `calculateCurrentStreak`, by contrast, is already a genuine top-level `async function` that runs its own Supabase query — it's the one piece decision 3 names that's already properly shared and callable from any route with zero extraction work.

---

## Decisions locked (Aug 24, confirmed with John before Stage 1 starts)

| Decision | Resolution |
|---|---|
| Breed matching | Layered fallback chain against the existing free-text field — no signup UI change (see below) |
| Progressive unlock structure | Chapters gated by the same live week-number calculation already used everywhere else — weeks 2/4/8/12, no new stored state |
| Personalization source | Weeks 8 and 12's content calls existing, already-tested helpers — `calculateCurrentStreak` directly, `describeJourneyTrend`/`describeWeightJourneyTrend` after being extracted to shared top-level functions (see below) — never new hand-written trend logic |
| Storage | No new database columns or migrations anywhere in this project |

### Decision 1 — breed matching: the layered chain

Applied in order, first match wins:

**a. Exact match (existing, unchanged).** `breedName.trim().toLowerCase()` against `BREED_GUIDES` keys directly. This is `getBreedGuide()`'s entire current implementation.

**b. Substring match.** Checks whether the *input* string contains a curated breed name — catches "Golden Retriever mix," "Golden Retriever - senior," "my German Shepherd." Direction matters and is worth being explicit about here so Stage 2 doesn't get it backwards: this only helps when the input is the curated name *plus extra words*, not when the input is a shortened nickname. "husky" does not contain "siberian husky" as a substring — that's layer (c)'s job, not layer (b)'s. Getting the direction reversed would either make this layer useless (checking if the short curated key is contained in nothing) or dangerous (checking if a curated key is a substring of arbitrary garbage, risking false positives on unrelated text that happens to contain a short breed name).

**c. Alias map.** A small, hand-authored dictionary of common nicknames/abbreviations to their canonical `BREED_GUIDES` key, for exactly the shortened-nickname case substring matching can't reach. Proposed starting list (finalized during Stage 2, not locked syntax — this is a strawman using judgment per the brief, not a final table):

```
lab → labrador
golden → golden retriever
gsd → german shepherd
frenchie → french bulldog
doxie → dachshund
wiener dog → dachshund
yorkie → yorkshire terrier
husky → siberian husky
doberman → doberman pinscher
gsp → german shorthaired pointer
berner → bernese mountain dog
cavalier → cavalier king charles spaniel
mini schnauzer → miniature schnauzer
rottie → rottweiler
newfie → newfoundland
ridgeback → rhodesian ridgeback
pom → pomeranian
shitzu → shih tzu
corgi → pembroke welsh corgi   (only corgi in the curated list — a Cardigan
                                 owner typing "corgi" gets the Pembroke guide;
                                 flagged as a known simplification, not a bug)
```
Deliberately excluded, worth noting so Stage 2 doesn't second-guess it: "bulldog" (French vs. English/American — English Bulldog isn't even in the curated list, so aliasing it to French Bulldog would be actively wrong, not just imprecise), "chi" (too short, real false-positive risk), "pit bull"/"pitbull" (no curated match exists to alias to at all — correctly falls through to generic).

**d. Fuzzy edit-distance match, last resort, conservative.** Catches genuine typos ("Golder Retriever," "Labordor"). A real different breed that merely sounds or looks similar to a curated one (e.g. "Labradoodle," a Lab/Poodle mix, not a typo of "Labrador") must NOT match — this is the actual risk this layer exists to guard against, not just an edge case. Conservative by design on two axes, not just one raw distance threshold: absolute edit distance capped low (e.g. ≤2), *and* that distance kept small relative to the candidate key's length (e.g. distance/length ≤ ~0.25), so a 3-letter key like "pug" can't absorb wildly different short inputs just because an absolute distance of 2 is small in isolation. Also requires a minimum input length before this layer even runs, and only accepts a match when it's unambiguous — i.e., not two different curated keys landing within the same small distance of the input. Exact numeric knobs get tuned empirically during Stage 2's own build, not pre-committed here.

**e. Fall-through logging.** When a breed genuinely clears none of the four layers above and lands on `GENERIC_BREED_GUIDE`, log it — `console.log`, raw breed string included. This has been completely invisible since the feature was built; there's no way to know today how much of the beta cohort is silently getting the generic guide, or what the real long-tail of un-matched breed strings actually looks like. Visibility is a prerequisite for ever prioritizing this properly, not a nice-to-have.

No signup UI change anywhere in this decision — `senior_dogs.breed` stays exactly the free-text field it already is. This is purely a smarter read of the same data.

### Decision 2 — progressive unlock structure

- **Week 2 (unchanged):** History + Temperament, exactly as they exist today.
- **Week 4:** the existing Senior Health Patterns / Looking Ahead section — *relocated* from its current week-2 position, not duplicated. Today `seniorSectionHeading`/`seniorSectionCopy` render unconditionally alongside History/Temperament the moment the page unlocks at week 2; after this project, that block moves to only render once `currentWeek >= 4`.
- **Week 8:** new "Your Dog's Journey" chapter — personalized trend narrative, built from Decision 3's extracted helpers, not new hand-written breed copy.
- **Week 12:** new closing/milestone chapter — full-history recap, program-completion framing. Same data source as week 8 (Decision 3), different framing/copy since this is the "you made it" moment, not a mid-program check-in.
- **Locked-but-visible teasers:** a not-yet-unlocked chapter shows on the same page as a visible "🔒 Unlocks at Week X" placeholder, not hidden entirely — consistent with how the standalone check-in page and `/checkins/:owner_id` already show explicit status states rather than just omitting unavailable things.
- **Dashboard card retrigger:** the existing "Breed guide unlocked" card gets reused at weeks 4, 8, and 12, not just 2 — same visual treatment (`.book-open` icon, tan accent block, "Read it →" link to `/breed-guide/:dog_id`), no new component. As the investigation above found, this requires changing the trigger condition from `nextCheckinWeekNumber >= 2` (persistent forever) to an exact match against the four real unlock weeks, so it reads as "something new is here" rather than a banner that never goes away.

### Decision 3 — personalization: confirmed function sources

This is the answer to the brief's own open question ("confirm exactly which existing functions these should call... don't reimplement trend logic a second time"), worked out during this planning pass rather than left for whoever starts the content stage:

- **Streak** → call the real, already-shared `calculateCurrentStreak(dog_id)` directly. Zero extraction needed — same single source of truth the dashboard and `/api/checkin-senior` already both use.
- **Per-metric trend narrative** ("Mobility: 1/10 → 1.3/10, up 0.3 since baseline") → `describeJourneyTrend`'s framing is the right fit for both new chapters (week 8's "journey so far" and week 12's "full-history recap" are both fundamentally baseline-vs-latest comparisons, not week-over-week ones). But as the investigation found, it's currently a private closure inside the dashboard route and has to be **extracted to a real top-level function first** — taking `label`, `baseline`, `latest`, and an explicit `hasAnyCheckins` boolean parameter instead of reaching into the dashboard route's `checkins.length` via closure. The dashboard route then calls the extracted version too, so there's exactly one real implementation everywhere, not two that could silently drift apart. This extraction is structural plumbing, not content — it belongs in the unlock-structure stage, ahead of the stage that actually writes week 8/12 copy.
- **Weight trend** → `describeWeightJourneyTrend` is the same story as above if weeks 8/12 want to reference weight specifically — same extraction treatment, but optional: the breed guide already has its own separate weight-vs-typical-range comparison (`compareWeightToBreedRange`), so a second weight-since-baseline line may be redundant. Left as a real Stage 4 call, not decided here.
- **Explicitly NOT `describeTrendForGlance`.** It's built for a *week-over-week* single comparison ("improved (-0.5)" vs. last check-in), which is the wrong shape for a multi-week milestone narrative — flagging this now so Stage 4 doesn't grab it by name-pattern-matching alone.
- **`generatePostLogInsight`** (already top-level, no extraction needed) picks whichever single metric moved the most since last time — a different, narrower kind of narrative than a full retrospective. Not the target pattern, but worth knowing it exists as prior art if week 8's opening line wants a "here's what stood out" highlight before the full per-metric list.
- **Weekly table data** (`journeyTableRows`) is also a dashboard-route closure, but it's a trivial sort + map with no real trend logic to duplicate — Stage 4 can re-derive it inline from `checkins` already being fetched in the breed-guide route, same low-risk pattern already used for the streak/senior/overweight helpers elsewhere in that route. Not proposing extraction for this one.

### Decision 4 — no new storage, anywhere

Everything in this project is computed live from `currentWeek` (the same `Math.max(1, Math.floor((now - created) / (7 * 24 * 60 * 60 * 1000)) + 1)` calculation already duplicated across the codebase) and existing `mobility_checkins` history — consistent with how `calculateCurrentStreak`, `isSeniorForBreed`, and `isOverweightForBreed` already work. No migration file, no new column, no new table, anywhere in this build.

---

## Stage plan

**Stage 1 — Investigation & schema check.** Confirm (formally, in writing, before any code) that nothing in this project needs a stored column — already true per Decision 4, this stage is closing the loop, not discovering something new. Finalizes the alias-map list and fuzzy-match thresholds against a broader look at real signup breed strings if any exist yet (none do — DB is empty per the last full wipe — so this will be judgment-based, same as the original 30-breed curation was). This planning document itself is most of Stage 1's real output.

**Stage 2 — Breed-matching fix.** Build the layered chain (a-e) inside/near `getBreedGuide()`. No route changes yet — this stage is scoped to the matching function itself plus its logging, verified against a real set of test breed strings covering every layer (exact, substring-with-suffix, alias, fuzzy-typo, genuine-fallback-with-log).

**Stage 3 — Unlock-structure rebuild.** The chapter/teaser mechanism in `/breed-guide/:dog_id`: week-2 content unchanged, Senior Health Patterns relocated to week 4, locked-teaser rendering for not-yet-unlocked chapters, and the dashboard card's retrigger condition changed to the exact-week match. Also where `describeJourneyTrend`/`describeWeightJourneyTrend` get extracted to shared top-level functions (structural plumbing that Stage 4's content depends on, not content itself) — the dashboard route is updated to call the extracted versions too, so nothing forks into two implementations.

**Stage 4 — Personalization content.** Week 8 "Your Dog's Journey" and week 12's closing/milestone chapter, built entirely on the Stage 3 plumbing (`calculateCurrentStreak`, extracted `describeJourneyTrend`, optionally `describeWeightJourneyTrend`) plus new framing copy (the "program complete" language for week 12 specifically is new prose, same as any other chapter's static copy — only the underlying *numbers* are required to come from existing helpers, not the surrounding sentences).

**Stage 5 — Verification pass.** Live testing: every matching layer against real deliberately-chosen test strings (not just the happy path), all four unlock weeks on a real multi-week test dog (locked-teaser correctly shown/hidden at each week, dashboard card firing exactly at 2/4/8/12 and not in between or after), fall-through logging confirmed actually appearing in server logs, and a check that the dashboard's own trend text is unchanged after the Stage 3 extraction (same numbers, same wording, just sourced from the now-shared function instead of an inline closure). Test data cleaned up afterward, same pattern as every prior verification pass in this project.

---

## Progress log

Not yet started. Build begins in a future session — this document is the completed planning-only output requested for this session; per instruction, Stage 1 does not start now.
