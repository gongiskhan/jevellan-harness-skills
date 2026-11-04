---
name: jevellan-duty-plan
description: "Duty plan. Use when this session is running a task step whose duty is plan: only when the runtime's instructions for this session say 'Your step is duty plan', never for a request typed by the owner. Writes plan.md at the worktree root, read-only otherwise. End by writing the report file."
jh-role: duty
jh-duty: plan
jh-needs: [repo-read]
---

# Duty: plan

This step writes one file, plan.md at the worktree root, and changes nothing else; the only other file you write is your report, .jevellan/report.json. Do not create, edit or delete any other file, and do not commit: task worktrees exclude plan.md from git, so it stays out of the task's commits and the later steps read it where you leave it.

1. Read the task text and the step instructions. The step instructions say what plan.md must contain; they are the outline of the plan. The brief's outcome (what the owner wants to see or do) is binding; the mechanism it prescribes (endpoints, components, files, a library) is a suggestion unless the brief marks it "required".
2. Read the code the change touches: the entry points, the modules involved, the existing tests next to them, and the project's conventions in AGENTS.md. Look first for what already does part of the job: the routes, functions, components and data the brief's outcome could reuse, even where the brief asks for something new. Read enough to name real files, functions and data shapes; a plan built on guessed names sends the next step the wrong way.
3. Write plan.md:
   - The first paragraph states the change in one paragraph: what changes, why, and what the owner will be able to see or do afterwards.
   - "## What already exists": the code that already does part of the job, each item with its file path and what it does today (a route with its handler, a component, a function, a stored field). Say when nothing relevant exists.
   - "## Smallest change": the least code that meets the brief's outcome, built on what exists. Go through every mechanism the brief prescribes (each endpoint, component, table, file or library it names) and say whether it is needed. When something that exists already does that job, even reached another way (the same data saved through an existing endpoint, the same screen through an existing component), use it and do not build the prescribed one. Build a prescribed mechanism only for a concrete reason the existing one cannot serve, and write the reason; "the brief says so" is not one. End the section with "Not followed from the brief": each prescribed mechanism the plan does not build, and what serves instead (or "none").
   - Then the sections the step instructions ask for, concrete and short: each file to touch and what changes in it, each test to add or change and what it proves, and anything that needs care (stored data, migrations, behaviour other code relies on).
   - Last, the scope: a fenced block whose info string is `scope`, one path or pattern per line (`*`, `?` and `**` as in riskyPaths), naming every file the task will change, tests included. The later steps stay inside it and landing compares the branch with it, so neither too narrow nor "everything":
     ```scope
     web/panel.mjs
     tests/panel.test.mjs
     ```
   - Size it for a capable engineer who will follow it in one sitting: no code beyond a signature or a short snippet where the shape matters, no restating of the task.
4. Decide yourself everything that follows from the task, the code or the project's conventions, and write each such decision with its reason in plan.md. Only a choice that genuinely belongs to the owner (what the product should do, scope, cost, their data) is an open question. Write it in plan.md under "Open questions" with the options, and plan the rest so the next step can continue once it is answered.
5. When plan.md already exists (a retry or a resumed step), update it instead of starting over, and keep the decisions the owner already made.

## Your report

Status done, with the first paragraph of plan.md as the summary, followed by one line naming the main files the plan touches and one line naming any brief instruction the plan does not follow. changedFiles is `["plan.md"]`.

When an owner's choice blocks the plan, use status needs-decision instead: the question in one or two sentences, two to four options with a short description each, and the rest of the plan already written.

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something. Then end your turn.

## Interface

No scripts. Other skills read only this file: its frontmatter (`jh-duty`, `jh-needs`) when a step is placed, and its body, which a runtime that cannot load skills gives its worker inline.
