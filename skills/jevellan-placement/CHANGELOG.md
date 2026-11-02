# Changelog: jevellan-placement

Changes made by the trigger-eval improvement loop (brief section 10); `evals/RESULTS.md` at the repository root holds each round's numbers.

## Trigger evals round 1, 2026-11-02

- The role-missing sentence now says how to tell a role (the first word of a skill's description) and to stop without trying any skill name: with the placement skill removed, sessions tried a skill name guessed from the role word before reporting the role missing (the placement skill's cases 9 and 10), and the brief says such a session must invoke nothing.

## Trigger evals round 2, 2026-11-02

- The role-missing sentence now says to call no skill at all when no listed skill has the role: one of the two placement-removed runs still tried a skill name guessed from the role word (the placement skill's case 9).

## 0.2.0

- Decoupled from the other skills: the scripts reach the ledger skill only through its public script, run as a process
  (`lib/ledger-client.mjs`: `show --json` for the task and its step views, `events --json` for the history, `record
  task.placed` for the placement); nothing of another skill is imported. Ids, the project folder and the redactor are
  this skill's own copies (`lib/ids.mjs`, `lib/project.mjs`, `lib/redact.mjs`); `providers.mjs` now always passes its
  state and output through the own redactor instead of only when the ledger skill was installed.
- `jev.mjs decide` is the public way for another skill to ask Jev: stdin `{state, questions}`, prints `{jevModel,
  answeredBy, answers, usage, latencyMs}`; every Jev failure is exit 2 with "Jev: <message>". `jev.mjs models` now
  reports an unusable providers.json as exit 2 with its message instead of crashing.
- A missing role now reads "no installed skill has the role <role>; tell the owner which role is missing and do not
  improvise it" (exit 2), and `--task-file` is read without the ledger skill.
- SKILL.md ends with a "## Interface" section listing every script with what it takes and prints. The policy loader
  ignores that section: it is not sent to Jev and not part of the policy hash, which stays
  `ec73b4a67a6b0225e95f97a49c359b4c3678aa6c05f57f89c95e56479a33fafe`.
- The evals export reads each project's ledger through the ledger skill's `events --json`.
- Own tests in `test/` run with only this skill present, against fake duty, runtime and ledger skills.

## 0.2.1

- Renamed from jevellan-router to jevellan-placement, so the folder name matches the role (owner decision,
  docs/decisions.md H-040). The role word, the description, the policy and every script are unchanged; the policy's
  error messages say "the placement policy".
