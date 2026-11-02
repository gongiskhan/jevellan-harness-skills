---
name: jevellan-workflow-bug
description: "Workflow bug. Use when the coordinator is about to run a task of kind bug: it gives the ordered steps, their duties and instructions, and the retry rule."
jh-role: workflow
jh-kind: bug
---

# Workflow: bug

Steps for a bug task are in workflow.json next to this file; read it. Before step 1, use the placement skill with --questions to learn which optional steps apply, and use the ledger skill to record the resolved steps (task.workflow). Then for each step in order: use the placement skill, use the runtime skill for the provider kind it chose, use the ledger skill to wait for the report. On done, record step.done with the ledger skill and go on. On a verify report with testsRun.passed false, or a failed or lost step: apply onFail (go back to the named step with a new placement; attempts carry the failure summary) at most maxLoops times, then tell the owner. A project overrides this file by placing .jevellan/workflows/bug.json; use that one when it exists and say so.

If no skill in your list has that role (a skill's role is the first word of its description), call no skill at all: stop, tell the owner which role is missing, and do not improvise it.

## Recording the steps

The ledger skill builds the task.workflow line itself from the workflow file and placement's answers; never write the steps by hand. Save what placement printed for `--questions` to a file, then use the ledger skill to append:

```
append task.workflow --task T --from-workflow <this skill>/workflow.json --answers <that file>
```

With a project override, pass `.jevellan/workflows/bug.json` as `--from-workflow` instead. The steps are numbered in file order, and skipped steps keep their number; that number is the step's ordinal for placement, for the runtime and in the ledger. For this file: 1 implement, 2 verify (on failure back to step 1, at most twice). The questions it depends on: none, so --answers may be left out.

A retry is recorded on the step that failed, before the step it goes back to is placed again: use the ledger skill to append `step.retrying --task T --step <failed ordinal>` with `--data-file <file>` holding `{"attempt": <1 for the first retry of that step, then 2>, "gotoOrdinal": <its onFail goto>, "reason": "<what failed, in one sentence>"}`. The ledger refuses a retry beyond maxLoops, and for a step without onFail; then tell the owner. A failed or lost step without onFail is not retried that way: place it and start it again.

When the git skill's landing answers verify-then-land, use the ledger skill to add the extra verify step as the next ordinal (3 for this file):

```
append task.workflow --task T --force --add-step '{"duty":"verify","instructions":"Full verification before landing: run the whole test command and every browser journey the change could affect."}'
```

Then place it, start it and wait for its report like any other step, record step.done, and use the git skill to land the task again. The extra step has no onFail: when it fails, tell the owner.
