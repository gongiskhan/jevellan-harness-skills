// The report contract a worker writes to .jevellan/report.json, ported from the skills repo's report.ts (where
// zod checked it). Hand-written so nothing needs dependencies. validateReport returns the first problem as one
// sentence, which the Stop hook hands back to the worker word for word.

import path from 'node:path';

export const STATUSES = ['progress', 'done', 'blocked', 'needs-decision'];
export const LIMITS = {
  summary: 4000,
  question: 1000,
  optionsMin: 2,
  optionsMax: 4,
  label: 120,
  description: 300,
  testsSummary: 600,
  command: 4000,
  changedFiles: 200,
  path: 1024,
  screenshots: 50,
  caption: 300,
  limitations: 4000,
  ownerCommands: 5,
  why: 300,
};

const KEYS = ['status', 'summary', 'question', 'options', 'testsRun', 'changedFiles', 'screenshots', 'limitations', 'ownerCommands'];

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const isText = (value) => typeof value === 'string' && value.trim().length > 0;

function unknownKey(object, allowed, where) {
  const extra = Object.keys(object).find((key) => !allowed.includes(key));
  return extra === undefined ? null : `${where} has an unknown field "${extra}"`;
}

// Lenient fixes applied before validation: an over-long summary is cut rather than refused, and a limitations
// list of strings becomes one text. Everything else must already be right.
export function normalizeReport(report) {
  if (!isObject(report)) return report;
  const out = { ...report };
  if (typeof out.summary === 'string' && out.summary.length > LIMITS.summary) {
    out.summary = `${out.summary.slice(0, LIMITS.summary - 1)}…`;
  }
  if (Array.isArray(out.limitations) && out.limitations.every((item) => typeof item === 'string')) {
    out.limitations = out.limitations.join('\n');
  }
  if (typeof out.limitations === 'string' && out.limitations.length > LIMITS.limitations) {
    out.limitations = `${out.limitations.slice(0, LIMITS.limitations - 1)}…`;
  }
  return out;
}

export function validateReport(input) {
  const report = normalizeReport(input);
  const problem = firstProblem(report);
  return problem ? { ok: false, problem: `report.json: ${problem}` } : { ok: true, report };
}

function firstProblem(r) {
  if (!isObject(r)) return 'must be one JSON object';
  const extra = unknownKey(r, KEYS, 'the report');
  if (extra) return extra;
  if (!STATUSES.includes(r.status)) return `status must be one of ${STATUSES.join(', ')}`;
  if (!isText(r.summary)) return 'summary must be a non-empty text';
  if (r.summary.length > LIMITS.summary) return `summary must be at most ${LIMITS.summary} characters`;

  if (r.status === 'needs-decision') {
    if (!isText(r.question)) return 'question is required when status is needs-decision';
    if (!Array.isArray(r.options)) return 'options are required when status is needs-decision';
  }
  if (r.question !== undefined) {
    if (!isText(r.question)) return 'question must be a non-empty text';
    if (r.question.length > LIMITS.question) return `question must be at most ${LIMITS.question} characters`;
  }
  if (r.options !== undefined) {
    if (!Array.isArray(r.options) || r.options.length < LIMITS.optionsMin || r.options.length > LIMITS.optionsMax) {
      return `options must have ${LIMITS.optionsMin} to ${LIMITS.optionsMax} items`;
    }
    for (const [index, option] of r.options.entries()) {
      if (!isObject(option)) return `options[${index}] must be an object with a label`;
      const bad = unknownKey(option, ['label', 'description'], `options[${index}]`);
      if (bad) return bad;
      if (!isText(option.label)) return `options[${index}].label must be a non-empty text`;
      if (option.label.length > LIMITS.label) return `options[${index}].label must be at most ${LIMITS.label} characters`;
      if (option.description !== undefined && typeof option.description !== 'string') {
        return `options[${index}].description must be a text`;
      }
      if (typeof option.description === 'string' && option.description.length > LIMITS.description) {
        return `options[${index}].description must be at most ${LIMITS.description} characters`;
      }
    }
  }
  if (r.testsRun !== undefined) {
    const t = r.testsRun;
    if (!isObject(t)) return 'testsRun must be an object with command, passed and summary';
    const bad = unknownKey(t, ['command', 'passed', 'summary'], 'testsRun');
    if (bad) return bad;
    if (!isText(t.command)) return 'testsRun.command must be a non-empty text';
    if (t.command.length > LIMITS.command) return `testsRun.command must be at most ${LIMITS.command} characters`;
    if (typeof t.passed !== 'boolean') return 'testsRun.passed must be true or false';
    if (typeof t.summary !== 'string') return 'testsRun.summary must be a text';
    if (t.summary.length > LIMITS.testsSummary) return `testsRun.summary must be at most ${LIMITS.testsSummary} characters`;
  }
  if (r.changedFiles !== undefined) {
    if (!Array.isArray(r.changedFiles)) return 'changedFiles must be a list of paths';
    if (r.changedFiles.length > LIMITS.changedFiles) return `changedFiles must have at most ${LIMITS.changedFiles} items`;
    const index = r.changedFiles.findIndex((file) => !isText(file) || file.length > LIMITS.path);
    if (index >= 0) return `changedFiles[${index}] must be a path of at most ${LIMITS.path} characters`;
  }
  if (r.screenshots !== undefined) {
    if (!Array.isArray(r.screenshots)) return 'screenshots must be a list of {path, caption}';
    if (r.screenshots.length > LIMITS.screenshots) return `screenshots must have at most ${LIMITS.screenshots} items`;
    for (const [index, shot] of r.screenshots.entries()) {
      if (!isObject(shot)) return `screenshots[${index}] must be an object with path and caption`;
      const bad = unknownKey(shot, ['path', 'caption'], `screenshots[${index}]`);
      if (bad) return bad;
      if (!isText(shot.path) || shot.path.length > LIMITS.path) return `screenshots[${index}].path must be a path`;
      const normal = path.posix.normalize(shot.path.replace(/\\/g, '/'));
      const relativeOk = !normal.startsWith('/') && normal.startsWith('.jevellan/evidence/');
      const absoluteOk = normal.startsWith('/') && normal.includes('/.jevellan/evidence/');
      if (shot.path.split(/[\\/]/).includes('..') || !(relativeOk || absoluteOk)) {
        return `screenshots[${index}].path must be under .jevellan/evidence/`;
      }
      if (!isText(shot.caption) || shot.caption.length > LIMITS.caption) {
        return `screenshots[${index}].caption must be a text of at most ${LIMITS.caption} characters`;
      }
    }
  }
  if (r.limitations !== undefined) {
    if (typeof r.limitations !== 'string') return 'limitations must be a text';
  }
  if (r.ownerCommands !== undefined) {
    if (!Array.isArray(r.ownerCommands)) return 'ownerCommands must be a list of {command, cwd, why}';
    if (r.ownerCommands.length > LIMITS.ownerCommands) return `ownerCommands must have at most ${LIMITS.ownerCommands} items`;
    for (const [index, item] of r.ownerCommands.entries()) {
      if (!isObject(item)) return `ownerCommands[${index}] must be an object with command, cwd and why`;
      const bad = unknownKey(item, ['command', 'cwd', 'why'], `ownerCommands[${index}]`);
      if (bad) return bad;
      if (!isText(item.command) || item.command.length > LIMITS.command) return `ownerCommands[${index}].command must be a non-empty text`;
      if (!isText(item.cwd) || !(['worktree', 'checkout', 'home'].includes(item.cwd) || item.cwd.startsWith('/'))) {
        return `ownerCommands[${index}].cwd must be worktree, checkout, home or an absolute folder`;
      }
      if (!isText(item.why) || item.why.length > LIMITS.why) return `ownerCommands[${index}].why must say why, in at most ${LIMITS.why} characters`;
    }
  }
  return null;
}
