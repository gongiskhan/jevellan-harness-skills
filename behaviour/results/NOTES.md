## Notes

- 2026-11-04, the first 0.3.0 sweep was stopped and archived (`~/.jevellan-harness/archive/evals/baseline-0.3.0-gh-not-on-path/`):
  Claude Code's Bash tool rebuilds PATH from the owner's login shell, so the coordinator's own commands did not see the
  run's fake gh (no GitHub query reached GitHub: the runs that would have landed were stopped before landing, and the only
  direct call was `gh --version`). The runner now puts the fake gh back in front through `CLAUDE_ENV_FILE` and
  `JH_GH_BIN`, and marks a run "error" when landing or an overlap check ran while the fake gh logged no call. The same
  sweep's finished runs had B01 0/3, B02 0/3, B03 0/3, B04 0/3; every number below is from the sweeps after the fix.
- Fixture history is a month old (the initial commit is dated 30 days back), so only what a case adds is recent.
- Check corrections (msg-harness-004: a check may be corrected only when it was wrong; every run was re-evaluated with
  `node behaviour/run.mjs --evaluate`, which re-runs the deterministic checks and keeps each run's judge score):
  - `prPattern` (B01, B02, B03, R01) matched "#8", "PR 8" and "pull request 8" only. A coordinator following the
    question shape writes "pull request ... (number 8)" or the pull request's URL, which name it as plainly. Before: dev
    B03 r2 failed "the owner is asked about #8" on a question that named "number 8"; after: it passes.
  - B03's default pattern did not know "if your reply does not choose" (the ledger's ask contract wording). Before: dev
    B03 r1 failed "the question says what happens by default" while its question said "that is what I will do if your
    reply does not choose" in r2; after: such a sentence counts. (r1's chat did not state a default at all and still
    fails.)
