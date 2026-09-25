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
| `PUT /v1/xparts/:id` | same, replaces the whole entry | `Part` |
| `POST /v1/xparts/:id/merge` | `{ intoId, byName, note }` (the two are the same part) | the merged `Part` (`:id` becomes deleted) |
| `DELETE /v1/xparts/:id` / `POST /v1/xparts/:id/restore` | `{ byName, note }` | `Part` |
| `GET /v1/xparts/:id/history` | | `[{ id, action, snapshot: Part, byName, byShop, note, createdAt }]` newest first |
| `POST /v1/xparts/:id/revert` | `{ revisionId, byName }` | `Part` |

Each change stores a revision holding the whole entry (`action`: added, edited, merged, removed, restored, reverted).

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
| `DELETE /v1/listings/:id` | | `{ ok }` (status REMOVED; own only) |
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
