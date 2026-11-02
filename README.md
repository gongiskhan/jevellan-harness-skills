# jevellan-harness-skills

Seventeen skills that turn a Claude Code session into a coordinator. Asked to do something in a project, the session
turns the request into tasks, has Jev (TypeSafe's decision model) choose the model, effort and provider of every
step, runs each step as its own session on the runtime that fits (`claude -p`, or `codex exec`), lands the result on
the project's default branch through a guarded script, and keeps the whole story in an append-only ledger that any
session can pick up from.

There is no daemon, no CLI to install and no database program. The harness is the runtime: every part is a folder
with a `SKILL.md` and, where it must act deterministically, plain Node scripts next to it. Copying `skills/` into a
project's `.claude/skills/` and merging three hooks into its `.claude/settings.json` is the whole installation.

## Install

Requirements: Node 22.13 or later, git, Claude Code (verified with 2.1.316), and for the Codex runtime the Codex CLI
(verified with 0.153.4). The machine-level configuration lives in `~/.jevellan-harness/`:

- `providers.json`: Jev's key file and model, and the provider accounts (see `providers.example.json`). Claude
  subscriptions name a `tokenFile` with a long-lived token (`claude setup-token`); Codex signs in with its own
  `CODEX_HOME` (`codex login`).
- `secrets/`: the key and token files, mode 600, folder mode 700. They reach worker processes through the environment
  a script builds; they never appear on a command line, in the ledger, in a log or in a report.

Then, with Node 22:

```
node install.mjs <project path>
```

It copies the skills into `<project>/.claude/skills/`, merges the Stop, PostToolUse and SessionStart hooks into
`<project>/.claude/settings.json` (with the absolute path of the Node binary, keeping every other key and hook), writes
`<project>/.jevellan/project.json` with the detected commands, and adds `.claude`, `.jevellan/` and `plan.md` to the
repository's `.git/info/exclude`, so nothing of the harness is ever committed. A second run changes only its own
entries. `--skills-only` copies the skills and the exclude lines only, for a repository where the orchestration will
not run.

`project.json` holds `defaultBranch`, `testCommand`, `devCommand`, `setupCommand` (run once in every new worktree, for
example `npm ci`), `checks` (the landing checks; empty means the test command), `riskyPaths` (shown to Jev at landing),
`pushAfterLanding` (false by default) and `retentionDays`. Check the detected values once; a project whose tests need
an environment writes it into `testCommand`.

## First run

Open a Claude Code session in the project and ask it to do something. The SessionStart hook tells the session that
the project's work runs through the coordinator skill and lists the open work; the coordinator skill takes it from
there:

```
> Add a How to run section to the README listing the commands in package.json.
```

The coordinator creates the task, makes its worktree, asks Jev where each step runs, starts the steps, waits for
their reports in the background, records each step done, and lands the task, or asks you ("Land now" or "Leave it")
when Jev routes the landing to the owner. Ask it for status at any time.

`node .claude/skills/jevellan-ledger/scripts/ledger.mjs status` shows the same from a shell, and `tail --follow`
streams the ledger.

## How the chain works

Three ideas carry the design.

1. Skills depend on roles, never on names. Every skill's description begins with its role (Coordinator, Placement,
   Runtime, Ledger, Git, Duty, Workflow) and no skill body names another skill: a body says "use the placement skill
   now", "use the runtime skill for provider kind <kind> to start the step", "use the ledger skill to wait for the
   report". Scripts follow the same rule: they find a sibling skill by its `jh-role` (`scripts/lib/roles.mjs`).
   `scripts/check-roles.mjs` enforces it and generates `docs/roles.md`.
2. The model decides whether; scripts own how. Routing, sequencing and the work itself are the sessions'. Anything
   that touches a branch people ship from, a secret or a provider's quota is a script that refuses (exit 2 with the
   reason) when its conditions are not met: `start.mjs` starts a step only on the provider, model and effort placement
   recorded for it; `step.done` is refused unless the step's last report is done without failing tests; `land.mjs`
   refuses unless every step is done and the tree is clean, runs the checks, and only then fast-forwards the default
   branch.
3. The ledger is hooks plus a file. `.jevellan/ledger.jsonl` at the project root is append-only, one JSON line per
   event, twenty event kinds. The Stop hook makes every worker end its turn with a valid `.jevellan/report.json` and
   records it; PostToolUse records what each session did (tool and path, never contents); SessionStart hands a
   resuming session its task's history, or the coordinator its open work. The state of every task is computed from
   the lines alone.

A task runs like this:

| Step | Who | What lands in the ledger |
|---|---|---|
| The owner asks | coordinator session | |
| Create the task with a complete brief | ledger skill (`ledger.mjs task create`) | `task.created` |
| Make the worktree, run the setup command | git skill (`worktree.mjs create`) | `task.worktree` |
| Ask Jev which optional steps apply, record the steps | placement (`route.mjs --questions`), ledger (`append task.workflow --from-workflow`) | `task.workflow` |
| For each step: place it | placement (`route.mjs`) | `task.placed` with Jev's probabilities |
| Start it as its own session | runtime skill for the provider's kind (`start.mjs`) | `step.started`, `session.started` |
| The worker follows its duty skill and writes its report | worker session, Stop hook | `session.event` lines, `step.report` |
| Wait in the background, read the report | ledger (`ledger.mjs wait`) | |
| Record the step | ledger (`append step.done`) | `step.done` |
| Land | git skill (`land.mjs`) | `landing.decided`, `landing.checked`, `task.landed` (or `task.asked`) |

The workflows (feature, bug, automation) are `workflow.json` files in the workflow skills; a project overrides one
with `.jevellan/workflows/<kind>.json`. A verify step whose tests fail sends the task back to the step its `onFail`
names, at most `maxLoops` times. Jev answers placement from the policy in the router skill's `SKILL.md` and landing
from the policy in the git skill's `SKILL.md`; both are plain sections a person edits, and `evals/` in each skill
replays them against the decisions recorded in the ledgers.

Workers run with their own Claude config folder (`~/.jevellan-harness/claude-config`), so the owner's personal
settings, hooks, plugins and instructions do not reach them; what a worker is told is the worker rules for its duty,
"Use the duty skill for <duty> now", the project's `AGENTS.md` and the task block.

## Adding a provider

Add an entry to `~/.jevellan-harness/providers.json`: `name`, `kind` (`claude-subscription`, `claude-endpoint`,
`codex-subscription`, `openai-compatible`), the login (`tokenFile`, `keyFile` with `baseUrl`, or `codexHome`),
`ceilingPct`, and `models` with their ids, labels and efforts (or `"same as <provider>"`). Add one line per new model id
to the router skill's `## model descriptions`; placement refuses a menu model without a description, so the policy
cannot drift from the providers. Run `node .claude/skills/jevellan-router/scripts/providers.mjs check` to probe the
login and usage. A kind is offered only when an installed runtime skill lists it in `jh-kinds`; `openai-compatible`
has no runtime skill yet.

## Adding a skill

A skill is a folder under `skills/` with a `SKILL.md` whose frontmatter has `name` (the folder name), `description`
(starting with the role word) and `jh-role`, plus `jh-kinds` for a runtime, `jh-duty` and `jh-needs` for a duty, and
`jh-kind` and a `workflow.json` for a workflow. A new duty is picked up by placement from its `jh-needs`; a new runtime
from its `jh-kinds`; a new workflow kind by the coordinator through "the workflow skill for <kind>". Its body uses
role phrases only, and when it uses one it carries the sentence "If no skill with that role is installed, stop, tell
the owner which role is missing, and do not improvise it." Add `evals/trigger-cases.json` and run
`node scripts/run-trigger-evals.mjs --skill <name>`; `npm test` runs the unit suites and the role lint.

## Repository

- `skills/`: the seventeen skills. `docs/roles.md` lists them with their roles.
- `install.mjs`, `providers.example.json`.
- `scripts/check-roles.mjs` (the lint), `scripts/run-trigger-evals.mjs` (trigger evals, results in `evals/RESULTS.md`).
- `test/`: `node --test` suites for every script and hook. `acceptance/`: the H1 to H12 journeys and `RESULTS.md`.
- `docs/decisions.md` (H-001 onwards, with reasons), `docs/findings.md` (verified tool behaviour).

MIT licence.
