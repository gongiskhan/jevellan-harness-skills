#!/usr/bin/env node
// Trigger evals (brief section 10): does each skill fire on the requests and role phrases it owns, and stay quiet on
// the near misses that belong to another skill?
//
//   node scripts/run-trigger-evals.mjs [--skill <name>]... [--model claude-sonnet-5-5] [--effort low]
//       [--provider claude-second] [--parallel 6] [--runs 1] [--split all|tuning|held-out] [--limit N]
//       [--out evals/RESULTS.md] [--timeout <seconds>] [--root <repo root>] [--keep] [--dry-run]
//       [--merge evals/results.json]
//
// Cases live in skills/<name>/evals/trigger-cases.json: a JSON array in Skillio's trigger-set format, {"query",
// "should_trigger", "held_out"}, with optional fields for the chained links of brief section 3:
//
//   role_phrase: true              the query carries one of the explicit role phrases (or the SessionStart line, or the
//                                  runtime's duty line); these cases have the stricter threshold
//   context_role: "<role>"         the calling skill, named by its role (a case never names another skill): the one
//   context_for: "<value>"         skill with that jh-role, narrowed by context_for when several hold it (a runtime's
//                                  provider kind in jh-kinds, a duty's jh-duty, a workflow's jh-kind). Its SKILL.md
//                                  body goes into the system prompt with --append-system-prompt, introduced as "The
//                                  skill <name> is loaded; follow its instructions:", as if that skill had been invoked
//                                  earlier in the session. The resolved name is kept as context_skill in the results.
//   context_skill: "<skill name>"  the older form, still read from results files; in a case file it may name only
//                                  the case file's own skill
//   remove_role: "<role>"          the skills whose jh-role is <role> are left out of the install; the case needs
//   expect_role_missing: "<role>"  should_trigger false, expect_role_missing equal to remove_role, role_phrase true,
//                                  and must live in the case file of a skill with that role
//
// For every case and run the script makes a temporary git project (under JH_TEST_TMPDIR, else the system temporary
// folder) with the repository's skills copied into .claude/skills (each without its evals/ folder; minus the removed
// role's skills) and runs one `claude -p` in it with --model, --effort, --tools Skill, --permission-mode dontAsk,
// --max-turns 2, --output-format stream-json --verbose, --no-session-persistence, the worker settings (the owner's
// personal ~/.claude rules stay out), the context skill's body when there is one, then "--" and the query (--tools is
// variadic, docs/findings.md). The environment is built from scratch: the base keys, the provider's login from
// providers.json (read by the Claude runtime's env.mjs, never printed and never on a command line), CLAUDE_CONFIG_DIR
// set to <harness home>/claude-config-evals and ENABLE_CLAUDEAI_MCP_SERVERS=false. JH_CLAUDE_BIN replaces `claude`.
//
// Scoring, per run: a positive passes when the case file's skill was invoked through the Skill tool (at any point of
// the two turns); a negative passes when it was not; a remove_role case passes when no skill of the removed role was
// invoked and the answer names the missing role (one sentence holds the role word and one of: missing, not installed,
// isn't installed, aren't installed, no skill, no <role> skill, not available, isn't available). A run that crashed,
// timed out, ended without a result or did not load the installed skills is retried once; if it fails again it is an
// error, which never counts as a pass.
//
// Thresholds, per skill: at least 90 percent of the positive runs pass, at most 5 percent of the negative runs fail,
// and at least 98 percent of the role-phrase runs pass. --limit N keeps at most N cases per skill, taken in file order
// after --split and alternating positives and negatives, so a limited run still sees both sides. --out is resolved
// against the repository root; results.json is written next to it.
//
// Exit codes: 0 every skill meets the thresholds, 1 at least one does not, 2 the evals cannot run (bad arguments or
// case files, no provider or token, no claude binary, or no run completed).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ROLES, readSkills } from './check-roles.mjs';
import {
  BASE_KEYS,
  findProvider,
  harnessHome,
  joinPath,
  nodeBinary,
  ownerHome,
  providerLogin,
  workerSettings,
} from '../skills/jevellan-runtime-claude/scripts/lib/env.mjs';

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CASES_FILE = path.join('evals', 'trigger-cases.json');
export const THRESHOLDS = Object.freeze({ positive: 0.9, falsePositive: 0.05, rolePhrase: 0.98 });
export const MAX_TURNS = 3;
export const contextIntro = (name) => `The skill ${name} is loaded; follow its instructions:`;

const DEFAULTS = Object.freeze({
  model: 'claude-sonnet-5-5',
  effort: 'low',
  provider: 'claude-second',
  parallel: 6,
  runs: 1,
  split: 'all',
  limit: null,
  out: 'evals/RESULTS.md',
  timeout: 300,
  merge: null,
});
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const SPLITS = ['all', 'tuning', 'held-out'];
const CASE_KEYS = new Set(['query', 'should_trigger', 'held_out', 'role_phrase', 'context_role', 'context_for', 'context_skill', 'remove_role', 'expect_role_missing']);
// The frontmatter field context_for narrows a role by, for the roles held by several skills.
const CONTEXT_FOR = Object.freeze({ runtime: 'jh-kinds', duty: 'jh-duty', workflow: 'jh-kind' });
const SESSION_START_LINE = "This project's work runs through the coordinator skill";
const DUTY_LINE = /Your step is duty [a-z]+\. Use the duty skill for [a-z]+ now/;
const TEXT_KEEP = 600;
const EM_DASH = String.fromCharCode(0x2014);
const USAGE = [
  'usage: node scripts/run-trigger-evals.mjs [--skill <name>]... [--model <id>] [--effort low|medium|high|xhigh|max]',
  '         [--provider <name>] [--parallel N] [--runs N] [--split all|tuning|held-out] [--limit N] [--merge <results.json>]',
  '         [--out <file>] [--timeout <seconds>] [--root <repo root>] [--keep] [--dry-run]',
].join('\n');

class UsageError extends Error {}

// ---- arguments -----------------------------------------------------------------------------------------------------

function positiveInt(flag, raw) {
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new UsageError(`${flag} needs a whole number of at least 1, not "${raw}"`);
  return value;
}

export function parseArgs(argv) {
  const opts = { ...DEFAULTS, skills: [], root: null, keep: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    let arg = argv[i];
    let value;
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1;
    if (eq > 0) {
      value = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const take = () => {
      if (value !== undefined) return value;
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) throw new UsageError(`${arg} needs a value`);
      i += 1;
      return next;
    };
    switch (arg) {
      case '--skill': opts.skills.push(take()); break;
      case '--model': opts.model = take(); break;
      case '--effort': opts.effort = take(); break;
      case '--provider': opts.provider = take(); break;
      case '--parallel': opts.parallel = positiveInt(arg, take()); break;
      case '--runs': opts.runs = positiveInt(arg, take()); break;
      case '--split': opts.split = take(); break;
      case '--limit': opts.limit = positiveInt(arg, take()); break;
      case '--out': opts.out = take(); break;
      case '--timeout': opts.timeout = positiveInt(arg, take()); break;
      case '--root': opts.root = path.resolve(take()); break;
      case '--keep': opts.keep = true; break;
      case '--dry-run': opts.dryRun = true; break;
      case '--merge': opts.merge = take(); break;
      case '--help': case '-h': opts.help = true; break;
      default: throw new UsageError(`unknown argument "${argv[i]}"`);
    }
  }
  if (!EFFORTS.includes(opts.effort)) throw new UsageError(`--effort must be one of ${EFFORTS.join(', ')}`);
  if (!SPLITS.includes(opts.split)) throw new UsageError(`--split must be one of ${SPLITS.join(', ')}`);
  if (!opts.model.trim()) throw new UsageError('--model needs a model id');
  return opts;
}

// ---- cases ---------------------------------------------------------------------------------------------------------

const roleOf = (skill) => (typeof skill?.data?.['jh-role'] === 'string' ? skill.data['jh-role'] : null);

// The skill names holding each role, from every skill folder under root (installed or not).
export function roleMembers(skills) {
  const members = Object.fromEntries(ROLES.map((role) => [role, []]));
  for (const skill of skills) {
    const role = roleOf(skill);
    if (role && members[role]) members[role].push(skill.folder);
  }
  return members;
}

// The one skill holding `role`, narrowed by `forValue` (see CONTEXT_FOR). Returns {skill} or {problem}.
export function contextSkill(skills, role, forValue) {
  if (!ROLES.includes(role)) return { problem: `context_role "${role}" is not one of ${ROLES.join(', ')}` };
  let holders = skills.filter((s) => roleOf(s) === role);
  if (forValue !== undefined && forValue !== null) {
    const field = CONTEXT_FOR[role];
    if (!field) return { problem: `context_for applies only to the roles ${Object.keys(CONTEXT_FOR).join(', ')}, not ${role}` };
    if (typeof forValue !== 'string' || !forValue) return { problem: 'context_for must be a non-empty string' };
    holders = holders.filter((s) => {
      const value = s.data?.[field];
      return Array.isArray(value) ? value.includes(forValue) : value === forValue;
    });
  }
  const label = `context_role ${role}${forValue ? ` for ${forValue}` : ''}`;
  if (holders.length === 0) return { problem: `${label}: no skill under skills/ has it` };
  if (holders.length > 1) {
    return { problem: `${label}: ${holders.length} skills hold it (${holders.map((s) => s.folder).join(', ')}); add context_for (their ${CONTEXT_FOR[role] ?? 'role'})` };
  }
  return { skill: holders[0].folder };
}

function validateCase(raw, { file, index, skill, byName, skills }) {
  const where = `${file} case ${index}`;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { problems: [`${where}: not an object`] };
  const problems = [];
  let context = null;
  for (const key of Object.keys(raw)) if (!CASE_KEYS.has(key)) problems.push(`${where}: unknown field "${key}"`);
  if (typeof raw.query !== 'string' || !raw.query.trim()) problems.push(`${where}: query must be a non-empty string`);
  else if (raw.query.includes(EM_DASH)) problems.push(`${where}: query holds an em dash; use a plain dash`);
  if (typeof raw.should_trigger !== 'boolean') problems.push(`${where}: should_trigger must be true or false`);
  for (const key of ['held_out', 'role_phrase']) {
    if (raw[key] !== undefined && typeof raw[key] !== 'boolean') problems.push(`${where}: ${key} must be true or false`);
  }
  if (raw.context_skill !== undefined && raw.context_role !== undefined) {
    problems.push(`${where}: give context_role, not context_skill as well`);
  } else if (raw.context_skill !== undefined) {
    if (typeof raw.context_skill !== 'string' || !byName.has(raw.context_skill)) {
      problems.push(`${where}: context_skill "${raw.context_skill}" is not a skill under skills/`);
    } else if (raw.context_skill !== skill.folder) {
      problems.push(`${where}: context_skill names another skill, ${raw.context_skill}; name the calling skill by its role with context_role (and context_for)`);
    } else {
      context = raw.context_skill;
    }
  } else if (raw.context_role !== undefined) {
    const found = contextSkill(skills, raw.context_role, raw.context_for);
    if (found.problem) problems.push(`${where}: ${found.problem}`);
    else context = found.skill;
  }
  if (raw.context_for !== undefined && raw.context_role === undefined) problems.push(`${where}: context_for needs context_role`);
  if (context && raw.remove_role && roleOf(byName.get(context)) === raw.remove_role) {
    problems.push(`${where}: the calling skill ${context} has the removed role ${raw.remove_role}`);
  }
  if (raw.remove_role !== undefined) {
    if (!ROLES.includes(raw.remove_role)) problems.push(`${where}: remove_role "${raw.remove_role}" is not one of ${ROLES.join(', ')}`);
    else if (roleOf(skill) !== raw.remove_role) problems.push(`${where}: remove_role ${raw.remove_role} is not the role of ${skill.folder} (${roleOf(skill)})`);
    if (raw.should_trigger !== false) problems.push(`${where}: a remove_role case needs should_trigger false`);
    if (raw.expect_role_missing !== raw.remove_role) problems.push(`${where}: expect_role_missing must equal remove_role`);
    if (raw.role_phrase !== true) problems.push(`${where}: a remove_role case needs role_phrase true`);
  } else if (raw.expect_role_missing !== undefined) {
    problems.push(`${where}: expect_role_missing needs remove_role`);
  }
  return { problems, context };
}

// Reads the case files of the selected skills. Returns {cases, problems}; each case carries its skill and its
// 1-based index in the file.
export function loadCases(root, skills, selected) {
  const byName = new Map(skills.map((s) => [s.folder, s]));
  const cases = [];
  const problems = [];
  for (const name of selected) {
    const skill = byName.get(name);
    const file = path.join('skills', name, CASES_FILE).split(path.sep).join('/');
    if (!skill) {
      problems.push(`skills/${name}: no such skill`);
      continue;
    }
    let list;
    try {
      list = JSON.parse(fs.readFileSync(path.join(root, file), 'utf8'));
    } catch (error) {
      problems.push(`${file}: ${error.code === 'ENOENT' ? 'missing' : `does not parse (${error.message})`}`);
      continue;
    }
    if (!Array.isArray(list) || list.length === 0) {
      problems.push(`${file}: must be a non-empty JSON array`);
      continue;
    }
    list.forEach((raw, i) => {
      const found = validateCase(raw, { file, index: i + 1, skill, byName, skills });
      if (found.problems.length) {
        problems.push(...found.problems);
        return;
      }
      cases.push({
        skill: name,
        index: i + 1,
        query: raw.query,
        should_trigger: raw.should_trigger,
        held_out: raw.held_out === true,
        role_phrase: raw.role_phrase === true,
        context_role: raw.context_role ?? (found.context ? roleOf(byName.get(found.context)) : null),
        context_for: raw.context_for ?? null,
        context_skill: found.context,
        remove_role: raw.remove_role ?? null,
        expect_role_missing: raw.expect_role_missing ?? null,
      });
    });
  }
  return { cases, problems };
}

export const caseKind = (c) => (c.remove_role ? 'role-missing' : c.should_trigger ? 'positive' : 'negative');

// Positives and negatives alternated, each side in file order.
function alternate(list) {
  const pos = list.filter((c) => c.should_trigger);
  const neg = list.filter((c) => !c.should_trigger);
  const out = [];
  for (let i = 0; i < Math.max(pos.length, neg.length); i += 1) {
    if (i < pos.length) out.push(pos[i]);
    if (i < neg.length) out.push(neg[i]);
  }
  return out;
}

export function selectCases(cases, { split = 'all', limit = null } = {}) {
  const inSplit = cases.filter((c) => split === 'all' || (split === 'held-out' ? c.held_out : !c.held_out));
  if (!limit) return inSplit;
  const out = [];
  for (const skill of [...new Set(inSplit.map((c) => c.skill))]) {
    out.push(...alternate(inSplit.filter((c) => c.skill === skill)).slice(0, limit));
  }
  return out;
}

// ---- one run -------------------------------------------------------------------------------------------------------

const skillName = (value) => (typeof value === 'string' ? value.trim().replace(/^\//, '').replace(/^.*:/, '') : '');

// The stream-json output of one `claude -p`: the skills the Skill tool invoked, in order, the final text, the result
// event and the init event's skill list.
export function parseStream(text) {
  const out = { skills: [], finalText: '', texts: [], result: null, init: null };
  for (const line of String(text ?? '').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (event.type === 'system' && event.subtype === 'init') {
      out.init = { skills: Array.isArray(event.skills) ? event.skills.map(String) : null, version: event.claude_code_version ?? null };
    } else if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
      for (const block of event.message.content) {
        if (block?.type === 'tool_use' && block.name === 'Skill') {
          const name = skillName(block.input?.skill);
          if (name) out.skills.push(name);
        } else if (block?.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
          out.texts.push(block.text);
        }
      }
    } else if (event.type === 'result') {
      out.result = {
        subtype: event.subtype ?? null,
        isError: event.is_error === true,
        text: typeof event.result === 'string' ? event.result : '',
        costUsd: Number.isFinite(event.total_cost_usd) ? event.total_cost_usd : 0,
        turns: Number.isFinite(event.num_turns) ? event.num_turns : null,
      };
    }
  }
  out.finalText = out.result?.text?.trim() ? out.result.text : out.texts.join('\n\n');
  return out;
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// True when one sentence of the answer holds the role word and a word saying it is missing.
export function namesMissingRole(text, role) {
  if (!text || !role) return false;
  const normal = String(text).replace(/[‘’]/g, "'").replace(/[*_`]/g, '').toLowerCase();
  const r = escapeRegExp(role.toLowerCase());
  const roleWord = new RegExp(`\\b${r}\\b`);
  const markers = [
    /\bmissing\b/, /\bnot installed\b/, /\bisn't installed\b/, /\baren't installed\b/, /\bno skills?\b/,
    new RegExp(`\\bno ${r}(?:-role| role)? skills?\\b`), /\bnot available\b/, /\bisn't available\b/,
    /\bno installed skill\b/, /\bnone of (?:the|my|your|our|these) (?:installed |available )?skills\b/, /\bno skill in\b/, /\bnothing (?:here |installed )?(?:has|covers)\b/,
    /\b(?:doesn't|does not|don't|do not) have\b/, /\bunavailable\b/, /\bcan't find\b/, /\bcannot find\b/, /\blacks?\b/,
  ];
  return normal.split(/(?<=[.!?])\s+|\n+/).some((sentence) => roleWord.test(sentence) && markers.some((m) => m.test(sentence)));
}

// The run's error, or null when it measured something.
export function runError(child, parsed, installed, timeoutSeconds) {
  if (child.spawnError) return `could not start claude (${child.spawnError.code ?? child.spawnError.message})`;
  if (child.timedOut) return `timed out after ${timeoutSeconds} s`;
  const tail = String(child.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(0, 300);
  if (!parsed.result) return `no result event (exit ${child.code ?? child.signal})${tail ? `: ${tail}` : ''}`;
  if (parsed.result.isError && parsed.result.subtype !== 'error_max_turns') {
    return `claude reported ${parsed.result.subtype ?? 'an error'}: ${parsed.result.text.replace(/\s+/g, ' ').slice(0, 300)}`;
  }
  if (parsed.init?.skills) {
    const missing = installed.filter((name) => !parsed.init.skills.includes(name));
    if (missing.length) return `installed skills not loaded: ${missing.join(', ')}`;
  }
  return null;
}

export function scoreRun(c, outcome, members) {
  if (outcome.error) return { passed: false, fired: false, namedMissing: null };
  // With the role's skills removed the session must invoke nothing at all (section 10: "must not invoke anything"), not
  // even a guessed name, and must say which role is missing.
  if (c.remove_role) {
    const fired = outcome.invoked.length > 0;
    const namedMissing = namesMissingRole(outcome.finalText, c.expect_role_missing);
    return { passed: !fired && namedMissing, fired, namedMissing };
  }
  // A positive passes when the skill fires within the run's turns. A negative fails only when the skill is the session's
  // first choice: a later call that the first skill's own instructions lead to (the router's body says to use the ledger
  // skill) is the chain working, not a false trigger.
  if (c.should_trigger) {
    const fired = outcome.invoked.includes(c.skill);
    return { passed: fired, fired, namedMissing: null };
  }
  const fired = outcome.invoked[0] === c.skill;
  return { passed: !fired, fired, namedMissing: null };
}

export function claudeArgs({ model, effort, contextText, query, cwd }) {
  const args = [
    '-p', '--model', model, '--effort', effort,
    '--tools', 'Skill,Read,Glob,Grep', '--permission-mode', 'dontAsk', '--max-turns', String(MAX_TURNS),
    '--output-format', 'stream-json', '--verbose', '--no-session-persistence',
    '--settings', workerSettings(cwd),
  ];
  if (contextText) args.push('--append-system-prompt', contextText);
  args.push('--', query);
  return args;
}

function childEnvironment(login, configDir) {
  const env = {};
  for (const key of BASE_KEYS) if (process.env[key]) env[key] = process.env[key];
  env.HOME = env.HOME || ownerHome();
  env.LANG = env.LANG || 'C.UTF-8';
  env.TERM = env.TERM || 'dumb';
  env.PATH = joinPath([path.dirname(nodeBinary())], process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin');
  Object.assign(env, login);
  env.CLAUDE_CONFIG_DIR = configDir;
  env.ENABLE_CLAUDEAI_MCP_SERVERS = 'false';
  env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS = '1';
  env.DISABLE_AUTOUPDATER = '1';
  return env;
}

export function resolveClaude(value = process.env.JH_CLAUDE_BIN || 'claude') {
  const candidates = value.includes('/')
    ? [path.resolve(value)]
    : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map((dir) => path.join(dir, value));
  for (const file of candidates) {
    try {
      fs.accessSync(file, fs.constants.X_OK);
      if (fs.statSync(file).isFile()) return file;
    } catch {}
  }
  return null;
}

// A temporary git project with the given skills copied into .claude/skills, each without its evals/ folder.
export const FIXTURE_APP = {
  'README.md': '# Shop\n\nA small Node and TypeScript app for invoices and customers.\n',
  'AGENTS.md': '# Shop\n\nWork in your task worktree. Tests: npm test.\n',
  'package.json': JSON.stringify({ name: 'shop', private: true, type: 'module', scripts: { start: 'tsx src/web/server.ts', test: 'vitest run', lint: 'tsc --noEmit', 'test:browser': 'playwright test' } }, null, 2) + '\n',
  'src/invoices/index.ts': 'export type Line = { quantity: number; unitPrice: number };\nexport const lineTotalCents = (l: Line) => Math.round(l.quantity * l.unitPrice * 100);\nexport const invoiceTotalCents = (lines: Line[]) => lines.reduce((sum, l) => sum + lineTotalCents(l), 0);\n',
  'src/customers/index.ts': 'export type Customer = { id: string; name: string; vat: string };\nexport const customers = () => { const rows: Customer[] = []; return { list: async () => rows }; };\n',
  'src/web/server.ts': "import { createServer } from 'node:http';\nimport { customers } from '../customers/index.js';\nconst escape = (t: string) => t.replaceAll('&', '&amp;').replaceAll('<', '&lt;');\nconst store = customers();\ncreateServer(async (req, res) => {\n  if (req.url?.startsWith('/customers')) { const rows = await store.list(); res.end('<table>' + rows.map((r) => '<tr><td>' + escape(r.name) + '</td></tr>').join('') + '</table>'); return; }\n  res.end('ok');\n}).listen(4173);\n",
  'src/invoices/index.test.ts': "import { expect, test } from 'vitest';\nimport { invoiceTotalCents } from './index.js';\ntest('total', () => { expect(invoiceTotalCents([{ quantity: 2, unitPrice: 5 }])).toBe(1000); });\n",
};

function makeProject(runDir, skills) {
  const dir = fs.mkdtempSync(path.join(runDir, 'project-'));
  const git = spawnSync('git', ['init', '-q', '-b', 'main', dir], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: ownerHome() } });
  if (git.status !== 0) throw new Error(`git init failed in ${dir}: ${(git.stderr || git.error?.message || '').trim()}`);
  // A small, realistic app, so a request about code meets code (an empty project made sessions answer "there is
  // nothing here" instead of choosing a skill). It mirrors what the cases talk about: a customers page, invoices,
  // package.json scripts.
  for (const [file, text] of Object.entries(FIXTURE_APP)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  const target = path.join(dir, '.claude', 'skills');
  fs.mkdirSync(target, { recursive: true });
  for (const skill of skills) {
    fs.cpSync(skill.dir, path.join(target, skill.folder), {
      recursive: true,
      filter: (src) => path.relative(skill.dir, src).split(path.sep)[0] !== 'evals',
    });
  }
  return dir;
}

const live = new Set();

function killGroup(child) {
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {}
  }
}

function runChild(bin, args, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    const res = { code: null, signal: null, stdout: '', stderr: '', timedOut: false, spawnError: null };
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve(res);
    };
    let child;
    try {
      child = spawn(bin, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      res.spawnError = error;
      finish();
      return;
    }
    live.add(child);
    const timer = setTimeout(() => {
      res.timedOut = true;
      killGroup(child);
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      res.stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      res.stderr = (res.stderr + chunk).slice(-8000);
    });
    child.on('error', (error) => {
      res.spawnError = error;
      clearTimeout(timer);
      live.delete(child);
      finish();
    });
    child.on('close', (code, signal) => {
      res.code = code;
      res.signal = signal;
      clearTimeout(timer);
      live.delete(child);
      finish();
    });
  });
}

async function runOnce(job, ctx, attempt) {
  const c = job.case;
  const installed = ctx.installFor(c.remove_role);
  const project = makeProject(ctx.runDir, installed);
  try {
    const contextText = c.context_skill ? `${contextIntro(c.context_skill)}\n\n${ctx.bodyOf(c.context_skill)}` : null;
    const args = claudeArgs({ model: ctx.model, effort: ctx.effort, contextText, query: c.query, cwd: project });
    const child = await runChild(ctx.bin, args, { cwd: project, env: ctx.env, timeoutMs: ctx.timeout * 1000 });
    const stream = path.join(ctx.runDir, 'streams', `${c.skill}-${c.index}-r${job.run}${attempt > 1 ? `-a${attempt}` : ''}.jsonl`);
    fs.writeFileSync(stream, ctx.redact(child.stdout));
    const parsed = parseStream(child.stdout);
    const installedNames = installed.map((s) => s.folder);
    const error = runError(child, parsed, installedNames, ctx.timeout);
    const known = parsed.init?.skills ?? installedNames;
    return {
      invoked: parsed.skills,
      unknownSkills: [...new Set(parsed.skills.filter((name) => !known.includes(name)))],
      finalText: ctx.redact(parsed.finalText),
      error: error ? ctx.redact(error) : null,
      subtype: parsed.result?.subtype ?? null,
      turns: parsed.result?.turns ?? null,
      costUsd: parsed.result?.costUsd ?? 0,
      version: parsed.init?.version ?? null,
    };
  } finally {
    // Claude Code leaves an empty projects/<cwd>/memory folder in the config folder even without session persistence;
    // only empty folders are removed.
    try {
      const left = path.join(ctx.configDir, 'projects', fs.realpathSync(project).replace(/[^a-zA-Z0-9]/g, '-'));
      for (const dir of [path.join(left, 'memory'), left]) {
        try {
          fs.rmdirSync(dir);
        } catch {}
      }
    } catch {}
    if (!ctx.keep) fs.rmSync(project, { recursive: true, force: true });
  }
}

async function runJob(job, ctx) {
  let outcome;
  let attempt = 0;
  while (attempt < 2) {
    attempt += 1;
    outcome = await runOnce(job, ctx, attempt);
    if (!outcome.error) break;
  }
  return { ...outcome, attempts: attempt, ...scoreRun(job.case, outcome, ctx.members) };
}

async function pool(items, parallel, worker) {
  const results = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const i = next;
      next += 1;
      results[i] = await worker(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallel, items.length) }, lane));
  return results;
}

// ---- summary -------------------------------------------------------------------------------------------------------

const tally = () => ({ runs: 0, passed: 0, fired: 0 });
const rate = (t) => (t.runs ? t.passed / t.runs : null);
const EPSILON = 1e-9;

export function linkOf(c) {
  const from = c.context_skill
    ?? (c.query.includes(SESSION_START_LINE) ? 'SessionStart line' : DUTY_LINE.test(c.query) ? 'runtime duty line' : 'prompt');
  const to = c.remove_role ? `${c.skill} (${c.remove_role} removed)` : c.should_trigger ? c.skill : `${c.skill} (must not fire)`;
  return `${from} -> ${to}`;
}

export function verdictFor(s, thresholds = THRESHOLDS) {
  const reasons = [];
  const pct = (x) => `${Math.round(x * 1000) / 10}%`;
  if (s.positives.runs && rate(s.positives) < thresholds.positive - EPSILON) {
    reasons.push(`positives ${s.positives.passed}/${s.positives.runs} below ${pct(thresholds.positive)}`);
  }
  if (s.negatives.runs) {
    const failed = s.negatives.runs - s.negatives.passed;
    if (failed / s.negatives.runs > thresholds.falsePositive + EPSILON) {
      reasons.push(`negatives failed ${failed}/${s.negatives.runs} above ${pct(thresholds.falsePositive)}`);
    }
  }
  if (s.rolePhrase.runs && rate(s.rolePhrase) < thresholds.rolePhrase - EPSILON) {
    reasons.push(`role-phrase runs ${s.rolePhrase.passed}/${s.rolePhrase.runs} below ${pct(thresholds.rolePhrase)}`);
  }
  return { ok: reasons.length === 0, reasons };
}

// caseResults: [{case, runs: [{passed, fired, error, ...}]}]. Returns {skills, links, totals}.
export function summarize(caseResults, skillNames, thresholds = THRESHOLDS) {
  const skills = new Map(skillNames.map((name) => [name, {
    skill: name,
    positives: tally(),
    negatives: tally(),
    roleMissing: tally(),
    rolePhrase: tally(),
    heldOut: { positives: tally(), negatives: tally() },
    errors: 0,
    costUsd: 0,
  }]));
  const links = new Map();
  const totals = { cases: caseResults.length, runs: 0, passed: 0, errors: 0, costUsd: 0 };
  for (const { case: c, runs } of caseResults) {
    const s = skills.get(c.skill);
    if (!s) continue;
    const kind = caseKind(c);
    for (const run of runs) {
      const buckets = [kind === 'positive' ? s.positives : kind === 'negative' ? s.negatives : s.roleMissing];
      if (c.held_out) buckets.push(c.should_trigger ? s.heldOut.positives : s.heldOut.negatives);
      if (c.role_phrase) {
        buckets.push(s.rolePhrase);
        const key = linkOf(c);
        if (!links.has(key)) links.set(key, { link: key, ...tally() });
        buckets.push(links.get(key));
      }
      for (const b of buckets) {
        b.runs += 1;
        if (run.passed) b.passed += 1;
        if (run.fired) b.fired += 1;
      }
      if (run.error) s.errors += 1;
      s.costUsd += run.costUsd ?? 0;
      totals.runs += 1;
      if (run.passed) totals.passed += 1;
      if (run.error) totals.errors += 1;
      totals.costUsd += run.costUsd ?? 0;
    }
  }
  for (const s of skills.values()) s.verdict = verdictFor(s, thresholds);
  return { skills: [...skills.values()], links: [...links.values()].sort((a, b) => a.link.localeCompare(b.link)), totals };
}

// ---- reports -------------------------------------------------------------------------------------------------------

const cell = (text) => String(text).replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
const frac = (t) => (t.runs ? `${t.passed}/${t.runs}` : '-');
const fracPct = (t) => (t.runs ? `${t.passed}/${t.runs} (${Math.round((t.passed / t.runs) * 100)}%)` : '-');
const oneLine = (text, max = 300) => {
  const flat = String(text ?? '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
};
const usd = (x) => `${(Math.round(x * 100) / 100).toFixed(2)} USD`;
const duration = (ms) => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
};

// The skills a run invoked, in order; a name that was not installed (a guess, or an agent's name) is marked.
export function invokedText(run) {
  if (!run.invoked?.length) return 'no skill';
  return run.invoked.map((name) => (run.unknownSkills?.includes(name) ? `${name} (not installed)` : name)).join(', ');
}

const roundUsd = (x) => Math.round((x ?? 0) * 10000) / 10000;

function caseLabel(c) {
  const parts = [caseKind(c)];
  if (c.held_out) parts.push('held out');
  if (c.role_phrase) parts.push('role phrase');
  if (c.context_skill) parts.push(`context ${c.context_skill}`);
  if (c.remove_role) parts.push(`${c.remove_role} removed`);
  return parts.join(', ');
}

// A run of some skills merged into the recorded results of a full run (`--merge <results.json>`): the skills this run
// measured replace theirs, every other skill of the package keeps its recorded cases and runs, and a skill of the
// recorded run that is no longer in the package (renamed or retired) is left out and named. Thresholds and totals are
// worked out again over the merged cases. `meta.merged` says which skill was measured when.
export function mergeResults(base, { meta, caseResults }, packageSkills) {
  if (!Array.isArray(base?.cases) || !Array.isArray(base?.skills)) throw new Error('not a results.json of this script');
  const measured = new Set(meta.selectedSkills);
  const kept = base.cases
    .filter((c) => !measured.has(c.skill) && packageSkills.includes(c.skill))
    .map(({ kind, runs, ...c }) => ({ case: c, runs }));
  const order = (r) => [packageSkills.indexOf(r.case.skill), r.case.index ?? 0];
  const merged = [...kept, ...caseResults].sort((a, b) => order(a)[0] - order(b)[0] || order(a)[1] - order(b)[1]);
  const keptSkills = packageSkills.filter((s) => !measured.has(s) && base.skills.some((r) => r.skill === s));
  const dropped = base.skills.map((r) => r.skill).filter((s) => !packageSkills.includes(s));
  const names = packageSkills.filter((s) => measured.has(s) || keptSkills.includes(s));
  const measuredAt = Object.fromEntries(names.map((s) => [s, measured.has(s) ? meta.date : base.measuredAt?.[s] ?? base.date]));
  return {
    meta: { ...meta, merged: { from: base.date, fromRuns: base.runs, remeasured: [...measured], kept: keptSkills, dropped, measuredAt } },
    summary: summarize(merged, names),
    caseResults: merged,
  };
}

export function renderResults({ meta, summary, caseResults }) {
  const out = [];
  const { totals } = summary;
  const failing = summary.skills.filter((s) => !s.verdict.ok);
  out.push('# Trigger evals', '');
  if (meta.merged) {
    const m = meta.merged;
    out.push(
      `Merged results. ${m.remeasured.join(' and ')} measured again on ${meta.date}; the other ${m.kept.length} skills keep the measurement of ${m.from} `
      + `(${m.fromRuns} run${m.fromRuns === 1 ? '' : 's'} per case)${m.dropped.length ? `; ${m.dropped.join(', ')} from that run is no longer in the package and is left out (runs recorded before a rename name the skill as it was then)` : ''}. `
      + 'Totals and verdicts below are over the merged cases.',
      '',
    );
  }
  // A merged file's totals cover every skill; the time and the cost of the run itself are its own cases'.
  const own = meta.merged ? summarize(caseResults.filter((r) => meta.merged.remeasured.includes(r.case.skill)), meta.merged.remeasured).totals : null;
  out.push(
    `Run of ${meta.date}: \`claude -p\`${meta.claudeVersion ? ` (Claude Code ${meta.claudeVersion})` : ''} with model ${meta.model}, effort ${meta.effort}, `
    + `provider ${meta.provider}, ${meta.runs} run${meta.runs === 1 ? '' : 's'} per case, split ${meta.split}`
    + `${meta.limit ? `, at most ${meta.limit} cases per skill` : ''}; `
    + (own
      ? `this run ${own.cases} cases, ${own.runs} runs, ${own.errors} errors, ${duration(meta.elapsedMs)}, cost ${usd(own.costUsd)}; merged ${summary.skills.length} skills, ${totals.cases} cases, ${totals.runs} runs, ${totals.errors} errors.`
      : `${summary.skills.length} skill${summary.skills.length === 1 ? '' : 's'}, ${totals.cases} cases, ${totals.runs} runs, ${totals.errors} errors, ${duration(meta.elapsedMs)}, cost ${usd(totals.costUsd)}.`),
  );
  out.push('');
  out.push(
    `Each run is one \`claude -p\` session in a temporary git project with the skills in .claude/skills, the Skill tool and the read-only Read, Glob and Grep, `
    + `--permission-mode dontAsk and --max-turns ${MAX_TURNS}. Thresholds per skill: at least ${THRESHOLDS.positive * 100}% of the positive runs `
    + `invoke the skill, at most ${THRESHOLDS.falsePositive * 100}% of the negative runs pick the skill as their first one, and at least ${THRESHOLDS.rolePhrase * 100}% of the `
    + 'role-phrase runs pass. A role-missing run (the role\'s skills not installed) passes when it invokes no skill at all and the '
    + 'answer names the missing role. An error never counts as a pass.',
  );
  const smallPhrase = summary.skills.some((s) => s.rolePhrase.runs && s.rolePhrase.runs < 50);
  if (smallPhrase) out.push('', 'With fewer than 50 role-phrase runs per skill, the 98% threshold means every role-phrase run must pass.');
  out.push('');
  out.push(failing.length
    ? `Verdict: ${failing.length} of ${summary.skills.length} skills below the thresholds: ${failing.map((s) => s.skill).join(', ')}.`
    : `Verdict: every skill meets the thresholds.`);
  out.push('', '## Per skill', '');
  out.push('| Skill | Positives | False negatives | False positives | Role missing | Role phrase | Held-out positives | Held-out negatives | Errors | Verdict |');
  out.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
  for (const s of summary.skills) {
    out.push(`| ${cell(s.skill)} | ${fracPct(s.positives)} | ${s.positives.runs ? s.positives.runs - s.positives.passed : '-'} | `
      + `${s.negatives.runs ? `${s.negatives.fired}/${s.negatives.runs}` : '-'} | ${frac(s.roleMissing)} | ${fracPct(s.rolePhrase)} | `
      + `${frac(s.heldOut.positives)} | ${frac(s.heldOut.negatives)} | ${s.errors} | ${s.verdict.ok ? 'meets' : cell(`below: ${s.verdict.reasons.join('; ')}`)} |`);
  }
  out.push('', '## Links (role-phrase cases)', '');
  if (summary.links.length) {
    out.push('| Link | Passed | Rate |', '| --- | --- | --- |');
    for (const l of summary.links) out.push(`| ${cell(l.link)} | ${l.passed}/${l.runs} | ${Math.round((l.passed / l.runs) * 100)}% |`);
  } else {
    out.push('No role-phrase case ran.');
  }
  out.push('', '## Failing cases', '');
  const failed = caseResults.filter((r) => r.runs.some((run) => !run.passed));
  if (!failed.length) out.push('None.');
  for (const { case: c, runs } of failed) {
    out.push(`### ${c.skill} case ${c.index} (${caseLabel(c)})`, '');
    for (const line of c.query.split('\n')) out.push(`> ${line}`.trimEnd());
    out.push('');
    runs.forEach((run, i) => {
      let line = `- Run ${i + 1}: ${run.passed ? 'passed' : 'failed'}; invoked ${invokedText(run)}`;
      if (run.error) line += `; error: ${oneLine(run.error, 300)}`;
      if (c.remove_role) line += `; named the missing role: ${run.namedMissing ? 'yes' : 'no'}`;
      if (run.finalText && (c.remove_role || !run.passed)) line += `; answer: "${oneLine(run.finalText, 300)}"`;
      out.push(line);
    });
    out.push('');
  }
  const missingRuns = caseResults.filter((r) => r.case.remove_role);
  if (missingRuns.length) {
    out.push('', '## Role-missing runs', '');
    out.push('Every run of a case whose role was not installed: what it invoked and how it answered.', '');
    for (const { case: c, runs } of missingRuns) {
      runs.forEach((run, i) => {
        const from = c.context_skill ? `, context ${c.context_skill}` : '';
        let line = `- ${c.skill} case ${c.index} (${c.remove_role} removed${from}), run ${i + 1}: ${run.passed ? 'passed' : 'failed'}; invoked ${invokedText(run)}`;
        if (run.error) line += `; error: ${oneLine(run.error, 200)}`;
        else line += `; answer: "${oneLine(run.finalText, 200)}"`;
        out.push(line);
      });
    }
  }
  const guesses = caseResults.flatMap(({ case: c, runs }) => (c.remove_role ? [] : runs.map((run, i) => ({ c, run, i })).filter(({ run }) => run.unknownSkills?.length)));
  if (guesses.length) {
    out.push('', '## Skill calls to names that were not installed', '');
    for (const { c, run, i } of guesses) out.push(`- ${c.skill} case ${c.index} (${caseLabel(c)}), run ${i + 1}: ${run.unknownSkills.join(', ')}`);
  }
  return `${out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd()}\n`;
}

function resultsJson({ meta, summary, caseResults }) {
  return {
    ...meta,
    ...(meta.merged ? { measuredAt: meta.merged.measuredAt } : {}),
    thresholds: THRESHOLDS,
    verdict: { ok: summary.skills.every((s) => s.verdict.ok), failingSkills: summary.skills.filter((s) => !s.verdict.ok).map((s) => s.skill) },
    totals: { ...summary.totals, costUsd: roundUsd(summary.totals.costUsd) },
    skills: summary.skills.map((s) => ({ ...s, costUsd: roundUsd(s.costUsd) })),
    links: summary.links,
    cases: caseResults.map(({ case: c, runs }) => ({
      ...c,
      kind: caseKind(c),
      runs: runs.map((run) => ({
        passed: run.passed,
        fired: run.fired,
        invoked: run.invoked ?? [],
        unknownSkills: run.unknownSkills ?? [],
        namedMissing: run.namedMissing,
        error: run.error,
        attempts: run.attempts,
        subtype: run.subtype,
        turns: run.turns,
        costUsd: roundUsd(run.costUsd),
        finalText: oneLine(run.finalText, TEXT_KEEP),
      })),
    })),
  };
}

// ---- the command ---------------------------------------------------------------------------------------------------

const say = (text) => process.stdout.write(`${text}\n`);
const fail = (code, text) => {
  process.stderr.write(`run-trigger-evals: ${text}\n`);
  return code;
};

function printPlan(selected, chosen) {
  for (const name of selected) {
    const mine = chosen.filter((c) => c.skill === name);
    const count = (pred) => mine.filter(pred).length;
    say(`${name}: ${mine.length} cases, ${count((c) => c.should_trigger)} positive, ${count((c) => !c.should_trigger && !c.remove_role)} negative, `
      + `${count((c) => c.remove_role)} role-missing, ${count((c) => c.role_phrase)} role-phrase, ${count((c) => c.held_out)} held out`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (error instanceof UsageError) return fail(2, `${error.message}\n${USAGE}`);
    throw error;
  }
  if (opts.help) {
    say(USAGE);
    return 0;
  }
  const root = opts.root ?? REPO;
  const { skills } = readSkills(root);
  if (!skills.length) return fail(2, `no skills under ${path.join(root, 'skills')}`);
  const selected = opts.skills.length ? [...new Set(opts.skills)] : skills.map((s) => s.folder);
  const { cases, problems } = loadCases(root, skills, selected);
  if (problems.length) return fail(2, `the case files have problems:\n${problems.join('\n')}`);
  const chosen = selectCases(cases, opts);
  if (!chosen.length) return fail(2, `no case to run (split ${opts.split})`);
  if (opts.dryRun) {
    printPlan(selected, chosen);
    return 0;
  }

  let login;
  try {
    login = providerLogin(findProvider(opts.provider));
  } catch (error) {
    const named = [' ', ':'].some((next) => error.message.startsWith(`provider ${opts.provider}${next}`));
    return fail(2, named ? error.message : `provider ${opts.provider}: ${error.message}`);
  }
  const secrets = Object.entries(login).filter(([key]) => /TOKEN|KEY|SECRET/.test(key)).map(([, value]) => value).filter(Boolean);
  if (!secrets.length) return fail(2, `provider ${opts.provider} names no token file; the evals run on a provider token`);
  const redact = (text) => secrets.reduce((acc, secret) => acc.split(secret).join('[redacted]'), String(text ?? ''));
  const bin = resolveClaude();
  if (!bin) return fail(2, `no claude binary (${process.env.JH_CLAUDE_BIN ? `JH_CLAUDE_BIN ${process.env.JH_CLAUDE_BIN}` : 'claude on PATH'})`);

  const configDir = path.join(harnessHome(), 'claude-config-evals');
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const base = process.env.JH_TEST_TMPDIR || os.tmpdir();
  fs.mkdirSync(base, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(base, 'jh-trigger-evals-'));
  fs.mkdirSync(path.join(runDir, 'streams'));

  const byName = new Map(skills.map((s) => [s.folder, s]));
  const installs = new Map();
  const ctx = {
    bin,
    configDir,
    env: childEnvironment(login, configDir),
    model: opts.model,
    effort: opts.effort,
    timeout: opts.timeout,
    keep: opts.keep,
    runDir,
    redact,
    members: roleMembers(skills),
    bodyOf: (name) => byName.get(name).body.trim(),
    installFor: (role) => {
      const key = role ?? '';
      if (!installs.has(key)) installs.set(key, skills.filter((s) => !role || roleOf(s) !== role));
      return installs.get(key);
    },
  };
  try {
    fs.rmSync(makeProject(runDir, ctx.installFor(null)), { recursive: true, force: true });
  } catch (error) {
    return fail(2, `cannot make a temporary project: ${error.message}`);
  }

  const stop = () => {
    for (const child of live) killGroup(child);
    process.stderr.write('run-trigger-evals: interrupted\n');
    process.exit(2);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  const jobs = chosen.flatMap((c) => Array.from({ length: opts.runs }, (_, i) => ({ case: c, run: i + 1 })));
  say(`run-trigger-evals: ${jobs.length} runs of ${chosen.length} cases over ${selected.length} skill${selected.length === 1 ? '' : 's'}, `
    + `model ${opts.model}, effort ${opts.effort}, provider ${opts.provider}, ${opts.parallel} in parallel`);
  const started = Date.now();
  let done = 0;
  const width = String(jobs.length).length;
  const outcomes = await pool(jobs, opts.parallel, async (job) => {
    const result = await runJob(job, ctx);
    done += 1;
    const c = job.case;
    const what = result.error ? `error: ${oneLine(result.error, 120)}` : `invoked ${invokedText(result)}`;
    say(`[${String(done).padStart(width)}/${jobs.length}] ${result.passed ? 'pass' : 'FAIL'} ${c.skill} case ${c.index} (${caseKind(c)}): ${what}`);
    return result;
  });
  process.off('SIGINT', stop);
  process.off('SIGTERM', stop);

  const byCase = new Map(chosen.map((c) => [c, { case: c, runs: [] }]));
  jobs.forEach((job, i) => byCase.get(job.case).runs.push(outcomes[i]));
  const caseResults = [...byCase.values()];
  const summary = summarize(caseResults, selected);
  const meta = {
    date: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    model: opts.model,
    effort: opts.effort,
    provider: opts.provider,
    runs: opts.runs,
    split: opts.split,
    limit: opts.limit,
    parallel: opts.parallel,
    selectedSkills: selected,
    claudeVersion: outcomes.find((o) => o.version)?.version ?? null,
    elapsedMs: Date.now() - started,
  };
  const outFile = path.resolve(root, opts.out);
  const jsonFile = path.join(path.dirname(outFile), 'results.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  let written = { meta, summary, caseResults };
  if (opts.merge) {
    try {
      written = mergeResults(JSON.parse(fs.readFileSync(path.resolve(root, opts.merge), 'utf8')), { meta, caseResults }, skills.map((s) => s.folder));
    } catch (error) {
      return fail(2, `--merge ${opts.merge}: ${error.message} (this run's results are in ${runDir}/streams)`);
    }
  }
  fs.writeFileSync(outFile, redact(renderResults(written)));
  fs.writeFileSync(jsonFile, `${redact(JSON.stringify(resultsJson(written), null, 2))}\n`);

  say('');
  const nameWidth = Math.max(...summary.skills.map((s) => s.skill.length));
  for (const s of summary.skills) {
    say(`${s.skill.padEnd(nameWidth)}  positives ${frac(s.positives)}  false positives ${s.negatives.runs ? `${s.negatives.fired}/${s.negatives.runs}` : '-'}  `
      + `role missing ${frac(s.roleMissing)}  role phrase ${frac(s.rolePhrase)}  errors ${s.errors}  ${s.verdict.ok ? 'meets' : `below: ${s.verdict.reasons.join('; ')}`}`);
  }
  say(`${summary.totals.passed}/${summary.totals.runs} runs passed, ${summary.totals.errors} errors, ${duration(meta.elapsedMs)}, cost ${usd(summary.totals.costUsd)}`);
  say(`wrote ${path.relative(process.cwd(), outFile) || outFile} and ${path.relative(process.cwd(), jsonFile) || jsonFile}; streams in ${path.join(runDir, 'streams')}`);
  if (summary.totals.runs > 0 && summary.totals.errors === summary.totals.runs) return fail(2, 'no run completed; see the errors in the results');
  const failing = summary.skills.filter((s) => !s.verdict.ok);
  if (failing.length) {
    say(`exit 1: ${failing.length} skill${failing.length === 1 ? '' : 's'} below the thresholds: ${failing.map((s) => s.skill).join(', ')}`);
    return 1;
  }
  say('exit 0: every skill meets the thresholds');
  return 0;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return fs.realpathSync(process.argv[1]) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`run-trigger-evals: ${error?.stack ?? error}\n`);
      process.exitCode = 2;
    },
  );
}
