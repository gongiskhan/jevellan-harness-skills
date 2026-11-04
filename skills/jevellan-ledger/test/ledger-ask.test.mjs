// The coordinator's own questions to the owner (0.4.0): `ask` records a task.asked line with source "coordinator"
// after checking its shape (two to four options that say what they mean, a recommended option, at most 120 words),
// one open question per task, `answer` records the owner's reply against it, and the projection shows the task as
// waiting on the owner until the answer (or a later step or landing line).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { TaskScript, cli, makeRepo, readLedger } from './helpers.mjs';

const question = {
  question: 'You asked for a Substituir button on the integrations page. The owner\'s own open pull request "Substituir e remover credenciais" already adds it. What should I do? If you do not choose, I will Build on it.',
  options: [
    { label: 'Wait', means: 'nothing is built until that pull request is merged or closed' },
    { label: 'Build on it', means: 'I continue from that pull request and add only what is missing' },
    { label: 'Go ahead', means: 'I build it separately; the two may conflict' },
  ],
  recommended: 'Build on it',
  reason: 'overlap with an open pull request',
};

const ask = (root, task, data) => cli(root, ['ask', '--task', task, '--data', JSON.stringify(data), '--json']);
const show = (root, task) => cli(root, ['show', task, '--json']).json();

describe('codeTerms', () => {
  test('finds code and internal names, not links or plain words', async () => {
    const { codeTerms } = await import('../scripts/ledger.mjs');
    assert.deepEqual(codeTerms('the 2,400-byte limit, an e-mail, the owner\'s pull request https://github.com/acme/x/pull/8'), []);
    assert.deepEqual(codeTerms('commit 8e3aae1 and abc'), ['8e3aae1']);
    assert.deepEqual(codeTerms('DELETE /configs/:key in server.mjs'), ['DELETE /configs/:key']);
  });
});

describe('ask', () => {
  test('records a coordinator question and the task waits on the owner', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const r = ask(root, s.task, question);
    assert.equal(r.status, 0, r.stderr);
    const line = r.json();
    assert.equal(line.kind, 'task.asked');
    assert.equal(line.data.source, 'coordinator');
    assert.deepEqual(line.data.options, ['Wait', 'Build on it', 'Go ahead']);
    assert.equal(line.data.meanings['Go ahead'], 'I build it separately; the two may conflict');
    assert.equal(line.data.recommended, 'Build on it');
    const task = show(root, s.task);
    assert.equal(task.state, 'waiting-owner');
    assert.equal(task.waiting.source, 'coordinator');
    assert.equal(task.waiting.recommended, 'Build on it');
    const status = cli(root, ['status']);
    assert.match(status.stdout, /Question: You asked for a Substituir button/);
    assert.match(line.data.question, /If you do not choose, I will Build on it\./);
    assert.match(status.stdout, /2\) Build on it: I continue from that pull request and add only what is missing \(recommended\)/);
  });

  test('refuses a question that does not stand on its own', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const cases = [
      [{ ...question, options: question.options.slice(0, 1) }, /options must have 2 to 4 items/],
      [{ ...question, options: [{ label: 'a' }, { label: 'b', means: 'x' }] }, /options\[0\]\.means must say what the option means/],
      [{ ...question, recommended: 'Something else' }, /recommended must be one of the options' labels/],
      [{ ...question, question: `${'word '.repeat(110)}Build on it` }, /words; keep them under 120/],
      [{ ...question, extra: 1 }, /unknown field "extra"/],
      [{ ...question, question: '' }, /question is required/],
      [{ ...question, question: 'What should I do?' }, /must say, in its own words, that "Build on it" is what happens/],
      [{ ...question, question: `${question.question} It changes \`tasks_list\`.` }, /uses code or internal names \(`tasks_list`, tasks_list\)/],
      [{ ...question, options: [{ label: 'Wait', means: 'until POST /configs/:key is merged' }, ...question.options.slice(1)] }, /uses code or internal names \(POST \/configs\/:key\)/],
      [{ ...question, question: `${question.question} See web/panel.mjs and triggerType.` }, /web\/panel\.mjs, triggerType/],
    ];
    for (const [data, message] of cases) {
      const r = ask(root, s.task, data);
      assert.equal(r.status, 2, JSON.stringify(data).slice(0, 80));
      assert.match(r.stderr, message);
    }
    assert.equal(readLedger(root).filter((e) => e.kind === 'task.asked').length, 0);
  });

  test('one open question per task; answer closes it and names the option', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const first = ask(root, s.task, question).json();
    const again = ask(root, s.task, question);
    assert.equal(again.status, 2);
    assert.match(again.stderr, new RegExp(`already has an open question \\(#${first.seq}`));
    const wrong = cli(root, ['answer', '--task', s.task, '--text', 'build on it', '--option', 'Nope', '--json']);
    assert.equal(wrong.status, 2);
    assert.match(wrong.stderr, /--option must be one of Wait, Build on it, Go ahead/);
    const answered = cli(root, ['answer', '--task', s.task, '--text', 'build on it please', '--option', 'Build on it', '--json']);
    assert.equal(answered.status, 0, answered.stderr);
    assert.deepEqual({ ...answered.json().data }, { text: `The owner answered #${first.seq}: build on it please`, answerTo: first.seq, option: 'Build on it', answer: 'build on it please' });
    assert.notEqual(show(root, s.task).state, 'waiting-owner');
    assert.equal(ask(root, s.task, question).status, 0, 'a new question once the last one is answered');
    const other = new TaskScript(root);
    const none = cli(root, ['answer', '--task', other.task, '--text', 'x']);
    assert.equal(none.status, 2);
    assert.match(none.stderr, /has no open question from the coordinator/);
  });

  test('a later step line ends the wait without an answer', () => {
    const root = makeRepo();
    const s = new TaskScript(root);
    ask(root, s.task, question);
    s.workflow([{ ordinal: 1, duty: 'plan' }]);
    s.placed(1, { duty: 'plan' });
    s.started(1, { duty: 'plan', pid: process.pid });
    assert.equal(show(root, s.task).state, 'running');
  });
});
