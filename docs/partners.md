# Partner links (API contract)

A partner link connects one **repair shop** with one **sewing or quilt shop** (StitchShop) that takes machines in
for it, buys parts and notions from it, and sells its stock on consignment. The hub relays typed JSON messages
between the two shops and stores nothing else about them. Only the two shops on a link receive its messages.

The hub does not act on the messages, but it does not hide or sign them either: they are stored as plain JSON for a
year (and are part of an export), so whoever runs the hub can read them, and could send one as either shop. The
apps take the hub's word for who a message is from. Run or join a hub you trust with this.

An install can host several shops (companies), so every call names the shop inside the install: `shopRef` (the
shop's id in that install). Both shops of a link can even be in the same install.

## Connecting

1. One shop makes a code: `POST /v1/partners/invites` `{ shopRef, shopName, side: "repair" | "retail", terms }` →
   `{ code: "7KQP-M2XH-9TRD", expiresAt }`. Codes use letters and digits that can't be misread (no 0/O, 1/I/L), are
   good for 14 days and work once. `terms` is whatever the apps agree on (StitchBench: `PartnerTerms`).
2. The other shop redeems it:
   - already on the hub: `POST /v1/partners/redeem` `{ code, shopRef, shopName }` → `{ link, side }`;
   - not on the hub: `POST /v1/partners/join` `{ code, shopRef, shopName, contact }` (no key) → `{ installId,
     installKey, scope: "partner", link, side }`. That install can call `/v1/partners/*` and `/v1/me` only, until
     `POST /v1/upgrade` `{ joinKey }` makes it a member.
3. The hub sends both sides a `link.created` message carrying the link.

Linking the same two shops again reuses (and reopens) their link.

## Messages

`POST /v1/partners/links/:id/messages` `{ id, shopRef, type, data }`: `id` is the sender's own id for the message;
sending the same `id` again is stored once (`duplicate: true`). `type` looks like `job.new` (lower-case word, dot,
word). Up to 4 MB (intake photos travel inside, shrunk by the app).

`GET /v1/partners/messages?since=N&limit=200` → `{ messages: [{ seq, id, linkId, fromSide, toSide, toShopRef,
type, data, createdAt }], next, more }`: messages for this install's shops after `N`, oldest first. A shop never
gets its own messages back. Hub messages (`fromSide: "hub"`) go to both sides; if both shops are in this install,
each gets its own copy (`toShopRef`). Keep `next` and ask again with it.

Messages are deleted after a year; spent codes after they expire plus 30 days.

`POST /v1/partners/links/:id/end` `{ shopRef, note }`: the link is marked ended and both sides get `link.ended`.
Messages can still pass (for the last statement).

## Message types StitchBench uses

| From | Type | Data |
|---|---|---|
| hub | `link.created`, `link.ended` | the link (`endedBy`, `note` when ended) |
| either | `terms.propose` | `{ version, terms, name, at }` |
| either | `terms.accept` | `{ version, name, at, key }` |
| repair shop | `catalog` | `{ items: [{ itemKey, partNumber, description, kind, brand, unit, wholesaleCents, retailCents, inStock }] }` |
| sewing shop | `job.new` | `{ id, tag, customerName (first name, last initial), brand, model, serial, machineType, problem, serviceRequested, accessories, preApprovedCents, note, photos: [{ mime, data (base64), caption }] }` |
| repair shop | `job.update` | `{ id, status, ticketNumber, lines, totalCents, taxCents, commissionPct, commissionCents, repairNote, paidCents, paidAt, readyAt }` |
| sewing shop | `job.reply` | `{ id, approval: APPROVED \| DECLINED, approvedCents, note, name }` |
| sewing shop | `job.paid`, `job.pickedup`, `job.cancel` | `{ id, amountCents, saleNumber }`, `{ id }`, `{ id, note }` |
| sewing shop | `order.new` | `{ id, number, lines: [{ itemKey, partNumber, description, qty, unitCents }], note, name }` |
| either | `order.update` | `{ id, status, carrier, tracking, sellerNote, eventNote }` |
| repair shop | `consign.place` | `{ id, items: [{ itemKey, partNumber, description, kind, brand, unit, priceCents, qty }] }` |
| either | `consign.return` | `{ id, items: [{ itemKey, qty }] }` |
| sewing shop | `consign.sale` | `{ id (sale line), itemKey, qty (negative for a void), priceCents, saleNumber }` |
| sewing shop | `consign.count` | `{ id, items: [{ itemKey, onHand }] }` |
| either | `settle.paid` | `{ id, periodFrom, periodTo, netCents (+ sewing shop paid), summary, note, name }` |

Every message also carries `at` (when it happened). Apply messages so that receiving one twice does no harm.
