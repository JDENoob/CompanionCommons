-- Contact Us form backend: a new table to store real submissions.
--
-- Schema matches the owners table's established conventions (uuid PK via
-- gen_random_uuid(), bare `timestamp` not `timestamptz`, matching how the
-- rest of this project already stores timestamps).
--
-- RLS enabled with ZERO new policies -- same "deny-all-except-service-role"
-- posture the Aug 26 RLS remediation (migration_enable_rls_all_tables.sql)
-- established for every other table in this project. server.js's primary
-- Supabase client already runs on the service-role key, which bypasses RLS
-- inherently, so no policy is needed for the app itself to read/write this
-- table -- and no anon/authenticated access path should ever exist here,
-- consistent with every other table.
--
-- Run this once, in the Supabase SQL Editor.

CREATE TABLE IF NOT EXISTS contact_submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  message text NOT NULL,
  ip_address text,
  created_at timestamp DEFAULT now()
);

ALTER TABLE public.contact_submissions ENABLE ROW LEVEL SECURITY;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above, confirm:
--   (a) the table exists with the 5 columns above
--   (b) rowsecurity = true
-- ============================================================
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'contact_submissions'
ORDER BY ordinal_position;

SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public' AND tablename = 'contact_submissions';
