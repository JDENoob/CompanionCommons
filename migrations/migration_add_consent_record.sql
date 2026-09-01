-- Closes the missing-consent-record gap flagged since Aug 20: the signup
-- consent checkbox already blocks form submission if unchecked (both
-- /api/send-magic-link and /api/add-dog validate `consent` as required),
-- but the fact that consent happened — a timestamp, proof it occurred —
-- was never actually persisted anywhere. This is per-dog consent, not
-- per-owner, since both routes that require it create a senior_dogs row.
--
-- Two columns, same pattern already used for contact_preference/owner_name
-- (see migration_add_token_contact_preference.sql):
--
--   - magic_link_tokens.consent_given_at: captured at
--     /api/send-magic-link submission time (consent is already validated
--     truthy before that insert), carried through to /verify, and copied
--     onto the new senior_dogs row from there — same "survive from
--     submission to /verify" pattern as contact_preference/owner_name.
--   - senior_dogs.consent_given_at: the actual persisted record. Written
--     from tokenData.consent_given_at on the /verify path (new owner or
--     returning owner, either way), or set directly at insert time on the
--     /api/add-dog path, which has no token to carry it through.
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS consent_given_at timestamp;

ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS consent_given_at timestamp;

NOTIFY pgrst, 'reload schema';
