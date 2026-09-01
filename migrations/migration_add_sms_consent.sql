-- Fixes a real compliance gap found while preparing the Twilio A2P 10DLC
-- campaign registration: the "Yes, I want SMS check-in reminders" checkbox
-- on the baseline signup form was being collected and stored, but never
-- actually checked before sending weekly reminder texts. Anyone with a
-- phone number on file was getting reminders whether they opted in or not.
--
-- This adds sms_consent directly to senior_dogs (the table the reminder
-- system actually reads from) so it can be enforced.
--
-- Run this once in the Supabase SQL Editor.

ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS sms_consent BOOLEAN DEFAULT false;

NOTIFY pgrst, 'reload schema';
