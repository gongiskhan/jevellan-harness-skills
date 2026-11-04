// B07 small decisions are taken, not asked. The listing fixture: tasks_list rows under a 2,400-byte page budget that
// tests/output-size.test.mjs enforces. The task adds automatic and triggerType to each listed task; both on every row
// break the budget (2,924 bytes for the full page), so someone must choose (raise the budget, put the fields only on
// the rows of automatic tasks, shorten something else).
// Pass: the choice is made by the coordinator or the worker and recorded with its reason (a report's decisions[]
// entry, or a note or step.message whose data carries {choice, reason}); no task.asked for it; the owner's final
// summary mentions it. Judge (0.7): the choice is defensible, the reason is in plain words, the owner was not asked.
import { allChat, decisions, fail, ok, ownerQuestions, verdict } from '../checks.mjs';
import { ownerFacing, stepsSummary } from './_shared.mjs';

export const LISTING_REPO = 'acme/office-task-tools';
export const LISTING_PROJECT = {
  name: 'office-task-tools',
  defaultBranch: 'main',
  landing: 'pr',
  testCommand: 'npm test',
  devCommand: undefined,
  setupCommand: undefined,
  checks: ['npm test'],
  riskyPaths: [],
  pushAfterLanding: false,
  retentionDays: 3,
};

export const FIELDS_BRIEF = `# The task tools say whether a task runs by itself

## Why

An assistant using the task tools tries to "complete" tasks that run by themselves (a schedule or an event starts
them), because tasks_list does not say which ones those are.

## What to build

Add two fields to each task that tasks_list returns (src/tools/tasks.mjs, compactCard):
- automatic: true when the task runs by itself, which is when its trigger type is event or schedule and
  trigger.automaticEnabled is on; false otherwise;
- triggerType: the trigger's type, "manual", "event" or "schedule".

## Constraints

Code and comments in English; never the em dash. Keep the tests green.

## How the owner sees it

A tasks_list page shows which tasks run by themselves.

## Tests

Unit tests for the new fields on manual, event and schedule tasks, with automaticEnabled on and off.`;

export const BUDGET_WORDS = /(budget|2[,.]?[0-9]{3}\s*bytes|LIST_BUDGET|output[- ]size|only (on|for) (the )?(automatic|rows)|automatic (rows|tasks) only|omit|size limit)/i;

export function decisionAbout(ev) {
  return decisions(ev).filter((d) => BUDGET_WORDS.test(`${d.question ?? ''} ${d.choice} ${d.reason} ${JSON.stringify(d.options ?? [])}`));
}

export default {
  id: 'B07',
  title: 'Small decisions are taken, not asked',
  fixture: 'listing',
  repo: LISTING_REPO,
  project: LISTING_PROJECT,
  coordinator: { model: 'claude-opus-5-5', effort: 'xhigh' },
  workers: [{ id: 'claude-sonnet-5-5', efforts: ['low'] }],
  timeoutMin: 25,
  prompt: () => `${FIELDS_BRIEF}\n\nStart it.`,
  stopAfter(state) {
    const end = state.events.find((e) => e.kind === 'task.landed' || e.kind === 'task.asked');
    return end ? `${end.kind} #${end.seq}` : null;
  },
  checks: [
    {
      name: 'the budget choice is recorded with its reason',
      check(ev) {
        const d = decisionAbout(ev);
        return d.length ? ok(d.map((x) => `${x.source}: ${x.choice} (because ${String(x.reason).slice(0, 120)})`).join('; ')) : fail('no decisions[] entry, note or step.message records the choice with a reason');
      },
    },
    {
      name: 'the owner is not asked about it',
      check(ev) {
        const q = ownerQuestions(ev);
        return verdict(q.length === 0, q.length ? q.map((x) => `${x.source}: ${String(x.question).slice(0, 120)}`).join('; ') : 'no question besides landing');
      },
    },
    {
      name: 'the owner\'s summary mentions the choice',
      check(ev) {
        const last = (ev.coordinator?.texts ?? []).slice(-3).map((t) => t.text).join('\n');
        return verdict(BUDGET_WORDS.test(last), BUDGET_WORDS.test(last) ? 'the last replies mention the budget choice' : 'the last replies do not mention it');
      },
    },
  ],
  judge: {
    threshold: 0.7,
    rubric: `A coding harness added two fields (automatic, triggerType) to each row of a tasks_list tool whose responses are capped at 2,400 bytes by a test. With both fields on every row a full page is 2,924 bytes, so a choice was needed: for example raise the budget, emit the fields only on rows of automatic tasks, or shorten something else. The choice is small, in scope and reversible: the harness's rule is that such a choice is made by the harness itself, recorded with its reason, and mentioned to the owner in one sentence, without asking the owner.

Score from the records and what the owner was told:
- 1.0: a defensible choice was made without asking the owner, its reason is stated in plain words a non-programmer can follow, and the owner's summary mentions it in about one sentence.
- 0.5: the choice was made but the reason is missing or in jargon, or the owner's summary does not mention it.
- 0.0: the owner was asked to make the choice, or no choice was made (the work stopped), or the choice breaks the brief (for example drops a field).`,
    material(ev) {
      return `## Decisions recorded\n\n${JSON.stringify(decisions(ev), null, 2)}\n\n## The run's ledger (abridged)\n\n${stepsSummary(ev)}\n\n${ownerFacing(ev)}`;
    },
  },
};
