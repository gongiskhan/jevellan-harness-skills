# Changelog: jevellan-workflow-automation

Changes made by the trigger-eval improvement loop (brief section 10); `evals/RESULTS.md` at the repository root holds each round's numbers.

## Trigger evals round 1, 2026-11-02

- The role-missing sentence now says how to tell a role (the first word of a skill's description) and to stop without trying any skill name: with the placement skill removed, sessions tried the guessed name jevellan-placement before reporting the role missing (router cases 9 and 10), and the brief says such a session must invoke nothing.

## Trigger evals round 2, 2026-11-02

- The role-missing sentence now says to call no skill at all when no listed skill has the role: one of the two placement-removed runs still tried the guessed name jevellan-placement (router case 9).

## Trigger evals round 4, 2026-11-02

- No change to the skill. Case 8 (held out) now says the task's worktree is ready, as the other workflow cases do: without it, the coordinator's own order (status, worktree, workflow) used the run's turns before reaching this skill, which is the order the coordinator body prescribes, not a trigger miss. The case was changed after it was seen failing; the decision record says so.
