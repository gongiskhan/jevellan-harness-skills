# Changelog: jevellan-runtime-codex

Changes made by the trigger-eval improvement loop (brief section 10); `evals/RESULTS.md` at the repository root holds each round's numbers.

## Trigger evals round 1, 2026-11-02

- The role-missing sentence now says how to tell a role (the first word of a skill's description) and to stop without trying any skill name: with the placement skill removed, sessions tried a skill name guessed from the role word before reporting the role missing (the placement skill's cases 9 and 10), and the brief says such a session must invoke nothing.

## Trigger evals round 2, 2026-11-02

- The role-missing sentence now says to call no skill at all when no listed skill has the role: one of the two placement-removed runs still tried a skill name guessed from the role word (the placement skill's case 9).

## 0.2.0

- The scripts reach the ledger only through the ledger skill's public script, found by role and run as a process
  (`scripts/lib/ledger-client.mjs`); nothing of another skill's code is imported. The task is read with `show --json`
  (its step views carry the ledger's reset and end rules) and every line is appended with `record` or `append`.
- The guards that ran inside the ledger lock now run on a fresh reading of the task, and the line is appended with
  `--if-last-seq`, so a task that changed in between is read and decided again: two concurrent starts or resumes
  still never both run, and a runner whose start the ledger refuses is killed with its Codex before the error is
  reported.
- The runner is internal and moved to `scripts/lib/runner.mjs`. It no longer validates and archives the report
  itself: when Codex exits it calls the ledger's `take-report` (`--ended "codex exec ended with exit N"` or `with
  signal X`), which records step.report and session.ended. It records session.started and the report only after
  the step.started that spawned it is in the ledger (it waits up to 30 s for it), so a report does not land ahead
  of the start it ends.
- The project folders, ids and secret masking are this skill's own copies (`scripts/lib/project.mjs`, `ids.mjs`,
  `redact.mjs`); `--duty` is checked against this skill's own list of duties.
- A missing ledger or duty skill is refused with exit 2 and the role-missing sentence, before any runner starts.
- The duty body inlined into the first message leaves out the duty skill's "## Interface" section.
- SKILL.md ends with an "## Interface" section listing the four scripts.
