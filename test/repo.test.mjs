// Repository hygiene: nothing tracked that the owner's rules forbid, and no attribution in history.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' });

test('no tracked CLAUDE.md and no tracked .claude folder', () => {
  const files = git('ls-files').split('\n').filter(Boolean);
  assert.deepEqual(files.filter((f) => /(^|\/)CLAUDE\.md$/.test(f) || /(^|\/)\.claude\//.test(f)), []);
});

test('no attribution in commit messages', () => {
  let log = '';
  try { log = git('log', '--format=%B'); } catch { return; } // no commits yet
  for (const pattern of [/co-authored-by/i, /claude-session/i, /generated with/i, /noreply@anthropic/i]) {
    assert.equal(pattern.test(log), false, `commit messages match ${pattern}`);
  }
});

test('no em dash in tracked text files', () => {
  const files = git('ls-files').split('\n').filter((f) => /\.(md|mjs|json)$/.test(f));
  const offenders = files.filter((f) => readFileSync(path.join(root, f), 'utf8').includes('—'));
  assert.deepEqual(offenders, []);
});
