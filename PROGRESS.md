# PROGRESS: StitchHub

Updated 2026-10-29. Read after `CLAUDE.md`. Keep this under one page.

## Current state
- `main` is `8c1672f` or newer; CI green (syntax check, 21+ database test scripts, smoke test, Docker build, dependency audit).
- The StitchFoundry inbox (with optional preview picture and extra meta keys) and the admin report `GET /v1/admin/orders/summary` are merged.
- **Production is not updated:** the live hub runs the 10 Oct code. Deploying runs migrations 038 and 039 (additive).
- The inbox does nothing on the live hub until `FOUNDRY_SIGNIN` and the `BACKUP_S3_*` bucket variables are set (a bucket costs money: owner decides).
- Licence AGPL-3.0; shared contracts will be MIT OR Apache-2.0 (owner, 2026-10-29).

## Recently done
- Integration contract v1.0.0 (`contracts/`, `docs/integration.md`) and `npm run test:contract`; real hub answers are checked against the schemas.
- StitchFoundry inbox and preview (#17); orders-by-month report for judging a parts-sales fee.
- Cleanup: `.nvmrc` (22), `.gitignore` additions, exact-version saves (b34daf4, on the work branch).

## Next 3 steps
1. Owner: authorize Railway's GitHub app on the Stitchwright org, back up the database, reconnect and deploy the hub.
2. Read the orders report (`/v1/admin/orders/summary?months=12`, pass `excludeInstalls` for test installs) and send the numbers to the owner.
3. Phase 4 of the plan: write the integration contract (OpenAPI and JSON schemas) for the partner and marketplace API that already exists, with contract tests.

## Blockers
- Railway source repo is the old name; "Wait for CI" is off.
- Card payment on parts orders (Task 2) waits on the owner: sales tax, fee, terms wording, marketplace name.
- The hub has no webhooks; Bench polls.
