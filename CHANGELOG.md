# Changelog

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
