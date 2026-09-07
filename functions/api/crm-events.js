// GET /api/crm-events?key=...&days=30
//
// The whole funnel in one place: how many entered through the site, and how
// many reached each stage of the CRM. The rest of the dashboard only sees the
// top half — without this there is no way to answer "are the CRM stages
// actually reaching Meta?" short of opening D1 by hand.
//
// Returns three things:
//   funnel    per-event counts in the window, from Lead through to the sale
//   events    the latest CRM-sourced events, with origin and Meta's response
//   failures  webhooks that arrived and did NOT become an event, with why
//
// The last one is the reason this endpoint exists. Success shows up in the
// counts; silence does not. An unmapped stage and a person who never came
// from the site both look like nothing happening.

export async function onRequestGet(context) {
  const { request, env } = context;
  const url = new URL(request.url);

  if (!env.DASH_KEY || url.searchParams.get('key') !== env.DASH_KEY) {
    return json({ error: 'Unauthorized' }, 401);
  }

  const days = clampInt(url.searchParams.get('days'), 30, 1, 365);
  const since = Math.floor(Date.now() / 1000) - days * 86400;

  // Which events make up the funnel, in order. Defaults to the common
  // lead-gen shape; override with CRM_FUNNEL_EVENTS when the stage map uses
  // different Meta events.
  const funnelEvents = parseList(env.CRM_FUNNEL_EVENTS)
    || ['Lead', 'QualifiedLead', 'Schedule', 'Purchase'];

  try {
    const placeholders = funnelEvents.map(() => '?').join(', ');
    const funnel = await env.DB.prepare(`
      SELECT event_name, COUNT(*) AS total,
             SUM(CASE WHEN meta_response_ok = 1 THEN 1 ELSE 0 END) AS accepted
      FROM event_log
      WHERE timestamp >= ? AND is_bot = 0
        AND event_name IN (${placeholders})
      GROUP BY event_name
    `).bind(since, ...funnelEvents).all();

    // `consent_status = 'crm'` is stamped at write time and is what separates
    // these from the browser-fired events of the same name.
    const events = await env.DB.prepare(`
      SELECT e.event_name, e.event_id, e.timestamp, e.raw_name, e.raw_phone,
             e.meta_status_code, e.meta_response_ok, e.meta_response_body,
             e.meta_payload_sent,
             s.utm_source, s.utm_campaign
      FROM event_log e
      LEFT JOIN sessions s ON s.session_id = e.session_id
      WHERE e.consent_status = 'crm' AND e.timestamp >= ?
      ORDER BY e.timestamp DESC
      LIMIT 100
    `).bind(since).all();

    const failures = await env.DB.prepare(`
      SELECT created_at, provider, person_id, deal_id, request_payload, response_body
      FROM crm_log
      WHERE provider LIKE '%-webhook:%' AND ok = 0 AND created_at >= ?
        -- "already sent" is deduplication working: a card went back a stage
        -- and was dragged forward again. Listing that in red teaches the
        -- reader to ignore the whole table.
        AND response_body NOT LIKE '%already sent%'
      ORDER BY id DESC
      LIMIT 50
    `).bind(since).all();

    return json({
      days,
      funnel: buildFunnel(funnel.results || [], funnelEvents),
      events: (events.results || []).map(cleanEvent),
      failures: (failures.results || []).map(describeFailure),
    });
  } catch (err) {
    return json({ error: err.message }, 500);
  }
}

// Fixed order, and a stage with no events shows as zero rather than vanishing.
// A zero on "appointment booked" is information; a missing row is not.
function buildFunnel(rows, order) {
  const byName = Object.fromEntries(rows.map(r => [r.event_name, r]));
  return order.map(name => ({
    event: name,
    total: byName[name] ? byName[name].total : 0,
    accepted: byName[name] ? byName[name].accepted : 0,
  }));
}

function cleanEvent(r) {
  let value = 0;
  try {
    const cd = JSON.parse(r.meta_payload_sent).data[0].custom_data;
    if (cd && cd.value) value = Number(cd.value);
  } catch (_) { /* event with no custom_data: value stays zero */ }

  return {
    event_name: r.event_name,
    event_id: r.event_id,
    timestamp: r.timestamp,
    name: r.raw_name || '',
    phone: r.raw_phone || '',
    utm_source: r.utm_source || '',
    utm_campaign: r.utm_campaign || '',
    value,
    meta_status_code: r.meta_status_code,
    meta_response_ok: r.meta_response_ok,
    meta_response_body: r.meta_response_body || '',
  };
}

function describeFailure(r) {
  let stage = '', hook = '';
  try {
    const p = JSON.parse(r.request_payload);
    stage = p.stage || '';
    hook = p.hook || '';
  } catch (_) { /* unreadable payload: fields stay empty */ }
  return {
    created_at: r.created_at,
    hook,
    stage,
    person_id: r.person_id,
    deal_id: r.deal_id,
    reason: r.response_body || '',
  };
}

function parseList(raw) {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) && v.length ? v : null;
  } catch (_) {
    const v = String(raw).split(',').map(s => s.trim()).filter(Boolean);
    return v.length ? v : null;
  }
}

function clampInt(v, def, min, max) {
  const n = parseInt(v, 10);
  if (Number.isNaN(n)) return def;
  return Math.min(Math.max(n, min), max);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
