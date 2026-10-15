# Contributing

Bug reports, ideas and pull requests are welcome.

- **Bugs and ideas:** open an issue. Say which program (StitchBench, StitchShop or StitchHub), Windows or hosted, the
  version, what you did and what happened.
- **Security problems:** see SECURITY.md, and please don't post them as issues.
- **Bigger changes** (new endpoints, new tables, billing or license rules): open an issue first so we can agree on the
  approach. The hub's API is used by shipped programs, so changes must stay compatible with older StitchBench versions.
- **Code:** fork the repository, make your change on a branch and open a pull request. Keep each pull request to one
  change, follow the house rules (AGENTS.md where there is one), and make sure CI is green.

## Setting up

You need Node 22 and a PostgreSQL 15 or newer database.

```sh
git clone https://github.com/Stitchwright/StitchHub.git
cd StitchHub
npm ci
cp .env.example .env     # set ADMIN_TOKEN (16+ characters), JOIN_KEY and DATABASE_URL
npm start                # http://localhost:8080/admin
```

The easiest database is `docker compose up -d db`. Never put real keys, tokens or passwords in a commit. Real mail,
Stripe and R2 credentials don't belong in a test hub; the tests use mocks (`test/stripe-mock.mjs`, `test/r2-mock.mjs`,
`test/anthropic-mock.mjs`).

## Checks that must pass

CI runs these on every pull request (`.github/workflows/ci.yml`):

```sh
npm run check                       # syntax check of every source file
npm run test:r2                     # no database needed
DATABASE_URL=postgresql://user:pass@127.0.0.1:5432/scratch npm run test:accounts
```

Each `test:*` script is described under **Checking a hub** in the README. Most need a scratch database, and some need a
role that can create databases. Use a throwaway database, never a real hub's. Add or extend a test with every change
that alters behavior. A new file under `src/` or `test/` also goes into the `check` script in `package.json`.

## Code style

- Plain ES modules, no build step, no TypeScript, no new dependencies unless there is a strong reason.
- Match the file you're editing: naming, comment density and layout. Comments explain *why*.
- A database change is a new numbered file in `migrations/` (never edit an applied one). If it adds a table or column,
  `src/transfer.mjs` (the export) must carry it; `npm run test:db` checks this.
- Don't log tokens, keys, passwords or install keys.

## License of contributions

This project is licensed under the GNU Affero General Public License, version 3 (LICENSE). By sending a contribution you agree that it is licensed
under the same terms, and that you have the right to send it.
