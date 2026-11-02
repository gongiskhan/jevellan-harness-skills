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

## H-014 What every worker's --settings carries

Besides `claudeMdExcludes` (H-001), the worker settings set `attribution` to `{"commit": "", "pr": "", "sessionUrl":
false}`. Claude Code 2.1.316 adds an attribution trailer to commits by default (`includeCoAuthoredBy` is the deprecated
form of the same setting); the owner's rule is no attribution anywhere, and the worker rules alone would leave it to
the model to remember.

## H-015 Placement details

- `route.mjs --task-file F` reads only the task id from the file (its `task` or `id` field) and the task's lines from
  the ledger, so a stale file cannot give Jev a stale state; `--task T` is the same without the file.
- The state sent to Jev and stored passes through the ledger's redactor first.
- Provider kinds by need: a duty with no needs (answer, converse) runs on claude-subscription, claude-endpoint or
  openai-compatible; any other on claude-subscription, claude-endpoint or codex-subscription; then only the kinds an
  installed runtime skill lists in `jh-kinds`. The ranking keeps the reference's exclusion reasons and adds
  login-unknown, not-probed and not-configured. A provider with a missing or stale probe (12 hours) is probed before the
  menu is built (`checkProviders({only, jev: false})`).
- Every Jev decision is also written to `.jevellan/decisions/<task>-s<step>-<time>.json` (placement), `<task>-...`
  (workflow questions) and `<task>-landing-<time>.json` (landing): the state text, the questions, the answers, the
  usage and the latency. The ledger line names the file (`decisionFile`), because a 60 000-character state does not
  fit the 64 KB line rule next to everything else; the evals replay these files.
- `--owner <provider>/<model>/<effort>` records an owner placement (`source: "owner"`, no Jev call), for when the
  owner says where a step runs.
- The reference's owner rules file (rules.json) and visible tmux steps are not ported.

## H-016 Provider probe details

`providers.mjs check` reports Jev ready only when the key file is present, non-empty and mode 600 and the configured
model is listed (ported from the reference's checkJev). `JH_ANTHROPIC_URL` and `JH_JEV_URL` (test servers) are accepted
only for loopback addresses, so a token can only go to the real API or to this machine. The Codex probe never starts
`codex app-server` when the `CODEX_HOME` folder is missing (it would write state there), passes only the base
environment plus HOME and CODEX_HOME, and never forces a token refresh. Codex is reported "no runtime" until the Codex
runtime skill is installed (phase 6).

## H-017 Worktree and landing details

- `.claude` is excluded without a trailing slash: git matches `.claude/` against directories only, so the `.claude`
  symlink of every task worktree showed as untracked, a worker's `git add -A` would have committed it and landing
  would have refused the tree as dirty. install.mjs and worktree.mjs both write `.claude`.
- `project.json` `defaultBranch` is required by both git scripts (exit 2 naming the file); nothing guesses the branch
  people ship from. Invalid project.json fields refuse before any Jev call.
- A `landing.decided` stays open until a `landing.checked`, `task.asked` or `task.landed` follows it: an open
  verify-then-land with no verify step started after it answers exit 6 again without Jev; once such a step has
  `step.done`, the land route runs without asking Jev again (the skills run's D-046).
- A merge conflict on the land route becomes ask-owner; under `--force` it is exit 2 with the instructions for an
  implement step that merges the target and resolves the conflict, which the coordinator runs before landing again
  (the skills run's D-076, kept simple: the script never starts a step).
- A child task lands into its parent's branch in the parent's worktree (D-048). The fast-forward happens in the
  worktree that has the target checked out, after checking the touched files are clean there, else with
  `push . <branch>:<target>`; up to three rounds when the target moves meanwhile.
- `worktree.mjs archive` moves the worktree with `git worktree move` under `~/.jevellan-harness/archive/worktrees/`,
  keeps the branch, refuses while a step's process is alive, and appends `step.stopped` when the task has not landed.

## H-018 The workflow is recorded by the script, not written by hand

The coordinator does not compose the steps JSON. `ledger.mjs append task.workflow --task T --from-workflow
<workflow.json> --answers <placement's --questions output>` numbers the steps 1..n in file order, turns `onFail.goto`
into an ordinal (a duty name goes to the nearest earlier step with that duty), computes `skipped` from the `when:
jev:<id>` rules and the answers, and refuses a missing answer. `--add-step '{"duty","instructions"}'` (with `--force`
when a workflow exists) appends the extra verify step of verify-then-land at the next ordinal; it also works for a
`single` task, whose workflow then keeps step 1 as its own step. `--data-file F` (or `-`) replaces `--data` for JSON
with apostrophes. A single task with a recorded workflow or a landing decision is done only when it lands. The three
workflow.json files carry `onFail.goto` as ordinals (feature verify to 2, bug verify to 1, automation verify to 2).

## H-019 Which assignments the redactor masks

A `NAME=value` assignment is masked when one of the name's underscore-separated words is TOKEN(S), KEY(S), APIKEY,
SECRET(S), PASSWORD, PASSWD, PASS, AUTH, CREDENTIAL(S) or PAT. Matching the word inside the name masked
`GIT_AUTHOR_NAME` and `GIT_AUTHOR_EMAIL` (AUTHOR contains AUTH).

## H-020 answer and converse: one turn, no tools, the report from the answer

Brief 5.6 runs answer and converse on the Claude runtime with `--max-turns 1` and `--tools ""`. Such a session can
neither invoke its duty skill nor write `.jevellan/report.json`. So the runtime puts the duty skill's body in the
system prompt append instead of the "use the duty skill" sentence, and the Stop hook, for these two duties only, takes
the report from the fenced json block that ends the answer (`last_assistant_message` in the hook input); without a
valid block it records the answer itself as a done report, marked synthesized, as the skills brief's section 5 did for
its llm runtime. These duties are never blocked.

## H-021 Read-only duties may write their report file

Brief 5.3 gives investigate and plan `--permission-mode dontAsk --tools Read,Glob,Grep,WebSearch,WebFetch,Skill`, which
has no tool that can write `.jevellan/report.json`. The runtime adds Write and Edit to `--tools` and pre-approves only
`Write(./.jevellan/report.json)` and `Edit(./.jevellan/report.json)` (plus `./plan.md` for plan) with `--allowedTools`,
together with Read, Glob, Grep, WebSearch, WebFetch and Skill; in dontAsk mode every other write is denied. Verified in
phase 3 (findings).

## H-022 A step starts only where placement put it

`start.mjs` refuses (exit 2) unless the step has a `task.placed` line newer than its latest start (or than the retry
that reset it) naming exactly the provider, model and effort it was given, refuses a step that is running, done, or
of another duty than the recorded workflow says, and refuses a task without a worktree for every duty that may touch
files. `resume.mjs` reuses the start's provider, model, effort and session, and refuses beyond 20 resumes since the
step's latest placement.

## H-023 A worktree's setup command

A fresh worktree has no installed dependencies, so neither a worker nor the landing checks could run the sandbox's
tests there. `project.json` gains `setupCommand`, detected by install.mjs from the lockfile (`npm ci` for
package-lock.json, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `npm install` for a
package.json without a lockfile, else none). `worktree.mjs create` runs it once in the new worktree with the owner's
environment (no provider or Jev values), writes its output to `<worktree>/.jevellan/setup.log`, and leaves
`.jevellan/setup.done` on success; a failure is exit 2 after the worktree is recorded, and the next create of the same
task runs the setup again. The sandbox's project.json, written before this decision, got `"setupCommand": "npm ci"`
from the H1 journey. (The skills run had the same need, its D-039.)

## H-024 The sandbox copy starts from the baseline before the skills run's journeys

The live sandbox's main (43e279e) already holds the skills run's journey landings of 1 November: a README "How to run"
section, the empty state of the customers page, unit tests for the HTML helpers and more. Copied as it is, the
requests of H6 ("Add a How to run section to the README...") and H7 (the same three tasks the skills run landed) would
be no-ops, and the phase 4 implement step found its section already there. So the copy's main was moved back, before
any H6 or H7 run, to `61fc71a` ("Seed invoices and customers acceptance baseline", 13 October), the commit the skills
run started its journeys from; the later commits stay in the copy on the branch `skills-run-main`, and nothing was
deleted. At the baseline `npm test` (3 tests) and `npm run test:browser` (2 specs) pass with `TZ=UTC
SANDBOX_DATA_DIR=.sandbox-data`, and `npm run lint` is clean. The live sandbox itself is untouched.

## H-025 The Codex runtime's shape

- `start.mjs` returns at once after spawning `runner.mjs` detached (its own process group). The runner feeds the
  message to `codex exec --json -C <worktree> -m <model> -c model_reasoning_effort=<effort>
  --dangerously-bypass-approvals-and-sandbox -` on stdin (a long append never meets the argument size limit), copies
  the event stream to `~/.jevellan-harness/logs/<session>.log`, appends `session.started` with the thread id from
  `thread.started` as the native session id, and when Codex exits records the report the way the Stop hook does
  (valid: `step.report` and the file archived; invalid: blocked with the problem; none: blocked, synthesized). It
  cannot block a turn the way the hook does, so a missing or invalid report is recorded at once.
- `step.started` carries the runner's pid (the step is alive while the runner is) and `nativeSessionId: null`;
  `resume.mjs` reads the thread id from the session's `session.started` and runs `codex exec resume --json ...
  <thread> -` in the worktree (resume has no `-C`).
- Codex loads no Claude skills, so the duty skill's body is put into the first message instead of the "use the duty
  skill" sentence, after "Instructions for this session:".
- Every duty runs with approvals and the sandbox bypassed, as brief 5.3 says; investigate and plan are held to
  read-only by their instructions on Codex (the Claude runtime enforces it with its tool set, H-021).
- `CODEX_HOME` is the provider's `codexHome` or the owner's `~/.codex`; `start.mjs` refuses when that folder has no
  `auth.json` and names `codex login`. No `auth.json` is copied, read or refreshed by these scripts.
- The shared runtime code lives in identical copies of `scripts/lib/{common,task,prompt,proc,cli,roles}.mjs` in both
  runtime skills; `scripts/check-roles.mjs` refuses copies that differ.

## H-026 Where the coordinator journeys run

H6 asks three times for the same README section, which only makes sense on a project that lacks it, so each H6 run
uses a fresh clone of the sandbox at its baseline (`~/jevellan-projects/jevellan-harness-runs/h6-r<n>-.../
jevellan-harness-sandbox`, installed like the sandbox). H7, H8 and H9 run on the sandbox itself, whose main then holds
what they landed; H7's README task is the same work as H6's request, so the sandbox's main gets that section from H7.
The coordinator is started as the brief says, `claude --permission-mode bypassPermissions` in the project folder under
the owner's login, plus `--session-id <uuid>` so the journey can read its transcript
(`~/.claude/projects/<folder>/<uuid>.jsonl`) for the Skill invocations and the slip count. The first run's slip
analysis read the lines of a heredoc brief as shell redirects (two false slips); the analyser was fixed to skip
heredoc bodies and run 1 was re-analysed from its saved transcript, which is recorded in
`acceptance/results/H6-runs.json` with the reason.

## H-027 The coordinator numbers a question's options

In the first H8 run the coordinator ended its reply with "1. T2XWRMC ...: Blue or Green? Options: Blue, Green.": the
question numbered, as the brief's body says ("those questions, numbered, each with its task and options"), but not its
options, so the owner's "1" could mean the question or the first option (it happened to resume with Blue). H8 asks for
numbered options, so the coordinator body's "Running a task" section now says to number the options of a step's
question ("1) Blue 2) Green"), to letter them when several questions are open, and to map the owner's answer back to
the option's label before resuming the step from the owner. H8 was run again on a fresh baseline clone after the
change, because the sandbox's README already carried the first run's line.

## H-028 Landing runs a worktree's missing setup before its checks

In the first H8 run the sandbox's project.json still lacked `setupCommand` (the H1 journey adds it, but H1 had not run
again since H-023), so the document step's worktree had no dependencies and the landing check `npm test` failed with
"Cannot find package 'vitest'". The coordinator handled it on its own (an extra verify step that installed and tested,
then a second landing), but the cause was the setup. `land.mjs` now runs the project's `setupCommand` in the
worktree before the checks whenever `.jevellan/setup.done` is missing (a worktree made before the project had a setup
command, or one whose setup failed), records a failure as a failed `landing.checked`, and the sandbox's project.json
has `"setupCommand": "npm ci"`.
