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

If no skill with that role is installed, stop, tell the owner which role is missing, and do not improvise it.

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
