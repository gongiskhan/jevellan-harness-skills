# Decisions

Choices the brief left open or that the machine forced, numbered from H-001, append-only. Each says what and why.

## H-001 Workers run with their own Claude config folder and without the owner's personal instructions

Section 5.3's worker environment passes HOME through and names no config folder, so a worker would load the owner's
`~/.claude/settings.json` (PreToolUse, Stop, SessionStart and SessionEnd hooks, seven plugin entries, auto memory,
an advisor model), write its transcripts, `.claude.json` and memory into the owner's `~/.claude`, and read the owner's
`~/.claude/CLAUDE.md` and `~/.claude/rules/*.md` (docs/findings.md: a worker answered "Caveman mode" present). None of
that is the worker's brief, and the owner's hooks would run once per tool call of every worker. So `lib/env.mjs`
adds `CLAUDE_CONFIG_DIR=~/.jevellan-harness/claude-config` (mode 700, created on first use) and every worker gets
`--settings '{"claudeMdExcludes":["<owner home>/.claude/**"]}'`. HOME stays the owner's, so git, gh, `~/.gitconfig`
and the Playwright cache work as before. `--setting-sources project,local` was tried instead and does not keep the
ancestor rules out (findings), and `--bare` and `--safe-mode` would drop the project hooks the ledger depends on.
What a worker is told is therefore exactly section 6: the worker rules, its duty, the project's `AGENTS.md` and the
task block. This follows the skills run's D-058 and D-070, which kept the owner's personal rules out of workers for
the same reason. The coordinator is the owner's own session and keeps the owner's configuration untouched.

## H-002 The sandbox's test command

The sandbox's tests need `TZ=UTC` and `SANDBOX_DATA_DIR` by design, and its bare `npm test` fails (findings, and the
skills run's D-066). `install.mjs` detects `npm test` as section 7 says; the journey setup then writes `testCommand`
`TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test` into the sandbox's `.jevellan/project.json`, so landing checks and
workers run the suite the way it passes. Nothing in the sandbox's own files changes for it.

## H-003 providers.json points at the harness's own secret files

Section 8 says to copy `~/.jv/providers.json` and drop the `home` fields. Its `keyFile` and `tokenFile` values name
files under `~/.jv/secrets/`; read at runtime they would make the harness depend on the skills run's folder, which
section 0 and section 8 forbid. The copy rewrites the prefix `~/.jv/secrets/` to `~/.jevellan-harness/secrets/`,
where phase 0 copied the three files that exist (`jev.key`, `claude-main.token`, `claude-second.token`). Entries
whose key files do not exist (`glm`, `deepseek`, `kimi`) and the `openai-compatible` kind (no runtime skill this
night) are kept in the file and left out of the placement menu by the router, with the reason in its output.

## H-004 Where the reference checkout lives

The skills repo is cloned from GitHub `main` (3284dd5) into `~/.jevellan-harness/reference/jevellan-skills`, read
only. The owner's `~/dev/jevellan-skills` checkout is never opened, so nothing this run does can touch the other
run's working tree. Nothing under `skills/` reads the reference at runtime.

## H-005 The worker prompt always follows `--`

`--tools` and the other list flags of Claude Code take every following word (findings). Every `claude` command line
the runtime builds ends with `--` and then the prompt, so a prompt can never be read as a tool name.

## H-006 Manual probes stand in for providers.mjs check before phase 2

Section 8 asks `providers.mjs check` to show both Claude providers ready and Jev reachable before phase 1 starts, but
`providers.mjs` is a phase 2 script. Phase 0 ran the same probes by hand (a one-turn `claude -p` per token, `GET
/v1/models` for Jev; findings) and records the result in the status file; phase 2 reruns them through
`providers.mjs check`.

## H-007 The Stop hook is the report path for Claude workers

Phase 0 verified that Claude Code 2.1.316 runs Stop hooks in `-p` mode and honours `decision: block` there
(findings). So `stop.mjs` records reports for Claude workers in `-p` and in interactive sessions alike, and the Claude
runtime's `start.mjs` returns at once instead of staying alive to run the hook's logic at exit (section 4's
fallback is not needed). The Codex runtime keeps its small parent process, because Codex runs no Stop hook.

## H-008 The projection rules, as implemented

Section 4's rules are applied in this order: stopped, done, waiting-owner, landing, failed, running, queued. Four
places needed a reading:

- waiting-owner comes before landing. Read literally, "landing if landing.decided exists without task.landed" would
  catch every ask-owner landing (land.mjs writes `task.asked` after `landing.decided`), and the waiting-owner clause
  "task.asked is the last landing event" could never apply. A needs-decision report from the extra verify step of
  verify-then-land is waiting-owner too.
- A `single` task is done when its step reports done, unless its duty writes (implement, document, verify, automate)
  and the report lists changed files: such a task still has commits to land, and stays open (next: land) until
  `task.landed`. The skills run found the same problem (its D-078): a single document task left its README change on
  the task branch.
- failed also covers `step.lost` as the last step event (the step's process is gone), and a failed `landing.checked`
  as the last landing event with no step activity after it.
- stopped is decided by lifecycle events only: `session.*` lines and notes written after a stop do not reopen a task.
- A step's state is decided by the last end event after its latest start (a `step.failed` appended after a blocked
  report fails the step); a `step.retrying` with `gotoOrdinal` returns that step and every later one to pending, and
  `step.done` is cleared by a new start of the same step. A task is running when any step's latest start has no end.

`status` leaves stopped tasks out of the open list and lists done and stopped tasks of the last 24 hours as recent.
Each open task carries a `next` hint for the coordinator (make the worktree, resolve the workflow, record step.done,
resume, place the next step, land).

## H-009 What a session may append by hand

`ledger.mjs append` accepts only `note`, `step.message`, `task.workflow`, `step.done`, `step.failed` and
`step.retrying`; every other kind is written by the script or hook that owns it (task create, route.mjs,
worktree.mjs, start.mjs, the hooks, land.mjs), so a session cannot fake a placement, a report or a landing. The hand
kinds are guarded inside the ledger lock: `step.done` is refused unless the step's last report since its latest start
is done with no failing `testsRun`; `step.retrying` is refused beyond the step's `onFail.maxLoops` or with a
`gotoOrdinal` other than its `onFail.goto`; a second `task.workflow` needs `--force`. `--force` on `step.done` is
recorded as `forced: true`.

## H-010 The SessionStart hook names the coordinator role

For a session that is not a worker, in a project with `.jevellan/` (an installed project), the hook prints one line
before the open work: "This project's work runs through the coordinator skill: use it for any request to do, plan,
track or report on work here." Section 0's first idea is that an explicit "use the X skill" in loaded context is
followed far more reliably than a description match; the owner's interactive session is the head of the chain, so
the hook gives it that sentence too. It prints the role line even before a ledger exists, and "Open work in this
project's ledger: none." when there is no open task. It also appends `session.started` with role coordinator for
`startup` and `resume`, so restarts (H9) are visible in the ledger.

## H-011 Stop hook details

The block counts live in `.jevellan/locks/stop-<session>.count` as `{promptId, missing, invalid}`; a new `prompt_id`
(a resumed turn) starts them again, so a resumed step gets its two blocks again. The hook acts only when the hook
input's `session_id` equals `JH_SESSION` (a session started inside a worker inherits `JH_TASK` and must not report for
it). A report is looked for in the hook's `cwd` and at the top of the worktree holding it. An invalid report that is
recorded as blocked is archived as `<task>-s<step>-<time>-invalid.json`, so the evidence stays. After recording a
report the hook appends `session.ended` for the worker's session. The invalid-report block reason is the problem
followed by "Fix .jevellan/report.json and end your turn again."

## H-012 Lock staleness and the redactor

A ledger lock whose holder pid is gone is taken over at once; one older than 10 s is stale even with a live pid
(only a reused pid can hold it that long). Breaking goes through a `.break` guard file; a waiter that finds the guard
held sleeps instead of spinning, and a stale lock is always broken in the end, so a Stop hook never loses a report
to a crashed writer. Every appended line passes through `lib/redact.mjs`, which masks the values of every file in
`~/.jevellan-harness/secrets/` and every key or token file providers.json names, `NAME=value` assignments whose name
says token, key, secret, password or auth (written `NAME:[redacted]`), and Bearer tokens. Hook logs go through the
same redactor.

## H-013 install.mjs details

The forbidden folders of section 7 are refused also when the path is anywhere under one of them, under both the
`dev/` and `Projects/` spellings, and after resolving symlinks; the owner's home comes from the user database, never
from HOME. A linked worktree is refused (install into the main checkout). A skill folder whose content already
matches is not rewritten; a changed one, and a `jevellan-*` folder the package no longer has, is moved to
`~/.jevellan-harness/archive/skills/` first. settings.json is merged by content and written atomically, only when it
changes; an unparsable settings.json is refused untouched, because Claude Code silently ignores invalid settings in
`-p` mode and the ledger would stop without a word. `devCommand` falls back to `npm start` when there is no `dev`
script (the sandbox has only `start`). A hook path containing quotes, `$`, backticks, backslashes or newlines is
refused for a full install.
