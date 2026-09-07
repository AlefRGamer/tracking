// -----------------------------------------------------------------------------
// CRM webhook receiver — one route for every provider.
//
// URL shape: /webhook/crm/<provider>/<slug>
//
// Unlike the sales-platform adapters, which each get their own route file
// because each verifies a different signature scheme, every CRM enters through
// here and is dispatched by the `<provider>` segment. Adding a CRM adds no
// route — only an adapter and a registry entry.
//
// The `<slug>` gate is the same obscure-URL scheme used by the sales-platform
// webhooks: an unguessable UUID v4 in `env.<PROVIDER>_WEBHOOK_SLUG`.
// -----------------------------------------------------------------------------

import { getCrmAdapterByName } from '../../../crm/_registry.js';
import { handleStageChange } from '../../../crm/_core.js';
import { guardSlug } from '../../_utils.js';

export async function onRequestPost(context) {
  const { request, env, params } = context;

  const adapter = getCrmAdapterByName(params.provider);
  // Unknown provider looks exactly like a missing route. A scanner walking
  // /webhook/crm/<guess>/<guess> learns nothing about which CRM is in use.
  if (!adapter) return json({ error: 'not found' }, 404);

  const slugFailure = guardSlug(params.slug, env[adapter.slugEnvVar]);
  if (slugFailure) return slugFailure;

  let body;
  try {
    body = await request.json();
  } catch (_) {
    return json({ error: 'invalid json' }, 400);
  }

  // Which trigger fired. The query string comes first because it is the only
  // source we control — each subscription is registered with its own trigger
  // name in the URL (see /api/crm/subscribe). Body and header are fallbacks
  // for providers that name the trigger in the payload.
  const hook = new URL(request.url).searchParams.get('hook')
    || body.event
    || body.trigger
    || request.headers.get('x-crm-event')
    || '';

  try {
    const result = await handleStageChange({ adapter, body, hook, env, context });
    // Always 200. A webhook that answers with an error joins the provider's
    // retry queue, and an unmapped stage is not a failure on our side.
    return json({ ok: true, ...result });
  } catch (e) {
    console.error('CRM webhook error:', e.message);
    return json({ ok: false, error: e.message });
  }
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
