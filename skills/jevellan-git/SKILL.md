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
