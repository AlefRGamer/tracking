-- Every attempt to talk to a CRM, in both directions.
--
-- Outbound rows (provider = '<name>') record pushing a captured lead into the
-- CRM. Inbound rows (provider = '<name>-webhook:<trigger>') record a stage
-- change arriving back, whether or not it became a conversion event.
--
-- Two jobs:
--
-- 1. Visibility. Without this a CRM failure is invisible — the lead already
--    went through to WhatsApp or the inbox, and nobody notices it never
--    reached the pipeline. `/api/crm-events` reads the failed rows for the
--    dashboard's "did not become an event" table.
--
-- 2. The return path. `person_id` ties the CRM's record back to the
--    `session_id` of the visit that produced it, which is how a stage change
--    weeks later can still be attributed to the ad click that started it.
CREATE TABLE IF NOT EXISTS crm_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT,
    session_id TEXT,
    provider TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    status_code INTEGER DEFAULT 0,
    ok INTEGER DEFAULT 0,
    person_id TEXT,
    deal_id TEXT,
    request_payload TEXT,
    response_body TEXT
);

CREATE INDEX IF NOT EXISTS idx_crm_log_created ON crm_log(created_at);
CREATE INDEX IF NOT EXISTS idx_crm_log_event ON crm_log(event_id);
-- The return-path lookup runs on every inbound webhook, filtered by person
-- and provider.
CREATE INDEX IF NOT EXISTS idx_crm_log_person ON crm_log(person_id, provider);
