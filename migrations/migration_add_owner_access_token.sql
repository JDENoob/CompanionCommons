-- Link-revocation project, Phase 2 (schema only -- see
-- docs/Link_Revocation_Build.md for the full audit this is built against).
--
-- Adds owners.access_token, a real per-owner secret that Phase 3 will embed
-- into outbound links (dashboard, check-in, checkins-list, unsubscribe,
-- etc.) instead of relying on the raw owner_id/dog_id UUID alone, which
-- today grants full access to anyone who has it and can never be revoked.
-- This migration only adds the column -- no route in server.js reads or
-- checks it yet; that's Phase 3.
--
-- gen_random_uuid() availability confirmed empirically, not assumed:
-- owners.id and senior_dogs.id already default to gen_random_uuid() and
-- have been generating real values on every insert throughout this
-- project's history (including the disposable test rows created during
-- the Phase 1 audit and the Sep 3 unsubscribe-route verification pass) --
-- direct, repeated proof the function already works in this database, on
-- whichever mechanism provides it (built into Postgres core since v13, or
-- via the pgcrypto extension on older versions -- Supabase projects enable
-- one or the other by default; a live query of pg_extension isn't
-- reachable through Supabase's REST API, but a function that has already
-- executed successfully on every owners/senior_dogs insert to date doesn't
-- need that check to be trusted).
--
-- access_token is generated as a UUID (cast to text) purely because
-- gen_random_uuid() is the readily-available, already-proven generator --
-- it is a distinct value from id, not a copy of it, and not meant to look
-- or behave like a row's primary key. NOT NULL + UNIQUE together, declared
-- inline on the ADD COLUMN so Postgres backfills a real, distinct random
-- value for every existing row (there are 0 real owner rows today per the
-- Phase 1 audit, but any disposable/test rows get a valid token too, per
-- the request -- no separate backfill statement needed).
--
-- No explicit index is created: a UNIQUE constraint in Postgres always
-- auto-creates a unique B-tree index to enforce it (this is Postgres core
-- behavior, not Supabase-specific) -- adding a second CREATE UNIQUE INDEX
-- here would be a redundant, functionally duplicate index. The
-- verification query at the bottom confirms the auto-created index exists
-- rather than assuming it.
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS access_token text NOT NULL DEFAULT gen_random_uuid()::text UNIQUE;

NOTIFY pgrst, 'reload schema';

-- ============================================================
-- Verification -- run after the above
-- ============================================================

-- 1. Confirm the column exists with the right shape.
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'owners'
  AND column_name = 'access_token';

-- 2. Confirm Postgres auto-created a unique index for the constraint
--    (should return exactly one row; indexdef will show UNIQUE).
SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public'
  AND tablename = 'owners'
  AND indexdef ILIKE '%access_token%';

-- 3. Confirm every existing row (if any) got a real, distinct, non-null
--    token -- not the same value repeated.
SELECT count(*) AS total_rows,
       count(access_token) AS non_null_tokens,
       count(DISTINCT access_token) AS distinct_tokens
FROM owners;
