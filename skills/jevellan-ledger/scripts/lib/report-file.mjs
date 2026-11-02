// A worker's .jevellan/report.json turned into a step.report line: read and checked against the report schema, the
// line appended first, the file moved to <project>/.jevellan/reports/ only after. Used by the Stop hook (Claude
// workers) and by `ledger.mjs take-report` (runtimes whose agent has no Stop hook), so both record a report the same
// way and the schema stays this skill's alone.

import fs from 'node:fs';
import path from 'node:path';
import { appendEvent } from './ledger.mjs';
import { projectPaths } from './project.mjs';
import { fitReportLine, validateReport } from './report-schema.mjs';
import { compactTime } from './ids.mjs';

// What the file says: {data, suffix, problem}. A valid report is its normalized data with suffix ''; a file that does
// not parse or breaks the schema is a blocked report marked synthesized, with the problem in limitations and suffix
// '-invalid'. A missing file is null.
export function readReportFile(file) {
  if (!fs.existsSync(file)) return null;
  let parsed;
  let problem = null;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    problem = `report.json: is not valid JSON (${error.message})`;
  }
  const result = problem ? null : validateReport(parsed);
  if (result?.ok) return { data: { ...result.report }, suffix: '', problem: null };
  problem = problem ?? result.problem;
  return { data: { status: 'blocked', summary: 'The report was not valid.', limitations: problem, synthesized: true }, suffix: '-invalid', problem };
}

export function archivePath(root, task, step, suffix = '') {
  const dir = projectPaths(root).reports;
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${task}-s${step}-${compactTime()}${suffix}.json`);
}

function moveFile(file, target) {
  try {
    fs.renameSync(file, target);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    fs.copyFileSync(file, target);
    fs.unlinkSync(file);
  }
}

// Appends step.report with `data` (fitted to one ledger line; reportFile names the archive when there is a file),
// then moves the file there. When the ledger refuses the line this throws and the file stays where the worker wrote
// it. A move that fails after the line was written is passed to `onMoveError` and does not undo the line.
export function recordReport(root, { task, step, session }, data, { file = null, suffix = '', onMoveError = () => {} } = {}) {
  const target = file ? archivePath(root, task, step, suffix) : null;
  const event = appendEvent(root, { kind: 'step.report', task, step, session, data: fitReportLine(file ? { ...data, reportFile: target } : data) });
  if (file) {
    try {
      moveFile(file, target);
    } catch (error) {
      onMoveError(error, file, target);
    }
  }
  return event;
}
