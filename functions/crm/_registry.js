// -----------------------------------------------------------------------------
// CRM adapter registry.
//
// Imports are static because Workers cannot dynamically import a path built at
// runtime. Adding a provider means adding one import and one map entry here —
// the `add-crm` skill does both.
//
// Only one CRM is active per deployment, chosen by `env.CRM_PROVIDER`. Leaving
// that unset disables the whole CRM path: no lead push, and the inbound webhook
// route 404s. That is the default, so an instance that does not use a CRM pays
// nothing for this code existing.
// -----------------------------------------------------------------------------

import agendor from './agendor.js';

const ADAPTERS = {
  agendor,
};

export function getCrmAdapter(env) {
  const name = String(env.CRM_PROVIDER || '').trim().toLowerCase();
  return ADAPTERS[name] || null;
}

// The inbound route resolves by URL segment rather than by env var, so a
// recipient switching CRMs does not silently start feeding the old provider's
// webhooks to the new adapter.
export function getCrmAdapterByName(name) {
  return ADAPTERS[String(name || '').trim().toLowerCase()] || null;
}

export function listCrmAdapters() {
  return Object.keys(ADAPTERS);
}
