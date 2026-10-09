# StitchHub

The community server for **StitchBench**, a repair-shop app for sewing, embroidery and quilting machine technicians.

StitchBench runs in each shop, on the shop's own PC, and its customers, machines, tickets and prices stay there.
StitchHub is the one small shared server that the shops sync with. It holds only what they choose to share:

- **Manual links.** Where each service, parts or operator manual can be downloaded, with a status (working, dead,
  or blocks robots) that the hub rechecks every week. Anyone can fix a dead link. Every change is kept and can be
  rolled back. **The hub stores manuals only in the manual repository** (off until you switch it on, see below); everywhere
  else it holds links to where they're published.
- **Tech notes.** An issue found, how it was fixed, or a tip, per brand and model, with photos (wiring and
  connectors, inside the machine, parts). Customer names and serial numbers are never sent.
- **Figure snapshots.** Small crops of manual pages that show a timing or adjustment, so a tech on a phone can see
  them.
- **Parts cross-reference.** One entry per physical part: every number it's sold under (per brand), the machines
  it fits and how that's known, and where to buy it. Anyone can fix an entry; every change can be rolled back.
- **Marketplace.** Shops list parts and accessories for other shops. Orders are private to the buyer and seller.
- **Data sets.** Files the hub admin publishes to every shop, for example updated factory specs.
- **Partner links.** A private channel between one repair shop and one sewing or quilt shop that works with it
  (StitchShop): machines taken in for repair and their status, estimates and approvals, parts orders, consignment
  stock and sales, and monthly settlements. Only those two shops receive them. See
  [docs/partners.md](docs/partners.md).

This repository is the server code only. Every hub's data lives in its own PostgreSQL database and is never part
of this repository.

## Joining a hub

**Membership is free.** The hub admin gives members the hub address and a **join key**. In StitchBench, open
**Settings → Community hub**, enter both, and press Join. (A shop can also join with no key by starting its StitchHub
account from Settings → Account; see Shop owner accounts below.)
The install gets its own key. The admin can block any install, and can change the join key for new members
without affecting shops that already joined.

## Running a hub

### Railway (about $5/month)
1. Fork this repository, then in Railway choose **New project → Deploy from GitHub repo** and pick your fork.
2. Add a **PostgreSQL** database to the project. Railway sets `DATABASE_URL` for you.
3. Set the variables `ADMIN_TOKEN` (a long random secret) and `JOIN_KEY`, plus `HUB_NAME` if you like.
4. Open `https://<your-app>.up.railway.app/admin` and sign in with the admin token.

### Your own PC, NAS or server (Docker)
```
cp .env.example .env        # set ADMIN_TOKEN and JOIN_KEY
docker compose up -d        # hub on port 8080, with its own PostgreSQL
```
To let shops reach it from outside your network, put it behind a tunnel or reverse proxy with HTTPS (for example
Cloudflare Tunnel or Tailscale Funnel), and set `TRUST_PROXY=true` in `.env` so the limits on joining see each shop's
own address. (On Railway that's already the default.)

### Without Docker
Node 20.12+ (22 recommended) and PostgreSQL: `npm ci`, copy `.env.example` to `.env` and fill it in (or set the same
variables in the environment; a variable that is set wins over the file), `npm start`. The database tables are
created on first start.

### One hub process only
Run **exactly one** hub process per database; the hub now enforces it: at start it takes a lock in the database, and a
second process answers 503 ("The hub is restarting") to writes and feeds, while health checks and plain reads go on,
until the first one stops (a deploy's overlap is a few seconds of that). The hub keeps track of the writes in progress in its own memory so
that a shop never skips a change in its sync, and a second process on the same database (Railway's replicas set
above 1, `docker compose up --scale hub=2`, a manual `npm start` beside the container) doesn't know about them.
`railway.json` pins Railway to one replica. (A deploy briefly runs the old and the new hub side by side; the old one
finishes the requests it is on before it stops.) Starting several hubs on one database at the same moment is safe for
the migrations: they take turns.

## Moving or rebuilding a hub

The **/admin** page exports everything to one `.ndjson.gz` file, and imports that file into another StitchHub. That
includes members and their keys, the join key, links with their history, notes, photos, figures, data sets, the
parts cross-reference with its history, marketplace listings and orders, shop owners' accounts and shops (with each
time an account accepted the terms), and billing (each shop's subscription, the webhook events handled, every license
key issued). The export is one snapshot, so it can be
taken while shops are using the hub. Download an export now and then and keep it somewhere safe.

**Keep the hub's address when you move it.** Point the same address (your own domain, for example
`hub.example.com`) at the new server: members' StitchBench installs carry on with their keys and their place, and
nothing changes for them. StitchBench can't switch a joined install to a new address yet. If the address changes,
each shop has to join again at the new one and becomes a new member there; its listings, orders, notes and partner
links stay with its old membership. On Railway, add your own domain before members join, so a move never changes it.

Import into a new, empty hub. Restoring an older export works too: installs that had synced past it start over and
receive everything on the hub again, so nothing new is missed (changes made after that export are gone from the hub;
each install keeps its own copy). Importing into a hub that's already in use adds the file's rows as new changes, so
every install receives them, and a link whose address is already there is merged into that one. If an import fails,
nothing is imported and the admin page says which line of the file was refused. Imports, bulk loads and data sets can
be up to 1 GB; set `ADMIN_UPLOAD_MB` for more.

If a hub disappears without an export, each StitchBench install still has its own synced copy of the links and
notes, so nobody loses what they can already see.

## Discord

On the /admin page, paste a Discord channel webhook. The hub then posts new notes, link fixes, new marketplace
listings and new members to that channel. Orders are never posted.

## Parts cross-reference and marketplace

**Cross-reference.** A part is one physical thing: a screw, a presser foot, a bobbin case. It has:
- every number it's sold under, per brand. A (brand, number) pair belongs to one part only; adding it again answers
  409 with the existing part's id.
- the machines it fits, each marked `listed` (it's in that model's parts list), `tested` (a tech fitted it) or
  `maker` (the manufacturer says so).
- where to buy it.

When two entries turn out to be the same part, **merge** moves everything into one. Every change keeps the whole
entry, so any version can be restored. The hub admin can bulk-load parts (for example from parts lists) with
`POST /v1/admin/xparts/import`. An entry whose numbers are already on the hub adds its new numbers and fits to
that part.

**Marketplace.** A shop lists a part or accessory with its price, quantity, condition, who made it (genuine,
compatible or 3D printed), photos, and shipping (a flat rate, or quoted per order). Another shop orders it:
1. The seller accepts, which issues the invoice with the seller's payment instructions and takes the quantity off
   the listing.
2. The **buyer pays the seller directly**, for example by PayPal, Zelle or check, and can mark it sent.
3. The seller marks it paid.
4. The seller ships and enters the carrier and tracking number. The buyer gets a tracking link for USPS, UPS,
   FedEx and DHL.
5. The buyer marks it received.

Either side can cancel before it ships, and the quantity goes back on the listing. Orders are visible only to the
buyer and the seller. The full contract is in [docs/parts-and-marketplace.md](docs/parts-and-marketplace.md).

**Ratings.** After an order each side rates the other, 1–5 stars with an optional comment:
- The buyer rates the seller once it has shipped; the seller rates the buyer once the buyer has said they paid
  ("Payment sent") or the order has shipped: marking it paid alone isn't enough. Rating again replaces the earlier
  one.
- Every listing shows its seller's average, and orders show both shops' reputations.
- `GET /v1/reputation/:installId` gives a shop's averages as seller and as buyer, and its last 10 ratings (without
  the raters' names).

**Where to buy, in bulk.** A supplier scan can attach buying links to parts with
`POST /v1/admin/xparts/sources/import`:
- Each row names a part number, the vendor, the link and optionally a price.
- A link already on the part is updated rather than copied. Sources added this way show as "StitchHub scan".

**Most used parts.** Each StitchBench sends how many of each part number it used per month: counts only, no
customers, tickets or prices. Sending a month again replaces it. Every member can see the community's top parts over
the last 1–36 months (optionally for one brand): quantity used, on how many tickets, and by how many shops, with the
cross-reference part when there is one. That's the list to stock from.

## Partner shops (StitchShop)
A repair shop and a sewing or quilt shop connect with a one-time **partner code** (12 letters and digits, good for 14
days). The shop that makes the code offers its terms (commission on repairs, consignment split and so on); the other
shop enters the code in StitchBench → Partner shops. A sewing shop that isn't a community member joins with the
partner code alone: its install can then use the partner channel and nothing else (it can join the community later
with the join key, keeping its partner links).

What goes through the hub is only what the two shops need: the sewing shop's tag number, the customer's first name
and last initial, the machine and the problem, intake photos, the repair bill and status, orders, consignment counts
and sales, and settlements. Customer phone numbers and addresses stay in the sewing shop. Messages are kept for a
year so a shop that was offline catches up. They are not encrypted or signed: the hub admin can read them in the
database, like everything else on the hub, and could send one as either shop.

## Shop hops
Paper passports stamped at each shop, on the hub (`src/hops.mjs`, migration 031; StitchBench's
`shop-features-round-2-design.md` 4.6). An **organizing shop** starts a hop in the program (name, first and last day,
the prize rule: stamps from **all** the shops, or from **any N**) and hands each other shop a one-use **hop code** (12
letters and digits, 14 days); a shop takes part only by entering one (its choice). Starting or joining pins the
company's partner key (Ed25519). **Shoppers** sign up on the hub's public page `/hop/<slug>` (the hop, its dates and
shops; name, email or phone, and a tick "share my name, email and phone with each shop I visit", **off by default**) and
land on their **passport**, `/p/<code>`: the code `HOP-XXXX-XXXX` in big type, a QR code of it (made on the hub,
`src/qr.mjs`), the stamps so far, and a printable card (`?print=1`). One passport per email or phone per hop; 20
sign-ups an hour from one address; 60 unknown passport codes an hour from one address. Large plain text, no scripts.

At the counter the program stamps the passport and sends the stamp signed with the company's key over
`SBHS1 \n hop \n company \n stamp id \n passport \n time \n sha256 of the canonical JSON of those five` (the program's
`src/lib/hops/hop-math.ts` is the other copy); the hub refuses a key other than the pinned one or a signature that
doesn't check out, keeps one stamp per passport per shop (the same one again answers with its first numbers), and
answers "stamp 4 of 10". A shop gets the shopper's name and contact with the stamp **only if she ticked share**; the
organizer's list of completed passports names only those who shared (the rest by their code), and its drawing records
each draw ("she's not here" marks one not present). What a shopper typed is all the hub keeps of her. The hop tables
go with a company's move and in the hub's export.

Routes (install key, the company in `X-Shop-Ref`; a partner-only install may use them): `GET /v1/hops` → `{ hops: [{ id,
name, startsOn, endsOn, rule, shops, role, status, slug }] }`; `POST /v1/hops { name, startsOn, endsOn, rule: "all" |
"any:N", publicKey }` → `{ hop }`; `POST /v1/hops/:id/invite-code` (organizer) → `{ code, expiresAt }`; `POST
/v1/hops/join { code, publicKey }` → `{ hop }`; `POST /v1/hops/:id/leave` → `{ ok }` (not the organizer); `POST
/v1/hops/:id/stamps { stampId, passport, at, sig: { v: 1, pub, sig } }` → `{ stampNo, of, complete, shopper: { name,
email, phone } | null }` (404 `{ error, code: "no_passport" }` for a passport not in the hop); `GET
/v1/hops/:id/completed` (organizer) → `{ passports, stamps, completed: [{ passport, name }], draws }`; `POST
/v1/hops/:id/draws { passport, prize }` (organizer, a completed passport) → `{ draw }`; `PATCH /v1/hops/:id/draws/:drawId
{ present }` → `{ draw }`. Test: `node test/hops.mjs` (`npm run test:hops`, a scratch database of its own).

## Help, ideas, ratings and error alerts
The programs' Help button (and the errors they catch on their own) send items here; the owner reads them on the admin
page's **Help & ideas** section (`src/feedback.mjs`, migration 034, `StitchBench/docs/plans/help-feedback-design.md`).

- `POST /v1/feedback` (install key, the company in `X-Shop-Ref`; a pending install and a partner-only install may send
  too). Multipart: `item` (JSON `{ kind: "help" | "idea" | "rating" | "error", text?, stars?, quoteOk?, replyTo?,
  fingerprint?, day?, count?, context: { program, version, path, role, desktop, userAgent, screen }, error?: { message,
  stack, digest, action } }`) and an optional `picture` (a JPEG, `image/jpeg`, checked by its first bytes, 1 MB at
  most); or the same item as a plain JSON body. Answers `{ ok, id }`. help and idea need `text` (4,000 characters at
  most), rating needs `stars` 1 to 5, error needs `error.message` (stack 8,000); every string is capped and unknown
  fields are dropped. The company's name is the one the hub already has for that `X-Shop-Ref` on that install, else
  `context.shopName`, else the install's name. An error is one row per (install, company, fingerprint, day): sending it
  again adds `count`. Limits: 60 items an hour per company (600 per install, since a hosted program serves many
  companies) and 200 errors a day per install; over, 429 and the program keeps the item and tries later. 413 for a
  picture over 1 MB, 415 for one that isn't a JPEG.
- Admin (Bearer admin token): `GET /v1/admin/feedback?status=new|seen|done&kind=&shop=<install id>/<shop ref>&limit=`
  → `{ items, more, counts, shops }`; `POST /v1/admin/feedback/:id { status?, note? }`;
  `GET /v1/admin/feedback/:id/picture` (the JPEG); `POST /v1/admin/feedback-sweep` (the 90-day picture clean-up, also run
  every 6 hours).
- `FEEDBACK_EMAIL` (optional): the owner's address. Each help, idea and rating is mailed at once (subject "Help: <shop> –
  first 60 characters", everything in the body, a link to `/admin`); new errors go in one digest email at most every hour
  ("3 new errors from 2 shops"; the wait is kept in memory, so a restart sends the next one at once). Unset: no email,
  the admin page only. Mail goes through `src/mail.mjs` (needs `SMTP_URL` and `MAIL_FROM`; `MAIL_DEV_LOG=true` prints it on
  a test hub).
- Retention: items are kept (they are the owner's product feedback); a picture is deleted 90 days after the item is
  marked done. **Feedback is not part of the hub's export or a company's move**: a rebuilt hub starts with an empty Help
  & ideas list.
- The admin page shows what shops typed as text only, never as HTML.
- Test: `node test/feedback.mjs` (`npm run test:feedback`, a scratch database of its own, mail through `MAIL_DEV_LOG`).

## Shop owner accounts
A shop owner can have an **account** on the hub: an email address and a password, confirmed by email, with a password
reset by email. The account owns one or more **hub shops** (a company on an install; a hosted StitchBench holds several).
The install key stays what the program uses on every request; the account is what a person uses on the hub's own pages
at `/account`. Three ways in:
1. **From the program** (the usual way): Settings → Account starts the account for the shop; the hub mails a link to
   set a password. A program that is on no hub yet joins this way too, with no join key: its install is `pending` (it
   can use `/v1/shops/*`, `/v1/accounts/*`, `/v1/me` and `/v1/upgrade`) and becomes a member when the email is confirmed.
2. **A link code**: the program shows a 10-character code (good for 15 minutes); the owner signs in on the hub and types
   it under "Connect a shop".
3. **On the hub first**: `/account` → Create an account, confirm by email, then connect a shop with a code.

Every company tells the hub about itself at each sync (`POST /v1/shops/claim`) and learns its **standing** (see
Billing below): a 30-day trial from its first claim, a subscription, free while partnered, free with the admin's
compliments (the /admin page, Shops → Comp), or lapsed. The answer carries the **license key** the program should hold for
itself (module `base`), signed by the hub; the key, not the words, is what the program enforces.

Passwords are hashed with scrypt; links, codes and session ids are stored as SHA-256 hashes; sessions are HttpOnly
cookies for 30 days; a password reset signs every browser out. Sign-ups are limited to 10 an hour per address and wrong
sign-ins to 20 an hour per address and 10 an hour per account (after that only the right password gets in, up to 100
tries an hour; a stranger can't lock the owner out), 20,000 an hour for the whole hub. A sign-up on an address that has an
account changes nothing but mails the owner a link to set the password; on an account not yet confirmed it also takes off
the password and confirm links (a stranger's sign-up may have set them).

For the emails the hub needs three variables: `HUB_URL` (its own public address, for the links; on Railway the public
domain is used when it is empty), `SMTP_URL` (`smtps://user:pass@host:465`, or `smtp://…:587` for STARTTLS) and
`MAIL_FROM`. Without them the account routes answer 503 and the rest of the hub runs as before. A test hub on this
computer can set `MAIL_DEV_LOG=true` instead: each email is printed to the hub's log (links included) rather than sent.
Never set that on a real hub.

## Billing
Two plans per shop (decided 3 Oct 2026), the same program and every feature on both, for StitchBench on Windows,
StitchShop on Windows and every company on a hosted instance, through Stripe Billing on the hub:

| plan | monthly | yearly | logins |
|---|---|---|---|
| **Solo** | $25 | $250 | up to 2 people signed in (active logins) |
| **Shop** | $45 | $450 | everyone |
| Solo, founding shop | $15 | $150 | up to 2 |
| Shop, founding shop | $30 | $300 | everyone |

**Founding shops** are the first 25 accounts the admin marks on /admin (Accounts → "Founding shop"; the page shows how
many of the 25 are used and refuses a 26th). A founding account gets the founding price of whichever plan it subscribes
to or switches to. The mark stays while the account's subscriptions run without a gap: when the last one stops (its paid
period ends, or a payment is refunded or disputed) the hub writes down when the gap started (`accounts.founding_gap_since`);
an account that subscribes again within 60 days keeps the founding prices, and after 60 days the mark goes by itself
(`founding_lost_at`) and its place is free again (a chargeback the shop later wins gives back a mark its gap cost, while a
place is free). A subscription already on a founding price keeps it in Stripe; taking
the mark off by hand changes only what the account is offered next. A trial, a comp and a partnered (waived) shop are
Shop, so a shop can try the program with its staff.

The owner subscribes on `/account` → Your shops → Solo or Shop, yearly or monthly (Stripe Checkout, a card is always
taken: the hub runs the trial itself). **Subscribing during the 30-day trial** charges nothing until the trial ends: when
more than about 48 hours of it are left (Stripe's minimum), Checkout gets `subscription_data.trial_end` = the trial's end,
so the subscription starts on Stripe's trial (`trialing`), the shop shows as subscribed with full use, and the first charge
falls the day the trial ends (the account page says which day, before and after subscribing); with less left it is
charged at once. The owner moves between the plans with **Switch to Shop / Switch to Solo** on the same page
(the subscription item moves to the other plan's price, same interval, founding if the account is, with Stripe's
proration). **Up to Shop** charges the difference for the rest of the period at once (`always_invoice`), and the change
waits for that payment (`payment_behavior: pending_if_incomplete`): the hub reads the plan from the price, so the Shop
key is signed only once Stripe has the difference paid, usually at once; a declined card leaves the shop on Solo (the
page says so, no dunning mail) until the invoice is paid. **Down to Solo** credits the difference on the next invoice
and takes effect at once. The owner changes the card, cancels or downloads invoices under Manage billing (Stripe's
Customer Portal). The hub never sees a card number. A shop has one subscription on the hub: when a Checkout completes
while an older subscription for the same shop hasn't ended (a past_due one Stripe still retries, a second Checkout),
the older one is cancelled in Stripe at once (no refund: if both were paid for the same days the log says to refund the
older one by hand), and a late event for an older subscription (its update, a retry, a payment, its cancellation) is
logged and ignored, never written over the shop's current one.

**The Customer Portal** (Stripe dashboard → Settings → Billing → Customer portal): turn on "Customers can switch plans",
add the one product with its four regular prices (Solo and Shop, monthly and yearly; add the founding prices too if
founding shops may switch there), choose to prorate and to **invoice the proration immediately** (the API's
`always_invoice`; with the default, invoiced at the next renewal, a switch up to Shop made in the portal would get every
login for up to a year before paying the difference; or leave "Customers can switch plans" off so every switch goes
through the hub's Switch), allow "Update payment methods", "Cancel subscriptions" (at the end of the billing period)
and "Invoice history". Leave quantity changes off: a plan is per shop, not per seat. Whatever the portal switches to,
the webhook re-reads the subscription and the hub takes its plan from the price.

The **login plan** reaches the program with the standing: `plan` ("solo" | "shop"), `interval` ("monthly" | "yearly" for
a subscription, else null) and `founding`, and inside the signed key as `l` (and `fs: true` for a founding price), so it
holds offline. A program limits logins only on a key that says `l: "solo"`; a key without `l` (an older hub, an emailed
key, the hosted administrator's switch) or no key at all is no limit. A shop already over two when it moves to Solo is
never locked out: the program shows the owner a notice and refuses only a third login added or restored. A lapsed shop
keeps its last plan. Stripe tells the
hub what happened through the webhook `POST /v1/stripe`: the signature is checked first, each event is handled once (its
id is kept in `stripe_events`; a replay is a 200 that does nothing) and the event's own copy of the object is never
trusted (the hub re-reads the subscription, invoice or charge from Stripe by id).

A shop's **standing**, worked out at every claim:

| standing | when | the key |
|---|---|---|
| `trial` | 30 days from the shop's first claim | plan `t`, from the first claim through the trial's last day; `l: "shop"` |
| `active` | Stripe says the subscription is paid (`active`), or on its trial (`trialing`: subscribed inside the hub's trial, the first charge on the trial's last day), or it is cancelled but paid through the period end | plan `m` or `y`, through the current period end (the trial's last day while `trialing`); `l` the subscription's plan |
| `past_due` | the last payment failed; 14 days' grace past the period end while Stripe retries | the same key (it already carries 14 days of grace) |
| `waived` | a **retail** shop (StitchShop, `kind: "retail"`) on the retail side of an `ACTIVE` partner link while **the real-partnership rule** holds (below). A repair shop is never waived, and a `both` shop counts as repair and pays. In its grace period the standing is still `waived`, `lastDay` is the grace's end and the message is the friendly notice | plan `w`, a 35-day key signed fresh each day the waiver holds (in a grace, ending with the grace), so an offline install works about a month past the end of its partnership and no longer |
| `comped` | the admin's "Comp": free through a day, or for good (`2099-12-31`) | plan `c` through that day |
| `lapsed` | the trial ended; the subscription ended or its grace ran out; a refund or chargeback (but see below: a full refund of the first payment inside the trial, a chargeback won); the admin's "Lapse now"; a waiver that ended more than 35 days ago | a key that is over: the trial's or period's own (grace from its last day); after a refund, a chargeback or "Lapse now", a one-day key with no grace, so the program is read-only from its next sync |

**The real-partnership rule** (owner decided 5 Oct 2026; `billing.mjs` `waiverRule`). A partnered quilt shop's free plan (the waiver: the
Shop plan, base only; add-ons are always paid, the hub signs the waiver's key for `base` alone) holds while BOTH (1) its repair partner is a
paying subscriber (`active` by a subscription: paid, or trialing with a card; not a free trial without a card, a comp, past_due, lapsed,
or itself waived) and (2) a repair passed between the two shops in the last calendar quarter or the current one. The hub measures (2)
from what it already relays: the distinct `job.new` messages the quilt shop sent over the link plus finished pickup runs (`pickup.done`)
in `partner_messages`, since the first day of last quarter (UTC); nothing new is reported by the programs. A link is exempt from (2) for
its first 90 days, so a new partnership is waived at once. When (1) or (2) stops, `waiver_grace` (migration 022) records the first day the
hub found the rule broken for that link and a 30-day grace runs: the shop is still `waived`, its key ends with the grace and the program
shows "Your free StitchShop comes with your repair partnership with X. Subscribe to keep going after <date>; nothing is locked or
lost." If the rule holds again inside the grace (a repair passes, the partner subscribes) the row is deleted and nothing changes. After
the grace the shop falls back to its normal standing by the existing rules (its trial if unused, else lapsed: read-only, never deleted);
if the rule holds again later it is waived again. The grace starts when the hub first notices, which is at the shop's or the admin page's
next look, never later than the next daily claim. The admin page lists, for each waived shop, its partner, the partner's standing, the
repairs counted, the last repair date and the grace end. A partner message isn't signed end to end yet (handoff item L134), so a quilt
shop could fake `job.new` messages to keep its waiver; the hub's per-hour limits apply, and the review of partnered shops' support hours
and add-on uptake (six months in) is the check.

Rules of thumb: a key is re-signed only when the plan, the login plan or last day changes (a renewal, a switch, a new comp date), and the current
key is sent at every claim so a program that lost it gets it back; a lapsed shop's key is never cut shorter than the one
it holds (a comp that ran out keeps its 14 days of grace), but a key the program believes is still live when the standing
has ended (a comp taken away) is replaced by one ending today, so the grace runs from today; `revokeKeyIds` names the
keys of a refunded or charged-back period (and of a "Lapse now") for the program to drop. A refund or chargeback lapses
the shop at once, with two exceptions (below). **A full refund also cancels the subscription in Stripe at once** (no
proration, nothing refunded beyond what was), so it can't charge the shop again; a partial refund doesn't. A paid
invoice makes a refunded or charged-back period good again only when its own payment stands (not refunded, not
disputed) and it is newer than the one taken back: a late or retried `invoice.paid` for that period changes nothing. Only a
period's own charge (an invoice for `subscription_create` or `subscription_cycle`) takes the period back: refunding the
difference charged for a plan switch leaves the period and the subscription alone. The Assistant's own subscription is
treated the same way (its keys revoked at once, the proxy refuses them, cancelled on a full refund, good again on a later
payment that stands or a won chargeback), and a refunded or charged-back top-up takes its calls back (a partial refund, its
share, rounded up). **A full refund of the subscription's first payment while the trial's original end
is still ahead** puts the shop back on its trial until that day (the trial key comes back, the paid period's key is still
named for removal; after that day it is a trial that ended); a partial refund, a refund of a later payment or a chargeback
inside the trial still lapses it. **A chargeback the shop wins** (`charge.dispute.closed` with status `won`, the dispute
re-read from Stripe) is undone: the period counts again, the subscription is re-read, the admin's dispute flag goes, a
founding mark the dispute's gap cost comes back while a place is free, the next sync gets a fresh key (the revoked ones
stay revoked), and the hub's log says so; a won one whose period was also refunded is left as it is. **A lost
chargeback** stands and cancels the subscription in Stripe; one the hub never acted on (an inquiry it held, a dispute it
never saw open) lapses the shop then. **A card-company inquiry** (a dispute whose status starts with `warning_`: a
retrieval request, no money taken yet) doesn't lock the shop: the hub records it on the subscription (several can be
open, one per charge), the admin page shows it as INQUIRY and the log says so, and the shop keeps full use. Only a real
chargeback (`needs_response`, `under_review`) lapses the shop, whether it opens as one or an inquiry escalates into one
(`charge.dispute.updated` with the new status, for any open inquiry); an inquiry that closes as `warning_closed` just
leaves the list, since nothing was taken. The hub keeps the disputes it has acted on, so a late or repeated dispute
event (evidence submitted, a review, a `created` or `updated` for a dispute already won, one ending in a refund) never
lapses the shop a second time. When a subscription ends while the trial still runs, the shop is back on
its trial. A partnered shop that also pays is told it can cancel and stay free; the hub never cancels for it. Dunning mail
goes once per period: when a payment fails, 7 days into the grace, the day the shop lapses, and 30 days before a yearly
renewal (Stripe sends the receipts).

Variables: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` (the endpoint `https://<hub>/v1/stripe` with these ten events:
`checkout.session.completed`, `customer.subscription.created|updated|deleted`, `invoice.paid`,
`invoice.payment_failed`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.updated`,
`charge.dispute.closed`), the prices (recurring prices made in the Stripe
dashboard, one product): `STRIPE_PRICE_SOLO_MONTHLY`, `STRIPE_PRICE_SOLO_YEARLY`, `STRIPE_PRICE_SHOP_MONTHLY`,
`STRIPE_PRICE_SHOP_YEARLY`, and for founding shops `STRIPE_PRICE_SOLO_MONTHLY_FOUNDING`,
`STRIPE_PRICE_SOLO_YEARLY_FOUNDING`, `STRIPE_PRICE_SHOP_MONTHLY_FOUNDING`, `STRIPE_PRICE_SHOP_YEARLY_FOUNDING`, and
`STRIPE_API_BASE` (the mock, for a test hub). **Several prices count as one plan**: each price variable takes a
comma-separated list of price ids; the first is the one new subscriptions get, the rest are older prices that still count
as that plan. A price rise is a new price put in front (`STRIPE_PRICE_SHOP_MONTHLY=price_new,price_old`): new shops pay
the new one, existing subscriptions stay on theirs (raise them in Stripe when their 12 months are up). An id in two
variables is refused (the admin page says which). A subscription on a price in none of them counts as **Shop** and is
logged (`stripe: subscription … is on a price the hub doesn't know`), so a forgotten variable never holds a paying shop
to two logins. The single price from before the plans (`STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`) is still
recognised, as Shop, for a subscription already on it, and is never sold again. Missing founding prices don't close
billing (the admin page lists them; a founding shop is told to ask). The account page shows each plan's price as Stripe
has it (read once an hour). **With the secret key, the webhook secret or any of the four regular prices unset,
subscriptions are closed**: the account page says so, a trial that ended
changes nothing ("Subscriptions aren't open yet"), and no trial or waiver key is signed, so no shop can go read-only for
want of a way to pay; comps still get their key. Keys are signed with `HUB_LICENSE_KID` and `HUB_LICENSE_KEY` (the
Ed25519 private key, PEM base64, from `npm run license:keygen -- --kid hub1 --hub` in the StitchBench repo; the hub prints
the public half at start, and the matching line must be in `license-keys.ts` in both programs before the hub signs).
Without them no key is signed and standing is only words. Every key issued is written in `license_issues` (the
retirement allow list of a kid is made from it; `GET /v1/admin/shops/:id/keys` lists a shop's).

## Hosted shops and password resets
**Start a hosted shop.** A verified account can start a StitchShop or StitchBench on the hosted service from
`/account/shops`. The hub calls that service's `POST /api/platform/companies` (`HOSTED_STITCHSHOP_URL` or
`HOSTED_STITCHBENCH_URL`, the site's https address only, with `Authorization: Bearer PLATFORM_API_TOKEN`, 32+ random
characters, the same variable on the service); the service makes the company with the account's email as its owner
login and answers its id, its own install on this hub and a link for the owner to choose a password (24 hours, one use).
The hub ties the company to the account on that install, so the company's first claim finds it under the account and its
trial runs from then, and shows the link once (it is never stored or logged). One start per account per 10 minutes; each
is written in `hosted_starts`. Unset variables: the option isn't shown. A service that isn't on this hub still makes
the shop; its owner connects it with a link code.

**Reset the owner's password on the shop PC.** The Windows program can allow a reset from the account (its owner ticks
it in Settings → Account on the PC; the program says so in every claim, `resetOptIn`, and the hub keeps it in
`shops.reset_opt_in`: the hub can never switch it on). While it is on, `/account/shops` offers "Reset the owner's
password on <shop>": the hub signs a grant with its own key (`HUB_LICENSE_KEY`, over its own context so it can never pass
as a license key) for that company, that install and the account's email, good for an hour, and the newest request
replaces any older one. The program fetches it at its sync, checks everything again, and shows "StitchHub asks to reset
…: Allow / Refuse" in its own window on the PC only; Allow shows the new password there, once. Its answer comes back
(`done`) and the grant is spent. Turning the option off withdraws a request still waiting. Three requests an hour per shop.

## The Assistant proxy

StitchBench's Assistant add-on (drafts, likely causes, plate reading, manual questions) calls the model through the hub, so the
Anthropic key exists in one place. Set `ANTHROPIC_API_KEY` on the hub's service only (never on a shop's PC, the installer or
the hosted StitchBench / StitchShop services). `POST /v1/assistant` takes `{ shopRef, tz, feature, model: draft | suggest | read
| manuals, system, messages, maxTokens, image?, key }` with the install key; `key` is the company's `assistant` license key text,
checked against `ASSISTANT_PUBLIC_KEYS` (JSON, `{"k1":"<x from license:keygen>"}`) and the hub's own signing key. A key holds
for one company only: one the hub signed (under its current kid or an older one) must be on record for that company on
that install (and not revoked); one of the owner's own signer belongs to the first install and company that made a real call
with it from an install that has claimed that company (a look at the usage binds nothing), and the admin clears that with
`POST /v1/admin/assistant/unbind { keyId, kid }` or `{ installId, shopRef }`. 300 calls a
month per company (the month turns in `tz`), top-ups of 300 from `POST /v1/admin/assistant/topup { installId, shopRef }`, an
admin comp from `POST /v1/admin/assistant/comp { installId, shopRef, until }`, and 20 free plate reads a month without the
module (the read model, or the suggest model the plate reader retries an unsure read with, with a photo and a short
prompt, for a company claimed on that install; at most `ASSISTANT_FREE_READS_PER_INSTALL`, 100, a month for an install's
companies that don't pay their own way together (a company with a running subscription or a comp, such as a hosted
service's paying companies, has only its own 20), and `ASSISTANT_FREE_DAILY`, 500, in 24 hours on the whole hub; reads sent
at once are all counted). `GET /v1/admin/assistant/usage?month=2026-10` lists calls, tokens and cost per company. Variables:
`ASSISTANT_MODEL_DRAFT` / `_SUGGEST` (claude-sonnet-5-5), `_READ` (claude-haiku-4-5-20251001), `_MANUALS` (claude-opus-5-5),
`ASSISTANT_MONTHLY_CALLS`, `ASSISTANT_TOPUP_CALLS`, `ASSISTANT_FREE_READS`, `ASSISTANT_HOURLY_CALLS` (60 per company; an
empty or unreadable value, such as "1,000", is the default), and `ANTHROPIC_API_BASE` (the mock, for a test hub). A move takes
the company's Assistant counts, zone, comp and call log to its new install. The hub keeps counts, tokens and cost, never a prompt or an answer.
`npm run test:assistant` (needs the dev Postgres on 127.0.0.1:5433; it makes and drops its own database).

**Selling the Assistant** (`src/assistant-billing.mjs`). On the account page each shop gets "Add the Assistant" ($15 a month or
$150 a year, 300 calls a month) and, once it is on, "Buy 300 more" ($10, this month only). The Assistant is its own Stripe
subscription per shop (table `assistant_subscriptions`), not an item on the base plan's: the base plan's standing, key and
"one subscription per shop" rules never see it, so cancelling or lapsing one leaves the other alone. Paying signs a key for the
module `assistant` for the company's own id (the shop_ref the proxy checks), written to `license_issues` with modules
`{assistant}` and sent in every claim and standing answer as `moduleKeys` (a renewal signs the next; an ended subscription gets
no new key and its last one runs out on its own last day plus 14 days). A top-up is a one-time Checkout (mode payment) credited
once by the webhook to the company's month (`assistant_topups`, one row per Checkout session). Variables, each a comma list
like the plans' (the first id is sold): `STRIPE_PRICE_ASSISTANT_MONTHLY`, `STRIPE_PRICE_ASSISTANT_YEARLY`,
`STRIPE_PRICE_ASSISTANT_TOPUP` (the Assistant isn't offered while the first two are unset, top-ups while the third is).
A refund or chargeback of a payment for an Assistant period (a renewal, or a switch to yearly, which starts a new year)
takes the period back and revokes its keys; a full refund also cancels the subscription, while a partial refund or a
chargeback leaves it running and the account page shows the Assistant on hold (no second Checkout, which would bill twice)
until a later payment stands. A chargeback is acted on once. A refunded or charged-back top-up takes back its share of the
calls. A second Assistant Checkout that is paid cancels the older Assistant subscription in Stripe. A top-up refunded (or
charged back) before its Checkout credit lands is held (`assistant_topup_pending`) and taken back when the credit comes.
`npm run test:assistant-billing` (the Stripe and Anthropic mocks, a fresh database).

**Selling the add-ons** (`src/addons.mjs`, migration 032; StitchBench `pricing-review-2026-10.md`). The price list:

| Add-on (module id) | Monthly | Yearly | Variables |
|---|---|---|---|
| Vac Shop (`vac`) | $10 | $100 | `STRIPE_PRICE_VAC_MONTHLY`, `STRIPE_PRICE_VAC_YEARLY` |
| Small Appliance Repair (`appliance`) | $5 | $50 | `STRIPE_PRICE_APPLIANCE_MONTHLY`, `_YEARLY` |
| Scheduling (`scheduling`) | $15 | $150 | `STRIPE_PRICE_SCHEDULING_MONTHLY`, `_YEARLY` |
| Marketing (`marketing`) | $10 | $100 | `STRIPE_PRICE_MARKETING_MONTHLY`, `_YEARLY` |
| Maker Shop (`maker`) | $10 | $100 | `STRIPE_PRICE_MAKER_MONTHLY`, `_YEARLY` |
| All five add-ons (the bundle) | $30 | $300 | `STRIPE_PRICE_BUNDLE_MONTHLY`, `_YEARLY` |
| Each store after the first | $25 | $250 | `STRIPE_PRICE_STORE_MONTHLY`, `_YEARLY` |

The Assistant ($15 / $150) stays out of the bundle. Each variable is a comma list like the plans' (the first id is sold); an
add-on isn't offered while either of its two is unset (the admin page lists what's missing). On the account page each shop
gets a button for each add-on and for all five. Each add-on, and the bundle, is its own Stripe subscription per shop (table
`addon_subscriptions`, one row per shop and product; metadata `hub_product: "addon"`, `hub_addon`), handled the way the
Assistant's is: paying signs a key for its module ids (`{maker}`, or all five for the bundle), plan `m` or `y`, through the
paid-through day plus 14 days, sent after the Assistant's in `moduleKeys` (five keys at most: a shop holds four single
add-ons at most, the bundle costing less by then); a refund or chargeback of a period's charge takes the period back and
revokes its keys (a full refund cancels it; a chargeback is acted on once and undone when won; a later payment that stands
makes it good); a second Checkout for the same add-on cancels the older one. **Buying the bundle cancels the shop's single
add-on subscriptions at once with Stripe's proration** (the unused days are a credit on the next invoice) and revokes their
keys; a single add-on isn't sold while the bundle runs. **The comp**: the admin's comp can cover the five add-ons too
("everything", `addons: true`: a key for all five, plan `c`, through the comp's last day; the Assistant keeps its own comp);
taking the comp away, or comping the program only, revokes that key. **Extra stores**: the program reports `stores` at every
claim (an older program says nothing and the count stays); each store after the first is a quantity of the store price on
the shop's base subscription: in its Checkout, and changed with Stripe's proration (on the next invoice) when the reported
count changes while it runs. The account and admin pages show the stores reported, the extra ones and those billed.
`npm run test:addons-billing` (the Stripe mock, a fresh database).

**Duplicate finder.** `node scripts/find-duplicate-xparts.mjs --dry` lists groups of cross-reference entries with the same
brand, a shared fit and names a letter apart and what asking about them costs; without `--dry` it asks Claude Haiku through the
Batch API (about $1.30 for the whole cross-reference, `ANTHROPIC_API_KEY` needed) and lists the groups it says are one part
(every verdict in `duplicate-xparts.json`). It changes nothing: merge by hand in the program. `npm run test:xpart-dups`.

## Off-site backups

`src/backups.mjs` (the routes are listed at its top): the hub hands out short-lived S3 addresses (`BACKUP_S3_ENDPOINT`,
`_BUCKET`, `_KEY_ID`, `_SECRET`, `_REGION`) for bytes already encrypted with the owner's key. Each company may keep
`BACKUP_QUOTA_GB` (25); over it new pictures wait and the company file still goes, up to a fifth over. The companies of one
install that don't pay their own way (no running subscription, no comp) share `BACKUP_INSTALL_QUOTA_GB` (250) besides, since
a company claim is cheap; a paying company has only its own quota, so a hosted service's paying companies never share one
install's space. An upload address never confirmed is swept after 6 hours (`BACKUP_SWEEP_MS`, every 30 minutes): the object
first, then the row, so a failed delete is tried again at the next sweep. `npm run test:backup` (a fresh database).

## Terms of Service and Privacy Policy
The hub serves both documents from markdown files in `legal/`: `terms-<version>.md` and `privacy-<version>.md`, one
version string for the pair. A version is the day it comes into force, `YYYY-MM-DD` (`YYYY-MM-DD.2` for a second one
that day), with `-draft` on the end while it is a draft: the pages then carry a **"DRAFT, not yet in force"** banner. The
drafts for the lawyer are in `legal/` as `2026-10-03-draft` (copied from StitchBench's `docs/legal/`, where the
placeholders and open questions are listed). Never edit a published version: add a new pair.

- `/terms` and `/privacy` show the version in force; `/terms/<version>` and `/privacy/<version>` any version on file
  (an earlier one says so and links the current one). The pages run no script and allow none (a strict CSP); the
  markdown renderer knows headings, paragraphs, lists, quotes, tables, rules, links (http, https, mailto and paths on the
  hub only), bold, italic and code, and escapes everything else.
- The version in force is `TERMS_VERSION`, or when it is unset the newest pair on file (drafts don't count once a
  published version exists). Set `TERMS_VERSION` when you publish, so a pair committed ahead of its date stays out of
  force. A `TERMS_VERSION` with no files is logged and the default is used.
- `GET /v1/terms/current` (no key) answers `{ version, draft, terms, privacy, versions }`: the programs read the version
  there for the tick in Settings → Account, and link `/terms` and `/privacy` from their login and sign-up pages.
- **Acceptance** is written down each time: an account started from the program (the version it ticked there), sign-up
  on the hub (the tick), "We updated our terms" on `/account` (shown, with a tick, whenever the version in force is newer
  than the one the account accepted, or it accepted none) and **every Checkout** (Subscribe needs the same tick while the
  account is behind; the version goes to Stripe in the subscription's metadata as `hub_terms_version`). The account
  keeps the latest (`accounts.terms_version`, `terms_at`), `terms_acceptances` keeps each one (version, how, and for a
  Checkout the shop and the Checkout Session). A page left open over a version change is told to reload (409).

## Manual repository
Design: `docs/plans/manual-repository-design.md` in the StitchBench repo (read its sections 1 and 4 and the lawyer
questions before you open it: **a plan, not legal advice**). Packages `repo-storage`, `repo-hub` and `repo-takedown`
(`/copyright`, notices, strikes, counter-notices) are built here, so **leave `REPO_UPLOADS` unset until the launch gate in
section 7 of the design is done** (the designated agent registered and named below, the copyright address working, the
lawyer's review, a takedown and a restore run on a test hub). With it unset, `POST /v1/repository/uploads` answers
403 "The manual repository opens soon." and nothing else changes; reading what is published needs no switch.

- **Storage**: one private Cloudflare R2 bucket, `src/r2.mjs` (AWS Signature V4 by hand, no SDK: presigned PUT and GET,
  and the hub's own HEAD, ranged GET, copy and delete). Variables: `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`,
  `R2_SECRET_ACCESS_KEY`, `R2_BUCKET` (on the hub's service only; `R2_ENDPOINT` points a test at the mock in
  `test/r2-mock.mjs`). Keys: `incoming/<upload id>.pdf` (the program PUTs here; lifecycle rule: delete after 1 day),
  `files/<sha256>.pdf`, `retired/<sha256>.pdf` (a removed file; 30 days), `held/` (copyright, with the takedown package;
  120 days). Bytes never pass through the hub except for the one verifying read of an upload (a whole file in memory,
  two at a time, `REPO_MAX_MB` 150).
- **Who may offer** (`POST /v1/repository/uploads`, install key and `X-Shop-Ref`): a company claimed by a verified,
  enabled StitchHub account, on a member install (partner and pending installs are refused before the route), with
  standing not lapsed, not in `REPO_OPERATOR_ACCOUNTS` (account emails or ids, comma separated: the hub's owner uploads
  nothing of his own), and not stopped (`accounts.repo_uploads_off`, `installs.repo_uploads_off`, set from the admin
  API). The offer names category, brand, models, a document type from the library's list, year, language and carries
  the statement's version (`REPO_STATEMENT_VERSION`, when set, must match). Limits: 25 offers a day per company, 100 and
  2 GB a day per account, 50 waiting per account.
- **The flow**: offer -> `{ uploadId, putUrl, putHeaders, expiresAt }` (15 minutes; type and length signed) -> the program
  PUTs to R2 -> `POST /uploads/:id/sent` -> the hub reads the object, checks size and sha256 and the PDF itself
  (`src/pdfcheck.mjs`), deletes it if refused, otherwise files it under `files/` as **pending**. The same bytes already
  there or waiting answer `{ duplicate, id }`; a removed or blocked hash answers `{ blocked }` (no slot).
- **The PDF check** (no dependency): refused when it isn't a PDF, is encrypted, or names `/JavaScript`, `/JS`, `/Launch`,
  `/EmbeddedFile`, `/RichMedia` or `/XFA` (searched in the file's own syntax and in inflated object streams, `#`-escaped
  names too, not in picture or font data, where the bytes turn up by chance). A file the reader can't make sense of is
  flagged for review. **Markings**: the first three pages and the last are read for scan_markings.py's words; a hit is a
  flag in the review queue with the page and the words around it, never a refusal. The reader follows the page tree
  and reads plain text with standard encodings; a scan or a font with its own encoding has no usable text layer. **OCR** (`src/ocr.mjs`; `REPO_OCR=off` turns it off, and
  then such a file gives "not checked for markings: scan or unreadable text", for the owner to look at the cover himself):
  the pages among the first three and the last that have no text are drawn to an image and read after the upload is
  filed, off the request path (one job at a time; the review queue says "checking for markings" until done, then the
  same flag as for text, with "(read by OCR)", or "not checked: OCR failed / timed out" for the owner to look at the cover). A hub restart
  puts files still "checking" back in the queue. Pure JS/WASM, nothing installed on the machine: `pdfjs-dist` (draws the
  page; handles CCITT, JBIG2, JPEG and Flate scans) on `@napi-rs/canvas` (prebuilt binary, Linux x64 glibc and musl
  (the Dockerfile's alpine), Windows, macOS; no compiler), then `tesseract.js` (WASM, in a worker thread) with the English
  `best_int` traineddata from `@tesseract.js-data/eng`, read from node_modules (nothing fetched from a CDN, no cache
  written). Limits: `REPO_OCR_PAGE_MS` 20000 a page (the engine is restarted after a timeout), `REPO_OCR_MAX_MB` 60 (a
  bigger file isn't read), `REPO_OCR_MAX_RSS_MB` 1200 (a page waits, then is skipped, while the process is that big);
  pages are drawn at about 200 dpi, at most 3200 px on the long side; the engine is stopped after 60 s idle.
  **Cost**: node_modules grows by about 130 MB on disk (tesseract.js-core 44 MB, the platform canvas binary about 37 MB,
  pdfjs-dist 35 MB, the English data 14 MB incl. an unused second copy, tesseract.js 2 MB) and so does the Railway image
  (the first build after this is slower). Memory: nothing is loaded until the first scan arrives; reading then
  takes roughly 200 to 350 MB resident while a page is worked on (measured about 240 MB for a 3-page scan on
  Windows), freed in part when the engine stops 60 s later; with the 1 GB-class Railway plan this fits beside the hub's
  own use, and the RSS guard above keeps a busy hub from taking it further. Time: about 3 seconds a page here
  (1.4 s drawing, 1.5 to 2 s reading) after a cold start of a few seconds (up to 12 s on a cold disk), so a 4-page check takes about
  15 seconds. Test: `npm run test:ocr` (about 2 minutes).
- **Review**: the admin page's "Manual repository" section lists what waits (offer as made, flags, markings, the people
  who offered the same bytes, published files for the same brand, model and type); preview opens the file for five
  minutes; **Approve** (with corrected metadata) puts it in the feed and on the Manuals page; **Reject** takes a reason
  the uploader sees, deletes the object and can block the hash. `POST /v1/admin/repository/manuals/:id/remove` takes
  a published manual down (`withdrawn` or `replaced`; bytes to `retired/`). Merge is not built yet; removal for
  copyright is the takedown process below. A review item also lists earlier notices that named its brand.
- **The feed and downloads**: `GET /v1/repository/changes?since=N` (its own cursor on the same change numbers; an old
  program never calls it), `POST /v1/repository/files/:id/url` (the feed's id; published manuals only; 300 an hour and
  3,000 a day per install; the URL lasts 5 minutes with the library's file name forced). `GET /v1/repository/uploads`
  lists the company's own offers and their states.
- **The free side**: signed in to `/account`, the **Manuals** page searches published manuals (brand, model, words,
  type) and gives a short-lived download link: 25 a day per account and per address (an address is kept only as a hash).
  The programs add convenience, not access.
- **Takedowns** (`src/takedown.mjs`; design 4.2; the process of 17 U.S.C. 512(c) and (g) as the design states it, for a
  lawyer to review). Variables: `COPYRIGHT_AGENT_NAME`, `COPYRIGHT_AGENT_ADDRESS`, `COPYRIGHT_EMAIL` (the designated
  agent as registered with the Copyright Office; `COPYRIGHT_AGENT_PHONE` is shown when set) and `REPO_NOTICE_EMAIL` (where
  new notices, counter-notices and the day-10 reminder are mailed; defaults to `COPYRIGHT_EMAIL`). **Until the three
  agent variables are all set, `/copyright` says "Not yet open" and its form refuses.** Mail goes through `src/mail.mjs`
  (`MAIL_DEV_LOG=true` prints it on a test hub).
  - `GET /copyright` (public; linked from the home page): the agent, how to send a notice, the counter-notice and
    repeat-infringer policy, what review checks, and the form. `POST /copyright/notice`: a field per 512(c)(3) element
    (signature; the work; the material and where it is; name, address, telephone, email; the good-faith and the accuracy
    statements); an incomplete one is refused with what is missing (nothing stored); 5 an hour per address, a honeypot
    field (`website`), 16 KB. A complete notice that names a manual's reference (its id, shown on the Manuals page) or a
    file's sha256 is acted on at once if it names 5 or fewer; any other waits for the owner (**Action** with the manual's reference, within one
    business day; the list shows each notice's age in business days).
  - **Acting on a notice**: the manual is `removed` (why: copyright) in the feed and gone from the free page; the object
    moves to `held/<sha256>.pdf`; the hash goes into `blocked_hashes` (the notice's id on it); the account whose upload was
    published gets a strike (one per notice, however many of its manuals the notice names) and an email (what, who complained: name or organisation only, how to counter-notify); anyone
    else who offered the same bytes is told, with no strike; the owner is mailed. Three strikes in 12 months set
    `accounts.repo_uploads_off` and reject that account's waiting offers. A notice logged from an email or letter
    (`POST /v1/admin/repository/notices`, "Log a notice" on the admin page) is checked the same way; an incomplete one is
    only acted on when the owner says it substantially complies.
  - **Counter-notice**: signed in, `/account/repository` lists what was removed for the account with a form (signature,
    name, address, telephone, the good-faith statement under penalty of perjury, consent to jurisdiction, acceptance of
    service); the form says the whole counter-notice goes to the complainant. An incomplete one is refused with what is
    missing. The complainant is mailed the whole of it and the window: **business days 10 to 14** after receipt, skipping
    weekends and US federal holidays as observed (across Thanksgiving 26 Nov 2026 a counter-notice received Monday 16 Nov
    gives 1 Dec to 7 Dec). The owner is reminded on day 10 (hourly sweep; `POST /v1/admin/repository/notices/reminders`
    runs it now) and presses **Restore** (refused before day 10, and after "Complainant has sued", which keeps the file
    down): the object returns to `files/`, the hash is unblocked, the strike withdrawn, the manual republished with a new
    change number, and both sides are mailed.
  - **The owner's admin page** has Copyright notices (each with its timeline, notes only ever appended; CSV export for the
    lawyer at `/v1/admin/repository/notices.csv`), Strikes (withdraw one, end or allow an account's uploading) and Blocked
    (hashes, with the notice that blocked them; refused brands). **Refused brands** (`/repository/refused-brands`, or
    "Refuse offers for this brand" when pressing Action): a maker who sent a takedown; every later offer of that brand is
    refused in words.
  - `TAKEDOWN_TEST_TODAY` (YYYY-MM-DD) pins "today" for the window arithmetic; used by `test/takedown.mjs` only, never set
    it on a real hub.
- Moving a hub: the export carries the tables (`manuals`, `manual_files`, `uploads`, `blocked_hashes`,
  `repo_downloads`, `takedown_notices`, `strikes`), not the bytes, which stay in the bucket.
- **Migration numbering**: this branch's migrations are `024_repository.sql` and `025_takedown.sql` (renumbered at merge after
  `hub-accounts`' 023; files apply in name order, once each).
- **Before opening**: register the designated agent with the Copyright Office and set the three `COPYRIGHT_*` variables;
  make `COPYRIGHT_EMAIL` a working mailbox and send a test notice through the form; set `REPO_NOTICE_EMAIL`; have the
  lawyer review the process; run a takedown and a restore on a test hub; then `REPO_UPLOADS=on`.

## Checking a hub
```
HUB_URL=http://localhost:8080 ADMIN_TOKEN=... JOIN_KEY=... npm test
```
Run this against a **test hub**, not the community's. It creates throwaway members, a link, a note, parts, buying links,
a listing, orders, ratings and parts usage, and checks every part of the API. It then removes the note, link, listing,
figure and parts, ends its partner links and blocks the test members. It joins about eight members (a hub allows ten
joins an hour from one address: restart the test hub before running it again) and would post about eight messages to
the hub's Discord channel, so it refuses a hub that has a webhook unless `SMOKE_ALLOW_DISCORD=1`.

To check moving a hub as well, start a second, empty test hub and add `IMPORT_HUB_URL=http://localhost:8081
IMPORT_ADMIN_TOKEN=...`: the export is imported there and compared (rows, change numbers, members' keys), and files
that are too large or break the rules are refused.

`DATABASE_URL=<a scratch database> ADMIN_TOKEN=<16+ characters> npm run test:db` checks what needs the database: every
column is in the export, the feeds stop below a write in progress, and the link checker drops what a probe found when the
link has changed since.

`DATABASE_URL=<a scratch database> npm run test:accounts` starts a hub of its own on a free port, with a small mail
server inside the test standing in for the mailbox, and checks accounts end to end: the three ways in, sign in, forgot
and reset, claim and standing, the admin's comp, that one account never sees another's shops, the export and the
limits.

`DATABASE_URL=<a scratch database> npm run test:companies` does the same for companies on one install: a listing, order,
note, link, part, usage report and figure made under a company's name shows that name (and the install's when none is
named), two companies on one install are kept apart in ratings and usage counts, and one can't change the other's rows.

`node test/r2.mjs` (`npm run test:r2`, no database) checks the R2 signing: AWS's documented examples yield their
published signatures, and presigned PUT, HEAD, ranged GET, copy and delete work against the in-memory R2 mock, which
refuses expired and altered URLs. (The design's one real 1 MB round trip against the bucket is done by hand once there
is a bucket.)

`DATABASE_URL=<a database on a server where the role may create databases> npm run test:repository` makes two fresh
databases beside it (dropped at the end), starts hubs with the R2 mock and walks the repository: the PDF check (scripts,
encryption, markings on the first three pages and the last), uploads off by default, the account rule, slot -> PUT ->
sent -> pending, wrong hash, wrong size, not a PDF, encrypted and JavaScript refused with the object deleted,
duplicates, blocked hashes, the 26th offer of a day and the 51st waiting (429), approve and reject, the feed, download
URLs for published files only, one company never seeing another's offers, the free Manuals page and its 25 a day, and
export and import into a second hub.

`DATABASE_URL=<a database on a server where the role may create databases> npm run test:takedown` makes two fresh databases
(dropped at the end) and walks the takedown process with the R2 mock and `MAIL_DEV_LOG`: business days and federal holidays
(Thanksgiving 2026), `/copyright` unset and set, an incomplete notice refused with what is missing, a complete one removed
(feed, free page, `held/`, blocked hash, strike, mails), the same bytes refused, a notice waiting for the owner, refused
brands, a counter-notice and its window, restore after the window (unblocked, strike withdrawn, republished) with the
day-10 reminder, a lawsuit, the third strike, the form's limit, honeypot and size, the CSV log, and export and import.

`DATABASE_URL=<a fresh scratch database> npm run test:move` walks a company moving from one install to another: the move
token (answered once, replaced, cancelled, expired, wrong, used), every table rewritten for that company only (legacy
rows with no company and the install's other companies stay), the old install told `410 moved` at its claim and
standing, the new install receiving the moved listings, notes and orders and the partner backlog once from the old
install's place, a move to a program on no hub (an install made), a stray row on the new install, the admin's list
and move by hand, and the export carrying `shop_moves`.

`DATABASE_URL=<a fresh scratch database> npm run test:provisioning` starts a hub with a mock hosted service and a
throwaway signing key and walks "Start a hosted shop" (offered per program, the token sent and never logged, the company
tied to the account and found there at its first claim, one start per 10 minutes, the service's refusal in its words, a
link to another site refused, a service not on this hub, one that doesn't answer) and the owner's reset (only while the
program allows it, the grant's signature and fields, fetched and answered by that install only, replaced, answered once,
withdrawn with the opt-in, the limit), and the export.

`DATABASE_URL=<a fresh scratch database> npm run test:signing` starts a hub of its own and walks two companies with Ed25519 keys through
a signed invite and redeem, signed messages the hub verifies and marks, the refusals (changed payload, type or id, a wrong key,
a bad proof, unsigned once a key is on file, one side signing for the other), a partnership made without keys and the
export. test/billing.mjs section 10b (g) covers the waiver rule on a keyed partnership.

`DATABASE_URL=<a fresh scratch database> npm run test:terms` starts a hub with a legal folder of its own and the Stripe
mock and checks the pages (the version in force, older and newer versions, 404s, the DRAFT banner, the markdown and its
escaping), `GET /v1/terms/current`, acceptance from the program, at sign-up, on `/account` and at Checkout (refused
without the tick while the account is behind), the claim answer's `terms`, the export, and a `TERMS_VERSION` with no files.

`DATABASE_URL=<a database on a server where the role may create databases> npm run test:billing` makes a fresh database
beside it for the run (dropped at the end), starts a hub with the Stripe mock (`test/stripe-mock.mjs`:
Checkout in subscription mode with Stripe's `trial_end` and its 48 hours, the Portal, signed webhooks, refunds (whole or
partial) and disputes (chargebacks and inquiries, opened, updated, then won, lost or closed), with hooks to fail or renew a payment)
and a throwaway `hub1` key, and walks a shop from its trial through subscribe → active → past_due → lapsed → paid again,
cancelling, a yearly plan, a refund and a chargeback (keys revoked; a full refund and a lost chargeback cancel the
subscription; late `invoice.paid` and dispute events change nothing), Solo and Shop (Switch up charged now, a declined
card waiting on Solo until the difference is paid, Switch down credited, an older price
still counted, the old single price and an unknown price counted as Shop, lapsed keeping its plan, the key's `l`),
founding shops (the admin's mark and the 26th refused, founding prices at Checkout and Switch, back within 60 days, the
mark lost after), the trial's edges (subscribing inside the trial is `trialing` and charged when it ends, no `trial_end`
under 48 hours, a partial refund lapses, a full refund of the first payment goes back to the trial and then ends with it,
a lost dispute changes nothing, a won one restores the period, a fresh key and the founding mark its gap cost; an
inquiry keeps full use and shows to the admin, two at once, the first escalating and lapsing the shop, the second
closing with the flag cleared), two subscriptions for one shop (the new Checkout cancels the old one, whose late events
are ignored), a
partnered retail shop waived and the waiver ending (the real-partnership rule: a paying partner and a repair in the quarter; grace and fallback for each break; add-ons never waived), comps, "Lapse now", replayed and badly signed
webhooks, one account unable to subscribe another's shop, the export, and a hub with billing closed. The database must be
fresh because the founding places are counted across it; the test makes its own each run. Every key the hub sends is verified with the program's own verify logic (a copy of
`license.ts`'s `verifyLicense`) and checked to be for the right shop. The mock also runs on its own
(`node test/stripe-mock.mjs`, `STRIPE_MOCK_PORT`, `STRIPE_MOCK_WEBHOOK_URL`) for a local test hub: set
`STRIPE_API_BASE` to it (on its own it offers the prices named in the hub's `STRIPE_PRICE_*` variables).

## API (for StitchBench)
Members send `Authorization: Bearer <install key>`.

| | |
|---|---|
| `POST /v1/register` | `{ joinKey, name, contact }` → `{ installId, installKey }` |
| `GET /v1/changes?since=N&limit=1000` | links, notes (photo info), figure ids, parts and listings changed after `N`; `next` is the new `N`. A removed note is only `{ id, deleted: true }`; a figure id that comes again was redrawn; `removedFigures` are figures the hub admin took down. `since` must be digits (400 otherwise); `limit` is kept between 1 and 2000 |
| `POST /v1/links`, `PUT /v1/links/:id`, `DELETE /v1/links/:id`, `POST /v1/links/:id/restore` | add, fix, remove, restore a link (a link into a private network is refused). The body may name who did it: `byName` (the person) and `shopRef` + `shopName` (the company, see **Companies** below) |
| `GET /v1/links/:id/history`, `POST /v1/links/:id/revert` | a link's versions (`byShop` is the company's name when its install named one, else the install's; `shopRef`); go back to one |
| `POST /v1/links/:id/report` | "this didn't download": check it again soon (404 for a link that isn't there; a link checked within the hour is left alone; 60 an hour per install) |
| `POST /v1/posts` (multipart: `post` JSON + `photo` files), `DELETE /v1/posts/:id` | share or remove a note. The `post` JSON may carry `shopRef` + `shopName`; the note then shows the company's name (`shopName`, `shopRef`, `shopId` in `/v1/changes`). A DELETE that names a company (`shopRef` in a JSON body or `X-Shop-Ref`) can't remove another company's note (403) |
| `GET /v1/photos/:id`, `GET/PUT /v1/figures/:id` | pictures. The first shop to share a figure keeps it and can replace it; PUT answers `{ ok, stored }`, and `stored: false` means another shop's copy is already there. PUT keeps `X-Shop-Ref` as the company that shared it |
| `GET /v1/datasets`, `GET /v1/datasets/:name` | published data sets |
| `POST /v1/xparts`, `PUT /v1/xparts/:id`, `DELETE /v1/xparts/:id`, `POST /v1/xparts/:id/restore` | add, edit, remove, restore a part (409 + `partId` if a number is already on another part). `byName`, `shopRef`, `shopName` as for links; a buying link added or changed is credited to that company (`sources[].byShop`, `shopRef`) |
| `POST /v1/xparts/:id/merge` | `{ intoId }`: the two entries are the same part |
| `GET /v1/xparts/:id/history`, `POST /v1/xparts/:id/revert` | a part's versions, newest 50 first (`X-History-More: 1`: ask for older ones with `before=<id>`; `byShop` and `shopRef` as for links); go back to one |
| `POST /v1/listings` (multipart: `listing` JSON + `photo` files), `PUT /v1/listings/:id`, `DELETE /v1/listings/:id` | list, change, remove a listing (own only). The `listing` JSON may carry `shopRef` + `shopName`: the listing is then the company's (`shopName` is the company's current name, `shopRef`, `shopId` once it has claimed itself, `sellerRating` is the company's). A PUT or DELETE that names a company (`shopRef` in the body or `X-Shop-Ref`) can't touch another company's listing (403) |
| `GET /v1/listing-photos/:id` | a listing photo |
| `POST /v1/orders`, `GET /v1/orders?since=N` | order from a listing (`shopRef` + `shopName` name the buying company); your orders changed after `N`. An order carries `sellerShop`, `buyerShop` (each side's company, else its install), `sellerShopRef`, `buyerShopRef`, `sellerShopId`, `buyerShopId`, `sellerReputation`, `buyerReputation` |
| `POST /v1/orders/:id/accept`, `decline`, `buyer-paid`, `paid`, `ship`, `received`, `cancel`, `message` | move an order along (409 for the wrong side or status; 403 when the body's `shopRef` or `X-Shop-Ref` names a company that isn't this side's) |
| `POST /v1/orders/:id/rate` | `{ stars, comment, shopRef }`: rate the other side of the order (the rating is given to, and by, the companies on the order) |
| `GET /v1/reputation/:installId?shopRef=` | a shop's ratings as seller and as buyer, and its last 10; `shopRef` picks one company on the install. Answers `{ installId, shopRef, shopId, shopName, asSeller, asBuyer, recent }` |
| `POST /v1/usage` | `{ month, items: [{ number, brand, qty, tickets }], shopRef, shopName }`: this shop's parts used that month (replaces it); per company when `shopRef` is sent, and `{ shopRef, off: true }` takes a company's reports back |
| `GET /v1/usage/top?months=12&brand=&limit=200` | the community's most used parts, by shops then quantity. Only parts that at least 3 shops used are listed (`USAGE_MIN_SHOPS` to change it), and nothing when fewer than 3 shops reported |
| `POST /v1/partners/invites` | `{ shopRef, shopName, side, terms }` → `{ code, expiresAt }`: a partner code |
| `POST /v1/partners/redeem` | `{ code, shopRef, shopName }` → `{ link, side }` |
| `POST /v1/partners/join` (no key) | `{ code, shopRef, shopName, contact }` → an install key for the partner channel only, and the link |
| `GET /v1/partners/links` | every link this install's shops are on |
| `POST /v1/partners/links/:id/messages` | `{ id, shopRef, type, data }`: send to the other shop (a repeated `id` is stored once) |
| `GET /v1/partners/messages?since=N&shopRef=` | messages for this install's shops after `N`; `shopRef` keeps one company's (a company that just moved here pulls its backlog once from the old install's place) |
| `POST /v1/partners/links/:id/end` | end a partnership (both shops are told) |
| `POST /v1/upgrade` | `{ joinKey }`: a partner-only install becomes a member |
| `POST /v1/shops/claim` | `{ shopRef, shopName, kind: "repair" \| "retail" \| "both", program: "StitchBench" \| "StitchShop", version, sole }` → `{ ok, listings, shop, account: { email, verified } \| null, terms: { version, draft, accepted }, standing: "trial" \| "active" \| "past_due" \| "waived" \| "comped" \| "lapsed", lastDay, message, plan: "solo" \| "shop", interval: "monthly" \| "yearly" \| null, founding, key: "SB1.…" \| null, revokeKeyIds: [] }`. Sent for every company at every sync; the first time starts its trial. `key` is the hub-signed key for the module `base` the program should hold (its current one, or a fresh one when the standing changed; null when the hub has no signing key, or billing is closed and the shop is on its trial); `revokeKeyIds` names hub keys to drop (a refund, a chargeback, "Lapse now"). `sole: true` (or a body with only `shopRef`, as older programs send) hands what the install listed, ordered and shared before it named its company to that company. `stores` (an integer, 1 to 100: the company's stores; each after the first is billed on its base subscription) is kept on the shop, left as it was when not sent; `moduleKeys` carries the Assistant's key and the add-ons' (five at most); `resetOptIn` (the Windows program's "allow a reset from my StitchHub account") is kept on the shop; left as it was when not sent; `false` withdraws a reset request still waiting |
| `GET /v1/shops/:ref/standing` | the same answer without the claim (404 until the shop has claimed itself). For a company that moved to another install, the install it left gets `410 { error, moved: true, to: <the install's name>, at }` here and at the claim |
| `POST /v1/shops/:ref/move-token`, `DELETE` | the install the company is on, making a move file: `{ shopName, kind, program, version }` → `{ token, expiresAt, shopRef }`, answered once (only its hash is kept), one use, 14 days; a second call replaces the first. `DELETE` cancels it (the owner cancelled the move) |
| `POST /v1/shops/move` (key optional) | `{ shopRef, token, shopName, kind, program, version }`: the install the company moved to redeems the token from the move file; every row of that company (shop, partner links, unused partner codes, listings, orders, ratings, notes, link and part revisions, parts usage) moves to it in one transaction, and listings, notes and orders are numbered again in the feeds. → the claim's answer plus `{ moved: { table: rows }, partner: { shopRef, links }, hubName }`; without a key (a program on no hub yet) the hub makes it an install with the old install's scope and adds `{ installId, installKey, scope }`. 404 wrong token, 409 used (the same install asking again gets the same answer), 410 replaced, cancelled or expired |
| `GET /v1/terms/current` (no key) | `{ version, draft, terms: "/terms/<version>", privacy: "/privacy/<version>", versions }`: the Terms and Privacy Policy version in force (404 when none is on file). The claim's `terms` carries the same `version` and the version the shop's account `accepted` |
| `POST /v1/stripe` (no key: Stripe's webhook) | `Stripe-Signature` checked against `STRIPE_WEBHOOK_SECRET` (400 otherwise); the event id is kept, so a replay answers `{ ok, replay: true }` and does nothing; the object is re-read from Stripe before anything is written (502 when that fails, so Stripe sends the event again). Body up to 256 KB |
| `POST /v1/accounts/start` | `{ shopRef, shopName, kind, program, version, email, termsVersion }` → `{ ok, account: { email, verified: false }, shop }`: the hub makes the account (or mails the link again for one not finished), ties the shop to it and mails a set-password link. 409 when the address already has a finished account (use a link code). Without an install key (an install on no hub yet; `contact` optional) the answer adds `{ installId, installKey, hubName, scope: "pending" }` |
| `GET /v1/shops/:ref/reset-grants` | `{ grants: [{ id, grant, expiresAt }] }`: the owner's password resets asked for on the account, `SBG1.<payload>.<signature>` (none while the program doesn't allow resets) |
| `POST /v1/shops/:ref/reset-grants/:id/done` | `{ result: "allowed" \| "refused", why }`: what the program's window answered; the grant is spent |
| `POST /v1/accounts/link-code` | `{ shopRef, shopName, kind, program, version }` → `{ code, expiresAt }`: a 10-character code the owner types in on the hub within 15 minutes (409 when the shop already has an account) |

The hub's own pages use a session cookie and JSON under `/account/api`: `GET me`, `POST signup { email, password,
acceptTerms, termsVersion }`, `terms { acceptTerms, termsVersion }` ("We updated our terms"), `verify { token }`, `signin { email, password }`, `signout`, `signout-all`, `forgot { email }`,
`resend { email }`, `set-password { token, password }`, `password { current, password }`, `connect { code }`,
`shops/:id/checkout { plan: "solo" | "shop", interval: "monthly" | "yearly", termsVersion, acceptTerms }` → `{ url,
firstChargeOn }` (a Stripe Checkout Session for one of the account's own shops, at the founding price for a founding
account, on Stripe's trial to the end of the hub's when more than 48 hours of it are left: `firstChargeOn` is that day,
null when charged at once; 404 for
another account's, 409 when it already has a subscription, 503 while subscriptions are closed or when a founding price
isn't set, 400 without `acceptTerms` while the account accepted an older terms version; `termsVersion` is the version the
page showed: 409 when it isn't the one in force), `shops/:id/switch { plan: "solo" | "shop" }` → `{ plan, pending,
standing, message, subscription }` (moves a running subscription to the other plan's price with proration: up to Shop the
difference is charged now and `pending: true` with `message` says the card was declined and the shop stays on Solo until
it is paid; down to Solo it is credited on the next invoice; 409 when there is none running or it is already on that
plan), `shops/:id/addons/checkout { addon: "vac" | "appliance" | "scheduling" | "marketing" | "maker" | "bundle",
interval, termsVersion, acceptTerms }` → `{ url, sessionId }` (an add-on's own subscription Checkout; 409 when the shop has it, has the
bundle, or holds four single add-ons; 503 while its prices aren't set) and
`shops/:id/portal` → `{ url }` (Stripe's Customer Portal for the account; 409 before it has ever subscribed),
`hosted { program, shopName, ownerName, timeZone }` → `{ shopRef, setPasswordUrl, expiresAt, appUrl, tied }` (503 for a
program this hub doesn't offer, 429 within 10 minutes of the last) and `shops/:id/reset-owner` → `{ id, expiresAt }`
(409 while the program doesn't allow it, 503 without a signing key). `me` carries each shop's `standing`, `lastDay`,
`message`, `plan`, `subscription` (`plan`, `interval`, `founding`, `status`, `trialEnd` while `trialing`, ...),
`canSubscribe`, `firstChargeOn` (subscribing now is first charged that day, when the trial ends; null: at once), `canSwitch`,
`canManage`, `resetOptIn` and `resetRequest`, `addons: { on, comped, items: { vac: { status, paidThrough, plan, canAdd }, ...,
bundle } }`, `stores: { reported, extra, billed }`, `billing: { open, prices: { solo: { monthly, yearly }, shop: { ... } },
addonPrices: { vac: { label, monthly, yearly }, ..., bundle, store } | null, soloLogins, founding: { on, gapSince, losesOn } }`, `hosted`,
`canSignResets` and `terms: { current, draft, accepted, acceptedAt, needsAccept }`. A change
asked for from another site (the browser's `Origin`) is refused. The admin API adds `GET /v1/admin/accounts` (with
`billing`: open or why not, the Stripe mode, the signing kid and public x and the founding prices not set;
`foundingPlaces: { used, limit }`; each account's `founding: { on, at, gapSince, lostAt }`),
`POST /v1/admin/accounts/:id/founding { founding: true | false }` (409 for the 26th), `POST /v1/admin/shops/:id/comp { until:
"YYYY-MM-DD" | "forever" | "", note, addons: true | false }` (a comp also takes back a "Lapse now"; `addons: true` covers the five
add-ons too, left out it stays as chosen before), `POST /v1/admin/shops/:id/lapse { lapsed:
true | false }` ("Lapse now" and its undo), `GET /v1/admin/shops/:id/keys`, `POST /v1/admin/accounts/:id/resend`,
`POST /v1/admin/accounts/:id/disable { disabled }` and `DELETE /v1/admin/accounts/:id`. Moves (the admin page's
"Moves"): `GET /v1/admin/moves` (every move token and move, newest first, with its state: waiting, moved, cancelled,
expired) and `POST /v1/admin/shops/:id/move { toInstallId }` ("Move this shop" by hand onto an install already on the
hub, as a token would have moved it: for a move file made while the hub was down, or one whose token expired).

The feeds (`/v1/changes`, `/v1/orders`, `/v1/partners/messages`) answer with `X-Feed-Reset: 1` when `since` was past
what this hub holds (it was restored from an older export): that answer starts again from the beginning.

### Companies
A hosted StitchBench serves several companies through one install key, so every record a company makes names the
company: `shopRef` (the company's id on that install) and `shopName` in the body of `POST /v1/listings`, `/v1/orders`,
`/v1/posts`, `/v1/usage`, the link and part writes and the partner calls, and `X-Shop-Ref: <shopRef>` on every other
request (steps of an order, a PUT or DELETE, a figure). The hub stores the company with the row and shows the company's
name wherever it shows an author or seller: listings (`shopName`), orders (`sellerShop`, `buyerShop`), notes
(`shopName`), link and part history and buying links (`byShop`). Once the company has claimed itself
(`POST /v1/shops/claim`), its rows show its current name from the hub's shops table and carry its `shopId`. Ratings
and the most-used-parts counts are per company. A program that sends none of this acts as the whole install, exactly
as before: its rows show the install's name and `shopRef` is null.

The install key stays the trust boundary: a row belongs to the install that made it. What the hub adds is one check:
a request that names a company (`shopRef` in its body, else `X-Shop-Ref`) is refused with 403 when the row names
another company on the same install. A request that names none, or a row that names none, passes as it always did,
so which company may act on an install's older rows is the program's call.

`X-Shop-Ref` also gives each company its own 300 changes an hour (3,000 for the install), so one can't use up the
others'. Parts-usage reports have their own allowance.

Prices and shipping are up to $1,000,000.00 (100,000,000 cents) and quantities up to 1,000,000; more is a 400 with the reason. A body that isn't JSON is a 400 too.

Request bodies are limited per route: 16 KB to join, 2 MB for a figure, a part or a month of parts usage, 37 MB for a
note with photos, 25 MB for a listing, 4 MB for a partner message and 64 KB for the rest. A larger one gets 413.

The admin API is under `/v1/admin` and uses `Authorization: Bearer <ADMIN_TOKEN>`. It includes
`POST /v1/admin/xparts/import` (load parts in bulk), `POST /v1/admin/xparts/sources/import` (buying links in
bulk), and `DELETE /v1/admin/figures/:id` or `DELETE /v1/admin/installs/:id/figures` (take down one figure, or every
figure a shop shared).

## License

AGPL-3.0. You can run, change and share it. If you run a changed version for other people, share your changes too.
