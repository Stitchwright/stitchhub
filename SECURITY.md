# Security

Thank you for helping keep StitchBench, StitchShop and StitchHub safe for the shops that use them.

## Reporting a problem

Please don't open a public issue for a security problem. Report it privately:

- on GitHub, from this repository's **Security** tab: **Report a vulnerability**; or
- by email to bwattendorfdev@gmail.com, with "Security" in the subject.

Say what you found, how to reproduce it and what someone could do with it. We aim to answer within a week, keep you
posted while we fix it, and credit you when the fix is out unless you'd rather not be named.

## Testing

Test against your own copy (README.md explains how to run one). Please don't test against the hosted
service, the community hub at hub.stitchbench.app or anyone else's install: they hold real shops' customers and
records. Don't run anything that could degrade a service (floods, large uploads, fast scanners).

## What's in scope

The code in this repository: the hub's API and pages, accounts and sign-in, the admin API, billing and the Stripe
webhook, license-key and reset-grant signing, partner and hop signing, the manual repository and its PDF/OCR checks,
and the Docker and Railway setup.

Out of scope: a hub someone else runs with weak settings (for example a short `ADMIN_TOKEN` shared around), social
engineering, and findings that need a stolen admin token or a stolen signing key.

## If you run a hub

- Set a long random `ADMIN_TOKEN` (the hub refuses to start with fewer than 16 characters) and keep it out of chat,
  email and screenshots.
- Keep `HUB_LICENSE_KEY` (the private Ed25519 key that signs license keys) only in the hub's environment variables.
  Anyone who has it can license any shop. If it leaks, make a new key, put the new public half in both programs and
  retire the old one.
- Never commit your `.env`. Use your host's variables (Railway, Docker secrets).
- Serve the hub over HTTPS only. Set `TRUST_PROXY=true` only behind a proxy you control.

## Supported versions

Fixes go into the newest release. The hosted service and the community hub always run the newest code.
