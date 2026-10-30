# Stitch contracts

The shared API between **StitchHub**, **StitchBench / StitchShop** and **StitchFoundry**: what each calls, and the exact shape of the data they exchange. It describes what the hub does today (version in `VERSION`), and tests in both repos fail when either side drifts from it.

Licence: **MIT OR Apache-2.0** (`LICENSE-MIT`, `LICENSE-APACHE`), so the open-source programs can carry it without taking on the hub's AGPL.

| File | What |
|---|---|
| `openapi.json` | Every call the programs make to the hub (JSON on purpose: no YAML parser needed to test it) |
| `schemas/*.json` | JSON Schemas for each message and record |
| `examples/*.json` | One valid example per schema (the tests use them) |
| `messages.json` | Each partner message type: which side may send it, and its schema |
| `validate.mjs` | A small dependency-free schema checker; it throws on any keyword it does not support |

## Your entities, and what they are today

The hub did not need a new model for the flow "a shop sends a machine to a tech". It already has one; these are the names.

| Entity | In the contract |
|---|---|
| Shop profile | `shop-claim` (`POST /v1/shops/claim`): `shopRef`, `shopName`, `kind` (repair, retail, both), `program`, `version` |
| Tech profile | A repair shop is the tech. There is no per-person profile: a `partner link` joins a repair shop and a retail shop |
| Machine | Fields inside `job.new` (brand, model, serial, machineType). It is not a record of its own on the hub |
| Job request (shop to tech) | The partner message `job.new` (retail side sends) |
| Job status updates | `job.update` (repair side), `job.reply`, `job.paid`, `job.pickedup`, `job.cancel` (retail side) |
| Ticket link | The job `id` in every message, plus `ticketNumber` in `job.update`. Same `id` in both shops' records |
| Part listing / part order | `listing` and `order` (marketplace, any shop to any shop). A retail shop buying from its own partner uses `catalog` / `order.new` / `order.update` |
| StitchFoundry file | `inbox-item` (the hub inbox) |

Not covered yet (they exist, with no schema): `terms.*`, `consign.*`, `settle.paid`, `pickup.*`, `caps.update`, `msg.rejected`. The hub relays any type unchanged.

## Where it lives, and why

**Now:** this folder in the StitchHub repo is the source; StitchBench carries an identical copy. **Recommended next:** a small `stitch-contracts` repo under Stitchwright (MIT OR Apache-2.0) that both repos pull in, because a copy can be edited in one place and left stale in the other. Until then the copies are kept honest two ways: each repo's contract test checks its own code against the files, and Bench's test compares its copy file by file with another one when you set `STITCH_CONTRACTS_DIR` (point it at the hub's `contracts/`). To move: create the repo, copy this folder in, and replace each repo's folder with a pinned git submodule or `git subtree`, at the same path (`contracts/`) so the tests need no change.

## Changing it

1. Change the files here and in the code, and add or update an example.
2. Additive change (a new optional field or message type): bump the minor number in `VERSION` and `openapi.json`. A change that breaks a receiver: bump the major number and keep the old shape working for one release.
3. Run `npm run test:contract` here and the unit tests in Bench (`STITCH_CONTRACTS_DIR=../stitchhub/contracts npm run test:unit`).
4. Copy the folder to the other repo in the same change window.

## Security

- **Calls:** every call carries a bearer key. A program's install key has a scope: `member` (everything here) or `partner` (only `/v1/partners/*` until it upgrades). StitchFoundry sends its Foundry Account token to the inbox's sender routes only. Rate limits answer 429.
- **Partner messages are signed** (Ed25519): the hub cannot invent one, and a receiver checks each against the key it pinned. See `docs/partners.md` ("Signing").
- **Webhooks are not built.** Programs poll `GET /v1/partners/messages`. The planned design is in `openapi.json` under `x-planned-webhooks`: the hub POSTs one message-envelope to a URL the install registers, with `X-StitchHub-Signature: t=<seconds>,v1=<HMAC-SHA256 of "t.body">`; receivers reject a bad signature or a timestamp more than five minutes old; the poll stays the source of truth.
