// Re-runs the slip analysis of a finished journey on its saved coordinator transcripts and rewrites that journey's
// "zero slips" check with the result and the reason for the re-check (used after a false slip in the analyser).
//   node acceptance/recheck-slips.mjs <H-id> <project dir> "<reason>" <session id>...
import fs from 'node:fs';
import path from 'node:path';
import { RESULTS_DIR, writeResultsMd } from './lib.mjs';
import { analyse, transcriptFile } from './coord.mjs';
const [id, dir, reason, ...sessions] = process.argv.slice(2);
const file = path.join(RESULTS_DIR, `${id}.json`);
const result = JSON.parse(fs.readFileSync(file, 'utf8'));
const slips = sessions.flatMap((s) => analyse(transcriptFile(dir, s), dir).slips);
const check = result.checks.find((c) => /zero slips/.test(c.name));
const before = check.detail;
check.ok = slips.length === 0;
check.detail = slips.join(' | ');
result.notes.push(`re-checked at ${new Date().toISOString()}: ${reason}; the first analysis said: ${before.slice(0, 300)}`);
result.passed = result.checks.filter((c) => c.ok).length;
result.status = result.checks.every((c) => c.ok) ? 'passed' : 'failed';
fs.writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`);
writeResultsMd();
console.log(`${id} ${result.status}: ${result.passed}/${result.total}; slips: ${slips.length}`);
