// The Codex runtime's own parts, alone: the codex command lines and first message, the worker environment, the
// shared helpers this skill carries its own copy of, and the runner's ledger calls (a fake ledger here).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CODEX, ROLE_MISSING, TaskLines, deadPid, infoFrom, makeProject, makeSkillsRoot, sleeper, waitFor, alive, writeProviders } from './helpers/fakes.mjs';
import { INSTRUCTIONS_LINE, codexHome, codexResumeArgs, codexStartArgs, firstMessage, workerEnv } from '../scripts/lib/env.mjs';
import { DUTIES, START_PROMPT } from '../scripts/lib/prompt.mjs';
import { findProvider, ownerHome } from '../scripts/lib/common.mjs';
import { groupAlive, signalGroup, stopGroup, waitForExit } from '../scripts/lib/proc.mjs';
import * as task from '../scripts/lib/task.mjs';
import { endedText, takeReportArgs, waitForStart } from '../scripts/lib/runner.mjs';

const { withoutInterface } = task;

const cleanup = [];
let providers;
before(() => {
  providers = writeProviders();
});
after(() => {
  for (const stop of cleanup) stop();
});

describe('codex command lines', () => {
  test('a first turn reads its message on stdin in the worktree; a resume continues the thread', () => {
    assert.deepEqual(codexStartArgs({ cwd: '/wt', model: 'gpt-6-astra', effort: 'medium' }), ['exec', '--json', '-C', '/wt', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=medium', '--dangerously-bypass-approvals-and-sandbox', '-']);
    assert.deepEqual(codexResumeArgs({ threadId: 'thread-1', model: 'gpt-6-astra', effort: 'high' }), ['exec', 'resume', '--json', '-m', 'gpt-6-astra', '-c', 'model_reasoning_effort=high', '--dangerously-bypass-approvals-and-sandbox', 'thread-1', '-']);
    assert.equal(firstMessage('  the append \n', START_PROMPT), `${INSTRUCTIONS_LINE}\n\nthe append\n\n${START_PROMPT}`);
  });

  test('how a turn ended, as the ledger is told it', () => {
    assert.equal(endedText({ exitCode: 0, signal: null }), 'codex exec ended with exit 0');
    assert.equal(endedText({ exitCode: null, signal: 'SIGTERM' }), 'codex exec ended with signal SIGTERM');
    assert.equal(endedText({ exitCode: null, signal: null, error: Object.assign(new Error('spawn codex ENOENT'), { code: 'ENOENT' }) }), 'codex exec did not run (ENOENT)');
  });
});

describe('worker environment', () => {
  const ids = { task: 'T0FAKE1', step: 1, duty: 'investigate', project: '/p', session: 'sess-1', cwd: '/p-wt' };

  test('CODEX_HOME is the provider\'s login folder; no key, token or other variable reaches the worker', () => {
    const env = workerEnv({ provider: findProvider('codex-test'), ...ids, base: { PATH: '/usr/bin', HOME: '/home/someone', OPENAI_API_KEY: 'x', OTHER: 'y' } });
    assert.equal(env.CODEX_HOME, providers.codexHome);
    assert.equal(env.OPENAI_API_KEY, undefined);
    assert.equal(env.OTHER, undefined);
    assert.deepEqual([env.JH_TASK, env.JH_STEP, env.JH_DUTY, env.JH_PROJECT, env.JH_SESSION, env.JH_CWD], ['T0FAKE1', '1', 'investigate', '/p', 'sess-1', '/p-wt']);
    assert.equal(codexHome({}), path.join(ownerHome(), '.codex'));
  });

  test('a provider without a login, of another kind, or disabled is refused with exit 2', () => {
    assert.throws(() => workerEnv({ provider: findProvider('codex-nologin'), ...ids }), (error) => /no Codex login in .*; the owner runs "codex login" once/.test(error.message) && error.exitCode === 2);
    assert.throws(() => workerEnv({ provider: findProvider('claude-test'), ...ids }), /is claude-subscription, not a Codex provider/);
    assert.throws(() => workerEnv({ provider: { name: 'off', kind: 'codex-subscription', enabled: false }, ...ids }), /disabled/);
  });
});

describe('shared helpers (this skill\'s copies)', () => {
  test('the duties, the Interface section of a skill body, the process groups', () => {
    assert.equal(DUTIES.length, 8);
    assert.equal(withoutInterface('# Duty\n\nDo it.\n\n## Interface\n\nNo scripts.\n'), '# Duty\n\nDo it.');
    for (const pid of [0, 1, -5, 2.5, undefined]) {
      assert.equal(groupAlive(pid), false);
      assert.equal(signalGroup(pid, 0), false);
    }
    const s = sleeper();
    cleanup.push(s.stop);
    assert.ok(waitFor(() => groupAlive(s.pid), 3000));
    assert.equal(stopGroup(s.pid, 5000), 'SIGTERM');
    assert.ok(waitForExit(s.pid, 3000));
  });
});

describe('the runner and the task helpers', () => {
  let skills;
  let project;
  let wt;

  before(() => {
    skills = makeSkillsRoot({ ledger: false });
    ({ project, wt } = makeProject());
  });

  test('waitForStart polls until the start is recorded, and gives up after its wait', async () => {
    let n = 0;
    assert.equal(await waitForStart({}, { ms: 2000, pollMs: 20, recorded: () => (n += 1) >= 3 }), true);
    assert.equal(n, 3);
    const t0 = Date.now();
    assert.equal(await waitForStart({}, { ms: 150, pollMs: 20, recorded: () => false }), false);
    assert.ok(Date.now() - t0 >= 150);
  });

  test('take-report is told the turn\'s folder, its thread when known and how it ended', () => {
    assert.deepEqual(takeReportArgs({ task: 'T0FAKE1', step: 2, session: 'sess-r', cwd: wt, threadId: 'thread-9', exitCode: 0, signal: null }), ['take-report', '--task', 'T0FAKE1', '--step', '2', '--session', 'sess-r', '--cwd', wt, '--native-session', 'thread-9', '--ended', 'codex exec ended with exit 0']);
    assert.deepEqual(takeReportArgs({ task: 'T0FAKE1', step: 2, session: 'sess-r', cwd: wt, threadId: null, exitCode: null, signal: 'SIGKILL' }), ['take-report', '--task', 'T0FAKE1', '--step', '2', '--session', 'sess-r', '--cwd', wt, '--ended', 'codex exec ended with signal SIGKILL']);
  });

  test('the duty\'s body goes inline for Codex, found by role, without its Interface section', () => {
    const lines = new TaskLines();
    lines.worktree(wt);
    lines.placed(1, CODEX);
    lines.started(1, 's1', { pid: deadPid() });
    const info = infoFrom(lines.show());
    const text = task.buildAppend(project, info, 1, 'investigate', wt, 'BLOCK', { inlineDuty: true, skillsRoot: skills.root });
    assert.match(text, /Your step is duty investigate\. The duty's instructions follow here:\n\n# Fake duty investigate\n\nFAKE-DUTY-BODY of investigate: cost \$1 and keep \$& as it is\./);
    assert.ok(!text.includes('## Interface'));
    assert.equal(task.liveWorker(info), null);
    assert.ok(!alive(info.overall(1).started.data.pid));
    assert.throws(() => task.assertDutyInstalled('automate', skills.root), (error) => error.message === `no installed skill has the role duty (duty automate); ${ROLE_MISSING}`);
  });
});
