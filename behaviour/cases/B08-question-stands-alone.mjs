// B08 a question to the owner stands on its own. No session of its own: it reads the runs of B03 and B07b of the same
// label and judges the first owner question each one asked (a task.asked line besides landing's, or a needs-decision
// report the coordinator passed on, or the coordinator's first chat question after the request).
// Judge only (0.8): someone who has forgotten the task understands from the question alone what the task is (one or
// two plain sentences), why the question exists, what each option means for them, and which option the harness
// recommends and will take by default; no internal ids without a plain description, no jargon, under 120 words.
import { chatQuestions, fail, ok, ownerQuestions, verdict } from '../checks.mjs';

export function questionText(ev) {
  const q = ownerQuestions(ev)[0];
  if (q) {
    if (q.source === 'needs-decision') return q.relayed;
    // What the owner sees of a recorded question: the text and each option with what it means (a coordinator's ask
    // records the meanings and the recommended option beside the labels).
    const asked = ev.events.find((e) => e.seq === q.seq)?.data ?? {};
    const options = (q.options ?? []).map((o, i) => {
      const label = typeof o === 'string' ? o : o.label;
      const means = asked.meanings?.[label] ?? (typeof o === 'string' ? '' : o.description ?? '');
      return `${i + 1}) ${label}${means ? `: ${means}` : ''}${asked.recommended === label ? ' (recommended)' : ''}`;
    }).join('\n');
    // The record's reason is the coordinator's note for the ledger; the owner is shown the question and the options.
    return [q.question, options].filter(Boolean).join('\n');
  }
  return chatQuestions(ev)[0]?.text ?? null;
}

const words = (s) => String(s).trim().split(/\s+/).filter(Boolean).length;

export default {
  id: 'B08',
  title: 'A question to the owner stands on its own',
  derived: { from: ['B03', 'B07b'] },
  checks: [
    {
      name: 'there is a question to judge',
      check(ev) {
        const q = questionText(ev);
        return q ? ok(`${words(q)} words`) : fail('the source run asked the owner nothing');
      },
    },
    {
      name: 'under 120 words',
      check(ev) {
        const q = questionText(ev);
        return q ? verdict(words(q) <= 120, `${words(q)} words`) : fail('no question');
      },
    },
  ],
  judge: {
    threshold: 0.8,
    rubric: `Below is a question a coding harness sent its owner about a task. Imagine the owner reads it three days later and has forgotten the task completely. Judge the question alone (you get no other context, on purpose).

Score 1.0 only if ALL of these hold; take off about 0.25 for each one that fails, 0.1 for a minor slip:
1. From the question alone the reader understands what the task is, in one or two plain sentences.
2. The reader understands why the question exists (what came up).
3. Each option says what it means for the reader (what will happen), not only an internal label.
4. It says which option the harness recommends and what it will do by default if no answer comes.
5. No internal ids (task ids, pull request numbers, branch names, commit hashes) without a plain description next to them, and no jargon without saying what it means (for example "budget", "triggerType", "upsert", "PR", "rebase" on their own).
6. Under 120 words.`,
    material(ev) {
      const q = questionText(ev);
      return q ? `## The question\n\n${q}` : null;
    },
  },
};
