# Hub sync audit (#19, Phase 1)

**Status:** 2026-10-31. Report only: nothing was changed. Read from the code at `origin/main` (`2d0b883`) and StitchBench at `a5c5a4a` and later. The design that follows from it is [`hub-sync-design.md`](hub-sync-design.md).

## In one minute
- Programs **poll**. There is no push, webhook or websocket from the hub to any app.
- There is **one API version** (`/v1`), **no handshake**, and **no minimum version**. The hub does not know what a recipient understands.
- A message for an offline shop simply **waits** in `partner_messages`. The hub keeps no per-recipient position and no acknowledgements, never expires a message, and never tells the sender that one is waiting.
- The "routing only" promise **is not true in the code**: the hub stores the full message bodies (up to 4 MB each, with photos) for a year after delivery and up to three years if never pulled, and it keeps marketplace order contact details with no deletion. The draft privacy policy (section 5.4) already says the first part; the second is not said anywhere.

## 1. How apps connect and authenticate today

| Who | Proves itself with | Code |
|---|---|---|
| A program (StitchBench or StitchShop) | An **install key** (`Authorization: Bearer ...`), stored only as a SHA-256 (`installs.key_hash`). One install can host several companies; each call names its company with `X-Shop-Ref` / `shopRef` | `installByKey`, `member` router, `src/server.mjs` |
| A program joined with only a partner code | The same, but scope `partner` limits it to `/v1/partners/*` and a few account routes; scope `pending` is limited to finishing the account | `member.use("*")` in `src/server.mjs` |
| StitchFoundry sending a file | A **Foundry Account token** (`sfs_` + 64 hex). The hub asks the Foundry service whose it is on every request and keeps nothing of it. Only shops on the token's own account are reachable | `senderOf`, `src/inbox.mjs`; `accountOfToken`, `src/foundry.mjs` |
| The hub admin | One shared `ADMIN_TOKEN` bearer | `admin` router, `src/server.mjs` |
| A person at the hub's web pages | A cookie session (`hub_session`) after sign-in with the Foundry Account | `src/accounts.mjs` |

**Transport:** plain HTTPS request and answer. The hub never calls an app. Apps pull `GET /v1/changes`, `GET /v1/orders?since=N` and `GET /v1/partners/messages?since=N`, and push with `POST`. `last_seen_at` on the install is refreshed at most every five minutes.

**Limits that exist:** 300 changes an hour per install (or per company when `X-Shop-Ref` is sent), per-hour byte caps on partner messages (256 MB per shop, 128 MB per link side, 1 GB per install), 2 GB stored per install, 4 MB per partner message (intake photos travel inside it).

**Partner messages are signed end to end.** Each company has an Ed25519 key; the hub checks signatures against the key on file but cannot forge a message (`docs/partners.md`, "Signing"). The marketplace and the inbox are not signed; they rely on the key or token.

## 2. What happens when the recipient is offline or older

| Question | Today |
|---|---|
| Recipient's PC is off | The message is stored with a global `seq`. The recipient's program remembers its own cursor and asks `since=<cursor>` when it is back. Nothing is lost, nothing is pushed |
| How long may it wait? | Indefinitely. A message is deleted a year after creation once every shop it is for has been seen on the hub since (`install.last_seen_at`, a stand-in for "delivered"), and after three years regardless (`sweep`, `src/partners.mjs`) |
| Does the hub know it was delivered? | **No.** There is no ack and no per-recipient cursor on the hub. "Delivered" is inferred from the install being seen, which is not the same as the shop having read this message |
| Is the sender told? | **No**, unless the other program sends an application message back. The sender cannot see "waiting for shop" |
| Duplicates | Handled: `UNIQUE (link_id, from_side, id)` with the sender's own id, so a retried send is stored once; the receiving program also de-duplicates (`applyOnce`) |
| Order | Feed order is the global `seq`. Per job there is no sequence number of its own |
| Recipient on an older version | The hub does not know the version of an **install** (programs report `version` per **shop** at `POST /v1/shops/claim`; it is stored in `shops.version` and never used). Any message type that looks like `word.word` is accepted and delivered. An old program that does not know a type answers with `msg.rejected` (StitchBench `tellRejected`, limited to a few an hour) so the sender sees it under "Messages that didn't get through" |
| Version of the API | Only `/v1`. There is no `Deprecation` header, no minimum version, no "please update" answer |
| Sender offline | StitchBench keeps its own durable outbox (`partnerOutbox`) and resends with the same ids. StitchFoundry's sender lives in another repo; whether it queues is not known from here |
| Queue overflow | Only the byte caps above (a 429 to the sender). No per-recipient queue limit |

## 3. What the hub stores (the privacy check)

The issue asks to "confirm routing-only". It is not routing-only. What the code keeps:

| Data | Where | How long | Holds personal data? |
|---|---|---|---|
| Partner messages, full JSON body (`data`) | `partner_messages` | 1 year after delivery, 3 years if never pulled | **Yes**: customer first name and last initial, machine make, model and serial, the problem, photos of the machine (up to 4 MB), estimates and bills. The draft privacy policy 5.4 says so and says they are not end-to-end encrypted |
| Marketplace orders | `orders`, `order_events` | **No deletion in the code** | **Yes**: `ship_to`, `buyer_contact` and `seller_contact` (name, email, phone, address), notes. Not named in the privacy draft as kept without limit |
| StitchFoundry inbox rows | `inbox_items` | The file leaves the bucket when taken or after 30 days, but the **row stays forever** (`deleted_at` is set, nothing deletes it) | **Yes, a little**: `file_name`, `meta` (can carry `customer` and `job` text StitchFoundry sent), checksums |
| Installs, shops | `installs`, `shops` | Until deleted | Names, a contact, version, program |
| Accounts | `accounts` | Until deleted | Email, Foundry id |
| Assistant | counts only (draft policy 4) | Months | No text kept |

**Verdict:** the only honest sentence today is "the hub relays and keeps these messages so an offline shop can catch up, readable by whoever runs the hub". The design proposes keeping only an **audit stub** after delivery and blanking the inbox row and old order contacts; the retention periods are the owner's decision (see the design's open questions). Changing what the privacy policy says is legal wording and is the owner's.

## 4. Gaps against #19's goals

| Goal in the issue | Status |
|---|---|
| Version in URL or header, support window, deprecation, minimum version | Missing |
| Capability handshake | Missing |
| Per-recipient durable queue with ack, expiry, per-conversation order | Partly: durable and ordered (global `seq`), deduped; **no ack, expiry or per-conversation sequence** |
| "Delivered to hub, waiting for shop" for the sender; expiry notice | Missing |
| Client-side outbound queue | Present in StitchBench; not shared; absent for the other senders |
| Conflicts | No rule written down |
| Signed messages, per-install keys, replay protection | Signed partner messages and per-install keys exist; **no replay window or key rotation**; marketplace and inbox unsigned |
| Installs dashboard | Missing (`/admin` lists installs and counts only) |
