---
name: jevellan-duty-plan
description: "Duty plan. Use when this session is running a task step whose duty is plan. Writes plan.md at the worktree root, read-only otherwise. End by writing the report file."
jh-role: duty
jh-duty: plan
jh-needs: [repo-read]
---

# Duty: plan

This step writes one file, plan.md at the worktree root, and changes nothing else; the only other file you write is your report, .jevellan/report.json. Do not create, edit or delete any other file, and do not commit: task worktrees exclude plan.md from git, so it stays out of the task's commits and the later steps read it where you leave it.

1. Read the task text and the step instructions. The step instructions say what plan.md must contain; they are the outline of the plan.
2. Read the code the change touches: the entry points, the modules involved, the existing tests next to them, and the project's conventions in AGENTS.md. Read enough to name real files, functions and data shapes; a plan built on guessed names sends the next step the wrong way.
3. Write plan.md:
   - The first paragraph states the change in one paragraph: what changes, why, and what the owner will be able to see or do afterwards.
   - Then the sections the step instructions ask for, concrete and short: each file to touch and what changes in it, each test to add or change and what it proves, and anything that needs care (stored data, migrations, behaviour other code relies on).
   - Size it for a capable engineer who will follow it in one sitting: no code beyond a signature or a short snippet where the shape matters, no restating of the task.
4. Decide yourself everything that follows from the task, the code or the project's conventions, and write each such decision with its reason in plan.md. Only a choice that genuinely belongs to the owner (what the product should do, scope, cost, their data) is an open question. Write it in plan.md under "Open questions" with the options, and plan the rest so the next step can continue once it is answered.
5. When plan.md already exists (a retry or a resumed step), update it instead of starting over, and keep the decisions the owner already made.

## Your report

Status done, with the first paragraph of plan.md as the summary, followed by one line naming the main files the plan touches. changedFiles is `["plan.md"]`.

When an owner's choice blocks the plan, use status needs-decision instead: the question in one or two sentences, two to four options with a short description each, and the rest of the plan already written.

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something. Then end your turn.
