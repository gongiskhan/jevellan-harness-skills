// P7: one session of the owner's on a named provider (the Claude runtime's session.mjs, H-044) does a small real
// change in a scratch repository: edit, run the tests, commit on a branch. The same task on every provider, so a run
// on the default (claude-main) and one on an endpoint (deepseek-rtx) compare; docs/endpoint-sessions.md has the
// numbers.
//
//   node acceptance/p7-endpoint-session.mjs --provider <name> [--model M] [--effort E] [--from <providers.json>]
//
// The provider's entry comes from --from (default ~/.jevellan-harness/providers.json), or from providers.example.json
// when that file has no such entry; it is copied into a private harness home with its projects list set to the scratch
// repository alone, so the run needs no change to the live providers.json and the provider sees only the fixture. For
// a claude-endpoint provider the live check (probe.mjs) runs first and its checks are recorded. Writes
// acceptance/results/P7-<provider>.json. Real model calls: the subscription's quota or the endpoint's.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { parseArgs } from 'node:util';
import { HARNESS, Journey, NODE, OUT_DIR, REPO, git, sh } from './lib.mjs';

const { values } = parseArgs({ options: { provider: { type: 'string' }, model: { type: 'string' }, effort: { type: 'string', default: 'medium' }, from: { type: 'string' } }, strict: true });
if (!values.provider) {
  console.error('usage: node acceptance/p7-endpoint-session.mjs --provider <name> [--model M] [--effort E] [--from <providers.json>]');
  process.exit(2);
}

const BRANCH = 'proof/title-case';
const PROMPT = [
  'In this repository, add an exported function `titleCase(text)` to src/text.mjs: it upper-cases the first letter of',
  'every word and lower-cases the rest; words are separated by single spaces. Add tests for it to test/text.test.mjs.',
  'Run `npm test` and make sure every test passes. Then create a git branch named `proof/title-case`, commit your',
  'change on it with a one-line message, and reply with the commit hash.',
].join(' ');

// The fixture: a tiny Node project with one function and its tests, committed on main.
function fixture(dir) {
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'test'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), `${JSON.stringify({ name: 'p7-fixture', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
  fs.writeFileSync(path.join(dir, 'src', 'text.mjs'), "// Small text helpers.\n\nexport function slugify(text) {\n  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');\n}\n");
  fs.writeFileSync(path.join(dir, 'test', 'text.test.mjs'), "import { test } from 'node:test';\nimport assert from 'node:assert/strict';\nimport { slugify } from '../src/text.mjs';\n\ntest('slugify', () => {\n  assert.equal(slugify(' Hello, World! '), 'hello-world');\n});\n");
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), '# p7 fixture\n\nRun `npm test` before committing.\n');
  sh('git', ['-C', dir, 'init', '-q', '-b', 'main']);
  sh('git', ['-C', dir, 'add', '-A']);
  sh('git', ['-C', dir, '-c', 'commit.gpgsign=false', 'commit', '-q', '--no-verify', '-m', 'p7 fixture']);
}

function entryFor(name) {
  const sources = [values.from ?? path.join(HARNESS, 'providers.json'), path.join(REPO, 'providers.example.json')];
  for (const file of sources) {
    try {
      const entry = JSON.parse(fs.readFileSync(file, 'utf8')).providers.find((p) => p.name === name);
      if (entry) return { entry, file };
    } catch {}
  }
  return null;
}

// Reads a stream-json transcript: the result line, every tool call and every tool result that was an error.
function readStream(text) {
  const out = { result: null, tools: {}, toolErrors: [], apiErrors: [], assistantTurns: 0 };
  for (const line of text.split('\n')) {
    let j;
    try {
      j = JSON.parse(line);
    } catch {
      continue;
    }
    if (j.type === 'result') out.result = j;
    if (j.type === 'assistant') {
      out.assistantTurns += 1;
      if (j.error) out.apiErrors.push(String(j.error));
      for (const c of j.message?.content ?? []) if (c.type === 'tool_use') out.tools[c.name] = (out.tools[c.name] ?? 0) + 1;
    }
    if (j.type === 'user') {
      for (const c of j.message?.content ?? []) {
        if (c.type === 'tool_result' && c.is_error) out.toolErrors.push((typeof c.content === 'string' ? c.content : JSON.stringify(c.content)).slice(0, 200));
      }
    }
    if (j.type === 'system' && /api_error|retry/.test(j.subtype ?? '')) out.apiErrors.push(JSON.stringify(j).slice(0, 200));
  }
  return out;
}

const found = entryFor(values.provider);
const j = new Journey(`P7-${values.provider}`, `Session on ${values.provider}: edit, test, commit (H-044)`);
if (!found) {
  j.check(`provider ${values.provider} is in providers.json or providers.example.json`, false);
  j.finish();
  process.exit();
}
if (found.entry.kind === 'claude-endpoint') {
  const keyFile = String(found.entry.keyFile ?? '').replace(/^~(?=\/)/, os.userInfo().homedir);
  if (!keyFile || !fs.existsSync(keyFile)) {
    j.note(`provider entry from ${found.file}`);
    j.finish(`blocked: the key file ${found.entry.keyFile ?? '(none named)'} does not exist yet; save the key there with mode 600 and run this again`);
    process.exit();
  }
}
const root = fs.mkdtempSync(path.join(OUT_DIR, `p7-${values.provider}-`));
const repo = path.join(root, 'proof');
fixture(repo);
const home = path.join(root, 'harness');
fs.mkdirSync(home, { recursive: true, mode: 0o700 });
const entry = { ...found.entry, ...(found.entry.kind === 'claude-endpoint' ? { projects: [repo] } : {}) };
fs.writeFileSync(path.join(home, 'providers.json'), `${JSON.stringify({ providers: [entry] }, null, 2)}\n`);
j.note(`provider entry from ${found.file}; scratch repository ${repo}`);
const model = values.model ?? (Array.isArray(entry.models) ? entry.models[0].id : undefined);

if (entry.kind === 'claude-endpoint') {
  const probed = sh(NODE, [path.join(REPO, 'skills', 'jevellan-runtime-claude', 'scripts', 'probe.mjs'), '--provider', values.provider, '--json'], { env: { ...process.env, JH_HARNESS_HOME: home }, timeoutMs: 20 * 60 * 1000 });
  const out = probed.json;
  j.check('the live check ran', probed.status === 0 && out?.checks, out?.error ?? probed.stderr.slice(0, 300));
  for (const c of out?.checks ?? []) j.check(`live check ${c.name}`, c.ok, `HTTP ${c.status}, ${c.ms} ms: ${c.detail}`);
  if (out?.checks) j.note(`live check: ok ${out.ok}, thinking in tool loops ${out.thinking ? 'works' : 'fails'}`);
}

const session = path.join(REPO, 'skills', 'jevellan-runtime-claude', 'scripts', 'session.mjs');
const args = ['--provider', values.provider, '--cwd', repo, '--', '-p', PROMPT, '--model', model, '--effort', values.effort, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
const transcript = path.join(root, 'transcript.jsonl');
const t0 = Date.now();
const run = await new Promise((resolve) => {
  const child = spawn(NODE, [session, ...args], { cwd: repo, env: { ...process.env, JH_HARNESS_HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (c) => (stdout += c));
  child.stderr.on('data', (c) => (stderr += c));
  const timer = setTimeout(() => child.kill('SIGTERM'), 30 * 60 * 1000);
  child.on('exit', (code) => {
    clearTimeout(timer);
    resolve({ code, stdout, stderr });
  });
});
const elapsed = Date.now() - t0;
fs.writeFileSync(transcript, run.stdout, { mode: 0o600 });
j.time('session', elapsed);
const stream = readStream(run.stdout);
j.check('the session ended with exit 0', run.code === 0, run.code === 0 ? '' : run.stderr.slice(-400));
j.check('the result is a success', stream.result?.subtype === 'success' && !stream.result?.is_error, JSON.stringify({ subtype: stream.result?.subtype, is_error: stream.result?.is_error }));
const branchTip = git(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}`]) || null;
j.check(`branch ${BRANCH} exists`, Boolean(branchTip), branchTip ?? '');
const commits = branchTip ? Number(git(repo, ['rev-list', '--count', `main..${BRANCH}`])) : 0;
j.check('the branch carries the change in commits of its own', commits >= 1, `${commits} commit(s)`);
const files = branchTip ? git(repo, ['diff', '--name-only', `main...${BRANCH}`]).split('\n').filter(Boolean) : [];
j.check('the change is in src/text.mjs and test/text.test.mjs', files.includes('src/text.mjs') && files.includes('test/text.test.mjs'), files.join(', '));
const log = branchTip ? git(repo, ['log', '--format=%B', `main..${BRANCH}`]) : '';
j.check('the commits carry no attribution', !/co-authored-by|generated with/i.test(log), log.slice(0, 200));
if (branchTip) {
  const check = path.join(root, 'check');
  sh('git', ['-C', repo, 'worktree', 'add', '-q', '--detach', check, branchTip]);
  const tests = sh('npm', ['test', '--silent'], { cwd: check });
  j.check('npm test passes on the branch', tests.status === 0, tests.status === 0 ? '' : `${tests.stdout}${tests.stderr}`.slice(-400));
  const probe = sh(NODE, ['--input-type=module', '-e', `import { titleCase } from ${JSON.stringify(path.join(check, 'src', 'text.mjs'))}; console.log(JSON.stringify([titleCase('hello WORLD'), titleCase('a'), titleCase('mIxEd cAsE words')]))`]);
  j.check('titleCase does what was asked', probe.stdout.trim() === JSON.stringify(['Hello World', 'A', 'Mixed Case Words']), probe.stdout.trim() || probe.stderr.slice(0, 200));
}
j.check('no tool call failed', stream.toolErrors.length === 0, stream.toolErrors.join(' | '));
j.check('no API error', stream.apiErrors.length === 0, stream.apiErrors.join(' | '));
const r = stream.result ?? {};
j.note(`model ${model}, effort ${values.effort}; turns ${r.num_turns ?? '?'}, assistant messages ${stream.assistantTurns}; tools ${JSON.stringify(stream.tools)}; tool errors ${stream.toolErrors.length}; API errors ${stream.apiErrors.length}`);
j.note(`duration_ms ${r.duration_ms ?? '?'}, duration_api_ms ${r.duration_api_ms ?? '?'}, cost reported ${r.total_cost_usd ?? '?'} USD, usage ${JSON.stringify(r.usage ?? {})}`);
j.note(`transcript ${transcript}`);
j.finish();
