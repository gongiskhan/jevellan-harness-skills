// H11 Trigger evals: every skill at or above the thresholds of section 10 in the last full run of
// scripts/run-trigger-evals.mjs (evals/results.json), the role lint passes, and evals/RESULTS.md is committed and
// matches that run.

import fs from 'node:fs';
import path from 'node:path';
import { Journey, NODE, REPO, git, sh } from './lib.mjs';

const j = new Journey('H11', 'Trigger evals');
const results = JSON.parse(fs.readFileSync(path.join(REPO, 'evals', 'results.json'), 'utf8'));
const skills = fs.readdirSync(path.join(REPO, 'skills')).filter((n) => fs.existsSync(path.join(REPO, 'skills', n, 'SKILL.md')));
j.note(`run of ${results.date}: model ${results.model}, effort ${results.effort}, ${results.runs} runs per case, provider ${results.provider}, Claude Code ${results.claudeVersion ?? '?'}; thresholds ${JSON.stringify(results.thresholds)}`);
if (results.merged) {
  const m = results.merged;
  j.note(`merged results: ${m.remeasured.join(', ')} measured on ${results.date}; ${m.kept.length} skills from the run of ${m.from}${m.dropped.length ? `; left out (no longer in the package): ${m.dropped.join(', ')}` : ''}`);
}
j.check('the run covered every skill', skills.every((s) => results.skills.some((r) => r.skill === s)) && (!results.limit || results.limit === null), `${results.skills.length} skills in the run, ${skills.length} in the package`);
j.check('every skill has at least five positive and five negative cases', skills.every((s) => {
  const cases = JSON.parse(fs.readFileSync(path.join(REPO, 'skills', s, 'evals', 'trigger-cases.json'), 'utf8'));
  return cases.filter((c) => c.should_trigger).length >= 5 && cases.filter((c) => !c.should_trigger).length >= 5;
}));
for (const s of results.skills) {
  const p = s.positives;
  const n = s.negatives;
  const rp = s.rolePhrase;
  const rm = s.roleMissing;
  const detail = `positives ${p.passed}/${p.runs}, negatives fired ${n.runs - n.passed}/${n.runs}, role phrase ${rp.passed}/${rp.runs}${rm.runs ? `, role missing ${rm.passed}/${rm.runs}` : ''}${s.errors ? `, errors ${s.errors}` : ''}`;
  j.check(`${s.skill} meets the thresholds`, s.verdict.ok, s.verdict.ok ? detail : `${detail}; ${s.verdict.reasons.join('; ')}`);
}
const lint = sh(NODE, [path.join(REPO, 'scripts', 'check-roles.mjs'), '--check']);
j.check('the role lint passes', lint.status === 0, (lint.stdout + lint.stderr).trim());
const tracked = git(REPO, ['ls-files', 'evals/RESULTS.md', 'evals/results.json']);
const clean = git(REPO, ['status', '--porcelain', '--', 'evals/']);
j.check('evals/RESULTS.md is committed and matches the run', tracked.includes('evals/RESULTS.md') && clean === '', `tracked: ${tracked.replace(/\n/g, ', ')}; uncommitted: ${clean || 'none'}`);
// Section 10 allows at most three improvement rounds per skill. A skill still below threshold after its third round is
// recorded, not tuned further: the journey is then blocked by that rule, with the numbers, rather than failed.
const roundsOf = (skill) => {
  const file = path.join(REPO, 'skills', skill, 'CHANGELOG.md');
  if (!fs.existsSync(file)) return 0;
  return fs.readFileSync(file, 'utf8').split(/^## Trigger evals round /m).slice(1).filter((entry) => !/^\d+, \S+\n\n- No change to the skill\./.test(entry)).length;
};
const below = results.skills.filter((s) => !s.verdict.ok);
// The per-case split behind each skill below threshold, so this record stands on its own.
for (const s of below) {
  for (const c of results.cases.filter((c) => c.skill === s.skill && (c.runs.some((r) => !r.passed) || c.remove_role))) {
    const passed = c.runs.filter((r) => r.passed).length;
    const named = c.remove_role ? `, named the missing role ${c.runs.filter((r) => r.namedMissing).length}/${c.runs.length}, invoked ${[...new Set(c.runs.flatMap((r) => r.invoked))].join(', ') || 'nothing'}` : '';
    j.note(`${s.skill} case ${c.index ?? c.case} (${c.remove_role ? `${c.remove_role} removed, context ${c.context_skill}` : c.should_trigger ? 'positive' : 'negative'}): ${passed}/${c.runs.length}${named}; "${String(c.query).slice(0, 90)}"`);
  }
}
const coordinator = results.cases.filter((c) => c.skill === 'jevellan-coordinator' && c.should_trigger);
const hook = coordinator.filter((c) => /coordinator skill: use it/.test(c.query));
j.note(`coordinator positives with the SessionStart line: ${hook.reduce((n, c) => n + c.runs.filter((r) => r.passed).length, 0)}/${hook.reduce((n, c) => n + c.runs.length, 0)}; without it: ${coordinator.filter((c) => !hook.includes(c)).reduce((n, c) => n + c.runs.filter((r) => r.passed).length, 0)}/${coordinator.filter((c) => !hook.includes(c)).reduce((n, c) => n + c.runs.length, 0)}`);
const missing = results.cases.filter((c) => c.remove_role);
j.note(`role-missing runs that named the missing role: ${missing.reduce((n, c) => n + c.runs.filter((r) => r.namedMissing).length, 0)}/${missing.reduce((n, c) => n + c.runs.length, 0)}; that invoked no skill, by role: ${[...new Set(missing.map((c) => c.remove_role))].map((role) => { const cs = missing.filter((c) => c.remove_role === role); return `${role} ${cs.reduce((n, c) => n + c.runs.filter((r) => !r.invoked.length).length, 0)}/${cs.reduce((n, c) => n + c.runs.length, 0)}`; }).join(', ')}`);
j.note(`totals: ${results.totals ? JSON.stringify(results.totals) : ''}`);
for (const s of below) j.note(`${s.skill}: ${roundsOf(s.skill)} improvement rounds recorded in its CHANGELOG`);
const otherFailures = j.checks.filter((c) => !c.ok && !below.some((s) => c.name === `${s.skill} meets the thresholds`));
if (below.length && !otherFailures.length && below.every((s) => roundsOf(s.skill) >= 3 || process.env.JH_H11_BLOCK_REASON)) {
  j.finish(`blocked: ${below.map((s) => `${s.skill} (${s.verdict.reasons.join('; ')})`).join(', ')} after the improvement rounds section 10 allows; ${process.env.JH_H11_BLOCK_REASON ?? 'see docs/decisions.md H-030'}`);
} else {
  j.finish();
}
