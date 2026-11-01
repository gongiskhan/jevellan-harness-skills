// The three hooks, run as the harness runs them: a child process with the hook input JSON on stdin and the worker
// variables in its environment. Every hook's wall time is measured and printed.
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { LEDGER_SKILL, NODE, TaskScript, addWorktree, childEnv, ledgerFile, ledgerText, makeRepo, readLedger, runHook, tempDir, writeJson } from './helpers/ledger-fixture.mjs';
import { oneLine } from '../skills/jevellan-ledger/scripts/lib/format.mjs';

const MISSING = 'End the step by writing .jevellan/report.json with status progress, done, blocked or needs-decision (see your duty skill).';
const COORDINATOR = "This project's work runs through the coordinator skill: use it for any request to do, plan, track or report on work here.";
const LIMIT_MS = 1000;

const timings = [];
function hook(t, name, input, options) {
  const r = runHook(name, input, options);
  timings.push({ name, test: t.name, ms: r.ms });
  t.diagnostic(`${name} hook: ${r.ms.toFixed(0)} ms`);
  assert.equal(r.status, 0, `${name} exited ${r.status}: ${r.stderr}`);
  assert.ok(r.ms < LIMIT_MS, `${name} took ${r.ms.toFixed(0)} ms`);
  return r;
}

// A worker's environment and its Stop input.
function worker(root, s, { step = 1, session = 'worker-session-1' } = {}) {
  return { env: { JH_TASK: s.task, JH_STEP: step, JH_DUTY: 'implement', JH_PROJECT: root, JH_SESSION: session }, session };
}
const stopInput = (cwd, session, promptId = 'prompt-1') => ({ session_id: session, cwd, prompt_id: promptId, hook_event_name: 'Stop', stop_hook_active: false, transcript_path: '/dev/null' });
const reportPath = (dir) => path.join(dir, '.jevellan', 'report.json');
const reports = (root) => readLedger(root).filter((e) => e.kind === 'step.report');

describe('stop hook', () => {
  test('a session without JH_TASK prints nothing and writes nothing', (t) => {
    const root = makeRepo();
    writeJson(reportPath(root), { status: 'done', summary: 'not a worker' });
    const r = hook(t, 'stop', stopInput(root, 'coord-1'), { cwd: root });
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(ledgerFile(root)), false);
    assert.equal(fs.existsSync(reportPath(root)), true);
  });

  test('a missing report blocks twice with the reason, then records blocked, synthesized', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1);
    const { env, session } = worker(root, s);
    for (let i = 0; i < 2; i += 1) {
      const r = hook(t, 'stop', stopInput(root, session), { cwd: root, env });
      assert.deepEqual(JSON.parse(r.stdout), { decision: 'block', reason: MISSING });
      assert.equal(reports(root).length, 0);
    }
    const third = hook(t, 'stop', stopInput(root, session), { cwd: root, env });
    assert.equal(third.stdout, '');
    const [report] = reports(root);
    assert.equal(report.task, s.task);
    assert.equal(report.step, 1);
    assert.equal(report.session, session);
    assert.deepEqual(report.data, { status: 'blocked', summary: 'No report was written.', synthesized: true });
    const ended = readLedger(root).filter((e) => e.kind === 'session.ended');
    assert.equal(ended.length, 1);
    assert.equal(ended[0].data.nativeSessionId, session);
    assert.match(fs.readFileSync(path.join(root, '.jevellan', 'hooks.log'), 'utf8'), /no report, blocked \(1\/2\)[\s\S]*\(2\/2\)[\s\S]*recorded blocked/);
  });

  test('an invalid report blocks once with the first problem, then records blocked with the problem in limitations', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    s.started(1);
    const { env, session } = worker(root, s);
    writeJson(reportPath(root), { status: 'needs-decision', summary: 'Which one?', question: 'Blue or Green?', options: [{ label: 'Blue' }] });
    const first = hook(t, 'stop', stopInput(root, session), { cwd: root, env });
    const out = JSON.parse(first.stdout);
    assert.equal(out.decision, 'block');
    assert.ok(out.reason.startsWith('report.json: options must have 2 to 4 items'), out.reason);
    assert.equal(out.reason, 'report.json: options must have 2 to 4 items. Fix .jevellan/report.json and end your turn again.');
    assert.equal(fs.existsSync(reportPath(root)), true, 'the report stays for the worker to fix');
    assert.equal(reports(root).length, 0);

    const second = hook(t, 'stop', stopInput(root, session), { cwd: root, env });
    assert.equal(second.stdout, '');
    const [report] = reports(root);
    assert.equal(report.data.status, 'blocked');
    assert.equal(report.data.synthesized, true);
    assert.equal(report.data.summary, 'The report was not valid.');
    assert.equal(report.data.limitations, 'report.json: options must have 2 to 4 items');
    assert.equal(path.dirname(report.data.reportFile), path.join(root, '.jevellan', 'reports'));
    assert.match(path.basename(report.data.reportFile), new RegExp(`^${s.task}-s1-\\d{8}T\\d{9}Z-invalid\\.json$`));
    assert.equal(fs.existsSync(report.data.reportFile), true, 'the invalid report is kept, archived');
    assert.equal(fs.existsSync(reportPath(root)), false);
  });

  test('a report that is not JSON blocks with the parse problem', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env, session } = worker(root, s);
    fs.mkdirSync(path.dirname(reportPath(root)), { recursive: true });
    fs.writeFileSync(reportPath(root), '{"status": "done",');
    const r = hook(t, 'stop', stopInput(root, session), { cwd: root, env });
    assert.match(JSON.parse(r.stdout).reason, /^report\.json: is not valid JSON \(/);
  });

  test('a valid report becomes step.report with reportFile, and the file moves to the project reports folder', (t) => {
    const root = makeRepo();
    const wt = addWorktree(root, 'valid-report');
    const s = new TaskScript(root);
    s.started(1);
    const { env, session } = worker(root, s);
    const body = {
      status: 'done',
      summary: 'Added a How to run section.',
      changedFiles: ['README.md'],
      testsRun: { command: 'npm test', passed: true, summary: '34 passed' },
      screenshots: [{ path: '.jevellan/evidence/readme.png', caption: 'The new section' }],
      limitations: ['none known'],
    };
    writeJson(reportPath(wt), body);
    const r = hook(t, 'stop', stopInput(wt, session), { cwd: wt, env });
    assert.equal(r.stdout, '');
    const [report] = reports(root);
    assert.equal(report.task, s.task);
    assert.equal(report.step, 1);
    assert.equal(report.session, session);
    const { reportFile, ...data } = report.data;
    assert.deepEqual(data, { ...body, limitations: 'none known' });
    assert.equal(path.dirname(reportFile), path.join(root, '.jevellan', 'reports'));
    assert.match(path.basename(reportFile), new RegExp(`^${s.task}-s1-\\d{8}T\\d{9}Z\\.json$`));
    assert.deepEqual(JSON.parse(fs.readFileSync(reportFile, 'utf8')), body);
    assert.equal(fs.existsSync(reportPath(wt)), false, 'the report is gone from the worktree');
    assert.equal(readLedger(root).at(-1).kind, 'session.ended');
  });

  test('a summary over 4000 characters is cut to 4000', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env, session } = worker(root, s);
    writeJson(reportPath(root), { status: 'progress', summary: 'word '.repeat(1200) });
    hook(t, 'stop', stopInput(root, session), { cwd: root, env });
    const [report] = reports(root);
    assert.equal(report.data.summary.length, 4000);
    assert.equal(JSON.parse(fs.readFileSync(report.data.reportFile, 'utf8')).summary.length, 6000);
  });

  test('in a worktree, without JH_PROJECT, the hook writes to the main checkout\'s ledger', (t) => {
    const root = makeRepo();
    const wt = addWorktree(root, 'linked');
    const s = new TaskScript(root);
    s.started(1, { cwd: wt });
    const { env, session } = worker(root, s);
    delete env.JH_PROJECT;
    const sub = path.join(wt, 'src');
    fs.mkdirSync(sub);
    const block = hook(t, 'stop', stopInput(sub, session, 'p-wt'), { cwd: sub, env });
    assert.equal(JSON.parse(block.stdout).reason, MISSING);
    assert.equal(fs.existsSync(path.join(root, '.jevellan', 'locks', `stop-${session}.count`)), true);
    writeJson(reportPath(wt), { status: 'done', summary: 'From the worktree.' });
    const r = hook(t, 'stop', stopInput(wt, session, 'p-wt'), { cwd: wt, env });
    assert.equal(r.stdout, '');
    const [report] = reports(root);
    assert.equal(report.data.summary, 'From the worktree.');
    assert.equal(path.dirname(report.data.reportFile), path.join(root, '.jevellan', 'reports'));
    assert.equal(fs.existsSync(path.join(wt, '.jevellan', 'ledger.jsonl')), false);
    assert.equal(fs.existsSync(path.join(wt, '.jevellan', 'reports')), false);
    assert.equal(fs.existsSync(reportPath(wt)), false);
  });

  test('a report in the worktree root is found when the session stops in a subfolder', (t) => {
    const root = makeRepo();
    const wt = addWorktree(root, 'subfolder');
    const s = new TaskScript(root);
    const { env, session } = worker(root, s);
    const sub = path.join(wt, 'docs');
    fs.mkdirSync(sub);
    writeJson(reportPath(wt), { status: 'done', summary: 'Found from a subfolder.' });
    const r = hook(t, 'stop', stopInput(sub, session), { cwd: sub, env });
    assert.equal(r.stdout, '');
    assert.equal(reports(root)[0].data.summary, 'Found from a subfolder.');
  });

  test('a session_id other than JH_SESSION is ignored', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env } = worker(root, s, { session: 'the-worker' });
    writeJson(reportPath(root), { status: 'done', summary: 'from a nested session' });
    const before = ledgerText(root);
    for (let i = 0; i < 3; i += 1) {
      const r = hook(t, 'stop', stopInput(root, 'a-nested-session'), { cwd: root, env });
      assert.equal(r.stdout, '');
    }
    assert.equal(ledgerText(root), before);
    assert.equal(fs.existsSync(reportPath(root)), true);
  });

  test('a new prompt_id starts the block counts again', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env, session } = worker(root, s);
    for (const prompt of ['p1', 'p1', 'p2', 'p2']) {
      const r = hook(t, 'stop', stopInput(root, session, prompt), { cwd: root, env });
      assert.equal(JSON.parse(r.stdout).reason, MISSING, prompt);
    }
    assert.equal(reports(root).length, 0);
    const recorded = hook(t, 'stop', stopInput(root, session, 'p2'), { cwd: root, env });
    assert.equal(recorded.stdout, '');
    assert.equal(reports(root).length, 1);
  });

  test('after a recorded report the counts start again for the next turn', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env, session } = worker(root, s);
    writeJson(reportPath(root), { status: 'progress', summary: 'half way' });
    assert.equal(hook(t, 'stop', stopInput(root, session), { cwd: root, env }).stdout, '');
    const r = hook(t, 'stop', stopInput(root, session), { cwd: root, env });
    assert.equal(JSON.parse(r.stdout).reason, MISSING);
  });

  test('JH_STEP that is not a step number writes nothing and logs it', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env, session } = worker(root, s);
    env.JH_STEP = 'two';
    const before = ledgerText(root);
    const r = hook(t, 'stop', stopInput(root, session), { cwd: root, env });
    assert.equal(r.stdout, '');
    assert.equal(ledgerText(root), before);
    assert.match(fs.readFileSync(path.join(root, '.jevellan', 'hooks.log'), 'utf8'), /JH_STEP is not a step number: two/);
  });

  test('an internal error exits 0, prints nothing and is logged', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env, session } = worker(root, s);
    // The counter folder cannot be made: .jevellan/locks/stop-<session>.count sits under a file.
    const locks = path.join(root, '.jevellan', 'locks');
    fs.renameSync(locks, `${locks}.moved`);
    fs.writeFileSync(locks, 'not a folder');
    const r = hook(t, 'stop', stopInput(root, session), { cwd: root, env });
    assert.equal(r.stdout, '');
    assert.match(fs.readFileSync(path.join(root, '.jevellan', 'hooks.log'), 'utf8'), /stop error:/);
  });

  test('stdin that is not JSON does not break the hook', (t) => {
    const root = makeRepo();
    const r = hook(t, 'stop', 'this is not json', { cwd: root });
    assert.equal(r.stdout, '');
  });
});

describe('post-tool hook', () => {
  const postInput = (cwd, tool, toolInput, extra = {}) => ({ session_id: 'worker-session-1', cwd, hook_event_name: 'PostToolUse', tool_name: tool, tool_input: toolInput, ...extra });

  test('Bash: the summary is the command\'s first 200 characters, never the output', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env } = worker(root, s, { step: 2 });
    const command = `echo ${'a'.repeat(150)} && echo ${'b'.repeat(150)}`;
    hook(t, 'post-tool', postInput(root, 'Bash', { command, description: 'echo' }, { tool_response: { stdout: 'OUTPUT-MARKER-1234', stderr: '' } }), { cwd: root, env });
    const event = readLedger(root).at(-1);
    assert.equal(event.kind, 'session.event');
    assert.equal(event.task, s.task);
    assert.equal(event.step, 2);
    assert.equal(event.session, 'worker-session-1');
    assert.deepEqual(event.data, { tool: 'Bash', summary: command.slice(0, 200) });
    assert.equal(event.data.summary.length, 200);
    assert.equal(ledgerText(root).includes('OUTPUT-MARKER-1234'), false);
  });

  test('Edit, Write, MultiEdit and NotebookEdit record the file path and never the content', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env } = worker(root, s);
    const file = path.join(root, 'README.md');
    const marker = 'CONTENT-MARKER-5678';
    const calls = [
      ['Edit', { file_path: file, old_string: `old ${marker}`, new_string: `new ${marker}` }],
      ['Write', { file_path: file, content: `whole file ${marker}` }],
      ['MultiEdit', { file_path: file, edits: [{ old_string: marker, new_string: marker }] }],
      ['NotebookEdit', { notebook_path: path.join(root, 'n.ipynb'), new_source: marker, cell_id: 'c1' }],
    ];
    for (const [tool, input] of calls) hook(t, 'post-tool', postInput(root, tool, input, { tool_response: { content: marker } }), { cwd: root, env });
    const events = readLedger(root).filter((e) => e.kind === 'session.event');
    assert.deepEqual(events.map((e) => e.data), [
      { tool: 'Edit', summary: file },
      { tool: 'Write', summary: file },
      { tool: 'MultiEdit', summary: file },
      { tool: 'NotebookEdit', summary: path.join(root, 'n.ipynb') },
    ]);
    assert.equal(ledgerText(root).includes(marker), false);
  });

  test('without JH_TASK and without a .jevellan folder nothing is written', (t) => {
    const root = makeRepo({ installed: false });
    const r = hook(t, 'post-tool', postInput(root, 'Bash', { command: 'ls' }), { cwd: root });
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(path.join(root, '.jevellan')), false);
  });

  test('without JH_TASK in an installed project the line has no task and no step', (t) => {
    const root = makeRepo();
    hook(t, 'post-tool', postInput(root, 'Bash', { command: 'git log --oneline' }), { cwd: root, env: { JH_STEP: 3 } });
    const [event] = readLedger(root);
    assert.equal(event.kind, 'session.event');
    assert.equal('task' in event, false);
    assert.equal('step' in event, false);
    assert.deepEqual(event.data, { tool: 'Bash', summary: 'git log --oneline' });
  });

  test('a worker in a worktree records to the main checkout', (t) => {
    const root = makeRepo();
    const wt = addWorktree(root, 'post-tool');
    const s = new TaskScript(root);
    const { env } = worker(root, s);
    delete env.JH_PROJECT;
    hook(t, 'post-tool', postInput(wt, 'Write', { file_path: path.join(wt, 'a.txt'), content: 'x' }), { cwd: wt, env });
    assert.equal(readLedger(root).at(-1).data.summary, path.join(wt, 'a.txt'));
    assert.equal(fs.existsSync(path.join(wt, '.jevellan')), false);
  });

  test('a secret in a command is masked', (t) => {
    const root = makeRepo();
    const name = ['DEPLOY', 'TOKEN'].join('_');
    hook(t, 'post-tool', postInput(root, 'Bash', { command: `${name}=abcdef123456 ./run.sh` }), { cwd: root });
    assert.equal(readLedger(root)[0].data.summary, `${name}:[redacted] ./run.sh`);
  });

  test('outside a git repository nothing happens', (t) => {
    const dir = tempDir('jh-nogit-');
    const r = hook(t, 'post-tool', postInput(dir, 'Bash', { command: 'ls' }), { cwd: dir, env: { JH_TASK: 'T000000', JH_STEP: 1 } });
    assert.equal(r.stdout, '');
    assert.deepEqual(fs.readdirSync(dir), []);
  });
});

describe('session-start hook', () => {
  const startInput = (cwd, source = 'startup', session = 'coord-session-1') => ({ session_id: session, cwd, hook_event_name: 'SessionStart', source, model: 'test-model' });

  test('a worker gets "Ledger for task <T>, step <N>:" and its task\'s last 20 events', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root);
    const other = new TaskScript(root);
    s.worktree();
    s.workflow([{ ordinal: 1, duty: 'implement' }, { ordinal: 2, duty: 'verify' }]);
    s.stepDone(1);
    for (let i = 0; i < 20; i += 1) {
      s.sessionEvent(2, 'Bash', `command ${i}`);
      other.note(`other ${i}`);
    }
    s.started(2, { duty: 'verify' });
    const { env } = worker(root, s, { step: 2 });
    const r = hook(t, 'session-start', startInput(root, 'startup', 'worker-session-1'), { cwd: root, env });
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], `Ledger for task ${s.task}, step 2:`);
    assert.equal(lines.length, 21);
    const mine = readLedger(root).filter((e) => e.task === s.task);
    assert.ok(mine.length > 20);
    assert.deepEqual(lines.slice(1), mine.slice(-20).map(oneLine));
    assert.ok(lines.slice(1).every((line) => !line.includes(other.task)));
    assert.equal(lines.at(-1).includes('step.started'), true);
  });

  test('a worker whose task is not in the ledger gets nothing', (t) => {
    const root = makeRepo();
    new TaskScript(root);
    const r = hook(t, 'session-start', startInput(root), { cwd: root, env: { JH_TASK: 'T000000', JH_STEP: 1, JH_PROJECT: root } });
    assert.equal(r.stdout, '');
  });

  test('a coordinator session in an installed project gets the coordinator line and the open work', (t) => {
    const root = makeRepo();
    const waiting = new TaskScript(root, { kind: 'single', duty: 'investigate', title: 'Pick a colour' });
    waiting.started(1);
    waiting.report(1, { status: 'needs-decision', question: 'Blue or Green?', options: [{ label: 'Blue' }, { label: 'Green' }] });
    const queued = new TaskScript(root, { kind: 'bug', title: 'Fix the footer' });
    const r = hook(t, 'session-start', startInput(root), { cwd: root });
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines[0], COORDINATOR);
    assert.equal(lines[1], "Open work in this project's ledger:");
    assert.equal(lines.length, 4);
    assert.match(lines[2], new RegExp(`^${waiting.task} waiting-owner: Pick a colour .*Blue or Green\\? 1\\) Blue  2\\) Green`));
    assert.match(lines[3], new RegExp(`^${queued.task} queued: Fix the footer \\(next: make the worktree\\)`));
    const started = readLedger(root).at(-1);
    assert.equal(started.kind, 'session.started');
    assert.equal(started.session, 'coord-session-1');
    assert.deepEqual(started.data, { role: 'coordinator', nativeSessionId: 'coord-session-1', model: 'test-model', source: 'startup' });
  });

  test('a coordinator with nothing open is told so; a compacted session is not recorded as a new start', (t) => {
    const root = makeRepo();
    const s = new TaskScript(root, { kind: 'single', duty: 'answer' });
    s.started(1);
    s.report(1, { status: 'done' });
    const before = readLedger(root).length;
    const r = hook(t, 'session-start', startInput(root, 'compact'), { cwd: root });
    assert.equal(r.stdout, `${COORDINATOR}\nOpen work in this project's ledger: none.\n`);
    assert.equal(readLedger(root).length, before);
    hook(t, 'session-start', startInput(root, 'resume'), { cwd: root });
    assert.equal(readLedger(root).at(-1).data.source, 'resume');
  });

  test('an installed project without a ledger gets the coordinator line only', (t) => {
    const root = makeRepo();
    const r = hook(t, 'session-start', { cwd: root, source: 'startup' }, { cwd: root });
    assert.equal(r.stdout, `${COORDINATOR}\n`);
    assert.equal(fs.existsSync(ledgerFile(root)), false);
  });

  test('more than five open tasks are summarized in five lines', (t) => {
    const root = makeRepo();
    for (let i = 0; i < 7; i += 1) new TaskScript(root, { kind: 'bug', title: `Bug ${i}` });
    const r = hook(t, 'session-start', startInput(root), { cwd: root });
    const lines = r.stdout.trimEnd().split('\n');
    assert.equal(lines.length, 7);
    assert.equal(lines.at(-1), 'and 3 more (ledger.mjs status)');
  });

  test('a project without .jevellan gets nothing', (t) => {
    const root = makeRepo({ installed: false });
    const r = hook(t, 'session-start', startInput(root), { cwd: root });
    assert.equal(r.stdout, '');
    assert.equal(fs.existsSync(path.join(root, '.jevellan')), false);
    const dir = tempDir('jh-nogit-');
    assert.equal(hook(t, 'session-start', startInput(dir), { cwd: dir }).stdout, '');
  });

  test('a coordinator started in a worktree reads the main checkout\'s ledger', (t) => {
    const root = makeRepo();
    const wt = addWorktree(root, 'session-start');
    const s = new TaskScript(root, { kind: 'bug', title: 'Seen from the worktree' });
    const r = hook(t, 'session-start', startInput(wt), { cwd: wt });
    assert.match(r.stdout, new RegExp(`${s.task} queued: Seen from the worktree`));
  });
});

describe('installed under a path with a space', () => {
  // The hooks and the command line run only when they are the process's entry point; the check must decode the
  // module URL, or nothing runs from a folder whose name has a space.
  test('the hooks and ledger.mjs still run', (t) => {
    const skill = path.join(tempDir('jh space-'), 'my skills', 'jevellan-ledger');
    fs.cpSync(LEDGER_SKILL, skill, { recursive: true });
    const root = makeRepo();
    const s = new TaskScript(root);
    const { env, session } = worker(root, s);
    const run = (file, input) => spawnSync(NODE, [path.join(skill, file)], { cwd: root, env: childEnv(env), input, encoding: 'utf8' });
    const stop = run('hooks/stop.mjs', JSON.stringify(stopInput(root, session)));
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(JSON.parse(stop.stdout).reason, MISSING);
    const post = run('hooks/post-tool.mjs', JSON.stringify({ session_id: session, cwd: root, tool_name: 'Bash', tool_input: { command: 'ls' } }));
    assert.equal(post.status, 0, post.stderr);
    assert.equal(readLedger(root).at(-1).kind, 'session.event');
    const start = run('hooks/session-start.mjs', JSON.stringify({ session_id: session, cwd: root, source: 'startup' }));
    assert.match(start.stdout, new RegExp(`^Ledger for task ${s.task}, step 1:`));
    const cli = spawnSync(NODE, [path.join(skill, 'scripts', 'ledger.mjs'), 'verify'], { cwd: root, env: childEnv(), encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /^ok: \d+ lines, seq contiguous/);
  });
});

test('hook wall times', (t) => {
  const by = {};
  for (const { name, ms } of timings) (by[name] ??= []).push(ms);
  assert.deepEqual(Object.keys(by).sort(), ['post-tool', 'session-start', 'stop']);
  for (const [name, list] of Object.entries(by)) {
    const sorted = [...list].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    t.diagnostic(`${name} hook wall time over ${list.length} runs: median ${median.toFixed(0)} ms, max ${sorted.at(-1).toFixed(0)} ms`);
  }
});
