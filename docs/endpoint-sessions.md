# Sessions on an endpoint provider

How to run a Claude Code session of the owner's (a coordinator, or any session he or Ekoa starts) on a provider other
than his own Claude login, by name, with the default untouched; what reaches that provider and what cannot; and the
settings chosen for the first such provider, `deepseek-rtx` (DeepSeek V4.1 Flash behind an OpenAI-compatible gateway).
Decision H-044 in `decisions.md`; what Claude Code was seen sending is in `findings.md`.

## In short

- `skills/jevellan-runtime-claude/scripts/session.mjs --provider deepseek-rtx -- <claude arguments>` starts the
  session; plain `claude` stays exactly what it was.
- The provider entry lives in `~/.jevellan-harness/providers.json` (example: `providers.example.json`). It names the
  only projects whose sessions and steps may use it; everything else is refused before anything starts.
- The session gets its own Claude config folder, so the owner's instructions, memory, MCP servers, connectors, plugins
  and claude.ai login never reach the provider.
- `probe.mjs --provider deepseek-rtx` checks the gateway against the requests Claude Code sends; P7
  (`acceptance/p7-endpoint-session.mjs`) runs the probe and a real edit-test-commit session and records both.

## The endpoint

`https://llm-rtx.culturabuilder.com` is LiteLLM behind Cloudflare. Without a key (13 Nov 2026) it answers
`POST /v1/messages`, `/v1/messages?beta=true` and `/v1/messages/count_tokens` with LiteLLM's 401 "Authentication Error,
No api key passed in." and an unknown route with 404 `{"detail":"Not Found"}`: the Anthropic Messages routes are
registered, so Claude Code talks to it directly and no local translating layer is used. That is evidence of the
route, not of this model's behaviour through it: LiteLLM translates `/v1/messages` to the backend's chat format, and
whether tool calls, thinking blocks and streamed events survive the translation is what `probe.mjs` checks once the
key is saved. Should the probe fail on the Messages route itself, the smallest layer would be a local proxy started
and stopped by `session.mjs` with the session; none is built, because nothing yet says it is needed.

Claude Code wants the origin without `/v1` (it appends `/v1/messages`); `session.mjs` and `probe.mjs` refuse a
`baseUrl` ending in `/v1`.

## Setting up

1. Save the key, the key only, readable by the owner only:

   ```
   mkdir -p ~/.config/cultura-builder-llm && chmod 700 ~/.config/cultura-builder-llm
   $EDITOR ~/.config/cultura-builder-llm/rtx-litellm-key     # paste the key, save
   chmod 600 ~/.config/cultura-builder-llm/rtx-litellm-key
   ```

   `session.mjs` and `probe.mjs` refuse a key file that is missing, is not a regular file, or that group or others can
   read.

2. Check the gateway and the profile end to end before using it for real work, with no change to the live
   providers.json (the journey copies the entry into a private harness home and lists only its scratch repository):

   ```
   node acceptance/p7-endpoint-session.mjs --provider deepseek-rtx
   ```

   It writes `acceptance/results/P7-deepseek-rtx.json`: the probe's checks (models, streamed text with named SSE
   events, a tool loop without and with thinking, count_tokens), then the session's time, tool calls, tool errors,
   API errors and whether the branch it committed passes its tests. If `tools-thinking` passes, thinking can be turned
   on (remove `MAX_THINKING_TOKENS` from `env`).

3. Add the entry to `~/.jevellan-harness/providers.json` only after this branch's placement and Claude runtime are
   installed: the released placement refuses the new keys (`placement`, `projects`, `env`) and would stop every
   placement until then.

## Starting a session

From a shell, in a listed project:

```
node <plugin>/skills/jevellan-runtime-claude/scripts/session.mjs --provider deepseek-rtx -- --model opus --effort medium
```

`<plugin>` is the installed plugin (or this checkout). Everything after `--` goes to `claude`. `--dry-run` prints
what would run, the key masked, and starts nothing. A session ends as usual; to resume one, run the same command
with `-- --resume <session id>` (its transcript lives in the session's config folder, not the owner's).

What `session.mjs` changes compared with plain `claude`:

- environment: the provider's login (`ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` read from the key file), its model
  in every slot, the entry's `env`, `CLAUDE_CONFIG_DIR=~/.jevellan-harness/claude-config-sessions/deepseek-rtx`,
  `ENABLE_CLAUDEAI_MCP_SERVERS=false`; from the caller's environment it drops every `ANTHROPIC_*` and `CLAUDE*`
  variable, the hooks' step variables and any variable named like a secret (`*_TOKEN`, `*_KEY`, `*_SECRET`, ...);
- arguments: `--model` becomes the provider's model when it names one the provider does not serve (`opus` included),
  `--remote-control` is left out (it needs a claude.ai login, which the session's folder has none of; Claude Code would
  ignore it silently), `--strict-mcp-config` is added, this plugin is loaded with `--plugin-dir`, and `--settings`
  gains the workers' settings: no instruction file from a folder above the session's folder (the owner's home is
  one), no attribution, no Read or Edit of the harness's secrets;
- Claude Code's first-run screens (onboarding, folder trust, the bypass-mode warning when bypass is asked for) are
  answered in the session's config folder for that folder only, so a session Ekoa starts in tmux does not stop at them.

A worker step can run on the provider too, through the owner's placement only (`route.mjs ... --owner
deepseek-rtx/deepseek-v4.1-flash-1017-uncensored/medium`): `placement: false` keeps it out of Jev's menu, and the
runtime refuses it outside the listed projects.

## Third-party guard

The endpoint is a third party's. Sessions on HUB or CSG material must not use it unless the owner says so, and the
profile makes that hard to do by accident:

- Fail closed by project. An endpoint provider is usable only in the git repositories its `projects` list names,
  compared by real path (a worktree counts as its repository; a parent folder allows nothing below it; a folder
  outside git is refused). `session.mjs` refuses every endpoint without a list, `start.mjs` and `resume.mjs` refuse a
  step outside it, placement neither offers nor accepts it for an unlisted project. The example lists only
  `~/dev/jevellan-harness-skills`. Adding a project to the list is the decision that its material may go to this
  provider, and it is the only way to make that happen.

  ```
  $ cd ~/dev/csg && node .../session.mjs --provider deepseek-rtx --dry-run
  provider deepseek-rtx runs only in the projects its projects list names, and /home/ggomes/dev/csg is not inside a git repository   (exit 2)
  ```

- Never by default. Nothing chooses the provider but its name: plain `claude` and Ekoa's current command are
  unchanged, and Jev never sees it (`placement: false`).

- Nothing personal in the session. Measured on the requests Claude Code 2.1.323 sent to a loopback server
  (`findings.md`): with the owner's own config the first request carried his global instructions (13 hits for the
  caveman rule), his name, MCP server names and memory instructions; through `session.mjs` with the example's
  settings every one of those counts is 0. What remains by design: the repository's files and instructions
  (`AGENTS.md`), the machine's git user name, the working folder's path.

What the profile does not stop, and is the owner's call:

- MCP servers named explicitly with `--mcp-config` still load. Ekoa passes its session MCP that way, and that server
  can read the inbox, the archive and clients: HUB or CSG material reaches the provider the moment the model calls
  one of those tools. See "What Ekoa needs".
- The session runs Bash with the owner's rights. The deny rules keep Read and Edit away from the harness's secrets,
  but a shell command can still read any file the owner can, and its output goes to the provider. Only Claude Code's
  sandbox would close that; it is not turned on here.

## The settings

Claude Code 2.1.323 was run against a loopback Messages server to see each setting's effect on the request (the
"seen" column); the published sources are listed below with the layer each one describes, because DeepSeek's own
documents describe DeepSeek's own API, not LiteLLM in front of a self-hosted copy of the model.

| Setting | Value | Why | Seen / source |
|---|---|---|---|
| `ANTHROPIC_BASE_URL` | `https://llm-rtx.culturabuilder.com` | the origin; Claude Code adds `/v1/messages?beta=true` | seen; [5] |
| `ANTHROPIC_AUTH_TOKEN` | the key file's value | sent as `Authorization: Bearer`, which LiteLLM accepts | seen; [5] |
| `ANTHROPIC_MODEL`, `ANTHROPIC_DEFAULT_OPUS/SONNET/HAIKU_MODEL`, `CLAUDE_CODE_SUBAGENT_MODEL` | `deepseek-v4.1-flash-1017-uncensored` | every slot, so `--model opus`, the small fast model and subagents never ask the gateway for a Claude model | [1], [7] |
| `CLAUDE_CODE_MAX_OUTPUT_TOKENS` | `65536` | the provider's maximum output | seen: `max_tokens` 32000 becomes 65536 |
| `CLAUDE_CODE_AUTO_COMPACT_WINDOW` | `786432` | Claude Code assumes 1M tokens for an unknown model (it says so at start), so compaction would otherwise wait until the window is nearly full; 786,432 is three quarters of 1M and DeepSeek's own value | seen; [1], [5] |
| `API_TIMEOUT_MS` | `1800000` | 65,536 tokens at a slow 40 tokens per second is about 27 minutes; Claude Code's default of 10 minutes would cut a long answer. Every request streams (seen), which also keeps Cloudflare's 100 s limit on silent responses away | seen; derived |
| `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | `1` | no telemetry, error reports or update checks from the session | asked for; [1] |
| `CLAUDE_CODE_DISABLE_EXPERIMENTAL_BETAS` | `1` | removes `context_management` (thinking clearing), tool search's `defer_loading` and four beta headers: fewer things for the gateway to translate. Tools are then all listed up front (21), which the 1M window affords | seen |
| `MAX_THINKING_TOKENS` | `0`, provisional | removes `thinking` (and `context_management`) from every request. DeepSeek's thinking with tools needs the reasoning sent back on every later request of the loop, and returns 400 when it cannot recover it [2]; clients that translate formats are where that breaks [8], [9]. Unverified for this gateway: the probe's `tools-thinking` decides | seen; [2], [8], [9] |
| `CLAUDE_CODE_DISABLE_AUTO_MEMORY` | `1` | nothing accumulates in a memory the provider reads back; the ledger is the harness's state | seen: memory instructions gone |
| `--effort` | the caller's | sent as `output_config.effort` (default `high` without the flag); DeepSeek's API honours only `effort` in `output_config` [2]; LiteLLM forwarding `output_config` to a backend that rejects it is a known failure [6], and the probe's tool checks send it | seen; [2], [6] |
| Sampling | not set | Claude Code sends no `temperature` or `top_p` (seen), so the gateway's defaults apply; the model card recommends 1.0 and 1.0 [3]; a community copy uses 0.5 [4] | seen; [3], [4] |
| Parallel tool calls | not set | Claude Code sends no `disable_parallel_tool_use`; DeepSeek ignores it anyway [2] | seen; [2] |
| Context | 1,048,576 tokens | Claude Code already assumes 1M for this name, so the `[1m]` suffix is not needed (it only adds the `context-1m` beta header) | seen |

Not available on this provider: WebSearch (Anthropic runs it server side), remote control (no claude.ai login), the
advisor and auto mode's server-side checks.

Sources, with the layer each describes:

1. DeepSeek, "Integrate with Claude Code", https://api-docs.deepseek.com/quick_start/agent_integrations/claude_code/
   (DeepSeek's own Anthropic API): every model slot set, `CLAUDE_CODE_SUBAGENT_MODEL`, `CLAUDE_CODE_EFFORT_LEVEL=max`,
   `CLAUDE_CODE_AUTO_COMPACT_WINDOW=786432`.
2. DeepSeek, "Using the Anthropic API", https://api-docs.deepseek.com/guides/anthropic_api (DeepSeek's own API): the
   field table (`thinking` adaptive treated as enabled, `temperature` fixed in thinking mode, `output_config` effort
   only, `tool_choice` any treated as auto, `disable_parallel_tool_use` ignored) and, for thinking with tools, "pass
   back the assistant's complete content array" and a 400 when recovery fails.
3. deepseek-ai/DeepSeek-V4.1-Flash-1017 model card, https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017
   (the model): temperature 1.0, top_p 1.0, 1M context, max_tokens of at least 256K recommended, no Jinja chat
   template (a Python encoder instead), Claude Code used as a benchmark harness.
4. dealignai/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8,
   https://huggingface.co/dealignai/DeepSeek-V4.1-Flash-1017-UNCENSORED-FP8 (an uncensored copy, probably the kind
   this gateway serves: unconfirmed): refusals removed from the weights, MMLU 3.86 points lower than the base, SGLang
   `--reasoning-parser deepseek-v41 --tool-call-parser deepseekv41`, effort tiers low, high (default) and max.
5. LiteLLM, "Use Claude Code with Non-Anthropic Models",
   https://docs.litellm.ai/docs/tutorials/claude_non_anthropic_models (the gateway): base URL without `/v1`,
   `ANTHROPIC_AUTH_TOKEN`, an unknown model gets Claude Code's default window, `CLAUDE_CODE_AUTO_COMPACT_WINDOW`.
6. LiteLLM issue 22963, https://github.com/BerriAI/litellm/issues/22963 (the gateway; read as a search summary):
   `output_config` forwarded to an OpenAI backend fails.
7. "Claude Code on DeepSeek V4.1-Flash-1017", https://blog.sandbase.ai/claude-code-deepseek-v4-1-flash-1017-2026/
   (secondary, 21 Oct 2026): set every slot, or an unset Opus slot falls back to another model.
8. Cursor forum, "Compatibility with DeepSeek model's design to return reasoning content after tool calls",
   https://forum.cursor.com/t/compatibility-with-deepseek-models-design-to-return-reasoning-content-after-tool-calls/158905
   (another client; read as a search summary).
9. cc-switch issue 3246, https://github.com/farion1231/cc-switch/issues/3246 (Claude Code against DeepSeek; one
   report, read as a search summary): adaptive thinking not supported, reasoning not kept.

## Proof

P7 gives the same task to a session on each provider: in a scratch repository with one function and its test, add
`titleCase`, add tests, run `npm test`, commit on `proof/title-case`. The journey then checks the branch, runs the tests
on it, calls `titleCase` itself, and counts tool calls, failed tool calls and API errors from the session's stream.

| | claude-main (default) | deepseek-rtx |
|---|---|---|
| Model, effort | claude-opus-5-5, medium | deepseek-v4.1-flash-1017-uncensored, medium |
| Run | 13 Nov 2026 09:09 UTC, `acceptance/results/P7-claude-main.json` | blocked: the key file does not exist yet (`P7-deepseek-rtx.json`) |
| Checks | 10 of 10 | - |
| Session time | 19.3 s (18.1 s in the session, 16.5 s of it in the API) | - |
| Tool calls | 3 (Bash) in 4 turns | - |
| Failed tool calls, API errors | 0, 0 | - |
| Branch | one commit, "Add titleCase text helper with tests"; its 3 tests pass; `titleCase` correct | - |

Both sessions start through `session.mjs`, each in its own config folder, so neither sees the owner's personal
configuration and the comparison is of the providers alone. An earlier default run (09:08 UTC) did the same in 20.1 s
with 3 Bash calls and no errors; the journey's own branch check failed on it (the branch was checked out in the
repository) and was fixed before the recorded run. To fill the right-hand column, save the key and run
`node acceptance/p7-endpoint-session.mjs --provider deepseek-rtx`.

## What Ekoa needs

Ekoa starts a coordinator today, in tmux, as
`claude --dangerously-skip-permissions --mcp-config <bridge>/claude-mcp.json --remote-control <name> --model opus --effort medium`.
For this provider it would start instead:

```
node <plugin>/skills/jevellan-runtime-claude/scripts/session.mjs --provider deepseek-rtx --cwd <project> -- \
  --dangerously-skip-permissions --mcp-config <bridge>/claude-mcp.json --model opus --effort medium
```

- What to pass: a provider name next to `--model` and `--effort`, `deepseek-rtx`; no name means today's command.
  `<plugin>` is the installed plugin's folder once this is released; nothing is installed from this branch.
- A refusal (exit 2, the reason on stderr) happens before anything starts: Ekoa should show the reason, not retry.
- Lost on this provider: remote control. Ekoa has to drive the session through tmux.
- The owner's decision: Ekoa's session MCP. Passed as today, it gives the session the inbox, archive and client tools
  as well as the task's, so HUB or CSG material can reach the provider through them. A task-only MCP configuration for
  sessions on a third-party provider would close that; until one exists, the projects list is the only guard.

## Overlap

An earlier branch, `jh/deepseek-rtx-run-harness-work-on-the-cul-TDMS2GF` (7 Nov, never pushed), routed some duties and
the evals to the same endpoint with a request gate; it is not merged and this work does not build on it. Its loopback
findings agree with this document's (Bearer token, `/v1/messages?beta=true`, named SSE events needed). The live
providers.json already has a provider called `deepseek` (api.deepseek.com), hence the name `deepseek-rtx`.
