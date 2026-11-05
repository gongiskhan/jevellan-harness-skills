# Changelog: jevellan-placement

Changes made by the trigger-eval improvement loop (brief section 10); `evals/RESULTS.md` at the repository root holds each round's numbers.

## Trigger evals round 3, 2026-11-05

- Strengthened the coordinator and bug workflow calling bodies: resolve the requested role from the listed descriptions before any Skill tool call, use only a matching listed name, never probe a guessed name, and explicitly say "The <role> role is missing" when absent. The previous placement-removed cases passed 2/3 and 1/3 respectively: two runs guessed names, while one invoked nothing but its missing-role wording was not recognized. Placement's description and policy body are unchanged; the correction belongs in the callers that remain installed when placement is removed. This is placement's final improvement round under section 10.
- Measurement: missing-role runs improved from 3/6 to 6/6 (cases 9 and 10 each 3/3), role-phrase runs from 24/27 to 27/27, and negatives stayed 18/18. Positives fell from 23/24 to 21/24: all three case 4 retry requests invoked the ledger first and exhausted the turn limit without invoking placement. Placement remains below the 90% positive threshold after its third round; record H11 as blocked under section 10, with no further tuning. The three-skill measurement cost 7.78 USD within the owner-approved 9 USD task cap; both calling skills meet their thresholds.

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
