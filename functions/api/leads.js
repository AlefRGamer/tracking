// GET /api/leads?key=...&days=30&limit=100
//
// Returns Lead events joined to their originating session so each row carries
// its UTMs / fbclid / gclid. This is the "where did my leads come from" view
// — the whole reason the tracking stack persists anything at all.
//
// Source: event_log (Lead events only) LEFT JOIN sessions via session_id.
// Bots are excluded by default; pass include_bots=1 to see them.

export async function onRequestGet(context) {
  const { request, env } = context;

  const url = new URL(request.url);
  const key = url.searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const limit = clampInt(url.searchParams.get('limit'), 100, 1, 500);
  const includeBots = url.searchParams.get('include_bots') === '1';
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  const botClause = includeBots ? '' : 'AND e.is_bot = 0';

  try {
    const rows = await env.DB.prepare(`
      SELECT
        e.event_id,
        e.timestamp,
        e.session_id,
        e.raw_email,
        e.raw_name,
        e.raw_phone,
        e.browser,
        e.os,
        e.is_mobile,
        e.is_bot,
        e.bot_reason,
        e.meta_status_code,
        e.meta_response_ok,
        e.meta_response_body,
        e.meta_payload_sent,
        e.ga4_status_code,
        e.ga4_response_ok,
        e.ga4_response_body,
        e.ga4_payload_sent,
        e.fbp_source,
        e.fbc_source,
        e.fbclid_source,
        s.utm_source,
        s.utm_medium,
        s.utm_campaign,
        s.utm_content,
        s.utm_term,
        s.fbclid,
        s.gclid,
        s.referrer,
        s.landing_url,
        c.ok            AS crm_ok,
        c.status_code   AS crm_status_code,
        c.person_id     AS crm_person_id,
        c.deal_id       AS crm_deal_id,
        c.response_body AS crm_response_body
      FROM event_log e
      LEFT JOIN sessions s ON e.session_id = s.session_id
      -- Latest CRM attempt for this event. A subquery rather than a plain join
      -- because one event can have more than one row in crm_log.
      LEFT JOIN crm_log c ON c.id = (
        SELECT MAX(id) FROM crm_log WHERE event_id = e.event_id
      )
      WHERE e.event_name = 'Lead'
        AND e.timestamp >= ?
        ${botClause}
      ORDER BY e.timestamp DESC
      LIMIT ?
    `).bind(since, limit).all();

    // Summary counts grouped by utm_source for the summary card above the table.
    const summary = await env.DB.prepare(`
      SELECT
        COALESCE(NULLIF(s.utm_source, ''), '(direct)') as utm_source,
        COUNT(*) as count
      FROM event_log e
      LEFT JOIN sessions s ON e.session_id = s.session_id
      WHERE e.event_name = 'Lead'
        AND e.timestamp >= ?
        AND e.is_bot = 0
      GROUP BY utm_source
      ORDER BY count DESC
    `).bind(since).all();

    return json({
      days,
      leads: rows.results || [],
      summary: summary.results || [],
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    },
  });
}

function clampInt(raw, fallback, min, max) {
  const n = parseInt(raw || '', 10);
  if (Number.isNaN(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
