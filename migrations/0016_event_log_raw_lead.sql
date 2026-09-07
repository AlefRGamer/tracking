-- Store the lead's raw name and phone alongside the raw_email that already
-- existed.
--
-- Why: on a lead-gen instance the conversion never passes through a checkout,
-- so `purchase_log` stays empty and `event_log` is the only record of the
-- person. Without these two columns D1 knows a Lead happened and which
-- campaign it came from, but not who to call. They are also what the CRM push
-- and the CRM funnel events read to build Meta's Advanced Matching payload.
--
-- Only the SHA-256 hash ever reaches Meta. The raw values stay in the
-- recipient's own D1.
ALTER TABLE event_log ADD COLUMN raw_name TEXT DEFAULT '';
ALTER TABLE event_log ADD COLUMN raw_phone TEXT DEFAULT '';
