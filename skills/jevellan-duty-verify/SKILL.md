---
name: jevellan-duty-verify
description: "Duty verify. Use when this session is running a task step whose duty is verify: only when the runtime's instructions for this session say 'Your step is duty verify', never for a request typed by the owner. Runs the tests and browser journeys and saves evidence. End by writing the report file."
jh-role: duty
jh-duty: verify
jh-needs: [repo-write, shell, browser]
---

# Duty: verify

This step checks the work on the task branch and reports what it found. You do not fix anything: when a check fails, report it, and the coordinator sends the task back to the step that wrote the code, with your report. The step instructions say what to check; what follows is how.

The project's settings are in `.jevellan/project.json` at the project root (the folder in the `JH_PROJECT` environment variable), not in your worktree; your task block lists testCommand, devCommand and automationDir under "Project settings" when they are set.

1. Find what to check: the earlier steps' summaries in your task block, plan.md when it exists, and the files this branch changed against its base branch (`git diff --name-only <base>...HEAD`, with the base branch from your isolation line).
2. Run the project's test command, testCommand in .jevellan/project.json, in full, once. When none is set, use the command the project documents (the test script in package.json, AGENTS.md, the README) and say in the report which one you used and that .jevellan/project.json sets none. Save the output to .jevellan/evidence/tests.txt. When something fails, run the failing tests once more on their own to tell a flaky test from a real failure, and report both runs.
   - Then sort each failure. A failure is this change's when the failing test or the code it exercises is changed on this branch (`git diff --name-only <base>...HEAD`). It is outside the task's scope when it is not, or when it fails the same way on the base branch: add a follow-up (kind unrelated-failure) with the test's name, the failing line and one sentence on its likely cause. It is the machine's when the error is one of a host (too many open files or watches: EMFILE, ENOSPC, inotify; a browser sandbox the system refuses; no display; the wrong Node version; a full disk; permission denied on system paths): add a follow-up (kind host) with the error line and the fix the machine needs.
3. Browser journeys, for every screen the change touches or could affect. If the skill web-testing is available, use it for browser journeys; otherwise use Playwright directly with the project's dev server command from .jevellan/project.json devCommand.
   - Drive the screens the way a person would: navigate, click, fill and submit, and check what appears. Cover the states the change affects, such as empty, error, long content and a signed-out user, not only the first render.
   - Check every journey at a desktop width (1440 by 900) and a phone width (390 by 844).
   - Save screenshots under .jevellan/evidence/ with names that say the screen, the state and the width (`.jevellan/evidence/customers-empty-phone.png`), and videos or traces there too when the step asks for them.
   - Save the browser run's own output there too, as .jevellan/evidence/browser.txt: what the journeys printed (each journey, what it checked, passed or failed), or the browser test runner's report. With the screenshots and tests.txt it is the evidence the owner reviews instead of re-running the journeys.
   - Start the dev server on a free port, and stop at the end only the processes you started.
   - When the change touches no screen, or the project has no interface, say so and skip this part.
4. Leave the worktree as you found it apart from .jevellan/evidence/: change no code or tests and commit nothing. A throwaway journey script, if you need one, goes under .jevellan/evidence/ too.

## Your report

Status done when you finished checking, whether the checks passed or not; the result is in testsRun:

- testsRun: command lists what you ran (the test command, and the journeys); passed is true only when everything you ran passed, the test command and every journey, apart from failures you put in followUps as outside the task's scope or the machine's; summary gives the counts, the first failure in a sentence, and names those set-aside failures (up to 600 characters).
- followUps: the failures outside the task's scope and the machine's problems (step 2), each {kind, title, evidence, cause}. The code stays as it is: verify fixes nothing.
- screenshots: every screenshot, its path starting with `.jevellan/evidence/`, with a caption that says what it shows. Name the videos and traces you saved in the summary.
- summary: what you checked, what passed, what failed with the exact error and where, and what you could not check and why. When a test is flaky, say which one and what its two runs showed.

Status blocked only when you could not check at all, for a reason outside the change (the dev server needs a service or credentials that are not there, no browser can start), with ownerCommands when the owner can fix it; each cwd there is `worktree`, `checkout`, `home` or an absolute folder.

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something, followUps [{kind, title, evidence, cause}] for what is not this task's to fix. Then end your turn.

## Interface

No scripts. Other skills read only this file: its frontmatter (`jh-duty`, `jh-needs`) when a step is placed, and its body, which a runtime that cannot load skills gives its worker inline.
