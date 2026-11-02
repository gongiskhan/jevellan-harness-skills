---
name: jevellan-runtime-claude
description: Runtime for Claude providers (kinds claude-subscription and claude-endpoint). Use when a session must start, resume, stop or check a task step on a Claude provider chosen by placement.
jh-role: runtime
jh-kinds: [claude-subscription, claude-endpoint]
---

# Runtime for Claude providers

Each step runs as its own `claude -p` session in the task's worktree, on the provider, model and effort that
placement chose, with the worker environment the scripts build (the provider's login, the hooks' variables, nothing
else). `<this skill>` below is this skill's base directory.

```
Start a step:  node <this skill>/scripts/start.mjs --task T --step N --duty D --cwd <worktree> --provider P --model M --effort E --prompt-file <task block file>
Resume a step: node <this skill>/scripts/resume.mjs --task T --step N --message "<text>"
Stop a step:   node <this skill>/scripts/stop.mjs --task T --step N
Check a step:  node <this skill>/scripts/status.mjs --task T --step N
start and resume return at once; the step runs in the background. Use the ledger skill to wait for its report.
```

If no skill in your list has that role (a skill's role is the first word of its description), call no skill at all: stop, tell the owner which role is missing, and do not improvise it.

## Details

- `--prompt-file` is optional: without it `start.mjs` builds the task block from the ledger (the task, the step's
  instructions from the recorded workflow, and the summaries of the earlier steps). With it, the file's text is used
  as the task block as it is.
- `resume.mjs` takes `--from owner` or `--from coordinator` (default coordinator): the message reaches the worker as
  "From the owner: ..." or "From the coordinator: ...". Use "Continue." after a progress report.
- Every script accepts `--json`. Exit codes: 0 ok, 2 refused with the reason (an unknown provider, a missing token
  file, a step that is still running), 3 not found.
- The worker's raw output goes to `~/.jevellan-harness/logs/<session>.log`; its report reaches the ledger through the
  ledger's Stop hook.

## Interface

What other skills' scripts may run, by role (runtime, for kinds claude-subscription and claude-endpoint). Every
script takes its input as arguments (nothing on stdin), prints one JSON object with `--json`, and on an error prints
`{"error", "exitCode"}` on stdout and the message on stderr. Exit codes: 0 ok, 2 refused with the reason (including a
missing role: the ledger, or the duty skill for the step's duty), 3 not found. resume, stop and status run with the
project (or a folder inside it) as their working folder.

- `start.mjs --task T --step N --duty D --cwd DIR --provider P --model M --effort E [--prompt-file F] --json` ->
  `{task, step, duty, session, pid, provider, model, effort, cwd, logFile, appendFile, staleReport}`; the worker runs
  detached; the ledger gets step.started and session.started.
- `resume.mjs --task T --step N --message TEXT [--from owner|coordinator] --json` -> `{task, step, session, pid, from,
  logFile}`; the ledger gets step.message and a new step.started.
- `stop.mjs --task T --step N [--reason TEXT] --json` -> `{task, step, pid, how, seq}`, `how` one of `SIGTERM`,
  `SIGKILL`, `not running`; the ledger gets step.stopped (`seq`).
- `status.mjs --task T --step N --json` -> `{task, step, state, pid, session, startedAt, model, effort, provider,
  ended, lastLine}`, `state` `alive` or `exited`, `ended` the kind of the line that ended the turn or null, `lastLine`
  the last thing the log says, with secrets masked.
