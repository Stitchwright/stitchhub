# Progress

- 2026-10-31, issue #20: `test/upgrade.mjs` (`npm run test:upgrade`, in CI) migrates a scratch database to 037, seeds rows, starts the hub so 038/039 run, and checks rows, sequences and the new inbox schema. `UPGRADE_SELF_CHECK=drop-rows|rewrite-rows` shows it catches a destructive migration.
