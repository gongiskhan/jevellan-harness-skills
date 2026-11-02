// Re-runs the slip analysis of one recorded H6 run on its saved transcript, and records the result in
// acceptance/results/H6-runs.json with the reason (used once, after the analyser read heredoc bodies as commands).
//   node acceptance/h06-reanalyse.mjs <run number> "<reason>"
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR } from './lib.mjs';
import { analyse, transcriptFile } from './coord.mjs';
const runsFile = path.join(RESULTS_DIR, 'H6-runs.json');
const runs = JSON.parse(fs.readFileSync(runsFile, 'utf8'));
const run = runs.find((r) => r.run === Number(process.argv[2]));
const result = analyse(transcriptFile(run.dir, run.session), run.dir);
const before = run.slips;
run.slips = result.slips;
run.reanalysed = { at: new Date().toISOString(), reason: process.argv[3], slipsBefore: before };
run.passed = result.slips.length === 0 && run.otherChecksPassed !== false;
fs.writeFileSync(runsFile, `${JSON.stringify(runs, null, 2)}\n`);
console.log(JSON.stringify({ run: run.run, passed: run.passed, slips: run.slips, skills: result.skills }, null, 2));
