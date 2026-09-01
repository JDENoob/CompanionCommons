-- ============================================================
-- Storage remediation — remove the overly broad SELECT policy on
-- storage.objects that allows anon-key enumeration of the Dog_Photos
-- bucket's full contents.
--
-- CONTEXT: Dog_Photos is intentionally a PUBLIC bucket (photo_url values
-- are rendered directly as <img src> throughout the app, and need to be
-- fetchable with no auth). That public-serving behavior goes through
-- Supabase's dedicated public-object URL path
-- (/storage/v1/object/public/{bucket}/{path}), which is entirely
-- independent of storage.objects RLS policies — confirmed empirically
-- with a disposable test bucket carrying zero policies: public URL
-- fetches still succeeded with no auth at all.
--
-- The "Read ba4ox0_0" policy (Supabase's auto-generated name from the
-- dashboard's policy-template UI) is a separate thing: a permissive
-- SELECT policy on storage.objects, which governs the Storage
-- Management API's list/info endpoints — NOT object fetching. Confirmed
-- empirically that anon can currently call
-- POST /storage/v1/object/list/Dog_Photos and enumerate all 3 real files
-- in the bucket right now.
--
-- Confirmed via full codebase search: this app never calls
-- .storage.from('Dog_Photos').list(...) or any bucket-enumeration
-- method anywhere — every use of photo_url is a direct fetch of an
-- already-known path. There is no legitimate reason for this policy to
-- exist, and removing it cannot affect photo display (see above).
--
-- A second policy, "upload ba4ox0_0" (same auto-generated dashboard
-- naming), grants the public role INSERT on storage.objects with
-- with_check: bucket_id = 'Dog_Photos' — meaning anyone with the anon
-- key can currently upload arbitrary files directly to this bucket.
-- Confirmed via full codebase search: zero client-side/browser Supabase
-- usage exists anywhere in Public/*.html. The app's only upload path is
-- the dashboard's own JS calling fetch('/api/upload-dog-photo', ...) —
-- a request to this app's own server (server.js), which then performs
-- the actual Storage upload server-side via the `supabase` client
-- (switched to the service role key, which bypasses storage policies
-- entirely regardless of what they grant). The browser never talks to
-- Supabase Storage directly. Already confirmed empirically (disposable
-- test bucket, zero policies) that a service-role upload succeeds with
-- no policies present at all — so dropping this cannot affect the real
-- upload path, only removes the unused anon-key ability.
--
-- No replacement policies are added for either. This can be run in the
-- same SQL Editor session as migration_enable_rls_all_tables.sql, in
-- either order relative to that migration — they touch unrelated
-- policies (table RLS vs. storage.objects) with no interaction between
-- them.
-- ============================================================

DROP POLICY IF EXISTS "Read ba4ox0_0" ON storage.objects;
DROP POLICY IF EXISTS "upload ba4ox0_0" ON storage.objects;

-- Verification — run after the DROPs above and confirm zero rows
-- (no lingering broad-access policy on storage.objects):
SELECT schemaname, tablename, policyname, roles, cmd, qual, with_check
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;
