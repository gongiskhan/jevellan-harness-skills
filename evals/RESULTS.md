# Trigger evals

Merged results. jevellan-placement and jevellan-coordinator measured again on 2026-11-02T13:25:26Z; the other 15 skills keep the measurement of 2026-11-02T02:37:23Z (3 runs per case); jevellan-router from that run is no longer in the package and is left out (runs recorded before a rename name the skill as it was then). Totals and verdicts below are over the merged cases.

Run of 2026-11-02T13:25:26Z: `claude -p` (Claude Code 2.1.316) with model claude-sonnet-5-5, effort low, provider claude-second, 3 runs per case, split all; this run 31 cases, 93 runs, 0 errors, 3 min 6 s, cost 4.62 USD; merged 17 skills, 248 cases, 744 runs, 0 errors.

Each run is one `claude -p` session in a temporary git project with the skills in .claude/skills, the Skill tool and the read-only Read, Glob and Grep, --permission-mode dontAsk and --max-turns 3. Thresholds per skill: at least 90% of the positive runs invoke the skill, at most 5% of the negative runs pick the skill as their first one, and at least 98% of the role-phrase runs pass. A role-missing run (the role's skills not installed) passes when it invokes no skill at all and the answer names the missing role. An error never counts as a pass.

With fewer than 50 role-phrase runs per skill, the 98% threshold means every role-phrase run must pass.

Verdict: 1 of 17 skills below the thresholds: jevellan-placement.

## Per skill

| Skill | Positives | False negatives | False positives | Role missing | Role phrase | Held-out positives | Held-out negatives | Errors | Verdict |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| jevellan-coordinator | 22/24 (92%) | 2 | 0/21 | - | 18/18 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-duty-answer | 21/21 (100%) | 0 | 0/21 | - | 27/27 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-duty-automate | 21/21 (100%) | 0 | 0/21 | - | 27/27 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-duty-converse | 21/21 (100%) | 0 | 0/21 | - | 27/27 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-duty-document | 20/21 (95%) | 1 | 0/21 | - | 27/27 (100%) | 5/6 | 3/3 | 0 | meets |
| jevellan-duty-implement | 21/21 (100%) | 0 | 0/21 | - | 27/27 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-duty-investigate | 19/21 (90%) | 2 | 0/21 | - | 27/27 (100%) | 4/6 | 3/3 | 0 | meets |
| jevellan-duty-plan | 21/21 (100%) | 0 | 0/21 | - | 27/27 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-duty-verify | 21/21 (100%) | 0 | 0/21 | - | 27/27 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-git | 24/24 (100%) | 0 | 0/18 | 3/3 | 18/18 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-ledger | 24/24 (100%) | 0 | 0/18 | 3/3 | 18/18 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-placement | 23/24 (96%) | 1 | 0/18 | 3/6 | 24/27 (89%) | 6/6 | 3/3 | 0 | below: role-phrase runs 24/27 below 98% |
| jevellan-runtime-claude | 24/24 (100%) | 0 | 0/18 | 3/3 | 27/27 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-runtime-codex | 24/24 (100%) | 0 | 0/18 | 3/3 | 24/24 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-workflow-automation | 24/24 (100%) | 0 | 0/18 | 3/3 | 21/21 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-workflow-bug | 24/24 (100%) | 0 | 0/18 | 3/3 | 21/21 (100%) | 6/6 | 3/3 | 0 | meets |
| jevellan-workflow-feature | 24/24 (100%) | 0 | 0/18 | 3/3 | 21/21 (100%) | 6/6 | 3/3 | 0 | meets |

## Links (role-phrase cases)

| Link | Passed | Rate |
| --- | --- | --- |
| jevellan-coordinator -> jevellan-coordinator (must not fire) | 3/3 | 100% |
| jevellan-coordinator -> jevellan-git | 9/9 | 100% |
| jevellan-coordinator -> jevellan-git (git removed) | 3/3 | 100% |
| jevellan-coordinator -> jevellan-git (must not fire) | 6/6 | 100% |
| jevellan-coordinator -> jevellan-ledger | 9/9 | 100% |
| jevellan-coordinator -> jevellan-ledger (ledger removed) | 3/3 | 100% |
| jevellan-coordinator -> jevellan-ledger (must not fire) | 3/3 | 100% |
| jevellan-coordinator -> jevellan-placement | 3/3 | 100% |
| jevellan-coordinator -> jevellan-placement (must not fire) | 6/6 | 100% |
| jevellan-coordinator -> jevellan-placement (placement removed) | 2/3 | 67% |
| jevellan-coordinator -> jevellan-runtime-claude | 6/6 | 100% |
| jevellan-coordinator -> jevellan-runtime-claude (must not fire) | 9/9 | 100% |
| jevellan-coordinator -> jevellan-runtime-claude (runtime removed) | 3/3 | 100% |
| jevellan-coordinator -> jevellan-runtime-codex | 6/6 | 100% |
| jevellan-coordinator -> jevellan-runtime-codex (must not fire) | 9/9 | 100% |
| jevellan-coordinator -> jevellan-runtime-codex (runtime removed) | 3/3 | 100% |
| jevellan-coordinator -> jevellan-workflow-automation | 9/9 | 100% |
| jevellan-coordinator -> jevellan-workflow-automation (must not fire) | 6/6 | 100% |
| jevellan-coordinator -> jevellan-workflow-automation (workflow removed) | 3/3 | 100% |
| jevellan-coordinator -> jevellan-workflow-bug | 9/9 | 100% |
| jevellan-coordinator -> jevellan-workflow-bug (must not fire) | 6/6 | 100% |
| jevellan-coordinator -> jevellan-workflow-bug (workflow removed) | 3/3 | 100% |
| jevellan-coordinator -> jevellan-workflow-feature | 9/9 | 100% |
| jevellan-coordinator -> jevellan-workflow-feature (must not fire) | 6/6 | 100% |
| jevellan-coordinator -> jevellan-workflow-feature (workflow removed) | 3/3 | 100% |
| jevellan-workflow-automation -> jevellan-placement | 3/3 | 100% |
| jevellan-workflow-automation -> jevellan-runtime-codex | 3/3 | 100% |
| jevellan-workflow-bug -> jevellan-placement | 3/3 | 100% |
| jevellan-workflow-bug -> jevellan-placement (placement removed) | 1/3 | 33% |
| jevellan-workflow-bug -> jevellan-runtime-claude | 3/3 | 100% |
| jevellan-workflow-feature -> jevellan-placement | 3/3 | 100% |
| jevellan-workflow-feature -> jevellan-runtime-claude | 3/3 | 100% |
| jevellan-workflow-feature -> jevellan-runtime-codex | 3/3 | 100% |
| prompt -> jevellan-duty-answer | 3/3 | 100% |
| prompt -> jevellan-duty-automate | 3/3 | 100% |
| prompt -> jevellan-duty-converse | 3/3 | 100% |
| prompt -> jevellan-duty-document | 3/3 | 100% |
| prompt -> jevellan-duty-implement | 3/3 | 100% |
| prompt -> jevellan-duty-investigate | 3/3 | 100% |
| prompt -> jevellan-duty-plan | 3/3 | 100% |
| prompt -> jevellan-duty-verify | 3/3 | 100% |
| runtime duty line -> jevellan-coordinator (must not fire) | 3/3 | 100% |
| runtime duty line -> jevellan-duty-answer | 12/12 | 100% |
| runtime duty line -> jevellan-duty-answer (must not fire) | 9/9 | 100% |
| runtime duty line -> jevellan-duty-automate | 12/12 | 100% |
| runtime duty line -> jevellan-duty-automate (must not fire) | 9/9 | 100% |
| runtime duty line -> jevellan-duty-converse | 12/12 | 100% |
| runtime duty line -> jevellan-duty-converse (must not fire) | 9/9 | 100% |
| runtime duty line -> jevellan-duty-document | 12/12 | 100% |
| runtime duty line -> jevellan-duty-document (must not fire) | 9/9 | 100% |
| runtime duty line -> jevellan-duty-implement | 12/12 | 100% |
| runtime duty line -> jevellan-duty-implement (must not fire) | 9/9 | 100% |
| runtime duty line -> jevellan-duty-investigate | 12/12 | 100% |
| runtime duty line -> jevellan-duty-investigate (must not fire) | 9/9 | 100% |
| runtime duty line -> jevellan-duty-plan | 12/12 | 100% |
| runtime duty line -> jevellan-duty-plan (must not fire) | 9/9 | 100% |
| runtime duty line -> jevellan-duty-verify | 12/12 | 100% |
| runtime duty line -> jevellan-duty-verify (must not fire) | 9/9 | 100% |
| runtime duty line -> jevellan-ledger (must not fire) | 3/3 | 100% |
| runtime duty line -> jevellan-placement (must not fire) | 3/3 | 100% |
| runtime duty line -> jevellan-runtime-claude (must not fire) | 3/3 | 100% |
| runtime duty line -> jevellan-workflow-automation (must not fire) | 3/3 | 100% |
| runtime duty line -> jevellan-workflow-bug (must not fire) | 3/3 | 100% |
| runtime duty line -> jevellan-workflow-feature (must not fire) | 3/3 | 100% |
| SessionStart line -> jevellan-coordinator | 12/12 | 100% |
| SessionStart line -> jevellan-duty-answer (must not fire) | 3/3 | 100% |
| SessionStart line -> jevellan-duty-automate (must not fire) | 3/3 | 100% |
| SessionStart line -> jevellan-duty-converse (must not fire) | 3/3 | 100% |
| SessionStart line -> jevellan-duty-document (must not fire) | 3/3 | 100% |
| SessionStart line -> jevellan-duty-implement (must not fire) | 3/3 | 100% |
| SessionStart line -> jevellan-duty-investigate (must not fire) | 3/3 | 100% |
| SessionStart line -> jevellan-duty-plan (must not fire) | 3/3 | 100% |
| SessionStart line -> jevellan-duty-verify (must not fire) | 3/3 | 100% |

## Failing cases

### jevellan-coordinator case 4 (positive)

> Three tasks in parallel: (1) README how to run; (2) a unit test for one untested pure function in src; (3) an empty-state message on the customers page when there are no customers, with a test.

- Run 1: failed; invoked no skill; answer: "I'll start by looking at the project. Three independent edits. `lineTotalCents` is the untested pure function. The server starts listening on import, so I'll move the customers HTML into a separate module to make it testable."
- Run 2: failed; invoked no skill; answer: "I'll start by looking at the project."
- Run 3: passed; invoked jevellan-coordinator, jevellan-ledger

### jevellan-duty-document case 6 (positive, held out)

> Task step with duty document: the CHANGELOG needs an entry for the CSV export. Docs only, then the report file.

- Run 1: failed; invoked no skill; answer: "I'll start by looking for the CHANGELOG and the CSV export code."
- Run 2: passed; invoked jevellan-duty-document
- Run 3: passed; invoked jevellan-duty-document

### jevellan-duty-investigate case 6 (positive, held out)

> Worker session for task T3VX8K, duty investigate: the owner wants to know whether anything in src/ still calls the old formatMoney helper. Read only, cite paths and lines, then write .jevellan/report.json.

- Run 1: failed; invoked no skill
- Run 2: failed; invoked no skill
- Run 3: passed; invoked jevellan-duty-investigate

### jevellan-placement case 4 (positive, context jevellan-coordinator)

> Verify step 3 of T8QW2N reported testsRun.passed false, and the retry back to step 2 is recorded. Step 2 must be placed again before it restarts; use the placement skill for it.

- Run 1: failed; invoked jevellan-ledger; answer: "I'll check the ledger first. Bash isn't available here, so I'll read the ledger file directly."
- Run 2: passed; invoked jevellan-ledger, jevellan-placement
- Run 3: passed; invoked jevellan-ledger, jevellan-placement

### jevellan-placement case 9 (role-missing, role phrase, context jevellan-coordinator, placement removed)

> Task T3K9QZ "README: how to run" (single, duty document) is created and its worktree is ready. Step 1 has not been placed yet. Use the placement skill now and continue with its answer.

- Run 1: passed; invoked no skill; named the missing role: yes; answer: "I can't place step 1 of T3K9QZ "README: how to run". None of my skills has the Placement role. Its description would have to start with "Placement", and the skills I have cover the coordinator, duties, git, ledger, runtimes and workflows only. I've called no skill and started nothing. The task st..."
- Run 2: passed; invoked no skill; named the missing role: yes; answer: "I can't place step 1 of T3K9QZ "README: how to run". None of my skills has the placement role. The ones I have cover coordinator, duty, git, ledger, runtime and workflow. Only placement can choose the provider, model and effort for a step, and I'm not allowed to pick those myself or start the ste..."
- Run 3: failed; invoked jevellan-placement (not installed); named the missing role: yes; answer: "I can't start step 1 of T3K9QZ "README: how to run" because this session has no placement skill. The skills I can see cover coordinator, duty, git, ledger, runtime and workflow roles, but none has the placement role. Placement is what picks the provider, model and effort for each step, and I don'..."

### jevellan-placement case 10 (role-missing, role phrase, context jevellan-workflow-bug, placement removed)

> Bug task T5HB7C has its worktree and its resolved steps are recorded: 1 implement, 2 verify. Step 1 is next. Use the placement skill now and continue with its answer.

- Run 1: failed; invoked jevellan-placement (not installed); named the missing role: yes; answer: "I can't continue with step 1. No placement skill is available in this session, so I haven't started anything. The workflow needs a skill whose role is "placement". It uses that skill to choose a provider for each step, and the runtime skill depends on its answer. The skills I do have cover coordi..."
- Run 2: failed; invoked no skill; named the missing role: no; answer: "I can't start step 1 (implement) of task T5HB7C. The workflow needs a placement skill, and none is available in this session. The skills I have cover the coordinator, the duties, git, the ledger, the runtimes and the workflows, but nothing with the placement role. I haven't called any skill or tr..."
- Run 3: passed; invoked no skill; named the missing role: yes; answer: "I'm stopping at step 1 of bug task T5HB7C because the placement skill isn't available in this session. The workflow tells me to use a placement skill to choose the provider for each step. None of the skills I can call has that role. The ledger, runtime (Claude and Codex), git, duty and workflow s..."

## Role-missing runs

Every run of a case whose role was not installed: what it invoked and how it answered.

- jevellan-git case 9 (git removed, context jevellan-coordinator), run 1: passed; invoked no skill; answer: "I can't make the worktree for T3K9QZ "README: how to run". None of my skills has the git role. I have ledger, placement, runtime, workflow and duty skills, but nothing that makes worktrees or lands..."
- jevellan-git case 9 (git removed, context jevellan-coordinator), run 2: passed; invoked no skill; answer: "I can't make the worktree for T3K9QZ "README: how to run" yet, because no git skill is loaded in this session. The skills I have cover ledger, placement, runtime, workflow and duty, but none covers..."
- jevellan-git case 9 (git removed, context jevellan-coordinator), run 3: passed; invoked no skill; answer: "I can't make the worktree for T3K9QZ "README: how to run" because none of my skills has the git role. I have ledger, placement, runtime, workflow and duty skills, but nothing that creates worktrees..."
- jevellan-ledger case 9 (ledger removed, context jevellan-coordinator), run 1: passed; invoked no skill; answer: "I can't create the task: none of my skills has the Ledger role. The skills I have cover coordination, placement, git, runtime, workflows and duties, but nothing that creates tasks, checks status or..."
- jevellan-ledger case 9 (ledger removed, context jevellan-coordinator), run 2: passed; invoked no skill; answer: "I can't create the task yet, because this session has no ledger skill. The skills I have cover coordinator, duty, git, placement, runtime and workflow, but nothing whose description starts with "Le..."
- jevellan-ledger case 9 (ledger removed, context jevellan-coordinator), run 3: passed; invoked no skill; answer: "I can't create the task because this session has no skill with the Ledger role. The skills I have cover placement, git, runtime, workflow and the duties, but none of them creates tasks or reports s..."
- jevellan-placement case 9 (placement removed, context jevellan-coordinator), run 1: passed; invoked no skill; answer: "I can't place step 1 of T3K9QZ "README: how to run". None of my skills has the Placement role. Its description would have to start with "Placement", and the skills I have cover the coordinator, dut..."
- jevellan-placement case 9 (placement removed, context jevellan-coordinator), run 2: passed; invoked no skill; answer: "I can't place step 1 of T3K9QZ "README: how to run". None of my skills has the placement role. The ones I have cover coordinator, duty, git, ledger, runtime and workflow. Only placement can choose ..."
- jevellan-placement case 9 (placement removed, context jevellan-coordinator), run 3: failed; invoked jevellan-placement (not installed); answer: "I can't start step 1 of T3K9QZ "README: how to run" because this session has no placement skill. The skills I can see cover coordinator, duty, git, ledger, runtime and workflow roles, but none has ..."
- jevellan-placement case 10 (placement removed, context jevellan-workflow-bug), run 1: failed; invoked jevellan-placement (not installed); answer: "I can't continue with step 1. No placement skill is available in this session, so I haven't started anything. The workflow needs a skill whose role is "placement". It uses that skill to choose a pr..."
- jevellan-placement case 10 (placement removed, context jevellan-workflow-bug), run 2: failed; invoked no skill; answer: "I can't start step 1 (implement) of task T5HB7C. The workflow needs a placement skill, and none is available in this session. The skills I have cover the coordinator, the duties, git, the ledger, t..."
- jevellan-placement case 10 (placement removed, context jevellan-workflow-bug), run 3: passed; invoked no skill; answer: "I'm stopping at step 1 of bug task T5HB7C because the placement skill isn't available in this session. The workflow tells me to use a placement skill to choose the provider for each step. None of t..."
- jevellan-runtime-claude case 9 (runtime removed, context jevellan-coordinator), run 1: passed; invoked no skill; answer: "I can't start step 1 (document) of T3K9QZ because there is no runtime skill in my list. I have skills for placement, ledger, git, workflow and the duties, but none whose description begins with "Ru..."
- jevellan-runtime-claude case 9 (runtime removed, context jevellan-coordinator), run 2: passed; invoked no skill; answer: "I can't start step 1 (document) of T3K9QZ, because none of my skills has the runtime role. The skills I have cover coordinator, duty, ledger, git, placement and workflow, but none of them starts a ..."
- jevellan-runtime-claude case 9 (runtime removed, context jevellan-coordinator), run 3: passed; invoked no skill; answer: "I can't start step 1 (document) of T3K9QZ because none of my available skills has the Runtime role. The skills I have cover coordinator, duty, git, ledger, placement and workflow, but none for star..."
- jevellan-runtime-codex case 9 (runtime removed, context jevellan-coordinator), run 1: passed; invoked no skill; answer: "I can't start step 2 (implement) of T8QW2N. None of my available skills has the Runtime role, which is the one that starts a step on a provider kind like codex-subscription. I haven't started anyth..."
- jevellan-runtime-codex case 9 (runtime removed, context jevellan-coordinator), run 2: passed; invoked no skill; answer: "I can't start step 2 (implement) of T8QW2N, because none of my skills has the Runtime role. The skills I have cover placement, ledger, git, workflow and the duties. None of them starts a step on a ..."
- jevellan-runtime-codex case 9 (runtime removed, context jevellan-coordinator), run 3: passed; invoked no skill; answer: "I can't start step 2 (implement) of T8QW2N. None of my skills has the Runtime role, so there is nothing for me to start a codex-subscription session with. I won't improvise it, and I haven't starte..."
- jevellan-workflow-automation case 9 (workflow removed, context jevellan-coordinator), run 1: passed; invoked no skill; answer: "I can't start T2KD8F "Friday invoice export" yet, because none of my skills has the Workflow role. I have the Placement, Ledger, Git, Runtime and Duty skills, but nothing that defines the steps for..."
- jevellan-workflow-automation case 9 (workflow removed, context jevellan-coordinator), run 2: passed; invoked no skill; answer: "I can't start T2KD8F "Friday invoice export" yet. None of my skills has the Workflow role. The closest, `workflow-authoring`, is a reference for writing Workflow tool scripts, not the skill that gi..."
- jevellan-workflow-automation case 9 (workflow removed, context jevellan-coordinator), run 3: passed; invoked no skill; answer: "I can't start T2KD8F "Friday invoice export" yet, because this session has no workflow skill. The skills I do have cover the coordinator, duty, git, ledger, placement and runtime roles, and none of..."
- jevellan-workflow-bug case 9 (workflow removed, context jevellan-coordinator), run 1: passed; invoked no skill; answer: "I can't run T5HB7C yet because this session has no skill with the Workflow role. The skills I have cover coordinator, duty, git, ledger, placement and runtime, but none of them is a workflow skill ..."
- jevellan-workflow-bug case 9 (workflow removed, context jevellan-coordinator), run 2: passed; invoked no skill; answer: "I can't run T5HB7C yet because no skill with the Workflow role is available to me. The skills I have cover Coordinator, Duty, Git, Ledger, Placement and Runtime. `workflow-authoring` is a reference..."
- jevellan-workflow-bug case 9 (workflow removed, context jevellan-coordinator), run 3: passed; invoked no skill; answer: "I can't start T5HB7C ("Invoice dates shown in the wrong timezone") yet, because none of my skills has the workflow role. I have coordinator, duty, git, ledger, placement and runtime skills, but not..."
- jevellan-workflow-feature case 9 (workflow removed, context jevellan-coordinator), run 1: passed; invoked no skill; answer: "I can't start T8QW2N "CSV export on the invoices page" yet, because none of my available skills has the workflow role. I have skills for placement, ledger, git, runtime and the duties, but nothing ..."
- jevellan-workflow-feature case 9 (workflow removed, context jevellan-coordinator), run 2: passed; invoked no skill; answer: "I can't run T8QW2N "CSV export on the invoices page" yet, because no skill with the Workflow role is available in this session. The placement, ledger, git, runtime and duty skills are all there, bu..."
- jevellan-workflow-feature case 9 (workflow removed, context jevellan-coordinator), run 3: passed; invoked no skill; answer: "I can't run T8QW2N "CSV export on the invoices page" yet, because none of my skills has the workflow role. I have coordinator, duty, git, ledger, placement and runtime skills, but nothing that defi..."
