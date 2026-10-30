# The Claude work queue: StitchHub

Small tasks wait as GitHub issues; scheduled Claude runs pick one, open a pull request, and stop. You review in the morning. Nothing is ever merged by Claude.

## Labels (create these once in the repository: Issues, Labels, New label)

| Label | Colour | Meaning |
|---|---|---|
| `claude-queue` | `#0e8a16` | Approved, small enough for one session. The routines pick from these |
| `claude-working` | `#fbca04` | A routine is working on it now |
| `claude-done` | `#5319e7` | A pull request is open for it |
| `claude-blocked` | `#b60205` | A routine stopped; the comment says why |
| `claude-proposed` | `#c5def5` | Suggested by a routine or by Claude; the owner promotes it to `claude-queue` or closes it. The routines never pick these up |
| `p1` / `p2` / `p3` | `#d93f0b` / `#e99695` / `#f9d0c4` | Priority, highest first |
| `integration` | `#1d76db` | Touches both repositories (the weekly routine does these) |
| `bug` | `#d73a4a` | Something is wrong (GitHub's default label; keep it) |

## How an issue moves

`claude-proposed` (a suggestion) → you relabel it `claude-queue` + a priority → a run relabels it `claude-working` → a pull request opens and it becomes `claude-done` (or `claude-blocked` with a comment) → you merge or comment. Every issue is one session's worth: a goal, the steps, and "done when".

## Your morning routine (about 2 minutes)

1. Open the pull request, if there is one. Merge it or comment.
2. Look at the `claude-proposed` issues. Relabel the good ones `claude-queue` and close the rest.

## The routines (paste into Claude Code Routines; one repository per nightly routine)

### Routine 1, nightly 2:30 a.m. ET, attach ONLY `Stitchwright/stitchhub`
Schedule: `CRON_TZ=America/New_York 30 2 * * *`

```
You are working in the repository Stitchwright/stitchhub (StitchHub). One issue, one pull request per run. Never merge. Never push to main. Never force-push.

1. Read CLAUDE.md and PROGRESS.md.
2. List open issues labelled claude-queue and NOT labelled integration. Pick the highest priority (p1, then p2, then p3), oldest first. Skip any labelled claude-working or claude-blocked.
3. If there is one: relabel it claude-working; create branch claude/issue-<number>; do the work; run `npm run check, then the relevant npm run test:<name> against a scratch Postgres (all of them are in .github/workflows/ci.yml)`; open a pull request that says "Fixes #<number>" (or "Refs #<number>" if it is only part); update PROGRESS.md; relabel the issue claude-done, or claude-blocked with a comment saying what stopped you. Stop after this one issue.
4. If there is NO open claude-queue issue, switch to maintenance mode:
   If there is NO open issue labelled claude-queue, switch to maintenance mode. At most ONE PR per run.
   STEP 1 HEALTH CHECK (always): build + full test suite. If anything fails, fix it (tonight's PR) and stop. Re-run tests 3 times to spot flaky ones; fix one flaky test or open an issue.
   STEP 2 STRENGTHEN TESTS (if all pass): ONE highest-value gap, PR adds tests only (Bench/Hub: ticket workflow, auth, the integration contract; edge cases: malformed input, empty/max values, clock drift). Do not change product behaviour. A test that reveals a real bug -> issue labelled bug + claude-proposed with the failing test attached, not a silent fix.
   STEP 3 SCOUT AND PROPOSE (always, at the end): up to 3 new issues labelled claude-proposed (NOT claude-queue): TODO/FIXME, dead/duplicated code, security (secrets, input validation, vulnerable deps), code-vs-docs gaps, next steps from PROGRESS.md. Each: one paragraph, why it matters, size S/M/L, suggested priority. No duplicates of open issues.
   RULES: never pick up claude-proposed; never merge; never touch main; never force-push; no large refactors, new features or major-version bumps; update PROGRESS.md with a 2-line "nightly maintenance" note; morning summary 5 lines max (what ran, test status, PR link, titles of new proposals).
   Owner morning routine (2 min): check the PR, merge or comment; relabel good claude-proposed -> claude-queue, close the rest.
```

### Routine 2, weekly, Saturday 3 a.m. ET, attach BOTH `Stitchwright/stitchbench` and `Stitchwright/stitchhub`
Schedule: `CRON_TZ=America/New_York 0 3 * * 6`

```
You are working across two repositories: Stitchwright/stitchbench (StitchBench and StitchShop) and Stitchwright/stitchhub (StitchHub). One integration task per run. Never merge. Never push to main. Never force-push.

1. Read CLAUDE.md and PROGRESS.md in both repositories, and contracts/README.md and docs/integration.md.
2. Find ONE open issue labelled integration and claude-queue (check both repositories; highest priority first, oldest first; skip claude-working and claude-blocked). If none, stop and say so.
3. Relabel it claude-working. Work on branch claude/issue-<number> in each repository you change. The two copies of contracts/ must stay identical.
4. Run the contract tests in BOTH repositories: in stitchhub `npm run check` and `npm run test:contract` (needs a scratch Postgres in DATABASE_URL); in stitchbench `npx tsc --noEmit`, `npm run lint` and `STITCH_CONTRACTS_DIR=<path to stitchhub>/contracts npm run test:unit`.
5. Open a pull request in each repository you changed; each description links to the other ("Part of Stitchwright/<other>#<number>") and says which one should be merged first. Update PROGRESS.md in each.
6. Relabel the issue claude-done, or claude-blocked with a comment saying what stopped you. Never pick up claude-proposed issues.
```

## Fallback: GitHub Actions

`.github/workflows/claude-nightly.yml` does the same nightly run inside GitHub. It is **off by default**: it runs by hand (Actions, Claude nightly, Run workflow) and runs on its schedule only when the repository variable `CLAUDE_NIGHTLY_ENABLED` is `true`. It needs the Claude GitHub app on the repository and the secret `ANTHROPIC_API_KEY` (as `claude-fix.yml` does). **It has not been run yet.** Do not turn on both this and Routine 1: they would pick the same issue.

## Rules for the runs
Never merge, never touch `main`, never force-push; one issue and one pull request per run; no large refactors, new features or major-version bumps in maintenance mode; follow `CLAUDE.md` (commit authorship). Cross-repo work is `integration` (see Routine 2 and `docs/integration.md`).
