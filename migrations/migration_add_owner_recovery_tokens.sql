-- Link-revocation project, Phase 3 (see docs/Link_Revocation_Build.md).
--
-- New table: owner_recovery_tokens. Backs the public "I lost my link"
-- recovery flow (POST /api/recover-account + GET /recover). Deliberately
-- separate from owners.access_token, which those routes never rotate or
-- return directly:
--
--   - owners.access_token is the PERMANENT credential embedded in every
--     outbound dashboard/check-in/etc. link. Recovery's whole point is to
--     help someone who lost that link get back to it -- rotating it here
--     would also silently invalidate every other link they (or a vet, or
--     family member) might still have saved, which recovery has no
--     business doing on its own. Deliberate, separate rotation lives in
--     POST /api/regenerate-access-token (the dashboard's "Regenerate My
--     Link" button), reachable only once already authenticated via the
--     owner-session cookie -- see server.js.
--   - A recovery_token here is short-lived (15 min), single-use (used_at,
--     same enforcement pattern already established by magic_link_tokens),
--     and sent unconditionally to BOTH phone and email once an owner is
--     found by phone (email is not a lookup key -- see the Phase 1
--     Finding 4 decision: owners.email has no UNIQUE constraint). Either
--     channel can consume it first; consuming it does not itself change
--     access_token -- it authenticates the visitor enough to be handed
--     their real, current dashboard-list link (which already carries
--     their live access_token).
--
-- No owner-identifying columns beyond the owner_id FK, matching this
-- project's standing "zero owner-identifying columns beyond a linking key"
-- pattern already used for medications/medication_response_windows.
--
-- Run this once, in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS owner_recovery_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL REFERENCES owners(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  expires_at timestamp NOT NULL,
  used_at timestamp,
  created_at timestamp NOT NULL DEFAULT now()
);

-- RLS enabled, zero policies -- same posture as every table since the
-- Aug 26 remediation (migration_enable_rls_all_tables.sql). service_role
-- (used by server.js) bypasses RLS inherently; no anon/authenticated
-- access path exists or is needed for this table.
ALTER TABLE owner_recovery_tokens ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above
-- ============================================================
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'owner_recovery_tokens'
ORDER BY ordinal_position;

SELECT tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename = 'owner_recovery_tokens';
