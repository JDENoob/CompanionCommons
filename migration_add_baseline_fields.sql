-- Migration: Add weight, spay/neuter, zip, diet, insurance, and
-- treatment category fields to the baseline signup pipeline.
-- Run this in the Supabase SQL Editor before testing the updated
-- baseline survey / server.js.

-- Temporary holding table used between /api/send-magic-link and /verify
ALTER TABLE magic_link_tokens
  ADD COLUMN IF NOT EXISTS weight_lbs INTEGER,
  ADD COLUMN IF NOT EXISTS spayed_neutered TEXT,
  ADD COLUMN IF NOT EXISTS zip_code TEXT,
  ADD COLUMN IF NOT EXISTS diet_type TEXT,
  ADD COLUMN IF NOT EXISTS pet_insurance TEXT,
  ADD COLUMN IF NOT EXISTS treatment_category TEXT[];

-- Permanent dog profile table — this is what the dashboard,
-- SMS reminders, and churn detection actually read from.
ALTER TABLE senior_dogs
  ADD COLUMN IF NOT EXISTS weight_lbs INTEGER,
  ADD COLUMN IF NOT EXISTS spayed_neutered TEXT,
  ADD COLUMN IF NOT EXISTS zip_code TEXT,
  ADD COLUMN IF NOT EXISTS diet_type TEXT,
  ADD COLUMN IF NOT EXISTS pet_insurance TEXT,
  ADD COLUMN IF NOT EXISTS treatment_category TEXT[];
