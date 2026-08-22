-- STAGE 4 of the multi-dog owner project: enables SMS reminder consolidation.
--
-- Adds one nullable column to sms_queue: owner_id.
--
-- Populated going forward at every insert site (the 3 missed-checkin
-- reminder tiers in evaluateDogForChurn, plus the proactive next-week
-- reminder queued right after a successful check-in) directly from the
-- dog's own senior_dogs.owner_id — no join needed at read time.
--
-- What this enables: the SMS-sending cron (the 60-second job that flushes
-- pending sms_queue rows to Twilio) now groups pending rows by
-- owner_id + message kind (the week number is stripped for grouping, since
-- sibling dogs can legitimately be on different weeks) before sending. Two
-- or more of the same owner's dogs due for the same reminder tier at the
-- same time now go out as ONE combined text instead of N separate ones.
-- Rows with owner_id = NULL (legacy/ownerless dogs, pre-dating phone-based
-- owner linking) are never combined — each sends individually, exactly as
-- today. See Multi_Dog_Signup_Build.md, Stage 4, for the full design.
--
-- Existing pending/sent rows are left with owner_id = NULL — nothing to
-- backfill retroactively (past sends already went out individually, and
-- any currently-pending row will just send solo once, same as before this
-- migration, since there's no owner_id to key a group on until a fresh
-- reminder gets queued under the new code).
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE sms_queue
  ADD COLUMN IF NOT EXISTS owner_id uuid REFERENCES owners(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
