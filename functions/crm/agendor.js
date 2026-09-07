// -----------------------------------------------------------------------------
// Agendor CRM adapter.
//
// Docs: https://api.agendor.com.br/docs — auth is `Authorization: Token <token>`,
// found in the Agendor UI under Menu > Integrações.
//
// Provider specifics, all confirmed against the live API:
//   - `POST /v3/people/upsert` deduplicates on email server-side, so a repeat
//     lead updates the existing contact instead of creating a twin. A lead with
//     no email cannot be deduplicated — Agendor has no phone-based upsert.
//   - Contact fields are nested: `contact.email`, `contact.mobile`, not flat.
//   - Deals hang off the person: `POST /v3/people/{id}/deals`. The published
//     examples only show the `/organizations/{id}/deals` form, so the flat
//     `POST /v3/deals` with `person` in the body is kept as a fallback.
//   - Responses wrap the record in `data`, i.e. `{ "data": { "id": 123 } }`.
//   - Webhooks are API-only. There is no screen for them anywhere in the UI.
//   - Agendor allows exactly ONE subscription per `target_url`. Registering a
//     second trigger on the same URL returns 422 "target_url has already been
//     taken", so each trigger gets its own URL via a `?hook=` query.
// -----------------------------------------------------------------------------

const API = 'https://api.agendor.com.br';

export default {
  name: 'agendor',
  tokenEnvVar: 'AGENDOR_TOKEN',
  slugEnvVar: 'AGENDOR_WEBHOOK_SLUG',

  // `on_deal_won` carries no stage; the trigger itself means the sale.
  // Everything else falls through to the CRM_STAGE_EVENTS map.
  eventForHook(hook) {
    return hook === 'on_deal_won' ? 'Purchase' : null;
  },

  webhookEvents: ['on_deal_stage_updated', 'on_deal_won'],

  // ---------------------------------------------------------------- OUTBOUND
  async pushLead({ lead, origin, session, env }) {
    const headers = {
      'Authorization': `Token ${env.AGENDOR_TOKEN}`,
      'Content-Type': 'application/json',
    };

    const person = { name: lead.name || 'Unnamed lead' };
    const contact = {};
    if (lead.email) contact.email = lead.email;
    if (lead.phone) contact.mobile = lead.phone;
    if (Object.keys(contact).length) person.contact = contact;

    const customFields = buildCustomFields(session, env);
    if (customFields) person.customFields = customFields;

    let personId = null, personStatus = 0, personBody = '';
    try {
      const r = await fetch(`${API}/v3/people/upsert`, {
        method: 'POST', headers, body: JSON.stringify(person),
      });
      personStatus = r.status;
      personBody = await r.text();
      personId = extractId(personBody);
    } catch (e) {
      personBody = `fetch error: ${e.message}`;
    }

    // No person means nothing to attach the deal to. The person may still have
    // been created, so both statuses are logged rather than one summary flag.
    let dealId = null, dealStatus = 0, dealBody = '';
    if (personId && env.AGENDOR_CREATE_DEAL !== 'false') {
      const deal = {
        title: `${env.AGENDOR_DEAL_TITLE || 'Website lead'} — ${lead.name || 'unnamed'}`,
        description: origin,
      };
      if (env.AGENDOR_DEAL_STAGE) deal.dealStage = Number(env.AGENDOR_DEAL_STAGE);
      if (env.AGENDOR_FUNNEL_ID) deal.funnel = Number(env.AGENDOR_FUNNEL_ID);

      try {
        let r = await fetch(`${API}/v3/people/${personId}/deals`, {
          method: 'POST', headers, body: JSON.stringify(deal),
        });
        if (r.status === 404 || r.status === 405) {
          r = await fetch(`${API}/v3/deals`, {
            method: 'POST', headers, body: JSON.stringify({ ...deal, person: personId }),
          });
        }
        dealStatus = r.status;
        dealBody = await r.text();
        dealId = extractId(dealBody);
      } catch (e) {
        dealBody = `fetch error: ${e.message}`;
      }
    }

    return {
      ok: personStatus >= 200 && personStatus < 300 ? 1 : 0,
      status: personStatus,
      personId,
      dealId,
      request: { person, dealDescription: origin },
      response: { personStatus, personBody, dealStatus, dealBody },
    };
  },

  // ----------------------------------------------------------------- INBOUND
  parseWebhook({ body }) {
    const deal = body.data || body.deal || body;
    return {
      dealId: deal.id || deal.dealId || null,
      personId: (deal.person && deal.person.id) || (body.person && body.person.id) || null,
      stage: (deal.dealStage && deal.dealStage.name)
        || (deal.deal_stage && deal.deal_stage.name)
        || (deal.stage && deal.stage.name)
        || '',
      value: Number(deal.value || 0),
    };
  },

  // ------------------------------------------------------------ SUBSCRIPTIONS
  async listSubscriptions({ env }) {
    const r = await fetch(`${API}/integrations/subscriptions`, { headers: authHeaders(env) });
    return { status: r.status, body: parseJson(await r.text()) };
  },

  async createSubscription({ env, targetUrl, event }) {
    const r = await fetch(`${API}/integrations/subscriptions`, {
      method: 'POST',
      headers: authHeaders(env),
      body: JSON.stringify({ target_url: targetUrl, event }),
    });
    return { status: r.status, body: parseJson(await r.text()) };
  },

  subscriptionMatches(subscription, event) {
    return subscription && subscription.event === event;
  },
};

// Optional mapping to Agendor custom fields:
//   AGENDOR_CUSTOM_FIELDS = {"utm_source":"origem","utm_campaign":"campanha"}
// Key is the session column, value is the field's identifying column in
// Agendor. Unset by default because a custom field that does not exist makes
// Agendor reject the entire record — losing the lead to save the attribution.
function buildCustomFields(session, env) {
  if (!env.AGENDOR_CUSTOM_FIELDS) return null;
  try {
    const map = JSON.parse(env.AGENDOR_CUSTOM_FIELDS);
    const out = {};
    for (const [sessionField, agendorColumn] of Object.entries(map)) {
      const v = (session || {})[sessionField];
      if (v) out[agendorColumn] = v;
    }
    return Object.keys(out).length ? out : null;
  } catch (_) {
    return null;
  }
}

function authHeaders(env) {
  return {
    'Authorization': `Token ${env.AGENDOR_TOKEN}`,
    'Content-Type': 'application/json',
  };
}

function extractId(text) {
  try {
    const j = JSON.parse(text);
    return (j && j.data && j.data.id) || (j && j.id) || null;
  } catch (_) {
    return null;
  }
}

function parseJson(text) {
  try { return JSON.parse(text); } catch (_) { return text; }
}
