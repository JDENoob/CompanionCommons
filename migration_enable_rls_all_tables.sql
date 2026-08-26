-- ============================================================
-- RLS remediation — enable Row Level Security on every real table.
--
-- CONTEXT: confirmed live via Supabase's own pg_tables/pg_policies —
-- all 9 tables in `public` have rowsecurity = false. page_content
-- additionally has three pre-existing policies granting the `public`
-- role unrestricted read/write/update (with_check/qual = true) — these
-- have never been enforced because RLS itself was never turned on for
-- that table, but they would activate the moment RLS is enabled, so
-- they must be dropped first.
--
-- DO NOT RUN THIS until the companion server.js change (switching the
-- app's primary Supabase client from SUPABASE_ANON_KEY to
-- SUPABASE_SERVICE_ROLE_KEY) is deployed and confirmed live. This app's
-- primary client is used for nearly every read/write in the whole app;
-- enabling RLS with zero policies means the anon role loses all access
-- by default (Postgres default-denies when RLS is on and no policy
-- matches) — the live app will break immediately on every signup,
-- check-in, and dashboard load if this runs before that code change is
-- live. See the deployment sequence in chat for the exact order.
--
-- No new policies are added anywhere below. service_role bypasses RLS
-- inherently in Supabase's role model, so "enable RLS, zero policies"
-- is a complete, correct deny-all-except-service-role configuration —
-- there is no legitimate anon/authenticated access path anywhere in
-- this app (confirmed: zero client-side/browser Supabase usage exists
-- anywhere in Public/*.html).
-- ============================================================

-- Step 1: drop the three pre-existing page_content policies. Without
-- this, enabling RLS on page_content would activate these and leave it
-- exactly as open as it is today, just now "protected" on paper.
DROP POLICY IF EXISTS "Allow all writes" ON public.page_content;
DROP POLICY IF EXISTS "Allow read access" ON public.page_content;
DROP POLICY IF EXISTS "Allow updates" ON public.page_content;

-- Step 2: enable RLS on all 9 tables. No new policies — see context above.
ALTER TABLE public.senior_dogs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mobility_checkins ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dog_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.owners ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.magic_link_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sms_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.health_alerts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.churn_flags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.page_content ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- Verification — run these after the ALTER TABLEs above, in the same
-- SQL Editor session, and confirm:
--   (a) rowsecurity = true for all 9 rows
--   (b) zero rows returned from pg_policies for page_content (both
--       old policies gone, no new ones added)
-- ============================================================
SELECT schemaname, tablename, rowsecurity
FROM pg_tables
WHERE schemaname = 'public'
ORDER BY tablename;

SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'public'
ORDER BY tablename, policyname;
