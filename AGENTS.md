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

## Testing

`npm test` runs every unit suite and the role lint. Acceptance journeys run with
`node acceptance/<journey>.mjs` against `~/jevellan-projects/jevellan-harness-sandbox` and need the provider seeds in
`~/.jevellan-harness/`.
