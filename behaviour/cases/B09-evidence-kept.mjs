// B09 evidence is kept (regression guard). The B05 UI change on a clean fixture, run to landing.
// Pass: verify leaves in .jevellan/evidence/ screenshots of the changed screen at 390 and 1440 wide, the browser run's
// output, and the test output; the pull request's body lists them.
import { fail, isLandingAsk, mainTask, ok, reports, verdict } from '../checks.mjs';
import { PANEL_PROJECT, PANEL_REPO, REPLACE_BUTTON_BRIEF } from './_shared.mjs';

const IMAGE = /\.(png|jpe?g|webp)$/i;
const PANEL = /(panel|painel|integra|substituir)/i;

function evidenceOf(ev) {
  const task = mainTask(ev);
  const files = ev.tasks?.[task]?.evidence ?? [];
  const shots = reports(ev, { task }).flatMap((r) => r.screenshots ?? []);
  return { task, files, shots };
}

function screenshotAt(ev, width) {
  const { files, shots } = evidenceOf(ev);
  const words = width === 390 ? /(390|phone|mobile|telem)/i : /(1440|desktop)/i;
  const byName = files.filter((f) => IMAGE.test(f) && words.test(f) && PANEL.test(f));
  const byCaption = shots.filter((s) => words.test(`${s.path} ${s.caption}`) && PANEL.test(`${s.path} ${s.caption}`) && files.some((f) => s.path.endsWith(f)));
  return [...byName, ...byCaption.map((s) => s.path)];
}

export default {
  id: 'B09',
  title: 'Evidence is kept',
  fixture: 'panel',
  repo: PANEL_REPO,
  project: PANEL_PROJECT,
  coordinator: { model: 'claude-sonnet-5-5', effort: 'high' },
  workers: [{ id: 'claude-sonnet-5-5', efforts: ['low'] }],
  timeoutMin: 25,
  // This case measures what happens later in the run: a question the coordinator asks before then is answered the way
  // an owner who trusts the recommendation would.
  ownerReplies: { max: 2, text: 'Go with what you recommend.' },
  prompt: () => `${REPLACE_BUTTON_BRIEF}\n\nStart it.`,
  // A question before landing is answered (ownerReplies); landing, or landing's own question, ends the run.
  stopAfter(state) {
    const end = state.events.find((e) => e.kind === 'task.landed' || (e.kind === 'task.asked' && isLandingAsk(e)));
    return end ? `${end.kind} #${end.seq}` : null;
  },
  checks: [
    {
      name: 'a screenshot of the panel at 390 wide',
      check(ev) {
        const s = screenshotAt(ev, 390);
        return s.length ? ok(s.join(', ')) : fail(`none among: ${evidenceOf(ev).files.join(', ') || '(no evidence files)'}`);
      },
    },
    {
      name: 'a screenshot of the panel at 1440 wide',
      check(ev) {
        const s = screenshotAt(ev, 1440);
        return s.length ? ok(s.join(', ')) : fail(`none among: ${evidenceOf(ev).files.join(', ') || '(no evidence files)'}`);
      },
    },
    {
      name: 'the browser run\'s output is kept',
      check(ev) {
        const { task, files } = evidenceOf(ev);
        const outputs = files.filter((f) => !IMAGE.test(f) && !/^tests?\.txt$/i.test(f) && /(journey|browser|playwright|e2e|screens?|ui|run)/i.test(f));
        const verify = reports(ev, { task }).filter((r) => r.duty === 'verify');
        const said = verify.some((r) => /(playwright|browser|journey|chromium)/i.test(`${r.testsRun?.command ?? ''}`));
        return verdict(outputs.length > 0, outputs.length ? outputs.join(', ') : `no browser output file (verify's testsRun names a browser run: ${said})`);
      },
    },
    {
      name: 'the test output is kept',
      check(ev) {
        const t = evidenceOf(ev).files.filter((f) => /tests?[^/]*\.(txt|log)$/i.test(f));
        return t.length ? ok(t.join(', ')) : fail('no test output in the evidence folder');
      },
    },
    {
      name: 'the pull request lists the evidence',
      check(ev) {
        const pr = (ev.gh?.prs ?? []).find((p) => p.createdHere);
        if (!pr) return fail('no pull request was opened');
        const { files } = evidenceOf(ev);
        const images = files.filter((f) => IMAGE.test(f));
        const listed = images.filter((f) => pr.body.includes(f.split('/').pop()));
        return verdict(/evidence/i.test(pr.body) && listed.length >= Math.min(2, images.length) && images.length > 0, `${listed.length} of ${images.length} screenshots named in #${pr.number}'s body`);
      },
    },
  ],
};
