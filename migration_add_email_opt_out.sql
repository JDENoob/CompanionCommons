-- Closes a real gap found and confirmed empirically: faqs.html and
-- privacy.html both promise users can "unsubscribe from emails," but no
-- opt-out mechanism existed anywhere in the codebase for the email
-- channel (SMS opt-out via "Reply STOP" already works correctly through
-- Twilio and is unaffected by this).
--
-- Adds one column: owners.email_opt_out.
--
-- Scoped to owners, not senior_dogs, deliberately deviating from
-- sms_consent's per-dog storage. Reasoning (see server.js and the Build
-- Log for full detail): the churn/re-engagement email this gates is
-- already owner-scoped by design (Stage 4 of the multi-dog project --
-- one combined email per owner covering all their overdue dogs, not one
-- per dog), so an owner-level opt-out is the only scope that actually
-- matches what a single unsubscribe link in that email can mean. A
-- per-dog flag would require multiple unsubscribe links in one email (one
-- per mentioned dog) for no real benefit, since nothing else in this
-- app lets an owner treat their dogs' email preferences differently.
--
-- Defaults to false (opted in) for all existing rows -- matches how
-- sms_consent and every other consent field in this project defaults,
-- and is correct here since this is closing a gap in an *existing*
-- promise ("you can unsubscribe"), not introducing a new consent
-- requirement that would need to default to opted-out.
--
-- Run this once, in the Supabase SQL Editor.

ALTER TABLE owners
  ADD COLUMN IF NOT EXISTS email_opt_out boolean NOT NULL DEFAULT false;

NOTIFY pgrst, 'reload schema';
