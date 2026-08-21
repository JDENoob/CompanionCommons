-- STAGE 3 of the multi-dog owner project.
--
-- Adds two Phase A fields to magic_link_tokens so they survive from form
-- submission through to /verify, before either one has a permanent home:
--
--   - contact_preference: the real 3-way answer (sms/email/both) captured
--     by the new Phase A field, instead of being flattened down to the
--     existing boolean sms_consent column along the way. sms_consent stays
--     on this table too, untouched — /verify still derives
--     senior_dogs.sms_consent from it (a boolean is all senior_dogs/the
--     churn cron need, per Stage 1's mapping), while contact_preference is
--     what populates a brand-new owners.preferred_contact_method precisely.
--     Same CHECK constraint as owners.preferred_contact_method, for the
--     same reason: a bad value here would silently break message delivery.
--
--   - owner_name: the new optional Phase A field, populates a brand-new
--     owners.name. Nullable/optional, matching that field's own design.
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS contact_preference text CHECK (contact_preference IN ('sms', 'email', 'both')),
  ADD COLUMN IF NOT EXISTS owner_name text;

NOTIFY pgrst, 'reload schema';
