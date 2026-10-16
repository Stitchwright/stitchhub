# CLAUDE.md

## Commit authorship

Commits in this repository are authored by **Bruce Wattendorf**, so the work shows on his GitHub profile. AI assistance is credited with a trailer, not as the author.

- Before the first commit in a session, set the identity: `git config user.name "Bruce Wattendorf"` and `git config user.email "bwattendorf@gmail.com"`. If you can't change the config, pass `--author="Bruce Wattendorf <bwattendorf@gmail.com>"` on every `git commit`.
- Never author or commit as `Claude <noreply@anthropic.com>`.
- End every commit message with this trailer as its last line:
  `Co-Authored-By: Claude <noreply@anthropic.com>`
