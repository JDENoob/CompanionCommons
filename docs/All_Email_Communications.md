# CompanionCommons — All Email Communications
**Date compiled:** August 31, 2026
**Companion to:** [`All_SMS_Communications.md`](All_SMS_Communications.md) — that doc covers every real SMS template; this one covers every real email, following the same format. Read together for the full picture of what a logger (or an owner who's gone quiet) actually receives.
**Purpose:** Reference record of every real automatic email sent to a logger, its exact subject/final copy, trigger condition, and (for the churn/re-engagement email specifically) the corrected once-per-missed-week cadence — confirmed via direct code trace (`server.js`), not from memory or assumption. No real SendGrid sends were made to produce this.

---

## Automatic emails (fire on their own, no user action required)

There are exactly two automatic email templates in the codebase — both are the churn/re-engagement email, one for a single overdue dog and one combined template for an owner with 2+ overdue dogs at once (Stage 4, multi-dog owner project). Nothing else sends automatically — no welcome/confirmation email exists at signup or at check-in (those are SMS-only, see the companion doc), and no milestone email exists (milestone messages are dashboard/confirmation-screen only, never a message of any kind).

### Churn / re-engagement email — single dog

**Fires:** From the hourly churn-detection cron (`evaluateDogForChurn` → `sendChurnAlertsForOwnerGroup` → `sendChurnAlertEmail`, `server.js`), when exactly one of an owner's dogs currently needs an alert.

**Subject:** `How's {dogName} this week? 👋`

**Final copy (body):**
> Hey there! 👋
>
> We noticed we haven't heard from you since **{last check-in date}**. No pressure — we know life gets busy. *(Or, if the dog has never had a real check-in yet: "We noticed you haven't logged a check-in yet. No pressure — we know life gets busy.")*
>
> When you get a moment, we'd love to know how {dogName}'s doing this week. One quick check-in takes 30 seconds and helps build a clear picture of {dogName} and all the pet families participating.
>
> **Bonus:** Every check-in helps us build a clearer picture of pet health for the whole community. 🐾
>
> [View {dogName}'s Progress and Update] → `{BASE_URL}/dashboard/{dogId}`
>
> Companion Commons — Together we can change the future of pet health understanding

### Churn / re-engagement email — combined (2+ overdue dogs, same owner)

**Fires:** Same pipeline, when 2+ of one owner's dogs need an alert in the same cron pass — one email, not one per dog.

**Subject:** `How are {nameList} doing this week? 👋` (e.g. "Bailey and Max", or "Bailey, Max, and Rex" via `joinDogNames`)

**Final copy (body):**
> Hey there! 👋
>
> No pressure — we know life gets busy. When you get a moment, we'd love a quick update on {nameList}. Each check-in takes 30 seconds and helps build a clear picture of your dogs and all the pet families participating.
>
> *(then, for each overdue dog:)* We haven't heard from you about {dogName} since **{last check-in date}**. *(or "You haven't logged a check-in for {dogName} yet.")*
> [View {dogName}'s Progress and Update] → `{BASE_URL}/dashboard/{dogId}`
>
> Companion Commons — Together we can change the future of pet health understanding

---

## Trigger gate (both templates)

Same gate for both: the churn cron won't even evaluate a dog for an alert until **`reminderDay1`** has passed — day 1 of the current missed week, 2:00 PM (`server.js:8312-8314`), the identical gate that also governs SMS Reminder #1 (see the companion doc). This exists specifically so the email can never fire before the first SMS reminder would have gone out — added Aug 21 2026, after the email originally had no time gate at all and could fire on the very first cron tick after midnight.

Two other gates apply before this one: the dog must be past its 7-day baseline period (`isInBaselinePeriod`), and must genuinely have no check-in for the current week (`thisWeekCheckin`). No SMS-consent-style opt-in gate exists for email — only a `toEmail` presence check.

---

## Dedup / re-fire cadence — corrected Aug 31, 2026

**Current, correct behavior:** once per dog, per `week_number`, full stop. `evaluateDogForChurn` checks whether *any* `churn_flags` row already exists for `(dog_id, week_number)` — regardless of age — and skips if one does (`server.js:8317-8325`). A successful send writes exactly one `churn_flags` row per dog (`sendChurnAlertsForOwnerGroup`), which becomes that permanent per-week record. `churn_flags.week_number` was already the right column for this — no schema change was needed, only the query logic.

**The prior bug, for context (found and fixed Aug 31 2026):** the dedup used to check whether the *most recent* `churn_flags` row for that dog+week was **less than 24 hours old**, not whether one existed at all. Since the churn cron runs hourly and every successful send resets that 24h clock, an unresolved week could re-send roughly once a day for as long as it stayed unresolved — up to **~7 times within a single 7-day missed week**, with no overall cap anywhere in the code. This was found during a full communications min/max/cost trace (Aug 31 2026 session) that was originally scoped to compute per-logger SMS/email volume and cost — the trace itself is what surfaced this as a real, previously-undocumented defect, not something anyone had set out to look for.

---

## Real MIN/MAX counts across a full 12-week program

Same two scenarios as the companion doc, same 11 "missable" weeks (weeks 2–12; week 1 is baseline-only, no check-in possible, so no churn evaluation happens at all that week):

| Scenario | Churn emails sent |
|---|---|
| **MIN** — owner logs on time every week, never misses | **0** — `thisWeekCheckin` is always populated, so `evaluateDogForChurn` returns `skipped` before it ever reaches the churn-email logic. |
| **MAX** — owner never logs in, misses every week | **11** — exactly one per missed week (weeks 2–12), down from the pre-fix worst case of up to 77 (~7/week × 11 weeks). |

Verified via a dry-run trace of the actual `evaluateDogForChurn`/`sendChurnAlertsForOwnerGroup` functions (extracted verbatim from `server.js`, no real sends) simulating hourly cron ticks across a full 12-week program plus extra headroom — MAX produced exactly one send per week, `[2,3,4,5,6,7,8,9,10,11,12]`; MIN produced zero. See the Build Log's Aug 31 entry for the full methodology, including a real harness bug (real wall-clock `Date`, not parameterized) found and fixed along the way.

---

## User-initiated emails (excluded from the automatic-lifecycle counts above)

These exist in the codebase but only ever fire in direct response to a person's own action — never as part of the automatic signup → check-in → reminder → churn lifecycle, so they contribute **0** to both MIN and MAX regardless of logging behavior:

- **Resend-dashboard-link email** (`sendDashboardLinkEmail`, subject: *"Your Companion Commons dashboard link"*) — only fires if the owner explicitly requests their link back via `/api/resend-dashboard-link` (used when `preferred_contact_method` includes email).
- **Contact Us notification** (to `hello@companioncommons.com`) and **Contact Us confirmation** (to the submitter, *"Thanks for reaching out! 👋"*) — only fire when someone actually submits the Contact Us form.

---

## Change history

**August 31, 2026:** Doc created, alongside fixing the churn-email dedup bug documented above (24h rolling window → once per dog per week). Companion to `All_SMS_Communications.md`, which had flagged this doc as a possible future addition since Aug 21.
