---
name: jevellan-placement
description: Placement. Use when a session must decide which model, effort and provider a task step should run on, or must answer a workflow question about a task. Runs a script that asks Jev; never choose yourself.
jh-role: placement
---

# Placement

Jev, the decision model, places every step of every task: which model runs it, at what effort, and on which provider
account. You never choose a model, an effort or a provider yourself, and nothing else may choose one. `<this skill>`
below is this skill's base directory.

To place a step: write the task JSON (what the ledger skill's `show --json` gives, plus the step ordinal and duty) to a file and run
  node <this skill>/scripts/route.mjs --task-file <file> --step <N> --duty <duty>
It prints {"provider","model","effort","kind","probabilities","latencyMs","policyHash"} and appends task.placed to the ledger. Exit 2 means Jev refused (no key, timeout, invalid answer): stop and tell the owner; never pick a model yourself.
To answer workflow questions at task creation: node <this skill>/scripts/route.mjs --task-file <file> --questions   prints {"needs_plan": true|false, "needs_docs": true|false}.
To check providers: node <this skill>/scripts/providers.mjs check   prints login state, usage and the menu each provider contributes.

`--task T` may be given instead of `--task-file`; the script then reads the task from the ledger itself. `kind` in
the answer is the provider kind (claude-subscription, claude-endpoint or codex-subscription): it says which runtime
skill starts the step.

If no skill in your list has that role (a skill's role is the first word of its description), call no skill at all: stop, tell the owner which role is missing, and do not improvise it.

## How this policy works

The script reads only the level-2 sections below, by name; everything above them is for people. It builds the menu
itself from `~/.jevellan-harness/providers.json`: only providers that are enabled, logged in per the last probe,
under their usage ceiling and of a kind that can do what the duty needs (the duty skill's `jh-needs`) are offered.
Jev chooses among those options and never sees a provider that cannot run the step.

- `model` and `effort` are the instructions sent with the model question and the effort question.
- `model descriptions` has one `<model id>: <text>` line per model id in providers.json. Each line becomes the
  criterion of that model's option. A model in the menu without a line stops placement with exit 2, so the policy
  cannot drift from the providers silently.
- `effort guide` has one line per effort level; the lines for the levels in the menu become the effort question's
  criteria. The chosen effort is mapped afterwards onto the nearest level the chosen model supports.
- `questions` holds the workflow questions asked once when a task is created (a step whose rule is `jev:<id>` is
  skipped when the answer is false), each written `<id>: <question> true: <criterion> false: <criterion>`.
- `rules` is sent verbatim to Jev with every placement: the owner's standing preferences.

Every placement is a `task.placed` line in the ledger with the policy hash, the probabilities and the latency; the
evals in `evals/` replay the policy against those lines.

## model
Choose the model for this step. Read the task, the step's duty and instructions, what the earlier steps of this task reported, the recent history and the owner's rules in the state. Each option names a model, the provider account that would run it and the runtime; its text says what the owner uses that model for. Match the work this step will actually do to those texts, and follow the rules wherever they speak to this kind of work. Prefer the model the previous step of this task used when it fits, because consecutive steps on one model reuse its cache. Treat a provider whose weekly usage is close to its ceiling as a last resort. On a retry after a failure, prefer a model at least as strong as the one that failed.

## model descriptions
claude-opus-5-5: Strong default for planning, implementation, reviews and all UI work (the owner wants UI on Opus at high or extra high, never on Fable).
claude-fable-5-1: The strongest Claude model: deep architecture, stubborn bugs, the hardest design questions. Uses subscription quota fastest. Not for UI.
claude-sonnet-5-5: Only trivial, mechanical work and short documentation.
claude-haiku-5-5: Short answers and conversation turns.
gpt-6-astra: Long, well-specified implementation runs; nearly as strong as Fable and its quota lasts about five times longer. An independent reviewer for work written by Claude.
glm-5.3: Cheap implementation of small, clear changes and mechanical refactors when Claude quota is tight.
deepseek-chat: Cheap answers and investigation summaries.
kimi-k2-turbo-preview: Cheap answers and conversation turns, and summaries of long texts; never for changes to the repository.
qwen3:8b: A small local model: only the shortest answers and conversation turns, when nothing else is available.

## effort
Choose the reasoning effort for this step. Effort follows how hard the step is, not how important the task is. Each option says when that level fits; pick the lowest level that fits the work this step will do. Weigh the duty (answers and conversation need little; implementation, planning and verification are usually high), the size and ambiguity of the task, whether it is UI or visual work, and the attempt number: a retry after a step failed at a lower effort goes higher. When the chosen model does not support the level you pick, the next supported level above it is used.

## effort guide
low: Short answers and conversation replies. Never for implementation.
medium: Small fixes, documentation and mechanical changes.
high: Default for implementation, planning and verification.
xhigh: Features across many files, architecture, hard debugging, all UI work on Claude.
max: After a step failed at a lower effort, or when the task text asks for the hardest effort.

## questions
needs_plan: Does this task need a written plan before implementation? true: The work spans several parts of the system, changes stored data, or the request is ambiguous. false: A small, clear change that a capable engineer would just do.
needs_docs: Does this change need documentation written for people? true: It changes how someone runs, configures or uses the project. false: Internal change, tests, or a fix with no user-visible behaviour change.

## rules
The owner builds TypeScript and JavaScript web apps and agent platforms.
Effort follows difficulty, not importance: most implementation, planning and verification are high; routine work is medium; quick answers are low; extra high or max for the hardest design, debugging and UI work, or after a step failed at a lower effort.
UI, visual work and anything judged by looking goes to Opus at high or extra high. Not Fable: the owner finds it too fast and careless on interfaces.
Long, well-specified implementation prefers GPT through Codex, especially when Claude quota is tight.
Prefer staying on the model the previous step used when it fits: consecutive steps on the same model reuse its prompt cache.
Small, clear changes need no plan. Plan when the work spans several parts of the system, changes stored data, or the request is ambiguous.
Tests catch problems better than reviews. Review only when the owner's workflow has a review step.
Sonnet almost never. Haiku and the cheap endpoint models for answers and conversation.
A provider above 80% of its weekly ceiling is a last resort; above the ceiling it is not in the menu.

## Interface

Not policy: this section is neither sent to Jev nor part of the policy hash.

- `route.mjs (--task-file F | --task T) --step N --duty D [--json]` -> `{provider, model, effort, kind, probabilities, latencyMs, policyHash, step, duty, source: "jev"}`. Reads the task through the ledger skill (a task file is what its `show T --json` prints; only `task` is read), asks Jev, writes `.jevellan/decisions/<T>-s<N>-<time>.json` and records `task.placed` through the ledger skill.
- `route.mjs (--task-file F | --task T) --step N --duty D --owner <provider>/<model>/<effort> [--json]` -> the same with `source: "owner"`, `probabilities: {}` and `latencyMs: 0`; no Jev call, no decision file.
- providers.json (H-044): a provider with `placement: false` is never in Jev's menu, though the owner's placement may name it; a provider with a `projects` list (claude-endpoint only) is in the menu, and may be placed by the owner, only for a task of a listed project (by real path; exit 2 otherwise); `env` (claude-endpoint only) is passed to every Claude session on the provider by the runtime and never holds a secret's name.
- `route.mjs (--task-file F | --task T) --questions [--json]` -> `{<question id>: true|false, ..., probabilities: {<id>: p}, policyHash, latencyMs}`; writes `.jevellan/decisions/<T>-workflow-<time>.json` and records nothing.
- `providers.mjs check [--json] [--only <name>]...` -> `{checkedAt, jev: {ok, models, configured, detail, checkedAt, fix?}, providers: {<name>: {auth, detail, weeklyPct, fiveHourPct, weeklyResetsAt, fiveHourResetsAt, observedAt, kind, menu: {models: [{id, efforts}], excluded, detail}, fix?}}, ok, error?, exitCode?}`, also written (without kind, menu and fix) to `~/.jevellan-harness/providers-state.json`. Exit 2 when Jev is not ready or no checked provider is ready, 3 for an `--only` name not in providers.json.
- `jev.mjs models [--json]` -> `{ok, model, models: [<name>]}`; exit 2 when Jev fails or the configured model is not listed.
- `jev.mjs decide [--json]`, stdin `{"state": "<JSON text of at most 60000 characters>", "questions": {<id>: {type: "choice" | "noul" | "score", instructions, criteria}}}` -> `{jevModel, answeredBy, answers: {<id>: {type, choice, probabilities, confidence} | {type, noul} | {type, score, legend, probabilities, confidence}}, usage: {input_tokens, output_tokens}, latencyMs}`: one Jev call with the Jev model of providers.json; nothing is written.
- Exit codes: 0 done; 2 refused with the reason (a Jev failure as "Jev: <message>", the policy, providers.json, the menu, a missing role, the ledger refusing); 3 not found. With `--json` a refusal prints `{"error", "exitCode"}` on stdout and the message on stderr. The Jev key is never printed.
