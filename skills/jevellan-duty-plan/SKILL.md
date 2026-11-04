---
name: jevellan-duty-plan
description: "Duty plan. Use when this session is running a task step whose duty is plan: only when the runtime's instructions for this session say 'Your step is duty plan', never for a request typed by the owner. Writes plan.md at the worktree root, read-only otherwise. End by writing the report file."
jh-role: duty
jh-duty: plan
jh-needs: [repo-read]
---

# Duty: plan

This step writes one file, plan.md at the worktree root, and changes nothing else; the only other file you write is your report, .jevellan/report.json. Do not create, edit or delete any other file, and do not commit: task worktrees exclude plan.md from git, so it stays out of the task's commits and the later steps read it where you leave it.

1. Read the task text and the step instructions. The step instructions say what plan.md must contain; they are the outline of the plan. The brief's outcome (what the owner wants to see or do) is binding. The mechanism it prescribes (endpoints, components, files, a library) is a suggestion, however firmly it is worded ("add two endpoints"), unless the brief marks it "required": the brief was written before anyone read the code.
2. Read the code the change touches: the entry points, the modules involved, the existing tests next to them, and the project's conventions in AGENTS.md. Look first for what already does part of the job: the routes, functions, components and data the brief's outcome could reuse, even where the brief asks for something new. Read enough to name real files, functions and data shapes; a plan built on guessed names sends the next step the wrong way.
3. Write plan.md:
   - The first paragraph states the change in one paragraph: what changes, why, and what the owner will be able to see or do afterwards.
   - "## What already exists": the code that already does part of the job, each item with its file path and what it does today (a route with its handler, a component, a function, a stored field). Say when nothing relevant exists.
   - "## Smallest change": the least code that meets the brief's outcome, built on what exists. Go through every mechanism the brief prescribes (each endpoint, component, table, file or library it names) and say whether it is needed. When something that exists already does that job, even reached another way (the same data saved through an existing endpoint, the same screen through an existing component), use it and do not build the prescribed one. For each one, put the two options side by side (what exists, and what the brief prescribes) with what each costs, and take the smaller one unless you name a concrete technical reason the existing one cannot serve; that the brief or the owner asked for it is not such a reason, and neither is a requirement you add yourself (stricter validation, a new error code). For example, a "rename" endpoint is not added when the existing update endpoint already saves a new name. End the section with "Not followed from the brief": each prescribed mechanism the plan does not build, and what serves instead (or "none").
   - Then the sections the step instructions ask for, concrete and short: each file to touch and what changes in it, each test to add or change and what it proves, and anything that needs care (stored data, migrations, behaviour other code relies on).
   - Last, the scope: a fenced block whose info string is `scope`, one path or pattern per line (`*`, `?` and `**` as in riskyPaths), naming every file the task will change, tests included, and the documentation the change will need updating (the README section, a docs page, the changelog) when the project keeps one: a change a person would look for there (a new button, command, option or behaviour) puts that file in the scope, because a later document step changes nothing outside it. The later steps stay inside it and landing compares the branch with it, so neither too narrow nor "everything":
     ```scope
     web/panel.mjs
     tests/panel.test.mjs
     ```
   - Size it for a capable engineer who will follow it in one sitting: no code beyond a signature or a short snippet where the shape matters, no restating of the task.
4. Decide yourself everything that follows from the task, the code or the project's conventions, and write each such decision with its reason in plan.md. Before you decide any choice beyond that, read the project's riskyPaths in .jevellan/project.json at the project root (the folder in the JH_PROJECT environment variable) and compare them with the files the choice changes: a choice that changes a file under a risky path is never yours, however small. Write it under "Open questions" with its options and report needs-decision. Otherwise decide too a choice that stays within the task, can be undone by a later change and is not about what the product is for, money, the owner's data or production: a trade-off between the brief's wording and one of the project's own limits or rules (a size or page limit, which rows carry a field) is one. Take the option that keeps the brief's outcome within the project's rules, or, when none does, the one that changes the least and is easiest to undo, and list it in your report's decisions. Only a choice that genuinely belongs to the owner (what the product should do, scope, cost, their data, or anything under riskyPaths) is an open question. Write it in plan.md under "Open questions" with the options, and plan the rest so the next step can continue once it is answered.
5. When plan.md already exists (a retry or a resumed step), update it instead of starting over, and keep the decisions the owner already made.

## Your report

Status done, with the first paragraph of plan.md as the summary, followed by one line naming the main files the plan touches and one line naming any brief instruction the plan does not follow. changedFiles is `["plan.md"]`. decisions lists the choices you made under step 4, each {question, choice, options, reason, reversible}.

When an owner's choice blocks the plan, use status needs-decision instead: the question in one or two sentences, two to four options with a short description each, and the rest of the plan already written.

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something, decisions [{question, choice, options, reason, reversible}] for choices you made yourself. Then end your turn.

## Interface

No scripts. Other skills read only this file: its frontmatter (`jh-duty`, `jh-needs`) when a step is placed, and its body, which a runtime that cannot load skills gives its worker inline.
