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
j.check('the run covered every skill', skills.every((s) => results.skills.some((r) => r.skill === s)) && !results.selectedSkills?.length, `${results.skills.length} skills in the run, ${skills.length} in the package`);
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
for (const s of below) j.note(`${s.skill}: ${roundsOf(s.skill)} improvement rounds recorded in its CHANGELOG`);
const otherFailures = j.checks.filter((c) => !c.ok && !below.some((s) => c.name === `${s.skill} meets the thresholds`));
if (below.length && !otherFailures.length && below.every((s) => roundsOf(s.skill) >= 3 || process.env.JH_H11_BLOCK_REASON)) {
  j.finish(`blocked: ${below.map((s) => `${s.skill} (${s.verdict.reasons.join('; ')})`).join(', ')} after the improvement rounds section 10 allows; ${process.env.JH_H11_BLOCK_REASON ?? 'see docs/decisions.md H-030'}`);
} else {
  j.finish();
}
