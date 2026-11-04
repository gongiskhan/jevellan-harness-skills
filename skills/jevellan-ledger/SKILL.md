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
Ask the owner:        node <this skill>/scripts/ledger.mjs ask --task T --data-file <file>
Record the answer:    node <this skill>/scripts/ledger.mjs answer --task T --text "<what the owner said>" [--option "<label>"]
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
- A question for the owner about a task (not landing's, which landing records itself) goes through `ask`, with a JSON
  file `{"question": "...", "options": [{"label": "...", "means": "..."}], "recommended": "<a label>", "reason": "..."}`:
  the question opens with one or two plain sentences on what the task is and why the question exists; each option
  says what it means for the owner; `recommended` is the option you recommend, which is also what you do when the
  owner's reply does not choose. Question and options together stay under 120 words; ids only with a plain
  description next to them. `ask` refuses a second question while the task's last one has no answer: record the
  owner's reply with `answer` first. The task shows as waiting on the owner until the answer.
- `--data-file F` (`-` for stdin) may replace `--data` whenever the JSON holds apostrophes or is long.
- Every command accepts `--json`. Exit codes: 0 ok, 2 refused with the reason on stderr, 3 not found.
- Tasks, worktrees, workflows, placements, starts, reports and landings are written by the scripts and hooks of the
  skills that own them; `append` refuses those kinds.
- The scripts of other skills run this skill's `ledger.mjs` as a process with `--json` (see Interface): they read with
  `show T --json` and `events`, write their own kinds with `record` and a worker's report with `take-report`, and pass
  `--if-last-seq` with the `lastSeq` they read, so a line written meanwhile refuses the append (exit 6).

## Interface

What a session or another skill's script runs: `node <this skill>/scripts/ledger.mjs <command>`, in the project or a
folder inside it (the project root is found through git, or `JH_PROJECT`). Input is arguments, and stdin where a
`-` file is given. With `--json` every command but `tail` prints one JSON object, and a refusal prints
`{"error", "exitCode"}` on stdout and the reason on stderr. A line "as written" is
`{seq, t, kind, task?, step?, session?, data}`.

- `ledger.mjs task create --kind feature|bug|automation|single [--duty D] --title "..." (--text "..." | --text-file F|-)
  [--parent T] [--after T] [--origin owner|coordinator] --json` -> `{task, kind, title, seq, existing: false}`, or
  `{task, kind, title, state, existing: true}` when the same task is still open.
- `ledger.mjs append <kind> [--task T] [--step N] [--session S] (--data JSON | --data-file F|-) [--force]
  [--if-last-seq N] --json` -> the line as written. Only the hand kinds note, step.message, task.workflow (also
  `--from-workflow F --answers F|JSON` or `--add-step JSON`), step.done, step.failed and step.retrying, each checked
  against the task's lines (exit 2 with the reason).
- `ledger.mjs ask --task T (--data JSON | --data-file F|-) --json` -> the task.asked line as written, data
  `{question, options: [labels], meanings: {label: means}, recommended, reason, source: "coordinator", words}`. Exit
  2 when the shape is wrong (2 to 4 options with label and means, recommended one of the labels, at most 120 words in
  all) or the task's last coordinator question has no answer yet.
- `ledger.mjs answer --task T --text "..." [--option LABEL] --json` -> a note `{text, answerTo: <seq of the
  question>, option, answer}`. Exit 2 when the task has no open coordinator question or the option is not one of its
  labels.
- `ledger.mjs record <kind> --task T [--step N] [--session S] (--data JSON | --data-file F|-) [--if-last-seq N] --json`
  -> the line as written. The kinds the skills' scripts own: task.worktree, task.placed, step.started (`--step`),
  step.stopped (`--step`), session.event, session.started, session.ended, landing.decided, landing.checked,
  task.landed, task.asked. Only the shape is checked; what the line means is the caller's guard. A worker's report
  goes through `take-report` (or the Stop hook), which checks it against the report schema.
- `ledger.mjs show T --json` -> the task's projection `{task, kind, duty, title, parent, after, origin, createdAt,
  updatedAt, worktree, workflowResolved, steps: [{ordinal, duty, state, starts, model, effort, provider, pid,
  nativeSessionId, startedAt}], currentStep, state, reason, waiting?, landing?, runningStep?, alive?, landedCommit?, landedPr?}`
  (`waiting.source` is `coordinator` for an open `ask` question, with `meanings` and `recommended`; `step` for a
  needs-decision or blocked report; `landing` for land.mjs's question)
  (`landedPr`, the pull request's URL, when the task landed by pull request)
  plus `text` (the brief), `lastSeq` (the task's newest seq), `views` and `events` (the task's lines). `views` is
  `[{ordinal, resetSeq, current, overall}]` for each ordinal from 1 to the highest a workflow, a placement or a step
  event names (step 1 for a single task; gaps are filled up to ordinal 100, and a higher ordinal that is named still
  gets its own view); `current` reads the step since its last retry reset, `overall` all its lines, each
  `{state, starts, started, end, done, lastReport, placed}` with the seq of each event, or null. An ordinal without a
  view has nothing: pending, no starts, every event null.
- `ledger.mjs events [--task T]... [--kind K]... [--since SEQ] --json` -> `{lastSeq, events}`: the lines, narrowed;
  `lastSeq` is the newest seq of the whole ledger (0 when it is empty).
- `ledger.mjs status [--brief] --json` -> `{tasks, recent, lost}`: the open tasks' projections with `next`, the tasks
  finished in the last 24 hours, and the steps this call marked lost (it appends step.lost for a worker whose process
  is gone without a report).
- `ledger.mjs report T [--step N] --json` -> `{task, step, seq, t, session, status, summary, ...}`, the newest report
  (exit 3 when there is none yet).
- `ledger.mjs wait --task T [--step N] [--timeout S] --json` -> `{kind, task, step, seq, ...data}` of what ended the
  step: exit 0 a report, 4 step.failed, step.lost or step.stopped; exit 5 `{timeout: true, task, step}`.
- `ledger.mjs take-report --task T --step N --session S --cwd DIR [--native-session ID] [--ended "text"] --json` ->
  `{task, step, seq, status, synthesized, reportFile, sessionEndedSeq}`: what the Stop hook does, for a runtime whose
  agent has none, once the turn's process has ended. `<cwd>/.jevellan/report.json` (DIR absolute) becomes step.report
  and moves to `.jevellan/reports/`; an invalid one is recorded blocked and synthesized with the problem in limitations
  and archived with `-invalid`; none is recorded blocked and synthesized with limitations "<ended> and no
  .jevellan/report.json". Then session.ended `{nativeSessionId, reason: "<ended> with a <status> report"}`. When the
  report line cannot be written nothing is, and the file stays.
- The report schema (scripts/lib/report-schema.mjs) takes, besides the fields the duty skills describe, two optional
  lists: `decisions` `[{question, choice, options?, reason, reversible}]` (choices a worker made itself) and
  `followUps` `[{kind: unrelated-failure | host | scope, title, evidence, cause}]` (what it found that is not the task's
  to fix). Reports without them stay valid.
- `ledger.mjs tail [--follow] [--task T] [--lines N] [--json]` -> the newest lines (40 by default), one per output
  line, JSON lines with `--json`; `--follow` keeps printing new ones.
- `ledger.mjs verify --json` -> `{ok, lines, issues}`: seq contiguous, every line parses with a known kind, a time and
  object data (exit 2 when not ok).

`--if-last-seq N` (append, record): the line is written only when the task's newest line is still #N, the `lastSeq`
of `show T --json`; lines of other tasks do not count. Otherwise exit 6 and nothing is written: read the task again
and decide again.

Exit codes: 0 ok; 2 refused, with the reason; 3 not found; 4 `wait`: the step failed, was lost or was stopped; 5
`wait`: timeout; 6 the task changed after `--if-last-seq`; 1 an unexpected error (a file that cannot be written), with
the message on stderr.

The hooks (`hooks/stop.mjs`, `hooks/post-tool.mjs`, `hooks/session-start.mjs`) are registered by the installer or the
plugin and are not called by other skills.
