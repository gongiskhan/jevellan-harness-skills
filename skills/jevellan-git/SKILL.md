---
name: jevellan-git
description: "Git. Use when a task needs its worktree created or removed, or when a finished task must be landed on the project's default branch. Landing is guarded: it refuses when steps are not done, the tree is dirty or the checks fail."
jh-role: git
---

# Git

Every task works in its own git worktree on its own branch; nothing edits the project's main checkout except
landing. `<this skill>` below is this skill's base directory.

```
Make a worktree:  node <this skill>/scripts/worktree.mjs create --task T [--base <branch>]     prints the path; branch jh/<slug>-<T>; .claude linked from the project
Remove one:       node <this skill>/scripts/worktree.mjs archive --task T                      moves it to ~/.jevellan-harness/archive/, never deletes
Land a task:      node <this skill>/scripts/land.mjs --task T [--force]
```

What `land.mjs` answers, by exit code:

- 0: landed. The default branch (or, for a child task, its parent's branch) now holds the task's commits; the ledger
  has `task.landed`.
- 2: refused, with the reason: a step is not done, the worktree has uncommitted changes (named), a check failed (its
  output tail), or Jev refused. Nothing moved.
- 6: `{"route":"verify-then-land"}`. Run one more verify step with the instructions "Full verification before
  landing: run the whole test command and every browser journey the change could affect." and call `land.mjs` again
  once it is done; the second call lands without asking Jev again.
- 7: ask-owner. The ledger has `task.asked` with the options "Land now" and "Leave it" and the reason. "Land now" is
  `land.mjs --task T --force`; "Leave it" is `worktree.mjs archive --task T`, which ends the task.

Use `--force` only when the owner said "Land now" for this task. The script never pushes unless the project's
`project.json` sets `pushAfterLanding` to true.

## How this policy works

`land.mjs` asks Jev one question, landing_route, with the landing state of the task: its title, kind and text, the
final step summaries, the changed files with their additions and deletions, the checks that already ran and whether
they passed, the corrections the task needed (retries and their reasons), and riskyAreas, the project's risky paths
from `.jevellan/project.json`. The script reads three sections of this file: "landing_route" is sent as the
question's instructions, "routes" holds one criterion line per route ("<route>: <criterion>", nothing else), and
"rules" is sent with the state as the standing rules. Everything outside those three sections, this paragraph
included, is for people and is ignored by the script. Every landing decision is a `landing.decided` line in the
ledger with the policy hash and the probabilities; `evals/` replays the policy against them.

## landing_route

Choose how this checked task reaches the project's default branch. Judge it from what changed (the files, their size, and whether any of them falls in a risky area), from what the checks that passed actually exercise, and from the corrections the task needed on the way. Landing puts the change on the default branch, where the owner releases it later; it deploys nothing. Production behaviour, in the routes, means deployed systems, live data, credentials, billing, infrastructure and deploy configuration, not the ordinary feature, UI, test or documentation changes every task makes. A small change outside the risky areas that the passing checks cover lands; a behaviour change the checks do not exercise is verify-then-land. When two routes fit about equally, choose the more cautious one.

## routes

land: Small or low-risk change outside the project's risky areas, covered by the checks that passed.
verify-then-land: A behaviour change the checks do not exercise, or a medium-sized change, outside the risky areas.
ask-owner: Touches a risky area, changes stored data or production behaviour, or is large or hard to undo.

## rules

Risky areas. A change touches a risky area when any changed file, or the behaviour the summaries describe, involves one of these: stored data (database schemas, the shape of records and files the application keeps, data formats other systems read or write); authentication, sessions, permissions and credentials; money (payments, billing, prices, invoices, refunds); deletion (anything that removes, purges or overwrites data or files people keep); concurrency (locks, queues, background workers, retries, jobs that run in parallel); migrations of any kind (schema, data, configuration); and any changed file under one of the project's risky paths, listed in riskyAreas. A path or file name that suggests one of them (migrat, auth, login, credential, pay, billing, delete, remove, lock, queue) counts as touching it unless the summaries show plainly that it does not. A change that only displays something about one of them (a heading or a total shown on a page that lists orders, a currency label next to a price) without changing how it is computed, stored, charged or sent does not touch it.

Production. Production behaviour means what deployed systems do with live data, credentials and billing, and how they are built and run: deploy scripts, CI workflows, infrastructure, and environment and deploy configuration. A change to any of those is a change to production behaviour and goes to the owner however small it is, because no check that runs before landing exercises a deployed system. Ordinary feature, UI, test and documentation changes are not: they land on the default branch, and the owner releases them later. Such a change, small and outside the risky areas, lands when the passing checks cover it; when it changes behaviour the checks do not exercise, it is verify-then-land.

Size. Small is at most two files and about a hundred changed lines; large is more than twelve files or more than about a thousand changed lines; medium is everything in between. Generated files and lock files count for little; tests count for less than the code they test.

Checks. A check counts as coverage only when it passed on this branch and exercises the changed behaviour. No checks, or a verify report whose tests did not pass, is no coverage. Tests added by the task cover what they assert, not the whole change.

Corrections. A task that needed retries (a verification failed and was fixed) leans one route more cautious, unless the final checks plainly cover what failed.

Documentation-only and test-only changes outside the risky areas whose checks passed land.

## Interface

Not policy: this section is neither sent to Jev nor part of the policy hash.

The scripts take arguments only (nothing on stdin). With `--json` they print the JSON shown; a refusal prints
`{"error", "exitCode"}` on stdout and the reason on stderr. Every command needs an installed skill with the ledger
role; `land.mjs` asking Jev also needs one with the placement role (`--force` and the verify-then-land continuation do
not). A missing role is exit 2: "no installed skill has the role <role>; tell the owner which role is missing and do
not improvise it".

- `worktree.mjs create --task T [--base <branch>] [--json]` -> `{path, branch, base, baseCommit, setup?}`, without
  `--json` the path alone. `setup` is `{command, ms}` when the project setupCommand ran in a new worktree, and the
  command when it ran in an existing one. Exit 0 made, or already there; 2 refused (a parent without a worktree, a
  branch or folder in the way, a failed setupCommand, and with `"landing": "pr"` a failed `git fetch origin` or an
  origin without the default branch); 3 no such task.
- `worktree.mjs archive --task T [--reason "..."] [--json]` ->
  `{archived: true, already, from, to, branch, stopped}`. Exit 0 archived, or archived before; 2 refused (a step is
  running, the worktree is locked or not registered); 3 no such task, or the task has no worktree.
- `overlap.mjs --task T [--checkpoint intake|step|landing] [--days N] [--json]` -> `{task, checkpoint, verdict, base,
  originHead, since, checkedAt, paths, items, newCommits, looked, gh, recorded}`: has this task's work already been
  done, or is it being done, elsewhere? After `git fetch origin` it lists the default branch's commits (the first
  check of a task: the last N days, 7 by default; a later one: only what arrived since the previous check, or since
  the task's branch started), the pull requests (open, and merged in the last N days; a later check only those opened,
  updated or merged since; never the task's own) and the project's other open tasks. An item is related when it
  changes a path the task names (the brief's file paths, plan.md's scope block, the files the branch changed) or its
  title shares most of its words with the task's (`filesOverlap`, `words`, `textScore`, `textRelated`). `verdict` is
  `none` or `possible`; `items` are the related ones (kind `merged-pr`, `open-pr`, `commit` or `task`, with number,
  commit, title, url, files). Judging them (nothing, part of the task, all of it) is the caller's. Each run is recorded
  as a note on the task (`data.overlap`, with the items and where it stopped). gh missing or failing is not a refusal:
  `gh.available` is false with the reason, and the rest runs. Exit 0; 2 refused; 3 no such task.
- `land.mjs --task T [--force] [--json]` -> by exit code:
  0 landed, `{task, route: "land", landed: true, commit, target, method, forced, reason, checks, push}` with
  `checks` as `[{name, command, passed, exitCode, timedOut, durationMs, round}]`, or
  `{task, landed: true, already: true, commit, target}` for a task that landed before;
  2 refused; 3 no such task;
  6 verify-then-land, `{"route":"verify-then-land"}` (with `--json` also `task, reason, instructions, again`);
  7 ask-owner, `{task, route: "ask-owner", question, options, reason}`.

Landing by pull request. `.jevellan/project.json` `"landing"` is `"local"` (the default: everything above) or `"pr"`.
With `"pr"`, a task without a parent never touches the local default branch, which may be far behind origin, and the
sentence above about pushing describes local landing only:

- `worktree.mjs create` runs `git fetch origin` and starts the task branch from `origin/<defaultBranch>`; `base` is
  `"origin/<defaultBranch>"`.
- `land.mjs` checks the steps and the worktree as above, looks up the branch's pull request with `gh pr list` (one
  merged on GitHub: exit 0, `{task, route: "land", landed: true, pr, merged: true, commit, target, method: "pr"}`; one
  closed without merging: exit 2), runs `git fetch origin`, refuses a branch with no commits beyond
  `origin/<defaultBranch>`, and decides as above (the changed files are taken against `origin/<defaultBranch>`). The
  land route merges `origin/<defaultBranch>` into the task branch, runs the checks, pushes the task branch to origin
  (never forced, never the default branch) and opens a pull request with `gh pr create --base <defaultBranch> --head
  <branch>`, or updates the open one's body and marks a draft ready. Exit 0 prints `{task, route: "land", landed: true,
  pr, draft: false, commit, target, method: "pr", forced, reason, checks, push}` and the ledger gets `task.landed
  {pr, commit, target, method: "pr"}`. The title is the task's title; the body holds the final step summaries, the
  checks and their results, the tests the steps ran and the evidence. Nothing merges the pull request or deploys.
- ask-owner opens the pull request as a draft first, then exit 7 adds `pr` and `draft` (and `checks`) to the JSON and
  `pr` to `task.asked`. "Land now" (`--force`) checks again and marks the pull request ready for review; "Leave it"
  archives the worktree and leaves the draft open on GitHub for the owner. A merge conflict with
  `origin/<defaultBranch>` is ask-owner too: the branch is pushed as it is and the draft says the checks did not run.
- `pushAfterLanding` must be false. A child task still lands into its parent's branch locally and is never pushed.

Guards before the decision (both landing modes unless said; without `--force`, which is the owner's "Land now"): the
route becomes ask-owner without asking Jev, recorded as `landing.decided {route: "ask-owner", source, reason}`, and by
pull request the draft says why.

- `source: "scope"`: plan.md's ```scope block (paths and patterns, one per line, with riskyPaths' rules) against the
  files the branch changed: more than two files outside it, or any outside file that is not a test or fixture.
  Tolerated outside files are listed in the pull request under "Outside the plan's scope". No plan.md or no block is
  nothing to compare.
- `source: "overlap"` (by pull request only): `overlap.mjs`'s check at checkpoint landing, before origin is merged in:
  an item new since the task's last check that changes files this branch changes and shares the task's intent
  (`textRelated`). It is recorded as a note.
- `source: "checks"`: a landing check fails, and the task's reports have a follow-up (`followUps[]`, kind
  `unrelated-failure` or `host`) whose test file or error code the check's output shows: "a check fails outside this
  task's scope: <titles>". By pull request the branch is pushed and the draft lists the failed check. With `--force`
  landing goes on despite such a failure. Any other failing check refuses as before.

The pull request body also has "Decisions taken" (the reports' `decisions[]`), "Follow-ups" (`followUps[]`) and
"Outside the plan's scope" when there are any.
- gh runs with `--repo` taken from origin's URL and the owner's HOME; without gh, or with an origin URL that names no
  host, owner and repository, landing refuses (exit 2).
