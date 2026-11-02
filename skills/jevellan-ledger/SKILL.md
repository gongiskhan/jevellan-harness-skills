---
name: jevellan-ledger
description: Ledger. Use when a session must create a task, record a note or a standing preference about how work runs, record or read what happened to a task, wait for a step's report, or show status. The ledger is the only durable state; its hooks record sessions automatically.
jh-role: ledger
---

# Ledger

The project's ledger is `.jevellan/ledger.jsonl` at the project root: one line per event, append-only. It is the
only durable state of the work in this project. `<this skill>` below is this skill's base directory.

```
Create a task:        node <this skill>/scripts/ledger.mjs task create --kind <kind> --title "<title>" --text-file <file> [--parent T] [--after T]
Status:               node <this skill>/scripts/ledger.mjs status
A task's history:     node <this skill>/scripts/ledger.mjs show T
A step's report:      node <this skill>/scripts/ledger.mjs report T --step N
Wait for a report:    node <this skill>/scripts/ledger.mjs wait --task T --step N   (run it in the background; it returns when the report arrives, with the report)
Record a note:        node <this skill>/scripts/ledger.mjs append note --data '{"text":"..."}'
```

Everything a session does is recorded by this skill's hooks; you never append step events yourself except note and
step.message.

## Details

- Kinds of task: `feature`, `bug`, `automation`, or `single` with `--duty <duty>` for one-step work (duties: answer,
  converse, investigate, plan, implement, document, verify, automate). Write the brief to a file first and pass it
  with `--text-file`; `--text-file -` reads it from stdin. The same open task created twice is one task: the second
  call prints the existing id.
- `status` lists every open task, waiting-owner first, with its current step, the question and options when it
  waits on the owner, and a `next:` hint. `status --json` gives the same as data. A step whose process is gone without
  a report is marked lost here.
- `wait` exits 0 with the report, 4 when the step failed, was lost or was stopped, and 5 on timeout (default 7200 s,
  `--timeout S`). Run it in the background and carry on with other work.
- Besides note and step.message, the workflow's bookkeeping is appended by hand, each refused when it does not fit
  the ledger:
  - the resolved steps, built by the script from a workflow file and placement's answers:
    `append task.workflow --task T --from-workflow <workflow.json> --answers <file or JSON>`; one more step at the
    next ordinal (the extra verify step of verify-then-land, also for a single task):
    `append task.workflow --task T --force --add-step '{"duty":"verify","instructions":"..."}'`
  - a done step: `append step.done --task T --step N` (refused unless the step's last report is done with no failing
    tests)
  - a failure: `append step.failed --task T --step N --data '{"reason":"..."}'`
  - a retry: `append step.retrying --task T --step N --data '{"attempt":1,"gotoOrdinal":2,"reason":"..."}'` (refused
    beyond the step's maxLoops, for a step without onFail or one that did not fail, and while a worker of the task runs)
  - a message to a step: `append step.message --task T --step N --data '{"direction":"owner","text":"..."}'`
- `--data-file F` (`-` for stdin) may replace `--data` whenever the JSON holds apostrophes or is long.
- Every command accepts `--json`. Exit codes: 0 ok, 2 refused with the reason on stderr, 3 not found.
- Tasks, worktrees, workflows, placements, starts, reports and landings are written by the scripts and hooks of the
  skills that own them; `append` refuses those kinds.
