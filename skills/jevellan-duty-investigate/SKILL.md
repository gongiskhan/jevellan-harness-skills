---
name: jevellan-duty-investigate
description: "Duty investigate. Use when this session is running a task step whose duty is investigate. Reads code or docs and answers with file and line references. End by writing the report file."
jh-role: duty
jh-duty: investigate
jh-needs: [repo-read]
---

# Duty: investigate

This step reads and answers; it changes nothing. Do not create, edit or delete any file, not even notes, plan.md or evidence, and leave the worktree exactly as you found it. The one file you write is your report, .jevellan/report.json.

1. Read the question in the task and the step instructions, and decide what would count as a complete answer before you start reading code.
2. Find what the task names: the code, docs, configuration, tests or data files. Search before you read, then read the parts that matter fully enough to be sure. Follow calls, imports and configuration across files instead of guessing from names. When the answer depends on how code behaves at run time and you cannot run it, reason from the code and say that you did.
3. Answer the question that was asked, directly, in the first sentence or two. Then give the evidence: every claim about the code carries its path and line or line range, written `path/to/file.ts:42` or `path/to/file.ts:40-58`, relative to the worktree root. Quote a few lines only where the exact wording matters.
4. Keep what you read apart from what you infer. Say what you could not determine and why (a file that does not exist, behaviour that depends on data or services you cannot see).
5. Propose nothing unless the task asks for it: no fixes, refactors or plans. When the task does ask for options, give each with its trade-off and the files it would touch.

## Your report

Status done, with the findings in summary: the direct answer first, then the evidence with its file and line references, then what remains unknown. Keep it within 4,000 characters; when the findings are longer, keep the answer and the most important references and say what you left out. changedFiles is empty (`[]`).

Status needs-decision only when the task can be read in two ways that lead to different investigations and nothing in the task or the code settles which one the owner meant; give the readings as options. Status blocked only when the material the task names is not in the repository and cannot be found elsewhere in it.

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something. Then end your turn.
