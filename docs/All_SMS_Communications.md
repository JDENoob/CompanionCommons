# CompanionCommons — All SMS Communications
**Date compiled:** August 21, 2026
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

## Message ordering — how these relate to each other

- On-time logging path: only the **Verification SMS** (once, at signup) and the **Proactive Next-Week Reminder** (once per successful check-in) fire. No other SMS is sent.
- Missed-week path: **Reminder #1 → Reminder #2 → Reminder #3**, in that order, across two days, if the check-in remains missing.
- **A related churn-detection re-engagement email** also exists (separate channel, not SMS) and now fires only after Reminder #1's 2:00 PM trigger has passed, as of today's fix — previously it could fire before any SMS reminder went out at all. Full detail on that email is not repeated here since this document is SMS-specific; ask if a matching "All Email Communications" reference doc would be useful too.

---

## Change history

**August 21, 2026:** Trimmed Reminders #2, #3, the Verification SMS, and the Proactive Next-Week Reminder to guarantee single-segment delivery at the new 40-character dog-name cap (all four were previously splitting into 2 segments for typical/long dog names — a real, ongoing cost, not just a style issue). Reminder #1 was already within limits and left unchanged. Added the 40-character `dog_name` maximum (client + server-side) specifically to keep this margin structural rather than something that could erode again as real users sign up with longer names.
