# Bug reports: from the programs to GitHub, and Claude fixes them

How a bug typed into a program becomes a GitHub issue, and how an issue becomes a pull request.

## The path

1. **In the program** a person presses *Report a bug* (StitchBench and StitchShop: Help; StitchFoundry and LaserFoundry:
   Help menu; StitchHub: the *Report a bug* link in the footer, `/report-a-bug`).
2. **StitchBench and StitchShop** send an item of `kind: "bug"` to `POST /v1/feedback` under their install key (it is
   kept for the admin page, "Help & ideas", like the other kinds). **StitchFoundry, LaserFoundry and the hub's own page**
   send `POST /v1/bug-report`, which needs no key.
3. **The hub** files a GitHub issue with `GITHUB_ISSUES_TOKEN` (`src/bugreports.mjs`). The token never leaves the hub.
   The issue gets the labels `bug` and `from-app`.

| Program | Issues go to |
|---|---|
| StitchBench, StitchShop | `Stitchwright/stitchbench` (private) |
| StitchHub | `Stitchwright/stitchhub` |
| StitchFoundry | `Stitchwright/StitchFoundry` (public) |
| LaserFoundry (`laserfoundry`; the old `lightfoundry` still works) | `Stitchwright/laserfoundry` (public) |

## What the owner sets up (once)

- **`GITHUB_ISSUES_TOKEN`** on the hub (Railway variables): a fine-grained personal access token whose repository access is
  exactly the four repositories above, with the permission *Issues: Read and write* and nothing else. Without it
  `/v1/bug-report` answers 503 and StitchBench's bugs are kept on the admin page only. `GITHUB_API_URL` is for tests.
- **In each of the four repositories**: install the Claude GitHub app (https://github.com/apps/claude) and add the secret
  `ANTHROPIC_API_KEY` (Settings → Secrets and variables → Actions). The workflow `.github/workflows/claude-fix.yml` is
  already in each repository.

## What can and can't happen

- Typed text goes into the issue only inside code fences, so it can't mention people, render images or links, or close
  its own formatting. The issue begins with a note that the text is untrusted.
- The shop's name and reply address never go into an issue (the hub keeps them, and the admin page links to the issue).
  The two open-source programs and the hub's page are public: their form says so.
- Limits: 5 reports an hour from one address and 100 an hour for the whole hub; a body over 16 KB is refused; a hidden form
  field catches bots (answered "ok", nothing filed).

## Having Claude fix a bug

1. Read the issue. If it is real, add the label **`claude-fix`** (only people with triage or write access can add labels).
   Comment `@claude` on an issue to ask a question or to ask for more work on it.
2. The workflow runs Claude on that issue. It reads the code, makes the change on a `claude/` branch, runs the repository's
   checks and opens a pull request that says `Fixes #<issue>`. It never merges: review and merge it yourself.
3. Only people with write access to the repository can start it. A report from a stranger does nothing until you label it.
