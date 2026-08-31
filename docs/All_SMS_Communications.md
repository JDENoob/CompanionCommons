# CompanionCommons — All SMS Communications
**Date compiled:** August 21, 2026
**Companion doc:** [`All_Email_Communications.md`](All_Email_Communications.md) — same format/spirit, covers every real automatic email (the churn/re-engagement email, its corrected once-per-missed-week cadence, and MIN/MAX counts).
**Purpose:** Reference record of every real SMS template sent to loggers, their exact final copy, trigger conditions, and character/segment counts — confirmed via direct code trace (no real Twilio sends were made to produce this). All character counts use real production values: full `companioncommons.com` URL, real 64-character magic-link tokens, real 36-character dog UUIDs, and both a short (Bailey, 6 chars) and long (Constantinople, 14 chars) test name to confirm margin at the new 40-character dog-name limit.

---

## Technical background: SMS segment limits

- **GSM-7 encoding** (plain ASCII text, no emoji/smart quotes/em dashes): **160 characters** per segment.
- **UCS-2 encoding** (triggered by any single emoji or special character): drops the limit to **70 characters** per segment.
- All five templates below are confirmed pure ASCII — GSM-7 encoded, 160-char limit applies.
- Going over the limit doesn't fail — it silently splits into multiple segments, which usually still arrives as one message on modern phones but costs more per send.
- As of this fix, `dog_name` is capped at **40 characters** at signup (both client-side on the form and server-side), so every template below has *structural* margin going forward — not just margin against the two test names used here.

---

## 1. Verification / Welcome SMS

**Fires:** Immediately at signup, once the baseline form is submitted.

**Final copy:**
> Bailey's profile - tap to finish: {url} (15 min)

**Character count:** 149 chars (Bailey) / 157 chars (Constantinople) — **1 segment**, 11–3 chars margin.

**Note:** This is the tightest-margin template of the five, purely because of URL overhead — `https://companioncommons.com/verify?token=` plus the 64-character token alone is 107 characters before any copy. Fine at the current 40-char name cap; if more margin is ever wanted, the lever would be shortening the token itself (not done — token length is a real security/collision-resistance tradeoff, deliberately left untouched).

---

## 2. Reminder SMS #1

**Fires:** 2:00 PM on the first day of a missed check-in week (day 1 of `weekStartDate`).

**Final copy (unchanged — already fit comfortably, not trimmed):**
> Bailey's #{N} week check-in time! Click here to complete a 30-second update: {url}

**Character count:** 149 chars (Bailey) / 157 chars (Constantinople) — **1 segment**, 11–3 chars margin.

---

## 3. Reminder SMS #2

**Fires:** 7:00 PM the same day as Reminder #1, if still no check-in.

**Final copy:**
> Bailey's week #{N} check-in - no rush, update when you can: {url}

**Character count:** 133 chars (Bailey) / 141 chars (Constantinople) — **1 segment**, 27–19 chars margin.

---

## 4. Reminder SMS #3

**Fires:** Next day — 7:30 AM on weekdays, or 2:00 PM on weekends — if still no check-in.

**Final copy:**
> Bailey's week #{N} check-in - every update helps the community: {url}

**Character count:** 137 chars (Bailey) / 145 chars (Constantinople) — **1 segment**, 23–15 chars margin.

---

## 5. Proactive Next-Week Reminder

**Fires:** Only after a successful check-in submission — scheduled 7 days out, at a personalized time (7:30 AM weekday / 2:00 PM weekend, matching whichever day the check-in was actually completed on). This is distinct from the missed-week reminder cascade above.

**Final copy:**
> Bailey's week #{N} check-in: {url}

**Character count:** 102 chars (Bailey) / 110 chars (Constantinople) — **1 segment**, 58–50 chars margin.

---

## 6. Combined Multi-Dog Reminder (Stage 4, multi-dog owner project)

**Fires:** Instead of the individual templates above, whenever 2 or more of the same owner's dogs are due for the same reminder tier at the same time (checked at actual send time by the SMS-sending cron — see `Multi_Dog_Signup_Build.md`, Stage 4). Never combines the Verification SMS (that's a per-signup, one-time text, not a recurring reminder). Deliberately omits the week number the individual templates carry, since sibling dogs can legitimately be on different weeks within the same combined send.

**Final copy — exactly 2 dogs:**
> Bailey & Max have check-ins ready: {url}

**Final copy — 3+ dogs:**
> {N} of your dogs have check-ins ready: {url}

**Character count (2-dog case):** 109 chars (Bailey & Max) / 128 chars (Constantinople & Constantinople) — **1 segment**, 51–32 chars margin. The link here points to the new `/checkins/:owner_id` page (74 chars, same length class as an individual check-in link), not any one dog's own check-in page — that's what keeps this in budget regardless of dog count.

**Character count (3-dog generic case):** 111 chars — **1 segment**, 49 chars margin. This form doesn't grow with dog count (it names a number, not a name list), so it stays comfortably within budget for any group size in practice.

---

## Message ordering — how these relate to each other

- On-time logging path: only the **Verification SMS** (once, at signup) and the **Proactive Next-Week Reminder** (once per successful check-in) fire. No other SMS is sent.
- Missed-week path: **Reminder #1 → Reminder #2 → Reminder #3**, in that order, across two days, if the check-in remains missing.
- **A related churn-detection re-engagement email** also exists (separate channel, not SMS) and fires only after Reminder #1's 2:00 PM trigger has passed (fixed Aug 21 2026 — previously it could fire before any SMS reminder went out at all), at most once per dog per missed week (fixed Aug 31 2026 — previously a 24h rolling dedup let it re-fire up to ~7 times in a single missed week). Full detail lives in the companion doc, `All_Email_Communications.md`, linked at the top of this file.

---

## Change history

**August 31, 2026:** Added a cross-reference to the new companion doc, `All_Email_Communications.md`, and updated the churn-email note in "Message ordering" to reflect its corrected once-per-missed-week cadence (was a 24h rolling window that could re-fire up to ~7 times/week). No SMS template content changed.

**August 22, 2026:** Added the combined multi-dog reminder template (see section 6) as part of Stage 4 of the multi-dog owner project — when 2+ of the same owner's dogs are due for the same reminder tier at once, they now receive one combined text instead of separate texts per dog. No existing single-dog template's copy changed.

**August 21, 2026:** Trimmed Reminders #2, #3, the Verification SMS, and the Proactive Next-Week Reminder to guarantee single-segment delivery at the new 40-character dog-name cap (all four were previously splitting into 2 segments for typical/long dog names — a real, ongoing cost, not just a style issue). Reminder #1 was already within limits and left unchanged. Added the 40-character `dog_name` maximum (client + server-side) specifically to keep this margin structural rather than something that could erode again as real users sign up with longer names.
