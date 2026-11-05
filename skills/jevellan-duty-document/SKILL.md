---
name: jevellan-duty-document
description: "Duty document. Use when this session is running a task step whose duty is document: only when the runtime's instructions for this session say 'Your step is duty document', never for a request typed by the owner. Changes documentation files only. End by writing the report file."
jh-role: duty
jh-duty: document
jh-needs: [repo-write]
---

# Duty: document

This step changes documentation files only: the README, the docs folder, guides, the changelog and similar prose the project keeps for people. Never change code, tests, configuration, build files or dependencies, not even to fix something you notice; mention it in the report instead.

1. Before editing, read plan.md at the worktree root when it exists, including when an implement step wrote it because planning was skipped. When it has a ```scope block, identify which documentation files it permits. That boundary applies to every edit below, including corrections and changelog entries. A workflow selecting this step or asking for documentation does not widen the scope, and this step never changes plan.md to admit another file.
   - If the scope contains no documentation file, change nothing and make no commit. Finish with status done and changedFiles empty (`[]`), explaining that no documentation is in scope. If a document outside the scope needs an update, name the path and what it should say in followUps (kind scope) for the owner's decision.
2. Find out what changed from the earlier steps' summaries in your task block and this branch's commits and diff against its base branch (from your isolation line). Find where the project documents those changes. Update only permitted documentation in its existing structure, voice and language. Create a new documentation file only when the step instructions ask for one or nothing existing fits, and only inside the scope when there is a scope block. Report needed updates outside it as followUps (kind scope), leaving those files as they are.
3. Document the behaviour as it is on this branch, not as the plan said it would be. Check every command, flag, option, setting and default you write down against the code (package.json scripts, the CLI's help, the configuration schema).
4. Within the permitted documentation, correct or remove what the change made false.
5. Add a changelog entry only when the project keeps a changelog and that file is permitted by the scope, in its format, under its unreleased section.
6. Before committing, compare every file this step changed with the permitted documentation. Commit only those changes on this branch, with a message that says what and why, and leave no uncommitted changes. When no documentation changes are needed or permitted, make no commit.

## Your report

Status done, with a summary that names each document you changed and what a reader now learns from it. changedFiles lists every file you touched. When nothing needed documenting or no documentation is in scope, say which and why, and use status done with changedFiles empty (`[]`). Needed updates outside the scope still go in followUps (kind scope); an empty changedFiles list describes this step, not the earlier steps' changes.

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something, followUps [{kind, title, evidence, cause}] for documents outside the plan's scope that need updating. Then end your turn.

## Interface

No scripts. Other skills read only this file: its frontmatter (`jh-duty`, `jh-needs`) when a step is placed, and its body, which a runtime that cannot load skills gives its worker inline.
