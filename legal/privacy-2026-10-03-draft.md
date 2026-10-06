> **DRAFT for review by a lawyer; not legal advice; not yet in force.**
> Notes in `[LAWYER: ...]` are questions for the lawyer. Notes in `[OWNER: ...]` are facts or choices the owner must
> confirm. Both come out before publishing. See `docs/legal/README.md`.

# Privacy Policy: StitchBench, StitchShop and StitchHub

Version: [VERSION DATE, YYYY-MM-DD]

This policy explains what information we hold, where it sits, who sees it, how long we keep it, and what you can do
about it. It covers StitchBench and StitchShop (the programs), StitchHub (the community hub), and our hosted service.

## 1. Who we are

We are [OWNER LEGAL NAME] ("we", "us"), of [ADDRESS]. Contact us about privacy at [CONTACT EMAIL].

"You" means the shop that uses our services, and the shop's owner and staff. "Your customers" means the people your
shop serves.

## 2. The short version

- **The Windows program keeps your shop's data on your shop PC.** We don't have it and can't see it.
- **On our hosted service** your shop's data sits on our hosting provider's servers. We hold it **for you**: you
  decide what it's for, and we use it only to run the service.
- **The hub holds only what it needs and what you choose to share**: your account and billing details, your shop's
  name, what you offer to the community, and messages between you and a partner shop.
- **Your customers' contact details never go to the community.** Partner shops see only what a repair needs (first
  name and last initial, not phone or address).
- **We never see card numbers.** Stripe handles payments.
- **We don't sell information, and we don't show ads.** No advertising or tracking cookies.
- **The optional Assistant** sends the text of a ticket (with customer names, emails and phone numbers taken out) to
  Anthropic, through the hub, only when someone presses a button. The hub doesn't keep it. Anthropic doesn't train on
  it.

## 3. Two kinds of information, two roles

1. **Information about you as our customer**: your hub account, your billing, your shop's name, what you share on
   the hub. **We decide** how this is used, as this policy says.
2. **Information your shop keeps about its customers and staff**: customers, machines, tickets, photos, payments,
   messages. **Your shop decides** how this is used; your shop is responsible for it (the "controller", or "business"
   in California's terms). On the hosted service we store and process it **on your shop's behalf** (as its "service
   provider" or "processor"). On the Windows program and a self-hosted server, we don't have it at all.

If you are a customer of a shop and have a question about your information, please ask the shop first. If the shop
uses our hosted service, we'll help the shop answer you. [LAWYER: confirm the controller/processor and CCPA
business/service-provider framing, and whether a separate DPA is needed (see the Terms, section 11).]

## 4. Where your shop's data sits

| How you run | Where the shop's data is | Who can get at it |
|---|---|---|
| **Windows program** | On the shop PC, in the program's database (`%APPDATA%\StitchBench`, or `StitchShop`), with nightly backups in `Documents\StitchBench Backups` | You. We have no copy and no access |
| **Hosted by us** | In a database on Railway, our hosting provider, in [OWNER: region, e.g. the United States] | You and your staff; us as the operator (section 6.2); Railway as our provider |
| **Self-hosted** | On your own server or cloud account | You. We have no copy and no access |
| **Hosted by your repair shop** (a StitchShop the repair shop runs for its partner shops) | On the repair shop's server | The repair shop, as your host. Ask it how it looks after your data |

**Manuals stay on your PC** in every case. The hub stores links to where manuals are published, never the manuals.
On the hosted service, each tech's browser opens manuals from that tech's own PC.

In every case, what you choose to send to the hub sits on the hub (section 5), which runs on Railway too.

## 5. What we collect, and why

### 5.1 Your StitchHub account and subscription

| What | Why |
|---|---|
| The owner's email address (the same email the owner signs in to the program with) | To sign you in, confirm the address, send password resets, billing emails and notices about these terms |
| A password, stored only as a scrambled one-way "hash" | To sign you in. We can't read your password |
| Whether the email is confirmed; when you signed up and last signed in; sign-in sessions (stored only as hashes) | Security, and to let you sign out everywhere |
| Which version of the Terms and this policy you accepted, and when | To know what you agreed to |
| The shops your account owns: name, kind (repair, retail or both), which program and version | To track each shop's trial, plan and standing |
| Your subscription: plan (monthly or yearly), status, paid-up-to date, Stripe customer and subscription ids, and which billing emails we've sent | To bill you and keep your program working |
| Free plans we give, with our note; licence keys we issued to your shop | To run the free plans and keys |
| Password-reset and link codes, stored only as hashes, for minutes or hours | To reset a password or connect a shop |

### 5.2 What the program tells the hub about your install and shop

When the program joins the hub, it sends the install's name and a contact you give (usually an email). At every sync
(every few minutes) it tells the hub, for each company: its id, name, kind, program and version. The hub answers with
the shop's standing and licence key. The hub keeps the install's key only as a hash.

**Internet (IP) addresses.** The hub uses the address a request comes from, for a short time, to limit abuse (for
example, too many sign-in attempts). It holds this in memory and doesn't save it to its database. Our hosting
provider may record addresses in its request logs. [OWNER: check Railway's log retention and say it here.]
[LAWYER: confirm this is enough.]

### 5.3 What you share on the hub

**You choose what to share, item by item.** Nothing about a ticket or a customer goes to the community unless someone
offers it. What can be shared:

- **Tech notes ("hints")** about a model: brand, model, the kind of note, the title, the text, and the photos you
  tick. Never the customer, the serial number, the ticket's problem or its notes. The program refuses a note that
  contains the machine's serial or the customer's name. Your shop's name and the name of the person who wrote it are
  shown with it.
- **Manual link fixes and parts cross-reference edits**: the change, with your shop's name and the person's name, kept
  in the history so it can be undone.
- **Marketplace listings**: the part, price, quantity, condition, photos, shipping. Your shop's name and rating show
  with it.
- **Marketplace orders** between two shops: the items, the seller's payment instructions, messages, tracking number,
  and ratings. Only the two shops see an order (ratings show to every shop, without the rater's name).
- **Parts-used counts** (only if you turn on the setting): how many of each part number you used each month. No
  customers, tickets or prices. The community list shows a part only when at least three shops used it.
- **Figure pictures**: small crops of manual pages that show a timing or adjustment. These contain nothing about your
  shop or customers. [OWNER: the program sends a figure to the hub automatically when it draws one for a factory
  setting; it is not an item-by-item choice today. Keep this sentence, or change the program.]

Every shop on the hub can see what you share there, except orders and partner messages. The hub may post a short
announcement of new notes, link fixes, listings and new members (with the shop's name) to the community's Discord
channel. Orders are never posted.

### 5.4 Messages between partner shops

When a repair shop and a sewing or quilt shop connect as partners, their programs exchange messages through the hub:
the sewing shop's tag number, **the customer's first name and last initial**, the machine and the problem, intake
photos, estimates and approvals, the repair bill and status, orders, consignment stock and sales, and monthly
statements. **Customers' phone numbers and addresses stay in the shop.**

The hub keeps these messages so a shop that was offline can catch up: **for a year** after every shop they're for has
received them, and **never more than three years**. They are **not end-to-end encrypted**: the people who run the hub
(us) can read them in the database. We look at them only to keep the hub running, to fix a problem a shop reports,
or when the law requires. [LAWYER: is the partner shops' own agreement the right place for the customer-facing notice
that some details go to the partner? Each shop is responsible to its own customers.]

### 5.5 Your shop's data on the hosted service

On the hosted service we store everything your shop enters, for example: customers (names, phones, emails, addresses,
notes, how they want to be contacted, their consent to marketing); machines and serial numbers; tickets, repairs,
estimates, photos and payments; sales and inventory; emails and texts sent, replies received, opt-outs and the
consent record; classes, enrollments, appointments; staff names, sign-ins (passwords as hashes) and shifts; online
bookings and online orders (with shipping addresses); and your mail, Twilio and Stripe passwords and keys, which are
**encrypted** in the database.

We use it only to run the service for your shop: to store it, show it to you and your staff, send your messages
through your accounts, take your online payments, back it up, keep it secure, and fix problems. We don't sell it, use
it for advertising, combine it with other shops' data, or look at it otherwise. [LAWYER: confirm this is complete,
and whether aggregated, de-identified statistics should be reserved or ruled out. Recommended: ruled out.]

### 5.6 Emails we send you

From one mailbox we control, we send: account emails (confirm your address, password resets, connecting a shop),
billing emails (payment failed, grace ending, read-only, yearly renewal reminders), notices about changes to these
terms and this policy, and, on the hosted service, password-reset emails to your staff. Stripe sends receipts. We
don't send you marketing. [OWNER: confirm. If you ever send product news, it must have an unsubscribe link.]
[OWNER: name the mail provider here once chosen.]

### 5.7 The Assistant (optional)

[OWNER: the Assistant is built on branch `assistant` except "Ask the manuals" and the parts helpers (rows marked "later"
below, which can stay or go until they ship). Publish this section when the Assistant ships, and check it against what
shipped. The hub keeps counts, tokens and cost only (migration 040); the "first time on each ticket" preview is built.]

The Assistant uses AI models made by **Anthropic**. It runs **only when someone presses a button**: never on a page
load, a timer or in the background.

**The path.** Your program sends the request to the hub. The hub sends it to Anthropic, gets the answer, and passes it
back. **The hub does not keep the text** it sends or gets back. It keeps only counts per shop and month (requests,
their size in "tokens", cost, which feature, how long, errors), to meter your allowance.

**What is taken out first, every time.** Email addresses, phone numbers, the ticket's customer name, the trade
account's name and your known customers' names are replaced with "[customer]". The customer's record (contact
details, address) is never read into a request at all. Customer **first names** are sent for drafts only if you turn
on "Offer customer first names to the Assistant" in Settings → Assistant (it starts **off**); otherwise the draft says
{first_name} and the program fills it in on your PC. The first time on each ticket, the program shows exactly what
will be sent before it goes.

**What each feature sends:**

| Feature | What is sent |
|---|---|
| Draft it (write-ups) | The ticket's service requested, problem, diagnosis, work done and the tech's notes; your shop's name and your "how we write" sample. Not the customer, serial number, payments or photos |
| What's likely wrong | The same for this ticket; the problem, diagnosis, work done and part and service lines of up to 20 of your closed tickets on the same model (no customers, no serial numbers); matching community notes, tension specs, factory settings and test-mode procedures |
| Read the plate | The one photo of the machine's rating plate that the tech chooses, and a list of brand names. The serial number comes back and is written only into the form; the log keeps it masked. No other photo is ever sent. If a photo shows a name tag, that would go too, so the program shows the photo first |
| Ask the manuals (later) | The question, brand and model, and the text of up to 12 matching pages of that model's manuals. The manuals themselves stay on your PC |
| Parts helpers (later) | Part numbers, descriptions and fits, and matching cross-reference entries; for an import, the column headings and three sample rows of a parts list |

**At Anthropic.** We use Anthropic's API under its Commercial Terms. As we read them on 3 October 2026:

- Anthropic's [Commercial Terms of Service](https://www.anthropic.com/legal/commercial-terms) (effective 17 June 2025),
  section B, say: "Anthropic may not train models on Customer Content from Services." The customer (us) retains the
  rights to its inputs and owns the outputs.
- Anthropic's Privacy Center, ["Is my data used for model training?"](https://privacy.claude.com/en/articles/7996868-is-my-data-used-for-model-training)
  (updated 18 August 2026), says: "By default, we will not use your inputs or outputs from our commercial products
  (e.g. Claude for Work, Anthropic API, Claude Gov, etc.) to train our models." The exception is feedback sent to
  Anthropic; the Assistant's "Use this" and "Not useful" buttons stay in your program and send nothing to Anthropic.
- Anthropic's Privacy Center, ["How long do you store my organization's data?"](https://privacy.claude.com/en/articles/7996866-how-long-do-you-store-my-organization-s-data)
  (updated 1 July 2026), says: "For Anthropic API users, we automatically delete inputs and outputs on our backend
  within 30 days of receipt or generation", except where a request is flagged under its Usage Policy (then kept up
  to 2 years) or the law requires longer.

[LAWYER: Anthropic's Data Processing Addendum is incorporated into its Commercial Terms by reference. Check it covers
our use as a processor for shops, and list Anthropic as a subprocessor (section 7). Re-check these quotes when
publishing.]

**In your program.** Each request and answer is logged in your shop's own data (Settings → Assistant shows "What was
sent" for each), so you can check it. It is part of your data: it's in your backups and exports, and on the Windows
program it stays on your PC.

### 5.8 Payments

- **Your subscription.** Stripe's Checkout and billing pages take your card. We keep only Stripe's customer and
  subscription ids, the plan, its status and dates. Stripe's dashboard shows us things like the card's brand and last
  four digits and your billing address; we don't copy them. Stripe's privacy policy applies to what it collects.
- **Your online shop.** Stripe Checkout takes your customers' cards. Card numbers never reach the program or us. The
  order (the customer's name, email or phone, shipping address, items and amounts) is kept in your shop's data.
  If you use the hosted service's Stripe account, Stripe and we see these payments too, because they go through our
  account. [OWNER/LAWYER: see the Terms, section 13, about that option.]
- **The marketplace** takes no payments: the buyer pays the seller directly.

### 5.9 Other services the program talks to

- **Your email account and Twilio**, to send your messages (section 8).
- **UPCitemdb**, when someone looks up a retail barcode: only the barcode number is sent.
- **Manufacturers' websites**, when a tech downloads a manual into the library.
- **A tunnel** (Tailscale, Cloudflare and similar), only if you set one up.

### 5.10 Cookies

The programs and the hub use **sign-in cookies only**: to keep you signed in, and for security. No advertising,
analytics or tracking cookies. The online shop keeps the cart in the page's address, not in a cookie.
[LAWYER: confirm no cookie banner is needed for US-only use.]

## 6. Your customers' information

### 6.1 Your shop is responsible for it

Your shop decides what to collect about its customers and staff and what to do with it. Your shop must give them any
notice the law requires (for example a privacy notice on your website if you use online booking or the online shop),
and answer their requests to see, correct or delete their information. [OWNER: the program can't yet delete or merge
a customer record (decided, not built: HANDOFF section 4, L126). Until it can, a hosted shop asks us; say how a
Windows shop does it.]

### 6.2 What we do with it on the hosted service

We hold it for you and act only on your shop's instructions (which are these terms and what you do in the program).
We and our provider Railway can technically get at it as the operators. We look at it only to keep the service
running and secure, to fix a problem you ask us to fix, or when the law requires us to. We'll tell you about a
request from the authorities for your data unless the law forbids it.

### 6.3 Texts and email: consent

Messages go from **your** email account and **your** Twilio account. Your shop is the sender and is responsible for
consent under the TCPA, CAN-SPAM and state laws (see the Terms, section 12). The program records each customer's
consent with the exact words they agreed to, honours STOP and unsubscribes, and keeps a consent record that is never
edited or deleted, because a dispute can be raised for four years. Those records stay even if a customer's other
details are deleted, because the law expects them to be kept. [LAWYER: confirm keeping opt-outs and consent records
after a deletion request is allowed (it's generally a legal-obligation exception).]

## 7. Who we share information with

**We don't sell or rent information, and we don't share it for advertising.**

We share only:

- **With our service providers**, who handle it for us under their own contracts and only to provide their service:
  - **Railway**: hosting and databases for the hub and the hosted service;
  - **Stripe**: payments and subscriptions;
  - **[OWNER: mail provider]**: our account, billing and password-reset emails;
  - **Anthropic**: only for the Assistant, only what section 5.7 lists, only when someone presses a button;
  - **Discord**: short announcements on the community channel (section 5.3).
- **With other shops**, only what you share on the hub (section 5.3), and with a partner shop only the partner
  messages (section 5.4).
- **When the law requires it**, or to protect people, the services or our rights, when that is lawful.
- **If our business changes hands**, with the new owner, who must keep to this policy. We'll tell you first.

[LAWYER: is a named list of providers enough, or should we publish a separate subprocessor list with a change notice?]

## 8. How long we keep things

| What | How long |
|---|---|
| Your hub account | Until you ask us to delete it |
| Subscription and invoice records | As long as tax and accounting law requires [LAWYER: how long; typically up to 7 years] |
| Sign-in sessions | 30 days, or until you sign out everywhere |
| Reset and link codes | Minutes to a day; each works once |
| Partner messages on the hub | A year after delivery; never more than three years |
| Things you shared on the hub (notes, link and part edits, listings, ratings) | Until you remove them, or for as long as the community uses them (section 9) |
| Assistant counts on the hub (no text) | [OWNER: choose, e.g. 2 years] |
| Your shop's data on the hosted service | While your shop is on the service. **A lapsed subscription never deletes it.** After you close the account: [OWNER: e.g. 90 days], then deleted |
| Hosted database backups | [OWNER: Railway's backup schedule and retention] |
| A move file | Not stored on the server when you make one: it streams straight to your download. One uploaded to the hosted service for an import is deleted from the server within 24 hours |
| The old copy after a move | Read-only, kept until someone deletes it (allowed after 30 days) |
| Your shop's data on Windows or self-hosted | You decide. The program never deletes consent records or opt-outs, and keeps sent messages and replies |
| At Anthropic (Assistant) | Deleted within 30 days, per Anthropic's terms (section 5.7) |

## 9. Deleting your information

- **Your hub account.** Ask us at [CONTACT EMAIL]. We delete the account, cancel its subscription, and detach its
  shops. What your shop shared with the community (notes, link and part edits, listings) stays, under your install's
  name, because other shops rely on it, unless you remove it first or ask us to remove it. [LAWYER: is keeping shared
  contributions after an account deletion acceptable, especially names of people in edit history? Consider replacing
  people's names with the shop's on deletion.]
- **Your hosted company.** Ask us. We'll confirm, give you the chance to export or move it first, and then delete it.
  Copies in backups disappear as the backups expire.
- **On Windows or self-hosted**, you delete your own data (uninstalling leaves the data and backups until you delete
  them; the installation guide says where they are).
- **What we must keep**: billing records the law requires, and anything we need for a legal claim.

## 10. Export and moving your company

You can take your data with you at any time, even when your shop is read-only:

- **Settings → Your data** downloads spreadsheets (CSV) of customers, machines, tickets, repairs, payments, sales,
  inventory, messages, consent records, campaigns, classes, appointments, shifts, online orders and more.
- **Settings → Company → Move this company** makes one file with the whole company, to move between a Windows PC, our
  hosted service and your own server. It holds everything, including staff password hashes, so keep it safe, don't
  email it, and delete it when the move is done. Passwords and keys for your mail, Twilio and Stripe are left out.
  On the hub, your shop's partner links, listings, notes and orders follow it; partner shops see nothing change.

## 11. Security, in plain terms

- Passwords are stored only as one-way hashes (bcrypt in the programs, scrypt on the hub). Reset links and codes are
  hashed too, and work once.
- Your mail, Twilio and Stripe passwords and keys are encrypted in the database (AES-256-GCM), each tied to your shop.
- The hosted service and the hub use encrypted connections (https). Sign-in cookies can't be read by page scripts.
- Sign-ins, sign-ups and resets are rate-limited against guessing.
- Card numbers never reach us; Stripe handles them.
- Each shop on a hosted service sees only its own data; every query is limited to the signed-in shop.
- **What we can't protect:** your shop PC, its backups and move files. Backups are **not encrypted**. Keep them as
  private as the PC, and remember that Windows may copy Documents to OneDrive.
- Partner messages on the hub are not end-to-end encrypted (section 5.4).

No system is perfectly secure. If a breach affects your information, we'll tell you without unreasonable delay and as
the law requires. [LAWYER: state breach-notification duties, including to shops' customers on the hosted service, and
who notifies whom.]

## 12. Your choices and rights

You can:

- see and change your account email and password on the hub, and your shop's details in the program;
- turn off sharing of parts-used counts, remove what you shared, and choose what you offer;
- turn the Assistant on or off, feature by feature, and decide whether first names are offered;
- export everything (section 10), and ask us to delete your account or hosted company (section 9);
- ask us what information we hold about you, at [CONTACT EMAIL]. We'll answer within [45] days and may need to check
  it's really you.

Depending on where you live, privacy laws may give you more rights. We'll honour them where they apply. [LAWYER:
which US state laws apply to a company our size (most have revenue or volume thresholds we may be below)? We don't
plan to offer the services outside the US (marketing texts go to US numbers only); should the policy say the services
are for US businesses only, and skip GDPR/UK language?]

## 13. Children

The services are for businesses and are **not meant for children**. We don't knowingly collect information from
children under 13. A shop may keep records about customers who are children (for example a child in a sewing class);
the shop is responsible for that under section 6. If you think a child has given us information, tell us and we'll
delete it. [LAWYER: COPPA applies to services directed at children or with actual knowledge; check whether shops
enrolling children in classes through online booking raises anything for us on the hosted service.]

## 14. Changes to this policy, and versions

Each version has a version date in the form **YYYY-MM-DD** at the top, and is published on the hub at
[HUB ADDRESS]/privacy, with earlier versions kept there. The hub records which version your account accepted. If we
make a change that matters, we'll email your account at least [30] days before it applies and show "We updated our
terms" on the hub and in Settings → Account. [LAWYER: same question as the Terms, section 23.]

## 15. Contact

[OWNER LEGAL NAME]
[ADDRESS]
[CONTACT EMAIL]
