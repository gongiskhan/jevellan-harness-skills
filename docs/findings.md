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

## 2026-11-02 The coordinator in tmux (phase 5)

- The workspace trust dialog of an interactive `claude` in a folder the owner never opened defaults to "No, exit":
  Enter quits. The journeys move to "Yes, I trust this folder" first. The bypass-permissions warning does not appear
  (the owner's settings skip it).
- An interactive transcript ends with metadata entries (`mode`, `permission-mode`, `atis-latch`, `bridge-session`)
  after the last message; whether the session is idle is read from the last `user` or `assistant` entry.
- A background Bash command (`ledger.mjs wait` run with run_in_background) wakes the interactive session when it
  exits: in H6 the coordinator went from the step's report to step.done, landing, the extra verify step and the
  landing again without any input. Its output file is read with `cat` of the task's output file.
- In zsh, a tmux target written `=jh-coord:` on a command line is equals expansion ("jh-coord: not found"); it must be
  quoted. The journeys pass it to tmux without a shell.

## 2026-11-02 Codex 0.153.4 under the Codex runtime (phase 6, P6 smoke and H10)

- `codex exec --json` prints `{"type":"thread.started","thread_id":...}`, `{"type":"turn.started"}`,
  `{"type":"item.completed","item":{"type":"agent_message"|...}}` and `{"type":"turn.completed","usage":{input_tokens,
  cached_input_tokens, cache_write_input_tokens, output_tokens, reasoning_output_tokens}}`. A prompt of `-` is read from
  stdin. `-c model_reasoning_effort=low|medium|high` and `--dangerously-bypass-approvals-and-sandbox` are accepted
  together with `-C`, `-m gpt-6-astra`.
- `codex exec resume --json -m <model> -c model_reasoning_effort=<e> --dangerously-bypass-approvals-and-sandbox
  <thread id> -`, run with the worktree as its working directory, continued the same thread (P6: resume to report 15 s).
- A single investigate step placed on GPT (the owner's `~/.codex` login, "Logged in using ChatGPT") reported through
  `.jevellan/report.json`, which the runner recorded as `step.report` and archived: 20 s (P6, effort low) and 25 s (H10,
  effort medium) from start to report. The Codex probe of `providers.mjs check` reported the account ready with 1% of
  its weekly window used.
- In H7, Jev placed the unit test task on `gpt-6-astra` high via codex (p 0.51); the coordinator started it with the
  Codex runtime skill and it landed after its checks passed.

## 2026-11-02 Final: every verification result and every flag, in one place

Verifications the brief asks for, and what they found (the entries above have the detail):

- Stop hooks run in `claude -p` (2.1.316), and `{"decision":"block","reason":...}` continues the turn; the second call
  carries `stop_hook_active: true`. The Claude runtime therefore needs no exit-time fallback (H-007). Verified again by
  H3 with real workers: a worker without a report was blocked twice and then recorded blocked and synthesized.
- SessionStart stdout reaches the session's context in `-p` and in interactive sessions, for `startup` and `resume`;
  the `hookSpecificOutput.additionalContext` form works too. H3 and H9 saw a worker's task ledger and a coordinator's
  open work in context; H9's restarted coordinator picked up its task from it.
- `--session-id <uuid>` is honoured in `-p` and names the transcript; `--resume <uuid>` continues the same
  conversation (H5).
- `--append-system-prompt-file` and `--effort` (low to max) are accepted; the append reaches the model (H5's worker
  followed its duty line).
- `--tools` restricts the read-only duties: with `--permission-mode dontAsk`, `--tools
  Read,Glob,Grep,WebSearch,WebFetch,Skill,Write,Edit` and `--allowedTools` naming only the report file (and plan.md),
  every other write is refused (H5 probe).
- Codex: every flag of section 5.3 exists in 0.153.4 and works as written (`exec --json -C -m -c
  model_reasoning_effort=... --dangerously-bypass-approvals-and-sandbox`, prompt from stdin with `-`); `exec resume`
  takes the thread id and has no `-C`. H10 and P6 ran live; `codex login status` said logged in, so H10 was not skipped.
- Jev answers placement in about 0.3 to 0.5 s; a missing key is exit 2 "Jev: no key configured" with nothing appended
  (H4).
- The owner's personal instructions reach any session under the owner's home through ancestor folders unless
  `claudeMdExcludes` keeps them out; Claude Code keeps `CLAUDE_CODE_OAUTH_TOKEN` out of the worker's shell.

Claude Code 2.1.316, supported and used: `-p`, `--session-id`, `--resume`, `--model`, `--effort`, `--permission-mode`
(bypassPermissions, dontAsk), `--tools` (variadic: the prompt follows `--`), `--allowedTools`, `--settings` (JSON:
`claudeMdExcludes`, `attribution`, `permissions.deny`), `--append-system-prompt-file` and `--append-system-prompt`,
`--output-format stream-json`, `--verbose`, `--include-hook-events`, `--max-turns` (answer and converse; the trigger
evals), `--no-session-persistence` (the trigger evals), and the environment `CLAUDE_CODE_OAUTH_TOKEN`,
`CLAUDE_CONFIG_DIR`, `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`. Present but not
used: `--setting-sources` (it does not keep ancestor CLAUDE.md files out when project settings must load), `--bare` and
`--safe-mode` (both drop the hooks the ledger needs), `--bg`, `--worktree`, `--system-prompt-snapshot`,
`--permission-prompts`, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` (needs bubblewrap and confines subprocesses). Not in the help
text but accepted: `--append-system-prompt-file`, `--max-turns`. Behaviour to know: the interactive trust dialog
defaults to "No, exit"; a settings file that fails validation is ignored silently in `-p` mode; transcripts end with
metadata entries after the last message.

Codex CLI 0.153.4, supported and used: `exec --json`, `-C`, `-m`, `-c key=value`,
`--dangerously-bypass-approvals-and-sandbox`, `-` for the prompt on stdin, `exec resume <thread id> -` (with `--json`,
`-m`, `-c`, the bypass flag), `login status`, `app-server` with `initialize`, `account/read` (`refreshToken: false`) and
`account/rateLimits/read`. Present but not used: `-s/--sandbox` (brief 5.3 bypasses it), `--ephemeral`,
`--output-schema`, `-o`, `--ignore-user-config`, `--skip-git-repo-check`. Not supported: `-C` on `exec resume`.

Journeys (acceptance/RESULTS.md): H1 to H10 and H12 pass; H11 is blocked by section 10's limit of three improvement
rounds per skill with 15 of 17 skills at or above the thresholds (H-030).

## 2026-11-02 Distribution as a Claude Code plugin (0.2.0, Claude Code 2.1.316)

Verified on dev-madrid in temporary HOME folders (each its own `~/.claude`), with a Claude subscription token passed in
the environment by a small script, never on a command line.

- Layout: the repository root is the plugin root. `.claude-plugin/plugin.json` (name `jevellan-harness`, version from
  `package.json`), `skills/` and `hooks/hooks.json` load from the standard layout without naming them in the manifest
  (naming them would be a second registration). `claude plugin validate .` passes with two warnings: no icon, and (until
  it was added) no marketplace description. There is no `package-lock.json` at the root on purpose: with a lockfile,
  Claude Code runs npm in the plugin's cache folder at install.
- `claude --plugin-dir .` (cwd the repository) and `claude --plugin-dir <repo>` from a project: the init event lists the
  plugin as `jevellan-harness@inline`, version 0.2.0, and 17 skills named `jevellan-harness:<skill>`; in a project set
  up for the harness the SessionStart hook prints the coordinator line, and the Stop hook runs (exit 0).
- `claude plugin marketplace add <local path>` adds `jevellan-harness-skills` to the user settings
  (`extraKnownMarketplaces.<name>.source = {source: "directory", path}`); `claude plugin install
  jevellan-harness@jevellan-harness-skills --scope user` adds `enabledPlugins`. A directory-source plugin loads in place
  (the session lists the plugin's path as the marketplace folder, so edits apply at the next session); a copy is also
  written to `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`. A session in a project set up with
  `install.mjs --project-only` then has the 17 skills and the hooks with no `.claude` folder in the project.
- Hooks: `hooks/hooks.json` with the exec form (`"command": "node"`, `"args": ["${CLAUDE_PLUGIN_ROOT}/..."]`) works;
  `${CLAUDE_PLUGIN_ROOT}` is substituted in `args` and also set in the hook's environment. `node` is the first one on
  the session's PATH, with no login shell, in the exec and the shell form alike: with Node 20.19.4 first on PATH a
  probe hook ran v20.19.4. So a plugin's hooks need Node 22.13 or later first on PATH; the SessionStart hook says so
  in the session when it runs on an older Node, and every hook logs it to `.jevellan/hooks.log`. Workers are not
  affected: the runtime puts Node 22's folder first on their PATH.
- A worker's own `CLAUDE_CONFIG_DIR` hides the owner's user-scope plugins: a session with an empty config folder in a
  HOME where the plugin is installed lists no plugin, no skill and runs no hook. With `--plugin-dir <plugin root>` the
  same session has them. A real worker started by the runtime from the plugin folder (single investigate step,
  claude-haiku-5-5 low, claude-second) listed `jevellan-harness@inline` and the 17 skills, invoked
  `jevellan-harness:jevellan-duty-investigate` through the Skill tool, its PostToolUse hook wrote `session.event` and its
  Stop hook recorded the done report and `session.ended`; its worktree had no `.claude` link (H-038).
- Two registrations of the same hook both run: in a project installed with `install.mjs` while the plugin is enabled at
  user scope, the session lists 34 skills (17 from the project, 17 namespaced) and every SessionStart, PostToolUse and
  Stop event started two hook processes in parallel with the same input (Claude Code deduplicates identical commands
  only within settings files, and the two commands differ). With the claim of H-039 the ledger got one
  `session.started` and one `session.event`, and `hooks.log` named each skipped duplicate. Use one installation per
  project; the claim keeps a mixed one correct.
- The init event of 2.1.316 also lists built-in plugins (`cc-plugin-agents-md`, `cc-plugin-telemetry`,
  `cc-plugin-plugin-authoring`).
- From GitHub, after 0.2.0 was pushed (fresh temporary HOME folders): `claude plugin marketplace add
  gongiskhan/jevellan-harness-skills` writes `extraKnownMarketplaces.jevellan-harness-skills.source = {source:
  "github", repo}` and clones the repository to `~/.claude/plugins/marketplaces/jevellan-harness-skills/` (where the
  README points for `install.mjs --project-only`); `claude plugin install jevellan-harness@jevellan-harness-skills
  --scope user` copies the plugin to `~/.claude/plugins/cache/jevellan-harness-skills/jevellan-harness/0.2.0/`, and
  sessions load it from there. From that copy the git skill's `worktree.mjs create` found the ledger by role (no
  `.claude` link made), the Claude runtime's command line carries `--plugin-dir <that copy>`, and a session in a
  project set up with `--project-only` lists the 17 skills and runs the hooks. `claude plugin details` reports the
  plugin's always-on cost as about 1,556 tokens per session (the skill descriptions).
- Pinning: `claude plugin marketplace add gongiskhan/jevellan-harness-skills#v0.2.0` records `"ref": "v0.2.0"` in the
  source and checks the marketplace out at the tag; installing from it gives 0.2.0. `#v0.1.0` fails ("Marketplace file
  not found ... .claude-plugin/marketplace.json"): that tag predates the plugin.
- Auto-update: `"autoUpdate": true` on the marketplace's entry in `extraKnownMarketplaces` is accepted (the settings
  stay valid; the `claude plugin` commands work), but no CLI command shows it, and an entry written there by hand
  before any add is not picked up by the `claude plugin` commands ("Plugin not found in marketplace"). The update pass
  itself runs only in an interactive session, up to ten minutes after the first message (documentation), and was not
  observed here.

## Claude Code on an endpoint provider (2.1.323), 2026-11-13

Measured by running the real `claude -p` against a loopback Messages server that records every request (fake key,
no model behind it), for H-044 (`endpoint-sessions.md`).

- The client calls `POST <ANTHROPIC_BASE_URL>/v1/messages?beta=true` with `Authorization: Bearer <ANTHROPIC_AUTH_TOKEN>`
  and no `x-api-key`, and `stream: true` on every inference request. A model name it does not know gets a 1M-token
  window ("Claude Code doesn't recognize the model ..., so it assumes a context window of 1m tokens"); the `[1m]`
  suffix only adds the `context-1m-2025-08-07` beta header.
- Default request for an unknown model: `max_tokens` 32000, `thinking: {type: "adaptive", display: "omitted"}`,
  `output_config: {effort}` (`high` without `--effort`), `context_management: {edits: [clear_thinking_20251015]}`,
  no `temperature` or `top_p`, tool search on (a `ToolSearch` tool and a `DeferredToolPlaceholder` with
  `defer_loading: true`), seven beta headers.
- `CLAUDE_CODE_MAX_OUTPUT_TOKENS=65536` makes `max_tokens` 65536. `MAX_THINKING_TOKENS=0` and
  `CLAUDE_CODE_DISABLE_THINKING=1` each remove `thinking` and `context_management`. `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS=1`
  leaves three beta headers (`claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24`), removes
  `context_management` and tool search (21 tools listed up front). `output_config.effort` is sent in every variant.
- In the owner's own config folder, a session in a folder under his home sent his global instructions (the folder
  above is his home, whose `.claude/` rules load as a parent folder's), memory instructions and MCP server names, and
  the claude.ai login added `safeguards` and two more betas. With its own `CLAUDE_CONFIG_DIR` and the workers'
  `claudeMdExcludes`, none of these appear; the machine's git user name (git status context) does.
- With its own `CLAUDE_CONFIG_DIR` an interactive session first shows the theme picker and security notes
  (`hasCompletedOnboarding` in `.claude.json`), then the folder trust dialog (`projects[<folder>].hasTrustDialogAccepted`),
  then, with `--dangerously-skip-permissions`, the bypass warning (`skipDangerousModePermissionPrompt` in
  `settings.json`). Seeding those three lets a session start straight to the prompt.
- Without a claude.ai login, `--remote-control <name>` is ignored silently (no error, no indicator) and
  `/remote-control` is an unknown command.
- Unauthenticated probes of `https://llm-rtx.culturabuilder.com`: `/v1/messages`, `/v1/messages?beta=true`,
  `/v1/messages/count_tokens`, `/v1/chat/completions`, `/v1/responses` and `/v1/models` answer LiteLLM's 401
  ("Authentication Error, No api key passed in."); an unknown `/v1/...` route answers 404 `{"detail":"Not Found"}`;
  `/health/readiness` answers 200 `{"status":"healthy","db":"connected"}`; `server: cloudflare`.
- With the key (13 Nov 2026 17:36 to 17:45 UTC, `probe.mjs` and a scratch matrix of the same tool loop): `/v1/models`
  lists `deepseek-v4.1-flash-1017-uncensored`; a streamed answer comes as `text/event-stream` with Anthropic's named
  events; a tool loop without thinking and `count_tokens` answer 200. Adaptive thinking with effort `medium`, or with no
  effort, answers 400 `litellm.BadRequestError: ... DeepSeek V4.1 reasoning_effort must be one of low, high, max or an
  integer within [1, 100] in chat_template_kwargs`; adaptive with `low`, `high` or `max`, `enabled` with
  `budget_tokens` 8000, and no thinking with effort `medium` answer 200. No answer carried a thinking block or a
  signature. A question needing reasoning, answered with three characters, took 72 to 151 output tokens whether
  thinking was asked for or not.
