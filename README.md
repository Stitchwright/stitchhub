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
Cloudflare Tunnel or Tailscale Funnel).

### Without Docker
Node 20+ and PostgreSQL: `npm ci`, set the variables from `.env.example`, `npm start`.
The database tables are created on first start.

## Moving or rebuilding a hub

The **/admin** page exports everything to one `.ndjson.gz` file, and imports that file into another StitchHub. That
includes members and their keys, the join key, links with their history, notes, photos, figures, data sets, the
parts cross-reference with its history, and marketplace listings and orders. After an
import, members keep working with their existing keys once they point StitchBench at the new address. Download an
export now and then and keep it somewhere safe.

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

**Marketplace.** A shop lists a part or accessory with its price, quantity, condition, photos, and shipping (a
flat rate, or quoted per order). Another shop orders it:
1. The seller accepts, which issues the invoice with the seller's payment instructions and takes the quantity off
   the listing.
2. The **buyer pays the seller directly**, for example by PayPal, Zelle or check, and can mark it sent.
3. The seller marks it paid.
4. The seller ships and enters the carrier and tracking number. The buyer gets a tracking link for USPS, UPS,
   FedEx and DHL.
5. The buyer marks it received.

Either side can cancel before it ships, and the quantity goes back on the listing. Orders are visible only to the
buyer and the seller. The full contract is in [docs/parts-and-marketplace.md](docs/parts-and-marketplace.md).

## Checking a hub
```
HUB_URL=https://your-hub ADMIN_TOKEN=... JOIN_KEY=... npm test
```
This creates throwaway members, a link, a note, parts, buying links, a listing, orders and ratings, and checks every part of the API. It
then removes the note, link, listing and parts and blocks the test members.

## API (for StitchBench)
Members send `Authorization: Bearer <install key>`.

| | |
|---|---|
| `POST /v1/register` | `{ joinKey, name, contact }` → `{ installId, installKey }` |
| `GET /v1/changes?since=N` | links, notes (photo info), figure ids, parts and listings changed after `N`; `next` is the new `N` |
| `POST /v1/links`, `PUT /v1/links/:id`, `DELETE /v1/links/:id`, `POST /v1/links/:id/restore` | add, fix, remove, restore a link |
| `GET /v1/links/:id/history`, `POST /v1/links/:id/revert` | a link's versions; go back to one |
| `POST /v1/links/:id/report` | "this didn't download": check it again soon |
| `POST /v1/posts` (multipart: `post` JSON + `photo` files), `DELETE /v1/posts/:id` | share or remove a note |
| `GET /v1/photos/:id`, `GET/PUT /v1/figures/:id` | pictures |
| `GET /v1/datasets`, `GET /v1/datasets/:name` | published data sets |
| `POST /v1/xparts`, `PUT /v1/xparts/:id`, `DELETE /v1/xparts/:id`, `POST /v1/xparts/:id/restore` | add, edit, remove, restore a part (409 + `partId` if a number is already on another part) |
| `POST /v1/xparts/:id/merge` | `{ intoId }`: the two entries are the same part |
| `GET /v1/xparts/:id/history`, `POST /v1/xparts/:id/revert` | a part's versions; go back to one |
| `POST /v1/listings` (multipart: `listing` JSON + `photo` files), `PUT /v1/listings/:id`, `DELETE /v1/listings/:id` | list, change, remove a listing (own only) |
| `GET /v1/listing-photos/:id` | a listing photo |
| `POST /v1/orders`, `GET /v1/orders?since=N` | order from a listing; your orders changed after `N` |
| `POST /v1/orders/:id/accept`, `decline`, `buyer-paid`, `paid`, `ship`, `received`, `cancel`, `message` | move an order along (409 for the wrong side or status) |

The admin API is under `/v1/admin` and uses `Authorization: Bearer <ADMIN_TOKEN>`. It includes
`POST /v1/admin/xparts/import` for loading parts in bulk.

## License

AGPL-3.0. You can run, change and share it. If you run a changed version for other people, share your changes too.
