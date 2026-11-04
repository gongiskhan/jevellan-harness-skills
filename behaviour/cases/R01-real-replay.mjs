// R01 real replay on ekoa-code (no build; read-only to GitHub). A throwaway clone of gongiskhan/ekoa-code at the commit
// where #408 merged (2d3659ec0, 2026-11-03 11:34:59 UTC), made from the owner's local objects; origin is a local bare
// mirror at that commit (behind https://github.com/gongiskhan/ekoa-code.git through url.<bare>.insteadOf, so nothing
// can be pushed to GitHub), holding main only (the checkout's other branches, the harness's task branches among them,
// are not copied). gh is the real one through a wrapper that lets only list and view through and shows GitHub as it
// was at the merge: pull requests created later (T7E8XHB's own #414 among them) are hidden. project.json is ekoa-code's,
// without setupCommand (the run stops before any step that builds).
// The prompt is T7E8XHB's original task text, verbatim from ekoa-code's ledger (seq 17), read at run time and never
// written into this repository.
// Pass: no implement step starts; the run names #408 (or its merge commit) as having shipped replace and remove from
// the web, and proposes closing as done or a narrow follow-up (the remove semantics). Judge (0.7) for the proposal.
import fs from 'node:fs';
import path from 'node:path';
import { allChat, commitPattern, fail, ok, prPattern, recordedText, startedSteps, verdict } from '../checks.mjs';
import { implementStarted, ownerFacing, stepsSummary } from './_shared.mjs';

const SOURCE = path.join(process.env.HOME ?? '', 'dev', 'ekoa-code');
const MERGE = '2d3659ec026d98eb3ed1a0b87f80b43ab93aa6e3';
const CUTOFF = '2026-11-03T11:34:59Z';

function taskText() {
  const ledger = path.join(SOURCE, '.jevellan', 'ledger.jsonl');
  for (const line of fs.readFileSync(ledger, 'utf8').split('\n')) {
    if (!line.includes('"seq":17,')) continue;
    const e = JSON.parse(line);
    if (e.seq === 17 && e.kind === 'task.created' && e.task === 'T7E8XHB') return e.data.text;
  }
  throw new Error('R01: seq 17 of ekoa-code\'s ledger is not T7E8XHB\'s task.created');
}

const named = (text) => prPattern(408).test(text) || commitPattern(MERGE).test(text);

export default {
  id: 'R01',
  title: 'Real replay: T7E8XHB after #408 merged',
  fixture: 'replay',
  repo: 'gongiskhan/ekoa-code',
  coordinator: { model: 'claude-opus-5-5', effort: 'xhigh' },
  workers: [{ id: 'claude-sonnet-5-5', efforts: ['high'] }],
  timeoutMin: 25,
  defaultRuns: 2,
  makeRepos(run, h) {
    h.git(path.dirname(run.origin), ['clone', '-q', '--bare', '--local', SOURCE, run.origin]);
    for (const ref of h.git(run.origin, ['for-each-ref', '--format=%(refname)', 'refs/heads/']).split('\n').filter(Boolean)) {
      if (ref !== 'refs/heads/main') h.git(run.origin, ['update-ref', '-d', ref]);
    }
    h.git(run.origin, ['update-ref', 'refs/heads/main', MERGE]);
    h.git(run.origin, ['symbolic-ref', 'HEAD', 'refs/heads/main']);
    run.project = path.join(run.projectsDir, 'ekoa-code');
    h.git(run.projectsDir, ['clone', '-q', '--local', run.origin, run.project]);
    const url = 'https://github.com/gongiskhan/ekoa-code.git';
    h.git(run.project, ['config', `url.${run.origin}.insteadOf`, url]);
    h.git(run.project, ['remote', 'set-url', 'origin', url]);
    h.installReadOnlyGh(run, { cutoff: CUTOFF });
    const project = h.readJson(path.join(SOURCE, '.jevellan', 'project.json'));
    delete project.setupCommand;
    run.projectFields = project;
    run.facts = { ...run.facts, repo: 'gongiskhan/ekoa-code', pr408: { number: 408, commit: MERGE, mergedAt: CUTOFF }, cutoff: CUTOFF };
  },
  prompt: () => `${taskText()}\n\nStart it.`,
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
      name: 'the owner is told that #408 shipped it',
      check(ev) {
        const inChat = named(allChat(ev));
        const inQuestion = ev.events.some((e) => e.kind === 'task.asked' && named(JSON.stringify(e.data)));
        return verdict(inChat || inQuestion, `chat: ${inChat}; question: ${inQuestion}`);
      },
    },
    {
      name: 'the ledger records #408',
      check(ev) {
        const n = named(recordedText(ev, { kinds: ['task.asked', 'step.report', 'note', 'step.message'] }));
        return verdict(n, n ? 'a ledger line names #408 or its commit' : 'no ledger line names #408');
      },
    },
  ],
  judge: {
    threshold: 0.7,
    rubric: `A coding harness received the task below (replace and remove an integration's credential in Ekoa; the Caixa account panel should link to the integration). Pull request #408, "Saved credentials can be replaced and removed; Caixa accounts link to their integration (D-CRED-REPLACE-1)", had been merged to main 40 minutes earlier: web only, 17 files. It made replace work by re-saving the form (the existing POST /api/v1/integrations/configs is an upsert into the same config row) and remove by calling the existing full integration delete (DELETE /api/v1/integrations/:key), which deletes the config row, its settings and stored action evidence, which is more than "remove the credential". It added the link from the Caixa accounts to the integration.

Score what the harness did, from its records and what it told the owner:
- 1.0: before building anything it found #408, told the owner plainly that replace, remove and the link already shipped, and proposed either closing the task as done or a narrow follow-up (for example: remove should drop only the credential and keep the row and its messages), without starting implementation.
- 0.5: it found #408 but its proposal is vague, or it proposes rebuilding most of the feature anyway.
- 0.0: it did not find #408, or it went on to plan and build the feature as briefed.`,
    material(ev) {
      return `## The task (abridged)\n\n${String(ev.events.find((e) => e.kind === 'task.created')?.data?.text ?? '').slice(0, 6000)}\n\n## The run's ledger (abridged)\n\n${stepsSummary(ev)}\n\n${ownerFacing(ev)}`;
    },
  },
};
