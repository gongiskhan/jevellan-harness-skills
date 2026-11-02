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

## Install as a plugin (Claude Code, auto-updated)

For Claude Code the repository is also a plugin with its own one-plugin marketplace, installed once per machine and
updated with each release; `install.mjs` (above) stays for Cursor and Codex, and for a project that should carry the
skills itself. Use one of the two in a project, not both (if both are there, every hook still records each event
once, docs/decisions.md H-039, but the session lists every skill twice).

```
claude plugin marketplace add gongiskhan/jevellan-harness-skills
claude plugin install jevellan-harness@jevellan-harness-skills --scope user
```

Then turn on auto-update for that marketplace: in Claude Code, `/plugin`, Marketplaces, `jevellan-harness-skills`,
Enable auto-update; or in `~/.claude/settings.json`:

```json
{
  "extraKnownMarketplaces": {
    "jevellan-harness-skills": {
      "source": { "source": "github", "repo": "gongiskhan/jevellan-harness-skills" },
      "autoUpdate": true
    }
  }
}
```

Claude Code then refreshes the marketplace in the background and installs a new release when `version` in
`.claude-plugin/plugin.json` changes; the running session keeps the old one until the next start or `/reload-plugins`.
A client machine that must stay on one release pins the marketplace to its tag instead, and gets no updates:

```
claude plugin marketplace add gongiskhan/jevellan-harness-skills#v0.2.0
```

(v0.2.0 is the first tag that carries the plugin; v0.1.0 predates it.) The skills appear namespaced
(`jevellan-harness:jevellan-coordinator`, ...) and work the same: they find each other by role inside the plugin's
folder. The ledger's hooks come with the plugin and run with the `node` first on PATH, so Node 22.13 or later must be
first on PATH for Claude Code (the SessionStart hook says so in the session when it is not). Workers the runtime
starts load the plugin themselves (`--plugin-dir`), since they run with the harness's own Claude configuration folder.

The plugin brings the skills and hooks, not a project's settings. Set each project up once, with Node 22, from the
marketplace's copy of this repository:

```
node ~/.claude/plugins/marketplaces/jevellan-harness-skills/install.mjs <project path> --project-only
```

It writes `<project>/.jevellan/project.json` with the detected commands and adds `.jevellan/` and `plan.md` to
`.git/info/exclude`; it copies no skills and writes no `.claude` folder. The machine's `~/.jevellan-harness/` is set
up as for `install.mjs`. To try a checkout without installing it: `claude --plugin-dir <checkout>`.

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
   report". Scripts follow the same rule: they find a sibling skill by its `jh-role` and run one of its public
   scripts as a process (`runRole` in their own `scripts/lib/roles.mjs`), never importing its code.
   `scripts/check-roles.mjs` enforces the roles and generates `docs/roles.md`; `scripts/check-decoupling.mjs` refuses
   any coupling between skills (AGENTS.md, "Decoupling over efficiency"; `docs/decoupling.md`).
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
role phrases only, and when it uses one it carries the role-missing sentence that `scripts/check-roles.mjs` names
(`ROLE_MISSING_SENTENCE`). Its body ends with a `## Interface` section: its public scripts with what they take and
print, or "No scripts.". It uses other skills only by running their public scripts by role (`runRole`), keeps its own
copies of any helper it needs, and has its own tests in `test/` that pass with only its folder present. Add
`evals/trigger-cases.json` and run `node scripts/run-trigger-evals.mjs --skill <name>`; `npm test` runs every skill's
own tests alone, the repository suites, the role lint and the decoupling lint.

## Repository

- `skills/`: the seventeen skills. `docs/roles.md` lists them with their roles.
- `install.mjs`, `providers.example.json`; `.claude-plugin/` (the plugin and its marketplace) and `hooks/hooks.json`
  (the plugin's hooks).
- `scripts/check-roles.mjs` (the role lint), `scripts/check-decoupling.mjs` (the decoupling lint),
  `scripts/test-skills.mjs` (each skill's own tests, alone), `scripts/run-trigger-evals.mjs` (trigger evals, results in
  `evals/RESULTS.md`).
- `skills/<name>/test/`: each skill's own suites. `test/`: the suites of several skills together, the installer and the
  lints. `acceptance/`: the H1 to H12 journeys, `timings.mjs` and `RESULTS.md`.
- `docs/decoupling.md` (each kind of coupling the repository forbids and how the lint catches it).
- `docs/decisions.md` (H-001 onwards, with reasons), `docs/findings.md` (verified tool behaviour).

MIT licence.
