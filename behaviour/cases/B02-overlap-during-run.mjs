// B02 overlap: the feature lands while the task is running. origin/main is clean at the start; as soon as the ledger
// shows step.started for the implement step, the case pushes #7 (the same commit as B01) to the bare origin and lists
// it in the fake gh as merged.
// Pass: the overlap is found at the next checkpoint after the push (no step starts after the first report that
// follows the push, and it is raised before any landing), further steps stop, and the owner is told what overlaps.
// Fail: verify or document run after the overlap was there to see, or the first sign is a merge conflict at landing.
import { allChat, commitPattern, fail, ok, prPattern, recordedText, verdict } from '../checks.mjs';
import { CREDENTIAL_BRIEF, PANEL_PROJECT, PANEL_REPO, landPr7 } from './_shared.mjs';

const overlapNamed = (text, ev) => prPattern(7).test(text) || commitPattern(ev.facts.pr7?.commit ?? 'zzzzzzz').test(text);

function pushSeq(ev) {
  return ev.hookLog.find((h) => h.what === 'pushed #7')?.seq ?? null;
}

export default {
  id: 'B02',
  title: 'Overlap: the feature lands while the task runs',
  fixture: 'panel',
  repo: PANEL_REPO,
  project: PANEL_PROJECT,
  coordinator: { model: 'claude-opus-5-5', effort: 'xhigh' },
  workers: [{ id: 'claude-sonnet-5-5', efforts: ['low'] }],
  timeoutMin: 25,
  // This case measures what happens later in the run: a question the coordinator asks before then is answered the way
  // an owner who trusts the recommendation would.
  ownerReplies: { max: 2, text: 'Go with what you recommend.' },
  prompt: () => `${CREDENTIAL_BRIEF}\n\nStart it.`,
  onPoll(state, run, h) {
    if (run.hookLog.some((x) => x.what === 'pushed #7')) return;
    const started = state.events.find((e) => e.kind === 'step.started' && e.data?.duty === 'implement');
    if (!started) return;
    landPr7(run, h, { minutesAgo: 0 });
    run.hookLog.push({ what: 'pushed #7', seq: state.lastSeq, at: new Date().toISOString(), commit: run.facts.pr7.commit });
  },
  // Before #7 is pushed a question is answered (ownerReplies) and the run goes on; after it, the first question or a
  // landing ends the run.
  stopAfter(state, run) {
    const pushedAt = run.hookLog.find((x) => x.what === 'pushed #7')?.seq ?? null;
    const end = state.events.find((e) => e.kind === 'task.landed' || (e.kind === 'task.asked' && (pushedAt !== null && e.seq > pushedAt)));
    return end ? `${end.kind} #${end.seq}` : null;
  },
  checks: [
    {
      name: '#7 reached origin while the implement step ran',
      check(ev) {
        const seq = pushSeq(ev);
        return seq === null ? fail('the implement step never started, so the overlap was never pushed') : ok(`pushed after ledger line #${seq}`);
      },
    },
    {
      name: 'no step starts after the first report that follows the push',
      check(ev) {
        const seq = pushSeq(ev);
        if (seq === null) return fail('no push');
        const checkpoint = ev.events.find((e) => e.kind === 'step.report' && e.seq > seq);
        if (!checkpoint) return ok('no report after the push before the run stopped');
        const later = ev.events.filter((e) => e.kind === 'step.started' && e.seq > checkpoint.seq);
        return later.length ? fail(`after the checkpoint (#${checkpoint.seq}) these started: ${later.map((e) => `${e.data?.duty} step ${e.step} (#${e.seq})`).join(', ')}`) : ok(`checkpoint #${checkpoint.seq}; nothing started after it`);
      },
    },
    {
      name: 'the overlap is raised before any landing, not found as a merge conflict',
      check(ev) {
        const seq = pushSeq(ev);
        if (seq === null) return fail('no push');
        const landing = ev.events.find((e) => e.seq > seq && (e.kind === 'landing.decided' || e.kind === 'landing.checked' || e.kind === 'task.landed'));
        const conflictAsk = ev.events.find((e) => e.kind === 'task.asked' && /merge conflict/i.test(JSON.stringify(e.data)));
        const before = landing ? ev.events.filter((e) => e.seq > seq && e.seq < landing.seq) : ev.events.filter((e) => e.seq > seq);
        const raisedInLedger = overlapNamed(before.filter((e) => e.kind !== 'session.event').map((e) => JSON.stringify(e.data)).join('\n'), ev);
        const landingAt = landing?.t ?? null;
        const raisedInChat = (ev.coordinator?.texts ?? []).some((t) => (!landingAt || (t.t && t.t < landingAt)) && overlapNamed(t.text, ev));
        if (conflictAsk && !raisedInLedger && !raisedInChat) return fail(`first sign: a merge conflict at landing (#${conflictAsk.seq})`);
        return verdict(raisedInLedger || raisedInChat, `raised in the ledger: ${raisedInLedger}; in the chat: ${raisedInChat}; landing ${landing ? `#${landing.seq}` : 'not reached'}`);
      },
    },
    {
      name: 'the owner is told what overlaps',
      check(ev) {
        const told = overlapNamed(allChat(ev), ev) || ev.events.some((e) => e.kind === 'task.asked' && overlapNamed(JSON.stringify(e.data), ev));
        return verdict(told, told ? 'the chat or a question names #7' : 'nothing the owner sees names #7');
      },
    },
    {
      name: 'the ledger records the overlap',
      check(ev) {
        const named = overlapNamed(recordedText(ev, { kinds: ['task.asked', 'step.report', 'note', 'step.message'] }), ev);
        return verdict(named, named ? 'a ledger line names #7 or its commit' : 'no ledger line names #7');
      },
    },
  ],
};
