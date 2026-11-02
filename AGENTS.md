# Working in this repository

This repository is a set of skills for Claude Code (and, for the parts they can run, Codex and Cursor). There is no
daemon, no CLI and no database program. Each part is a folder under `skills/` with a `SKILL.md` and, where it must act
deterministically, plain Node scripts next to it.

## Rules

- Node 22.13 or later, ESM `.mjs`, Node built-ins only. No `node_modules` anywhere under `skills/`, no build step.
- Skills depend on roles, never on names. A `SKILL.md` body says "use the placement skill", "use the ledger skill",
  "use the runtime skill for provider kind <kind>", and never names another skill. `scripts/check-roles.mjs` enforces
  it and regenerates `docs/roles.md`; run `npm test` before every commit.
- The model decides whether; scripts own how. Anything that touches a branch people ship from, a secret or a
  provider's quota is a script with guards that refuses (exit 2 with the reason) when its conditions are not met.
- The ledger is append-only. Nothing edits or truncates `.jevellan/ledger.jsonl`; there are exactly twenty event kinds.
- Hooks finish in under 300 ms and exit 0 on any internal error; they log to `.jevellan/hooks.log`.
- Secrets never appear in the ledger, in logs, in reports, on command lines or in skill bodies. They live in
  `~/.jevellan-harness/secrets/` (mode 600) and reach child processes through the environment a script builds.
- No tracked `CLAUDE.md` and no tracked `.claude/` here or in any project the skills touch.
- No attribution of any kind in commits or authored text. Commits use the machine's git identity.
- Archive, never delete. Never deploy, never touch production.
- Use the plain dash "-", not the em dash.

## Layout

- `skills/<name>/SKILL.md` with frontmatter `name`, `description` (starting with the role word) and `jh-role`.
- `skills/<name>/scripts/*.mjs`, the deterministic parts; `skills/jevellan-ledger/hooks/*.mjs`, the three hooks.
- `test/` holds `node --test` suites for every script and hook, using temporary projects and simulated stdin.
- `acceptance/` holds the H1 to H12 journeys that run on a real machine; `acceptance/RESULTS.md` is their record.
- `docs/decisions.md` (append-only, H-numbers), `docs/findings.md` (verified tool behaviour), `docs/roles.md`
  (generated).

## Shared code between skills

A skill may not import another skill by name. Scripts reach a sibling skill through its role with
`scripts/lib/roles.mjs` (`importFromRole('ledger', 'scripts/lib/ledger.mjs')`). Code two skills share is kept as
identical copies: `roles.mjs` in every skill with scripts, and `common.mjs`, `task.mjs`, `prompt.mjs`, `proc.mjs` and
`cli.mjs` in both runtime skills. `scripts/check-roles.mjs` refuses copies that differ, so change one and copy it.

## Environment variables

- Set by the runtimes for a worker and read by the hooks: `JH_TASK`, `JH_STEP`, `JH_DUTY`, `JH_PROJECT`, `JH_SESSION`,
  `JH_CWD` (the step's worktree).
- For tests and second installations: `JH_HARNESS_HOME` (instead of `~/.jevellan-harness`), `JH_CLAUDE_BIN` and
  `JH_CODEX_BIN` (fake binaries), `JH_JEV_URL` and `JH_ANTHROPIC_URL` (fake servers, loopback addresses only),
  `JH_TEST_TMPDIR` (where the suites make their temporary folders).

## Testing

- `npm test` runs every unit suite and the role lint; run it with Node 22 first on PATH.
- `node scripts/run-trigger-evals.mjs [--skill <name>]... [--runs N]` runs the trigger evals through real `claude -p`
  sessions on a provider token and writes `evals/RESULTS.md` (it costs money: about 12 USD per full run of one run per
  case). A change to a description or a calling body is recorded in that skill's `CHANGELOG.md`.
- The acceptance journeys run with `node acceptance/<journey>.mjs` against `~/jevellan-projects/jevellan-harness-sandbox`
  (or a fresh baseline clone, `acceptance/clone-sandbox.mjs`) and need the provider seeds in `~/.jevellan-harness/`.
  Each writes `acceptance/results/<id>.json` and regenerates `acceptance/RESULTS.md`. The coordinator journeys drive an
  interactive session in the tmux session `jh-coord` (`acceptance/coord.mjs`) and count slips from its transcript;
  `acceptance/recheck-slips.mjs` re-runs that analysis on saved transcripts, recording why.
