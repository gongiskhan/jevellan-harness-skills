// The report contract of section 6 and its hand-written validator: the first problem as one sentence, prefixed
// "report.json: ", and the lenient fixes (an over-long summary cut, a list of limitations joined).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// The fixture points JH_HARNESS_HOME at a temporary folder: fitReportLine redacts with the secrets it finds there, and
// no test reads the real ~/.jevellan-harness.
import './helpers.mjs';
import { LIMITS, REPORT_LINE_BYTES, STATUSES, cutText, fitReportLine, normalizeReport, validateReport } from '../scripts/lib/report-schema.mjs';
import { MAX_LINE } from '../scripts/lib/ledger.mjs';

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

describe('fitting a report to one ledger line', () => {
  const bytes = (value) => Buffer.byteLength(JSON.stringify(value));
  const wide = '中'.repeat(1000);
  const big = () => ({
    status: 'needs-decision',
    summary: '報'.repeat(LIMITS.summary),
    question: '問'.repeat(LIMITS.question),
    options: [{ label: 'Blue', description: '藍'.repeat(LIMITS.description) }, { label: 'Green' }],
    testsRun: { command: 'npm test', passed: false, summary: '試'.repeat(LIMITS.testsSummary) },
    changedFiles: Array.from({ length: LIMITS.changedFiles }, (_, i) => `src/${wide}-${i}.js`),
    screenshots: Array.from({ length: LIMITS.screenshots }, (_, i) => ({ path: `.jevellan/evidence/${i}.png`, caption: '图'.repeat(LIMITS.caption) })),
    limitations: '限'.repeat(LIMITS.limitations),
    ownerCommands: Array.from({ length: LIMITS.ownerCommands }, () => ({ command: '命'.repeat(LIMITS.command), cwd: 'home', why: 'Only you can.' })),
    reportFile: '/p/.jevellan/reports/T1-s1-20261102T011409312Z.json',
  });

  test('the budget is the ledger line rule minus room for the envelope', () => {
    assert.ok(REPORT_LINE_BYTES < MAX_LINE && REPORT_LINE_BYTES > MAX_LINE - 8192);
  });

  test('a report that fits is left as it is', () => {
    const data = { ...decision, changedFiles: ['README.md'], limitations: 'none', reportFile: '/p/r.json' };
    assert.deepEqual(fitReportLine(data), data);
  });

  test('a schema-valid report over the budget keeps its decision fields and cuts its lists, with the counts', () => {
    const input = big();
    assert.equal(validateReport(Object.fromEntries(Object.entries(input).filter(([k]) => k !== 'reportFile'))).ok, true);
    assert.ok(bytes(input) > MAX_LINE);
    const copy = structuredClone(input);
    const out = fitReportLine(input);
    assert.deepEqual(input, copy, 'the input is untouched');
    assert.ok(bytes(out) <= REPORT_LINE_BYTES, `${bytes(out)} bytes`);
    for (const key of ['status', 'summary', 'question', 'options', 'testsRun', 'reportFile']) assert.deepEqual(out[key], input[key], key);
    assert.equal(out.trimmed, true);
    assert.deepEqual(out.originalCounts, { changedFiles: 200, screenshots: 50, ownerCommands: 5, limitations: 4000 });
    assert.ok(out.changedFiles.length >= 1, 'changed files stay listed');
    assert.deepEqual(out.changedFiles, input.changedFiles.slice(0, out.changedFiles.length));
    for (const key of ['screenshots', 'ownerCommands']) assert.deepEqual(out[key], input[key].slice(0, out[key].length), key);
    assert.match(out.limitations, /the full report is \/p\/\.jevellan\/reports\/T1-s1-20261102T011409312Z\.json\.$/);
  });

  test('the room left is filled in order, so a short list survives whole', () => {
    const input = { status: 'done', summary: 's', changedFiles: ['a.js', 'b.js'], screenshots: [{ path: '.jevellan/evidence/a.png', caption: 'A' }], limitations: 'l'.repeat(LIMITS.limitations), reportFile: '/r.json' };
    const out = fitReportLine(input, { maxBytes: 1500 });
    assert.ok(bytes(out) <= 1500, `${bytes(out)} bytes`);
    assert.deepEqual(out.changedFiles, input.changedFiles);
    assert.deepEqual(out.screenshots, input.screenshots);
    assert.match(out.limitations, /^l+…\n\nThis ledger line was cut to fit/);
    assert.deepEqual(out.originalCounts, { changedFiles: 2, screenshots: 1, limitations: 4000 });
  });

  test('even text that escapes to six bytes a character fits: the longest kept texts are halved', () => {
    const control = '\u0001';
    const input = {
      status: 'needs-decision',
      summary: control.repeat(LIMITS.summary),
      question: control.repeat(LIMITS.question),
      options: Array.from({ length: 4 }, () => ({ label: control.repeat(LIMITS.label), description: control.repeat(LIMITS.description) })),
      testsRun: { command: control.repeat(LIMITS.command), passed: true, summary: control.repeat(LIMITS.testsSummary) },
      reportFile: '/r.json',
    };
    assert.ok(bytes(input) > REPORT_LINE_BYTES);
    const out = fitReportLine(input);
    assert.ok(bytes(out) <= REPORT_LINE_BYTES, `${bytes(out)} bytes`);
    assert.equal(out.trimmed, true);
    assert.equal(out.status, 'needs-decision');
    assert.ok(out.summary.length > 0 && out.testsRun.command.length > 0);
  });

  test('cutText never splits a character made of two UTF-16 units', () => {
    assert.equal(cutText('abcdef', 10), 'abcdef');
    assert.equal(cutText('abcdef', 4), 'abc…');
    const cut = cutText('a😀😀😀', 3);
    assert.equal(cut, 'a…');
    assert.doesNotThrow(() => encodeURIComponent(cut));
  });
});

describe('decisions and followUps (additive, 0.4.0)', () => {
  const d = { question: 'Both fields break the 2,400-byte page budget', choice: 'fields only on automatic rows', options: ['raise the budget', 'only automatic rows'], reason: 'keeps the page small', reversible: true };
  const f = { kind: 'unrelated-failure', title: 'tests/unrelated.test.mjs fails on main too', evidence: 'daysBetween: 3 !== 2', cause: 'an off-by-one in utils/dates.mjs' };

  test('a report without them stays valid, and one with them is kept as written', () => {
    ok(base);
    assert.deepEqual(ok({ ...base, decisions: [d], followUps: [f, { ...f, kind: 'host' }, { ...f, kind: 'scope' }] }), { ...base, decisions: [d], followUps: [f, { ...f, kind: 'host' }, { ...f, kind: 'scope' }] });
    ok({ ...base, decisions: [{ ...d, options: undefined }] });
  });

  test('their shape is checked', () => {
    problem({ ...base, decisions: {} }, 'decisions must be a list of {question, choice, options, reason, reversible}');
    problem({ ...base, decisions: [{ ...d, reason: '' }] }, 'decisions[0].reason must be a non-empty text of at most 600 characters');
    problem({ ...base, decisions: [{ ...d, reversible: 'yes' }] }, 'decisions[0].reversible must be true or false');
    problem({ ...base, decisions: [{ ...d, why: 'x' }] }, 'decisions[0] has an unknown field "why"');
    problem({ ...base, followUps: [{ ...f, kind: 'bug' }] }, 'followUps[0].kind must be one of unrelated-failure, host, scope');
    problem({ ...base, followUps: [{ ...f, cause: '' }] }, 'followUps[0].cause must be a non-empty text of at most 600 characters');
    problem({ ...base, followUps: Array(11).fill(f) }, 'followUps must have at most 10 items');
  });
});
