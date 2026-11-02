# Changelog: jevellan-ledger

Changes made by the trigger-eval improvement loop (brief section 10); `evals/RESULTS.md` at the repository root holds each round's numbers.

## 0.2.0

Decoupling over efficiency: other skills reach the ledger only through `ledger.mjs`, run as a process with `--json`,
and never import its `scripts/lib/`. The description is unchanged; the body gains one Details line and the
"## Interface" section.

- `record <kind> --task T [--step N] [--session S] (--data | --data-file) [--if-last-seq N]` appends the kinds the
  skills' scripts own (task.worktree, task.placed, step.started, step.report, step.stopped, session.*, landing.*,
  task.landed, task.asked). It refuses unknown kinds, the hand kinds (they go through `append` and its checks),
  task.created (written by `task create`) and step.lost (written by this skill alone), a missing `--task`, and a
  missing `--step` for the step kinds.
- `--if-last-seq N` on `append` and `record`: the line is written only when the task's newest line is still #N;
  otherwise exit 6 (new) and nothing is written. Lines of other tasks do not count. It replaces the guard closures
  that other skills' scripts used to run inside the ledger lock: they now read the task, check their guards on what
  they read and append with the seq they read.
- `events [--task T]... [--kind K]... [--since SEQ]` prints `{lastSeq, events}` of the whole ledger, narrowed.
- `show T --json` also prints `lastSeq` (the task's newest seq) and `views`: for each ordinal from 1 to the highest a
  workflow, a placement or a step event names (step 1 for a single task), the step's view since its last retry reset
  (`current`) and over all its lines (`overall`), with the seqs of the events, so no other skill keeps its own copy of
  the reset and end rules. Gaps are filled up to ordinal 100, so a line that names a huge step number by mistake
  cannot make every `show` of its task build that many views.
- `take-report --task T --step N --session S --cwd DIR [--native-session ID] [--ended "text"]` does what the Stop hook
  does for a runtime whose agent has no Stop hook: valid, invalid and missing reports are recorded, archived and
  followed by session.ended the same way. The Stop hook and `take-report` share `scripts/lib/report-file.mjs`; the
  hook's behaviour is unchanged.
- The ledger's own tests moved into `test/` in this skill (with their own `test/helpers.mjs`) and pass with only this
  skill's folder present (`node scripts/test-skills.mjs --skill <this skill>` from the repository root); new tests
  cover record, `--if-last-seq`, events, the show views and take-report.
- A hook registered twice (the plugin and a project's settings) handles each event once: `runHook` claims the event
  first (docs/decisions.md H-039). The hooks log a Node older than 22.13, and the SessionStart hook says it in the
  session; a plugin's hooks run with the `node` first on PATH.

## Trigger evals round 1, 2026-11-02

- The description names recording a note or a standing preference: "Record a note for this project's work: the owner wants every report summary written in Portuguese" invoked no skill (case 6, a positive).
