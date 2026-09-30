# Round 3 review

The round-3 code/QA/security review, its fix status and the next steps live in the StitchBench repo on branch `claude/code-qa-security-review-agqf4z`: `docs/HANDOFF.md` and `docs/round3/ROUND3_FINDINGS.md`.

Done here: package hub-core (body limits on every route, rate limits not keyed on spoofable X-Forwarded-For, link-checker SSRF guard, pool error handling, deleted notes stop going out, export/import fixes; migration 007). Still to do: packages partners (migration 008) and hub-market-parts (migration 009).

Low and info findings (package lo-hub): join keys are trimmed; a member's fix or roll back of a link onto an address another link has answers 409 (and so does a race); link addresses are capped; "check again" is limited; prices, shipping and quantities are bounded; feeds refuse a `since` that isn't a number; malformed JSON is a 400; Discord posts show member text as typed and ping nobody; the seller's listings go out again after a rating only when the standing changed, and a blocked rater's ratings don't count; the usage list needs 3 shops per row; a part's history comes in pages; hub imports are read with a line limit and each row is checked; migrations take turns; the hub stops after finishing its requests; a database connection dropped while in use no longer stops the hub.
