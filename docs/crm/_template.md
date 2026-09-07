# CRM template

Starting shape for documenting a new CRM. Copy to `docs/crm/<provider>.md` and
fill in each section. The `add-crm` skill walks through populating it.

Every adapter is thin: authenticate, push a lead, parse a webhook. The shared
lookup, stage mapping, deduplication and Meta fan-out live in
`functions/crm/_core.js` and never branch per provider.

Read [README.md](README.md) first for the concepts — which events to send and
why the lookup is by person.

---

## Identity

- **CRM name**:
- **API base**:
- **Auth header** — the exact string, including the scheme word. `Token`,
  `Bearer` and `apikey` are all in use across CRMs and getting it wrong
  returns a 401 that looks like a bad token.
- **Where the recipient finds the token** — exact UI path.
- **Env vars**: `<PROVIDER>_TOKEN`, `<PROVIDER>_WEBHOOK_SLUG`
- **Inbound URL**: `/webhook/crm/<provider>/<slug>`

## Outbound — creating the lead

- **Endpoint(s)** and order of calls.
- **Is there an upsert?** What does it deduplicate on — email, phone, an
  external id? What happens to a lead missing that field? Without an upsert,
  every repeat submission creates a duplicate contact and the sales team will
  notice before you do.
- **Payload shape.** Paste a real one. Note especially whether contact fields
  are nested or flat — this is the single most common mistake, and the failure
  is silent: a 201 with an empty email.
- **Response shape.** Where is the created id? Wrapped in `data`, or at the
  root?
- **Does it create a deal/opportunity too**, or only a contact?

## Where the attribution goes

- **Which field** holds the origin block.
- **Are custom fields available?** If yes: what breaks when you reference one
  that does not exist? Many CRMs reject the whole record, which trades the
  lead for the attribution — the wrong way round. Default to a free-text
  field and treat custom fields as an opt-in.
- **Mapping variable**, if the adapter supports one.

## Inbound — webhooks

- **Is there a UI for webhooks, or is it API-only?** Say this explicitly.
  API-only is common and people waste an hour looking for the screen.
- **Registration endpoint** and payload.
- **Full list of available triggers**, verbatim.
- **Which triggers this adapter registers** and why.
- **Any limit on subscriptions** — one per URL, one per event, a maximum
  count? Agendor allows one per `target_url` and returns 422 on the second,
  which is the kind of thing you only discover by hitting it.
- **Payload shape of a real webhook.** Where are the person id, the deal id,
  the stage name and the value?
- **Do any triggers carry no stage?** Map those directly via `eventForHook`.

## Stage mapping

The recipient's pipeline, and the `CRM_STAGE_EVENTS` value that fits it:

```
CRM_STAGE_EVENTS = {"<STAGE>":"<MetaEvent>", ...}
```

Note which stage they should optimise for and why — see the one-third-to-one-half
rule in [README.md](README.md).

## Gotchas that cost real time

The section that earns this file. Anything that behaved differently from what
the documentation said, or that a non-technical operator can silently get
wrong. Real examples worth copying in spirit:

- A value field masked in cents, so `2400` becomes 24.00.
- Records created before the integration existed that can never be attributed.
- An operation that looks like drag-and-drop but is actually a form field.

## Example configuration

A complete, working set of env vars with realistic values.
