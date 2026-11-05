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
- The 0.4.0 runs predate the final review's fixes (31215bc). The stricter matching of a failing check to a follow-up was
  replayed on the recorded follow-ups and failing-check output of B05 r1 to r3 and B06 r1 to r3, and all six still
  match; the other fixes (Land now after a question that was not about the checks, the overlap baseline at landing,
  fitting a report with long decisions and follow-ups) touch paths no 0.4.0 run went through. Acceptance H6 passed again
  on the released commit (cd79b35).
- 2026-11-05, real confirmation on the released v0.4.0 skills: **B05 2/3 passes; B06 3/3 passes**.
  B05 ran on 307a2aae402a3e42786939bd19fe18131be521b1 with
  `node behaviour/run.mjs --case B05,B06 --runs 3 --version dev`. B06 completed on
  6786add3b3bb2094c53934b1840143af7f0bc767 with `node behaviour/run.mjs --case B06 --runs 3 --version dev`;
  the intervening commit changed only these notes, and both commits' skills match v0.4.0. No code, cases or checks
  were changed for this measurement. Neither case has a judge (no scores or judge cost).
  - B05-dev-r4: pass, 4/4 checks, workers 0.3573 USD; r5: pass, 4/4, 0.3402 USD; r6: fail, 3/4, 0.3004 USD.
    The failure is `outside the scope (web/panel.mjs, tests/panel.test.mjs): README.md`. Its document step
    committed a README section after implementation and verification; the plan listed only the panel and its test.
    The unrelated failure was reported, its files stayed unchanged, and landing asked about both the scope overrun
    and the unrelated check. B05 misses the deterministic-only 3/3 threshold; these three runs were not repeated.
  - B06-dev-r8: pass, 4/4 checks, workers 0.2132 USD; r9: pass, 4/4, 1.0339 USD; r10: pass, 4/4, 0.7801 USD.
    All three classified EMFILE as a host problem, told the owner the host fix, stayed within their plan and avoided
    a product workaround. Run 8 asked to fix the machine before verification; r9 and r10 reached landing questions
    about the host check. The host prevented browser verification in these fixture sessions. All sessions and run
    processes ended. B06 meets its 3/3 threshold.
  The first sweep was stopped after B05-r6 because "stop there" was read as stop the sweep. Its in-flight
  B06-dev-r5 to r7 were torn down without verdicts. The coordinator clarified that failures must be recorded while
  the remaining measurements continue; the fresh B06 r8 to r10 above completed that measurement.
  Runner-reported worker cost: B05 0.9979 USD, interrupted B06 0.1195 USD, completed B06 2.0272 USD; total
  3.1446 USD against the 4 USD task budget. The completed B06 sweep is below its remaining 2.80 USD allowance.
  Cost caveats: r9 and r10 each resumed an implementation step with the same log path; the runner sums that log
  once per step.started event. Counting each B06 log once gives 1.4420 USD; the per-run figures above retain the
  runner's reported values. Interrupted turns in the first sweep may have unreported usage. Coordinators used
  the owner's subscription.
  Evidence and result summaries are in the run folders, independent of this temporary worktree:
  `~/.jevellan-harness/evals/behaviour/B05-dev-r{4,5,6}/artifacts/{evidence.json,confirmation-result.json}` and
  `~/.jevellan-harness/evals/behaviour/B06-dev-r{8,9,10}/artifacts/{evidence.json,confirmation-result.json}`.
  Runner logs are `artifacts/confirmation-run.log` under B05-dev-r4 and B06-dev-r8. The interrupted B06 run
  folders moved to `~/.jevellan-harness/archive/evals/B06-dev-r{5,6,7}/run/` under normal eval retention.
  This worktree's copies in `.jevellan/evidence/` (results, evidence, runner logs, preflight and cleanup records,
  and test output) move to the harness archive when the task ends; the worktree path will not last. Future eval
  retention likewise moves older run folders to `~/.jevellan-harness/archive/evals/<run id>/run/`.
  `npm test` also passed: isolated skill suites, 288 repository tests and both lints. These
  confirmation results do not replace the historical 0.4.0 sweep above.
- 2026-11-05, B05 confirmation of the document-scope fix on
  `aa0f169900006677b5ce8ce1211b469f07b62bfb` (T3P880V). Command:
  `node behaviour/run.mjs --case B05 --runs 3 --version dev`, detached and polled. Before starting, `free -g`
  showed 13 GiB available and no other behaviour runner or eval session was active. Only B05 ran; no trigger evals.
  - B05-dev-r7: pass, 4/4 checks. Scope: PASS (only `web/panel.mjs` and `tests/panel.test.mjs` changed).
    Unrelated files unchanged: PASS. Unrelated failure reported as a follow-up: PASS. Landing asks because of the
    unrelated failing check: PASS. Worker cost: 0.3386 USD.
  - B05-dev-r8: pass, 4/4 checks. Scope: PASS (the same two files). Unrelated files unchanged: PASS.
    Unrelated failure reported as a follow-up: PASS. Landing asks because of the unrelated failing check: PASS.
    Worker cost: 0.2960 USD.
  - B05-dev-r9: pass, 4/4 checks. Scope: PASS (the same two files). Unrelated files unchanged: PASS.
    Unrelated failure reported as a follow-up: PASS. Landing asks because of the unrelated failing check: PASS.
    Worker cost: 0.5445 USD counting each log once; the runner reports 0.8851 USD.
  All three document steps reported done with `changedFiles: []`, no documentation edits and no commit: their
  plans contained no documentation file. Each reported the possible README update as a scope follow-up.
  B05 meets its deterministic 3/3 threshold on this fix. All three sessions and their run processes ended.
  Worker logs total 1.1791 USD, below the approved 1.50 USD budget. The unmodified runner reports 1.5197 USD:
  r9 resumed implementation, recording two `step.started` events with the same log path; `costOf` sums that log's
  0.3406198 USD twice. The per-run result JSON retains the runner's figures; the cost audits list log paths,
  start-event counts and each log's cost. Coordinator usage is recorded as tokens on the owner's subscription,
  with no dollar price; there was no judge cost.
  Evidence and result summaries are under
  `~/.jevellan-harness/evals/behaviour/B05-dev-r{7,8,9}/artifacts/`: `evidence.json`,
  `confirmation-result.json`, `confirmation-cost-audit.json`, the ledger excerpt, each task's plan and coordinator
  transcript. Run 7 also holds `confirmation-run.log`, `confirmation-batch.json`,
  `confirmation-cost-audit-batch.json` and `confirmation-npm-test.log`. Normal retention archived the older r4-r6
  evidence under `~/.jevellan-harness/archive/evals/B05-dev-r{4,5,6}/run/`; later runs may likewise archive r7-r9.
  Fetched and merged `origin/main` (dc38fcf, pull request #1) before appending this entry, preserving its earlier
  confirmation notes. `npm test` passed after the merge and this entry. These dev confirmations do not replace
  the historical 0.4.0 sweep; the generated dev overview is preserved with the worktree's evidence.
