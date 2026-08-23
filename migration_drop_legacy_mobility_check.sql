-- STEP P10 follow-up: drops a stale, pre-existing CHECK constraint on
-- magic_link_tokens.baseline_mobility_score that migration_redesign_health_
-- instrument.sql did not know about and therefore never touched.
--
-- Found via real end-to-end testing after that migration ran: a real
-- signup submission with a genuine mobility composite outside the OLD 1-8
-- range (e.g. all four mobility items answered 0, giving a composite of
-- 0.0 — a real, common "perfectly healthy week" answer under the new
-- instrument) was rejected with:
--   new row for relation "magic_link_tokens" violates check constraint "mobility_check"
--
-- This constraint is NOT one migration_redesign_health_instrument.sql
-- created — that migration's own constraint on this column is named
-- magic_link_tokens_baseline_mobility_score_range (0-10) and is still
-- correct and left in place. "mobility_check" is a separate, older
-- constraint that predates this project's P10 work, still enforcing the
-- OLD 1-8 range on the same column (confirmed empirically: 0 and 10 both
-- rejected, 1/4/8 accepted) — it was never dropped when the column's
-- valid range changed, because migration_redesign_health_instrument.sql
-- didn't check for pre-existing constraints before adding its own.
--
-- Confirmed via systematic testing that this is the ONLY column, on the
-- ONLY table, with this problem — senior_dogs and mobility_checkins' own
-- composite/single-value columns (baseline_mobility_score,
-- baseline_energy_score, baseline_appetite_score, baseline_cognitive_score,
-- and mobility_checkins' equivalents) all correctly accept the full 0-10
-- range already. magic_link_tokens' other three composite columns
-- (baseline_energy_score, baseline_appetite_score, baseline_cognitive_score)
-- were also tested and are clean.
--
-- Run this once in the Supabase SQL Editor.

ALTER TABLE magic_link_tokens DROP CONSTRAINT IF EXISTS mobility_check;

NOTIFY pgrst, 'reload schema';
