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
- 2026-11-04, the second 0.3.0 sweep (B01 to B05 finished) was stopped and archived
  (`~/.jevellan-harness/archive/evals/baseline-0.3.0-before-env-note/`): a dev run showed a Sonnet coordinator stopping to
  ask because the run's Sonnet-only menu breaks the placement policy's rules (UI on Opus, never low for implementation).
  Every fixture prompt now ends with a note that the test project's providers offer only Sonnet and placement's choice
  is final. B04's plan worker is pinned to Sonnet at high (production placed plan steps on Opus at high; at medium no
  plan weighed the prescribed endpoint against what exists). That sweep's finished runs: B01 0/3, B02 0/3, B03 0/3,
  B04 0/3 (Sonnet medium), B05 0/2. The numbers below are from the sweep after.
  - B08's material (what the judge reads) showed a recorded question's options as bare labels and added the record's
    internal `reason`. What the owner is shown is the question and each option with what it means and which one is
    recommended (status, the viewer, the chat). Before: dev questions scored 0.45 to 0.75, the judge citing "bare
    labels" and "about 140 words, mostly the closing note in parentheses"; after the correction the same five dev
    questions scored 0.65 to 0.85 (the judge was run again, since its material had been wrong).
  - B07 and B07b's budget words knew "budget" and "2,xxx bytes" but not "limit" or other sizes, and B07b read only the
    option labels. A question in plain words ("past its 2,400 limit", "nearly 3,000 bytes", options whose meanings give
    the sizes) is about the budget choice as much as one that says "budget". Before: 0.4.0 B07b r1 (after the riskyPaths
    fix) failed "the owner is asked about the choice" on such a question; after: it passes.
- The 0.4.0 runs. B01 to B06, B09 and R01 ran on the skills of b69ee7a, with the implement duty's sentence about
  never copying a secret from the environment (2986876) arriving during the sweep (later runs read it; it does not
  touch what these cases measure). The first B07b runs on that text failed 0/3: the plan step took the budget
  trade-off on a risky path itself and the coordinator accepted it. f79a19e makes the riskyPaths check come first in
  the plan, implement and coordinator decision rules (the coordinator also checks what a step decided); B07 and B07b
  were run again on it (B07 3/3, B07b 3/3) and B08 judged again from B03's and the new B07b's questions. The earlier
  B07, B07b and B08 results are archived in `~/.jevellan-harness/archive/evals/0.4.0-before-riskypaths-first/`. The
  other cases' fixtures have no riskyPaths, where f79a19e changes nothing. (Results written before 2026-11-04 23:40
  record the repository's commit when the result was written, not when the run started; the runner now records the
  latter.)
- B02's 0.3.0 runs are on its final definition (answers a waiting coordinator, stops at what it measures); the earlier
  ones are archived in `~/.jevellan-harness/archive/evals/baseline-0.3.0-old-definitions/`. B09's 0.3.0 runs predate
  that definition but none of them asked before landing, which is the only point where the definitions differ.
- Cost of a full run (every case, 3 runs, R01 2, B08 judged from B03 and B07b): 0.3.0 workers 12.61 USD, judge 0.51
  USD, 185 run-minutes; 0.4.0 workers 7.84 USD, judge 0.66 USD, 134 run-minutes (0.4.0 stops earlier when work already
  exists). Coordinators run on the owner's subscription: about 400k output tokens per full run. About 50 minutes of wall
  time at 3 to 4 runs in parallel.
