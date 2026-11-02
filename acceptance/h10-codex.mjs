// H10 Codex: with the router policy temporarily edited to prefer GPT for investigation, a single investigate step
// runs on codex exec, its report is recorded by the runtime parent, and the policy is restored. Or "skipped: Codex not
// logged in" with a NEEDS-OWNER line when `codex login status` does not say logged in.

import fs from 'node:fs';
import path from 'node:path';
import { Journey, NODE, REPO, SANDBOX, ledgerCli, readLedger, sh, skillDir } from './lib.mjs';
import { driveTask } from './chain.mjs';

const j = new Journey('H10', 'Codex');
const login = sh('codex', ['login', 'status']);
if (!/logged in/i.test(`${login.stdout}${login.stderr}`)) {
  j.note(`codex login status: ${(login.stdout + login.stderr).trim()}`);
  fs.appendFileSync(path.join(process.env.HOME, '.jevellan-build', 'manager', 'jevellan-harness-status.txt'), `${new Date().toISOString().slice(0, 19)}Z NEEDS-OWNER: run "codex login" once so the Codex runtime can run H10.\n`);
  j.finish('skipped: Codex not logged in');
} else {
  j.check('codex login status says logged in', true, (login.stdout + login.stderr).trim());
  j.check('the skills are installed', sh(NODE, [path.join(REPO, 'install.mjs'), SANDBOX, '--json']).status === 0);
  const policy = path.join(skillDir(SANDBOX, 'jevellan-router'), 'SKILL.md');
  const original = fs.readFileSync(policy, 'utf8');
  let result;
  let task;
  try {
    const edited = original.replace(/## model descriptions\n([\s\S]*?)\n\n## /, (whole, lines) => {
      const changed = lines.split('\n').map((line) => {
        const [id] = line.split(':');
        if (id === 'gpt-6-astra') return 'gpt-6-astra: The model for investigation: questions about the code, finding where something happens, explaining how it works.';
        return `${id}: Not for investigation. ${line.slice(id.length + 1).trim()}`;
      });
      return `## model descriptions\n${changed.join('\n')}\n\n## `;
    });
    j.check('the installed policy was edited for the journey', edited !== original);
    fs.writeFileSync(policy, edited);
    task = ledgerCli(SANDBOX, ['task', 'create', '--kind', 'single', '--duty', 'investigate', '--title', 'H10: where is the invoice total computed', '--text', 'Find where the invoice total is computed and how a line total is rounded: the file, the function and the line. Acceptance H10.', '--json']).json.task;
    const t0 = Date.now();
    result = await driveTask(SANDBOX, task, { log: (l) => j.note(l), timeoutS: 900 });
    j.time('task to report', Date.now() - t0);
  } finally {
    fs.writeFileSync(policy, original);
  }
  j.check('the policy is restored byte for byte', fs.readFileSync(policy, 'utf8') === original && sh('diff', ['-q', policy, path.join(REPO, 'skills', 'jevellan-router', 'SKILL.md')]).status === 0);
  const events = readLedger(SANDBOX).filter((e) => e.task === task);
  const placed = events.find((e) => e.kind === 'task.placed');
  j.check('Jev placed the step on GPT via codex', placed?.data?.provider === 'codex' && placed?.data?.model === 'gpt-6-astra', `${placed?.data?.model} via ${placed?.data?.provider} (p ${placed?.data?.probabilities?.model?.[placed?.data?.model]})`);
  const started = events.find((e) => e.kind === 'step.started');
  j.check('the step ran on codex exec', started?.data?.runtime === 'codex', started?.data?.runtime);
  const thread = events.find((e) => e.kind === 'session.started' && e.data?.runtime === 'codex')?.data?.nativeSessionId;
  j.check('the Codex thread id is the native session id', Boolean(thread), thread);
  const report = events.find((e) => e.kind === 'step.report');
  j.check('its report was recorded by the runtime parent', report?.data?.status === 'done' && !report.data.synthesized && Boolean(report.data.reportFile), (report?.data?.summary ?? '').slice(0, 200));
  j.check('the single investigate task is done', result?.landed || events.some((e) => e.kind === 'step.done'), result?.why ?? '');
  const open = ledgerCli(SANDBOX, ['status', '--json']).json?.tasks ?? [];
  if (open.some((t) => t.task === task)) {
    sh(NODE, [path.join(skillDir(SANDBOX, 'jevellan-git'), 'scripts', 'worktree.mjs'), 'archive', '--task', task, '--reason', 'acceptance H10 finished'], { cwd: SANDBOX });
  }
  j.finish();
}
