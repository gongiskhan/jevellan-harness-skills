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
