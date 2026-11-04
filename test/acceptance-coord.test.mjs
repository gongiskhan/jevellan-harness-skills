// The coordinator journeys' slip analyser: heredoc bodies are data, read-only git is allowed, writes are slips.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readOnlyGit, stripHeredocs, analyse, unquoted } from '../acceptance/coord.mjs';
import { tempDir } from './helpers/ledger-fixture.mjs';

test('heredoc bodies are dropped, the opening line is kept', () => {
  const cmd = "mkdir -p .jevellan/briefs && cat > .jevellan/briefs/a.md <<'EOF'\nNode >= 20 is required\nnpm run lint > out.txt\nEOF\nnode x.mjs";
  assert.equal(stripHeredocs(cmd), "mkdir -p .jevellan/briefs && cat > .jevellan/briefs/a.md <<'EOF'\nnode x.mjs");
});

test('read-only git is allowed, writing git is not', () => {
  for (const [sub, rest] of [['log', ' --oneline'], ['show', ' HEAD'], ['remote', ' -v'], ['worktree', ' list'], ['branch', ''], ['branch', ' --show-current'], ['config', ' --get user.name'], ['check-ignore', ' -v .jevellan/briefs/x.md']]) {
    assert.equal(readOnlyGit(sub, rest), true, `${sub}${rest}`);
  }
  for (const [sub, rest] of [['commit', ' -m x'], ['merge', ' main'], ['push', ''], ['worktree', ' add x'], ['branch', ' -D x'], ['branch', ' newname'], ['remote', ' add o u'], ['checkout', ' main']]) {
    assert.equal(readOnlyGit(sub, rest), false, `${sub}${rest}`);
  }
});

test('a transcript with an Edit of a project file and a git merge has two slips; briefs under .jevellan are fine', () => {
  const project = tempDir('jh-coord-');
  const file = path.join(project, 't.jsonl');
  const entry = (content) => JSON.stringify({ type: 'assistant', message: { content } });
  fs.writeFileSync(file, [
    entry([{ type: 'tool_use', id: '1', name: 'Write', input: { file_path: path.join(project, '.jevellan', 'briefs', 'a.md') } }]),
    entry([{ type: 'tool_use', id: '2', name: 'Edit', input: { file_path: path.join(project, 'README.md') } }]),
    entry([{ type: 'tool_use', id: '3', name: 'Bash', input: { command: 'git merge main && git log --oneline' } }]),
    entry([{ type: 'tool_use', id: '4', name: 'Skill', input: { skill: 'jevellan-ledger' } }]),
    entry([{ type: 'text', text: 'Done.' }]),
  ].join('\n'));
  const r = analyse(file, project);
  assert.equal(r.slips.length, 2, r.slips.join(' | '));
  assert.deepEqual(r.skills, ['jevellan-ledger']);
  assert.equal(r.idle, true);
});

test('a > inside quotes is not a redirect', () => {
  assert.equal(unquoted("git show --format='%an <%ae>%n%s' HEAD"), "git show --format='' HEAD");
  assert.equal(unquoted('echo "a > b" > out.txt'), 'echo "" > out.txt');
});

test('separators and arrows inside a quoted script are not commands or redirects', () => {
  const dir = fs.realpathSync(tempDir('jh-slips-'));
  const file = path.join(dir, 't.jsonl');
  const bash = (command) => JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${command.length}`, name: 'Bash', input: { command } }] } });
  fs.writeFileSync(file, [
    bash(`node ledger.mjs show T --json | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s).events){console.log(e.seq)}})'`),
    bash('echo hi > notes.txt'),
    bash('cat x > .jevellan/briefs/b.md'),
    bash("node -e 'require(\"fs\").copyFileSync(\"a\",\"b\")' && cp a .jevellan/report.json"),
    bash('SP=/tmp/claude-x/scratchpad\n{ echo a; } > $SP/prompt.md'),
  ].join('\n') + '\n');
  const slips = analyse(file, dir).slips;
  assert.equal(slips.filter((s) => /notes\.txt/.test(s)).length, 1, slips.join(' | '));
  assert.equal(slips.filter((s) => /wrote a report/.test(s)).length, 1, slips.join(' | '));
  assert.equal(slips.length, 2, slips.join(' | '));
});
