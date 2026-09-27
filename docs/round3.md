# Round 3 review

The round-3 code/QA/security review, its fix status and the next steps live in the StitchBench repo on branch `claude/code-qa-security-review-agqf4z`: `docs/HANDOFF.md` and `docs/round3/ROUND3_FINDINGS.md`.

Done here: package hub-core (body limits on every route, rate limits not keyed on spoofable X-Forwarded-For, link-checker SSRF guard, pool error handling, deleted notes stop going out, export/import fixes; migration 007). Still to do: packages partners (migration 008) and hub-market-parts (migration 009).
