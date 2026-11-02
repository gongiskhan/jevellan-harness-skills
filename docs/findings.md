# Findings

Verified facts about the installed tools on dev-madrid, the hooks, skills behaviour and Jev. Append-only; every
entry is dated and says how it was checked. Times are UTC.

## 2026-11-01 Machine and tool versions (phase 0)

- Claude Code 2.1.316 (`claude --version`), Codex CLI 0.153.4 (`codex --version`), Node 22.23.2 at
  `/home/ggomes/.nvm/versions/node/v22.23.2/bin/node` (the default `node` of a login shell is 20.19.4), git 2.43.0,
  tmux 3.4, rsync present, gh logged in as gongiskhan.
- Jev: `GET https://api.typesafe.ai/v1/models` with the key from `~/.jevellan-harness/secrets/jev.key` answered 200
  in 163 ms and listed `jev-latest` (released 2026-10-22) and `jev-preview`.
- Both Claude subscription tokens (`claude-main`, `claude-second`) answered a one-turn
  `claude -p --max-turns 1 --model claude-haiku-5-5` with only `CLAUDE_CODE_OAUTH_TOKEN` from the token file, an
  isolated `CLAUDE_CONFIG_DIR` and a minimal environment, in about 3 s each ("READY"). This substitutes for
  `providers.mjs check` until phase 2 delivers it (H-006).
- `codex login status` with the owner's default `~/.codex` prints "Logged in using ChatGPT".
- Skillio is checked out at `~/dev/skillio` (skills `building-skills`, `checking-skills`, `improving-skills`,
  `web-testing`; `scripts/skillio.mjs`), on the branch `jv-eval-runner` the skills run left checked out.

## 2026-11-01 Claude Code 2.1.316 flags (from `claude --help`, phase 0)

In the help text: `-p/--print`, `--session-id <uuid>`, `-r/--resume [value]`, `--model <model>`,
`--effort <level>` (low, medium, high, xhigh, max), `--permission-mode <mode>` (acceptEdits, auto,
bypassPermissions, manual, dontAsk, plan), `--append-system-prompt <prompt>`, `--system-prompt <prompt>`,
`--output-format text|json|stream-json`, `--verbose`, `--include-hook-events` (hook lifecycle events in the
stream-json output), `--include-partial-messages`, `--tools <tools...>` ("" disables all tools), `--allowedTools`,
`--disallowedTools`, `--setting-sources <sources>` (user, project, local), `--settings <file-or-json>`,
`--mcp-config`, `--strict-mcp-config`, `--add-dir`, `--no-session-persistence`, `--max-budget-usd`,
`--permission-prompts host|none`, `--fork-session`, `--system-prompt-snapshot on|off` (on by default: the system
prompt is recorded on the first request and resent verbatim on every resume, until compaction), `--bare` (skips
hooks and CLAUDE.md discovery; not usable here because the ledger is hooks), `--safe-mode` (disables skills and
hooks; not usable here), `--bg`, `--worktree`.

Not in the help text: `--append-system-prompt-file` and `--max-turns` (the skills run found both accepted by
2.1.316; both strings are in the binary). Verified again in phase 3 (see the runtime entry).

`--tools`, `--allowedTools`, `--disallowedTools`, `--add-dir` and `--mcp-config` are variadic: a positional prompt
right after them is taken as one more value. `claude -p --tools "" "<prompt>"` failed with "Input must be provided
either through stdin or as a prompt argument when using --print". The runtime therefore always ends the argument
list with `--` before the prompt; `claude -p ... --tools "" -- "<prompt>"` answered.

## 2026-11-01 Codex CLI 0.153.4 flags (from `codex exec --help` and `codex exec resume --help`, phase 0)

- `codex exec [OPTIONS] [PROMPT]`: `--json` (JSONL events on stdout), `-C, --cd <DIR>`, `-m, --model <MODEL>`,
  `-c, --config <key=value>` (TOML value, so `-c model_reasoning_effort=high` is accepted as a string),
  `--dangerously-bypass-approvals-and-sandbox`, `-s, --sandbox read-only|workspace-write|danger-full-access`,
  `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`, `--output-schema <FILE>`,
  `-o, --output-last-message <FILE>`, `--add-dir`, `-p, --profile`. A prompt of `-` (or none) is read from stdin.
- `codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]`: `--last`, `--all`, `-m`, `-c`, `--json`,
  `--dangerously-bypass-approvals-and-sandbox`, `--skip-git-repo-check`, `--ephemeral`, `--ignore-user-config`,
  `-o`. It has no `-C`: a resume runs in the working directory of the process, so the runtime spawns it with the
  worktree as cwd.
- `codex login status` exists (it reads the stored file only; the skills run found it says "Logged in" for an
  expired login too).

## 2026-11-01 Hooks and sessions in `claude -p` (phase 0 probes)

Checked with a throwaway repository under `~/.jevellan-harness/probe/proj` whose `.claude` is a symlink to another
folder (the worktree shape), a project `.claude/settings.json` with Stop, SessionStart (`startup`, `resume`) and
PostToolUse hooks that write their stdin to files, `CLAUDE_CONFIG_DIR` pointing at a harness folder, the
claude-second token, `claude-sonnet-5-5` effort low, `--output-format stream-json --verbose --include-hook-events`.

- Project hooks run although `CLAUDE_CONFIG_DIR` points elsewhere and `.claude` is a symlink; the skill under
  `.claude/skills/` is listed and the Skill tool can invoke it.
- Stop hooks run in `-p` mode. `{"decision":"block","reason":"..."}` on stdout (exit 0) continues the turn with the
  reason: the model replied "Hello!", was blocked, then replied with the word the reason asked for, and the result
  was that word. The second Stop call had `stop_hook_active: true`, the first `false`. The Stop input carries
  `session_id`, `transcript_path`, `cwd`, `prompt_id`, `permission_mode`, `effort` ({level}), `hook_event_name`,
  `stop_hook_active`, `last_assistant_message`, `background_tasks`, `session_crons`. So the Stop hook is the primary
  report path for Claude workers, and the runtime does not need the exit fallback of section 4 (H-007).
- SessionStart: plain stdout and the `hookSpecificOutput.additionalContext` form both reach the model's context in
  `-p` mode (asked for "the secret word" it answered the word from either form). The hook fires for `-p --resume`
  as well (`hook_started:SessionStart` in the resumed turn's stream).
- `-p --session-id <uuid>` then `-p --resume <uuid>`: the second turn has the same session id and recalled the word
  from the first. The transcript is `$CLAUDE_CONFIG_DIR/projects/<cwd with every non-alphanumeric character as
  "-">/<uuid>.jsonl` (the Stop input's `transcript_path` names it).
- Read-only shape `--permission-mode dontAsk --tools Read,Glob,Grep,WebSearch,WebFetch,Skill`: the Skill tool
  invoked the project skill; a Write call failed with "No such tool available: Write"; there is no Bash tool.
- `--permission-mode bypassPermissions` in `-p` mode with a fresh `CLAUDE_CONFIG_DIR` shows no dialog and does not
  hang.

## 2026-11-01 Owner instructions reach workers through ancestor folders (phase 0 probes)

The owner's `~/.claude/CLAUDE.md` and `~/.claude/rules/caveman.md` are loaded as project memory for any session whose
working folder is under `/home/ggomes`, because Claude Code reads `CLAUDE.md`, `.claude/CLAUDE.md` and
`.claude/rules/` of every ancestor folder. Asked whether its context held a rule named "Caveman mode" and a rule
about the em dash, a worker answered `CAVEMAN=YES EMDASH=YES` with an isolated `CLAUDE_CONFIG_DIR`, with the owner's
own config folder, and with `--setting-sources project,local`. With
`--settings '{"claudeMdExcludes":["/home/ggomes/.claude/**"]}'` it answered `CAVEMAN=NO EMDASH=NO`.
`claudeMdExcludes` is in the 2.1.316 settings schema ("Glob patterns or absolute paths of CLAUDE.md files to exclude
from loading. Patterns are matched against absolute file paths using picomatch. Only applies to User, Project, and
Local memory types"). The owner's `~/.claude/settings.json` also carries hooks (PreToolUse, Stop, SessionStart,
SessionEnd, UserPromptSubmit, PermissionRequest), seven plugin entries, an auto-memory setting and an advisor
model, which would all run inside every worker that shares the owner's config folder. See H-001.

## 2026-11-01 The sandbox copy (phase 0)

- `~/jevellan-projects/jevellan-harness-sandbox` is an `rsync -a` copy of `jevellan-live-sandbox` at `43e279e`
  without `node_modules`, `.jv-evidence`, `.claude`, `.jevellan`, the APM leftovers (`apm_modules`, `apm.yml`,
  `apm.lock.yaml`, all untracked) and `.git/worktrees` (the skills run's worktree records, which point into
  `~/.jv/worktrees`). `origin` was removed; the copy has no remote.
- Its bare `npm test` fails by design (one test requires `TZ=UTC`, another `SANDBOX_DATA_DIR`): 2 files failed.
  With `TZ=UTC SANDBOX_DATA_DIR=.sandbox-data` both suites pass: `npm test` 34 of 34, `npm run test:browser` 11 of 11
  (Playwright, chromium from `~/.cache/ms-playwright`), `npm run lint` clean. See H-002.
- Its `AGENTS.md` says "Work in your assigned worktree and publish a pull request. Never run scripts/owner-only.sh
  yourself"; `.github/workflows/nightly-deploy.yml` exists. Neither is touched.
- Deviation recorded for H12: the read-only `git status` and `git log` this run ran in `jevellan-live-sandbox` at
  22:46:14Z created and removed `.git/index.lock`, which moved the mtime of that `.git` folder; no file in it
  changed (`index` still 19:19:29Z). No git command runs there again, and H12 compares file contents and refs, not
  the folder's own mtime.

## 2026-11-01 The worker's shell does not see the OAuth token (phase 1)

A `claude -p` worker started with `CLAUDE_CODE_OAUTH_TOKEN` in its environment and `bypassPermissions`, asked to run
`printenv CLAUDE_CODE_OAUTH_TOKEN | wc -c`, answered `0`: Claude Code 2.1.316 keeps that variable out of the Bash
tool's environment. A worker running `env` therefore cannot print the token into its transcript or the runtime log.
(`CLAUDE_CODE_SUBPROCESS_ENV_SCRUB`, which needs bubblewrap, is a separate and stronger mode that also confines the
subprocess; it is not used, `bwrap` is installed at `/usr/bin/bwrap`.)

## 2026-11-01 Hook timings (phase 1, unit suites)

Over 46 runs each with a small ledger: Stop hook median about 60 ms (max 83), PostToolUse about 58 ms (max 69),
SessionStart about 58 ms (max 69), all inside the 300 ms budget; most of it is Node's start-up. 10 processes
appending 50 lines each through the library took about 295 ms with `seq` contiguous; through the command line about
4.3 s. A lock left by a dead pid was taken over in 0.7 ms. `ledger.mjs wait` returned between 43 and 438 ms after
the report line was written.

## 2026-11-02 The Claude runtime in `claude -p` (phase 3, journey H5)

Checked by `acceptance/h05-worker.mjs` on the sandbox: a single investigate task, placed by the real Jev on
`claude-opus-5-5` effort `max` via claude-second, started with the installed `start.mjs`.

- `--append-system-prompt-file <file>` is accepted by `claude -p` in 2.1.316 and its text reaches the model: the
  worker followed the append's "Use the duty skill for investigate now" and its first tool call was the Skill tool
  with `{"skill": "jevellan-duty-investigate"}`.
- `--effort max` with `--model claude-opus-5-5` is accepted.
- `--session-id <uuid>` names the conversation: the stream's session id and the transcript file
  `~/.jevellan-harness/claude-config/projects/<worktree path with non-alphanumerics as "->/<uuid>.jsonl` both carry it.
  `claude -p --resume <uuid> -- "From the coordinator: Continue."` continued the same conversation (same session id in
  the stream) and its report reached the ledger through the Stop hook like the first turn's.
- The read-only tool set of H-021 works: in `--permission-mode dontAsk` with `--tools
  Read,Glob,Grep,WebSearch,WebFetch,Skill,Write,Edit` and `--allowedTools Read Glob Grep WebSearch WebFetch Skill
  "Write(./.jevellan/report.json)" "Edit(./.jevellan/report.json)"`, a worker told to write `notes.txt` and then the
  report got the first refused ("denied permission because Claude Code is running in don't-ask mode") and the second
  written. The investigate worker wrote only its report file and left the worktree clean.
- Times: placement 443 ms; start to report 87 s (Opus at max effort); resume to report 35 s; `stop.mjs` ended a running
  turn with SIGTERM to the process group in 456 ms, and the projection then showed the task stopped.

## 2026-11-02 A real implement step landed (phase 4 check)

`acceptance/p4-implement.mjs`, a scripted chain over the installed scripts on a clone of the sandbox at its baseline:
a single implement task "README: how to run" got its worktree (with `npm ci` as its setup command), Jev placed it on
`claude-sonnet-5-5` medium via claude-second (p 0.89), the worker committed a "How to run" section and reported done
through the Stop hook, `step.done` passed its guard, and `land.mjs` asked Jev (land 0.97), ran
`TZ=UTC SANDBOX_DATA_DIR=.sandbox-data npm test` in the worktree (passed) and fast-forwarded the clone's main with
`merge --ff-only`, in 19 s from the task to the landing. The landed commit carries no attribution.
