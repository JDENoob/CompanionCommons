-- Adds a policy-version identifier alongside the existing consent_given_at
-- timestamp (migration_add_consent_record.sql, run Aug 22 2026). That
-- migration closed "was consent given, and when" -- this one closes the
-- other half of a real consent record: "which version of Terms/Privacy
-- was the owner actually agreeing to at that moment." A bare timestamp
-- with no version reference can't answer that if the policy text is ever
-- revised later -- exactly the gap a real lawyer review would flag.
--
-- Same two-table staging pattern already established for consent_given_at
-- (see that migration's own comment) -- captured at /api/send-magic-link
-- submission time, carried through the token to /verify, or set directly
-- at /api/add-dog time (no token to carry it through on that path).
--
-- Value is a simple, manually-maintained date string (e.g. "2026-09-01"),
-- not an automatically-derived content hash -- server.js defines this as
-- CURRENT_CONSENT_POLICY_VERSION, a single constant that must be bumped
-- by hand whenever terms.html/privacy.html's actual content changes.
-- This is a real, standing discipline requirement, not a one-time setup
-- step -- flagged in the constant's own comment in server.js too.
--
-- Run this once, in the Supabase SQL Editor, AFTER
-- migration_add_consent_record.sql (already run).

ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS consent_policy_version text;

ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS consent_policy_version text;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above, confirm both columns exist
-- ============================================================
SELECT table_name, column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name IN ('magic_link_tokens', 'senior_dogs')
  AND column_name = 'consent_policy_version'
ORDER BY table_name;
