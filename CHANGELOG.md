# Changelog

## 0.2.1 - 2026-11-02

- The placement skill is named `jevellan-placement` (it was `jevellan-router`), so its folder name matches its role;
  the role word and every role phrase are unchanged (docs/decisions.md H-040). `install.mjs` moves an installed
  `jevellan-router` to the project's `.jevellan/archive/skills/` when it installs `jevellan-placement`.
- `run-trigger-evals.mjs --merge <results.json>`: a run of some skills merged into a full run's results, naming which
  skill was measured when; the placement and coordinator skills measured again (three runs per case).
- `tools/viewer.mjs`: a read-only page over one project's ledger (open and finished tasks, step reports, landings,
  questions waiting on the owner, the steps' screenshots), to follow the coordinator from a browser over the tailnet.

## 0.2.0 - 2026-11-02

Decoupling over efficiency (docs/decisions.md H-031 to H-036, AGENTS.md, docs/decoupling.md).

- A skill uses another only through its public scripts, run as a process found by role (`runRole` in its own
  `scripts/lib/roles.mjs`, which replaces `importFromRole`); nothing imports or reads another skill's `scripts/lib/`.
  Every `SKILL.md` ends with a `## Interface` section listing its public scripts and their JSON.
- The ledger's public interface for other skills: `show --json` with `lastSeq` and every step's views, `events`,
  `record`, `take-report`, and `--if-last-seq` (compare-and-append, exit 6 when the task changed). The guards that ran
  inside the ledger lock now run in the calling script on what it read. The placement skill gained `jev.mjs decide`
  for the git skill's landing question; the Codex runner moved to `scripts/lib/`.
- Helpers stay duplicated per skill; `check-roles.mjs` only prints a notice for copies that differ.
- `scripts/check-decoupling.mjs` (run by `npm test`) fails on any coupling between skills; `scripts/test-skills.mjs`
  runs each skill's own tests (`skills/<x>/test/`) with only that skill present; `test/isolation.test.mjs` checks every
  public script of every skill installed alone.
- Workers ignore instruction files from every folder above their worktree (H-034, generalizing H-001).
- Trigger cases name the calling skill by role (`context_role`).
- `acceptance/timings.mjs` and the before-and-after section of `acceptance/RESULTS.md`; every journey run again.

Distribution as a Claude Code plugin (H-037 to H-039, README "Install as a plugin", docs/findings.md):

- `.claude-plugin/plugin.json` (`jevellan-harness`), `.claude-plugin/marketplace.json` (`jevellan-harness-skills`, the
  repository root as its one plugin) and `hooks/hooks.json` (the ledger's three hooks through `${CLAUDE_PLUGIN_ROOT}`,
  run with the `node` first on PATH). `install.mjs` stays; `install.mjs --project-only` sets up a project for the plugin.
- Workers started by the Claude runtime load the plugin with `--plugin-dir` when the skills came with it; the git skill
  links `.claude` into a worktree only for skills installed in the project.
- Each hook handles an event once even when registered twice (plugin and project settings); the hooks name a Node older
  than 22.13.

## 0.1.0 - 2026-11-02

The first release: seventeen skills that turn a Claude Code session into a coordinator, with Jev placement, steps
run as their own sessions, guarded landing and an append-only ledger. Built and verified on dev-madrid against Claude
Code 2.1.316 and Codex 0.153.4; `acceptance/RESULTS.md` holds the journeys H1 to H12.

- Ledger skill: `.jevellan/ledger.jsonl` with twenty event kinds, an O_EXCL lock with stale takeover, secret masking on
  every line, the projection of section 4 (H-008), `ledger.mjs` (task create, guarded hand appends, status, show,
  report, wait, tail, verify, workflow recording from a workflow file), and the Stop, PostToolUse and SessionStart
  hooks.
- Router skill (placement): Jev client, `route.mjs` (menu from providers.json and the probes, the state of the skills
  brief 7.2, model, effort and provider questions, `task.placed` with decision files, workflow questions, owner
  placements), `providers.mjs check` (Claude usage headers, Codex app-server rate limits, Jev), and the placement policy
  with its evals.
- Git skill: `worktree.mjs` (task worktrees with the `.claude` link and the project's setup command; archive, never
  delete) and `land.mjs` (every step done, a clean tree, Jev's landing route, the checks, a fast-forward of the default
  branch or a parent's branch; verify-then-land and ask-owner), with the landing policy and its evals.
- Runtime skills: Claude (`claude -p` with its own session id, the worker environment with its own config folder and
  no owner instructions, the placement guard, read-only tool sets, resume, stop, status) and Codex (`codex exec` under a
  runner that records the thread id and the report).
- The eight duty skills and the three workflow skills, ported from the skills repo with the report file in place of
  the report tool.
- The coordinator skill: the brief's body, the order of a task's operations in role phrases, and the conversation
  voice.
- `install.mjs`, `scripts/check-roles.mjs` (roles, role phrases, the twenty kinds, shared library copies, generated
  `docs/roles.md`), `scripts/run-trigger-evals.mjs`.
