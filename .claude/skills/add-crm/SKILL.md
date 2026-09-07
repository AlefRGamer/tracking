---
name: add-crm
description: Wire a CRM into the tracking stack — push captured leads into it with their attribution, and send pipeline stage changes back to Meta as conversion events. Use when the recipient says "I use [CRM]", "send my leads to my CRM", "connect my CRM", "optimise for qualified leads", "Meta only knows about form fills", "send my sales stages back to Meta", or asks about MQL/SQL/qualified-lead events. Creates functions/crm/<provider>.js from the Agendor adapter as a structural reference, registers it, creates docs/crm/<provider>.md from the template, generates the webhook slug, and works out the stage-to-event map with the recipient.
---

# Skill: add-crm

The recipient wants their CRM connected. There are two halves and they are
worth naming separately, because recipients often only realise they want the
second one after you explain it:

- **Outbound** — a captured lead lands in the CRM carrying its UTMs, `fbclid`,
  referrer and landing page. Attribution becomes visible to the sales team.
- **Inbound** — pipeline stage changes come back to Meta as conversion events,
  tied to the original visit. **Ad delivery changes.** Meta stops optimising
  for form-fill volume and starts optimising for people who convert.

If `CRM_PROVIDER` is already set and the recipient's CRM is `agendor`, they do
not need this skill — send them to the configuration section of
`docs/crm/README.md`.

Read `docs/crm/README.md` before starting. It carries the event-vocabulary
reference you will need in Step 3, and getting that wrong is the most
expensive mistake available here.

## Step 1 — Gather the CRM info

Five things. Ask for them a couple at a time; do not dump the list.

1. **CRM name** — becomes the filename, lowercase, no spaces.
2. **API docs URL**, and the **exact auth header**. `Token`, `Bearer` and
   `apikey` are all in use; the wrong one returns a 401 that looks like a bad
   token and sends people back to regenerate a perfectly good one.
3. **How a contact is created**, and **whether there is an upsert**. If there
   is, what does it deduplicate on? If there is not, say plainly that repeat
   submissions will create duplicate contacts — the sales team will notice.
4. **Whether the CRM has webhooks**, and how they are registered. Many are
   API-only with no screen anywhere. Establish this before promising the
   inbound half.
5. **The recipient's pipeline stages**, verbatim, in order. Ask them to read
   them off the screen rather than paraphrasing — you will match on these
   strings.

Do not ask for the token. It goes straight into Cloudflare as a secret at the
end; you never need to see it.

## Step 2 — Write the adapter

Copy `functions/crm/agendor.js` as the structural reference. It is the only
adapter, so it is also the contract:

| Member | Required | Purpose |
|---|---|---|
| `name` | yes | Lowercase provider key, matches the filename and the URL segment |
| `tokenEnvVar` / `slugEnvVar` | yes | Env var names |
| `pushLead({ lead, origin, session, env })` | yes | Returns `{ ok, status, personId, dealId, request, response }` |
| `parseWebhook({ body, hook })` | yes | Returns `{ personId, dealId, stage, value }` |
| `webhookEvents` | inbound | Triggers to register |
| `listSubscriptions` / `createSubscription` / `subscriptionMatches` | inbound | Used by `/api/crm/subscribe` |
| `eventForHook(hook)` | optional | For triggers that imply an event with no stage, e.g. a "deal won" hook |

Rules:

- **Do not add provider branching to `_core.js`.** If you are about to write
  `if (provider === ...)` there, it belongs in the adapter.
- **`personId` must be stable across pipelines.** It is the key the return
  path matches on. Read the "Attribution beats the deal id" section of
  `docs/crm/README.md` before choosing it.
- Register the adapter in `functions/crm/_registry.js` — one import, one map
  entry.

## Step 3 — Work out the stage map

This is the part with judgement in it, and the part worth slowing down for.

Take the recipient's pipeline stages and decide which ones are worth an event.
Most stages should fire nothing. Then map each chosen stage to a Meta event
using the vocabulary reference in `docs/crm/README.md`.

Two things to tell the recipient explicitly, because they will not know:

- **There is no standard "qualified lead" event.** Meta has 17 standard events
  and none of them is MQL/SQL. A custom event is correct here, not a
  workaround — but it needs a **custom conversion** created in Events Manager
  before it can be used as a campaign objective. Say this out loud; forgetting
  it is the most common reason a correctly-firing event cannot be optimised
  for.
- **Which stage to optimise for.** Roughly one third to one half of leads
  should reach it. Usually that is the qualified stage, not the sale — a new
  pipeline has no closed deals, and a campaign optimising for an event with no
  history never leaves the learning phase.

Write the result as `CRM_STAGE_EVENTS`, and confirm it back to the recipient
in their own stage names before moving on.

## Step 4 — Document it

Copy `docs/crm/_template.md` to `docs/crm/<provider>.md` and fill it in as you
go — not afterwards. The "Gotchas that cost real time" section is the one that
earns the file: anything that behaved differently from the documentation, or
that a non-technical operator can silently get wrong.

Add a link to the new file from the bottom of `docs/crm/README.md`.

## Step 5 — Generate the slug and hand off

Generate a UUID v4 for `<PROVIDER>_WEBHOOK_SLUG`. Then give the recipient the
env vars to paste into Cloudflare Pages → Settings → Variables:

| Variable | Type |
|---|---|
| `CRM_PROVIDER` | Text |
| `CRM_STAGE_EVENTS` | Text |
| `<PROVIDER>_TOKEN` | **Secret** |
| `<PROVIDER>_WEBHOOK_SLUG` | **Secret** |

Tell them to redeploy afterwards — Pages env vars only reach a build that runs
after they are set.

Then register the webhooks:

```bash
curl -X POST "https://<domain>/api/crm/subscribe?key=<DASH_KEY>"
```

## Step 6 — Verify end to end

Do not stop at "it deployed". Verify both halves with real data:

1. **Outbound.** Submit a test lead on the page. Confirm the contact appears
   in the CRM with the origin block filled in.
2. **Inbound.** Move that deal into a mapped stage. Then check what Meta
   actually said:

   ```bash
   npx wrangler d1 execute <db> --remote --json \
     --command "SELECT provider, status_code, ok, response_body FROM crm_log ORDER BY id DESC LIMIT 3"
   ```

   You are looking for `"events_received": 1` in the response body. A 200 from
   our own endpoint proves nothing — it is Meta's answer that counts.

3. Open `/dash` and confirm the CRM funnel section shows the event.

Finally, delete the test records from the CRM — but **ask first**. It is the
recipient's client data, not yours.
