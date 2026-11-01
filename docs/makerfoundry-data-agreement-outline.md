# MakerFoundry orders: data agreement outline and privacy wording (draft for the lawyer)

**Status:** 1 Nov 2026. A plan, not legal advice. Everything marked *(MF)* is what MakerFoundry told us on 1 Nov 2026 and is
theirs to confirm in their own wording; everything marked *(hub)* comes from `docs/hub-sync-design.md`; *(shop)* is how StitchShop
behaves today. A fact not in one of those is not stated here. Open questions for the lawyer are at the end.

## 1. Who does what

| Party | Role for an order | Holds |
|---|---|---|
| The customer | Orders and pays on MakerFoundry | - |
| MakerFoundry (makerfoundry.app) | Takes the order and the payment, sends the order to the shop | Name, delivery address (only if it ships), items, decorations, art and mock-ups, amounts, the customer's note; the customer's account email; Stripe payment references. Card details stay with Stripe. *(MF)* |
| StitchHub (Bruce Wattendorf dba SiteSentrix) | Carries the order message from MakerFoundry to the shop and the shop's replies back | The message while it waits, then 30 days after the shop acknowledges it, then a stub with no personal data beyond shop ids, kept a year. Files: deleted 30 days after they are ready. *(hub)* |
| The shop | Makes and delivers the order | Its own copy as a decorating order. The delivery address is wiped 30 days after shipping, and at once if the customer cancels. *(shop)* |

Never sent in an order: the customer's email or phone (the order form refuses them in the name and note). *(MF)*

## 2. Terms the agreement should contain

1. **Purpose limit.** Each party uses an order's personal data only to take, make, deliver, pay for and support that order. No selling.
   No marketing use by MakerFoundry or the shop. *(MF confirmed)*
2. **What is sent.** The list above, and no more. A change to what an order carries (a new field) is told to the other parties first.
3. **Retention, each side.**
   - MakerFoundry: art and mock-ups 30 days after the order closes; name, address and note blanked 30 days after the order is
     shipped, collected or cancelled; amounts and tax records kept without the address as the law requires. Not yet in force:
     they will do this before ordering opens. *(MF)*
   - Hub: as in section 1. *(hub)*
   - Shop: as in section 1. *(shop)*
4. **Who answers a customer.** MakerFoundry for what it holds, the shop for its copy, the hub for its queue. First contact for requests:
   support@makerfoundry.app. Each answers within [period: lawyer]. *(MF)*
5. **Providers.** Each side names the providers that touch order data. MakerFoundry: Stripe (payments, sales tax), Railway (hosting and
   database, US), Cloudflare R2 (art and mock-ups), StitchHub (delivery). Hub: Railway (Virginia, US), Resend (email, not used for
   orders). *(MF, hub)*
6. **Breach.** Each side tells the other within 72 hours of learning of it. Contacts: Bruce Wattendorf, support@makerfoundry.app. *(MF)*
7. **Test data.** Test deploys hold only the owners' own test data, never production orders. *(MF confirmed)*
8. **Ending.** What each side deletes when it stops taking part, and how a shop leaving takes its copy with it.

## 3. Proposed wording for the hub's Privacy Policy (the next version, not the one in force)

Add to "Who we share information with" (section 7):

> **MakerFoundry.** If your shop takes orders from MakerFoundry, the hub carries each order from MakerFoundry to your shop and
> your replies back. An order includes the customer's name, delivery address (only if it ships), the items and decorations, the
> artwork, the amounts and the customer's note. It never includes the customer's email or phone number. The hub keeps a message
> until your shop acknowledges it, erases its contents 30 days after that, and then keeps only a record with no personal
> details for a year. Files (artwork and mock-ups) are deleted 30 days after they are ready. MakerFoundry is a separate service with its
> own terms and privacy policy (https://makerfoundry.app/privacy); it answers customers about what it holds, and your shop answers
> for its own copy. We do not use order details for anything else.

Also add MakerFoundry to the hosted-service list in the Terms ("other companies' services") and to the retention table. Because this
changes the published Privacy Policy, it is a new version with a new acceptance, so it is published together with MakerFoundry's
own updated terms, before ordering opens on production.

## 4. Questions for the lawyer

1. Is a short three-party agreement (MakerFoundry, the hub, and each shop through the hub's Terms) the right shape, or do the Terms
   plus MakerFoundry's own terms cover it?
2. Controller or processor: for an order, is the shop the controller and MakerFoundry and the hub processors, or are MakerFoundry and
   the shop each independent? (US-only today; does Rhode Island or any state law change the answer?)
3. The period within which each side answers a customer's request.
4. Is a 72-hour breach window acceptable between the parties, and does any state law require shorter notice to customers?
5. Does the hub's 30-day body retention after the acknowledgement match what MakerFoundry will say publicly?
