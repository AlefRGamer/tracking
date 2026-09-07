// -----------------------------------------------------------------------------
// CRM core — provider-agnostic lead push and funnel-event return.
//
// This is the CRM sibling of `webhook/_core.js`. Same rule applies: this file
// never branches per provider. Everything provider-specific lives in the thin
// adapter under `functions/crm/<provider>.js`.
//
// Two directions, and they are independent:
//
//   OUTBOUND  /tracker fires a Lead  ->  pushLead()  ->  contact in the CRM,
//             carrying the UTMs, fbclid, referrer and landing page of the
//             visit that produced it.
//
//   INBOUND   someone moves the deal to another stage  ->  the CRM calls
//             /webhook/crm/<provider>/<slug>  ->  handleStageChange()  ->
//             a conversion event back to Meta, tied to that ORIGINAL visit.
//
// The inbound half is the point of the whole thing. Without it Meta only ever
// learns who filled in a form, so that is what it optimises for — volume of
// forms, including the tyre-kickers. With it, Meta learns who became a paying
// customer weeks later and optimises for that instead.
//
// Everything is logged to `crm_log`, success and failure alike. A CRM that
// silently stops accepting leads looks exactly like a quiet week; the log is
// what tells the two apart.
// -----------------------------------------------------------------------------

import { getCrmAdapter } from './_registry.js';

const META_API = 'https://graph.facebook.com/v25.0';

// =============================================================================
// OUTBOUND — a captured lead goes into the CRM
// =============================================================================

export async function pushLeadToCrm({ lead, session, eventId, sessionId, env, context }) {
  const adapter = getCrmAdapter(env);
  if (!adapter) return { skipped: 'no CRM provider configured' };
  if (!env[adapter.tokenEnvVar]) return { skipped: `missing ${adapter.tokenEnvVar}` };

  const origin = describeOrigin({ session, eventId, sessionId });

  let result;
  try {
    result = await adapter.pushLead({ lead, origin, session, env });
  } catch (e) {
    result = { ok: 0, status: 0, request: null, response: `adapter error: ${e.message}` };
  }

  const write = logToCrm({
    env,
    eventId,
    sessionId,
    provider: adapter.name,
    status: result.status || 0,
    ok: result.ok || 0,
    personId: result.personId,
    dealId: result.dealId,
    request: result.request,
    response: result.response,
  });
  if (context) context.waitUntil(write); else await write;

  return result;
}

// The block of text a salesperson reads inside the CRM record.
//
// It goes in a free-text field on purpose. Custom fields are the tidier home
// for this, but a custom field that does not exist yet makes most CRM APIs
// reject the whole record — trading the lead for the attribution. Adapters
// that support custom fields map them separately; this text always works.
export function describeOrigin({ session, eventId, sessionId }) {
  const s = session || {};
  const line = (label, value) => (value ? `${label}: ${value}\n` : '');

  return 'Lead captured on the site\n\n'
    + line('Source', s.utm_source || '(direct)')
    + line('Medium', s.utm_medium)
    + line('Campaign', s.utm_campaign)
    + line('Content', s.utm_content)
    + line('Term', s.utm_term)
    + '\n'
    + line('Landing page', s.landing_url)
    + line('Referrer', s.referrer)
    + line('fbclid', s.fbclid)
    + line('gclid', s.gclid)
    + '\n'
    + line('session_id', sessionId)
    + line('event_id', eventId);
}

// =============================================================================
// INBOUND — a stage change comes back as a conversion event
// =============================================================================

export async function handleStageChange({ adapter, body, hook, env, context }) {
  const parsed = adapter.parseWebhook({ body, hook }) || {};
  const { personId, dealId, stage, value } = parsed;

  // Log the raw body even when there is nothing to fire. It is the only way to
  // learn the provider's real payload shape without reproducing a live lead,
  // and the only way to answer "why didn't that stage fire?" afterwards.
  const log = (fields) => logToCrm({
    env,
    provider: `${adapter.name}-webhook:${hook}`,
    personId,
    dealId,
    request: { hook, stage, value, raw: body },
    ...fields,
  });

  const eventName = adapter.eventForHook
    ? (adapter.eventForHook(hook) || resolveEvent(stage, env))
    : resolveEvent(stage, env);

  if (!eventName) {
    await log({ response: `no mapping for stage "${stage}"` });
    return { skipped: 'stage not mapped', stage };
  }
  if (!personId) {
    await log({ response: 'payload carries no person id — cannot find the session' });
    return { skipped: 'no person id' };
  }

  // Look up by PERSON, not by deal. A second pipeline often creates a fresh
  // deal rather than moving the existing one, and then the deal id matches
  // nothing. The person is the same record across every pipeline.
  const origin = await findOriginByPerson({ personId, provider: adapter.name, env });
  if (!origin) {
    await log({ response: `person ${personId} did not come from the site — nothing to attribute` });
    return { skipped: 'person not from site' };
  }

  // Deterministic event id: dragging a card back and forth across the same
  // stage sends Meta the same id, and Meta counts it once.
  const eventId = `${adapter.name}-${dealId || personId}-${eventName}`;

  const alreadySent = await env.DB
    .prepare('SELECT 1 FROM event_log WHERE event_id = ? LIMIT 1')
    .bind(eventId).first().catch(() => null);
  if (alreadySent) {
    await log({ eventId, sessionId: origin.session_id, response: 'already sent' });
    return { skipped: 'duplicate', eventId };
  }

  const sent = await sendToMeta({ eventName, eventId, value, origin, env });

  context.waitUntil(Promise.all([
    log({
      eventId,
      sessionId: origin.session_id,
      status: sent.status,
      ok: sent.ok,
      response: sent.body,
    }),
    logToEventLog({ eventName, eventId, origin, sent, env }),
  ]));

  return { sent: eventName, eventId, status: sent.status };
}

// Stage name -> Meta event name, from `env.CRM_STAGE_EVENTS`:
//
//   {"QUALIFIED":"QualifiedLead","APPOINTMENT BOOKED":"Schedule","WON":"Purchase"}
//
// There is no built-in default because every pipeline is named differently.
// An unmapped stage is not an error — most stages should fire nothing.
function resolveEvent(stageName, env) {
  if (!env.CRM_STAGE_EVENTS) return null;
  let map;
  try {
    map = JSON.parse(env.CRM_STAGE_EVENTS);
  } catch (_) {
    return null; // malformed config fires nothing rather than the wrong thing
  }
  const key = normalizeStage(stageName);
  for (const [stage, event] of Object.entries(map)) {
    if (normalizeStage(stage) === key) return event;
  }
  return null;
}

// "Consulta Agendada", "CONSULTA AGENDADA" and "consulta  agendada" all have to
// resolve to the same key — someone will rename the stage with different casing
// or an accent sooner or later.
function normalizeStage(s) {
  return String(s || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .trim().toUpperCase().replace(/\s+/g, ' ');
}

// Joins the original visit (fbc/fbp/UTMs) to the raw PII of the Lead event
// that created this person in the CRM.
async function findOriginByPerson({ personId, provider, env }) {
  if (!env.DB) return null;
  try {
    return await env.DB.prepare(`
      SELECT
        s.session_id, s.external_id, s.fbc, s.fbp, s.ip_address, s.user_agent,
        s.landing_url, s.utm_source, s.utm_campaign,
        e.raw_email, e.raw_name, e.raw_phone
      FROM crm_log c
      JOIN sessions s ON s.session_id = c.session_id
      LEFT JOIN event_log e ON e.event_id = c.event_id
      WHERE c.person_id = ? AND c.provider = ?
      ORDER BY c.id DESC
      LIMIT 1
    `).bind(String(personId), provider).first();
  } catch (e) {
    console.error('CRM origin lookup error:', e.message);
    return null;
  }
}

async function sendToMeta({ eventName, eventId, value, origin, env }) {
  if (!env.META_PIXEL_ID || !env.META_ACCESS_TOKEN) {
    return { ok: 0, status: 0, body: 'skipped: missing meta env', payload: null };
  }

  const parts = (origin.raw_name || '').trim().split(/\s+/);
  const userData = {
    client_ip_address: origin.ip_address || '',
    client_user_agent: origin.user_agent || '',
  };

  const em = await sha256(origin.raw_email);
  const ph = await sha256(normalizePhone(origin.raw_phone, env.DEFAULT_COUNTRY_CODE));
  const fn = await sha256((parts[0] || '').toLowerCase());
  const ln = await sha256(parts.slice(1).join(' ').toLowerCase());
  const eid = await sha256(origin.external_id);

  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];
  if (fn) userData.fn = [fn];
  if (ln) userData.ln = [ln];
  if (eid) userData.external_id = [eid];
  if (origin.fbp) userData.fbp = origin.fbp;
  if (origin.fbc) userData.fbc = origin.fbc;

  const event = {
    event_name: eventName,
    event_time: Math.floor(Date.now() / 1000),
    event_id: eventId,
    event_source_url: origin.landing_url || '',
    // Not the browser — a person moved a card in the CRM. Meta rejects
    // `website` for events with no browser context behind them.
    action_source: 'system_generated',
    user_data: userData,
  };

  if (eventName === 'Purchase') {
    event.custom_data = {
      currency: env.CRM_CURRENCY || 'BRL',
      value: value > 0 ? value : 0,
    };
  }

  const payload = { data: [event] };
  if (env.META_TEST_EVENT_CODE) payload.test_event_code = env.META_TEST_EVENT_CODE;

  try {
    const r = await fetch(
      `${META_API}/${env.META_PIXEL_ID}/events?access_token=${env.META_ACCESS_TOKEN}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    return { ok: r.ok ? 1 : 0, status: r.status, body: await r.text(), payload: JSON.stringify(payload) };
  } catch (e) {
    return { ok: 0, status: 0, body: `fetch error: ${e.message}`, payload: JSON.stringify(payload) };
  }
}

// CRM events land in the same table as site events so `/dash` can show the
// whole funnel instead of only its top half. `consent_status = 'crm'` is what
// separates them from the browser-fired events of the same name.
async function logToEventLog({ eventName, eventId, origin, sent, env }) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`
      INSERT INTO event_log (
        session_id, event_name, event_id, timestamp,
        is_bot, consent_status,
        sent_to_meta, meta_status_code, meta_response_ok, meta_response_body, meta_payload_sent,
        has_email, has_phone, has_name,
        raw_email, raw_name, raw_phone
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      origin.session_id, eventName, eventId, Math.floor(Date.now() / 1000),
      0, 'crm',
      1, sent.status, sent.ok, sent.body, sent.payload,
      origin.raw_email ? 1 : 0, origin.raw_phone ? 1 : 0, origin.raw_name ? 1 : 0,
      origin.raw_email || '', origin.raw_name || '', origin.raw_phone || ''
    ).run();
  } catch (e) {
    console.error('CRM event_log error:', e.message);
  }
}

async function logToCrm({ env, eventId, sessionId, provider, status, ok, personId, dealId, request, response }) {
  if (!env.DB) return;
  try {
    await env.DB.prepare(`
      INSERT INTO crm_log (
        event_id, session_id, provider, created_at,
        status_code, ok, person_id, deal_id, request_payload, response_body
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      eventId || '', sessionId || '', provider, Math.floor(Date.now() / 1000),
      status || 0, ok || 0,
      personId ? String(personId) : null,
      dealId ? String(dealId) : null,
      truncate(typeof request === 'string' ? request : JSON.stringify(request ?? null), 20000),
      truncate(typeof response === 'string' ? response : JSON.stringify(response ?? null), 8000)
    ).run();
  } catch (e) {
    console.error('crm_log error:', e.message);
  }
}

function truncate(s, max) {
  return typeof s === 'string' && s.length > max ? s.slice(0, max) : s;
}

async function sha256(value) {
  if (!value) return '';
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(value).toLowerCase().trim()));
  return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Same rule as tracker.js: Meta wants country code + area code in the digits
// before hashing, and lead forms almost never collect the country code.
function normalizePhone(ph, countryCode) {
  if (!ph) return '';
  const cc = String(countryCode || '55');
  const d = String(ph).replace(/\D/g, '').replace(/^0+/, '');
  if (!d) return '';
  if (d.startsWith(cc) && d.length >= cc.length + 8 && d.length <= cc.length + 11) return d;
  if (d.length >= 8 && d.length <= 11) return cc + d;
  return d;
}
