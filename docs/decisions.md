# Decisions

Choices the brief left open or that the machine forced, numbered from H-001, append-only. Each says what and why.

## H-001 Workers run with their own Claude config folder and without the owner's personal instructions

Section 5.3's worker environment passes HOME through and names no config folder, so a worker would load the owner's
`~/.claude/settings.json` (PreToolUse, Stop, SessionStart and SessionEnd hooks, seven plugin entries, auto memory,
an advisor model), write its transcripts, `.claude.json` and memory into the owner's `~/.claude`, and read the owner's
`~/.claude/CLAUDE.md` and `~/.claude/rules/*.md` (docs/findings.md: a worker answered "Caveman mode" present). None of
that is the worker's brief, and the owner's hooks would run once per tool call of every worker. So `lib/env.mjs`
adds `CLAUDE_CONFIG_DIR=~/.jevellan-harness/claude-config` (mode 700, created on first use) and every worker gets
`--settings '{"claudeMdExcludes":["<owner home>/.claude/**"]}'`. HOME stays the owner's, so git, gh, `~/.gitconfig`
and the Playwright cache work as before. `--setting-sources project,local` was tried instead and does not keep the
ancestor rules out (findings), and `--bare` and `--safe-mode` would drop the project hooks the ledger depends on.
What a worker is told is therefore exactly section 6: the worker rules, its duty, the project's `AGENTS.md` and the
task block. This follows the skills run's D-058 and D-070, which kept the owner's personal rules out of workers for
the same reason. The coordinator is the owner's own session and keeps the owner's configuration untouched.

## H-002 The sandbox's test command

The sandbox's tests need `TZ=UTC` and `SANDBOX_DATA_DIR` by design, and its bare `npm test` fails (findings, and the
skills run's D-066). `install.mjs` detects `npm test` as section 7 says; the journey setup then writes `testCommand`
`TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test` into the sandbox's `.jevellan/project.json`, so landing checks and
workers run the suite the way it passes. Nothing in the sandbox's own files changes for it.

## H-003 providers.json points at the harness's own secret files

Section 8 says to copy `~/.jv/providers.json` and drop the `home` fields. Its `keyFile` and `tokenFile` values name
files under `~/.jv/secrets/`; read at runtime they would make the harness depend on the skills run's folder, which
section 0 and section 8 forbid. The copy rewrites the prefix `~/.jv/secrets/` to `~/.jevellan-harness/secrets/`,
where phase 0 copied the three files that exist (`jev.key`, `claude-main.token`, `claude-second.token`). Entries
whose key files do not exist (`glm`, `deepseek`, `kimi`) and the `openai-compatible` kind (no runtime skill this
night) are kept in the file and left out of the placement menu by the router, with the reason in its output.

## H-004 Where the reference checkout lives

The skills repo is cloned from GitHub `main` (3284dd5) into `~/.jevellan-harness/reference/jevellan-skills`, read
only. The owner's `~/dev/jevellan-skills` checkout is never opened, so nothing this run does can touch the other
run's working tree. Nothing under `skills/` reads the reference at runtime.

## H-005 The worker prompt always follows `--`

`--tools` and the other list flags of Claude Code take every following word (findings). Every `claude` command line
the runtime builds ends with `--` and then the prompt, so a prompt can never be read as a tool name.

## H-006 Manual probes stand in for providers.mjs check before phase 2

Section 8 asks `providers.mjs check` to show both Claude providers ready and Jev reachable before phase 1 starts, but
`providers.mjs` is a phase 2 script. Phase 0 ran the same probes by hand (a one-turn `claude -p` per token, `GET
/v1/models` for Jev; findings) and records the result in the status file; phase 2 reruns them through
`providers.mjs check`.

## H-007 The Stop hook is the report path for Claude workers

Phase 0 verified that Claude Code 2.1.316 runs Stop hooks in `-p` mode and honours `decision: block` there
(findings). So `stop.mjs` records reports for Claude workers in `-p` and in interactive sessions alike, and the Claude
runtime's `start.mjs` returns at once instead of staying alive to run the hook's logic at exit (section 4's
fallback is not needed). The Codex runtime keeps its small parent process, because Codex runs no Stop hook.
