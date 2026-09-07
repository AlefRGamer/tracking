# CRM funnel events

Reference for the return path: sending what happens *after* the form back to
the ad platform.

## The problem this solves

A lead-gen page ends at `Lead`. That is the only signal Meta gets, so that is
what it optimises for — **volume of form fills**. It cannot tell a serious
buyer from a tyre-kicker, because nothing ever tells it which was which.

Everything that decides whether a lead was worth anything happens later, in a
CRM: someone calls, qualifies, books, closes. The return path sends those
stage changes back as conversion events, tied to the visit that produced the
lead in the first place.

The result: Meta stops buying *more* leads and starts buying *the kind of
people who convert*.

## Two directions

| | Trigger | Path | Result |
|---|---|---|---|
| **Outbound** | `Lead` fires | `/tracker` → `crm/_core.js` → adapter | Contact created in the CRM carrying its UTMs, `fbclid`, referrer, landing page |
| **Inbound** | Stage changes | CRM → `/webhook/crm/<provider>/<slug>` → `crm/_core.js` | Conversion event to Meta, tied to the original visit |

The two are independent. Outbound works on its own if all you want is
attribution visible inside the CRM. Inbound is what changes ad delivery.

## Which events to send

This is the question people get wrong, so it is worth being precise.

### Meta has exactly 17 standard events

`AddPaymentInfo` · `AddToCart` · `AddToWishlist` · `CompleteRegistration` ·
`Contact` · `CustomizeProduct` · `Donate` · `FindLocation` ·
`InitiateCheckout` · `Lead` · `Purchase` · `Schedule` · `Search` ·
`StartTrial` · `SubmitApplication` · `Subscribe` · `ViewContent`

**There is no standard event for a qualified lead.** No `QualifiedLead`, no
MQL, no SQL. People look for one, do not find it, and conclude the return
path is unsupported.

It is not a gap — it is deliberate. Meta's own Conversions API for CRM
guidance says to map *your* pipeline stages to event names *you* choose.
Every funnel is named differently, so Meta stops prescribing after `Lead`.

### So: standard where one fits, custom where none does

A typical service-business mapping:

| Pipeline stage | Event | Type |
|---|---|---|
| Form submitted | `Lead` | standard — fired by the page, not the CRM |
| Qualified by sales | `QualifiedLead` | **custom** |
| Appointment booked | `Schedule` | standard — "booking of an appointment to visit one of your locations" |
| Deal won | `Purchase` + `value` | standard |

`Schedule` and `Purchase` are exact fits and appear in Ads Manager by
themselves. A custom event needs a **custom conversion** created in Events
Manager pointing at that name before it can be used as a campaign objective.
That is a one-time, two-minute step, and forgetting it is the most common
reason a correctly-firing event cannot be optimised for.

### Which stage to optimise for

Meta's rule of thumb: pick a stage that **one third to one half** of leads
reach. Frequent enough for the algorithm to learn from, rare enough to mean
something.

In practice that is usually the "qualified" stage, not the sale. Two reasons:

- **Volume.** A brand-new pipeline has zero closed deals. A campaign
  optimising for an event with no history never leaves the learning phase and
  costs climb.
- **Attribution window.** Meta attributes on a 7-day click window. If deals
  take longer than that to close, most `Purchase` events land outside it. They
  still train delivery, but they will not show up as attributed conversions.

Optimise for the qualified stage, measure with `Schedule` and `Purchase`, and
move the objective down the funnel once the lower stages have history.

## Attribution beats the deal id

`crm_log.person_id` — not `deal_id` — is what ties a CRM record back to its
session.

This looks like a detail and is not. Pipelines get split across teams, and the
second team frequently creates a *new* deal instead of moving the existing
one. Match on the deal and attribution silently disappears at exactly the
stage that matters most. The person record survives.

## Duplicates

Event ids are deterministic: `<provider>-<deal|person>-<event>`. Drag a card
back a stage and forward again and Meta receives the same id, so it counts
once.

This also means "already sent" is normal behaviour, not a failure — the
dashboard's failures table filters it out deliberately.

## `action_source`

CRM events use `action_source: 'system_generated'`, not `'website'`. No
browser was involved — a person moved a card. Sending `website` for an event
with no browser context is a misrepresentation and Meta may reject it.

## Setup

| Variable | Purpose |
|---|---|
| `CRM_PROVIDER` | Which adapter is active (`agendor`). Unset disables the whole CRM path. |
| `CRM_STAGE_EVENTS` | Stage → event map, JSON. e.g. `{"QUALIFIED":"QualifiedLead","BOOKED":"Schedule","WON":"Purchase"}` |
| `CRM_FUNNEL_EVENTS` | Optional. Dashboard funnel order. Defaults to `["Lead","QualifiedLead","Schedule","Purchase"]`. |
| `CRM_CURRENCY` | Optional. Currency for `Purchase`. Defaults to `BRL`. |
| `<PROVIDER>_TOKEN` | The CRM's API token. Secret. |
| `<PROVIDER>_WEBHOOK_SLUG` | UUID v4 gating the inbound route. Secret. |

Stage names are matched case-insensitively and accent-insensitively, so
`Consulta Agendada` and `CONSULTA AGENDADA` resolve to the same entry.

Register the webhooks with:

```bash
curl -X POST "https://<your-domain>/api/crm/subscribe?key=<DASH_KEY>"
```

That endpoint exists because most CRMs have no UI for webhooks. It uses the
token already held by the Worker, so nobody has to handle the credential to
get set up.

## Per-provider notes

- [Agendor](agendor.md)
- [Adding another CRM](_template.md)
