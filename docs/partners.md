# Partner links (API contract)

A partner link connects one **repair shop** with one **sewing or quilt shop** (StitchShop) that takes machines in
for it, buys parts and notions from it, and sells its stock on consignment. The hub relays typed JSON messages
between the two shops and stores nothing else about them. Only the two shops on a link receive its messages.

The hub does not act on the messages and does not hide them: they are stored as plain JSON for a year (and are part
of an export), so whoever runs the hub can read them. Run or join a hub you trust with that. They are signed, though
(next section): a program checks every message against the key it pinned for its partner, so the hub cannot make one up.

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

## Signing

Each company's program makes an Ed25519 key pair (the private key never leaves it). Keys travel as base64 of the
SPKI DER; `fingerprint(key)` is the first 10 bytes of the key's sha256 as five groups of four hex digits.

- Invite: `POST /v1/partners/invites` also takes `publicKey` and `proof: { issuedAt, sig }`, where `sig` signs
  `SBINV1 \n fingerprint \n side \n shopRef \n sha256(canonical terms) \n issuedAt`. The answer carries `fingerprint`.
- Redeem and join also take `publicKey` and `proof`, signing `SBRDM1 \n sha256(code without dashes) \n shopRef \n issuedAt`.
  The link the hub sends (`link.created`, the redeem answer) has `repair` and `retail` each with `publicKey` and `proof`
  (null for a side whose program sends none). A new code for the same pair replaces both keys: that is how a company
  that lost its key is trusted again.
- Messages: `POST .../messages` also takes `sig: { v: 1, pub, seq, ts, sig }`, `sig` signing
  `SBPM1 \n link id \n sender's side \n type \n message id \n seq \n ts \n sha256(canonical data)` (canonical JSON:
  keys sorted). `seq` is a millisecond clock that only goes up per link and sender. The hub checks the signature
  against the key on file for that side (a side with none takes the key of its first valid signature), stores `sig`
  and marks the message `verified`. A bad signature or a key other than the one on file is a 400; an unsigned message
  from a side that has a key on file is a 400 too. Unsigned messages from older programs are still stored (unverified).
  The feed gives each message's `sig` so the receiving program verifies it itself.

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
| repair shop | `catalog` | `{ items: [{ itemKey, partNumber, description, kind, brand, unit, wholesaleCents, retailCents, inStock, condition?, origin? }] }` |
| sewing shop | `job.new` | `{ id, tag, customerName (first name, last initial), brand, model, serial, machineType, problem, serviceRequested, accessories, preApprovedCents, note, photos: [{ mime, data (base64), caption }] }` |
| repair shop | `job.update` | `{ id, status, ticketNumber, lines, totalCents, taxCents, commissionPct, commissionCents, repairNote, paidCents, paidAt, readyAt }` |
| sewing shop | `job.reply` | `{ id, approval: APPROVED \| DECLINED, approvedCents, note, name }` |
| sewing shop | `job.paid`, `job.pickedup`, `job.cancel` | `{ id, amountCents, saleNumber }`, `{ id }`, `{ id, note }` |
| sewing shop | `order.new` | `{ id, number, lines: [{ itemKey, partNumber, description, qty, unitCents, condition?, origin? }], note, name }` |
| either | `order.update` | `{ id, status, carrier, tracking, sellerNote, eventNote }` (from the repair shop also `lines`, as above) |
| repair shop | `consign.place` | `{ id, items: [{ itemKey, partNumber, description, kind, brand, unit, priceCents, qty, condition?, origin? }] }` |
| either | `consign.return` | `{ id, items: [{ itemKey, qty }] }` |
| sewing shop | `consign.sale` | `{ id (sale line), itemKey, qty (negative for a void), priceCents, saleNumber }` |
| sewing shop | `consign.count` | `{ id, items: [{ itemKey, onHand }] }` |
| either | `settle.paid` | `{ id, periodFrom, periodTo, netCents (+ sewing shop paid), summary, note, name }` |

Every message also carries `at` (when it happened). Apply messages so that receiving one twice does no harm.

`condition` (`USED` or `REFURB`) and `origin` (`COMPATIBLE` or `PRINTED`) say that a part isn't new / isn't the machine
maker's own. They are sent only when they say that: left out means `NEW` / `GENUINE`, which is also what an install from
before they existed means. A receiver ignores values it doesn't know.
