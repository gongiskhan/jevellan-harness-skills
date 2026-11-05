# Changelog: jevellan-workflow-bug

Changes made by the trigger-eval improvement loop (brief section 10); `evals/RESULTS.md` at the repository root holds each round's numbers.

## Placement trigger evals round 3, 2026-11-05

- Body: check the role against this session's listed descriptions before any Skill tool call, use only the exact listed name, and never probe a guessed name. If absent, explicitly say "The <role> role is missing" and invoke nothing. Placement case 10 previously passed 1/3: one run guessed a name for the removed placement skill; another invoked nothing but said "none is available", which did not explicitly name the missing role in a form the scorer recognizes. The description is unchanged; this calling body was re-measured with placement's final round.
- Re-measurement: positives 24/24, negatives 18/18, role-missing runs 3/3 and role-phrase runs 21/21, meeting every threshold. Placement case 10 with this calling body and placement removed improved from 1/3 to 3/3, invoking nothing and naming the missing role in every run.

## Trigger evals round 1, 2026-11-02

- The role-missing sentence now says how to tell a role (the first word of a skill's description) and to stop without trying any skill name: with the placement skill removed, sessions tried a skill name guessed from the role word before reporting the role missing (the placement skill's cases 9 and 10), and the brief says such a session must invoke nothing.

## Trigger evals round 2, 2026-11-02

- The role-missing sentence now says to call no skill at all when no listed skill has the role: one of the two placement-removed runs still tried a skill name guessed from the role word (the placement skill's case 9).

## 0.2.0 - Interface section added; body otherwise unchanged
