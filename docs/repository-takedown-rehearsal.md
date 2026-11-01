# Rehearsal: one takedown and one restore on a test hub

The last item of the manual repository's launch gate (README, "Manual repository"; design section 7). Run it once on a
**test hub**, never the community's, and keep the notes at the bottom. Nothing here needs a real complainant or a real
manual: the file is a small PDF you make yourself.

**What it proves:** a notice arrives and is mailed; acting on it removes the manual, holds the bytes, blocks the hash and
strikes the uploader; a counter-notice is accepted; the restore is refused before business day 10 and works after it;
and every step is in the notice's timeline and the CSV.

## 0. Set up the test hub
A separate Railway service or local run, its own database and its own R2 bucket (or `test/r2-mock.mjs` locally).

| Variable | Value on the test hub |
|---|---|
| `REPO_UPLOADS` | `on` (test hub only) |
| `COPYRIGHT_AGENT_NAME`, `COPYRIGHT_AGENT_ADDRESS`, `COPYRIGHT_EMAIL` | the registered agent's details (DMCA-1084865); the email must be a mailbox you read |
| `REPO_NOTICE_EMAIL` | a mailbox you read (defaults to `COPYRIGHT_EMAIL`) |
| mail | a real `SMTP_URL`, so you see the mail actually arrive. `MAIL_DEV_LOG=true` (prints mail to the log) is enough for the rehearsal but does **not** prove the address works |
| `TAKEDOWN_TEST_TODAY` | unset at first; set in step 6 only, and never on the real hub |

Make two throwaway accounts: **uploader** (a claimed company on a member install) and **complainant** (just an email
address you control). Make a small valid PDF with a made-up brand and model, for example "Testbrand TB-100 Service
Manual", with no JavaScript or attachments.

## 1. Publish a manual
1. As the uploader, offer the PDF (`POST /v1/repository/uploads`, then PUT, then `/sent`), or use the program with
   `REPO_UPLOADS` on.
2. Admin page, Manual repository: the offer waits in review. **Approve** it.
3. Check: it is in the feed (`GET /v1/repository/changes?since=0`) and on the signed-in Manuals page; note its reference
   (the id the Manuals page shows).

## 2. Send a notice through the public form
1. Open `/copyright` (it must show the agent, not "Not yet open").
2. Fill in every element as the complainant, naming the manual's reference. Submit.
3. Try once with something missing (for example no signature): it must be refused and say what is missing, with nothing stored.
4. Check: **the notice email arrives in `REPO_NOTICE_EMAIL`'s mailbox.** This is the "a test notice arrives" gate item.

## 3. Act on it
A complete notice naming five or fewer manuals is acted on at once; if it waits, use **Action** on the admin page.
Check each of these, and write down what you saw:
- the manual is gone from the feed and the Manuals page;
- the object has moved from `files/<sha256>.pdf` to `held/<sha256>.pdf` in the bucket;
- the hash is under Blocked, with the notice's id;
- the uploader has one strike, and got an email saying what was removed, who complained (name or organisation only) and
  how to counter-notify;
- the owner got the mail;
- offering the same PDF again answers `{ blocked }`.

## 4. Counter-notice
1. As the uploader, open `/account/repository` and send a counter-notice (all fields; the form says the whole thing goes to
   the complainant). Try an incomplete one first: refused with what is missing.
2. Check: the complainant's mailbox gets the whole counter-notice and the window, **business days 10 to 14** after receipt.
3. Try **Restore** now: it must be **refused** (before day 10).

## 5. The complainant sues (once, then undo by using a second notice)
Do this on a second notice and manual only, so the main run stays clean: **Complainant has sued**, then Restore must be
refused and the file stays down. This proves the stop.

## 6. Restore on the main notice
Moving the clock needs the test variable, so this is the only step that touches it:
1. Set `TAKEDOWN_TEST_TODAY` to a date at least 10 business days after the counter-notice (skip weekends and US federal
   holidays; the README has the arithmetic) and restart the test hub.
2. `POST /v1/admin/repository/notices/reminders` (or wait for the hourly sweep): the owner gets the day-10 reminder.
3. Press **Restore**. Check: the object is back in `files/`, the hash is unblocked, the strike is withdrawn, the manual is
   back in the feed with a new change number, and both sides were mailed.
4. Unset `TAKEDOWN_TEST_TODAY` and restart.

## 7. Record it
- Download `/v1/admin/repository/notices.csv`: every step above should be in the timelines.
- Check three strikes: with a third throwaway notice against the same uploader across three manuals, confirm
  `accounts.repo_uploads_off` is set and its waiting offers are rejected. (Optional; the automated test `test/takedown.mjs`
  covers it.)
- Write the result below, date it, and keep it with the lawyer's sign-off.

Only then: `REPO_UPLOADS=on` on the **real** hub.

## Result (fill in)
| Step | Date | Passed? | Notes |
|---|---|---|---|
| 1 publish | | | |
| 2 notice form and mail arrived | | | |
| 3 act on the notice | | | |
| 4 counter-notice, early restore refused | | | |
| 5 sued stops restore | | | |
| 6 restore | | | |
| 7 CSV and timelines | | | |
