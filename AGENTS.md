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
- `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`: the repository is also a Claude Code plugin and
  its one-plugin marketplace; `hooks/hooks.json` registers the ledger's hooks for the plugin. Bump `version` in
  `package.json` and `plugin.json` together for a release (a test checks they match); never add a `package-lock.json`
  at the root (Claude Code would run npm in the plugin cache).
- `skills/<name>/scripts/*.mjs`, the deterministic parts; `skills/jevellan-ledger/hooks/*.mjs`, the three hooks.
- `skills/<name>/test/` holds the skill's own `node --test` suites, run with only that skill present
  (`scripts/test-skills.mjs`); `test/` holds the suites of several skills together, the installer and the lints.
- `acceptance/` holds the H1 to H12 journeys that run on a real machine; `acceptance/RESULTS.md` is their record.
- `behaviour/` holds the behaviour evals: real coordinator sessions on small fixture repositories, scored on what the
  harness did (ledger, reports, git, gh calls, what the owner was told); `behaviour/RESULTS.md` is their record and
  `behaviour/README.md` says how to run and add one.
- `docs/decisions.md` (append-only, H-numbers), `docs/findings.md` (verified tool behaviour), `docs/roles.md`
  (generated), `docs/endpoint-sessions.md` (sessions on a third party's endpoint: never by default, only in the projects
  the provider's `projects` list names).

## Decoupling over efficiency

The owner's rule for this repository: decoupling wins over efficiency, always. Each skill must keep working when it
is copied alone into another project next to skills that merely have the same roles, so nothing in a skill may depend
on how a sibling is written, only on what its public interface promises. Agents (and people) reach for the efficient
shared module by habit; the repository refuses it, and `npm test` fails when it happens.

- A skill uses another skill only through that skill's public interface: the scripts at the top of its `scripts/`
  folder, run as a child process with JSON on stdin or argv and JSON on stdout. Scripts find the other skill by role
  with their own `scripts/lib/roles.mjs`: `runRole('ledger', 'ledger.mjs', ['show', T, '--json'])` returns
  `{code, stdout, stderr, json}`. The script name is a literal and must be listed in the target skill's
  `## Interface` section. Importing, requiring or reading anything under another skill's `scripts/lib/` is
  forbidden; reading a sibling's `SKILL.md` through the role scan (its frontmatter, a duty's body) is the scan itself.
- Every `SKILL.md` ends with a short `## Interface` section: its public scripts, what each takes and prints, and its
  exit codes, or "No scripts." A script that only its own skill runs lives in `scripts/lib/`, not at the top.
- The ledger keeps the meaning of its lines. Other skills read a task with `ledger.mjs show T --json` (the
  projection, every step's views since and before its last retry reset, and `lastSeq`) and append with
  `ledger.mjs record <kind>` or `append <kind>` plus `--if-last-seq <lastSeq>`: a guard is checked by the calling
  script on what it read, and the append is refused with exit 6 when the task changed meanwhile, so the script reads
  again. Nothing outside the ledger skill re-implements the projection.
- Small helpers stay duplicated: each skill keeps its own copy (`roles.mjs`, `ledger-client.mjs`, `project.mjs`,
  `ids.mjs`, `redact.mjs`, `lock.mjs`, and the runtimes' `common.mjs`, `task.mjs`, `prompt.mjs`, `proc.mjs`,
  `cli.mjs`). Copies may drift; `scripts/check-roles.mjs` prints a notice listing the copies that differ and never
  fails on them. That is the price of portability.
- Shared state is the project's `.jevellan/` folder (above all the ledger), `~/.jevellan-harness/`, the task's worktree
  and Node's built-ins. Nothing else is shared ground.
- Each skill passes its own tests (`skills/<x>/test/`) with only its folder present: `scripts/test-skills.mjs` copies
  the folder alone and runs them there. A test that needs another role builds a small fake of it (a folder such as
  `fake-ledger` with a `SKILL.md` carrying the role and a script answering canned JSON) next to the copy, never the
  real sibling. Tests of several real skills together live in `test/` at the root.
- `scripts/check-decoupling.mjs` (run by `npm test`) fails on: an import, require, `createRequire`, read or path
  string that leaves a skill's folder other than the shared ground; the skills folder (`SKILLS_ROOT`) or a scanned
  skill's folder used outside `roles.mjs`; another skill's folder name anywhere under `skills/<x>/`; a root module used
  from `skills/`; a reference to `~/.claude` or `.claude/settings` from a skill (only `install.mjs` touches settings);
  an event kind beyond the twenty; a `runRole` target missing from the target's Interface section; a symbolic link, a
  `node_modules` folder or a TypeScript file under a skill.
  `docs/decoupling.md` explains each kind of coupling and how the lint catches it. `test/isolation.test.mjs` copies
  each skill alone into a project and checks that every public script answers `--help` and refuses a role-dependent
  command with exit 2 and the role-missing sentence instead of crashing.

| The temptation | What to do instead |
|---|---|
| Share a module between two skills | Copy it into each skill; let the copies drift if they must |
| Import a sibling's code | `runRole(role, 'script.mjs', args)` and JSON on stdout; add the command to its Interface |
| Add a field everyone reads | Add an event kind, only while there are fewer than twenty (there are twenty now, so carry it in an existing kind's data) |
| Write new shared state | Put it in the ledger, or in the project's `.jevellan/` folder |
| Reference a skill by name | Reference its role ("the ledger skill"), and find it with `skillsWithRole` |
| Re-derive a ledger rule (resets, step ends, task state) | Read it from `show --json`; if it is missing, add it to the ledger's output |
| Check a guard inside another skill's lock | Check it on what you read and append with `--if-last-seq`; read again on exit 6 |

## Environment variables

- Set by the runtimes for a worker and read by the hooks: `JH_TASK`, `JH_STEP`, `JH_DUTY`, `JH_PROJECT`, `JH_SESSION`,
  `JH_CWD` (the step's worktree).
- For tests and second installations: `JH_HARNESS_HOME` (instead of `~/.jevellan-harness`), `JH_CLAUDE_BIN`,
  `JH_CODEX_BIN` and `JH_GH_BIN` (fake binaries), `JH_JEV_URL` and `JH_ANTHROPIC_URL` (fake servers, loopback addresses only),
  `JH_TEST_TMPDIR` (where the suites make their temporary folders).

## Testing

- `npm test` runs every skill's own suites alone (`scripts/test-skills.mjs`), the repository suites, the role lint and
  the decoupling lint; run it with Node 22 first on PATH.
- `node scripts/run-trigger-evals.mjs [--skill <name>]... [--runs N]` runs the trigger evals through real `claude -p`
  sessions on a provider token and writes `evals/RESULTS.md` (it costs money: about 12 USD per full run of one run per
  case). A change to a description or a calling body is recorded in that skill's `CHANGELOG.md`.
- The acceptance journeys run with `node acceptance/<journey>.mjs` against `~/jevellan-projects/jevellan-harness-sandbox`
  (or a fresh baseline clone, `acceptance/clone-sandbox.mjs`) and need the provider seeds in `~/.jevellan-harness/`.
  Each writes `acceptance/results/<id>.json` and regenerates `acceptance/RESULTS.md`. The coordinator journeys drive an
  interactive session in the tmux session `jh-coord` (`acceptance/coord.mjs`) and count slips from its transcript;
  `acceptance/recheck-slips.mjs` re-runs that analysis on saved transcripts, recording why.
- The behaviour evals run with `node behaviour/run.mjs [--plugin <ref>|working] [--case ...] [--runs N]` (real models;
  see `behaviour/README.md`); their checks run on hand-written evidence in `test/behaviour-checks.test.mjs`, part of
  `npm test`. Their coordinators run in tmux sessions named `jh-beh-<case>-<label>-<n>`.
