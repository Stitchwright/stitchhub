# Security policy

StitchHub holds shop owners' accounts, billing links and the signing key for StitchBench licenses, so we take
security reports seriously.

## Reporting a vulnerability

**Please don't open a public issue.** Report it privately instead:

- Use GitHub's **[Report a vulnerability](../../security/advisories/new)** button (Security tab → Advisories), or
- email **[SECURITY CONTACT EMAIL]**.

Please include what you found, the steps to reproduce it (a hub you run yourself is best), and what you think an
attacker could do with it. We'll acknowledge your report within 3 working days, keep you posted, and credit you in the
fix if you'd like.

Please test only against a hub you run yourself. Don't test against the community's hub, don't touch other people's
data, and don't run anything that could degrade the service (floods, large uploads, scanners at speed).

## What's in scope

The code in this repository: the hub's API and pages, accounts and sign-in, the admin API, billing and the Stripe
webhook, license-key and reset-grant signing, partner and hop signing, the manual repository and the OCR/PDF checks,
and the Docker and Railway setup.

Out of scope: a hub someone else runs with weak settings (for example a short `ADMIN_TOKEN` shared around), social
engineering, and findings that need a stolen admin token or a stolen signing key.

## If you run a hub

- Set a long random `ADMIN_TOKEN` (the hub refuses to start with fewer than 16 characters) and keep it out of chat,
  email and screenshots.
- Keep `HUB_LICENSE_KEY` (the private Ed25519 key that signs license keys) only in the hub's environment variables. Anyone
  who has it can license any shop. If it leaks, make a new key, put the new public half in both programs and retire
  the old one on the hub's Billing page.
- Never commit your `.env`. Use your host's variables (Railway, Docker secrets).
- Serve the hub over HTTPS only. Set `TRUST_PROXY=true` only behind a proxy you control.
- Keep the Node image and dependencies up to date; Dependabot is on for this repository.

## Supported versions

Only the latest commit on `main` is supported. There are no separate release branches.
