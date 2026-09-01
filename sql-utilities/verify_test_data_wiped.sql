-- ============================================================================
-- CompanionCommons — Verify delete_all_test_data.sql worked
-- Run this after the delete script. Every row below should read 0.
-- page_content is deliberately excluded -- it's expected to be non-zero
-- (it's the live, admin-edited site copy table, not test/user data).
-- ============================================================================

SELECT 'senior_dogs' AS table_name, COUNT(*) AS row_count FROM senior_dogs
UNION ALL
SELECT 'owners', COUNT(*) FROM owners
UNION ALL
SELECT 'magic_link_tokens', COUNT(*) FROM magic_link_tokens
UNION ALL
SELECT 'mobility_checkins', COUNT(*) FROM mobility_checkins
UNION ALL
SELECT 'dog_notes', COUNT(*) FROM dog_notes
UNION ALL
SELECT 'health_alerts', COUNT(*) FROM health_alerts
UNION ALL
SELECT 'churn_flags', COUNT(*) FROM churn_flags
UNION ALL
SELECT 'contact_submissions', COUNT(*) FROM contact_submissions
UNION ALL
SELECT 'sms_queue', COUNT(*) FROM sms_queue
UNION ALL
SELECT 'medications', COUNT(*) FROM medications
UNION ALL
SELECT 'medication_weekly_updates', COUNT(*) FROM medication_weekly_updates
ORDER BY table_name;
