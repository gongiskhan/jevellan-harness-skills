# Changelog: jevellan-git

## 0.4.0

- From the final review: --force tolerates a check failing outside the task's scope only when the landing question was about it, and every other check still runs; matching uses test paths with a folder and system error codes only; a landing overlap note that found overlap is not the next check's baseline.
- `overlap.mjs --task T [--checkpoint intake|step|landing]`: the commits, pull requests and open tasks related to the
  task, recorded as a note (docs/decisions.md H-043).
- Landing guards before the decision: files outside plan.md's scope block beyond two tests or fixtures (source
  "scope"), and by pull request new work sharing files and intent with the branch (source "overlap"), make the route
  ask-owner. A check that fails on a follow-up the reports named becomes ask-owner (source "checks") instead of a
  refusal. The pull request body gains "Decisions taken", "Follow-ups" and "Outside the plan's scope". The policy
  text and its hash are unchanged.
- gh and path helpers moved to `scripts/lib/gh.mjs` and `scripts/lib/scope.mjs` (land.mjs re-exports them).

## 0.3.0

- Landing by pull request (`.jevellan/project.json` `"landing": "pr"`, docs/decisions.md H-041). `worktree.mjs create`
  fetches origin and starts a parentless task from `origin/<defaultBranch>`, refusing when the fetch fails.
  `land.mjs` compares with `origin/<defaultBranch>` only, merges it into the task branch, runs the checks, pushes the
  task branch (never forced, never the default branch) and opens or updates the pull request with gh (`--repo` from
  origin's URL, the body on stdin); ask-owner opens it as a draft and asks, "Land now" marks it ready. It records
  `task.landed {pr, commit, target, method: "pr"}`, reuses an open pull request, records one merged on GitHub as
  landed and refuses one closed without merging. `landing` must be `"local"` or `"pr"`; `pushAfterLanding: true` with
  `"pr"` refuses. Local landing is unchanged.
- `riskyPaths` entries may be patterns: `*` within a name, `?` one character, `**` any number of folders
  (`clients/mcp-server/**`, `api/scripts/migrate*`, `**/migrations`); a pattern also covers everything below a folder it
  names. A path without a wildcard is a prefix, as before.
- The description and the policy sections are unchanged, so the policy hash is too; the Interface section documents
  the new mode.

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
