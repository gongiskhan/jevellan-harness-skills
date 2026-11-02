// H1 Install: install.mjs on the sandbox writes every skill folder (17 when the package is complete), the three hooks
// with absolute Node 22 paths into .claude/settings.json (other keys untouched), project.json with the detected
// commands and the three exclude lines; a second run changes nothing but its own entries; --skills-only writes
// skills and excludes only. The installed hooks are then seen to fire in a real `claude -p` session.

import fs from 'node:fs';
import path from 'node:path';
import { Journey, NODE, OUT_DIR, REPO, SANDBOX, SANDBOX_TEST_COMMAND, git, parseStream, runtimeEnvLib, sh } from './lib.mjs';

const j = new Journey('H1', 'Install');
const INSTALL = path.join(REPO, 'install.mjs');
const packageSkills = fs.readdirSync(path.join(REPO, 'skills')).filter((n) => n.startsWith('jevellan-') && fs.existsSync(path.join(REPO, 'skills', n, 'SKILL.md')));

// A key of the owner's that must survive the merge.
const settingsFile = path.join(SANDBOX, '.claude', 'settings.json');
fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
let settings = {};
try {
  settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
} catch {}
if (settings.cleanupPeriodDays !== 30) {
  settings.cleanupPeriodDays = 30;
  fs.writeFileSync(settingsFile, `${JSON.stringify(settings, null, 2)}\n`);
}

// Detection is checked on a fresh clone, because the sandbox's project.json is written once and then kept.
const scratch = fs.mkdtempSync(path.join(OUT_DIR, 'h1-'));
const clone = path.join(scratch, 'clone');
sh('git', ['clone', '--quiet', '--local', SANDBOX, clone]);
const fresh = sh(NODE, [INSTALL, clone, '--json']);
j.check('install on a fresh clone exits 0', fresh.status === 0, fresh.stderr.trim());
const freshProject = JSON.parse(fs.readFileSync(path.join(clone, '.jevellan', 'project.json'), 'utf8'));
j.check('project.json detects testCommand npm test', freshProject.testCommand === 'npm test', freshProject.testCommand);
j.check('project.json detects devCommand npm start (no dev script)', freshProject.devCommand === 'npm start', freshProject.devCommand);
j.check('project.json detects setupCommand npm ci (package-lock.json)', freshProject.setupCommand === 'npm ci', freshProject.setupCommand);
j.check('project.json defaultBranch main, pushAfterLanding false, retentionDays 3', freshProject.defaultBranch === 'main' && freshProject.pushAfterLanding === false && freshProject.retentionDays === 3, JSON.stringify(freshProject));

const first = sh(NODE, [INSTALL, SANDBOX, '--json']);
j.check('install on the sandbox exits 0', first.status === 0, first.stderr.trim());
const installed = fs.readdirSync(path.join(SANDBOX, '.claude', 'skills')).filter((n) => n.startsWith('jevellan-'));
j.check(`every package skill is installed (${packageSkills.length})`, packageSkills.every((n) => installed.includes(n)) && installed.length === packageSkills.length, installed.join(', '));
j.check('the package has 17 skills', packageSkills.length === 17, `${packageSkills.length} skill folders with SKILL.md`);
for (const name of packageSkills) {
  const same = sh('diff', ['-r', path.join(REPO, 'skills', name), path.join(SANDBOX, '.claude', 'skills', name)]);
  if (same.status !== 0) j.check(`${name} is a byte copy`, false, same.stdout.slice(0, 300));
}
j.check('installed skills are byte copies of the package', packageSkills.every((name) => sh('diff', ['-rq', path.join(REPO, 'skills', name), path.join(SANDBOX, '.claude', 'skills', name)]).status === 0));

settings = JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
const hooks = settings.hooks ?? {};
const commands = (event) => (hooks[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => ({ matcher: g.matcher, command: h.command })));
const ours = (event, file) => commands(event).filter((c) => c.command.includes(`jevellan-ledger/hooks/${file}`));
const abs = (c) => c.command.startsWith(`"${NODE}"`) && c.command.includes(`"${path.join(SANDBOX, '.claude', 'skills', 'jevellan-ledger', 'hooks')}`);
j.check('Stop hook installed with the absolute Node 22 path', ours('Stop', 'stop.mjs').length === 1 && abs(ours('Stop', 'stop.mjs')[0]), JSON.stringify(ours('Stop', 'stop.mjs')));
j.check('PostToolUse hook with matcher Bash|Edit|Write|MultiEdit|NotebookEdit', ours('PostToolUse', 'post-tool.mjs').length === 1 && ours('PostToolUse', 'post-tool.mjs')[0].matcher === 'Bash|Edit|Write|MultiEdit|NotebookEdit' && abs(ours('PostToolUse', 'post-tool.mjs')[0]));
const ss = ours('SessionStart', 'session-start.mjs');
j.check('SessionStart hook for startup, resume and compact', ss.length === 3 && ['startup', 'resume', 'compact'].every((m) => ss.some((c) => c.matcher === m)) && ss.every(abs), JSON.stringify(ss.map((c) => c.matcher)));
j.check('the owner key in settings.json is untouched', settings.cleanupPeriodDays === 30);
j.check('Node 22 is the hooks\' binary', sh(NODE, ['--version']).stdout.trim().startsWith('v22'), NODE);

const exclude = fs.readFileSync(path.join(SANDBOX, '.git', 'info', 'exclude'), 'utf8').split('\n').map((l) => l.trim().replace(/^\//, '').replace(/\/$/, ''));
j.check('the three exclude lines are present', ['.claude', '.jevellan', 'plan.md'].every((p) => exclude.includes(p)));

const second = sh(NODE, [INSTALL, SANDBOX, '--json']);
j.check('a second run changes nothing', second.status === 0 && Array.isArray(second.json?.changed) && second.json.changed.length === 0, JSON.stringify(second.json?.changed));

const clone2 = path.join(scratch, 'skills-only');
sh('git', ['clone', '--quiet', '--local', SANDBOX, clone2]);
const only = sh(NODE, [INSTALL, clone2, '--skills-only', '--json']);
j.check('--skills-only exits 0', only.status === 0, only.stderr.trim());
j.check('--skills-only writes the skills', fs.existsSync(path.join(clone2, '.claude', 'skills', 'jevellan-ledger', 'SKILL.md')));
j.check('--skills-only writes no settings.json and no .jevellan', !fs.existsSync(path.join(clone2, '.claude', 'settings.json')) && !fs.existsSync(path.join(clone2, '.jevellan')));
const exclude2 = fs.readFileSync(path.join(clone2, '.git', 'info', 'exclude'), 'utf8');
j.check('--skills-only writes the exclude lines', exclude2.includes('.jevellan/') || exclude2.includes('/.jevellan'));

// The sandbox's tests need TZ and SANDBOX_DATA_DIR (H-002).
const projectFile = path.join(SANDBOX, '.jevellan', 'project.json');
const project = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
if (project.testCommand !== SANDBOX_TEST_COMMAND || project.setupCommand !== 'npm ci') {
  project.testCommand = SANDBOX_TEST_COMMAND;
  project.setupCommand = 'npm ci';
  fs.writeFileSync(projectFile, `${JSON.stringify(project, null, 2)}\n`);
  j.note(`set the sandbox testCommand to "${SANDBOX_TEST_COMMAND}" (H-002) and setupCommand to "npm ci" (H-023), written once before H-023 existed`);
}

// The hooks fire in a real session after the install (a settings file that fails validation is ignored silently).
const { findProvider, workerSettings, claudeConfigDir } = await runtimeEnvLib();
const provider = findProvider('claude-second');
const { providerLogin } = await runtimeEnvLib();
const env = { PATH: process.env.PATH, HOME: process.env.HOME, USER: process.env.USER, LANG: 'C.UTF-8', TERM: 'dumb', SHELL: process.env.SHELL, TMPDIR: '/tmp', ...providerLogin(provider), CLAUDE_CONFIG_DIR: claudeConfigDir(), ENABLE_CLAUDEAI_MCP_SERVERS: 'false', CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' };
const t0 = Date.now();
const live = sh('claude', ['-p', '--model', 'claude-haiku-5-5', '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--settings', workerSettings(SANDBOX), '--tools', '', '--', 'Reply with the word OK.'], { cwd: SANDBOX, env, timeoutMs: 180_000 });
j.time('one-turn session in the sandbox', Date.now() - t0);
fs.writeFileSync(path.join(scratch, 'live.stream.jsonl'), live.stdout);
const stream = parseStream(live.stdout);
const ssResponse = stream.hooks.find((h) => h.subtype === 'hook_response' && h.hook_event === 'SessionStart');
j.check('the installed SessionStart hook ran in a real session and printed the coordinator line', Boolean(ssResponse?.stdout?.includes('coordinator skill')), (ssResponse?.stdout ?? '').split('\n')[0]);
j.check('the installed Stop hook ran in that session', stream.hooks.some((h) => h.subtype === 'hook_response' && h.hook_event === 'Stop' && h.exit_code === 0));

const status = git(SANDBOX, ['status', '--porcelain']);
const tracked = git(SANDBOX, ['ls-files', '.claude', '.jevellan', 'CLAUDE.md']);
j.check('the sandbox git status stays clean, nothing of .claude or .jevellan tracked', status === '' && tracked === '', `status "${status}" tracked "${tracked}"`);
j.finish();
