# Changelog: jevellan-coordinator

Changes made by the trigger-eval improvement loop (brief section 10); `evals/RESULTS.md` at the repository root holds each round's numbers.

## Placement trigger evals round 3, 2026-11-05

- Body: check the role against this session's listed descriptions before any Skill tool call, use only the exact listed name, and never probe a guessed name. If absent, explicitly say "The <role> role is missing" and invoke nothing. Placement case 9 previously passed 2/3: one run guessed a name for the removed placement skill before naming the missing role. The description is unchanged; this calling body requires re-measurement with placement's final round.

## 0.4.0

- Body: a choice that changes a file under riskyPaths is the owner's, however small, checked before any other decision rule (the coordinator also checks the decisions a step reports).
- Body: the overlap check before the first step and before each later one, judged by what each item did; a decision
  rule for small choices (decide, record, mention) and a fixed shape for questions, recorded with the ledger's ask;
  follow-ups (never sent back to implement); the final summary names the decisions and follow-ups. The description is
  unchanged. Trigger evals run again for 0.4.0.

## Trigger evals round 1, 2026-11-02

- The role-missing sentence now says how to tell a role (the first word of a skill's description) and to stop without trying any skill name: with the placement skill removed, sessions tried a skill name guessed from the role word before reporting the role missing (the placement skill's cases 9 and 10), and the brief says such a session must invoke nothing.
- Step 1 of "Running a task" now asks for status before creating a task for a new request only, and sends a request about an existing task straight to its next operation: on "run automation task T6AU4M by its workflow" the session went to the ledger first and never reached the workflow skill within its turns (workflow-automation case 8).

## Trigger evals round 2, 2026-11-02

- The role-missing sentence now says to call no skill at all when no listed skill has the role: one of the two placement-removed runs still tried a skill name guessed from the role word (the placement skill's case 9).

## Trigger evals round 3, 2026-11-02

- "Running a task" now says to find a role's skill in the skill list by the first word of its description and never to call a skill by a name not in the list: with the placement skill removed, a session with this body in context still tried a skill name guessed from the role word once (the placement skill's case 9).

## 0.2.0 - Interface section added; body otherwise unchanged

## 0.3.0 - step 7 names the pull request

- Step 7 of "Running a task" now says that when landing opened a pull request (a project that lands by pull request,
  docs/decisions.md H-041) the change is not on the default branch yet, and to give the owner the pull request's link.
  The description is unchanged; the trigger evals were not run again for this line.

