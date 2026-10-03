# StitchHub

The community server for **StitchBench**, a repair-shop app for sewing, embroidery and quilting machine technicians.

StitchBench runs in each shop, on the shop's own PC, and its customers, machines, tickets and prices stay there.
StitchHub is the one small shared server that the shops sync with. It holds only what they choose to share:

- **Manual links.** Where each service, parts or operator manual can be downloaded, with a status (working, dead,
  or blocks robots) that the hub rechecks every week. Anyone can fix a dead link. Every change is kept and can be
  rolled back. **The hub never stores manuals**, only links to where they're published.
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

The hub admin gives members the hub address and a **join key** (for example by email after a one-time
contribution toward server costs). In StitchBench, open **Settings → Community hub**, enter both, and press Join.
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
Run **exactly one** hub process per database. The hub keeps track of the writes in progress in its own memory so
that a shop never skips a change in its sync, and a second process on the same database (Railway's replicas set
above 1, `docker compose up --scale hub=2`, a manual `npm start` beside the container) doesn't know about them.
`railway.json` pins Railway to one replica. (A deploy briefly runs the old and the new hub side by side; the old one
finishes the requests it is on before it stops.) Starting several hubs on one database at the same moment is safe for
the migrations: they take turns.

## Moving or rebuilding a hub

The **/admin** page exports everything to one `.ndjson.gz` file, and imports that file into another StitchHub. That
includes members and their keys, the join key, links with their history, notes, photos, figures, data sets, the
parts cross-reference with its history, and marketplace listings and orders. The export is one snapshot, so it can be
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
- The buyer rates the seller once it has shipped; the seller rates the buyer once they've paid. Rating again
  replaces the earlier one.
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

Every company tells the hub about itself at each sync (`POST /v1/shops/claim`) and learns its **standing**: a 30-day
trial from its first claim, or free with the admin's compliments (the /admin page, Shops → Comp). Subscriptions and
license keys come with the billing package; until then `key` is always null and the standing changes nothing in the
program.

Passwords are hashed with scrypt; links, codes and session ids are stored as SHA-256 hashes; sessions are HttpOnly
cookies for 30 days; a password reset signs every browser out. Sign-ups are limited to 10 an hour per address and wrong
sign-ins to 20 an hour per address (and 200 an hour for the whole hub).

For the emails the hub needs three variables: `HUB_URL` (its own public address, for the links; on Railway the public
domain is used when it is empty), `SMTP_URL` (`smtps://user:pass@host:465`, or `smtp://…:587` for STARTTLS) and
`MAIL_FROM`. Without them the account routes answer 503 and the rest of the hub runs as before. A test hub on this
computer can set `MAIL_DEV_LOG=true` instead: each email is printed to the hub's log (links included) rather than sent.
Never set that on a real hub.

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
| `GET /v1/partners/messages?since=N` | messages for this install's shops after `N` |
| `POST /v1/partners/links/:id/end` | end a partnership (both shops are told) |
| `POST /v1/upgrade` | `{ joinKey }`: a partner-only install becomes a member |
| `POST /v1/shops/claim` | `{ shopRef, shopName, kind: "repair" \| "retail" \| "both", program: "StitchBench" \| "StitchShop", version, sole }` → `{ ok, listings, shop, account: { email, verified } \| null, standing: "trial" \| "comped", lastDay, message, key: null, revokeKeyIds: [] }`. Sent for every company at every sync; the first time starts its trial. `sole: true` (or a body with only `shopRef`, as older programs send) hands what the install listed, ordered and shared before it named its company to that company |
| `GET /v1/shops/:ref/standing` | the same answer without the claim (404 until the shop has claimed itself) |
| `POST /v1/accounts/start` | `{ shopRef, shopName, kind, program, version, email, termsVersion }` → `{ ok, account: { email, verified: false }, shop }`: the hub makes the account (or mails the link again for one not finished), ties the shop to it and mails a set-password link. 409 when the address already has a finished account (use a link code). Without an install key (an install on no hub yet; `contact` optional) the answer adds `{ installId, installKey, hubName, scope: "pending" }` |
| `POST /v1/accounts/link-code` | `{ shopRef, shopName, kind, program, version }` → `{ code, expiresAt }`: a 10-character code the owner types in on the hub within 15 minutes (409 when the shop already has an account) |

The hub's own pages use a session cookie and JSON under `/account/api`: `GET me`, `POST signup { email, password,
acceptTerms }`, `verify { token }`, `signin { email, password }`, `signout`, `signout-all`, `forgot { email }`,
`resend { email }`, `set-password { token, password }`, `password { current, password }`, `connect { code }`. A change
asked for from another site (the browser's `Origin`) is refused. The admin API adds `GET /v1/admin/accounts`,
`POST /v1/admin/shops/:id/comp { until: "YYYY-MM-DD" | "forever" | "", note }`, `POST /v1/admin/accounts/:id/resend`,
`POST /v1/admin/accounts/:id/disable { disabled }` and `DELETE /v1/admin/accounts/:id`.

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
