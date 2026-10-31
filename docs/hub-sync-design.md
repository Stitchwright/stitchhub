# Hub sync design: versions, handshake and a queue for offline shops (#19, Phase 2)

**Status:** 2026-10-31. **Approved by the owner on 2026-10-31 (30 days after the ack for message bodies).** Steps A to C are built in the transport PR (see "As built" at the end); the order messages of #34 are built on top. Read [`hub-sync-audit.md`](hub-sync-audit.md) first (how it works today). Input: MakerFoundry's proposal, `docs/shop-orders-contract.md` on the branch `issue-2-ordering-audit` of SiteSentrix/makerfoundry (PR #44). #34 (MakerFoundry orders) is built on top of this and waits for it.

## The decisions in one minute
1. **Adopt MakerFoundry's proposal almost whole**: the envelope (sender-made id, `type`, `version`, per-conversation `seq`, `expires_at`), `GET /v2/hello`, `POST /v2/messages`, `GET /v2/messages` with `POST .../ack`, `message.expired` back to the sender. It is the right shape and it matches what partner messages already do (sender ids, dedupe, signatures).
2. **One queue for every kind of message**, not one per feature. The partner messages (job, order, consign...), the MakerFoundry orders and the StitchFoundry inbox's notices all ride the same tables. `/v1/partners/messages` keeps working unchanged during the support window and reads the same data.
3. **No new infrastructure**: Postgres tables, polling (with an optional 25-second wait so news arrives in seconds), no websockets, no broker.
4. **The hub keeps a message body only until it is acknowledged plus 30 days**, then keeps an audit stub (no body). This is shorter than today (a year) and is the owner's call (privacy text changes with it).
5. **Nothing is silently dropped.** A full queue refuses the new message and tells the sender; an expired message sends `message.expired` back; a recipient too old to understand a message holds it (visibly) until it updates or the message expires.

## Where I changed MakerFoundry's proposal, and why
| Their proposal | This design | Why |
|---|---|---|
| `order` field on every message | `conversation` (any string: an order, a job, a link), with `seq` per sender per conversation | Partner jobs and links need the same ordering as orders. An order is just a conversation |
| `seq` only per order | Also a hub-made `delivery_seq` per recipient, used as the polling cursor | Per-conversation `seq` orders one conversation; the cursor is what a poller resumes from. They answer different questions |
| Delivered messages kept 30 days "for support" | Body kept 30 days after ack, then erased down to an audit stub | Same period, but made explicit as "stub afterwards" (the issue's wording) |
| Bodies at most 256 KB | 256 KB for new families; `partner` family keeps today's 4 MB until intake photos move to signed-address attachments | Today's job intake carries photos inside the message; cutting it to 256 KB would break StitchBench |
| Default expiry 7 days (orders), 14 (proofs) | Per-type table (below); partner job and order messages **60 days**, not 7 | A repair shop on a two-week holiday must not lose a job. Today partner messages never expire, so any expiry is a behaviour change (owner's decision) |
| Auth: service key for MakerFoundry | Same, plus MakerFoundry **signs** `order.placed` with its own Ed25519 key | `order.placed` means "money was taken". Partner messages are already signed end to end so the hub cannot forge one; orders that cost money should be too |
| Not covered | Capability filtering, per-recipient queue caps, replay window, key rotation, health dashboard | The rest of #19's list |

## 1. API versions
- **Major version in the path**: `/v1/...` (today) and `/v2/...`. Within a major, changes are **additive only**: new optional fields, new routes, new message types. A field is never removed or reinterpreted; readers ignore fields they do not know.
- **Message types have their own version** (`order.placed` v1, v2). A breaking change to a message is a new version, offered alongside the old one until its sunset date.
- **Support window: the current major and the previous two.** When `/v4` ships, `/v1` is switched off (after notice).
- **Deprecation notice**: every response from a deprecated route carries `Deprecation: true` and `Sunset: <date>` headers, `/v2/hello` lists it, and programs show a quiet banner ("StitchHub will stop supporting this version of the program on <date>. Please update.").
- **Minimum version**: `/v2/hello` returns `min_client` per app (`stitchbench`, `stitchshop`, `makerfoundry`). A program older than that gets **`426 Upgrade Required`** on every call except `/hello`, with a plain JSON message and the download address. The program turns it into its own "please update" screen and stops sending (it keeps its outbox).
- **Notice period before a cut-off: at least 90 days** from the day the hub starts returning the warning (owner's call).
- Where the version lives: path for the API, `X-Client: <app>/<version>` header on every call (the hub records it per install; today the version is only known per shop and unused).

## 2. The capability handshake
`GET /v2/hello` (also sent after every reconnect), headers `X-Client: stitchbench/1.8.0`, query or body listing what the program understands:
```json
{ "app": "stitchbench", "version": "1.8.0",
  "types": { "job.new": [1], "job.update": [1], "order.new": [1], "proof.sent": [1] } }
```
Answer:
```json
{ "hub": "2.0.0", "min_client": { "stitchbench": "1.8.0", "stitchshop": "1.8.0", "makerfoundry": "0.1.0" },
  "types": { "job.new": [1], "order.placed": [1] },
  "deprecated": [{ "route": "/v1/partners/messages", "sunset": "2027-06-01" }],
  "limits": { "body_bytes": 262144, "queue_messages": 1000, "queue_bytes": 67108864 } }
```
- The hub stores the install's capabilities (`install_caps`: app, version, types and versions, last hello).
- **The hub never delivers a type or version the recipient has not declared.** If a sender sends one:
  1. if the sender included a lower-version body (`downgrade: [{ version: 1, body }]`), the hub delivers that;
  2. otherwise the message is **held** (`held_capability`) in the queue, the sender sees "waiting for the shop to update", and it is delivered when the recipient's next hello lists the type, or it expires (`message.expired` with reason `recipient_too_old`).
- A program that has never said hello (an old v1 program) is treated as supporting exactly what v1 delivers today (the existing partner types), so nothing changes for it.

## 3. The durable per-recipient queue
Postgres, two tables (names are proposals):
- `messages`: `id` (the sender's UUIDv7), `sender` (principal), `type`, `version`, `conversation`, `seq`, `created_at`, `expires_at`, `body` (jsonb, erased later), `body_sha256`, `body_bytes`, `sig`.
- `deliveries`: one row per recipient (`message_id`, `recipient`, `delivery_seq` bigserial, `state`: `queued` | `held_capability` | `delivered` | `acked` | `expired`, `delivered_at`, `acked_at`).

Rules:
- **Send**: `POST /v2/messages` with the envelope. The hub checks the principal, the recipient's opt-in/relationship, size, type known and allowed for this sender, `created_at` within ±10 minutes (replay window), signature where the type requires one. `202 { queued: true }`. The same `(sender, id)` twice returns `202 { duplicate: true }` and stores nothing.
- **Receive**: `GET /v2/messages?after=<delivery_seq>&limit=50[&wait=25]` returns the recipient's oldest unacknowledged messages (a held one is skipped). `POST /v2/messages/ack { ids }` marks them `acked`. Delivery is **at least once**: a message fetched but not acked is offered again. Receivers **de-duplicate by `id`** (partner programs already do).
- **Ordering**: per `(sender, conversation)` by `seq`, starting at 1. The hub hands a conversation's messages out in `seq` order and does not release `seq` n+1 while n is queued and unexpired. The receiver also applies in `seq` order and holds a later one until the gap fills; a gap older than 24 hours raises an admin notice. Different conversations are independent (a stuck order never blocks another job).
- **Expiry**: each message has `expires_at`. A sweep (every few minutes) marks an unacked, past-due delivery `expired`, erases its body, and sends the sender **`message.expired { id, type, conversation, reason }`**.

| Type family | Default expiry |
|---|---|
| `order.placed` (MakerFoundry to shop) | 7 days (then refund; as proposed) |
| `proof.sent`, `proof.answer`, `order.status`, `order.cancel` | 14 days |
| Partner `job.*`, `order.*`, `consign.*`, `catalog` | **60 days** (owner to confirm) |
| StitchFoundry inbox notices | 30 days (matches the file's life) |

- **Retention**: an acked body is erased 30 days after the ack, leaving the **audit stub** (`id`, sender, recipient, type, version, conversation, seq, byte count, `body_sha256`, timestamps, state). Stubs are kept one year, then deleted. Nothing in a stub is personal data beyond the shop ids.
- **Caps** (defaults, per recipient): 1,000 queued messages and 64 MB of queued bodies; 50 messages a minute per sender per recipient. A full queue **refuses** the new message (`429`, `recipient_queue_full`); it never drops old ones. The sender sees the refusal at once.
- Large files never go in a message; they use the inbox's short-lived signed addresses, checked by size and SHA-256 (10 MB a file, previews 2 MB).

## 4. What the sender and the shop see (the offline experience)
- A sender can ask `GET /v2/messages/status?ids=...` and sees `queued` ("delivered to the hub, waiting for the shop"), `delivered`, `acked` ("received by the shop"), `held_capability` ("the shop's program needs updating") or `expired`.
- Shops: a program that was off for three days reconnects, says hello, and drains its queue in order. It shows "Catching up: 12 messages" while it does. An expired message appears under "Messages that didn't get through" on the sender's side (StitchBench already has this screen for `msg.rejected`).
- MakerFoundry shows its customer "Sent to the shop" while queued (with "the shop's program is offline; it gets your order when it's back on"), and "Received by the shop" after the ack, as proposed.

## 5. The client side (one shared module)
A small module that StitchBench, StitchShop and MakerFoundry share (in `stitch-contracts` if it exists, otherwise in `contracts/` for now, MIT OR Apache-2.0):
- a **durable outbox** (local database table): a message is written first, then sent; the same `id` and `seq` on every retry; retry with exponential backoff and jitter; survives restarts;
- **hello** on start and on reconnect; handling of `426` (stop sending, show "please update", keep the outbox) and `Deprecation`;
- **polling** with the cursor, ack after the message is applied (not before), de-duplication by `id`, per-conversation `seq` holding;
- a **status** for the screen: online, offline since, queued to send, catching up.
StitchBench already has the pieces (`partnerOutbox`, `applyOnce`, `tellRejected`, an offline pill); the module generalises them.

## 6. Conflicts
Rule: **the record's owner wins**; the other side's message is a request, not a fact. Each conversation type names its owner:

| Record | Owner | Others may |
|---|---|---|
| A repair ticket and its bill | The repair shop | Approve or decline an estimate (`job.reply`); cancel (`job.cancel`) |
| A sale, a customer's payment at the counter | The sewing shop | Nothing |
| A MakerFoundry order's fulfilment status | The shop | MakerFoundry may only add `proof.answer` and `order.cancel` |
| A MakerFoundry order's payment | MakerFoundry | Nothing |

When both sides acted while one was offline (the customer cancels in MakerFoundry while the shop had already moved the order to `in_production`): each message carries `base_seq`, the last `seq` it had seen from the other side. A receiver that sees a message whose `base_seq` is older than the status it has already published treats it as a **conflict**: it does not apply it silently, it keeps the owner's status, and adds a **"Needs a look" item** for a person (with both messages) and, for money, tells the other side with a `conflict` notice. Cancel-after-production on MakerFoundry orders follows the Seller Terms (the shop decides the refund).

## 7. Security
- **Principals**: (a) a program's **install key** (hashed; rotate with `POST /v2/key/rotate`, the old key works for 24 hours); (b) a **service key** the hub admin issues to MakerFoundry (hashed in the database, shown once, prefix `mfk_`, scopes such as `orders:send`, revocable, rotatable, its last use recorded); (c) a **Foundry token** for StitchFoundry's sender, as today.
- **Signed messages**: every message type that moves money or changes a record is signed (Ed25519) by its sender's registered key over the canonical envelope (including `to`, `conversation`, `seq`, `expires_at`), so the hub and any observer cannot alter or redirect it. Partner messages are signed today; `order.placed` joins them with MakerFoundry's key. The shop pins MakerFoundry's public key from the hub's hello, set by the admin. (Trust anchor: owner to confirm.)
- **Replay protection**: `created_at` within ±10 minutes on submit; `(sender, id)` is unique for as long as the audit stub lives, so an old message cannot be replayed even after its body is erased; receivers de-duplicate by `id`.
- **TLS only** (HSTS); no secrets in URLs or logs; bodies are never logged.
- **Minimal payloads**: MakerFoundry orders never carry the customer's email or phone; the shipping address is sent only when the order ships (#34).
- **Rate limits**: per principal and per recipient (above).

## 8. The installs health dashboard (admin)
A page in `/admin`: one row per install: app, version, last seen, last hello, queue depth and the age of its oldest queued message, held count, and a **cut-off countdown** for any install below the next `min_client`. An alert (email or the Discord webhook the hub already has) goes to the admin for: an install about to be cut off (30, 7 and 1 day), a queue near its cap, and a message within a day of expiring. A recipient's owner sees the same for their own shop in the program.

## 9. Migration (no big bang)
1. **Step A (small, no behaviour change)**: `X-Client` recorded per install, `/v2/hello`, `Deprecation`/`Sunset` and `426` plumbing with `min_client` empty.
2. **Step B**: the `messages`/`deliveries` tables; `/v2/messages` and ack. `/v1/partners/messages` becomes a view over the same tables, so v1 programs keep working and can move when they update.
3. **Step C**: expiry, `message.expired`, caps, the status route, replay window, key rotation.
4. **Step D**: the dashboard and alerts.
5. **Step E** (separate PR, #34): MakerFoundry as a principal, shop opt-in, the order types, the catalogue.
The shared client module and the contract fixtures (one valid and several invalid examples per type and version) are written with step B and tested in every repo.

## 10. Tests to write in Phase 3
A shop that reconnects after 3 days offline and drains in order; an old client receiving a newer type (held, then delivered after hello); duplicate delivery; out-of-order delivery; an expired message (sender gets `message.expired`, body gone); queue overflow (new refused, old kept); a conflict while both sides were offline (owner wins, "Needs a look" raised); `426` for a too-old client; replay of an old id; contract tests in each repo.

## 11. Also found while auditing (small fixes for Phase 3, owner to approve)
- Blank `file_name` and `meta` on `inbox_items` rows when the file is taken or expires (the row stays forever today).
- Marketplace orders keep contact details with no deletion: blank `buyer_contact`, `seller_contact` and `ship_to` some days after an order is RECEIVED or CANCELLED (period: owner and lawyer).
- Update the draft privacy policy 5.4 to match the new retention.

## Open questions for the owner
1. **Retention**: 30 days after ack, then a stub for a year? (Today: a year of full bodies.) The privacy text must change with it.
2. **Expiry of partner messages**: 60 days, or never expire as today? An expired job is a lost job.
3. **Minimum version policy**: 90 days' notice before a cut-off; who decides each cut-off?
4. **MakerFoundry's signing key**: who holds it, and how do shops learn to trust it (published by the hub admin through hello is proposed)?
5. **Caps**: 1,000 messages and 64 MB per recipient queue; 200 open orders per shop (from #34); OK?
6. **Scope**: put every message family on `/v2` (this design), or only the new ones and leave partner messages on `/v1` for now?
7. **The shared client module and contract fixtures**: in `stitch-contracts` (needs the new repo) or in `contracts/` for now?

## As built (transport PR, 2026-10-31)
What is in the code now (`src/sync.mjs`, `src/sync-types.mjs`, migration `040_sync.sql`, `test/sync.mjs`), and where it differs from the text above:
- `GET /v2/hello` is public and only reads; **`POST /v2/hello`** records what the caller understands (a GET with a body was awkward). Held messages are released by the POST.
- Service keys start `svk_` (not `mfk_`: they are not only MakerFoundry's), are hashed, carry scopes `orders:send` and `shops:list`, and can be revoked; the admin sets an optional Ed25519 public key. The signature itself is checked with the order messages (next PR).
- Addresses: `shop:<hub shop id>`, `service:<name>`, `hub`.
- `GET /v2/messages` hands a conversation's messages out in `seq` order: `seq` n+1 is not released while n is still queued or held for the same recipient. `wait=` (up to 25 s) makes the poll wait for news.
- Expiry: a sender may ask for a shorter life than the type's maximum (7 days for an order, 14 for proofs and status, 30 for notices). The notice `message.expired` has a reason `expired` or `recipient_too_old`.
- **Not done yet:** `downgrade` bodies (a lower-version copy for an old recipient: today the message is held), the installs health dashboard and alerts (Step D), key rotation for install keys, and moving the partner messages onto `/v2` (`/v1/partners/messages` is untouched). The queue tables are in flight data and are not part of a hub export.
- Settings, names only: `SYNC_MIN_CLIENT`, `SYNC_DEPRECATED`, `SYNC_UPDATE_URL`, `SYNC_QUEUE_MESSAGES` (1000), `SYNC_QUEUE_MB` (64), `SYNC_BODY_KB` (256), `SYNC_KEEP_DAYS` (30), `SYNC_SKEW_MIN` (10), `SYNC_SWEEP_MS` (60000).

## As built (order messages PR, #34, 2026-10-31)
What is in the code now (`src/sync-orders.mjs`, `src/sync.mjs`, migration `041_sync_orders.sql`, `test/sync-orders.mjs`, fixtures in `test/fixtures/sync-orders/`):
- **Message bodies are checked and cleaned before they are queued** (`validateBody`): `catalog`, `order.placed`, `order.status`, `proof.sent`, `proof.answer`, `order.cancel`, `message.expired`. The recipient gets what the hub validated, never what arrived; a field outside the version is dropped and reported to the sender (`dropped`).
- **Customer contact details never travel.** A key called email/phone/tel/mobile/contact anywhere in a body is refused (`personal_contact`), and so is an email address or phone number typed into a note or a name. The shop reaches the customer through the order's messages.
- **The shipping address travels only with an order to be shipped** (`fulfilment: "ship"` needs `customer.ship_to`; a pickup with one is refused).
- **`order.placed` is signed** by the service (Ed25519, `SBHUB1` text over the envelope and the SHA-256 of the canonical body), and has to be sent exactly as it will be delivered (`not_normalized` otherwise). The hub verifies with the key the admin registered; `GET/POST /v2/hello` publish the keys (`keys`) so a shop can verify as well.
- **Files by signed address, replacing `art_urls`.** An address must be made when the file is fetched (it lasts minutes), so a message carries `{ file, size, sha256 }` and the file travels apart: `POST /v2/files/put` (sender: conversation, sha256, size, kind `art` | `mockup`, type for a mock-up, `to` for a service) → a 15-minute upload address that signs the length and the SHA-256, so the bucket itself refuses other bytes; `POST /v2/files/done` (the hub checks the size, removes a wrong file); `POST /v2/files/get` (only the uploader and the other side of the conversation; a 10-minute address). A message that names a file that is not ready is refused (`file_not_ready`). Limits: art 10 MB, mock-ups PNG or JPEG 2 MB. Files are deleted 30 days after they are ready (`SYNC_FILE_DAYS`); a delete the bucket refuses is retried by the next sweep. No bucket set up: `503 no_storage`.
- **Open orders** (`sync_orders`): ids only. A shop's cap (`maxOpen`, default 200) applies to open orders; an order finishes on `shipped`/`collected`/cancel, and a lapsed one closes as `expired`. `order.status`, `proof.*` and `order.cancel` are only accepted on a real order between that shop and that service (`409 no_such_order`); a finished order still takes late messages, a lapsed one does not (the shop never saw it).
- **Order of delivery:** a later `seq` is held back while an earlier one in the same conversation is still waiting; once both were handed over they come back together (in delivery order: the receiver applies them by `seq`).
- New setting: `SYNC_FILE_DAYS` (30). The hub's `hello` limits now include `art_bytes` and `preview_bytes`.
- **Not done:** the StitchShop and MakerFoundry clients (stitchbench#74, makerfoundry#1), the `stitch-contracts` repository does not exist so the fixtures live here for now and are written to be copied, and signature checking by the shop is up to the client.

## As built: shipping by the piece, the pick-up address and sales tax (2026-10-31)
Two owner decisions from MakerFoundry (SiteSentrix/makerfoundry PR #45, its `docs/shop-orders-contract.md`), both inside catalog v1 and order.placed v1 (no new types or versions):
- **Catalogue shipping**: `shipping.flat_cents` (one piece) plus the optional `per_extra_piece_cents` and `free_over_cents` (both default 0). `shop.address` (optional; line1, city, country and a postcode are needed when it is sent) is the pick-up address. The catalogue also carries the optional `shop.account` and a product's `cents` (the garment's own price; the method price breaks are then the decoration alone) and the method `dtg`, all passed on unchanged.
- **Sales tax is the marketplace's**: `totals.tax_cents` may be above 0, and the hub refuses a body whose totals don't add up (`totals_dont_add_up`): `goods + set-up + shipping + tax = paid`, and `shop_gets = paid - tax - fee - card_fee`.
- Addresses: the postcode is `postcode` (what MakerFoundry sends); `postal` is still read. `ship_to.name` is optional, and an empty `line2`, `region` or `tracking` is allowed and kept as sent (a signed order is delivered exactly as signed).
- **Not changed, and MakerFoundry's fixtures differ from it**: their examples still use the first draft's envelope (`order`, `from: "makerfoundry"`), `art_urls` and `preview.url`. The hub's envelope is `conversation` and `shop:<id>`/`service:<name>`, files are fetched by `/v2/files/get`, and a signed `order.placed` that carries fields outside the version (such as `art_urls`) is refused (`not_normalized`). Those need agreeing with MakerFoundry; they are not part of these two decisions.
