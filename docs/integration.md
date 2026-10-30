# Integration: StitchShop, StitchBench, StitchHub and StitchFoundry

How a shop's request becomes a tech's ticket, and how the status gets back. Exact shapes: [`contracts/`](../contracts/README.md). Written 2026-10-29, from the code as it is; where something does not exist yet it says so.

## The pieces
- **A repair shop** (a tech) runs StitchBench. **A sewing or quilt shop** runs StitchShop. Both are one code base; each joins StitchHub with an install key and tells it about its shops (`POST /v1/shops/claim`).
- **StitchHub** relays typed messages between the two shops of a **partner link**, keeps the parts marketplace, and holds the StitchFoundry inbox. It stores what it relays as JSON for a year.
- **Today the programs poll the hub** (`GET /v1/partners/messages?since=N`). There are no webhooks yet.

## The flow
1. **Link the shops.** One shop makes a code (`POST /v1/partners/invites`); the other redeems it (`/redeem`, or `/join` if it is not on the hub yet). Both agree on terms (`terms.propose`, `terms.accept`) and pin each other's signing key.
2. **A shop asks for a repair.** The sewing shop takes a machine in at its counter and sends **`job.new`** (customer first name and last initial, brand, model, serial, problem, photos). The job `id` is created here and never changes.
3. **The tech receives it.** At the repair shop `job.new` arrives as a ticket under the sewing shop's trade account. **There is no separate "accept" step today:** the ticket simply exists, and the tech works it. (A sewing shop can withdraw a job with `job.cancel`, and either shop can end the link.)
4. **Estimate.** When the tech needs the customer's OK the ticket goes to WAITING_CUSTOMER_OK and the repair shop sends **`job.update`** (status, lines, total, tax, commission). The sewing shop calls the customer and answers with **`job.reply`** (APPROVED or DECLINED, amount).
5. **Parts.**
   - From its own repair shop's catalog: the repair shop sends `catalog`; the sewing shop sends **`order.new`**; either side sends **`order.update`** (status, carrier, tracking).
   - From any shop on the marketplace (what a tech does to source a part): `POST /v1/orders` on a listing; the seller accepts, the buyer pays the seller directly, the seller ships with tracking, the buyer confirms receipt. Each step is `/v1/orders/:id/{accept,paid,ship,received,...}`.
6. **Completion and status sync.** Whenever the ticket changes the repair shop queues a **`job.update`**, so the sewing shop always sees status, bill, commission, paid and ready dates. The customer pays at the sewing shop's register (**`job.paid`**) and collects the machine (**`job.pickedup`**). A monthly statement nets repairs, consignment and orders (`settle.paid`).
7. **Ticket link.** The Hub job and the Bench ticket are tied by the same job `id` in both shops' records; `job.update` also carries the repair shop's `ticketNumber`.

## StitchFoundry to a shop
StitchFoundry (with the Foundry Account token) lists the account's shops (`GET /v1/inbox/shops`), announces a file and optional preview (`POST /v1/inbox/put`), uploads to the signed addresses, confirms (`/done`). The shop's program lists (`/inbox/list`), downloads (`/inbox/get`), makes a decoration in an order, and tells the hub (`/inbox/take`). StitchFoundry's sender is not built yet; the hub side is.

## Checking it
`npm run test:contract` (hub) runs the real hub through a listing, an order and a `job.new` and checks every answer against the schemas. Bench's `tests/unit/contract.test.ts` checks the `job.update` it builds, its sender rules and its readers against the same files.
