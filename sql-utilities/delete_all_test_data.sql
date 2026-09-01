-- ============================================================================
-- CompanionCommons — Delete all rows from the 11 real data tables
-- (senior_dogs, owners, magic_link_tokens, mobility_checkins, dog_notes,
--  health_alerts, churn_flags, contact_submissions, sms_queue, medications,
--  medication_weekly_updates)
--
-- medications/medication_weekly_updates added when those tables were
-- created (see migration_add_medications.sql) -- both have a real,
-- migration-confirmed ON DELETE CASCADE from medication_weekly_updates ->
-- medications -> senior_dogs, so deleting senior_dogs alone would cascade
-- correctly regardless, but both are still deleted explicitly here first,
-- matching this script's existing "delete children before parents,
-- whether or not the FK is confirmed" convention rather than relying on
-- CASCADE silently doing the work.
--
-- Does NOT touch page_content (live, admin-edited site copy — not
-- test/user data). Does NOT drop or alter any table/column. Does NOT
-- reset any sequence/identity — see note at the bottom on why that's a
-- no-op here anyway.
--
-- Per CompanionCommons_Build_Log.md's Aug 21 full-wipe entry: churn_flags
-- has a real, DB-enforced foreign key to senior_dogs — a prior wipe
-- attempt that deleted senior_dogs before churn_flags was caught mid-
-- delete by a foreign-key violation. The order below deletes every
-- child table before senior_dogs/owners specifically to avoid repeating
-- that. This order is safe whether or not a given child table's FK is
-- actually enforced in the database (deleting children first is never
-- wrong), so it does not depend on confirming every constraint by hand.
--
-- Confirmed FKs (from the live migration files):
--   senior_dogs.owner_id        -> owners(id)  ON DELETE RESTRICT
--     (RESTRICT means owners CANNOT be deleted while any senior_dogs
--      row still references them -- senior_dogs must be deleted first)
--   magic_link_tokens.existing_owner_id -> owners(id)  ON DELETE SET NULL
--   sms_queue.owner_id          -> owners(id)  ON DELETE SET NULL
--
-- mobility_checkins.dog_id, dog_notes.dog_id, health_alerts.dog_id,
-- churn_flags.dog_id, and sms_queue.pet_id are not documented in any
-- migration file (these tables predate the migration-file convention),
-- but are deleted before senior_dogs regardless, both because
-- churn_flags is confirmed to enforce this and because it costs
-- nothing to do the same for the others.
--
-- sms_queue orphan note: the last inventory found 13 sms_queue rows
-- whose pet_id doesn't match the one current senior_dogs row (leftover
-- from an earlier test-data wipe that deleted senior_dogs without
-- clearing their queued sms_queue rows first -- itself evidence that
-- sms_queue.pet_id has NO enforced FK to senior_dogs, since an orphaned
-- pet_id could not exist if one did). Since this script deletes ALL rows
-- from both tables, the orphan status is irrelevant to correctness --
-- flagged here only because the order below (sms_queue before
-- senior_dogs) handles it safely either way, orphaned or not.
--
-- DELETE vs TRUNCATE: DELETE is used deliberately, not TRUNCATE CASCADE.
-- Not every FK on these 9 tables is confirmed via a migration file (only
-- 3 are); TRUNCATE ... CASCADE would silently cascade across the full,
-- not-fully-confirmed constraint graph, and provides no per-table error
-- if something unexpected is referenced. Explicit ordered DELETEs either
-- succeed cleanly or fail loudly on the exact table/constraint that
-- wasn't accounted for -- fail-loud is the safer failure mode here, and
-- row counts are tiny (0-13 rows per table), so TRUNCATE's performance
-- advantage doesn't matter.
--
-- Wrapped in a transaction: either every table above ends at 0 rows, or
-- (if some unexpected constraint fires) nothing is deleted at all --
-- never a half-wiped state.
-- ============================================================================

BEGIN;

-- 1. Children of senior_dogs (and, for sms_queue, also owners) first.
DELETE FROM mobility_checkins;
DELETE FROM dog_notes;
DELETE FROM health_alerts;
DELETE FROM churn_flags;
DELETE FROM sms_queue;
DELETE FROM medication_weekly_updates; -- child of medications, delete first
DELETE FROM medications;

-- 2. magic_link_tokens references owners (ON DELETE SET NULL, non-blocking)
--    but is cleared here anyway, ahead of owners, for the same reason as above.
DELETE FROM magic_link_tokens;

-- 3. senior_dogs references owners with ON DELETE RESTRICT -- must be
--    deleted before owners, or the owners delete below will fail.
DELETE FROM senior_dogs;

-- 4. owners -- now safe, nothing left references it.
DELETE FROM owners;

-- 5. contact_submissions has no FK relationship to any of the above
--    (confirmed via its live column list: id, email, message, ip_address,
--    created_at -- no dog_id/owner_id/pet_id column exists). Order
--    relative to the rest doesn't matter; included here for completeness.
DELETE FROM contact_submissions;

COMMIT;

-- ============================================================================
-- Sequences / identity columns: NOT reset, and there is nothing to reset.
-- Every one of these 9 tables uses a uuid primary key (DEFAULT
-- gen_random_uuid()), confirmed directly against real row data pulled
-- during the last inventory (e.g. owners.id, senior_dogs.id,
-- sms_queue.id were all UUID strings, not integers) -- none of them are
-- integer/serial/identity columns backed by a sequence. There is no
-- SETVAL/RESTART IDENTITY step this script could meaningfully add, and
-- none is included.
-- ============================================================================
