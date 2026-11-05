// The Claude runtime's own parts, alone: the claude command line, the worker settings and environment, what the
// worker is told, the process helpers, and the task helpers over the ledger's show --json (a fake ledger here).

import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CLAUDE, HARNESS_HOME, ROLE_MISSING, TOKEN, TaskLines, deadPid, infoFrom, makeProject, makeSkillsRoot, sleeper, tempDir, waitFor, alive, writeProviders } from './helpers/fakes.mjs';
import { claudeArgs } from '../scripts/lib/step.mjs';
import { foldersAbove, instructionExcludes, providerLogin, workerEnv, workerSettings } from '../scripts/lib/env.mjs';
import { DUTIES, START_PROMPT, dutyMode, projectInstructions, resumeMessage, systemAppend, taskBlock, workerRules, AGENTS_CUT_NOTE } from '../scripts/lib/prompt.mjs';
import { groupAlive, pidAlive, signalGroup, stopGroup, waitForExit } from '../scripts/lib/proc.mjs';
import { findProvider } from '../scripts/lib/common.mjs';
import * as lib from '../scripts/lib/task.mjs';

const { withoutInterface } = lib;

const cleanup = [];
after(() => {
  for (const stop of cleanup) stop();
});

before(() => {
  writeProviders();
});

describe('claudeArgs', () => {
  const base = { session: 'sess-1', model: 'claude-sonnet-5-5', effort: 'low', appendFile: '/logs/sess-1.append.md', prompt: START_PROMPT, cwd: '/work/area/wt' };
  const settingsOf = (argv) => JSON.parse(argv[argv.indexOf('--settings') + 1]);

  test('a write duty bypasses permissions; the prompt always follows --', () => {
    const argv = claudeArgs({ ...base, duty: 'implement' });
    assert.deepEqual(argv.slice(0, 7), ['-p', '--session-id', 'sess-1', '--model', 'claude-sonnet-5-5', '--effort', 'low']);
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'bypassPermissions');
    assert.ok(!argv.includes('--tools'));
    assert.deepEqual(argv.slice(-2), ['--', START_PROMPT]);
    assert.equal(argv[argv.indexOf('--append-system-prompt-file') + 1], base.appendFile);
    assert.deepEqual(argv.slice(argv.indexOf('--output-format'), argv.indexOf('--output-format') + 3), ['--output-format', 'stream-json', '--verbose']);
  });

  test('with the skills installed alone no plugin is loaded; skills that came with a plugin load it with --plugin-dir', async () => {
    assert.equal(claudeArgs({ ...base, duty: 'implement' }).includes('--plugin-dir'), false, 'this copy is not inside a plugin');
    const argv = claudeArgs({ ...base, duty: 'investigate', plugin: '/plugins/cache/jh/0.2.0' });
    assert.equal(argv[argv.indexOf('--plugin-dir') + 1], '/plugins/cache/jh/0.2.0');
    assert.ok(argv.indexOf('--plugin-dir') < argv.indexOf('--'), 'before the prompt');
    // pluginRoot: the folder holding the skills folder, when it carries .claude-plugin/plugin.json.
    const { pluginRoot, runsFromProject } = await import('../scripts/lib/roles.mjs');
    const plugin = tempDir('jh-plugin-');
    fs.mkdirSync(path.join(plugin, 'skills'), { recursive: true });
    assert.equal(pluginRoot(path.join(plugin, 'skills')), null);
    fs.mkdirSync(path.join(plugin, '.claude-plugin'));
    fs.writeFileSync(path.join(plugin, '.claude-plugin', 'plugin.json'), '{"name":"p"}');
    assert.equal(pluginRoot(path.join(plugin, 'skills')), plugin);
    // runsFromProject: the skills folder is <project>/.claude/skills.
    const project = tempDir('jh-proj-');
    fs.mkdirSync(path.join(project, '.claude', 'skills'), { recursive: true });
    assert.equal(runsFromProject(project, path.join(project, '.claude', 'skills')), true);
    assert.equal(runsFromProject(project, path.join(plugin, 'skills')), false);
  });

  test('read-only and plan duties write only their report (and plan.md); tool-less duties get one turn', () => {
    let argv = claudeArgs({ ...base, duty: 'investigate' });
    assert.equal(argv[argv.indexOf('--permission-mode') + 1], 'dontAsk');
    assert.equal(argv[argv.indexOf('--tools') + 1], 'Read,Glob,Grep,WebSearch,WebFetch,Skill,Write,Edit');
    assert.ok(argv.includes('Write(./.jevellan/report.json)') && argv.includes('Edit(./.jevellan/report.json)'));
    assert.ok(!argv.includes('Write(./plan.md)'));
    argv = claudeArgs({ ...base, duty: 'plan' });
    assert.ok(argv.includes('Write(./plan.md)') && argv.includes('Edit(./plan.md)'));
    argv = claudeArgs({ ...base, duty: 'answer', resume: true });
    assert.deepEqual(argv.slice(0, 3), ['-p', '--resume', 'sess-1']);
    assert.equal(argv[argv.indexOf('--max-turns') + 1], '1');
    assert.equal(argv[argv.indexOf('--tools') + 1], '');
  });

  test('the settings are the ones of the step\'s worktree', () => {
    const argv = claudeArgs({ ...base, duty: 'implement' });
    assert.deepEqual(settingsOf(argv), JSON.parse(workerSettings(base.cwd)));
  });
});

describe('worker settings', () => {
  test('every folder above the worktree has its instruction files excluded, the worktree none of its own', () => {
    const settings = JSON.parse(workerSettings('/work/area/wt'));
    assert.deepEqual(settings.claudeMdExcludes, [
      '/work/area/CLAUDE.md', '/work/area/CLAUDE.local.md', path.join('/work/area', '.claude', '**'),
      '/work/CLAUDE.md', '/work/CLAUDE.local.md', path.join('/work', '.claude', '**'),
      '/CLAUDE.md', '/CLAUDE.local.md', path.join('/', '.claude', '**'),
    ]);
    assert.deepEqual(settings.attribution, { commit: '', pr: '', sessionUrl: false });
    assert.deepEqual(foldersAbove('/'), []);
    assert.deepEqual(instructionExcludes('/top'), ['/CLAUDE.md', '/CLAUDE.local.md', path.join('/', '.claude', '**')]);
  });

  test('a worktree reached through a symlink is covered under both spellings', () => {
    const real = path.join(tempDir('jh-real-'), 'deep', 'wt');
    fs.mkdirSync(real, { recursive: true });
    const link = path.join(tempDir('jh-link-'), 'wt');
    fs.symlinkSync(real, link);
    const above = foldersAbove(link);
    assert.ok(above.includes(path.dirname(link)));
    assert.ok(above.includes(path.dirname(real)));
    assert.equal(new Set(above).size, above.length, 'no folder twice');
    const excludes = JSON.parse(workerSettings(link)).claudeMdExcludes;
    assert.ok(excludes.includes(path.join(path.dirname(real), 'CLAUDE.md')));
    assert.ok(!excludes.some((p) => p.startsWith(`${real}/`) || p.startsWith(`${link}/`)));
  });

  test('Read and Edit are denied on the harness secrets folder, under both spellings of a symlinked home', () => {
    const secrets = path.join(HARNESS_HOME, 'secrets');
    assert.deepEqual(JSON.parse(workerSettings('/x/wt')).permissions.deny, [`Read(/${secrets}/**)`, `Edit(/${secrets}/**)`]);
    const link = path.join(tempDir('jh-harness-link-'), 'home');
    fs.symlinkSync(HARNESS_HOME, link);
    const saved = process.env.JH_HARNESS_HOME;
    process.env.JH_HARNESS_HOME = link;
    try {
      assert.deepEqual(JSON.parse(workerSettings('/x/wt')).permissions.deny, [`Read(/${link}/secrets/**)`, `Read(/${secrets}/**)`, `Edit(/${link}/secrets/**)`, `Edit(/${secrets}/**)`]);
    } finally {
      process.env.JH_HARNESS_HOME = saved;
    }
  });
});

describe('worker environment', () => {
  const ids = { task: 'T0FAKE1', step: 2, duty: 'implement', project: '/p', session: 'sess-9', cwd: '/p-wt' };

  test('a subscription worker gets its token, its own config folder and the hooks\' variables, nothing else', () => {
    const env = workerEnv({ provider: findProvider('claude-test'), ...ids, base: { PATH: '/usr/bin', HOME: '/home/someone', SECRET_THING: 'x', ANTHROPIC_API_KEY: 'y' } });
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, TOKEN);
    assert.equal(env.CLAUDE_CONFIG_DIR, path.join(HARNESS_HOME, 'claude-config'));
    assert.equal(env.ENABLE_CLAUDEAI_MCP_SERVERS, 'false');
    assert.equal(env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1');
    assert.deepEqual([env.JH_TASK, env.JH_STEP, env.JH_DUTY, env.JH_PROJECT, env.JH_SESSION, env.JH_CWD], ['T0FAKE1', '2', 'implement', '/p', 'sess-9', '/p-wt']);
    assert.equal(env.SECRET_THING, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.PATH.split(':')[0], path.dirname(process.execPath));
    assert.equal((fs.statSync(env.CLAUDE_CONFIG_DIR).mode & 0o777), 0o700);
  });

  test('an endpoint worker gets the base URL, the key and the model ids', () => {
    const login = providerLogin(findProvider('endpoint-test'));
    assert.deepEqual(login, {
      ANTHROPIC_BASE_URL: 'http://127.0.0.1:9',
      ANTHROPIC_AUTH_TOKEN: 'fake-endpoint-key-0123456789',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'model-a',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'model-b',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'model-b',
    });
  });

  test('a provider that cannot run a Claude session here is refused with exit 2', () => {
    for (const [name, pattern] of [['codex-test', /not a Claude provider/], ['off-test', /disabled/]]) {
      assert.throws(() => providerLogin(findProvider(name)), (error) => pattern.test(error.message) && error.exitCode === 2);
    }
    assert.throws(() => providerLogin({ name: 'gone', kind: 'claude-subscription', tokenFile: '/nonexistent/token', models: [] }), /token file .* is missing or empty/);
    assert.throws(() => findProvider('nobody'), (error) => error.exitCode === 3);
  });
});

describe('what the worker is told', () => {
  test('the rules follow the duty\'s mode', () => {
    assert.deepEqual(DUTIES.map(dutyMode), ['no-tools', 'no-tools', 'read-only', 'plan', 'write', 'write', 'write', 'write']);
    const args = { project: 'demo', cwd: '/wt', branch: 'jh/x', base: 'main' };
    assert.match(workerRules({ ...args, duty: 'implement' }), /Commit your work on this branch/);
    assert.match(workerRules({ ...args, duty: 'plan' }), /writes only plan\.md/);
    assert.match(workerRules({ ...args, duty: 'investigate' }), /changes nothing in this worktree/);
    assert.match(workerRules({ ...args, duty: 'answer' }), /no tools and no access to the repository/);
    for (const duty of DUTIES) assert.match(workerRules({ ...args, duty }), /Never edit, commit or mention CLAUDE\.md/);
  });

  test('the task block leaves out what has nothing to say, and the append puts the parts in order', () => {
    const block = taskBlock({ task: 'T0FAKE1', title: 'Title', kind: 'feature', position: 2, total: 3, duty: 'implement', text: 'The brief.', instructions: 'Do it.', settings: { testCommand: 'npm test', other: 'x' }, earlier: [{ duty: 'plan', status: 'done', summary: 'planned' }], plan: true });
    assert.equal(block, 'Task T0FAKE1: Title\nKind: feature. Step 2 of 3: implement.\n\nThe brief.\n\nStep instructions:\nDo it.\n\nProject settings (.jevellan/project.json):\n- testCommand: npm test\n\nEarlier steps of this task:\n- plan (done): planned\nPlan: plan.md in the worktree root.');
    const text = systemAppend({ rules: 'RULES', duty: 'implement', agents: 'AGENTS', block: 'BLOCK' });
    assert.equal(text, 'RULES\n\nYour step is duty implement. Use the duty skill for implement now and follow it.\n\n# This project\'s AGENTS.md\n\nAGENTS\n\n# Your step\n\nBLOCK\n');
    assert.equal(resumeMessage('owner', 'Go on.'), 'From the owner: Go on.');
    assert.equal(resumeMessage('coordinator', 'Continue.'), 'From the coordinator: Continue.');
  });

  test('AGENTS.md is cut at 32 KiB on a character boundary', () => {
    const dir = tempDir('jh-agents-');
    fs.writeFileSync(path.join(dir, 'AGENTS.md'), 'é'.repeat(20000));
    const text = projectInstructions(dir);
    assert.ok(text.endsWith(AGENTS_CUT_NOTE));
    assert.ok(!text.includes('�'));
    assert.equal(projectInstructions(tempDir('jh-none-')), null);
  });

  test('a skill body loses its Interface section, wherever it sits', () => {
    assert.equal(withoutInterface('# Duty\n\nDo it.\n\n## Interface\n\nNo scripts.\n'), '# Duty\n\nDo it.');
    assert.equal(withoutInterface('# Duty\n\n## Interface\n\n- `x.mjs`\n\n## Details\n\nMore.'), '# Duty\n\n## Details\n\nMore.');
    assert.equal(withoutInterface('# Duty\n\nNo section.\n'), '# Duty\n\nNo section.');
  });
});

describe('processes', () => {
  test('pid and group checks never take 0, 1 or a non-integer for a group', () => {
    assert.equal(pidAlive(process.pid), true);
    assert.equal(pidAlive(deadPid()), false);
    for (const pid of [0, 1, -5, 2.5, undefined, null, 'x']) {
      assert.equal(groupAlive(pid), false);
      assert.equal(signalGroup(pid, 0), false);
    }
  });

  test('stopGroup ends a detached group with SIGTERM; a gone group is not running', () => {
    const s = sleeper();
    cleanup.push(s.stop);
    assert.ok(waitFor(() => groupAlive(s.pid), 3000));
    assert.equal(stopGroup(s.pid, 5000), 'SIGTERM');
    assert.ok(waitForExit(s.pid, 3000));
    assert.equal(stopGroup(s.pid), 'not running');
    assert.equal(alive(s.pid), false);
  });
});

describe('the task as the ledger shows it', () => {
  let skills;
  let project;
  let wt;

  before(() => {
    skills = makeSkillsRoot({ ledger: false });
    ({ project, wt } = makeProject());
  });

  test('the views since the reset and over all lines, the newest start whatever came after, the placement guard', () => {
    const lines = new TaskLines({ kind: 'feature' });
    lines.worktree(wt);
    lines.workflow([{ ordinal: 1, duty: 'investigate', onFail: { goto: 1, maxLoops: 2 } }, { ordinal: 2, duty: 'implement' }]);
    lines.placed(1, CLAUDE);
    const first = lines.started(1, 's1', { pid: deadPid(), runtime: 'claude' });
    lines.report(1, 's1', { status: 'blocked', summary: 'stuck' });
    const retry = lines.add('step.retrying', { ordinal: 1, attempt: 1, gotoOrdinal: 1, reason: 'try again' }, { step: 1 });
    const placed = lines.placed(1, CLAUDE);
    const info = infoFrom(lines.show());
    assert.equal(info.created.task, lines.task);
    assert.equal(info.lastSeq, placed.seq);
    assert.equal(lib.currentView(info, 1).started, null, 'the retry reset hides the old start');
    assert.equal(info.view(1).resetSeq, retry.seq);
    assert.equal(info.overall(1).started.seq, first.seq);
    assert.equal(lib.newestStart(info).seq, first.seq);
    assert.equal(lib.newestStart(info, 2), null);
    assert.equal(lib.liveWorker(info), null, 'its pid is gone');
    assert.equal(lib.requirePlacement(info, 1, CLAUDE).seq, placed.seq);
    assert.throws(() => lib.requirePlacement(info, 1, { ...CLAUDE, effort: 'medium' }), /is placed on claude-test claude-sonnet-5-5 low, not claude-test claude-sonnet-5-5 medium/);
    assert.throws(() => lib.requirePlacement(info, 2, CLAUDE), /has no placement since it last ran/);
    assert.deepEqual(lib.workflowOf(info).steps.map((s) => s.duty), ['investigate', 'implement']);
    assert.equal(lib.worktreeOf(info).path, wt);
    // The retried step is told what failed.
    assert.match(lib.buildTaskBlock(project, info, 1, 'investigate'), /This step runs again after a failure\. What failed:\ntry again Report of step 1: stuck/);
  });

  test('a placement before the reset does not count; the step\'s latest start does', () => {
    const lines = new TaskLines({ kind: 'feature' });
    lines.workflow([{ ordinal: 1, duty: 'investigate', onFail: { goto: 1, maxLoops: 2 } }]);
    lines.placed(1, CLAUDE);
    lines.add('step.retrying', { ordinal: 1, attempt: 1, gotoOrdinal: 1, reason: 'again' }, { step: 1 });
    assert.throws(() => lib.requirePlacement(infoFrom(lines.show()), 1, CLAUDE), /has no placement since it last ran/);
    lines.placed(1, CLAUDE);
    lines.started(1, 's2', { pid: deadPid() });
    assert.throws(() => lib.requirePlacement(infoFrom(lines.show()), 1, CLAUDE), /has no placement since it last ran/);
  });

  test('a live worker refuses a start, a start since the placement refuses another, a done step refuses both', () => {
    const s = sleeper();
    cleanup.push(s.stop);
    const lines = new TaskLines();
    lines.worktree(wt);
    const placed = lines.placed(1, CLAUDE);
    lines.started(1, 's1', { pid: s.pid });
    let info = infoFrom(lines.show());
    assert.equal(lib.liveWorker(info).data.pid, s.pid);
    assert.throws(() => lib.startCheck(info, 1, placed), /was started meanwhile on the same placement/);
    assert.throws(() => lib.assertNoLiveWorker(info, 1), new RegExp(`step 1 of ${lines.task} is running \\(pid ${s.pid}\\)`));
    assert.throws(() => lib.assertNoLiveWorker(info, 2), new RegExp(`step 1 of ${lines.task} is still running`));
    s.stop();
    assert.ok(waitFor(() => !alive(s.pid), 3000));
    lines.report(1, 's1', { status: 'done', summary: 'done' });
    lines.done(1);
    info = infoFrom(lines.show());
    assert.throws(() => lib.resumeCheck(info, 1, info.view(1).started), /is done/);
    assert.throws(() => lib.resumeCheck(info, 1, { seq: 1 }), /was started, resumed or reset meanwhile/);
    const fresh = new TaskLines();
    const again = fresh.placed(1, CLAUDE);
    assert.equal(lib.startCheck(infoFrom(fresh.show()), 1, again), undefined, 'nothing to refuse');
  });

  test('a worker whose turn ended gets a moment to exit before it counts as live', () => {
    const s = sleeper(1500);
    cleanup.push(s.stop);
    const lines = new TaskLines();
    lines.started(1, 's1', { pid: s.pid });
    lines.report(1, 's1');
    const info = infoFrom(lines.show());
    assert.equal(lib.liveWorker(info).data.pid, s.pid, 'without grace it is live');
    assert.equal(lib.liveWorker(info, { graceMs: 5000 }), null, 'with grace it exits');
  });

  test('the duty skill is found by its role; its body goes inline without its Interface section and "$" intact', () => {
    assert.equal(lib.dutyBody('answer', skills.root), '# Fake duty answer\n\nFAKE-DUTY-BODY of answer: cost $1 and keep $& as it is.');
    const lines = new TaskLines({ duty: 'answer' });
    lines.placed(1, CLAUDE);
    const text = lib.buildAppend(project, infoFrom(lines.show()), 1, 'answer', project, 'BLOCK', { skillsRoot: skills.root });
    assert.match(text, /You have no tools, so the duty's instructions follow here:\n\n# Fake duty answer\n\nFAKE-DUTY-BODY of answer: cost \$1 and keep \$& as it is\./);
    assert.ok(!text.includes('## Interface'));
    assert.match(text, /FIXTURE-AGENTS/);
    assert.match(text, /# Your step\n\nBLOCK\n$/);
    assert.throws(() => lib.assertDutyInstalled('verify', skills.root), (error) => error.exitCode === 2 && error.message === `no installed skill has the role duty (duty verify); ${ROLE_MISSING}`);
    assert.throws(() => lib.dutyBody('verify', skills.root), /no installed skill has the role duty \(duty verify\)/);
  });
});

// B05 r6: planning was skipped, implementation wrote plan.md, and the document worker never loaded its duty.
describe('document instructions before the worker uses tools', () => {
  test('a plan written by implementation is announced from the task worktree even when planning was skipped', () => {
    const { project, wt } = makeProject();
    const lines = new TaskLines({ kind: 'feature' });
    lines.worktree(wt);
    const workflow = lines.workflow([
      { ordinal: 1, duty: 'plan', when: 'jev:needs_plan' },
      { ordinal: 2, duty: 'implement' },
      { ordinal: 3, duty: 'verify' },
      { ordinal: 4, duty: 'document', when: 'jev:needs_docs' },
    ]);
    workflow.data.skipped = [1];
    workflow.data.questions = { needs_plan: false, needs_docs: true };
    lines.report(2, 'implementation', { status: 'done', summary: 'Button implemented.' });
    lines.report(3, 'verification', { status: 'done', summary: 'Button verified.' });
    const info = infoFrom(lines.show());
    const block = () => lib.buildTaskBlock(project, info, 4, 'document');
    assert.ok(!block().includes('Plan: plan.md'), 'no plan exists yet');
    fs.writeFileSync(path.join(project, 'plan.md'), 'A different task in the checkout.');
    assert.ok(!block().includes('Plan: plan.md'), 'the checkout is not this task worktree');
    fs.writeFileSync(path.join(wt, 'plan.md'), 'Add the button.\n\n```scope\nweb/panel.mjs\ntests/panel.test.mjs\n```\n');
    assert.ok(block().includes('Plan: plan.md in the worktree root.'), 'the implementation-created plan must reach the document step');
  });

  test('the document duty body reaches the worker without a skill invocation', () => {
    const skills = makeSkillsRoot({ ledger: false, duties: ['document'] });
    const { project, wt } = makeProject();
    const lines = new TaskLines({ duty: 'document' });
    lines.worktree(wt);
    const info = infoFrom(lines.show());
    const text = lib.buildAppend(project, info, 1, 'document', wt, 'BLOCK', { skillsRoot: skills.root });
    assert.ok(text.includes(lib.dutyBody('document', skills.root)), 'include the installed duty body, resolved by role');
    assert.ok(!text.includes('## Interface'));
    assert.ok(!text.includes('Use the duty skill for document now'));
    const missing = makeSkillsRoot({ ledger: false, duties: [] });
    assert.throws(() => lib.buildAppend(project, info, 1, 'document', wt, 'BLOCK', { skillsRoot: missing.root }),
      (error) => error.exitCode === 2 && error.message.includes('no installed skill has the role duty (duty document)'));
  });
});
