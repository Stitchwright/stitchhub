# CLAUDE.md

## Commit authorship

Commits in this repository are authored by **Bruce Wattendorf**, so the work shows on his GitHub profile. AI assistance is credited with a trailer, not as the author.

- Before the first commit in a session, set the identity: `git config user.name "Bruce Wattendorf"` and `git config user.email "bwattendorf@gmail.com"`. If you can't change the config, pass `--author="Bruce Wattendorf <bwattendorf@gmail.com>"` on every `git commit`.
- Never author or commit as `Claude <noreply@anthropic.com>`.
- End every commit message with this trailer as its last line:
  `Co-Authored-By: Claude <noreply@anthropic.com>`

## What this is

StitchHub: the community hub and parts marketplace for StitchBench and StitchShop (manuals, tech notes, partner shops, listings and orders, accounts, billing, the StitchFoundry inbox). Node 22, Hono, Postgres. Deployed on Railway at hub.stitchbench.app. Licence: AGPL-3.0. Start with `docs/start-here.md`, then `docs/plan.md`.

## Layout

- `src/server.mjs` routes and admin; one `src/<area>.mjs` per area (`market`, `partners`, `inbox`, `accounts`, `billing`, `repository`, ...)
- `migrations/NNN_*.sql` numbered, applied at start; `src/transfer.mjs` lists every table column for export (a test enforces it)
- `test/*.mjs` one script per area, each against a scratch Postgres; `docs/` API and design notes; `public/` admin page

## Build and test

```
npm ci
npm run check                                   # node --check on every file
DATABASE_URL=postgresql://... npm run test:<name>   # one area; CI runs them all, each on a fresh database (.github/workflows/ci.yml)
npm run test:orders-report                      # for example
```

Node version: `.nvmrc`. A test script needs an empty scratch database of its own.

## Conventions

Rules in `docs/start-here.md` apply (secrets only in Railway variables; payments, prices and legal wording are the owner's decision). Add a numbered migration for any schema change and the new columns to `src/transfer.mjs`. Add a `test:<name>` script and wire it into `package.json` and `ci.yml`.

## Product family

StitchFoundry is the umbrella brand (SiteSentrix, Rhode Island). One free **Foundry Account** (cloud.stitchfoundry.app) and one credit balance work across the apps.

| Product | What it is | How it relates to this repo |
|---|---|---|
| StitchFoundry | Embroidery digitizing (stitchfoundry.app), the flagship | Sends a finished design to a shop's StitchShop through StitchHub's inbox ("Send to StitchShop"); shares the Foundry Account |
| LaserFoundry | Laser cutting and engraving (laserfoundry.app) | Sibling; shares the Foundry Account only |
| MakerFoundry | Share, buy and sell embroidery and laser designs (makerfoundry.app) | Sibling; shares the Foundry Account only |
| PatternFoundry | Sewing patterns (coming soon) | Sibling; shares the Foundry Account only |
| StitchBench | Repair-shop ticketing: machines, tickets, parts, factory specs | Joins the hub with an install key; techs are the supply side of partner jobs and the marketplace |
| StitchShop | The counter for sewing, quilt and vacuum shops (same code base as StitchBench, `APP_NAME=StitchShop`) | Joins the hub the same way; receives StitchFoundry designs through the hub inbox |
| StitchHub | The community hub and parts marketplace (hub.stitchbench.app) | This repo (Node, Hono, Postgres), the shared server both programs sync with |

## Standing rule for every session

At START read `CLAUDE.md` and `PROGRESS.md`. Do ONE task. At END update `PROGRESS.md` and open a pull request (never merge it, never push to main, never force-push).

Where this conflicts with a repo-specific rule above (for example commit authorship), the repo-specific rule wins.
