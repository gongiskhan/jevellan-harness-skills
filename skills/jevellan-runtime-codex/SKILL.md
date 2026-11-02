---
name: jevellan-runtime-codex
description: Runtime for Codex providers (kind codex-subscription). Use when a session must start, resume, stop or check a task step on a Codex provider chosen by placement.
jh-role: runtime
jh-kinds: [codex-subscription]
---

# Runtime for Codex providers

Each step runs as a `codex exec` turn in the task's worktree, on the model and effort that placement chose, under a
small parent process that records the turn's report when Codex ends (Codex runs no hooks). `<this skill>` below is
this skill's base directory.

```
Start a step:  node <this skill>/scripts/start.mjs --task T --step N --duty D --cwd <worktree> --provider P --model M --effort E [--prompt-file <task block file>]
Resume a step: node <this skill>/scripts/resume.mjs --task T --step N --message "<text>" [--from owner|coordinator]
Stop a step:   node <this skill>/scripts/stop.mjs --task T --step N
Check a step:  node <this skill>/scripts/status.mjs --task T --step N
start and resume return at once; the step runs in the background. Use the ledger skill to wait for its report.
```

If no skill in your list has that role (a skill's role is the first word of its description), call no skill at all: stop, tell the owner which role is missing, and do not improvise it.

## Details

- Codex signs in with the login in its `CODEX_HOME` (the provider's `codexHome`, else the owner's `~/.codex`). When
  that folder has no login, `start.mjs` refuses and names the owner's one-time command, `codex login`.
- The worker's instructions (the worker rules, the duty's instructions, AGENTS.md, the task block) go first in the
  first message, after "Instructions for this session:"; a resume sends only the message, "From the owner: ..." or
  "From the coordinator: ...", to the same Codex thread.
- Every script accepts `--json`. Exit codes: 0 ok, 2 refused with the reason, 3 not found. The raw event stream goes
  to `~/.jevellan-harness/logs/<session>.log`.

## Interface

What other skills' scripts may run, by role (runtime, for kind codex-subscription). Every script takes its input as
arguments (nothing on stdin), prints one JSON object with `--json`, and on an error prints `{"error", "exitCode"}` on
stdout and the message on stderr. Exit codes: 0 ok, 2 refused with the reason (including a missing role: the ledger,
or the duty skill for the step's duty), 3 not found. resume, stop and status run with the project (or a folder inside
it) as their working folder.

- `start.mjs --task T --step N --duty D --cwd DIR --provider P --model M --effort E [--prompt-file F] --json` ->
  `{task, step, duty, session, pid, provider, model, effort, cwd, logFile, appendFile, staleReport}`; `pid` leads the
  turn's process group (the runner and Codex); the ledger gets step.started, then session.started with the Codex
  thread id, and the turn's report when Codex exits.
- `resume.mjs --task T --step N --message TEXT [--from owner|coordinator] --json` -> `{task, step, session, threadId,
  pid, from, logFile}`; the ledger gets step.message and a new step.started on the same thread.
- `stop.mjs --task T --step N [--reason TEXT] --json` -> `{task, step, pid, how, seq}`, `how` one of `SIGTERM`,
  `SIGKILL`, `not running`; the ledger gets step.stopped (`seq`).
- `status.mjs --task T --step N --json` -> `{task, step, state, pid, session, startedAt, model, effort, provider,
  ended, lastLine}`, `state` `alive` or `exited`, `session` the Codex thread id (null until Codex announced it),
  `ended` the kind of the line that ended the turn or null, `lastLine` the last thing the log says, with secrets
  masked.
