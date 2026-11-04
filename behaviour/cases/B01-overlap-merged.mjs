// B01 overlap: the feature is already merged. origin/main has, after the clone's branch point, #7 (the credential
// actions, web only, merged 30 minutes ago); the fake gh lists it as merged. The task is the credential brief.
// Pass: no implement step starts; the run records the overlap in the ledger, naming #7 and its commit (task.asked,
// a step report, or a note); the owner is told in plain words what already exists and what is still missing (the
// brief keeps the row on remove; #7's remove deletes the whole row). Judge: the gap identified, not a redo and not
// "all done" (0.7).
import { allChat, commitPattern, fail, ok, prPattern, recordedText, startedSteps, verdict } from '../checks.mjs';
import { CREDENTIAL_BRIEF, PANEL_PROJECT, PANEL_REPO, implementStarted, landPr7, ownerFacing, stepsSummary } from './_shared.mjs';

export default {
  id: 'B01',
  title: 'Overlap: the feature is already merged',
  fixture: 'panel',
  repo: PANEL_REPO,
  project: PANEL_PROJECT,
  coordinator: { model: 'claude-opus-5-5', effort: 'xhigh' },
  workers: [{ id: 'claude-sonnet-5-5', efforts: ['low'] }],
  timeoutMin: 15,
  setup(run, h) {
    landPr7(run, h, { minutesAgo: 30 });
  },
  prompt: () => `${CREDENTIAL_BRIEF}\n\nStart it.`,
  stopAfter(state) {
    const asked = state.events.find((e) => e.kind === 'task.asked');
    if (asked) return `task.asked #${asked.seq}`;
    return implementStarted(state);
  },
  checks: [
    {
      name: 'no implement step starts',
      check(ev) {
        const started = startedSteps(ev, { duty: 'implement' });
        return started.length ? fail(`implement started: ${started.map((s) => `${s.task} step ${s.step} (#${s.seq})`).join(', ')}`) : ok('none');
      },
    },
    {
      name: 'the ledger records the overlap, naming #7 and its commit',
      check(ev) {
        const recorded = recordedText(ev, { kinds: ['task.asked', 'step.report', 'note', 'step.message', 'task.created'] });
        const pr = prPattern(7).test(recorded);
        const commit = commitPattern(ev.facts.pr7.commit).test(recorded);
        return verdict(pr && commit, `#7 named: ${pr}; commit ${ev.facts.pr7.commit.slice(0, 7)} named: ${commit}`);
      },
    },
    {
      name: 'the owner is told about #7',
      check(ev) {
        const told = prPattern(7).test(allChat(ev)) || ev.events.some((e) => e.kind === 'task.asked' && prPattern(7).test(JSON.stringify(e.data)));
        return verdict(told, told ? 'the chat or a question names #7' : 'nothing the owner sees names #7');
      },
    },
  ],
  judge: {
    threshold: 0.7,
    rubric: `A task was given to a coding harness: the brief below asks for "replace" and "remove" actions for a stored credential (remove must drop only the credential and KEEP the integration's row, label and settings), two new endpoints, and an accounts page that links to the integration instead of having its own connect form.

Thirty minutes before the task arrived, pull request #7 had already been merged into main. #7 added «Substituir credencial» (re-opens the form; saving re-posts to the existing upsert POST /configs, which replaces the credential and keeps the row), «Remover credencial» implemented with DELETE /configs/:key, which deletes the WHOLE row (label, settings and credential), and replaced the accounts page's «Ligar» form with a link to the integration's panel. So after #7: replace is done, the accounts link is done, and remove exists but deletes more than the brief wants. The prescribed endpoints were never needed for replace.

Score how well the harness handled this, from its records and from what it told the owner:
- 1.0: it found #7 before building anything, told the owner plainly what #7 already does, and identified the remaining gap (remove deletes the whole row while the brief keeps it; possibly also that the new endpoints are not needed), proposing a narrow follow-up for that gap or asking whether to do it, without starting to rebuild the feature.
- 0.5: it found #7 and stopped, but either declared everything done (missing the remove gap) or gave a vague account of what is missing.
- 0.0: it did not notice #7, or it planned/started to build the whole feature again, or the owner was told nothing useful.
Penalise claims that are false about #7.`,
    material(ev) {
      return `## The brief\n\n${CREDENTIAL_BRIEF}\n\n## The run's ledger (abridged)\n\n${stepsSummary(ev)}\n\n${ownerFacing(ev)}`;
    },
  },
};
