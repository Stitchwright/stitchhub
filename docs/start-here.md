# Start here: notes for a new session

Written 2026-10-19. Read this, then [`plan.md`](plan.md).

## The owner
**Bruce Wattendorf**, doing business as **SiteSentrix**. Plain, step-by-step instructions work best for anything he
has to click through. Commits are authored by him (see `CLAUDE.md`).

## The family
| Thing | Where | Notes |
|---|---|---|
| StitchHub (this repo) | Railway, hub.stitchbench.app | Node + Hono + Postgres. The shared server the shops sync with |
| StitchBench and StitchShop | github.com/Stitchwright/stitchbench | **One code base.** StitchShop is StitchBench run with `APP_NAME=StitchShop` and `DEFAULT_SHOP_KIND=retail`; two Railway projects, plus Windows/Mac/Linux installers |
| stitchsite | github.com/Stitchwright/stitchsite | The static marketing site (Cloudflare Pages). Links to the hub's `/account` pages |
| Foundry Account service | cloud.stitchfoundry.app, code in github.com/Stitchwright/StitchFoundry (`apps/stitchfoundry-cloud`, `docs/cloud.md`) | Accounts, credits, Stripe, and `/v1/messages` for AI |
| MakerFoundry | github.com/SiteSentrix/makerfoundry | The reference for how an app uses the account service ("Accounts (MF-1)" in its `docs/plan.md`) |

## Decided (owner, 2026-10-19)
- **One login: the Foundry Account**, and one credit balance ("Foundry credits") across all SiteSentrix software.
- **AI is how SiteSentrix earns, and we pay Anthropic.** The default is Foundry credits through the cloud service's
  `/v1/messages`, called from the server with the signed-in user's token. A shop may instead use **its own Anthropic
  key**. Our own Anthropic key never lives in this repo's runtime: it stays only in the cloud service's variables.
- **Desktop installs** keep local logins. A Foundry link is optional; without it the program works on its own (own AI
  key allowed) but has **no hub sharing and no credit-paid AI**. Hosted editions use Foundry sign-in only.
- Shop-specific data (shops, tickets, machines, roles) stays in each app's own database, keyed by the account's `id`.

## The owner decides (ask, don't assume)
Anything that costs money, touches payments, is legal wording, or changes what real users see: the hub's Stripe
subscriptions and marketplace, prices, terms and privacy text, and moving existing users.

## Rules for this repo
- Run `npm run check` and the relevant `npm run test:*` before every push. Never push to main with failing checks;
  never force-push.
- Secrets live in Railway variables. Never in code, docs or chat. Name variables, never values.
- Work on the branch the session names. Open a pull request at the end of each task (see CLAUDE.md, "Standing rule"); never merge it yourself.
