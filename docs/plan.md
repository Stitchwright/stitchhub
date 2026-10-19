# StitchHub: the Foundry Account plan

**Status:** 2026-10-19. Survey done, nothing built yet. Owner: Bruce Wattendorf (SiteSentrix).

## Goal
One login for all SiteSentrix software: the **Foundry Account** (cloud.stitchfoundry.app), with one credit balance
("Foundry credits"). The hub signs people in through the cloud service the way MakerFoundry does ("Accounts (MF-1)" in
github.com/SiteSentrix/makerfoundry `docs/plan.md`), keeps the cloud token server-side, and keeps its own data keyed by
the account's `id`.

## Today (surveyed 2026-10-19)
- **Login:** own `accounts` table (migration 012), scrypt hashes (N=2^15), cookie `hub_session` (HttpOnly; only the hash is
  stored; 30 days), verify and reset links by SMTP (`src/accounts.mjs`, `src/mail.mjs`). Programs use an **install key**
  on every request; that stays.
- **Admin:** `/admin` with a shared `ADMIN_TOKEN` bearer (`src/server.mjs`).
- **AI:** `src/assistant.mjs` holds `ANTHROPIC_API_KEY`, maps classes (draft/suggest/read/manuals) to Sonnet 5.5, Haiku
  4.5 and Opus 5.5, limits 300 calls a month per company (`assistant-billing.mjs`). `src/xpart-dups.mjs` and
  `scripts/find-duplicate-xparts.mjs` use Haiku through the Batch API.
- **Users:** none yet; development phase (owner, 2026-10-19). So **no migration flow**: demo accounts are reset.
- **Variables (names only):** `DATABASE_URL`, `ADMIN_TOKEN`, `JOIN_KEY`, `HUB_NAME`, `HUB_URL`, `SMTP_URL`, `MAIL_FROM`,
  `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_MONTHLY`, `STRIPE_PRICE_YEARLY`,
  `HUB_LICENSE_KID`, `HUB_LICENSE_KEY`, `PLATFORM_API_TOKEN`, `TRUST_PROXY`, `GITHUB_ISSUES_TOKEN`, `PROGRAM_FREE`.

## Design
1. **Sign up / sign in** on the hub's own pages: the form posts to the hub, which calls the cloud's `POST /v1/signup` or
   `/v1/signin` over HTTPS. The password passes through but is never stored or logged.
2. **The cloud token (`sfs_…`) never reaches the browser.** It is kept in the hub's Postgres under a hub session id held in
   a `__Host-` cookie (HttpOnly, Secure, SameSite=Lax); form posts also check `Origin`. Sign-out calls `/v1/signout`.
3. `accounts` gains `foundry_id` (unique). It becomes the key; `password_hash`, verify and the hub's own reset mail are
   removed after the cutover (password reset is the cloud's, `/v1/password/forgot`).
4. **Shop data stays here:** shops, installs, partners, marketplace, hops and billing hang off `accounts.id` as now.
5. **Install keys are unchanged.** Programs still authenticate to the hub by install key. A program is tied to a Foundry
   Account by the existing link-code flow, which now needs a Foundry sign-in.
6. **Hub sharing needs a Foundry link.** A desktop install with no link works alone: no hub, no credit-paid AI.
7. **Admin:** keep `ADMIN_TOKEN` for now; moving admin to Foundry sign-in is a later task.

## AI (decided 2026-10-19)
SiteSentrix pays Anthropic; credits are how it earns. Default is Foundry credits via the cloud service's `/v1/messages`,
called **server-side with the signed-in user's token**. A shop may use its own Anthropic key instead (held by the
shop's own program, sealed there; never by the hub). The hub drops `ANTHROPIC_API_KEY`, `/v1/assistant`, the 300-call
plan and its top-ups; the duplicate finder either goes through the cloud service or stays an admin script on the
owner's own key, outside the hub's runtime (owner to choose).

## Asks for the StitchFoundry chat (cloud service)
1. Email verification at sign-up, or `emailVerified` in `/v1/account`.
2. Model allowlist: today only `claude-opus-5-5`. We need `claude-haiku-4-5-20251001` and `claude-sonnet-5-5` too.
3. Confirm image input and the 16,000 `max_tokens` cap fit our features (plate and packing-slip reads send photos).
4. A **company-level spend**: staff don't each hold credits; the owner's Foundry Account pays for the shop's calls.
5. Calls with no person behind them (customer questions on a public booking page; batch jobs): a way to bill the
   owner's balance, and to turn the feature off when it runs out.
6. A free monthly allowance (like the 20 plate reads) and a per-company spending cap, if wanted.
7. Batch API support, or the duplicate finder keeps its own key.

## Tasks
| Id | What | Done when |
|---|---|---|
| FA-0 | These docs; asks sent to the StitchFoundry chat | merged |
| FA-1 | Cloud sign-in on the hub; `foundry_id`; server-side token | a person signs in with a Foundry Account on the hub |
| FA-2 | Link a program to the account; remove hub passwords | demo accounts reset; no hash left |
| FA-3 | AI through `/v1/messages`; retire the hub's key | `ANTHROPIC_API_KEY` removed from Railway |
| FA-4 | Admin on Foundry sign-in (optional) | `ADMIN_TOKEN` retired |


## Other apps' landing pages (owner, 2026-10-19; not done here)
PatternFoundry and LaserFoundry each need their own marketing page and download links for their different installers; MakerFoundry needs no landing
page, because it is the storefront, so pages link straight to it. PatternFoundry will get the same treatment as StitchBench/StitchShop later. The owner
will do these pages in the StitchFoundry chat, not in this repository.

## Open: "We host it for you" (FA-7)
**Owner, 2026-10-19:** running it yourself (the Windows/Mac/Linux program, or your own server) stays **free**. If **SiteSentrix hosts**
the shop or bench on its own server, it costs about **$25 a month**, and the hosting **includes backups**. The owner wants it, with
the cost, on the StitchFoundry landing pages, and the figure goes to the StitchFoundry chat once it is settled (that chat owns those
pages; nothing is edited here). "Like $25 a month would be reasonable" is the owner's working number, not yet a final price.

What is known: the hub's code already has a subscription of $25 a month or $250 a year per shop (Stripe, `STRIPE_PRICE_MONTHLY` and
`STRIPE_PRICE_YEARLY`), switched off while `PROGRAM_FREE` is on; StitchBench's `docs/plans/pricing-review-2026-10.md` puts Railway at
about $14 for the shared instance and under $1 per added shop, and about $10 for a dedicated copy; the hub already has off-site backups
(`src/backups.mjs`, with a per-install quota). Hosted copies sign in with a Foundry Account (FA-2), which this rides on.

Still the owner's to decide before anything is built or published (money, payments and public wording):
1. **Confirm the price** and whether there is a yearly price ($250 a year is what the hub code has) or only monthly.
2. **How it is paid**: the hub's Stripe subscription (turning billing on is a payments change), or the Foundry Account service's Stripe.
3. **What "backups" promises**: how often, how long they are kept, whether a shop can download one, and whether a restore is included.
   (Say only what is true; the hub's backup feature is the starting point.)
4. **What stays free on the hosted service**: today the public pages say hosted use is free ("nothing to pay"), on `/`,
   `/stitchbench/`, `/signup/` and `/features/` of stitchsite. Those pages and any shop already on the free shared hosting need a decision.
5. **Foundry credits are separate** from the hosting fee (AI is paid in credits, or a shop's own key).

**Hand-off draft for the StitchFoundry chat (not sent; send after the owner confirms):**
> The owner's wording for the apps landing pages: *StitchBench and StitchShop are free to run yourself, on a Windows, Mac or Linux
> computer or on your own server. Or let SiteSentrix host it for you: about $25 a month, backups included.* Sign-in is a Foundry
> Account; AI is paid in Foundry credits or with your own key. Please add this where the apps are described, and tell us the page
> address so stitchsite can link to it. The final price and the backup promise are the owner's; check them before publishing.

## Hub proxy retirement (FA-4 follow-up)
The program no longer needs the hub for AI once `FOUNDRY_AI=on` (StitchBench `docs/plan.md`, "FA-4 notes"). The hub's `/v1/assistant`, its
`ANTHROPIC_API_KEY`, the 300-call plan and `assistant-billing.mjs` stay until every program in use has the switch on; removing them is then FA-3 here, and
a decision for the owner (it ends the free plate reads and the monthly allowance for good).

## Open decisions (the owner's)
The hub's Stripe subscriptions and marketplace payments (`PROGRAM_FREE` is on), terms and privacy wording, prices of
credits (the cloud service's), and what happens to the duplicate finder.
