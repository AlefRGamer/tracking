# Agendor

Brazilian CRM. Adapter: `functions/crm/agendor.js`. All notes below were
confirmed against the live API, not read from documentation.

## Identity

- **API base**: `https://api.agendor.com.br`
- **Auth header**: `Authorization: Token <token>` — note `Token`, not `Bearer`
- **Where the token lives**: Agendor UI → Menu → Integrações
- **Env vars**: `AGENDOR_TOKEN`, `AGENDOR_WEBHOOK_SLUG`
- **Inbound URL**: `/webhook/crm/agendor/<AGENDOR_WEBHOOK_SLUG>`

## Outbound — creating the lead

Two calls per lead:

```
POST /v3/people/upsert          → { "data": { "id": 71280662, ... } }
POST /v3/people/{id}/deals      → { "data": { "id": 45363556, ... } }
```

**`upsert` deduplicates on email, server-side.** A returning lead updates the
existing contact instead of creating a twin. A lead with no email cannot be
deduplicated — Agendor has no phone-based upsert, so email-less leads will
create duplicates on repeat submissions.

**Contact fields are nested**, and this is the most common mistake:

```json
{ "name": "Maria Silva",
  "contact": { "email": "maria@example.com", "mobile": "(17) 99999-9999" } }
```

Not `email` at the top level. A flat `email` is silently ignored — you get a
201 and a contact with no email.

**Deals hang off the person.** The published examples only ever show
`POST /v3/organizations/{id}/deals`, but `/v3/people/{id}/deals` works. The
adapter falls back to the flat `POST /v3/deals` with `person` in the body if
the nested route ever 404s.

**Responses wrap the record in `data`.** `{ "data": { "id": ... } }`, not the
object at the root.

## Where the attribution goes

Into the **deal's `description`** — plain text, since the field renders none.

This is a deliberate trade. Custom fields are the tidier home, but Agendor
**rejects the entire record** if you reference a custom field that does not
exist. That trades the lead for the attribution, which is the wrong way round.

Once the client has created the fields, map them and both happen:

```
AGENDOR_CUSTOM_FIELDS = {"utm_source":"origem","utm_campaign":"campanha"}
```

Key is the session column, value is the field's *identifying column* in
Agendor (not its label).

## Inbound — webhooks

**There is no UI for webhooks.** None. Not under Integrações, not anywhere.
People hunt for the screen and conclude the feature does not exist. It is
API-only:

```
POST   /integrations/subscriptions   { "target_url": "...", "event": "..." }
GET    /integrations/subscriptions
```

Use `/api/crm/subscribe` rather than doing this by hand — the token stays
inside the Worker.

### Available triggers

`on_deal_created` · `on_deal_updated` · `on_deal_stage_updated` ·
`on_deal_won` · `on_deal_lost` · `on_deal_deleted` ·
`on_person_created` · `on_person_updated` · `on_person_deleted` ·
`on_organization_created` · `on_organization_updated` · `on_organization_deleted` ·
`on_activity_created` · `on_activity_updated` · `on_activity_finished` · `on_activity_deleted` ·
`on_product_created` · `on_product_updated` · `on_product_deleted`

The adapter registers `on_deal_stage_updated` and `on_deal_won`.

### One subscription per URL

Agendor allows **one subscription per `target_url`**, not one per event.
Registering a second trigger on the same URL returns:

```
422 { "errors": [{ "title": "target_url has already been taken" }] }
```

So each trigger gets its own URL via `?hook=<event>`. The receiver reads the
trigger name back from that query rather than trusting the payload.

### `on_deal_won` carries no stage

It means the sale by itself, so the adapter maps it straight to `Purchase`
without consulting `CRM_STAGE_EVENTS`. The deterministic event id stops it
double-counting with a `WON` stage change firing the same event.

## Gotchas that cost real time

**The deal value field is masked in cents.** Typing `2400` in the Agendor UI
produces R$ 24,00, not R$ 2.400,00 — you have to type `240000`. Tell whoever
moves deals to the won stage, or every `Purchase` reaches Meta at 1/100th of
its value and ROAS is nonsense.

**Moving a deal between pipelines is done through "Editar negócio".** There is
no drag-across-pipelines. Changing the Funil field moves the deal to the first
stage of the target pipeline, which fires `on_deal_stage_updated` normally.

**People created before the integration cannot be attributed.** They have no
`crm_log` row, so the lookup finds nothing and the event is skipped with
`person X did not come from the site`. Expected during the transition; it
resolves itself as new leads flow through the form. Those skips show up in the
dashboard's failures table — do not chase them.

## Example configuration

A clinic running two pipelines — one for qualification, one for delivery:

```
CRM_PROVIDER      = agendor
AGENDOR_TOKEN     = <secret>
AGENDOR_WEBHOOK_SLUG = <uuid v4>
CRM_STAGE_EVENTS  = {"QUALIFICADO":"QualifiedLead","CONSULTA AGENDADA":"Schedule","GANHO":"Purchase"}
AGENDOR_DEAL_TITLE = Lead do site
```

Stage matching ignores case and accents, so the keys can be written the way
they appear on screen.
