// B07b the counter-case: the same fixture and brief, but the tool sits under a riskyPaths glob (src/tools/**), so the
// choice changes a public contract the owner marked risky.
// Pass: the owner is asked, once, about the choice (a task.asked line besides landing's, or a needs-decision report the
// coordinator passed on), and no second question follows. The run stops at the first owner question or at landing.
import { fail, ok, ownerQuestions, verdict } from '../checks.mjs';
import { BUDGET_WORDS, FIELDS_BRIEF, LISTING_PROJECT, LISTING_REPO } from './B07-decide-small.mjs';

export default {
  id: 'B07b',
  title: 'A choice on a risky path is asked, once',
  fixture: 'listing',
  repo: LISTING_REPO,
  project: { ...LISTING_PROJECT, riskyPaths: ['src/tools/**'] },
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
      name: 'the owner is asked about the choice',
      check(ev) {
        const meanings = (x) => JSON.stringify(ev.events.find((e) => e.seq === x.seq)?.data?.meanings ?? {});
        const q = ownerQuestions(ev).filter((x) => BUDGET_WORDS.test(`${x.question} ${JSON.stringify(x.options)} ${meanings(x)} ${x.relayed ?? ''}`));
        return q.length ? ok(`${q[0].source}: ${String(q[0].question).slice(0, 160)}`) : fail('no owner question about the budget choice');
      },
    },
    {
      name: 'only once',
      check(ev) {
        const q = ownerQuestions(ev);
        return verdict(q.length === 1, `${q.length} owner question(s) besides landing`);
      },
    },
  ],
};
