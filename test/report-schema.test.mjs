// The report contract of section 6 and its hand-written validator: the first problem as one sentence, prefixed
// "report.json: ", and the lenient fixes (an over-long summary cut, a list of limitations joined).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LIMITS, STATUSES, normalizeReport, validateReport } from '../skills/jevellan-ledger/scripts/lib/report-schema.mjs';

const base = { status: 'done', summary: 'Added the section.' };
const decision = { status: 'needs-decision', summary: 'Two ways.', question: 'Blue or Green?', options: [{ label: 'Blue' }, { label: 'Green' }] };

function ok(report) {
  const result = validateReport(report);
  assert.equal(result.ok, true, result.problem);
  return result.report;
}

function problem(report, expected) {
  const result = validateReport(report);
  assert.equal(result.ok, false, `accepted ${String(JSON.stringify(report)).slice(0, 200)}`);
  assert.equal(result.problem, `report.json: ${expected}`);
}

describe('status and summary', () => {
  test('every status is accepted with a summary', () => {
    assert.deepEqual(STATUSES, ['progress', 'done', 'blocked', 'needs-decision']);
    for (const status of ['progress', 'done', 'blocked']) assert.deepEqual(ok({ status, summary: 's' }), { status, summary: 's' });
    ok(decision);
  });

  test('the report must be one object', () => {
    for (const value of [null, [], 'done', 3, undefined]) problem(value, 'must be one JSON object');
  });

  test('status must be one of the four', () => {
    problem({ summary: 's' }, 'status must be one of progress, done, blocked, needs-decision');
    problem({ status: 'finished', summary: 's' }, 'status must be one of progress, done, blocked, needs-decision');
    problem({ status: 'DONE', summary: 's' }, 'status must be one of progress, done, blocked, needs-decision');
  });

  test('summary must be a non-empty text', () => {
    problem({ status: 'done' }, 'summary must be a non-empty text');
    problem({ status: 'done', summary: '' }, 'summary must be a non-empty text');
    problem({ status: 'done', summary: '   \n' }, 'summary must be a non-empty text');
    problem({ status: 'done', summary: 42 }, 'summary must be a non-empty text');
  });

  test('an over-long summary is cut to 4000 characters, not refused', () => {
    const exact = 'a'.repeat(LIMITS.summary);
    assert.equal(ok({ status: 'done', summary: exact }).summary, exact);
    const long = 'b'.repeat(9000);
    const cut = ok({ status: 'done', summary: long }).summary;
    assert.equal(cut.length, 4000);
    assert.equal(cut, `${'b'.repeat(3999)}…`);
  });

  test('unknown fields are refused, at the top and inside', () => {
    problem({ ...base, colour: 'blue' }, 'the report has an unknown field "colour"');
    problem({ ...base, reportFile: '/x.json' }, 'the report has an unknown field "reportFile"');
    problem({ ...base, synthesized: true }, 'the report has an unknown field "synthesized"');
    problem({ ...decision, options: [{ label: 'A', value: 1 }, { label: 'B' }] }, 'options[0] has an unknown field "value"');
    problem({ ...base, testsRun: { command: 'npm test', passed: true, summary: 'ok', duration: 3 } }, 'testsRun has an unknown field "duration"');
    problem({ ...base, screenshots: [{ path: '.jevellan/evidence/a.png', caption: 'c', width: 390 }] }, 'screenshots[0] has an unknown field "width"');
    problem({ ...base, ownerCommands: [{ command: 'x', cwd: 'home', why: 'y', sudo: true }] }, 'ownerCommands[0] has an unknown field "sudo"');
  });

  test('the unknown field is reported before anything else', () => {
    problem({ status: 'nope', extra: 1 }, 'the report has an unknown field "extra"');
  });
});

describe('needs-decision, question and options', () => {
  test('needs-decision requires a question and options', () => {
    problem({ status: 'needs-decision', summary: 's' }, 'question is required when status is needs-decision');
    problem({ status: 'needs-decision', summary: 's', question: '  ' }, 'question is required when status is needs-decision');
    problem({ status: 'needs-decision', summary: 's', question: 'Q?' }, 'options are required when status is needs-decision');
    problem({ status: 'needs-decision', summary: 's', question: 'Q?', options: 'Blue or Green' }, 'options are required when status is needs-decision');
  });

  test('options must have 2 to 4 items', () => {
    const opts = (n) => Array.from({ length: n }, (_, i) => ({ label: `Option ${i + 1}` }));
    problem({ ...decision, options: [] }, 'options must have 2 to 4 items');
    problem({ ...decision, options: opts(1) }, 'options must have 2 to 4 items');
    problem({ ...decision, options: opts(5) }, 'options must have 2 to 4 items');
    ok({ ...decision, options: opts(2) });
    ok({ ...decision, options: opts(4) });
    // Options given with another status follow the same bounds.
    problem({ ...base, options: opts(1) }, 'options must have 2 to 4 items');
    problem({ ...base, options: {} }, 'options must have 2 to 4 items');
  });

  test('each option is an object with a label and an optional description', () => {
    problem({ ...decision, options: ['Blue', 'Green'] }, 'options[0] must be an object with a label');
    problem({ ...decision, options: [{ label: 'Blue' }, { description: 'no label' }] }, 'options[1].label must be a non-empty text');
    problem({ ...decision, options: [{ label: 'Blue' }, { label: 'x'.repeat(LIMITS.label + 1) }] }, 'options[1].label must be at most 120 characters');
    problem({ ...decision, options: [{ label: 'Blue', description: 3 }, { label: 'Green' }] }, 'options[0].description must be a text');
    problem({ ...decision, options: [{ label: 'Blue', description: 'd'.repeat(301) }, { label: 'Green' }] }, 'options[0].description must be at most 300 characters');
    ok({ ...decision, options: [{ label: 'Blue', description: 'the calm one' }, { label: 'Green', description: '' }] });
  });

  test('a question is at most 1000 characters, and must be a text when given', () => {
    problem({ ...decision, question: 'q'.repeat(1001) }, 'question must be at most 1000 characters');
    ok({ ...decision, question: 'q'.repeat(1000) });
    problem({ ...base, question: '' }, 'question must be a non-empty text');
    ok({ ...base, question: 'An open question for later.' });
  });
});

describe('testsRun', () => {
  const tests = { command: 'npm test', passed: true, summary: '34 passed' };

  test('a complete testsRun is accepted, passed or failed', () => {
    ok({ ...base, testsRun: tests });
    ok({ ...base, testsRun: { ...tests, passed: false, summary: '' } });
  });

  test('its shape is checked field by field', () => {
    problem({ ...base, testsRun: 'npm test' }, 'testsRun must be an object with command, passed and summary');
    problem({ ...base, testsRun: [] }, 'testsRun must be an object with command, passed and summary');
    problem({ ...base, testsRun: { passed: true, summary: 's' } }, 'testsRun.command must be a non-empty text');
    problem({ ...base, testsRun: { ...tests, command: 'x'.repeat(LIMITS.command + 1) } }, 'testsRun.command must be at most 4000 characters');
    problem({ ...base, testsRun: { ...tests, passed: 'true' } }, 'testsRun.passed must be true or false');
    problem({ ...base, testsRun: { command: 'npm test', passed: true } }, 'testsRun.summary must be a text');
    problem({ ...base, testsRun: { ...tests, summary: 's'.repeat(601) } }, 'testsRun.summary must be at most 600 characters');
    ok({ ...base, testsRun: { ...tests, summary: 's'.repeat(600) } });
  });
});

describe('changedFiles', () => {
  test('a list of at most 200 paths', () => {
    ok({ ...base, changedFiles: [] });
    ok({ ...base, changedFiles: Array.from({ length: 200 }, (_, i) => `src/file-${i}.js`) });
    problem({ ...base, changedFiles: Array.from({ length: 201 }, (_, i) => `f${i}`) }, 'changedFiles must have at most 200 items');
    problem({ ...base, changedFiles: 'README.md' }, 'changedFiles must be a list of paths');
    problem({ ...base, changedFiles: ['README.md', ''] }, 'changedFiles[1] must be a path of at most 1024 characters');
    problem({ ...base, changedFiles: ['README.md', 7] }, 'changedFiles[1] must be a path of at most 1024 characters');
    problem({ ...base, changedFiles: ['x'.repeat(1025)] }, 'changedFiles[0] must be a path of at most 1024 characters');
  });
});

describe('screenshots', () => {
  test('paths under .jevellan/evidence/, relative or absolute, each with a caption', () => {
    ok({ ...base, screenshots: [{ path: '.jevellan/evidence/desktop.png', caption: 'Desktop' }] });
    ok({ ...base, screenshots: [{ path: './.jevellan/evidence/phone.png', caption: 'Phone' }] });
    ok({ ...base, screenshots: [{ path: '/home/u/.jevellan-harness/worktrees/p/t/.jevellan/evidence/a.png', caption: 'Absolute' }] });
  });

  test('anything else is refused', () => {
    problem({ ...base, screenshots: { path: 'a' } }, 'screenshots must be a list of {path, caption}');
    problem({ ...base, screenshots: ['a.png'] }, 'screenshots[0] must be an object with path and caption');
    problem({ ...base, screenshots: [{ path: 'shots/a.png', caption: 'c' }] }, 'screenshots[0].path must be under .jevellan/evidence/');
    problem({ ...base, screenshots: [{ path: 'evidence/a.png', caption: 'c' }] }, 'screenshots[0].path must be under .jevellan/evidence/');
    problem({ ...base, screenshots: [{ path: '/tmp/a.png', caption: 'c' }] }, 'screenshots[0].path must be under .jevellan/evidence/');
    problem({ ...base, screenshots: [{ path: '', caption: 'c' }] }, 'screenshots[0].path must be a path');
    problem({ ...base, screenshots: [{ path: '.jevellan/evidence/a.png' }] }, 'screenshots[0].caption must be a text of at most 300 characters');
    problem({ ...base, screenshots: [{ path: '.jevellan/evidence/a.png', caption: 'c'.repeat(301) }] }, 'screenshots[0].caption must be a text of at most 300 characters');
    const many = Array.from({ length: LIMITS.screenshots + 1 }, (_, i) => ({ path: `.jevellan/evidence/${i}.png`, caption: 'c' }));
    problem({ ...base, screenshots: many }, 'screenshots must have at most 50 items');
  });
});

describe('limitations', () => {
  test('a text, or a list of texts joined into one', () => {
    assert.equal(ok({ ...base, limitations: 'Only tested on desktop.' }).limitations, 'Only tested on desktop.');
    assert.equal(ok({ ...base, limitations: ['No phone check.', 'No dark mode.'] }).limitations, 'No phone check.\nNo dark mode.');
    assert.equal(ok({ ...base, limitations: 'l'.repeat(5000) }).limitations.length, 4000);
    problem({ ...base, limitations: 3 }, 'limitations must be a text');
    problem({ ...base, limitations: ['a', 2] }, 'limitations must be a text');
    problem({ ...base, limitations: { note: 'x' } }, 'limitations must be a text');
  });
});

describe('ownerCommands', () => {
  const command = { command: 'npm run deploy:preview', cwd: 'worktree', why: 'Needs your cloud login.' };

  test('cwd is worktree, checkout, home or an absolute folder', () => {
    for (const cwd of ['worktree', 'checkout', 'home', '/home/u/project']) ok({ ...base, ownerCommands: [{ ...command, cwd }] });
    for (const cwd of ['project', 'src/app', '~/project', '', 'Worktree']) {
      problem({ ...base, ownerCommands: [{ ...command, cwd }] }, 'ownerCommands[0].cwd must be worktree, checkout, home or an absolute folder');
    }
  });

  test('every command says what and why, at most five of them', () => {
    problem({ ...base, ownerCommands: command }, 'ownerCommands must be a list of {command, cwd, why}');
    problem({ ...base, ownerCommands: ['npm test'] }, 'ownerCommands[0] must be an object with command, cwd and why');
    problem({ ...base, ownerCommands: [{ ...command, command: ' ' }] }, 'ownerCommands[0].command must be a non-empty text');
    problem({ ...base, ownerCommands: [{ command: 'x', cwd: 'home' }] }, 'ownerCommands[0].why must say why, in at most 300 characters');
    problem({ ...base, ownerCommands: [command, { ...command, why: 'w'.repeat(301) }] }, 'ownerCommands[1].why must say why, in at most 300 characters');
    ok({ ...base, ownerCommands: Array.from({ length: 5 }, () => command) });
    problem({ ...base, ownerCommands: Array.from({ length: 6 }, () => command) }, 'ownerCommands must have at most 5 items');
  });
});

describe('the validator itself', () => {
  test('a full report passes and comes back normalized, the input untouched', () => {
    const input = {
      status: 'done',
      summary: 's'.repeat(4500),
      changedFiles: ['README.md'],
      testsRun: { command: 'npm test', passed: true, summary: 'ok' },
      screenshots: [{ path: '.jevellan/evidence/a.png', caption: 'A' }],
      limitations: ['one', 'two'],
      ownerCommands: [{ command: 'gh auth login', cwd: 'home', why: 'Only you can log in.' }],
    };
    const copy = structuredClone(input);
    const report = ok(input);
    assert.deepEqual(input, copy);
    assert.equal(report.summary.length, 4000);
    assert.equal(report.limitations, 'one\ntwo');
    assert.deepEqual(report.changedFiles, input.changedFiles);
  });

  test('normalizeReport leaves values that are not objects alone', () => {
    assert.equal(normalizeReport(null), null);
    assert.equal(normalizeReport('x'), 'x');
    const list = [1];
    assert.equal(normalizeReport(list), list);
  });

  test('the first problem wins', () => {
    problem({ status: 'needs-decision', summary: '', question: '', options: [] }, 'summary must be a non-empty text');
    problem({ ...decision, options: [{ label: 'A' }], testsRun: 'x' }, 'options must have 2 to 4 items');
  });
});
