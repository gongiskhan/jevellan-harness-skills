// Writes acceptance/results/comparison.json, the before-and-after section of acceptance/RESULTS.md, and regenerates
// RESULTS.md. Before: the journeys' records at a git ref (the last release) and acceptance/results/timings-before.json
// (acceptance/timings.mjs run on that release); after: the records in the working tree and timings-after.json.
//
//   node acceptance/compare-timings.mjs --before-ref v0.1.0 [--notes notes.json]
//
// notes.json is a JSON array of sentences, each saying what changed in a journey for this run and why.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { REPO, RESULTS_DIR, git, writeResultsMd } from './lib.mjs';

const { values } = parseArgs({ options: { 'before-ref': { type: 'string' }, notes: { type: 'string' } } });
const ref = values['before-ref'] ?? 'v0.1.0';
const read = (file) => JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, file), 'utf8'));
const before = read('timings-before.json');
const after = read('timings-after.json');

const seconds = (ms) => `${Math.round(ms / 1000)} s`;
const describe = (r) => {
  if (!r) return '-';
  const timed = Object.entries(r.timings ?? {}).map(([k, v]) => `${k} ${seconds(v)}`).join('; ');
  return `${r.status.split(':')[0]}, ${r.passed}/${r.total}, ${seconds(r.elapsedMs)}${timed ? ` (${timed})` : ''}`;
};
const rows = [];
for (let i = 1; i <= 12; i += 1) {
  const id = `H${i}`;
  let old = null;
  try {
    old = JSON.parse(git(REPO, ['show', `${ref}:acceptance/results/${id}.json`]));
  } catch {}
  const now = fs.existsSync(path.join(RESULTS_DIR, `${id}.json`)) ? read(`${id}.json`) : null;
  rows.push({ id: `${id} ${now?.title ?? old?.title ?? ''}`.trim(), before: describe(old), after: describe(now) });
}

const comparison = {
  title: `Before and after the move to process boundaries (${ref} and 0.2.0)`,
  intro: [
    `From 0.2.0 a skill reaches another only by running its public script as a process (docs/decisions.md H-031, H-032). The cost is a Node process per call into another skill. The table below times the deterministic scripts on the same machine, the same way, on ${ref} and on 0.2.0; the journeys below it were all run again after the change.`,
    'Most of what a journey spends is model time (a worker turn takes minutes), so the journeys\' times vary from run to run far more than the added process time; they are listed to show that nothing slowed down by an order of magnitude, not as a benchmark.',
  ],
  scripts: { runs: after.runs, before, after },
  journeys: { beforeLabel: `${ref} (records at that tag)`, afterLabel: '0.2.0 (this run)', rows },
  notes: values.notes ? JSON.parse(fs.readFileSync(values.notes, 'utf8')) : [],
};
fs.writeFileSync(path.join(RESULTS_DIR, 'comparison.json'), `${JSON.stringify(comparison, null, 2)}\n`);
writeResultsMd();
process.stdout.write(`wrote ${path.join(RESULTS_DIR, 'comparison.json')} and acceptance/RESULTS.md\n`);
