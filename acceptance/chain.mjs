// A scripted coordinator: drives one task through the skills' scripts the way the coordinator skill says, with no
// model in the loop above the workers. Used by the phase 4 check and as the reference the coordinator journeys are
// compared with.

import fs from 'node:fs';
import path from 'node:path';
import { ledgerCli, readLedger, skillScript } from './lib.mjs';

export async function driveTask(project, task, { journey, log = console.log, maxContinues = 3, timeoutS = 1800 } = {}) {
  const run = (skill, script, args, opts = {}) => skillScript(project, skill, script, args, { timeoutMs: 180_000, ...opts });
  const info = () => readLedger(project).filter((e) => e.task === task);
  const created = info().find((e) => e.kind === 'task.created');
  const kind = created.data.kind;
  const wt = run('jevellan-git', 'scripts/worktree.mjs', ['create', '--task', task, '--json'], { timeoutMs: 900_000 });
  if (wt.status !== 0) throw new Error(`worktree: ${wt.stderr}`);
  const cwd = wt.json.path;
  log(`worktree ${cwd}`);
  let steps;
  if (kind === 'single') {
    steps = [{ ordinal: 1, duty: created.data.duty }];
  } else {
    const q = run('jevellan-router', 'scripts/route.mjs', ['--task', task, '--questions']);
    if (q.status !== 0) throw new Error(`questions: ${q.stderr}`);
    const answers = path.join(path.dirname(cwd), `${task}-answers.json`);
    fs.writeFileSync(answers, q.stdout);
    const wf = path.join(project, '.claude', 'skills', `jevellan-workflow-${kind}`, 'workflow.json');
    const rec = ledgerCli(project, ['append', 'task.workflow', '--task', task, '--from-workflow', wf, '--answers', answers, '--json']);
    if (rec.status !== 0) throw new Error(`workflow: ${rec.stderr}`);
    const line = info().filter((e) => e.kind === 'task.workflow').pop();
    steps = line.data.steps.filter((s) => !line.data.skipped.includes(s.ordinal));
    log(`workflow: ${steps.map((s) => `${s.ordinal} ${s.duty}`).join(', ')} (skipped ${line.data.skipped.join(', ') || 'none'})`);
  }
  const placements = [];
  const runStep = async (step) => {
    const placed = run('jevellan-router', 'scripts/route.mjs', ['--task', task, '--step', String(step.ordinal), '--duty', step.duty]);
    if (placed.status !== 0) throw new Error(`placement of step ${step.ordinal}: ${placed.stderr}`);
    const p = placed.json;
    placements.push({ step: step.ordinal, duty: step.duty, model: p.model, effort: p.effort, provider: p.provider, p: p.probabilities?.model?.[p.model] });
    log(`step ${step.ordinal} ${step.duty}: ${p.model} ${p.effort} via ${p.provider}`);
    const started = run('jevellan-runtime-claude', 'scripts/start.mjs', ['--task', task, '--step', String(step.ordinal), '--duty', step.duty, '--cwd', cwd, '--provider', p.provider, '--model', p.model, '--effort', p.effort, '--json']);
    if (started.status !== 0) throw new Error(`start of step ${step.ordinal}: ${started.stderr}`);
    for (let turn = 0; ; turn += 1) {
      const waited = ledgerCli(project, ['wait', '--task', task, '--step', String(step.ordinal), '--timeout', String(timeoutS), '--json'], { timeoutMs: (timeoutS + 60) * 1000 });
      const r = waited.json ?? {};
      log(`  report: ${r.kind === 'step.report' ? r.status : r.kind}${r.summary ? ` - ${r.summary.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`);
      if (r.kind !== 'step.report') return { ok: false, why: r.kind ?? `wait exit ${waited.status}` };
      if (r.status === 'done') {
        const done = ledgerCli(project, ['append', 'step.done', '--task', task, '--step', String(step.ordinal), '--json']);
        if (done.status === 0) return { ok: true };
        return { ok: false, why: done.stderr.trim(), report: r };
      }
      if (r.status === 'progress' && turn < maxContinues) {
        run('jevellan-runtime-claude', 'scripts/resume.mjs', ['--task', task, '--step', String(step.ordinal), '--message', 'Continue.', '--json']);
        continue;
      }
      if (r.status === 'needs-decision' && r.options?.length && turn < maxContinues) {
        run('jevellan-runtime-claude', 'scripts/resume.mjs', ['--task', task, '--step', String(step.ordinal), '--message', r.options[0].label, '--json']);
        continue;
      }
      return { ok: false, why: `report ${r.status}`, report: r };
    }
  };
  for (const step of steps) {
    const result = await runStep(step);
    if (!result.ok) return { landed: false, why: `step ${step.ordinal} ${step.duty}: ${result.why}`, placements, cwd };
  }
  for (let round = 0; round < 3; round += 1) {
    const land = run('jevellan-git', 'scripts/land.mjs', ['--task', task, '--json'], { timeoutMs: 1_800_000 });
    log(`land: exit ${land.status} ${land.stdout.replace(/\s+/g, ' ').slice(0, 200)} ${land.stderr.trim().slice(0, 200)}`);
    if (land.status === 0) return { landed: true, placements, cwd, land: land.json };
    if (land.status === 6) {
      const add = ledgerCli(project, ['append', 'task.workflow', '--task', task, '--force', '--add-step', JSON.stringify({ duty: 'verify', instructions: 'Full verification before landing: run the whole test command and every browser journey the change could affect.' }), '--json']);
      if (add.status !== 0) return { landed: false, why: `add verify step: ${add.stderr}`, placements, cwd };
      const line = readLedger(project).filter((e) => e.task === task && e.kind === 'task.workflow').pop();
      const result = await runStep(line.data.steps[line.data.steps.length - 1]);
      if (!result.ok) return { landed: false, why: `extra verify: ${result.why}`, placements, cwd };
      continue;
    }
    if (land.status === 7) return { landed: false, asked: true, why: 'ask-owner', placements, cwd, land: land.json };
    return { landed: false, why: `land exit ${land.status}: ${land.stderr.trim().slice(0, 300)}`, placements, cwd };
  }
  return { landed: false, why: 'landing did not finish in 3 rounds', placements, cwd };
}
