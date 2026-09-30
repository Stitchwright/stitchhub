# Parts cross-reference and marketplace (API contract)

Both are members-only (`Authorization: Bearer <install key>`), like the rest of `/v1`.

## Parts cross-reference

One **part** = one physical thing, known under one or more part numbers (per brand), fitting many machines.

```
Part {
  id, name, kind: "PART" | "ACCESSORY" | "SUPPLY", category (e.g. "Screw", "Presser foot", "Bobbin case"),
  specs (free text, e.g. "M3 x 6 mm pan head"), notes, deleted, updatedAt,
  numbers: [{ brand, number }],                               // each (brand, number) belongs to one part only
  fits:    [{ brand, model, modelKey, evidence, source }],     // evidence: "listed" (in that model's parts list),
                                                                //   "tested" (a tech fitted it), "maker" (maker says)
  sources: [{ id, vendor, url, priceCents, currency, note, byShop, updatedAt }]   // where to buy
}
```

- `modelKey` / number keys: upper-case letters and digits only (`BES-1216AC` → `BES1216AC`).
- Parts come to installs through `GET /v1/changes` as `xparts: Part[]` (full entries, `deleted` included), in
  the same `seq` order as links, posts and figures.

| Call | Body | Answer |
|---|---|---|
| `POST /v1/xparts` | `{ name, kind, category, specs, notes, numbers, fits, sources, byName, note }` | `Part`. **409** `{ error, partId }` if a number already belongs to another part |
| `GET /v1/xparts/:id` | | `Part` as it is now |
| `PUT /v1/xparts/:id` | same, replaces the whole entry; `baseUpdatedAt` (the `updatedAt` the edit started from) → **409** `{ error, partId }` when the part changed since | `Part` |
| `POST /v1/xparts/:id/merge` | `{ intoId, byName, note }` (the two are the same part) | the merged `Part` (`:id` becomes deleted) |
| `DELETE /v1/xparts/:id` / `POST /v1/xparts/:id/restore` | `{ byName, note }` | `Part` |
| `GET /v1/xparts/:id/history?limit=50&before=<id>` | | `[{ id, action, snapshot: Part, byName, byShop, note, createdAt }]` newest first: at most 50 (`limit`, up to 200) and about 8 MB; `X-History-More: 1` says older versions exist (ask again with `before` = the id of the oldest one you have) |
| `POST /v1/xparts/:id/revert` | `{ revisionId, byName }` | `Part` |

Each change stores a revision holding the whole entry (`action`: added, edited, merged, removed, restored, reverted).
A merge records which part it took in: rolling the merged part back to a version from before the merge makes that
part its own again, as it was just before (merges from before this was recorded: 409, roll back to a later version).

Admin: `POST /v1/admin/xparts/import` with a JSON array of
`{ name, kind, category, numbers, fits }` adds parts whose numbers aren't on the hub yet;
when some numbers already exist, the new numbers and fits are added to that existing part.
Answers `{ added, merged, skipped }`.

## Marketplace

Shops list parts and accessories; another shop orders; the **buyer pays the seller directly** (the seller's
payment instructions are on the invoice); the **seller enters the carrier and tracking**.

```
Listing {
  id, shopName, mine, title, description, kind, condition: "NEW" | "USED" | "REFURB",
  brand, partNumber, xpartId, fits (free text), priceCents, currency, qty,
  shippingCents (flat, null = quoted per order), shippingNote, shipsFrom,
  status: "ACTIVE" | "PAUSED" | "SOLD_OUT" | "REMOVED", photos: [{ id, sortOrder }], createdAt, updatedAt
}
```

Listings come through `GET /v1/changes` as `listings: Listing[]` (every member sees them; `mine` is true on the
install's own).

| Call | Body | Answer |
|---|---|---|
| `POST /v1/listings` | multipart: `listing` (JSON of the fields above) + `photo` files (≤ 8, ≤ 3 MB each) | `Listing` |
| `PUT /v1/listings/:id` | JSON: any of title, description, condition, priceCents, qty, shippingCents, shippingNote, shipsFrom, status (ACTIVE / PAUSED) | `Listing` (own only) |
| `DELETE /v1/listings/:id` | | `{ ok }` (status REMOVED; own only). Orders still REQUESTED on it are declined ("The seller took the listing down.") |
| `GET /v1/listing-photos/:id` | | the image |

### Orders (only the buyer and the seller see an order)

```
Order {
  id, number ("SH-000123"), role: "buyer" | "seller",
  listingId, item: { title, brand, partNumber, condition },
  sellerShop, buyerShop, qty, unitPriceCents, shippingCents, totalCents, currency,
  shipTo (text), buyerNote, buyerContact: { name, email, phone },
  sellerContact: { name, address, email, phone }, payInstructions,
  status: "REQUESTED" | "ACCEPTED" | "PAID" | "SHIPPED" | "RECEIVED" | "DECLINED" | "CANCELLED",
  buyerPaidNote, paidAt, carrier, tracking, trackingUrl, shippedAt, receivedAt, cancelReason,
  createdAt, updatedAt,
  events: [{ at, by: "buyer" | "seller", action, note }]
}
```

| Call | Who | Body | Result |
|---|---|---|---|
| `POST /v1/orders` | buyer | `{ listingId, qty, shipTo, buyerNote, buyerContact }` | `Order` REQUESTED (not your own listing; qty ≤ listing qty) |
| `GET /v1/orders?since=N` | both | | `{ orders: Order[], next }`: your orders changed after N |
| `POST /v1/orders/:id/accept` | seller | `{ shippingCents?, sellerContact, payInstructions }` | ACCEPTED: the invoice is issued; listing qty goes down (SOLD_OUT at 0) |
| `POST /v1/orders/:id/decline` | seller | `{ reason }` | DECLINED |
| `POST /v1/orders/:id/buyer-paid` | buyer | `{ note }` | stays ACCEPTED, `buyerPaidNote` set ("sent by PayPal") |
| `POST /v1/orders/:id/paid` | seller | `{}` | PAID |
| `POST /v1/orders/:id/ship` | seller | `{ carrier, tracking }` | SHIPPED (`trackingUrl` for USPS / UPS / FedEx / DHL) |
| `POST /v1/orders/:id/received` | buyer | `{}` | RECEIVED |
| `POST /v1/orders/:id/cancel` | either, before SHIPPED | `{ reason }` | CANCELLED (qty goes back to the listing if it was accepted) |
| `POST /v1/orders/:id/message` | either | `{ text }` | adds an event |

Every order action adds an event and bumps the order's `seq`. Wrong role or wrong status → 409 with a plain
message.

## Ratings

After an order, each side rates the other with 1–5 stars and an optional comment.

- Either side rates the other once the order is PAID, SHIPPED or RECEIVED; the buyer can also answer a seller who
  rated them on an order cancelled after. Rating again replaces the earlier rating (one per side per order).
- A shop's standing counts the latest rating from each shop that rated it (not one per order), and none from $0
  orders.
- Wrong status (or not your order) → 409 / 404 with a plain message; stars outside 1..5 → 400.
- Ratings from an install the hub admin blocked stop counting (and come back if it is unblocked).
- Each rating adds an order event (`action: "rated"`, `note: "4 stars"`) and bumps the order's `seq`. When the
  buyer rates the seller and the seller's average or count changes, every non-REMOVED listing of that seller is
  bumped too, so the new seller rating reaches every member through `/v1/changes` (rating again with the same stars
  sends nothing).

| Call | Who | Body | Answer |
|---|---|---|---|
| `POST /v1/orders/:id/rate` | buyer or seller | `{ stars, comment }` | `Order` |
| `GET /v1/reputation/:installId` | any member | | `{ asSeller: {avg, count}, asBuyer: {avg, count}, recent: [{ stars, comment, role, at }] }` |

- `avg` has one decimal, or is `null` with `count: 0`.
- `recent` is the last 10 ratings the shop **received**, without the raters' names. `role` is the rated shop's side
  of that order: `"seller"` means a buyer rated it as a seller.
- 404 for an unknown install.

Order gains:
```
ratings: { buyer: { stars, comment, at } | null,    // the buyer's rating of the seller
           seller: { stars, comment, at } | null },  // the seller's rating of the buyer
sellerReputation: { avg, count },                    // ratings the seller has received as a seller
buyerReputation:  { avg, count }                     // ratings the buyer has received as a buyer
```

Listing gains `sellerId` (the seller's install id, for `/v1/reputation`) and `sellerRating: { avg, count }`.

## Bulk sources

For a supplier scan: attach "where to buy" links to parts in bulk.

Admin `POST /v1/admin/xparts/sources/import` with a JSON array of
`{ number, brand?, vendor, url, priceCents?, currency?, note? }`.

- **Matching:** each row goes on the live (not removed) part owning that number, by number key. When `brand` is
  given, that brand's number is preferred; otherwise any brand's.
- **Keyed by (part, url):** a link already on the part gets its vendor, price, currency and note updated. No second
  copy is made.
- **Shop label:** sources written this way have `byShop: "StitchHub scan"`.
- **History:** each part whose sources changed gets its `seq` bumped and one revision (`action: "sources"`) holding
  the whole entry.
- **Answer:** `{ attached, updated, unmatched, unchanged }`.
  - `unmatched` counts rows whose number isn't on the hub, and rows missing a vendor or a valid http(s) link.
  - `unchanged` counts rows identical to what's already there; those parts aren't bumped.
- **Speed:** 20,000 rows take about 5 seconds.

## Parts usage

"Most used parts": each StitchBench sends how many of each part number it used per month, and every member can see
the community's totals. Only counts are stored: no customers, ticket ids or prices.

`POST /v1/usage` (member), body `{ month: "YYYY-MM", items: [{ number, brand, qty, tickets }] }`:
- `month` must be the current month (UTC) or up to 24 months back; anything else → 400.
- Up to 5,000 items. `qty` and `tickets` are whole numbers ≥ 0 (default 0); a missing number, or a negative or
  non-integer count → 400.
- Replaces everything this install sent for that month (delete + insert in one transaction). The same number sent
  twice in one request (matched by number key) is added up.
- Answer `{ ok: true, items }`, where `items` is the number of rows stored.

`GET /v1/usage/top?months=12&brand=<optional>&limit=200` (member):
```
{ from: "YYYY-MM", to: "YYYY-MM", shops,
  items: [{ numberKey, number, brand, qty, tickets, shops, xpartId, name }] }
```
- The window is the last `months` months including this one (1–36, default 12); `limit` 1–1000 (default 200).
- Grouped by number key; ordered by `shops` desc, then `qty` desc.
- `number` / `brand`: the spelling reported most often (by rows; ties go to the one with more used).
- `xpartId` / `name`: the cross-reference part that owns that number key (any brand), or null.
- `brand` filters case-insensitively on the reported brand; it applies to `shops` too.
- `shops` (top level): distinct shops (companies) with any usage in the window (and brand, if given).
- Blocked installs are left out of everything.
- **Small groups are not shown.** A part number is listed only when at least 3 shops used it (`minShops`, answered
  with the list; `USAGE_MIN_SHOPS` changes it for a small hub), and when fewer than that many shops reported in the
  window (for the brand asked for) the answer is `{ shops: 0, items: [] }`: with less, the totals would be one
  shop's own counts.

Export/import carries `part_usage`; the admin summary counts its rows (`usage`).

## Per company (a StitchBench holding several companies)

A hosted StitchBench serves several companies through one install key. Each call can say which company it is for,
as the partner channel does; installs that don't say act as the whole install, as before (`shopRef` '' on the hub).

- `POST /v1/listings` (`listing` JSON), `POST /v1/orders` and `POST /v1/posts` (`post` JSON) take `shopRef` (the
  company's id on that install) and `shopName`. The listing's `shopName`, the order's `sellerShop` / `buyerShop` and
  the note's `shopName` are then the company's. Listing, order and note carry `shopRef`, `sellerShopRef`,
  `buyerShopRef` (null when not given).
- Reputation is per (install, shopRef): `GET /v1/reputation/:installId?shopRef=`; listings' `sellerRating` and
  orders' reputations use it.
- Two companies on one install can't order from each other (409).
- `clientId` on a listing or an order: sent again (a lost answer), the hub returns the one already made.
- `PUT /v1/listings/:id` takes `expectedQty` with `qty`: 409 when orders changed the quantity since.
- `POST /v1/shops/claim` `{ shopRef }`: a one-company install names its company; what it listed, ordered, was rated
  for and shared without a `shopRef` becomes that company's.
- `POST /v1/usage` takes `shopRef` / `shopName` (per company; the install's earlier reports without one are dropped)
  and `{ shopRef, off: true }` (that company's reports are taken back). `shops` counts companies.
- A blocked install's listings show PAUSED to everyone and take no orders; its REQUESTED orders are declined.
- `GET /v1/changes` stops a page short of about 32 MB (a run of very large parts), with `more: true`.
