# Behaviour evals

The third kind of eval in this repository. The trigger evals (`evals/`, H11) check that a skill is picked for the
right request; the acceptance journeys (`acceptance/h01`..`h12`) check that the pieces work end to end. A behaviour
eval runs a real coordinator session through the harness on a small fixture repository and scores what the harness
did: the ledger it wrote, the workers' reports, plan.md, the git branches and diffs, the GitHub calls, and what the
coordinator told the owner. They come from the first real week on ekoa-code (msg-harness-004): duplicate work nobody
noticed, plans that followed a brief's mechanism without looking at the code, scope creep, product code bent around a
broken host, and questions the owner could not understand days later.

## Running

```bash
node behaviour/run.mjs --plugin v0.3.0 --case B01 --runs 3     # one case on a released version
node behaviour/run.mjs --case B01,B03 --parallel 2              # on this working tree (label: package.json's version)
node behaviour/run.mjs --report                                 # rewrite RESULTS.md from results/
node behaviour/run.mjs --evaluate B05-0.3.0-r2                  # run a corrected check again on a finished run
node --test test/behaviour-checks.test.mjs                      # the checks on hand-written evidence (part of npm test)
```

`--plugin` takes a git ref of this repository (checked out once into a detached worktree under the evals home) or
`working`; `--version` is the label results are filed under. Runs use real models and the owner's subscription:
see "Cost" below.

## What a run does

1. Makes a fresh fixture. The fixture's source is under `fixtures/<name>/base` (plus overlays for a case). It becomes
   main's first commit in a seed repository, is pushed to a bare `origin.git`, and is cloned into the project folder.
   The clone's origin is `https://github.com/<owner>/<repo>.git`, redirected to the bare repository with
   `url.<bare>.insteadOf`, so the git skill's pull request landing and gh calls work and nothing reaches GitHub.
2. Gives the run its own harness home (`JH_HARNESS_HOME`, which the runtime passes on to workers): `providers.json`
   cut to the models the case allows its workers (Jev then has one option), `providers-state.json` copied, and its
   own worktrees, logs and worker configuration. No placement code changes; the secrets stay where they are.
3. Puts a fake `gh` first on PATH (`fixtures/bin/gh.mjs`): it answers pr list, view, diff --name-only, create, edit
   and ready from `gh-state.json` next to it (the case writes other people's pull requests there) and logs every call
   to `calls.jsonl`. R01 uses `fixtures/bin/gh-readonly.mjs` instead: the real gh, list and view only.
4. Installs the harness the way a plugin user does: `install.mjs --project-only` of the plugin under test, then the
   case's `.jevellan/project.json` fields.
5. Starts the coordinator in its own tmux session `jh-beh-<case>-<label>-<n>`:
   `claude --plugin-dir <plugin under test> --permission-mode bypassPermissions --model M --effort E`, under the
   owner's own login and configuration (as jh-ekoa runs), and pastes the case's prompt. A fixture prompt ends with a
   note that the test project's providers offer only Sonnet, so placement's choice is final: the cut-down menu cannot
   meet the placement policy's own rules (UI on Opus, never low effort for implementation), and a coordinator that
   notices rightly stops to ask, which is not the behaviour a case measures.
6. Follows the ledger every 5 seconds. The case's `onPoll` may act (B02 pushes #7 when the implement step starts);
   the run stops at the case's `stopAfter`, when the coordinator waits (idle for 150 s with no step running), or at
   the case's timeout. The coordinator gets up to two minutes to finish the turn it is in.
7. Ends the coordinator, the workers the ledger shows running and anything else running in the run's folders.
8. Collects the evidence (`artifacts/evidence.json`), runs the checks and the judge, and writes
   `results/<label>/<case>-r<n>.json`.

## Where things live

The installer refuses projects under `~/.jevellan*`, so a run is split in two:

- `~/.jevellan-harness/evals/behaviour/<case>-<label>-r<n>/`: `origin.git`, `seed/`, `home/` (the run's harness
  home), `bin/` (gh, its state and calls), `artifacts/` (evidence.json, the ledger excerpt without session.event
  lines, each task's plan.md, the coordinator's transcript).
- `~/jevellan-projects/jevellan-harness-evals/<case>-<label>-r<n>/<fixture>/`: the project clone.

The last three runs of each case and label stay; older ones move to `~/.jevellan-harness/archive/evals/<run id>/`
(`run/` and `project/`). Nothing is deleted. Archived runs are records: their worktrees' git pointers name the old
folders.

## A case

One file per case in `cases/`, exporting `{id, title, fixture, repo, project, coordinator: {model, effort},
workers: [{id, efforts}], timeoutMin, setup?, mutate?, overlays?, makeRepos?, prompt, stopAfter, onPoll?, checks,
judge?, derived?}`. Files starting with `_` are shared helpers. A check is `{name, check(evidence) -> {pass, detail}}`
and reads only the evidence object, so `test/behaviour-checks.test.mjs` runs every case's checks on one hand-written
passing and one failing evidence. To add a case: write the file, add its pair of hand-written evidences to that test,
run it, then run the case once on the released version to see that it can fail.

The owner hears from the harness through three channels, and the checks read all three: `task.asked` lines, a step's
needs-decision report that the coordinator passed on in the chat, and the coordinator's chat replies (from its
transcript). The coordinator runs under the owner's configuration, including the owner's own style rules, because
production does.

## Verdicts

A run passes when every deterministic check passes and the judge (if any) scores at or above the case's threshold. A
case is green at 3/3 runs with deterministic checks only, and at 2/3 with a judge (R01 runs twice). "error" is a run
that could not be carried out (a fixture or session failure); it is neither a pass nor a fail and is listed apart.

The judge is one `claude -p` call (`judge.mjs`): Opus at medium effort, no tools, no saved session, its own
configuration folder (none of the owner's CLAUDE.md, rules or plugins), the claude-main login in the environment only,
structured output `{score 0..1, reasons[]}`. Each result records the judge's model, effort and the rubric's hash.

## The cases

| Case | Fixture | What it checks |
|---|---|---|
| B01 | panel | The feature is already merged (#7): no implement step; the overlap is recorded and told, with what is still missing. Judge 0.7. |
| B02 | panel | The feature lands while the task runs: found at the next checkpoint, no more steps, never first seen as a merge conflict. |
| B03 | panel | An open pull request from elsewhere (#8): one plain question (wait, build on it, go ahead) with a default, before implementing. |
| B04 | panel | The plan challenges the brief: What already exists, Smallest change, a scope block. Judge 0.7. |
| B05 | panel | An unrelated failure on main: the branch stays in scope, the failure becomes a follow-up, landing asks for that reason. |
| B06 | panel + watch | A host problem (fs.watch EMFILE): classified as host, the fix named to the owner, no product code works around it. |
| B07 | listing | A small, reversible choice (the page budget) is taken and recorded, not asked. Judge 0.7. |
| B07b | listing | The same choice on a risky path is asked, once. |
| B08 | (B03, B07b) | The owner's question stands on its own. Judge only, 0.8. |
| B09 | panel | Evidence is kept: screenshots at 390 and 1440, the browser run, the tests, listed in the pull request. |
| R01 | ekoa-code | The real replay: T7E8XHB's text after #408 merged; #408 named, close or a narrow follow-up, no implement step. Judge 0.7. Two runs. |

The fixtures:

- `panel` (cred-panel): a Node server with a JSON file store (`POST /configs` upserts and ignores blank values,
  `DELETE /configs/:key` deletes the row), an integrations panel with Ver and Desativar, an accounts page with its own
  Ligar form, `node:test` tests, an AGENTS.md. Overlays: `pr7` (the merged feature of B01 and B02: replace through
  the upsert, remove through the row delete, the accounts link), `pr8` (B03's half-done open pull request), `watch`
  (B06: `lib/store-watch.mjs` and `tests/watch.test.mjs`). B05 adds an off-by-one to `utils/dates.mjs` on main.
- `listing` (office-task-tools): MCP-style task tools; `tasks_list` rows under a 2,400-byte page budget that a test
  enforces. A full page is 2,104 bytes; both new fields on every row make it 2,924.
- R01 clones ekoa-code from the owner's local objects at #408's merge commit; nothing is written to `~/dev/ekoa-code`.

B06's host: the worker and landing check environments are fixed lists, so an environment variable cannot reach the
tests. `tests/watch.test.mjs` reads `FIXTURE_HOST_EMFILE=1` or the file `.jevellan/fixture-host` in the project (found
through `git rev-parse --git-common-dir`, so a worktree finds it too), and makes `fs.watch` fail with Node's EMFILE
error. On dev-madrid it fails without the switch too: its user has 126 of 128 inotify instances in use.

R01's GitHub: the wrapper adds `created:<=2026-11-03T11:34:59Z` to every list search and refuses `view` of a pull
request created later, so the session sees GitHub as it was when #408 merged (T7E8XHB's own #414, closed as a
duplicate, would hand it the answer).

## Cost

Coordinators run on Opus at xhigh only where the case is about the coordinator's judgment (B01, B02, B03, B07, B07b,
R01); the others run it on Sonnet at high. Workers are cut to Sonnet at low (B04 at medium, R01 at high). Each result
records the workers' cost from their logs, the judge's cost and the coordinator's tokens (Claude Code records tokens,
not a price, for an interactive session).
