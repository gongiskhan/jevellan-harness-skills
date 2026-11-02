#!/usr/bin/env node
// Runs each skill's own tests (skills/<name>/test/*.test.mjs) with only that skill present: the skill's folder is
// copied alone into <temporary folder>/skills/<name> and `node --test` runs the copied tests there, so a test (or a
// script it runs) that reaches for a sibling skill's files finds nothing and fails. A skill's tests may install
// fakes of the roles it calls next to the copy (see AGENTS.md, "Decoupling over efficiency"); they never use the
// real sibling skills of this repository.
//
//   node scripts/test-skills.mjs [--skill <name>]... [--concurrency N]
//
// --concurrency is a positive integer (default: the smaller of 4 and the machine's parallelism). Exit 0 when every
// chosen skill ran and its tests passed (a skill without a test/ folder has nothing to run and is listed as such), 1
// when a skill's tests failed or a chosen skill has no result, 2 on a usage error.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SKILLS = path.join(REPO, 'skills');

const USAGE = 'usage: node scripts/test-skills.mjs [--skill <name>]... [--concurrency N]';
const usageError = (message) => {
  process.stderr.write(`test-skills: ${message}\n${USAGE}\n`);
  process.exit(2);
};

let values;
try {
  ({ values } = parseArgs({ options: { skill: { type: 'string', multiple: true }, concurrency: { type: 'string' } } }));
} catch (error) {
  usageError(error.message);
}
const all = fs.readdirSync(SKILLS).filter((name) => fs.existsSync(path.join(SKILLS, name, 'SKILL.md'))).sort();
const chosen = values.skill ?? all;
for (const name of chosen) if (!all.includes(name)) usageError(`no skill ${name} under skills/`);
if (values.concurrency !== undefined && !/^[1-9][0-9]*$/.test(values.concurrency)) {
  usageError(`--concurrency must be a positive integer, not "${values.concurrency}"`);
}
const concurrency = values.concurrency !== undefined ? Number(values.concurrency) : Math.max(1, Math.min(4, os.availableParallelism?.() ?? 4));

const base = fs.mkdtempSync(path.join(process.env.JH_TEST_TMPDIR || os.tmpdir(), 'jh-skill-tests-'));

function testFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...testFiles(full));
    else if (entry.name.endsWith('.test.mjs')) out.push(full);
  }
  return out.sort();
}

function runSkill(name) {
  const own = testFiles(path.join(SKILLS, name, 'test'));
  if (!own.length) return Promise.resolve({ name, skipped: true });
  const root = path.join(base, name);
  const copy = path.join(root, 'skills', name);
  fs.mkdirSync(path.dirname(copy), { recursive: true });
  fs.cpSync(path.join(SKILLS, name), copy, { recursive: true, verbatimSymlinks: true });
  const files = testFiles(path.join(copy, 'test'));
  const tmp = path.join(root, 'tmp');
  fs.mkdirSync(tmp, { recursive: true });
  // Nothing of this repository's environment reaches the tests: a private harness home and temporary folder, and no
  // worker variables.
  const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: process.env.LANG, TMPDIR: tmp, JH_TEST_TMPDIR: tmp, JH_HARNESS_HOME: path.join(root, 'harness') };
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, ['--test', '--test-concurrency=1', ...files], { cwd: copy, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', (chunk) => {
      output += chunk;
    });
    child.stderr.on('data', (chunk) => {
      output += chunk;
    });
    child.on('close', (code) => resolve({ name, code, output, ms: Date.now() - started, files: files.length }));
  });
}

const queue = [...chosen];
const results = [];
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (queue.length) results.push(await runSkill(queue.shift()));
}));
results.sort((a, b) => a.name.localeCompare(b.name));
let failed = 0;
for (const r of results) {
  if (r.skipped) {
    process.stdout.write(`- ${r.name}: no own tests\n`);
    continue;
  }
  const summary = (key) => Number(new RegExp(`^# ${key} (\\d+)`, 'm').exec(r.output)?.[1] ?? NaN);
  const line = `${r.name}: ${summary('pass')} passed, ${summary('fail')} failed (${r.files} files, ${Math.round(r.ms / 1000)} s, alone)`;
  if (r.code === 0) {
    process.stdout.write(`ok ${line}\n`);
  } else {
    failed += 1;
    process.stdout.write(`FAIL ${line}\n${r.output.split('\n').filter((l) => /^not ok|^\s+(error|expected|actual|location|stack):|^# fail|Error/.test(l)).slice(0, 60).join('\n')}\n`);
  }
}
if (results.length !== chosen.length) {
  failed += 1;
  process.stdout.write(`FAIL ${results.length} of ${chosen.length} chosen skills have a result\n`);
}
process.exitCode = failed ? 1 : 0;
