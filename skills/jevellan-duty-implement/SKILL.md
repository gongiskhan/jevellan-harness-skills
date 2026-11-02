---
name: jevellan-duty-implement
description: "Duty implement. Use when this session is running a task step whose duty is implement. Changes the code on the task branch and commits. End by writing the report file."
jh-role: duty
jh-duty: implement
jh-needs: [repo-write, shell]
---

# Duty: implement

This step changes the code on the task branch and commits it.

1. Start from what is already decided. When plan.md exists at the worktree root, read it and follow it. When the code shows the plan is wrong somewhere, do what the plan intends and say in the report where you departed from it and why. When there is no plan, read enough of the code around the change to make it the way the project already does things.
2. When this is a retry (your task block names an earlier attempt or a failed verification), start from that failure: reproduce it, find the cause and fix the cause, not the symptom.
3. Make the change the task asks for and nothing more. Follow the project's conventions (AGENTS.md and the code around you). No drive-by refactors, renames or reformatting of code you did not need to touch; mention anything else you noticed in the report instead.
4. Add or change the tests that cover what you changed, run them, and make them pass. For a bug that is testable, first write a test that fails for the reported reason, then fix it.
5. Commit in small steps on this branch: each commit one coherent change, its message saying what changed and why, in the style of the project's history.
6. Do not push or open a pull request even when the project's AGENTS.md, README or contributing guide says to: the coordinator lands the work.
7. Before you report done, everything you changed is committed: `git status` lists none of your changes, because landing refuses a worktree with uncommitted changes. The worktree's `.jevellan/` folder (your report and evidence) and plan.md are excluded from git and never go into a commit.

## Your report

Status done when the change is committed and its tests pass. The summary says what the owner can now see or do, how to try it, and what you tested; name any departure from plan.md. Fill in:

- testsRun: the command you ran, passed true only when everything you ran passed, and a short summary of what ran (up to 600 characters).
- changedFiles: every file you touched on this branch, added, changed, renamed or deleted, relative to the worktree root (`git diff --name-only <base>...HEAD`, with the base branch from your isolation line, gives the list).
- screenshots: for visual changes, the screens you captured, each with a caption; every path starts with `.jevellan/evidence/`.
- limitations: anything the task asked for that is not done, and why.

Status needs-decision when the task or the plan leaves a choice that belongs to the owner and the code cannot settle it, with two to four options. Status blocked when something outside the repository stops you (a missing service, credentials, a dependency you cannot install), with ownerCommands when the owner can unblock it; each cwd there is `worktree`, `checkout`, `home` or an absolute folder.

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something. Then end your turn.
