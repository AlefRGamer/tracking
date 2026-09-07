// -----------------------------------------------------------------------------
// Register the CRM's webhook subscriptions.
//
//   GET  /api/crm/subscribe?key=<DASH_KEY>   list what is registered today
//   POST /api/crm/subscribe?key=<DASH_KEY>   create what is missing (idempotent)
//
// This exists because most CRMs have no screen for webhooks — Agendor, for one,
// is API-only. Without this endpoint the recipient would have to paste their
// CRM token into a terminal to run curl by hand. The Worker already holds the
// token as a secret, so it makes the calls itself and nobody handles the
// credential to get set up.
// -----------------------------------------------------------------------------

import { getCrmAdapter } from '../../crm/_registry.js';

export async function onRequestGet(context) {
  const guard = check(context);
  if (guard) return guard;

  const adapter = getCrmAdapter(context.env);
  const result = await adapter.listSubscriptions({ env: context.env });
  return json({ provider: adapter.name, ...result });
}

export async function onRequestPost(context) {
  const guard = check(context);
  if (guard) return guard;

  const { env } = context;
  const adapter = getCrmAdapter(env);

  const existing = await adapter.listSubscriptions({ env }).catch(() => null);
  const list = (existing && existing.body && (existing.body.data || existing.body)) || [];
  const alreadyThere = (event) =>
    Array.isArray(list) && list.some(s => adapter.subscriptionMatches(s, event));

  const results = [];
  for (const event of adapter.webhookEvents) {
    if (alreadyThere(event)) {
      results.push({ event, status: 'already registered' });
      continue;
    }
    const targetUrl = targetUrlFor(context, adapter, event);
    const r = await adapter.createSubscription({ env, targetUrl, event });
    results.push({ event, targetUrl, ...r });
  }

  return json({ provider: adapter.name, results });
}

function check({ request, env }) {
  const key = new URL(request.url).searchParams.get('key');
  if (!env.DASH_KEY || key !== env.DASH_KEY) return json({ error: 'Unauthorized' }, 401);

  const adapter = getCrmAdapter(env);
  if (!adapter) return json({ error: 'CRM_PROVIDER not set' }, 400);
  if (!env[adapter.tokenEnvVar]) return json({ error: `${adapter.tokenEnvVar} not set` }, 400);
  if (!env[adapter.slugEnvVar]) return json({ error: `${adapter.slugEnvVar} not set` }, 400);
  return null;
}

// One URL per trigger. Agendor rejects a second subscription on a target_url it
// already knows with 422 "target_url has already been taken", and the query
// doubles as the trigger name the receiver reads back.
function targetUrlFor({ request, env }, adapter, event) {
  const origin = new URL(request.url).origin;
  const base = `${origin}/webhook/crm/${adapter.name}/${env[adapter.slugEnvVar]}`;
  return `${base}?hook=${encodeURIComponent(event)}`;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
