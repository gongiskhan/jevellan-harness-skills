// B03 overlap: an open pull request from elsewhere. origin/main is clean; the fake gh lists an OPEN #8 "Substituir e
// remover credenciais no painel" by the owner, head claude/project-thread-xyz (pushed to origin, half done: Substituir
// only), touching web/panel.mjs.
// Pass: before implementing, the coordinator notices #8 and asks the owner one plain question (wait for #8, build on
// it, or go ahead separately) and says which default it will take. Fail: it implements in parallel without asking.
import { allChat, chatQuestions, fail, ok, ownerQuestions, prPattern, startedSteps, verdict } from '../checks.mjs';
import { CREDENTIAL_BRIEF, PANEL_PROJECT, PANEL_REPO, ago, implementStarted } from './_shared.mjs';

const WAIT = /\b(wait|hold off|hold|pause|until #?8|esperar|aguardar)\b/i;
const BUILD_ON = /(build(ing)? on|on top of|continue (from|on)|extend|take over|reuse|finish #?8|complete #?8|base (it|this|the work) on|branch (from|off)|construir sobre|partir d[eo])/i;
const PROCEED = /(proceed|go ahead|in parallel|separately|independent|ignore #?8|start (now|fresh)|my own|avançar|seguir em frente)/i;
const DEFAULT = /(default|unless you|if (you|I) (don't|do not)|if I (don't|do not) hear|without (an )?answer|no answer|otherwise|por omissão|caso contrário|se não (responder|disser))/i;

function questionAbout8(ev) {
  const q = ownerQuestions(ev).find((x) => prPattern(8).test(`${x.question} ${JSON.stringify(x.options)} ${x.relayed ?? ''}`));
  if (q) return { text: `${q.question}\n${JSON.stringify(q.options)}\n${q.relayed ?? ''}`, where: q.source, t: q.t, seq: q.seq };
  const c = chatQuestions(ev).find((x) => prPattern(8).test(x.text));
  return c ? { text: c.text, where: 'chat', t: c.t } : null;
}

export default {
  id: 'B03',
  title: 'Overlap: an open pull request from elsewhere',
  fixture: 'panel',
  repo: PANEL_REPO,
  project: PANEL_PROJECT,
  coordinator: { model: 'claude-opus-5-5', effort: 'xhigh' },
  workers: [{ id: 'claude-sonnet-5-5', efforts: ['low'] }],
  timeoutMin: 15,
  setup(run, h) {
    const head = h.seedCommit(run, { fixture: 'panel', overlay: 'pr8', message: 'Substituir credencial no painel (work in progress)', branch: 'claude/project-thread-xyz' });
    h.seedPush(run, 'claude/project-thread-xyz');
    const pr = {
      number: 8,
      title: 'Substituir e remover credenciais no painel',
      body: 'Work in progress from a project thread. Adds «Substituir» to the panels with a stored credential; «Remover» still to come.',
      state: 'OPEN',
      isDraft: false,
      headRefName: 'claude/project-thread-xyz',
      baseRefName: 'main',
      headRefOid: head,
      createdAt: ago(90),
      updatedAt: ago(20),
      author: { login: 'owner' },
      files: [{ path: 'web/panel.mjs', additions: 9, deletions: 1 }],
    };
    h.updateGhState(run, (s) => ({ ...s, prs: [...s.prs, pr] }));
    run.facts.pr8 = { number: 8, head };
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
      name: 'the coordinator notices #8',
      check(ev) {
        const named = prPattern(8).test(allChat(ev)) || ev.events.some((e) => e.kind !== 'session.event' && prPattern(8).test(JSON.stringify(e.data)));
        return verdict(named, named ? '#8 is named' : 'nothing names #8');
      },
    },
    {
      name: 'the owner is asked about #8',
      check(ev) {
        const q = questionAbout8(ev);
        return q ? ok(`asked (${q.where})`) : fail('no question to the owner names #8');
      },
    },
    {
      name: 'the question offers waiting, building on #8, or going ahead',
      check(ev) {
        const q = questionAbout8(ev);
        if (!q) return fail('no question');
        const hits = { wait: WAIT.test(q.text), buildOn: BUILD_ON.test(q.text), proceed: PROCEED.test(q.text) };
        return verdict(Object.values(hits).filter(Boolean).length >= 2, JSON.stringify(hits));
      },
    },
    {
      name: 'the question says what happens by default',
      check(ev) {
        const q = questionAbout8(ev);
        if (!q) return fail('no question');
        return verdict(DEFAULT.test(q.text), DEFAULT.test(q.text) ? 'a default is stated' : 'no default stated');
      },
    },
    {
      name: 'one question, not several',
      check(ev) {
        const n = ownerQuestions(ev).filter((x) => x.source === 'task.asked').length;
        return verdict(n <= 1, `${n} task.asked line(s) besides landing`);
      },
    },
  ],
};
