# Changelog: jevellan-git

## 0.2.0

- Decoupled from the other skills: `worktree.mjs`, `land.mjs` and `evals/run.mjs` reach the ledger only through the
  ledger skill's public `ledger.mjs` (show, record and events with `--json`, run as a process and found by role), and
  Jev only through the placement skill's `jev.mjs decide --json`. Nothing of another skill is imported any more; the
  project paths, ids, locks, redactor and policy parser are this skill's own copies in `scripts/lib/`.
- The guards that ran inside the ledger lock (a worktree recorded meanwhile at another path; a task already stopped or
  landed when archiving) now run on a fresh read, and the line is appended with `--if-last-seq`, so a task that changed
  in between is read and decided again. A concurrent create of the same worktree is no longer recorded twice.
- `land.mjs --force` and the verify-then-land continuation work without a placement skill installed; only asking Jev
  needs it. A missing role is exit 2 naming it.
- `evals/run.mjs` replays the cases one after another (one `jev.mjs decide` process per case) instead of four at a
  time.
- `SKILL.md` ends with an "## Interface" section listing the scripts, what they print and their exit codes. The
  landing policy is unchanged, and so is its hash: the policy parser (`scripts/lib/policy.mjs`, the placement skill's
  current version) leaves the Interface section out of the sections and the hash.
- `resolveChoice` no longer throws on a missing answer; land.mjs refuses an answer without a usable landing_route as
  "Jev: invalid response", as before.
- Own tests in `test/`, run with only this skill present (`node scripts/test-skills.mjs --skill jevellan-git`), with
  fake ledger and placement skills.
- `worktree.mjs create` links `.claude` into a worktree only when the skills run from the project's own
  `.claude/skills`; skills that came with a plugin reach workers through `--plugin-dir` (H-038).
