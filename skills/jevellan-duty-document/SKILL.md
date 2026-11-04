---
name: jevellan-duty-document
description: "Duty document. Use when this session is running a task step whose duty is document: only when the runtime's instructions for this session say 'Your step is duty document', never for a request typed by the owner. Changes documentation files only. End by writing the report file."
jh-role: duty
jh-duty: document
jh-needs: [repo-write]
---

# Duty: document

This step changes documentation files only: the README, the docs folder, guides, the changelog and similar prose the project keeps for people. Never change code, tests, configuration, build files or dependencies, not even to fix something you notice; mention it in the report instead.

1. Find out what changed: the earlier steps' summaries in your task block, plan.md when it exists, and this branch's commits and diff against its base branch (from your isolation line).
2. Find where the project documents the things that changed. Update those places in their existing structure, voice and language. Create a new documentation file only when the step instructions ask for one or nothing existing fits.
   - When plan.md has a ```scope block, change only documentation files inside it. A document that needs updating but is outside the scope stays as it is: name it, and what it should say, in your report's followUps (kind scope), so the owner decides.
3. Document the behaviour as it is on this branch, not as the plan said it would be. Check every command, flag, option, setting and default you write down against the code (package.json scripts, the CLI's help, the configuration schema).
4. Correct or remove what the change made false, wherever it appears.
5. Add a changelog entry only when the project keeps a changelog, in its format, under its unreleased section.
6. Commit on this branch with a message that says what and why, and leave no uncommitted changes.

## Your report

Status done, with a summary that names each document you changed and what a reader now learns from it. changedFiles lists every file you touched. When nothing needed documenting, say why and use status done with changedFiles empty (`[]`).

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something, followUps [{kind, title, evidence, cause}] for documents outside the plan's scope that need updating. Then end your turn.

## Interface

No scripts. Other skills read only this file: its frontmatter (`jh-duty`, `jh-needs`) when a step is placed, and its body, which a runtime that cannot load skills gives its worker inline.
