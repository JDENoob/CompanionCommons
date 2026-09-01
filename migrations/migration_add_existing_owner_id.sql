-- STAGE 3 of the multi-dog owner project: enables the returning-owner path.
--
-- Adds one nullable column to magic_link_tokens: existing_owner_id.
--
--   - NULL (today's exact behavior): a brand-new owner's first signup.
--     /verify creates both a new owners row and a new senior_dogs row, same
--     as it always has.
--   - Set: this pending token is for an owner who already has an owners
--     row (matched by phone at /api/send-magic-link submission time — see
--     Stage 3's design). /verify skips owner creation entirely and just
--     inserts the new senior_dogs row with owner_id = existing_owner_id,
--     pulling contact info from the existing owner record rather than the
--     token's own email/phone fields (which, in this case, came from a
--     resubmitted but not-yet-verified form — the actual owner record is
--     the trusted source once a match is found).
--
-- No other change to magic_link_tokens' shape — same token/expiry/used_at
-- mechanism Stage 1 found, reused as-is per Stage 3's design.
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS existing_owner_id uuid REFERENCES owners(id) ON DELETE SET NULL;

NOTIFY pgrst, 'reload schema';
