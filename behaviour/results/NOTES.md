## Notes

- 2026-11-04, the first 0.3.0 sweep was stopped and archived (`~/.jevellan-harness/archive/evals/baseline-0.3.0-gh-not-on-path/`):
  Claude Code's Bash tool rebuilds PATH from the owner's login shell, so the coordinator's own commands did not see the
  run's fake gh (no GitHub query reached GitHub: the runs that would have landed were stopped before landing, and the only
  direct call was `gh --version`). The runner now puts the fake gh back in front through `CLAUDE_ENV_FILE` and
  `JH_GH_BIN`, and marks a run "error" when landing or an overlap check ran while the fake gh logged no call. The same
  sweep's finished runs had B01 0/3, B02 0/3, B03 0/3, B04 0/3; every number below is from the sweeps after the fix.
- Fixture history is a month old (the initial commit is dated 30 days back), so only what a case adds is recent.
