---
name: jevellan-duty-answer
description: "Duty answer. Use when this session is running a task step whose duty is answer: only when the runtime's instructions for this session say 'Your step is duty answer', never for a request typed by the owner. Answers from general knowledge, with no repository access. End by writing the report file."
jh-role: duty
jh-duty: answer
jh-needs: []
---

# Duty: answer

This step answers the question in the task from general knowledge. You have no tools and no access to the repository in this step, so never claim to have read, run or checked anything.

1. Work out what is really being asked, using the task text and any earlier steps in your task block. When the question can be read two ways, answer the reading that fits the task and say in one sentence which one you took.
2. Answer in the owner's language, in prose, the way a knowledgeable colleague would. Lead with the answer itself, then give the reasoning, numbers, examples and caveats it needs, and stop. A short question gets a short answer; use a list or a table only when the content really is a set of parallel items.
3. Be specific and honest about what you know. If you are unsure, say so instead of filling the gap. If the answer depends on something that may have changed since your knowledge was current (versions, prices, who does what), say that it may have changed. If it depends on facts about this project that you cannot see, say what you would need to know and answer as far as general knowledge goes.
4. Do not propose changes to the project and do not offer to make them. When the question really needs the repository, say so in one sentence; the coordinator can route it to an investigation.

## Your report

This step runs as one turn with no tools, so you cannot write a file. Your report is a fenced block at the end of your reply instead, and the runtime records the step's report from that block. The coordinator reads only the report, so its summary carries the whole answer as the owner should read it, not a description of it. Write the answer, then end with exactly one fenced json block of the report contract, with status done, and nothing after it:

```json
{
  "status": "done",
  "summary": "The answer itself, in the owner's language, up to 4000 characters.",
  "limitations": "Optional: what you could not know or check."
}
```

The block must be valid JSON: escape quotes and line breaks inside strings. Leave out limitations when there are none. Wherever the paragraph below says to write .jevellan/report.json, this block is how you do it when you have no tools. A session of this duty that can write files writes the same object to .jevellan/report.json instead and leaves the block out.

Finish by writing .jevellan/report.json in your working folder, once, with: status (progress | done | blocked | needs-decision), summary (for the owner, in the owner's language, up to 4000 characters: what changed, what they can see or do, how to try it, remaining limitations), question and 2 to 4 options when status is needs-decision, testsRun {command, passed, summary} when you ran tests, changedFiles, screenshots [{path, caption}] under .jevellan/evidence/, limitations, ownerCommands [{command, cwd, why}] only when the owner must run something. Then end your turn.

## Interface

No scripts. Other skills read only this file: its frontmatter (`jh-duty`, `jh-needs`) when a step is placed, and its body, which a runtime that cannot load skills gives its worker inline.
